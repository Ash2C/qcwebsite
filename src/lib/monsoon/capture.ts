// Port of the CRM core's capture transaction (quantcloud/crm/db.py Crm.capture) plus the
// monsoon additions in the spec, section 6.4. All SQL is parameterised and unnamed.
import type { ClientBase } from "pg";
import type { OfferedTodo } from "./refine";
import { MAX_TODO_TITLE, todosReady, validDay } from "./todos";
import { mergeFillEmpty, nameKey, similarOrgNames } from "./rules";

export type CaptureKind = "card" | "badge" | "screen" | "other";

export type CaptureInput = {
  captureId: string; // UUID
  name: string;
  role: string;
  org?: string;
  title?: string;
  email?: string;
  phone?: string;
  linkedin?: string;
  notes?: string;
  rawText?: string;
  extracted?: unknown; // reader's original output
  newOrg?: boolean;
  samePerson?: string | false; // person id, or false = a different person
  kind?: CaptureKind; // what the image was; sets the timeline wording
  todos?: OfferedTodo[]; // written as open to-dos on the member, only when the CRM has the to-do table
};

// `name` is the name on file (a match by email can carry another spelling than the typed one).
export type CaptureResult =
  | { outcome: "added"; person: string; name?: string; org: string | null; role: string; filled: string[] }
  | { outcome: "existing"; person: string; name?: string; org: string | null; role: string; filled: string[] }
  | { outcome: "filed"; person: string; name?: string; org: string; role: string; filled: string[]; created: boolean }
  | { outcome: "duplicate"; person: string; org: string | null }
  | { outcome: "org_lookalike"; similar: string[] }
  | { outcome: "same_name"; matches: { personId: string; org: string | null }[] }
  | { outcome: "ambiguous"; orgs: (string | null)[] }
  | { outcome: "needs_company"; orgs: (string | null)[] }
  | { outcome: "invalid"; error: string };

const SOURCE = "monsoon-app";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIND_TEXT: Record<CaptureKind, string> = {
  card: "Added from a photo of a business card",
  badge: "Added from a photo of a badge",
  screen: "Added from a screenshot",
  other: "Added from a photo",
};
// A contact typed in by hand: no image, and nothing is assumed about having met.
const TYPED_TEXT = "Added by hand";
const PERSON_COLUMNS = ["title", "email", "phone", "linkedin_url"] as const;

type PersonRow = {
  id: string;
  name: string;
  name_key: string;
  org_id: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
};

