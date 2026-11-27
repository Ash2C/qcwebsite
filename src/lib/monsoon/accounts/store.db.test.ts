import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
import { makeAccountsTestDb } from "../testing/db";
import {
  FEEDBACK_DAILY_LIMIT,
  activeOwnerKeys,
  activityInLastDay,
  clearAccountCache,
  failuresSince,
  findCustomerByCode,
  loadAccountRows,
  recordActivity,
  recordAttempt,
  recordFeedback,
  reserveSpeak,
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
    await client.query("TRUNCATE ask_feedback, activity, setup_links, pipelines, people, customers, sign_in_attempts CASCADE");
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

  it("activityInLastDay counts only that person's rows of that action from the last 24 hours", async () => {
    const { cid, pid } = await seed();
    const other = (await client.query(
      "INSERT INTO people (customer_id, display_name, owner_key, passcode_hash) VALUES ($1, 'Bob', 'BO', 'h') RETURNING id", [cid])).rows[0].id;
    const ins = (person: string, action: string, ago: string) =>
      client.query("INSERT INTO activity (customer_id, person_id, action, at) VALUES ($1,$2,$3, now() - $4::interval)", [cid, person, action, ago]);
    await ins(pid, "speak", "1 hour");
    await ins(pid, "speak", "23 hours");
    await ins(pid, "speak", "25 hours");
    await ins(pid, "ask", "1 hour");
    await ins(other, "speak", "1 hour");
    expect(await activityInLastDay(cid, pid, "speak")).toBe(2);
    expect(await activityInLastDay(cid, other, "speak")).toBe(1);
    expect(await activityInLastDay(cid, pid, "tidy")).toBe(0);
  });

  it("recordFeedback writes one row and stops at the daily limit", async () => {
    const { cid, pid } = await seed();
    expect(FEEDBACK_DAILY_LIMIT).toBe(300);
    expect(await recordFeedback({ customerId: cid, personId: pid, pipelineKey: "first", kind: "down", mode: "voice", detail: "too long" })).toBe(true);
    const r = await client.query("SELECT customer_id, person_id, pipeline_key, kind, mode, detail FROM ask_feedback");
    expect(r.rows).toEqual([{ customer_id: cid, person_id: pid, pipeline_key: "first", kind: "down", mode: "voice", detail: "too long" }]);
    await client.query(
      "INSERT INTO ask_feedback (customer_id, person_id, kind, mode) SELECT $1, $2, 'up', 'typed' FROM generate_series(1, $3::int)",
      [cid, pid, FEEDBACK_DAILY_LIMIT - 1],
    );
    expect((await client.query("SELECT count(*)::int AS n FROM ask_feedback")).rows[0].n).toBe(300);
    expect(await recordFeedback({ customerId: cid, personId: pid, pipelineKey: null, kind: "up", mode: "typed", detail: null })).toBe(false);
    expect((await client.query("SELECT count(*)::int AS n FROM ask_feedback")).rows[0].n).toBe(300);
  });

  it("reserveSpeak writes a speak row only while the person has fewer than the limit in 24 hours", async () => {
    const { cid, pid } = await seed();
    const other = (await client.query("INSERT INTO people (customer_id, display_name, owner_key, passcode_hash) VALUES ($1, 'Bea', 'BE', 'h') RETURNING id", [cid])).rows[0].id;
    await client.query("INSERT INTO activity (customer_id, person_id, action) SELECT $1, $2, 'speak' FROM generate_series(1, 149)", [cid, pid]);
    await client.query("INSERT INTO activity (customer_id, person_id, action, at) SELECT $1, $2, 'speak', now() - interval '25 hours' FROM generate_series(1, 20)", [cid, pid]);
    await client.query("INSERT INTO activity (customer_id, person_id, action) SELECT $1, $2, 'speak' FROM generate_series(1, 30)", [cid, other]);
    await client.query("INSERT INTO activity (customer_id, person_id, action) SELECT $1, $2, 'ask' FROM generate_series(1, 30)", [cid, pid]);
    expect(await reserveSpeak({ customerId: cid, personId: pid, pipelineKey: "first", limit: 150 })).toBe(true);
    expect(await activityInLastDay(cid, pid, "speak")).toBe(150);
    expect(await reserveSpeak({ customerId: cid, personId: pid, pipelineKey: "first", limit: 150 })).toBe(false);
    expect(await activityInLastDay(cid, pid, "speak")).toBe(150);
    const row = await client.query("SELECT pipeline_key FROM activity WHERE person_id = $1 AND action = 'speak' ORDER BY at DESC LIMIT 1", [pid]);
    expect(row.rows[0].pipeline_key).toBe("first");
    expect(await reserveSpeak({ customerId: cid, personId: other, pipelineKey: null, limit: 150 })).toBe(true);
  });

  it("concurrent reserveSpeak calls cannot pass the limit together", async () => {
    const { cid, pid } = await seed();
    const results = await Promise.all(Array.from({ length: 6 }, () => reserveSpeak({ customerId: cid, personId: pid, pipelineKey: null, limit: 3 })));
    expect(results.filter(Boolean).length).toBe(3);
    expect(await activityInLastDay(cid, pid, "speak")).toBe(3);
  });

  it("activeOwnerKeys lists only the active people of that customer", async () => {
    const { cid } = await seed();
    const other = (await client.query("INSERT INTO customers (code, name) VALUES ('other-co', 'Other') RETURNING id")).rows[0].id;
    await client.query(
      `INSERT INTO people (customer_id, display_name, owner_key, passcode_hash, status) VALUES
         ($1, 'Bob', 'BO', 'h', 'active'), ($1, 'Cy', 'CY', 'h', 'suspended'), ($2, 'Di', 'DI', 'h', 'active')`,
      [cid, other],
    );
    expect((await activeOwnerKeys(cid)).sort()).toEqual(["AN", "BO"]);
  });

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
