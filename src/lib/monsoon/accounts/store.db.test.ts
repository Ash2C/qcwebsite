import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
import { makeAccountsTestDb } from "../testing/db";
import {
  clearAccountCache,
  failuresSince,
  findCustomerByCode,
  loadAccountRows,
  recordActivity,
  recordAttempt,
} from "./store";

const db = makeAccountsTestDb();

describe.skipIf(!db.available)("accounts store", () => {
  let client: Client;
  beforeAll(async () => {
    await db.reset();
    client = await db.connect();
  });
  afterAll(async () => {
    await client?.end();
  });
  beforeEach(async () => {
    vi.stubEnv("MONSOON_ACCOUNTS_DATABASE_URL", db.url());
    clearAccountCache();
    await client.query("TRUNCATE activity, setup_links, pipelines, people, customers, sign_in_attempts CASCADE");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  async function seed(): Promise<{ cid: string; pid: string }> {
    const c = await client.query("INSERT INTO customers (code, name) VALUES ('acme-co', 'Acme') RETURNING id");
    const cid = c.rows[0].id;
    const p = await client.query(
      "INSERT INTO people (customer_id, display_name, owner_key, passcode_hash) VALUES ($1, 'Ann', 'AN', 'h') RETURNING id",
      [cid],
    );
    await client.query(
      `INSERT INTO pipelines (customer_id, key, label, default_role, position) VALUES
         ($1, 'second', 'Second', 'investor', 2), ($1, 'first', 'First', 'investor', 1)`,
      [cid],
    );
    return { cid, pid: p.rows[0].id };
  }

  it("findCustomerByCode lowercases its input and returns null for unknown", async () => {
    const { cid } = await seed();
    const found = await findCustomerByCode(client, "ACME-Co");
    expect(found?.customer.id).toBe(cid);
    expect(found?.customer.claudeKeyEnc).toBeNull();
    expect(found?.people.map((p) => p.ownerKey)).toEqual(["AN"]);
    expect(await findCustomerByCode(client, "nobody")).toBeNull();
  });

  it("loadAccountRows orders pipelines by position and caches for 60 seconds", async () => {
    const { cid, pid } = await seed();
    const first = await loadAccountRows(cid, pid);
    expect(first?.pipelines.map((p) => p.key)).toEqual(["first", "second"]);
    expect(first?.person.sessionNo).toBe(1);

    vi.useFakeTimers({ toFake: ["Date"] });
    await client.query("UPDATE customers SET status = 'suspended' WHERE id = $1", [cid]);
    expect((await loadAccountRows(cid, pid))?.customer.status).toBe("active");
    vi.setSystemTime(Date.now() + 61_000);
    expect((await loadAccountRows(cid, pid))?.customer.status).toBe("suspended");
  });

  it("loadAccountRows returns null for a mismatched person", async () => {
    const { cid } = await seed();
    expect(await loadAccountRows(cid, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("failuresSince counts pair and code separately, failures only", async () => {
    await recordAttempt(client, { code: "acme-co", personId: null, addressHash: "a", ok: false });
    await recordAttempt(client, { code: "acme-co", personId: null, addressHash: "a", ok: false });
    await recordAttempt(client, { code: "acme-co", personId: null, addressHash: "b", ok: false });
    await recordAttempt(client, { code: "acme-co", personId: null, addressHash: "a", ok: true });
    await recordAttempt(client, { code: "other-co", personId: null, addressHash: "a", ok: false });
    expect(await failuresSince(client, "acme-co", "a", Date.now() - 15 * 60_000)).toEqual({ pair: 2, code: 3 });
    expect(await failuresSince(client, "acme-co", "a", Date.now() + 60_000)).toEqual({ pair: 0, code: 0 });
  });

  it("recordAttempt prunes a 31-day-old row and keeps a 29-day-old one", async () => {
    await client.query(
      `INSERT INTO sign_in_attempts (code, address_hash, ok, at) VALUES
         ('old-co', 'a', false, now() - interval '31 days'), ('mid-co', 'a', false, now() - interval '29 days')`,
    );
    await recordAttempt(client, { code: "new-co", personId: null, addressHash: "a", ok: true });
    const r = await client.query("SELECT code FROM sign_in_attempts ORDER BY code");
    expect(r.rows.map((x) => x.code)).toEqual(["mid-co", "new-co"]);
  });

  it("recordActivity writes a row", async () => {
    const { cid, pid } = await seed();
    await recordActivity({ customerId: cid, personId: pid, pipelineKey: "first", action: "capture" });
    const r = await client.query("SELECT person_id, pipeline_key, action FROM activity");
    expect(r.rows).toEqual([{ person_id: pid, pipeline_key: "first", action: "capture" }]);
  });

  it("recordActivity with an unreachable db resolves without throwing", async () => {
    vi.stubEnv("MONSOON_ACCOUNTS_DATABASE_URL", "postgresql://u:p@127.0.0.1:1/x");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      recordActivity({ customerId: "c", personId: null, pipelineKey: null, action: "sign_in" }),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
});