function clean(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

async function orgName(db: ClientBase, orgId: string | null): Promise<string | null> {
  if (!orgId) return null;
  const r = await db.query("SELECT name FROM orgs WHERE id = $1", [orgId]);
  return r.rows[0]?.name ?? null;
}

async function peopleByKey(db: ClientBase, key: string): Promise<PersonRow[]> {
  const r = await db.query("SELECT * FROM people WHERE name_key = $1 ORDER BY created_at, id", [key]);
  return r.rows;
}

/** Fill only the empty person columns; returns the columns filled. */
async function fillPerson(
  db: ClientBase,
  person: PersonRow,
  fields: Record<string, string | undefined>,
): Promise<string[]> {
  const updates = mergeFillEmpty(person, fields);
  const cols = PERSON_COLUMNS.filter((c) => c in updates);
  if (cols.length === 0) return [];
  const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(", ");
  await db.query(`UPDATE people SET ${sets} WHERE id = $1`, [person.id, ...cols.map((c) => updates[c])]);
  return [...cols];
}

export async function capture(db: ClientBase, input: CaptureInput, owner: string): Promise<CaptureResult> {
  const name = (input.name ?? "").trim();
  if (!name) return { outcome: "invalid", error: "name is required" };
  if (!UUID_RE.test(input.captureId ?? "")) return { outcome: "invalid", error: "captureId must be a UUID" };

  const org = clean(input.org);
  const notes = clean(input.notes);
  const fields = {
    title: clean(input.title),
    email: clean(input.email),
    phone: clean(input.phone),
    linkedin_url: clean(input.linkedin),
  };
  const key = nameKey(name);

  async function insertPerson(orgId: string | null): Promise<PersonRow> {
    const r = await db.query(
      `INSERT INTO people (org_id, name, name_key, title, email, phone, linkedin_url, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        orgId,
        name,
        key,
        fields.title ?? null,
        fields.email ?? null,
        fields.phone ?? null,
        fields.linkedin_url ?? null,
        SOURCE,
      ],
    );
    return r.rows[0];
  }

  async function run(writeTodos: boolean): Promise<CaptureResult> {
    // 1. Lock on the capture id; an earlier capture with this id returns its result.
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [input.captureId]);
    const earlier = await db.query(
      "SELECT person_id, org_id FROM captures WHERE capture_id = $1 ORDER BY created_at, id LIMIT 1",
      [input.captureId],
    );
    if (earlier.rows[0]) {
      const row = earlier.rows[0];
      return { outcome: "duplicate", person: row.person_id ?? "", org: await orgName(db, row.org_id) };
    }

    // 2. The role must exist.
    const role = await db.query("SELECT 1 FROM roles WHERE key = $1", [input.role]);
    if (role.rowCount === 0) return { outcome: "invalid", error: `unknown role: ${input.role}` };

    // 3. Same name under another company, or Vincent's answer to that question.
    let person: PersonRow | undefined;
    let created = false;
    let cardOrg: string | undefined; // typed company that differs from the one on file
    let filled: string[] = [];
    const namesakes = await peopleByKey(db, key);

    if (typeof input.samePerson === "string") {
      // A match is the same name, or the same email (a different spelling of the name).
      const chosen = UUID_RE.test(input.samePerson)
        ? ((await db.query("SELECT * FROM people WHERE id = $1", [input.samePerson])).rows[0] as PersonRow | undefined)
        : undefined;
      // Same normalisation as match.ts: trimmed and lower-cased on both sides.
      const sameEmail =
        !!chosen?.email &&
        !!fields.email &&
        chosen.email.trim().toLowerCase() === fields.email.trim().toLowerCase();
      person = chosen && (chosen.name_key === key || sameEmail) ? chosen : undefined;
      if (!person) return { outcome: "invalid", error: "samePerson is not a person with this name" };
    } else if (input.samePerson === false && !org && namesakes.length > 0) {
      // A different person with this name cannot be stored without a company.
      const orgs: (string | null)[] = [];
      for (const p of namesakes) orgs.push(await orgName(db, p.org_id));
      return { outcome: "needs_company", orgs };
    } else if (org && input.samePerson === undefined && namesakes.length > 0) {
      const atTypedOrg = await db.query(
        "SELECT 1 FROM people p JOIN orgs o ON o.id = p.org_id WHERE p.name_key = $1 AND o.name_key = $2",
        [key, nameKey(org)],
      );
      if (atTypedOrg.rowCount === 0) {
        const matches = [];
        for (const p of namesakes) matches.push({ personId: p.id, org: await orgName(db, p.org_id) });
        return { outcome: "same_name", matches };
      }
    }

    if (person) {
      // Reuse the person; their company on file stays.
      const onFile = await orgName(db, person.org_id);
      if (org && (onFile === null || nameKey(onFile) !== nameKey(org))) cardOrg = org;
      filled = await fillPerson(db, person, fields);
    } else if (org) {
      // 4. Lookalike guard, then find or create the org and the person.
      let orgRow = (await db.query("SELECT id FROM orgs WHERE name_key = $1", [nameKey(org)])).rows[0];
      if (!orgRow) {
        if (!input.newOrg) {
          const existing = (await db.query("SELECT name FROM orgs")).rows.map((r) => r.name as string);
          const similar = similarOrgNames(org, existing).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
          if (similar.length > 0) return { outcome: "org_lookalike", similar };
        }
        orgRow = (
          await db.query("INSERT INTO orgs (name, name_key, source) VALUES ($1, $2, $3) RETURNING id", [
            org,
            nameKey(org),
            SOURCE,
          ])
        ).rows[0];
      }
      const found = (await db.query("SELECT * FROM people WHERE name_key = $1 AND org_id = $2", [key, orgRow.id]))
        .rows[0] as PersonRow | undefined;
      if (found) {
        person = found;
        filled = await fillPerson(db, person, fields);
      } else {
        person = await insertPerson(orgRow.id);
        created = true;
      }
    } else if (namesakes.length > 1) {
      const orgs: (string | null)[] = [];
      for (const p of namesakes) orgs.push(await orgName(db, p.org_id));
      return { outcome: "ambiguous", orgs };
    } else if (namesakes.length === 1) {
      person = namesakes[0];
      filled = await fillPerson(db, person, fields);
    } else {
      person = await insertPerson(null);
      created = true;
    }

    // 5. The member, if this person has none. An existing member is left alone.
    let member = (await db.query("SELECT id, role FROM members WHERE person_id = $1", [person.id])).rows[0];
    let memberCreated = false;
    let filedUnder = false; // logged on the company's pipeline entry instead
    if (!member && person.org_id) {
      member = (await db.query("SELECT id, role FROM members WHERE org_id = $1", [person.org_id])).rows[0];
      filedUnder = !!member;
    }
    if (!member) {
      const stage = (await db.query("SELECT key FROM stages WHERE NOT terminal ORDER BY ord LIMIT 1")).rows[0]?.key;
      member = (
        await db.query(
          `INSERT INTO members (person_id, role, stage, owner, notes, source)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, role`,
          [person.id, input.role, stage, owner, notes ?? null, SOURCE],
        )
      ).rows[0];
      memberCreated = true;
    }

    // 6. The captures row.
    await db.query(
      `INSERT INTO captures (capture_id, channel, status, raw_text, extracted, image_ref, person_id, org_id)
       VALUES ($1, $2, 'written', $3, $4, NULL, $5, $6)`,
      [
        input.captureId,
        SOURCE,
        input.rawText ?? null,
        input.extracted === undefined ? null : JSON.stringify(input.extracted),
        person.id,
        person.org_id,
      ],
    );

    // 7. A meeting touch, also for an existing member.
    const kindKey = input.kind;
    let summary = kindKey !== undefined && Object.hasOwn(KIND_TEXT, kindKey) ? KIND_TEXT[kindKey] : TYPED_TEXT;
    if (filedUnder) summary = `${person.name}: ${summary}`;
    if (notes) summary += `: ${notes}`;
    if (cardOrg) summary += ` (card shows ${cardOrg})`;
    await db.query("INSERT INTO touches (member_id, kind, by_whom, summary) VALUES ($1, 'meeting', $2, $3)", [
      member.id,
      owner,
      summary,
    ]);

    // 8. Offered to-dos: plain inserts in this transaction (addTodo opens its own, which cannot nest).
    // No timeline entry; the trigger sets the member's next action.
    if (writeTodos) {
      for (const todo of input.todos ?? []) {
        const title = typeof todo?.title === "string" ? todo.title.trim().slice(0, MAX_TODO_TITLE) : "";
        if (!title) continue;
        const due = typeof todo.due === "string" && validDay(todo.due) ? todo.due : null;
        await db.query(
          `INSERT INTO todos (title, due_date, member_id, about_person_id, owner, source)
           VALUES ($1, $2::date, $3, $4, $5, 'notes')`,
          [title, due, member.id, filedUnder ? person.id : null, owner],
        );
      }
    }

    if (filedUnder) {
      return {
        outcome: "filed",
        person: person.id,
        name: person.name,
        org: (await orgName(db, person.org_id)) ?? "",
        role: member.role,
        filled,
        created,
      };
    }
    return {
      outcome: created || memberCreated ? "added" : "existing",
      person: person.id,
      name: person.name,
      org: await orgName(db, person.org_id),
      role: member.role,
      filled,
    };
  }

  // Checked before the transaction: a missing version table is an error that would abort it.
  const writeTodos = (input.todos?.length ?? 0) > 0 && (await todosReady(db));
  await db.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    await db.query("SET LOCAL statement_timeout = '10s'");
    const result = await run(writeTodos);
    await db.query(result.outcome === "added" || result.outcome === "existing" || result.outcome === "filed"
        ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (err) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
}
