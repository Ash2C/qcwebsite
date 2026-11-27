import { describe, expect, it } from "vitest";
import { makeAccountsTestDb, makeTestDb, makeV1TestDb, testDb, testRoleName } from "./db";

const POOL = /^\d+$/.test(process.env.VITEST_POOL_ID ?? "") ? process.env.VITEST_POOL_ID : "0";
const dbName = (url: string) => new URL(url).pathname.slice(1);

describe("test harness", () => {
  it("names each database after its purpose and worker, always containing test", () => {
    const a = makeTestDb("alpha");
    const b = makeTestDb("beta");
    expect(dbName(a.url())).toBe(`monsoon_alpha_test_w${POOL}`);
    expect(dbName(b.url())).toBe(`monsoon_beta_test_w${POOL}`);
    expect(dbName(a.url())).not.toBe(dbName(b.url()));
    expect(dbName(makeAccountsTestDb().url())).toBe(`monsoon_accounts_test_w${POOL}`);
    expect(dbName(testDb.url())).toBe(`monsoon_test_w${POOL}`);
    expect(testRoleName()).toBe(`monsoon_app_w${POOL}`);
  });

  it("rejects names that would not make a safe database name", () => {
    expect(() => makeTestDb("bad name;")).toThrow();
  });

  it.skipIf(!testDb.available)("reset() records every schema version, up to 2, and builds the to-do table", async () => {
    const db = makeTestDb("crm");
    await db.reset();
    const client = await db.connect();
    try {
      const res = await client.query("SELECT version FROM schema_migrations ORDER BY version");
      expect(res.rows.map((r) => Number(r.version))).toEqual([1, 2]);
      expect((await client.query("SELECT to_regclass('todos') AS t")).rows[0].t).toBe("todos");
    } finally {
      await client.end();
    }
  });

  it.skipIf(!testDb.available)("makeV1TestDb builds a CRM at schema version 1, with no to-do table", async () => {
    const db = makeV1TestDb("crm_v1");
    await db.reset();
    const client = await db.connect();
    try {
      const res = await client.query("SELECT version FROM schema_migrations ORDER BY version");
      expect(res.rows.map((r) => Number(r.version))).toEqual([1]);
      expect((await client.query("SELECT to_regclass('todos') AS t")).rows[0].t).toBeNull();
      expect((await client.query("SELECT count(*)::int AS n FROM stages")).rows[0].n).toBe(5);
    } finally {
      await client.end();
    }
  });

  it.skipIf(!testDb.available)("accounts reset() applies the accounts schema", async () => {
    const db = makeAccountsTestDb();
    await db.reset();
    const client = await db.connect();
    try {
      const res = await client.query("SELECT to_regclass('public.customers') AS t");
      expect(res.rows[0].t).toBe("customers");
    } finally {
      await client.end();
    }
  });
});
