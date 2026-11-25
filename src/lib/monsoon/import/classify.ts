// Bulk import, the check before saving: is each row a new person, someone already on file, a
// possible match, a repeat of an earlier row, or unreadable? Read-only: one `readOnly` transaction
// and one set-based statement for the whole batch, as match.ts does. `judge` holds the rules and is
// used again by the save step, which decides for itself at save time.
import type { ClientBase } from "pg";
import { readOnly, type QueryOptions } from "../ask/queries";
import { nameKey } from "../rules";
import type { ImportContact } from "./mapping";

export type RowClass = "new" | "existing" | "possible" | "unreadable" | "repeat";
export type RowVerdict = { class: RowClass; personId?: string };

/** What a row or a person on file is compared by. A missing company or email is null. */
export type Keys = { nameKey: string; orgKey: string | null; email: string | null };
export type Candidate = Keys & { id: string };

export function contactKeys(contact: ImportContact): Keys {
  return {
    nameKey: nameKey(contact.name),
    orgKey: contact.org ? nameKey(contact.org) : null,
    email: contact.email ? contact.email.trim().toLowerCase() : null,
  };
}

/**
 * The rules, against the people given (oldest first):
 * - the row's email is on file under the same name: existing; under another name: possible;
 * - otherwise by name: the same company, or no company on either side: existing;
 * - the same name but one side has no company: possible;
 * - the same name at another company: possible when the row has no email to settle it, else new.
 */
export function judge<C extends Candidate>(row: Keys, people: C[]): { class: "new" } | { class: "existing" | "possible"; match: C } {
  if (row.email !== null) {
    const byEmail = people.filter((p) => p.email === row.email);
    const same = byEmail.find((p) => p.nameKey === row.nameKey);
    if (same) return { class: "existing", match: same };
    if (byEmail.length > 0) return { class: "possible", match: byEmail[0] };
  }
  const namesakes = people.filter((p) => p.nameKey === row.nameKey);
  if (namesakes.length === 0) return { class: "new" };
  const sameCompany = namesakes.find((p) => p.orgKey === row.orgKey);
  if (sameCompany) return { class: "existing", match: sameCompany };
  const oneSideBlank = namesakes.find((p) => p.orgKey === null || row.orgKey === null);
  if (oneSideBlank) return { class: "possible", match: oneSideBlank };
  return row.email === null ? { class: "possible", match: namesakes[0] } : { class: "new" };
}

/**
 * True when a new person with these keys can be stored beside the people given: nobody on file
 * has the same name at the same company (or the same name with no company on either side).
 */
export function canHold(row: Keys, people: Candidate[]): boolean {
  return !people.some((p) => p.nameKey === row.nameKey && p.orgKey === row.orgKey);
}

/** People who could match any of the rows: same name key or same email. Oldest first. */
export const CANDIDATES_SQL = `SELECT p.id, p.name_key, po.name_key AS org_key, NULLIF(lower(btrim(p.email)), '') AS email_lc
   FROM people p
   LEFT JOIN orgs po ON po.id = p.org_id
  WHERE p.name_key = ANY($1::text[]) OR lower(btrim(p.email)) = ANY($2::text[])
  ORDER BY p.created_at, p.id`;

/**
 * One verdict per row, same order (null = a row with no name). A row is first compared with the
 * rows before it in the same batch: one that would be "existing" against an earlier row is a
 * `repeat`. Then with the people on file. A row that is new on file but a possible match of an
 * earlier row (a shared email under another name, the same name at another company) is `possible`.
 */
export function classifyRows(db: ClientBase, contacts: (ImportContact | null)[], opts?: QueryOptions): Promise<RowVerdict[]> {
  const keys = contacts.map((c) => (c ? contactKeys(c) : null));
  const named = keys.filter((k): k is Keys => k !== null && k.nameKey !== "");
  if (named.length === 0) return Promise.resolve(contacts.map(() => ({ class: "unreadable" as const })));
  return readOnly(
    db,
    async () => {
      const found = await db.query(CANDIDATES_SQL, [
        [...new Set(named.map((k) => k.nameKey))],
        [...new Set(named.map((k) => k.email).filter((e): e is string => e !== null))],
      ]);
      const onFile: Candidate[] = found.rows.map((r) => ({ id: r.id, nameKey: r.name_key, orgKey: r.org_key, email: r.email_lc }));
      const earlier: Candidate[] = [];
      return keys.map((row, i): RowVerdict => {
        if (row === null || row.nameKey === "") return { class: "unreadable" };
        const inFile = judge(row, earlier);
        earlier.push({ ...row, id: String(i) });
        if (inFile.class === "existing") return { class: "repeat" };
        const stored = judge(row, onFile);
        if (stored.class !== "new") return { class: stored.class, personId: stored.match.id };
        return { class: inFile.class === "possible" ? "possible" : "new" };
      });
    },
    opts,
  );
}
