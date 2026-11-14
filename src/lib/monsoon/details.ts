// Editing a person's or a company's details through a signed proposal. proposeDetails only reads;
// applyDetails runs in one transaction after `act` has verified the signature. Statements are fixed
// text with parameters: the only column names in SQL come from the two constant column lists below,
// never from a proposal.
import type { ClientBase } from "pg";
import type { ProposeResult } from "./ask/actions";
import { PROPOSAL_TTL_MS, signProposal, type DetailChange, type DetailField, type Proposal } from "./ask/proposal";
import { readOnly } from "./ask/queries";
import type { EstateKey } from "./estates";
import { nameKey, similarOrgNames } from "./rules";

export const DETAIL_LABELS: Record<DetailField, string> = {
  name: "Name",
  title: "Title",
  email: "Email",
  phone: "Phone",
  linkedin: "LinkedIn",
  country: "Country",
  company: "Company",
  website: "Website",
};

/** The only people columns this module may update. `name_key` follows `name`; `org_id` is `company`. */
export const PERSON_DETAIL_COLUMNS: readonly string[] = [
  "name",
  "name_key",
  "title",
  "email",
  "phone",
  "linkedin_url",
  "country",
  "org_id",
];
/** The only orgs columns this module may update. */
export const ORG_DETAIL_COLUMNS: readonly string[] = ["website", "country"];

export type DetailInput = Partial<Record<DetailField, string | null>>;
export type ApplyResult = {
  status: "updated" | "partly" | "unchanged" | "missing" | "collision" | "unlogged";
  written: DetailField[];
  skipped: DetailField[];
  name: string;
};
type DetailsProposal = Extract<Proposal, { kind: "update_details" }>;

const SOURCE = "monsoon-app";
const OWNER = "VF";
const MAX_VALUE = 300;
// The most a signed proposal carries as a stored `from` value (see proposal.ts).
const MAX_FROM = 2000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_CONTACT = "No such contact.";
// Postgres's default name for UNIQUE NULLS NOT DISTINCT (org_id, name_key) on people (unnamed in the schema).
const PEOPLE_NAME_KEY = "people_org_id_name_key_key";
// Postgres's default name for UNIQUE NULLS NOT DISTINCT (org_id, person_id) on members.
const MEMBERS_TARGET_KEY = "members_org_id_person_id_key";
const FIELD_ORDER: readonly DetailField[] = ["name", "title", "email", "phone", "linkedin", "country", "company", "website"];
const PERSON_FIELDS: readonly DetailField[] = ["name", "title", "email", "phone", "linkedin", "country", "company"];
const ORG_FIELDS: readonly DetailField[] = ["website", "country"];
// Field to the column that holds its value (company is handled through org_id).
const PERSON_COLUMN_OF: Partial<Record<DetailField, string>> = {
  name: "name",
  title: "title",
  email: "email",
  phone: "phone",
  linkedin: "linkedin_url",
  country: "country",
};
const ORG_COLUMN_OF: Partial<Record<DetailField, string>> = { website: "website", country: "country" };

// One fixed UPDATE per table: each column takes its parameter when its flag is true, else keeps its value.
const COLUMN_TYPE: Record<string, string> = { org_id: "uuid" };
function assignments(columns: readonly string[]): string {
  return columns
    .map((c, i) => `${c} = CASE WHEN $${2 + 2 * i}::boolean THEN $${3 + 2 * i}::${COLUMN_TYPE[c] ?? "text"} ELSE ${c} END`)
    .join(", ");
}
export const UPDATE_PEOPLE = `UPDATE people SET ${assignments(PERSON_DETAIL_COLUMNS)} WHERE id = $1`;
export const UPDATE_ORGS = `UPDATE orgs SET ${assignments(ORG_DETAIL_COLUMNS)} WHERE id = $1`;

/** Trimmed text; empty becomes null. */
function norm(value: string | null | undefined): string | null {
  const v = typeof value === "string" ? value.trim() : "";
  return v === "" ? null : v;
}
function same(field: DetailField, a: string | null, b: string | null): boolean {
  const x = norm(a);
  const y = norm(b);
  if (x === null || y === null) return x === y;
  return field === "company" ? nameKey(x) === nameKey(y) : x === y;
}

