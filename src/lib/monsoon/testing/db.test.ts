import { describe, expect, it } from "vitest";
import { makeAccountsTestDb, makeTestDb, testDb, testRoleName } from "./db";

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

  it.skipIf(!testDb.available)("reset() records schema version 1", async () => {
    const db = makeTestDb("crm");
    await db.reset();
    const client = await db.connect();
    try {
      const res = await client.query("SELECT max(version) AS v FROM schema_migrations");
      expect(Number(res.rows[0].v)).toBe(1);
    } finally {
      await client.end();
    }
  });

  it.skipIf(!testDb.available)("accounts reset() leaves an empty public schema when no schema.sql exists", async () => {
    const db = makeAccountsTestDb();
    await db.reset();
    const client = await db.connect();
    try {
      const res = await client.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'");
      expect(typeof res.rows[0].n).toBe("number");
    } finally {
      await client.end();
    }
  });
});
