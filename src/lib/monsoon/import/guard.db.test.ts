import type { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "../testing/db";
import { withImportLock } from "./guard";

const testDb = makeTestDb("import_guard");
const PERSON = "00000000-0000-4000-8000-000000000002";
const OTHER = "00000000-0000-4000-8000-000000000003";

describe.skipIf(!testDb.available)("withImportLock (real Postgres)", () => {
  let a: Client;
  let b: Client;

  beforeEach(async () => {
    a = await testDb.connect();
    b = await testDb.connect();
  });
  afterEach(async () => {
    await a.end();
    await b.end();
  });

  it("runs the work and answers its value", async () => {
    expect(await withImportLock(a, PERSON, async () => 42)).toEqual({ locked: true, value: 42 });
  });

  it("refuses a second import by the same person while the first runs, and allows it afterwards", async () => {
    let inner: unknown;
    const outer = await withImportLock(a, PERSON, async () => {
      inner = await withImportLock(b, PERSON, async () => "second");
      return "first";
    });
    expect(outer).toEqual({ locked: true, value: "first" });
    expect(inner).toEqual({ locked: false });
    expect(await withImportLock(b, PERSON, async () => "again")).toEqual({ locked: true, value: "again" });
  });

  it("does not hold up another person", async () => {
    const out = await withImportLock(a, PERSON, () => withImportLock(b, OTHER, async () => "other"));
    expect(out).toEqual({ locked: true, value: { locked: true, value: "other" } });
  });

  it("lets go when the work throws, and leaves the connection outside a transaction", async () => {
    await expect(
      withImportLock(a, PERSON, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await withImportLock(b, PERSON, async () => 1)).toEqual({ locked: true, value: 1 });
    const first = (await a.query("SELECT txid_current() AS t")).rows[0].t;
    expect((await a.query("SELECT txid_current() AS t")).rows[0].t).not.toBe(first);
  });

  it("lets go when the connection is lost", async () => {
    const c = await testDb.connect();
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`monsoon-import-running:${PERSON}`]);
    expect(await withImportLock(b, PERSON, async () => 1)).toEqual({ locked: false });
    await c.end();
    // The server lets go once it notices the connection is gone.
    let out: unknown = { locked: false };
    for (let i = 0; i < 50 && (out as { locked: boolean }).locked === false; i++) {
      await new Promise((r) => setTimeout(r, 20));
      out = await withImportLock(b, PERSON, async () => 1);
    }
    expect(out).toEqual({ locked: true, value: 1 });
  });
});
