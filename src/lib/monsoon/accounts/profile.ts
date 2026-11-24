// The user's own page: their details (shared by every CRM they use), their work context for one
// pipeline, and the notes they add about themself. Read fresh from the accounts database, never the
// 60-second cache. The customer and person always come from the session; every statement is keyed
// on both, so a person reaches only their own rows and only their own customer's pipelines.
// Notes only accumulate: this module inserts them and never changes or removes one.
import type { Client } from "pg";
import { evictAccount, withAccountsDb } from "./store";

export type UserPage = {
  person: { name: string; phone: string | null; email: string | null };
  work: { company: string | null; website: string | null; roleObjectives: string | null };
  /** Newest first, at most 50, ISO times. */
  notes: { id: string; body: string; at: string }[];
  /** Every note of this person in this pipeline, including those not listed. */
  notesTotal: number;
};

export type PageInput = {
  name: string;
  phone: string | null;
  email: string | null;
  company: string | null;
  website: string | null;
  roleObjectives: string | null;
};

/** The signed-in customer and person, as the session gives them. */
export type Who = { customerId: string; personId: string };

/** The page plus, for every person of the customer, their account name by CRM key. */
export type AskContext = { page: UserPage; ownerNames: Record<string, string> };

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const MAX = { name: 80, phone: 40, email: 200, company: 200, website: 300, roleObjectives: 4000, note: 2000 } as const;
const NOTES_SHOWN = 50;
const ASK_TIMEOUT_MS = 3000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Only web addresses: the page may one day link or read it, so no other scheme is ever stored.
const WEBSITE = /^https?:\/\//i;

// One line: control characters and every kind of line break become a space, as Ask's prompt expects
// of a name. Done before storing, so nothing downstream has to trust the field.
const singleLine = (text: string): string =>
  text
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();

// Several lines: line breaks are kept (as \n) and tabs too; other control characters are dropped,
// a NUL among them, which Postgres cannot store.
const multiLine = (text: string): string =>
  text
    .replace(/\r\n?|[\u0085\u2028\u2029]/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .trim();

const tooLong = (label: string, max: number): string => `${label} is too long (${max.toLocaleString("en-US")} characters at most)`;

/** An optional field: missing, null or blank is null. */
function optional(raw: unknown, label: string, max: number, clean: (text: string) => string): Parsed<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: `${label} must be text` };
  const value = clean(raw);
  if (value === "") return { ok: true, value: null };
  if (value.length > max) return { ok: false, error: tooLong(label, max) };
  return { ok: true, value };
}

/** Checks and tidies what the page sends. Anything else in the body (an id, the estate) is ignored. */
export function parsePageInput(body: unknown): Parsed<PageInput> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "Invalid page" };
  const b = body as Record<string, unknown>;

  const name = optional(b.name, "Name", MAX.name, singleLine);
  if (!name.ok) return name;
  if (name.value === null) return { ok: false, error: "Enter your name" };
  const phone = optional(b.phone, "Phone", MAX.phone, singleLine);
  if (!phone.ok) return phone;
  const email = optional(b.email, "Email", MAX.email, singleLine);
  if (!email.ok) return email;
  if (email.value !== null && !EMAIL.test(email.value)) return { ok: false, error: "Enter a valid email address" };
  const company = optional(b.company, "Company", MAX.company, singleLine);
  if (!company.ok) return company;
  const website = optional(b.website, "Website", MAX.website, singleLine);
  if (!website.ok) return website;
  if (website.value !== null && !WEBSITE.test(website.value)) {
    return { ok: false, error: "The website must start with http:// or https://" };
  }
  const roleObjectives = optional(b.roleObjectives, "Role and objectives", MAX.roleObjectives, multiLine);
  if (!roleObjectives.ok) return roleObjectives;

  return {
    ok: true,
    value: {
      name: name.value,
      phone: phone.value,
      email: email.value,
      company: company.value,
      website: website.value,
      roleObjectives: roleObjectives.value,
    },
  };
}

