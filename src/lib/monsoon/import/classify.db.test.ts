import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "../testing/db";
import { classifyRows } from "./classify";
import type { ImportContact } from "./mapping";

const testDb = makeTestDb("import_classify");

describe.skipIf(!testDb.available)("classifyRows (real Postgres)", () => {
  let db: Client;
  const id: Record<string, string> = {};

  async function org(name: string): Promise<string> {
    const r = await db.query("INSERT INTO orgs (name, name_key, source) VALUES ($1, lower($1), 'test') RETURNING id", [name]);
    return r.rows[0].id;
  }
  async function person(name: string, orgId: string | null, email: string | null = null): Promise<string> {
    const r = await db.query(
      "INSERT INTO people (org_id, name, name_key, email, source) VALUES ($1, $2, lower($2), $3, 'test') RETURNING id",
      [orgId, name, email],
    );
    return r.rows[0].id;
  }

  beforeAll(async () => {
    await testDb.reset();
    db = await testDb.connect();
    const acme = await org("Acme Capital");
    const beta = await org("Beta Partners");
    id.jane = await person("Jane Tan", acme, " Jane@Acme.com ");
    id.omar = await person("Omar Haddad", null);
    id.li = await person("Li Wei", beta);
    id.sam = await person("Sam Roe", null, "sam@roe.com");
  });
  afterAll(async () => {
    await db?.end();
  });
  beforeEach(() => undefined);

  const classes = async (rows: (ImportContact | null)[]) => (await classifyRows(db, rows)).map((r) => r.class);

  it("a stranger is new, a row with no name unreadable", async () => {
    expect(await classifyRows(db, [{ name: "Nobody Known", org: "Acme Capital", email: "n@x.com" }, null])).toEqual([
      { class: "new" },
      { class: "unreadable" },
    ]);
  });

  it("an email on file under the same name is existing, whatever the company", async () => {
    expect(await classifyRows(db, [{ name: "jane  TAN", org: "Other Co", email: "JANE@acme.com" }])).toEqual([
      { class: "existing", personId: id.jane },
    ]);
  });

  it("an email on file under another name is a possible match", async () => {
    expect(await classifyRows(db, [{ name: "Janet Tanner", email: "jane@acme.com" }])).toEqual([
      { class: "possible", personId: id.jane },
    ]);
  });

  it("name and company both matching is existing, with or without an email on the row", async () => {
    expect(await classifyRows(db, [{ name: "Jane Tan", org: "ACME  capital" }, { name: "Li Wei", org: "Beta Partners", email: "li@new.com" }])).toEqual([
      { class: "existing", personId: id.jane },
      { class: "existing", personId: id.li },
    ]);
  });

  it("same name and no company on either side is existing", async () => {
    expect(await classifyRows(db, [{ name: "Omar Haddad" }, { name: "Omar Haddad", email: "omar@new.com" }])).toEqual([
      { class: "existing", personId: id.omar },
      { class: "repeat" },
    ]);
  });

  it("same name, one side without a company: possible, with or without an email", async () => {
    expect(await classes([{ name: "Jane Tan" }])).toEqual(["possible"]);
    expect(await classes([{ name: "Jane Tan", email: "jane@elsewhere.com" }])).toEqual(["possible"]);
    expect(await classes([{ name: "Omar Haddad", org: "Gamma" }])).toEqual(["possible"]);
    expect(await classes([{ name: "Omar Haddad", org: "Gamma", email: "omar@gamma.com" }])).toEqual(["possible"]);
  });

  it("same name at another company: possible without an email, new with one", async () => {
    expect(await classifyRows(db, [{ name: "Jane Tan", org: "Gamma" }])).toEqual([{ class: "possible", personId: id.jane }]);
    expect(await classifyRows(db, [{ name: "Jane Tan", org: "Gamma", email: "jane@gamma.com" }])).toEqual([{ class: "new" }]);
  });

  it("a row matching an earlier row by email, or by name and company, is a repeat", async () => {
    expect(
      await classes([
        { name: "New One", org: "Gamma", email: "one@gamma.com" },
        { name: "New One", org: "Elsewhere", email: "ONE@gamma.com" },
        { name: "New Two", org: "Gamma" },
        { name: "new two", org: "gamma" },
        { name: "New Three" },
        { name: "New Three" },
      ]),
    ).toEqual(["new", "repeat", "new", "repeat", "new", "repeat"]);
  });

  it("a shared email on differently named rows: the second is possible", async () => {
    expect(await classes([{ name: "Ann Lee", email: "team@gamma.com" }, { name: "Bob Ray", email: "team@gamma.com" }])).toEqual(["new", "possible"]);
  });

  it("a second row for a person already on file is a repeat", async () => {
    expect(await classes([{ name: "Jane Tan", org: "Acme Capital" }, { name: "Jane Tan", org: "Acme Capital" }])).toEqual(["existing", "repeat"]);
  });

  it("the same new name at two companies in one file, with no email: the second is possible", async () => {
    expect(await classes([{ name: "Kim Park", org: "Gamma" }, { name: "Kim Park", org: "Delta" }])).toEqual(["new", "possible"]);
  });

  it("treats odd text as plain text", async () => {
    expect(await classes([{ name: "x' OR '1'='1", org: "%", email: "a@b.c'; --" }, { name: "%" }, { name: "_ane Tan", org: "Acme Capital" }])).toEqual([
      "new",
      "new",
      "new",
    ]);
  });

  it("classifies 200 rows in one statement, in one read-only transaction", async () => {
    const seen: string[] = [];
    const orig = db.query.bind(db) as (...a: unknown[]) => Promise<unknown>;
    (db as unknown as { query: unknown }).query = (...a: unknown[]) => {
      if (typeof a[0] === "string") seen.push(a[0]);
      return orig(...a);
    };
    try {
      const rows = Array.from({ length: 200 }, (_, i) => ({ name: `Person ${i}`, email: `p${i}@x.com` }));
      rows[7] = { name: "Jane Tan", email: "jane@acme.com" };
      const out = await classifyRows(db, rows);
      expect(out).toHaveLength(200);
      expect(out[7].class).toBe("existing");
      expect(out.filter((r) => r.class === "new")).toHaveLength(199);
      expect(seen).toHaveLength(4);
      expect(seen[0]).toBe("BEGIN TRANSACTION READ ONLY");
      expect(seen[3]).toBe("COMMIT");
    } finally {
      (db as unknown as { query: unknown }).query = orig;
    }
  });

  it("asks the database nothing when no row has a name", async () => {
    let calls = 0;
    const fake = { query: async () => (calls++, { rows: [] }) } as unknown as Client;
    expect(await classifyRows(fake, [null, null])).toEqual([{ class: "unreadable" }, { class: "unreadable" }]);
    expect(calls).toBe(0);
  });

  it("writes nothing", async () => {
    const before = (await db.query("SELECT (SELECT count(*) FROM people)::int AS p, (SELECT count(*) FROM orgs)::int AS o")).rows[0];
    await classifyRows(db, [{ name: "Brand New", org: "Brand New Co", email: "b@n.co" }]);
    expect((await db.query("SELECT (SELECT count(*) FROM people)::int AS p, (SELECT count(*) FROM orgs)::int AS o")).rows[0]).toEqual(before);
  });
});
