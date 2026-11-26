import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listMembers, type Sort } from "./sift";
import { makeTestDb } from "./testing/db";

const testDb = makeTestDb("sift_many");
const TODAY = "2026-11-25";
const PEOPLE = 2150;

// A pipeline larger than the list ever shows, as a few imports make it. Everyone who belongs at
// the top of a sort was added last, so a list cut before it is sorted would miss them.
describe.skipIf(!testDb.available)("the Contacts list beyond 2,000 pipeline entries (real Postgres)", () => {
  let db: Client;
  const top = async (sort: Sort, high = false) => {
    const r = await listMembers(db, { high, sort, today: TODAY });
    return { names: r.contacts.slice(0, 5).map((c) => c.name), shown: r.contacts.length, total: r.total };
  };

  beforeAll(async () => {
    await testDb.reset();
    db = await testDb.connect();
    await db.query(
      `INSERT INTO people (name, name_key, source)
       SELECT 'P ' || lpad(i::text, 4, '0'), 'p ' || lpad(i::text, 4, '0'), 'seed' FROM generate_series(1, ${PEOPLE}) AS i`,
    );
    // The later a person was added, the more recently they were updated.
    await db.query(
      `INSERT INTO members (person_id, role, stage, owner, source, priority, next_action, next_action_date, created_at, updated_at)
       SELECT p.id, 'investor',
              CASE WHEN i IN (2102, 2149) THEN 'uncontacted' WHEN i = 2103 THEN 'contacted' ELSE 'engaged' END,
              'VF', 'seed',
              CASE WHEN i IN (5, 2148) THEN 'high' END,
              CASE WHEN i IN (2120, 2140, 2150) THEN 'Call' WHEN i = 2130 THEN '   ' END,
              CASE i WHEN 2150 THEN DATE '2026-11-20' WHEN 2140 THEN DATE '2026-12-01' WHEN 2130 THEN DATE '2026-01-01' END,
              now() - interval '90 days', now() - (${PEOPLE + 1} - i) * interval '1 minute'
         FROM (SELECT id, substr(name, 3)::int AS i FROM people) p
        ORDER BY i`,
    );
    // A company that is itself a pipeline entry, updated a day ago.
    const org = (await db.query("INSERT INTO orgs (name, name_key, source) VALUES ('Zulu Holdings', 'zulu holdings', 'seed') RETURNING id")).rows[0].id;
    await db.query(
      `INSERT INTO members (org_id, role, stage, owner, source, created_at, updated_at)
       VALUES ($1, 'introducer', 'engaged', 'VF', 'seed', now() - interval '90 days', now() - interval '1 day')`,
      [org],
    );
    const touch = (i: number, kind: string, ago: string) =>
      db.query(
        `INSERT INTO touches (member_id, at, kind, by_whom, summary)
         SELECT m.id, now() - $3::interval, $2, 'VF', 'x' FROM members m JOIN people p ON p.id = m.person_id WHERE p.name = $1`,
        [`P ${String(i).padStart(4, "0")}`, kind, ago],
      );
    await touch(2145, "call", "3 hours");
    await touch(2111, "meeting", "5 hours");
    // Not an action, and newer than any: it counts for Recent only.
    await touch(2100, "system", "1 second");
  });
  afterAll(async () => {
    await db?.end();
  });

  it("shows 100 rows and counts every entry", async () => {
    for (const sort of ["recent", "next", "last", "stage"] as const) {
      expect(await top(sort)).toMatchObject({ shown: 100, total: PEOPLE + 1 });
    }
  });

  it("recent: the most recently touched or updated first", async () => {
    expect((await top("recent")).names).toEqual(["P 2100", "P 2150", "P 2149", "P 2148", "P 2147"]);
  });

  it("next: the soonest dated next action, then next actions with no date, then the rest by name", async () => {
    // P 2130 has a date but a blank next action: it has none.
    expect((await top("next")).names).toEqual(["P 2150", "P 2140", "P 2120", "P 0001", "P 0002"]);
  });

  it("last: the most recent call, meeting, email or note first, then the rest by name", async () => {
    expect((await top("last")).names).toEqual(["P 2145", "P 2111", "P 0001", "P 0002", "P 0003"]);
  });

  it("stage: in pipeline order, by name within a stage", async () => {
    expect((await top("stage")).names).toEqual(["P 2102", "P 2149", "P 2103", "P 0001", "P 0002"]);
  });

  it("high priority only: counted and ordered the same way", async () => {
    expect(await top("recent", true)).toEqual({ names: ["P 2148", "P 0005"], shown: 2, total: 2 });
  });

  it("answers quickly", async () => {
    const started = Date.now();
    await top("recent");
    await top("next");
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
