// Bulk import, the save step. Each row is saved in its own small transaction and decided at save
// time by the same rules as the check (classify.ts): it never asks a question. A row that wrote
// something leaves a `captures` record whose id comes from the import id and the row number, so a
// row sent again is answered with what happened the first time and writes nothing.
//
// Five round trips for a row: begin, lock, look, write, commit. Role, first stage and owner are
// looked up once per call. Nothing here changes or removes a row that was already on file.
import { createHash } from "node:crypto";
import type { ClientBase } from "pg";
import { canHold, contactKeys, judge, type Candidate } from "./classify";
import { alsoInEntry, companyImportEntry, importedFromEntry } from "./entries";
import { cleanContact, type ImportContact } from "./mapping";

export type SaveOutcome = "added" | "existing" | "possible_skipped" | "skipped" | "unreadable" | "repeat" | "failed";

/**
 * `filedUnder` is set only for a person just added under a company that is itself the pipeline
 * entry: that entry's member id. Such a person gets no timeline entry of their own; pass the
 * results to noteCompanyImports for the one summary entry per company.
 */
export type SaveRowResult = { rowNumber: number; outcome: SaveOutcome; filedUnder?: string };

export type SaveImportInput = {
  importId: string; // UUID, made by the browser once per import
  label: string;
  role: string;
  owner: string;
  includePossible: boolean;
  rows: { rowNumber: number; contact: ImportContact | null }[];
};

/** The caller sent something that can never be saved (role, owner, import id, label). */
export class ImportInputError extends Error {}

export const IMPORT_CHANNEL = "monsoon-import";
export const MAX_LABEL = 80;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`, "g");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A label as stored and shown: one line, no control characters, trimmed, at most 80 characters. */
export function cleanLabel(label: unknown): string {
  if (typeof label !== "string") return "";
  return label.replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL).trim();
}

/** The capture id of one row of one import: a UUID worked out from both, the same every time. */
export function importCaptureId(importId: string, rowNumber: number): string {
  const hex = createHash("sha256").update(`monsoon-import:${importId.toLowerCase()}:${rowNumber}`).digest("hex");
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** "2021-03-02" -> "2 Mar 2021". */
function shortDate(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// One call's lookups.
const SETUP_SQL = `SELECT EXISTS (SELECT 1 FROM roles WHERE key = $1) AS role_ok,
       EXISTS (SELECT 1 FROM owners WHERE key = $2) AS owner_ok,
       (SELECT key FROM stages WHERE NOT terminal ORDER BY ord LIMIT 1) AS stage`;

// The row's lock, as capture.ts takes it, and the transaction's time limit in the same round trip.
const LOCK_SQL = "SELECT set_config('statement_timeout', '10s', true), pg_advisory_xact_lock(hashtextextended($1, 0))";

// An earlier capture of this row, and everyone the row could match (same name key or same email),
// oldest first. `in_import` is true for a person this import has already added or noted.
const LOOK_SQL = `SELECT 'capture' AS what, NULL::uuid AS id, c.extracted->>'outcome' AS name_key, NULL::text AS org_key,
       NULL::text AS email_lc, NULL::uuid AS org_id, NULL::uuid AS own_id, false AS in_import, c.created_at
  FROM captures c
 WHERE c.capture_id = $1::uuid
