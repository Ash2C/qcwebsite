import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ImportContact } from "./import/mapping";
import { noteCompanyImports, saveImportRows } from "./import/save";
import { listImported, listImports } from "./sift";
import { makeTestDb } from "./testing/db";

const testDb = makeTestDb("sift_imports");
const TODAY = "2026-11-25";

describe.skipIf(!testDb.available)("the Imports filter (real Postgres)", () => {
  let db: Client;
  let northwind: string;

  async function bring(label: string, rows: ImportContact[]): Promise<void> {
    const results = await saveImportRows(db, {
      importId: randomUUID(),
      label,
      role: "investor",
      owner: "VF",
      includePossible: false,
      rows: rows.map((contact, i) => ({ rowNumber: i + 1, contact })),
    });
    expect(results.map((r) => r.outcome)).toEqual(rows.map(() => "added"));
    await noteCompanyImports(db, { label, owner: "VF", results });
  }

  beforeAll(async () => {
    await testDb.reset();
    db = await testDb.connect();
    // On file before any import, and a company that is itself a pipeline entry.
    await db.query("INSERT INTO people (name, name_key, source) VALUES ('Old Hand', 'old hand', 'monsoon-app')");
    const org = (await db.query("INSERT INTO orgs (name, name_key, source) VALUES ('Northwind', 'northwind', 'core') RETURNING id")).rows[0].id;
    northwind = (
      await db.query("INSERT INTO members (org_id, role, stage, owner, source) VALUES ($1, 'introducer', 'engaged', 'VF', 'core') RETURNING id", [org])
    ).rows[0].id;
    await bring("LinkedIn import, October 2026", [
      { name: "Cara Diaz", org: "Acme Capital", title: "CIO", email: "cara@acme.com" },
      { name: "Abe Stone" },
      { name: "Bea Park", org: "Northwind" },
    ]);
    await bring("50% off_list", [{ name: "Dan Wu", org: "Acme Capital" }]);
    await db.query("UPDATE members SET priority = 'high' WHERE person_id = (SELECT id FROM people WHERE name = 'Abe Stone')");
  });
  afterAll(async () => {
    await db?.end();
  });

  it("lists the imports with their counts, newest first", async () => {
    const imports = await listImports(db);
    expect(imports.map((i) => [i.label, i.count])).toEqual([
      ["50% off_list", 1],
      ["LinkedIn import, October 2026", 3],
    ]);
    for (const i of imports) expect(new Date(i.at as string).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("lists nothing when nothing was imported", async () => {
    const other = makeTestDb("sift_imports_empty");
    await other.reset();
    const c = await other.connect();
    try {
      expect(await listImports(c)).toEqual([]);
      expect(await listImported(c, { label: "x", high: false, sort: "recent", today: TODAY })).toEqual({ contacts: [], total: 0 });
    } finally {
      await c.end();
    }
  });

  it("lists the contacts of one import, each with its pipeline entry and work", async () => {
    const { contacts, total } = await listImported(db, { label: "LinkedIn import, October 2026", high: false, sort: "stage", today: TODAY });
    expect(total).toBe(3);
    // In pipeline order: the two in the first stage by name, then the one under the engaged company.
    expect(contacts.map((c) => c.name)).toEqual(["Abe Stone", "Cara Diaz", "Bea Park"]);
    const cara = contacts[1];
    expect(cara).toMatchObject({ kind: "person", title: "CIO", company: "Acme Capital", email: "cara@acme.com", memberOf: "self" });
    expect(cara.personId).toMatch(/^[0-9a-f-]{36}$/);
    expect(cara.member).toMatchObject({ memberKind: "person", role: "investor", stage: "uncontacted" });
    expect(cara.work).toMatchObject({ priority: null, nextAction: null, lastKind: null, lastAt: null, stageOrd: 0 });
    const bea = contacts[2];
    expect(bea).toMatchObject({ company: "Northwind", memberOf: "company" });
    expect(bea.member).toEqual({ memberId: northwind, memberKind: "company", role: "introducer", stage: "engaged" });
    expect(bea.work).toMatchObject({ stageOrd: 2, lastKind: null });
  });

  it("matches the label exactly, as plain text", async () => {
    const list = (label: string) => listImported(db, { label, high: false, sort: "recent", today: TODAY });
    expect((await list("50% off_list")).contacts.map((c) => c.name)).toEqual(["Dan Wu"]);
    for (const label of ["50% off list", "%", "50%", "linkedin import, october 2026", "' OR '1'='1", ""]) {
      expect(await list(label)).toEqual({ contacts: [], total: 0 });
    }
  });

  it("keeps only the high-priority ones when asked", async () => {
    const { contacts, total } = await listImported(db, { label: "LinkedIn import, October 2026", high: true, sort: "recent", today: TODAY });
    expect(contacts.map((c) => c.name)).toEqual(["Abe Stone"]);
    expect(total).toBe(1);
  });

  it("answers at most 100 rows and counts them all", async () => {
    const rows = Array.from({ length: 130 }, (_, n) => ({ name: `Bulk ${String(n).padStart(3, "0")}` }));
    await bring("Big list", rows.slice(0, 100));
    await bring("Big list", rows.slice(100));
    const { contacts, total } = await listImported(db, { label: "Big list", high: false, sort: "stage", today: TODAY });
    expect(total).toBe(130);
    expect(contacts).toHaveLength(100);
    expect(contacts[0].name).toBe("Bulk 000");
    expect((await listImports(db))[0]).toMatchObject({ label: "Big list", count: 130 });
  });

  it("reads only", async () => {
    const seen: string[] = [];
    const orig = db.query.bind(db) as (...a: unknown[]) => Promise<unknown>;
    (db as unknown as { query: unknown }).query = (...a: unknown[]) => {
      if (typeof a[0] === "string") seen.push(a[0]);
      return orig(...a);
    };
    try {
      await listImports(db);
      await listImported(db, { label: "Big list", high: false, sort: "recent", today: TODAY });
    } finally {
      (db as unknown as { query: unknown }).query = orig;
    }
    expect(seen.filter((s) => s === "BEGIN TRANSACTION READ ONLY")).toHaveLength(2);
    expect(seen).toHaveLength(8);
  });
});
