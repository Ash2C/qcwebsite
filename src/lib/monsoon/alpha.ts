import type { ClientBase } from "pg";
import { nameKey } from "./rules";

// Records a Monsoon private-alpha sign-up from the quantcloud.com home page in the Zero One CRM.
// Only ever inserts: a person (named by their email) and a pipeline member when they are new, and
// one timeline note. Someone already on file is reused, never duplicated, and never overwritten.

// Paused 2026-11-13 until email and phone verification are built: the route saves nothing.
export const SIGNUPS_OPEN = false;

export const ALPHA_NOTE = "Signed up for the Monsoon alpha on quantcloud.com";
/** The note for someone whose request to join Monsoon was approved. */
export const APPROVED_NOTE = "Approved for Monsoon on quantcloud.com";
const MAX_NAME = 200;
const SOURCE = "monsoon-alpha";
const ROLE = "reader";

export type AlphaResult = { status: "added" | "existing" | "repeat" };

async function addMember(db: ClientBase, personId: string, owner: string): Promise<string> {
  const stage = (await db.query("SELECT key FROM stages WHERE NOT terminal ORDER BY ord LIMIT 1")).rows[0]?.key;
  const role = (await db.query("SELECT key FROM roles WHERE key = $1", [ROLE])).rows[0]?.key;
  if (!stage || !role) throw new Error("The CRM is missing its first stage or the reader role");
  const row = (
    await db.query(
      `INSERT INTO members (person_id, role, stage, owner, source) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [personId, role, stage, owner, SOURCE],
    )
  ).rows[0];
  return row.id as string;
}

/**
 * `opts.name` names a new person by their name instead of their email (unless someone else without
 * a company is already on file under that name: then the email is used, as before). `opts.note` is
 * the timeline note to leave (default: the alpha sign-up note); the same note is never left twice.
 */
export async function recordAlphaSignup(
  db: ClientBase,
  email: string,
  owner: string,
  opts: { name?: string; note?: string } = {},
): Promise<AlphaResult> {
  const clean = email.trim().toLowerCase();
  const note = opts.note ?? ALPHA_NOTE;
  const wanted = (opts.name ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME).trim();
  await db.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    await db.query("SET LOCAL statement_timeout = '8s'");
    // Two submissions of the same email at once write once.
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`monsoon-alpha:${clean}`]);

    const person = (
      await db.query(
        `SELECT p.id,
                (SELECT m.id FROM members m WHERE m.person_id = p.id) AS own_member,
                (SELECT m.id FROM members m WHERE p.org_id IS NOT NULL AND m.org_id = p.org_id) AS org_member
           FROM people p
          WHERE lower(p.email) = $1
          ORDER BY p.created_at, p.id
          LIMIT 1`,
        [clean],
      )
    ).rows[0] as { id: string; own_member: string | null; org_member: string | null } | undefined;

    let memberId: string;
    let status: AlphaResult["status"];
    if (person) {
      status = "existing";
      memberId = person.own_member ?? person.org_member ?? (await addMember(db, person.id, owner));
    } else {
      let name = clean;
      if (wanted) {
        const taken = await db.query("SELECT 1 FROM people WHERE org_id IS NULL AND name_key = $1 LIMIT 1", [nameKey(wanted)]);
        if ((taken.rowCount ?? 0) === 0) name = wanted;
      }
      const created = (
        await db.query(
          `INSERT INTO people (name, name_key, email, source) VALUES ($1, $2, $3, $4) RETURNING id`,
          [name, nameKey(name), clean, SOURCE],
        )
      ).rows[0];
      memberId = await addMember(db, created.id as string, owner);
      status = "added";
    }

    const already = await db.query(
      `SELECT 1 FROM touches WHERE member_id = $1 AND kind = 'note' AND summary = $2 LIMIT 1`,
      [memberId, note],
    );
    if ((already.rowCount ?? 0) > 0) {
      await db.query("COMMIT");
      return { status: "repeat" };
    }
    await db.query(`INSERT INTO touches (member_id, kind, by_whom, summary) VALUES ($1, 'note', $2, $3)`, [
      memberId,
      owner,
      note,
    ]);
    await db.query("COMMIT");
    return { status };
  } catch (err) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
}