UNION ALL
SELECT 'person', p.id, p.name_key, po.name_key, NULLIF(lower(btrim(p.email)), ''), p.org_id, own.id,
       EXISTS (SELECT 1 FROM captures ic
                WHERE ic.person_id = p.id AND ic.channel = '${IMPORT_CHANNEL}' AND ic.extracted->>'importId' = $4::text),
       p.created_at
  FROM people p
  LEFT JOIN orgs po ON po.id = p.org_id
  LEFT JOIN members own ON own.person_id = p.id
 WHERE p.name_key = $2::text OR lower(btrim(p.email)) = $3::text
 ORDER BY what, created_at, id`;

// A new person, in one statement: the company (found by its exact name key, else made), the
// person, a pipeline entry of their own unless the company already is one, the capture record and
// the timeline entry. Filed as capture.ts files a new person with a company. When another save made
// the same company at this very moment `person` comes back null and the row is tried again.
const ADD_SQL = `WITH o AS (
  SELECT id FROM orgs WHERE name_key = $2::text
), new_o AS (
  INSERT INTO orgs (name, name_key, source)
  SELECT $1::text, $2::text, $3::text WHERE $1::text IS NOT NULL AND NOT EXISTS (SELECT 1 FROM o)
  ON CONFLICT (name_key) DO NOTHING
  RETURNING id
), org AS (
  SELECT id FROM o UNION ALL SELECT id FROM new_o
), p AS (
  INSERT INTO people (org_id, name, name_key, title, email, phone, linkedin_url, country, notes, source)
  SELECT (SELECT id FROM org), $4::text, $5::text, $6::text, $7::text, $8::text, $9::text, $10::text, $11::text, $3::text
   WHERE $1::text IS NULL OR EXISTS (SELECT 1 FROM org)
  RETURNING id, org_id
), cm AS (
  SELECT m.id FROM members m WHERE m.org_id = (SELECT id FROM o)
), m AS (
  INSERT INTO members (person_id, role, stage, owner, source)
  SELECT p.id, $12::text, $13::text, $14::text, $3::text FROM p WHERE NOT EXISTS (SELECT 1 FROM cm)
  RETURNING id
), cap AS (
  INSERT INTO captures (capture_id, channel, status, extracted, person_id, org_id)
  SELECT $15::uuid, '${IMPORT_CHANNEL}', 'written', $16::jsonb, p.id, p.org_id FROM p
  RETURNING id
), t AS (
  INSERT INTO touches (member_id, kind, by_whom, summary)
  SELECT m.id, 'system', $14::text, $17::text FROM m
  RETURNING id
)
SELECT (SELECT id FROM p) AS person, (SELECT id FROM cm) AS company_member`;

// Someone already on file who has a pipeline entry of their own: one timeline entry and the capture
// record that stops a second one for this import. Nothing of theirs is changed.
const ALSO_SQL = `WITH t AS (
  INSERT INTO touches (member_id, kind, by_whom, summary) VALUES ($1::uuid, 'system', $2::text, $3::text)
  RETURNING id
)
INSERT INTO captures (capture_id, channel, status, extracted, person_id, org_id)
VALUES ($4::uuid, '${IMPORT_CHANNEL}', 'written', $5::jsonb, $6::uuid, $7::uuid)`;

type Found = Candidate & { orgId: string | null; ownMember: string | null; inImport: boolean };

class TryAgain extends Error {}

/**
 * Saves the rows one by one and answers one result per row, in the order given. A failure in one
 * row is `failed` for that row only. Rows not started by `opts.deadline` (epoch milliseconds) are
 * answered `failed` untouched, so a request can stop inside its time limit; sending them again is safe.
 * Throws ImportInputError for an unknown role or owner, a bad import id or an empty label; anything
 * else thrown is the database being unreachable for the lookups.
 */
export async function saveImportRows(db: ClientBase, input: SaveImportInput, opts: { deadline?: number } = {}): Promise<SaveRowResult[]> {
  const importId = typeof input.importId === "string" && UUID_RE.test(input.importId) ? input.importId.toLowerCase() : null;
  if (importId === null) throw new ImportInputError("importId must be a UUID");
  const label = cleanLabel(input.label);
  if (label === "") throw new ImportInputError("label is required");
  const setup = (await db.query(SETUP_SQL, [input.role, input.owner])).rows[0];
  if (!setup.role_ok) throw new ImportInputError(`unknown role: ${input.role}`);
  if (!setup.owner_ok) throw new ImportInputError("unknown owner");
  if (!setup.stage) throw new ImportInputError("the pipeline has no open stage");
  const source = `import:${label}`;

  async function attempt(rowNumber: number, contact: ImportContact): Promise<SaveRowResult> {
    const captureId = importCaptureId(importId as string, rowNumber);
    const keys = contactKeys(contact);
    await db.query(LOCK_SQL, [captureId]);
    const looked = await db.query(LOOK_SQL, [captureId, keys.nameKey, keys.email, importId]);
    const earlier = looked.rows.find((r) => r.what === "capture");
    if (earlier) return { rowNumber, outcome: earlier.name_key === "added" ? "added" : "existing" };

    const people: Found[] = looked.rows.map((r) => ({
      id: r.id,
      nameKey: r.name_key,
      orgKey: r.org_key,
      email: r.email_lc,
      orgId: r.org_id,
      ownMember: r.own_id,
      inImport: r.in_import === true,
    }));
    const verdict = judge(keys, people);
    const record = (outcome: "added" | "existing") => JSON.stringify({ importId, rowNumber, outcome });

    if (verdict.class === "existing") {
      const person = verdict.match;
      if (person.inImport) return { rowNumber, outcome: "repeat" };
      if (person.ownMember !== null) {
        await db.query(ALSO_SQL, [person.ownMember, input.owner, alsoInEntry(label), captureId, record("existing"), person.id, person.orgId]);
      }
      return { rowNumber, outcome: "existing" };
    }
    if (verdict.class === "possible") {
      if (!input.includePossible) return { rowNumber, outcome: "skipped" };
      if (!canHold(keys, people)) return { rowNumber, outcome: "possible_skipped" };
    }

    let summary = importedFromEntry(label);
    if (contact.connectedOn) summary += ` Connected on LinkedIn ${shortDate(contact.connectedOn)}.`;
    const added = (
      await db.query(ADD_SQL, [
        contact.org ?? null,
        keys.orgKey,
        source,
        contact.name,
        keys.nameKey,
        contact.title ?? null,
        contact.email ?? null,
        contact.phone ?? null,
        contact.linkedin ?? null,
        contact.country ?? null,
        contact.notes ?? null,
        input.role,
        setup.stage,
        input.owner,
        captureId,
        record("added"),
        summary,
      ])
    ).rows[0];
    if (!added?.person) throw new TryAgain();
    return added.company_member ? { rowNumber, outcome: "added", filedUnder: added.company_member } : { rowNumber, outcome: "added" };
  }

  async function saveRow(rowNumber: number, contact: ImportContact): Promise<SaveRowResult> {
    // A second go only when another save wrote the same company or person at the same moment: the
    // row is then decided again, and finds them.
    for (let tries = 0; ; tries++) {
      try {
        await db.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        const result = await attempt(rowNumber, contact);
        await db.query("COMMIT");
        return result;
      } catch (err) {
        await db.query("ROLLBACK").catch(() => undefined);
        const clash = err instanceof TryAgain || (err as { code?: string } | null)?.code === "23505";
        if (clash && tries === 0) continue;
        // Code only: the message can carry the row's contents.
        console.error("monsoon: import row failed", err instanceof Error ? err.name : "error", (err as { code?: string } | null)?.code ?? "");
        return { rowNumber, outcome: "failed" };
      }
    }
  }

  const results: SaveRowResult[] = [];
  for (const row of input.rows) {
    const rowNumber = row?.rowNumber;
    const contact = cleanContact(row?.contact);
    if (!Number.isInteger(rowNumber) || rowNumber < 0) results.push({ rowNumber, outcome: "failed" });
    else if (contact === null) results.push({ rowNumber, outcome: "unreadable" });
    else if (opts.deadline !== undefined && Date.now() > opts.deadline) results.push({ rowNumber, outcome: "failed" });
    else results.push(await saveRow(rowNumber, contact));
  }
  return results;
}

/**
 * One timeline entry per company for the people just filed under it: "<n> people imported from
 * <label>." Call once per request with that request's results. One statement.
 */
export async function noteCompanyImports(db: ClientBase, o: { label: string; owner: string; results: SaveRowResult[] }): Promise<void> {
  const label = cleanLabel(o.label);
  const filed = new Map<string, number>();
  for (const r of o.results) {
    if (r.outcome === "added" && r.filedUnder) filed.set(r.filedUnder, (filed.get(r.filedUnder) ?? 0) + 1);
  }
  if (filed.size === 0 || label === "") return;
  const members = [...filed.keys()];
  const summaries = members.map((m) => companyImportEntry(filed.get(m) as number, label));
  await db.query(
    `INSERT INTO touches (member_id, kind, by_whom, summary)
     SELECT x.member_id, 'system', $3::text, x.summary FROM unnest($1::uuid[], $2::text[]) AS x(member_id, summary)`,
    [members, summaries, o.owner],
  );
}