/** Checks one note's text (the text itself, not the request around it). Inner line breaks are kept. */
export function parseNote(body: unknown): Parsed<string> {
  if (typeof body !== "string") return { ok: false, error: "Write a note first" };
  const value = multiLine(body);
  if (value === "") return { ok: false, error: "Write a note first" };
  if (value.length > MAX.note) return { ok: false, error: tooLong("The note", MAX.note) };
  return { ok: true, value };
}

/** The pipeline's id, found by the session's customer and the key; null when it is not theirs. */
async function findPipeline(db: Client, who: Who, pipelineKey: string): Promise<string | null> {
  const r = await db.query("SELECT id FROM pipelines WHERE customer_id = $1 AND key = $2", [who.customerId, pipelineKey]);
  return (r.rows[0]?.id as string | undefined) ?? null;
}

/**
 * Reads the page. The person is read by id AND customer first, and nothing else is read unless that
 * finds them, so a person id paired with the wrong customer gets an error and no rows.
 */
async function readPage(db: Client, who: Who, pipelineId: string): Promise<UserPage> {
  const p = await db.query("SELECT display_name, phone, email FROM people WHERE id = $2 AND customer_id = $1", [
    who.customerId,
    who.personId,
  ]);
  if (p.rowCount !== 1) throw new Error("Person not found");
  const w = await db.query("SELECT company, website, role_objectives FROM person_work WHERE person_id = $1 AND pipeline_id = $2", [
    who.personId,
    pipelineId,
  ]);
  const n = await db.query(
    `SELECT id, body, created_at, (count(*) OVER ())::int AS total
       FROM person_notes
      WHERE person_id = $1 AND pipeline_id = $2
      ORDER BY created_at DESC, id DESC
      LIMIT $3`,
    [who.personId, pipelineId, NOTES_SHOWN],
  );
  const person = p.rows[0] as { display_name: string; phone: string | null; email: string | null };
  const work = w.rows[0] as { company: string | null; website: string | null; role_objectives: string | null } | undefined;
  return {
    person: { name: person.display_name, phone: person.phone ?? null, email: person.email ?? null },
    work: {
      company: work?.company ?? null,
      website: work?.website ?? null,
      roleObjectives: work?.role_objectives ?? null,
    },
    notes: (n.rows as { id: string; body: string; created_at: Date }[]).map((r) => ({
      id: r.id,
      body: r.body,
      at: r.created_at.toISOString(),
    })),
    notesTotal: (n.rows[0]?.total as number | undefined) ?? 0,
  };
}

const RECORD_PROFILE = "INSERT INTO activity (customer_id, person_id, pipeline_key, action) VALUES ($1, $2, $3, 'profile')";

/** The person's page for one pipeline. Null when the pipeline is not one of their customer's. */
export async function loadUserPage(who: Who, pipelineKey: string): Promise<UserPage | null> {
  return withAccountsDb(async (db) => {
    const pipelineId = await findPipeline(db, who, pipelineKey);
    return pipelineId === null ? null : readPage(db, who, pipelineId);
  });
}

/**
 * Saves the details and this pipeline's work fields in one transaction and returns the page as it
 * now stands. Null (and nothing written) when the pipeline is not one of their customer's.
 */
