import type { ClientBase } from "pg";
import { nameKey } from "./rules";

// Records a Monsoon private-alpha sign-up from the quantcloud.com home page in the Zero One CRM.
// Only ever inserts: a person (named by their email) and a pipeline member when they are new, and
// one timeline note. Someone already on file is reused, never duplicated, and never overwritten.

export const ALPHA_NOTE = "Signed up for the Monsoon alpha on quantcloud.com";
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

export async function recordAlphaSignup(db: ClientBase, email: string, owner: string): Promise<AlphaResult> {
  const clean = email.trim().toLowerCase();
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
      const created = (
        await db.query(
          `INSERT INTO people (name, name_key, email, source) VALUES ($1, $2, $1, $3) RETURNING id`,
          [clean, nameKey(clean), SOURCE],
        )
      ).rows[0];
      memberId = await addMember(db, created.id as string, owner);
      status = "added";
    }

    const already = await db.query(
      `SELECT 1 FROM touches WHERE member_id = $1 AND kind = 'note' AND summary = $2 LIMIT 1`,
      [memberId, ALPHA_NOTE],
    );
    if ((already.rowCount ?? 0) > 0) {
      await db.query("COMMIT");
      return { status: "repeat" };
    }
    await db.query(`INSERT INTO touches (member_id, kind, by_whom, summary) VALUES ($1, 'note', $2, $3)`, [
      memberId,
      owner,
      ALPHA_NOTE,
    ]);
    await db.query("COMMIT");
    return { status };
  } catch (err) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
}