type Target = { personId?: string; orgId?: string; memberId?: string };
type Row = { type: "person" | "company"; id: string; name: string; company: string | null; orgId: string | null; values: Record<string, string | null> };

const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

async function loadPerson(db: ClientBase, id: string, lock: boolean): Promise<Row | undefined> {
  // The person row is read alone: under READ COMMITTED a joined row would not be re-read after a
  // lock wait. The company name is a second read, from the locked row's org_id.
  const r = await db.query(
    `SELECT id, name, org_id, title, email, phone, linkedin_url, country
       FROM people WHERE id = $1${lock ? " FOR UPDATE" : ""}`,
    [id],
  );
  const p = r.rows[0];
  if (!p) return undefined;
  const orgName: string | null = p.org_id
    ? ((await db.query("SELECT name FROM orgs WHERE id = $1", [p.org_id])).rows[0]?.name ?? null)
    : null;
  return {
    type: "person",
    id: p.id,
    name: p.name,
    company: orgName,
    orgId: p.org_id ?? null,
    values: {
      name: p.name,
      title: p.title,
      email: p.email,
      phone: p.phone,
      linkedin: p.linkedin_url,
      country: p.country,
      company: orgName,
    },
  };
}

async function loadOrg(db: ClientBase, id: string, lock: boolean): Promise<Row | undefined> {
  const r = await db.query(`SELECT id, name, website, country FROM orgs WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id]);
  const o = r.rows[0];
  if (!o) return undefined;
  return { type: "company", id: o.id, name: o.name, company: null, orgId: o.id, values: { website: o.website, country: o.country } };
}

/**
 * The target row. When more than one id is given the most specific wins: the person, then the
 * company, then the member (a member id may stand for the company a person is filed under).
 */
async function resolve(db: ClientBase, target: Target): Promise<Row | undefined> {
  if (isUuid(target.personId)) return loadPerson(db, target.personId, false);
  if (isUuid(target.orgId)) return loadOrg(db, target.orgId, false);
  if (isUuid(target.memberId)) {
    const m = (await db.query("SELECT person_id, org_id FROM members WHERE id = $1", [target.memberId])).rows[0];
    if (!m) return undefined;
    return m.person_id ? loadPerson(db, m.person_id, false) : loadOrg(db, m.org_id, false);
  }
  return undefined;
}

/** The member whose timeline logs a change: the person's own, else their company's. */
async function logMemberFor(db: ClientBase, row: { type: string; id: string; orgId: string | null }): Promise<string | null> {
  if (row.type === "company") {
    return (await db.query("SELECT id FROM members WHERE org_id = $1", [row.id])).rows[0]?.id ?? null;
  }
  const own = (await db.query("SELECT id FROM members WHERE person_id = $1", [row.id])).rows[0];
  if (own) return own.id;
  if (!row.orgId) return null;
  return (await db.query("SELECT id FROM members WHERE org_id = $1", [row.orgId])).rows[0]?.id ?? null;
}

export async function proposeDetails(
  db: ClientBase,
  estate: EstateKey,
  target: Target,
  input: DetailInput,
  opts: { nowMs: number; defaultRole: string; newCompany?: boolean },
): Promise<ProposeResult> {
  return readOnly(db, async (): Promise<ProposeResult> => {
    const row = await resolve(db, target);
    if (!row) return { ok: false, reason: NO_CONTACT };
    const allowed = row.type === "person" ? PERSON_FIELDS : ORG_FIELDS;

    // Validate what was asked, then keep only what differs from what is on file.
    const wanted: { field: DetailField; to: string | null }[] = [];
    for (const field of FIELD_ORDER) {
      if (!Object.hasOwn(input, field) || input[field] === undefined) continue;
      if (!allowed.includes(field)) {
        return { ok: false, reason: `${DETAIL_LABELS[field]} cannot be changed on a ${row.type === "person" ? "person" : "company"}.` };
      }
      const raw = input[field];
      if (raw !== null && typeof raw !== "string") return { ok: false, reason: `${DETAIL_LABELS[field]} must be text.` };
      const to = norm(raw);
      if (field === "name" && to === null) return { ok: false, reason: "A name cannot be blank." };
      if (to !== null && to.length > MAX_VALUE) {
        return { ok: false, reason: `${DETAIL_LABELS[field]} is too long (limit ${MAX_VALUE} characters).` };
      }
      wanted.push({ field, to });
    }
    const changes: DetailChange[] = [];
    for (const { field, to } of wanted) {
      const from = norm(row.values[field]);
      if (same(field, from, to)) continue;
      // The signed proposal bounds `from`; a stored value past that cannot be carried, so refuse up front.
      if (from !== null && from.length > MAX_FROM) return { ok: false, reason: `${DETAIL_LABELS[field]} is too long to edit here.` };
      changes.push({ field, from, to });
    }
    if (changes.length === 0) return { ok: false, reason: "Nothing to change." };

    // The company, when it changes: an exact existing one as is, otherwise a new one past the lookalike guard.
    let resultingOrg: string | null = row.orgId;
    const companyChange = changes.find((c) => c.field === "company");
    if (companyChange) {
      resultingOrg = null;
      if (companyChange.to !== null) {
        const typed = companyChange.to;
        const found = (await db.query("SELECT id, name FROM orgs WHERE name_key = $1", [nameKey(typed)])).rows[0];
        if (found) {
          resultingOrg = found.id;
          companyChange.to = found.name;
        } else if (!opts.newCompany) {
          const existing = (await db.query("SELECT name FROM orgs")).rows.map((r) => r.name as string);
          const similar = similarOrgNames(typed, existing).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
          if (similar.length > 0) {
            return {
              ok: false,
              reason: `${typed} looks like ${similar.join(", ")}, already on file. Use that name, or say it is a different company.`,
            };
          }
        }
      }
    }

    // Another person with the resulting name at the resulting company.
    if (row.type === "person" && (changes.some((c) => c.field === "name") || companyChange)) {
      const nameChange = changes.find((c) => c.field === "name");
      const resultingName = nameChange?.to ?? row.name;
      const clash = await db.query(
        "SELECT 1 FROM people WHERE name_key = $1 AND org_id IS NOT DISTINCT FROM $2::uuid AND id <> $3 LIMIT 1",
        [nameKey(resultingName), resultingOrg, row.id],
      );
      if (clash.rows.length > 0) return { ok: false, reason: `Another ${resultingName} is already on file there.` };
    }

    const logMemberId = await logMemberFor(db, row);
    if (row.type === "company" && logMemberId === null) return { ok: false, reason: `${row.name} is not on the pipeline.` };

    const proposal: DetailsProposal = {
      kind: "update_details",
      estate,
      target: { type: row.type, id: row.id },
      targetName: row.name,
      company: row.company,
      changes,
      logMemberId,
      addsToPipeline: row.type === "person" && logMemberId === null ? opts.defaultRole : null,
      expires: opts.nowMs + PROPOSAL_TTL_MS,
    };
    return { ok: true, signed: { proposal, signature: signProposal(proposal) } };
  });
}

/** Run `fn` in one read-committed transaction; commit when it asks to, otherwise roll back. */
async function transaction<T>(db: ClientBase, fn: () => Promise<{ value: T; commit: boolean }>): Promise<T> {
  await db.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    await db.query("SET LOCAL statement_timeout = '10s'");
    const { value, commit } = await fn();
    await db.query(commit ? "COMMIT" : "ROLLBACK");
    return value;
  } catch (err) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
}

const display = (v: string | null) => v ?? "(empty)";

/**
 * Applies a proposal in one transaction. When the edit adds the person to the pipeline and a
 * concurrent capture added them first (a unique violation on members), it runs once more in a fresh
 * transaction, which finds the member and does not insert; a second violation is rethrown.
 */
export async function applyDetails(db: ClientBase, proposal: DetailsProposal): Promise<ApplyResult> {
  try {
    return await applyOnce(db, proposal);
  } catch (err) {
    const e = err as { code?: unknown; constraint?: unknown };
    if (e?.code === "23505" && e.constraint === MEMBERS_TARGET_KEY && proposal.addsToPipeline !== null) {
      return applyOnce(db, proposal);
    }
    throw err;
  }
}

function applyOnce(db: ClientBase, proposal: DetailsProposal): Promise<ApplyResult> {
  return transaction<ApplyResult>(db, async () => {
    const { target, changes } = proposal;
    const result = (status: ApplyResult["status"], written: DetailField[], skipped: DetailField[], name: string, commit = false) => ({
      value: { status, written, skipped, name },
      commit,
    });

    const row = target.type === "person" ? await loadPerson(db, target.id, true) : await loadOrg(db, target.id, true);
    if (!row) return result("missing", [], [], proposal.targetName);

    const fresh: DetailChange[] = [];
    const skipped: DetailField[] = [];
    for (const c of changes) {
      if (same(c.field, c.from, row.values[c.field])) fresh.push(c);
      else skipped.push(c.field);
    }
    if (fresh.length === 0) return result("unchanged", [], skipped, row.name);

    const resultingName = fresh.find((c) => c.field === "name")?.to ?? row.name;
    // A unique violation (a namesake appeared since the proposal) is reported; the caller rolls back.
    try {
      // The log member comes from the state before the change.
      let logMember = await logMemberFor(db, row);
      if (target.type === "company" && logMember === null) return result("unlogged", [], [], proposal.targetName);

      if (target.type === "person") {
        const set = new Map<string, string | null>();
        let orgId: string | null | undefined;
        for (const c of fresh) {
          const column = PERSON_COLUMN_OF[c.field];
          if (column) set.set(column, c.to);
          if (c.field === "name") set.set("name_key", nameKey(c.to as string));
          if (c.field === "company") orgId = c.to === null ? null : await findOrCreateOrg(db, c.to);
        }
        const params: unknown[] = [target.id];
        for (const column of PERSON_DETAIL_COLUMNS) {
          const on = column === "org_id" ? orgId !== undefined : set.has(column);
          params.push(on, column === "org_id" ? (orgId ?? null) : (set.get(column) ?? null));
        }
        await db.query(UPDATE_PEOPLE, params);

        if (logMember === null && proposal.addsToPipeline !== null) {
          const stage = (await db.query("SELECT key FROM stages WHERE NOT terminal ORDER BY ord LIMIT 1")).rows[0]?.key;
          logMember = (
            await db.query(
              `INSERT INTO members (person_id, role, stage, owner, source)
               VALUES ($1, $2, $3, $4, $5) RETURNING id`,
              [target.id, proposal.addsToPipeline, stage, OWNER, SOURCE],
            )
          ).rows[0].id;
        }
      } else {
        const set = new Map<string, string | null>();
        for (const c of fresh) {
          const column = ORG_COLUMN_OF[c.field];
          if (column) set.set(column, c.to);
        }
        const params: unknown[] = [target.id];
        for (const column of ORG_DETAIL_COLUMNS) params.push(set.has(column), set.get(column) ?? null);
        await db.query(UPDATE_ORGS, params);
      }

      if (logMember === null) return result("unlogged", [], [], proposal.targetName);
      const summary = `Details updated: ${fresh
        .map((c) => `${DETAIL_LABELS[c.field]}: ${display(c.from)} → ${display(c.to)}`)
        .join("; ")}`;
      await db.query("INSERT INTO touches (member_id, kind, by_whom, summary) VALUES ($1, 'system', $2, $3)", [
        logMember,
        OWNER,
        summary,
      ]);
    } catch (err) {
      const e = err as { code?: unknown; constraint?: unknown };
      if (e?.code === "23505" && e.constraint === PEOPLE_NAME_KEY) return result("collision", [], [], resultingName);
      throw err;
    }
    return result(skipped.length > 0 ? "partly" : "updated", fresh.map((c) => c.field), skipped, resultingName, true);
  });
}

/** The org with this name key, created (source monsoon-app) when there is none. */
async function findOrCreateOrg(db: ClientBase, name: string): Promise<string> {
  const key = nameKey(name);
  const existing = (await db.query("SELECT id FROM orgs WHERE name_key = $1", [key])).rows[0];
  if (existing) return existing.id;
  const inserted = await db.query(
    "INSERT INTO orgs (name, name_key, source) VALUES ($1, $2, $3) ON CONFLICT (name_key) DO NOTHING RETURNING id",
    [name, key, SOURCE],
  );
  if (inserted.rows[0]) return inserted.rows[0].id;
  return (await db.query("SELECT id FROM orgs WHERE name_key = $1", [key])).rows[0].id;
}