export async function saveUserPage(who: Who, pipelineKey: string, input: PageInput): Promise<UserPage | null> {
  let saved = false;
  try {
    return await withAccountsDb(async (db) => {
      const pipelineId = await findPipeline(db, who, pipelineKey);
      if (pipelineId === null) return null;
      await db.query("BEGIN");
      try {
        const p = await db.query("UPDATE people SET display_name = $3, phone = $4, email = $5 WHERE id = $2 AND customer_id = $1", [
          who.customerId,
          who.personId,
          input.name,
          input.phone,
          input.email,
        ]);
        if (p.rowCount !== 1) throw new Error("Person not found");
        await db.query(
          `INSERT INTO person_work (person_id, pipeline_id, company, website, role_objectives)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (person_id, pipeline_id) DO UPDATE
             SET company = EXCLUDED.company, website = EXCLUDED.website,
                 role_objectives = EXCLUDED.role_objectives, updated_at = now()`,
          [who.personId, pipelineId, input.company, input.website, input.roleObjectives],
        );
        await db.query(RECORD_PROFILE, [who.customerId, who.personId, pipelineKey]);
        await db.query("COMMIT");
        saved = true;
      } catch (err) {
        await db.query("ROLLBACK").catch(() => undefined);
        throw err;
      }
      return readPage(db, who, pipelineId);
    });
  } finally {
    // The cached account rows hold the old name: drop them so it shows at once on this instance,
    // even when reading the page back failed after the save went through.
    if (saved) evictAccount(who.customerId, who.personId);
  }
}

/**
 * Adds one note for this pipeline and returns the page. Null (and nothing written) when the
 * pipeline is not one of their customer's. `body` has been through parseNote.
 */
export async function addUserNote(who: Who, pipelineKey: string, body: string): Promise<UserPage | null> {
  return withAccountsDb(async (db) => {
    const pipelineId = await findPipeline(db, who, pipelineKey);
    if (pipelineId === null) return null;
    await db.query("BEGIN");
    try {
      // Written only when the person is this customer's: the check and the write are one statement.
      const n = await db.query(
        `INSERT INTO person_notes (person_id, pipeline_id, body)
         SELECT p.id, $3::uuid, $4::text FROM people p WHERE p.id = $2 AND p.customer_id = $1`,
        [who.customerId, who.personId, pipelineId, body],
      );
      if (n.rowCount !== 1) throw new Error("Person not found");
      await db.query(RECORD_PROFILE, [who.customerId, who.personId, pipelineKey]);
      await db.query("COMMIT");
    } catch (err) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
    return readPage(db, who, pipelineId);
  });
}

/**
 * What Ask is told about the user: their page for this pipeline, and the account names of the
 * customer's people by CRM key (a rename shows in Ask without touching the CRM). One connection.
 * Rejects when it takes longer than `timeoutMs` (3 seconds unless given); the caller swallows that
 * and answers without it. Null when the pipeline is not one of their customer's.
 */
export async function loadAskContext(who: Who, pipelineKey: string, opts?: { timeoutMs?: number }): Promise<AskContext | null> {
  const timeoutMs = Math.max(1, Math.floor(opts?.timeoutMs ?? ASK_TIMEOUT_MS));
  const lookup = withAccountsDb(async (db): Promise<AskContext | null> => {
    // The limit is set inside a transaction, so it also holds behind a pooler that hands each
    // transaction to a different server session.
    await db.query("BEGIN READ ONLY");
    try {
      await db.query("SELECT set_config('statement_timeout', $1, true)", [String(timeoutMs)]);
      const pipelineId = await findPipeline(db, who, pipelineKey);
      if (pipelineId === null) return null;
      const page = await readPage(db, who, pipelineId);
      // Active people only: a suspended person's name must not reach their colleagues' assistant.
      const people = await db.query("SELECT owner_key, display_name FROM people WHERE customer_id = $1 AND status = 'active'", [
        who.customerId,
      ]);
      const ownerNames: Record<string, string> = {};
      for (const r of people.rows as { owner_key: string; display_name: string }[]) ownerNames[r.owner_key] = r.display_name;
      return { page, ownerNames };
    } finally {
      await db.query("ROLLBACK").catch(() => undefined);
    }
  });
  // The statement limit does not cover connecting, so the whole lookup is also raced against a timer.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Accounts lookup timed out")), timeoutMs);
  });
  try {
    return await Promise.race([lookup, expired]);
  } finally {
    clearTimeout(timer);
    // If the timer won, the lookup still ends by itself; its late error has nowhere to go.
    lookup.catch(() => undefined);
  }
}
