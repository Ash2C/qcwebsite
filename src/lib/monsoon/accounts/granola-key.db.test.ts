import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
import { makeAccountsTestDb } from "../testing/db";
import { encryptSecret } from "./crypto";
import {
  disconnectGranolaKey,
  loadGranolaKey,
  loadGranolaKeyState,
  readGranolaKeyForAsk,
  recordGranolaStatus,
  saveGranolaKey,
} from "./granola-key";

const db = makeAccountsTestDb();
// Obviously fake keys: the shape only.
const ANN_KEY = "grn_FAKE_ann_key_000000_wxyz";
const BOB_KEY = "grn_FAKE_bob_key_000000_abcd";
const NEW_KEY = "grn_FAKE_new_key_000000_qrst";
const COLUMNS = "granola_key_enc, granola_status, granola_checked_at, granola_key_set_at";
const EMPTY = { granola_key_enc: null, granola_status: null, granola_checked_at: null, granola_key_set_at: null };

describe.skipIf(!db.available)("a person's Granola key", () => {
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
    vi.stubEnv("MONSOON_MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
    await client.query("TRUNCATE activity, setup_links, pipelines, people, customers, sign_in_attempts CASCADE");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  type Who = { customerId: string; personId: string };
  async function seed(): Promise<{ ann: Who; bob: Who; oz: Who }> {
    const customer = async (code: string) =>
      (await client.query("INSERT INTO customers (code, name) VALUES ($1, $1) RETURNING id", [code])).rows[0].id as string;
    const person = async (customerId: string, name: string, owner: string): Promise<Who> => ({
      customerId,
      personId: (
        await client.query(
          "INSERT INTO people (customer_id, display_name, owner_key, passcode_hash) VALUES ($1, $2, $3, 'h') RETURNING id",
          [customerId, name, owner],
        )
      ).rows[0].id as string,
    });
    const acme = await customer("acme-co");
    const other = await customer("other-co");
    return { ann: await person(acme, "Ann", "AN"), bob: await person(acme, "Bob", "BO"), oz: await person(other, "Oz", "OZ") };
  }
  const row = async (who: Who) => (await client.query(`SELECT ${COLUMNS} FROM people WHERE id = $1`, [who.personId])).rows[0];

  it("reports no key as missing, and a key with no result yet as connected", async () => {
    const { ann } = await seed();
    expect(await loadGranolaKeyState(ann)).toEqual({ status: "missing", last4: null, setAt: null, checkedAt: null });
    expect(await loadGranolaKey(ann)).toBeNull();
    await client.query("UPDATE people SET granola_key_enc = $2 WHERE id = $1", [
      ann.personId,
      encryptSecret(ANN_KEY, ann.customerId, `granola:${ann.personId}`),
    ]);
    expect(await loadGranolaKeyState(ann)).toEqual({ status: "ok", last4: "wxyz", setAt: null, checkedAt: null });
    expect(await loadGranolaKey(ann)).toBe(ANN_KEY);
  });

  it("saves a tested key encrypted, with its times and an activity row by that person", async () => {
    const { ann } = await seed();
    expect(await saveGranolaKey(ann, ANN_KEY)).toBe(true);
    const state = await loadGranolaKeyState(ann);
    expect(state).toMatchObject({ status: "ok", last4: "wxyz" });
    expect(state.setAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(state.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const stored = (await row(ann)).granola_key_enc as string;
    expect(stored).toMatch(/^k1\./);
    expect(stored).not.toContain("FAKE");
    const act = await client.query("SELECT customer_id, person_id, pipeline_key, action FROM activity");
    expect(act.rows).toEqual([{ customer_id: ann.customerId, person_id: ann.personId, pipeline_key: null, action: "granola" }]);

    // Replacing it: the new key, a fresh ok even after a refusal was recorded.
    await recordGranolaStatus(ann, "key_rejected");
    expect(await saveGranolaKey(ann, NEW_KEY)).toBe(true);
    expect(await loadGranolaKeyState(ann)).toMatchObject({ status: "ok", last4: "qrst" });
    expect(await loadGranolaKey(ann)).toBe(NEW_KEY);
  });

  it("a colleague at the same customer never gets or changes this person's key", async () => {
    const { ann, bob } = await seed();
    await saveGranolaKey(ann, ANN_KEY);
    expect(await loadGranolaKeyState(bob)).toEqual({ status: "missing", last4: null, setAt: null, checkedAt: null });
    expect(await loadGranolaKey(bob)).toBeNull();
    expect(await readGranolaKeyForAsk(bob)).toBeNull();

    const before = await row(ann);
    await recordGranolaStatus(bob, "key_rejected");
    expect(await disconnectGranolaKey(bob)).toBe(true);
    expect(await row(ann)).toEqual(before);
    expect(await row(bob)).toEqual(EMPTY);

    await saveGranolaKey(bob, BOB_KEY);
    expect(await row(ann)).toEqual(before);
    expect(await readGranolaKeyForAsk(ann)).toBe(ANN_KEY);
    expect(await readGranolaKeyForAsk(bob)).toBe(BOB_KEY);
    await disconnectGranolaKey(bob);
    expect(await readGranolaKeyForAsk(ann)).toBe(ANN_KEY);
  });

  it("a key copied onto another person's row cannot be read there", async () => {
    const { ann, bob, oz } = await seed();
    await saveGranolaKey(ann, ANN_KEY);
    await client.query("UPDATE people SET granola_key_enc = (SELECT granola_key_enc FROM people WHERE id = $1) WHERE id = ANY($2)", [
      ann.personId,
      [bob.personId, oz.personId],
    ]);
    expect(await readGranolaKeyForAsk(bob)).toBeNull();
    expect(await readGranolaKeyForAsk(oz)).toBeNull();
    await expect(loadGranolaKey(bob)).rejects.toThrow("Could not decrypt");
    expect(await readGranolaKeyForAsk(ann)).toBe(ANN_KEY);
  });

  it("a person of another customer never gets or changes this person's key, even naming their id", async () => {
    const { ann, oz } = await seed();
    await saveGranolaKey(ann, ANN_KEY);
    const before = await row(ann);
    expect(await loadGranolaKeyState(oz)).toMatchObject({ status: "missing", last4: null });
    expect(await readGranolaKeyForAsk(oz)).toBeNull();

    // Ann's person id under the other customer's id: nothing is found and nothing is written.
    const forged = { customerId: oz.customerId, personId: ann.personId };
    await expect(loadGranolaKeyState(forged)).rejects.toThrow("Person not found");
    await expect(loadGranolaKey(forged)).rejects.toThrow("Person not found");
    expect(await readGranolaKeyForAsk(forged)).toBeNull();
    expect(await saveGranolaKey(forged, NEW_KEY)).toBe(false);
    expect(await disconnectGranolaKey(forged)).toBe(false);
    await recordGranolaStatus(forged, "no_access");
    expect(await row(ann)).toEqual(before);
    expect(await row(oz)).toEqual(EMPTY);
    expect((await client.query("SELECT count(*)::int AS n FROM activity")).rows[0].n).toBe(1);
  });

  it("records the result of a real call, only while a key is on file", async () => {
    const { ann, bob } = await seed();
    await saveGranolaKey(ann, ANN_KEY);
    await recordGranolaStatus(ann, "key_rejected");
    expect((await loadGranolaKeyState(ann)).status).toBe("key_rejected");
    await recordGranolaStatus(ann, "no_access");
    expect((await loadGranolaKeyState(ann)).status).toBe("no_access");
    await recordGranolaStatus(ann, "ok");
    expect((await loadGranolaKeyState(ann)).status).toBe("ok");

    await recordGranolaStatus(bob, "key_rejected");
    expect(await row(bob)).toEqual(EMPTY);
  });

  it("recordGranolaStatus never throws and logs no detail", async () => {
    const { ann } = await seed();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("MONSOON_ACCOUNTS_DATABASE_URL", "postgresql://u:hunter2@127.0.0.1:1/monsoon_test_nowhere");
    await expect(recordGranolaStatus(ann, "key_rejected")).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/hunter2|127\.0\.0\.1/);
  });

  it("disconnecting empties the four columns, keeps the person and leaves an activity row", async () => {
    const { ann, bob } = await seed();
    await saveGranolaKey(ann, ANN_KEY);
    await saveGranolaKey(bob, BOB_KEY);
    expect(await disconnectGranolaKey(ann)).toBe(true);
    expect(await row(ann)).toEqual(EMPTY);
    expect(await loadGranolaKeyState(ann)).toEqual({ status: "missing", last4: null, setAt: null, checkedAt: null });
    expect(await readGranolaKeyForAsk(ann)).toBeNull();
    expect((await client.query("SELECT display_name FROM people WHERE id = $1", [ann.personId])).rows).toEqual([{ display_name: "Ann" }]);
    expect((await client.query("SELECT count(*)::int AS n FROM activity WHERE person_id = $1 AND action = 'granola'", [ann.personId])).rows[0].n).toBe(2);
    expect((await loadGranolaKeyState(bob)).last4).toBe("abcd");

    // Again, with nothing on file: fine, and no further activity.
    expect(await disconnectGranolaKey(ann)).toBe(true);
    expect((await client.query("SELECT count(*)::int AS n FROM activity WHERE person_id = $1", [ann.personId])).rows[0].n).toBe(2);
  });

  it("Ask gets the key of an active person of an active customer, and null for anyone else", async () => {
    const { ann } = await seed();
    expect(await readGranolaKeyForAsk(ann)).toBeNull();
    await saveGranolaKey(ann, ANN_KEY);
    expect(await readGranolaKeyForAsk(ann)).toBe(ANN_KEY);

    await client.query("UPDATE people SET status = 'suspended' WHERE id = $1", [ann.personId]);
    expect(await readGranolaKeyForAsk(ann)).toBeNull();
    await client.query("UPDATE people SET status = 'active' WHERE id = $1", [ann.personId]);
    await client.query("UPDATE customers SET status = 'suspended' WHERE id = $1", [ann.customerId]);
    expect(await readGranolaKeyForAsk(ann)).toBeNull();
    await client.query("UPDATE customers SET status = 'active' WHERE id = $1", [ann.customerId]);
    expect(await readGranolaKeyForAsk(ann)).toBe(ANN_KEY);
    expect(await readGranolaKeyForAsk({ customerId: ann.customerId, personId: "00000000-0000-4000-8000-00000000dead" })).toBeNull();
  });

  it("Ask's read answers null, without throwing or logging, on an error, a wrong master key or a slow database", async () => {
    const { ann } = await seed();
    await saveGranolaKey(ann, ANN_KEY);
    const logs = [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "log")];

    vi.stubEnv("MONSOON_MASTER_KEY", Buffer.alloc(32, 9).toString("base64"));
    expect(await readGranolaKeyForAsk(ann)).toBeNull();
    vi.stubEnv("MONSOON_MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));

    vi.stubEnv("MONSOON_ACCOUNTS_DATABASE_URL", "postgresql://u:hunter2@127.0.0.1:1/monsoon_test_nowhere");
    expect(await readGranolaKeyForAsk(ann)).toBeNull();
    vi.stubEnv("MONSOON_ACCOUNTS_DATABASE_URL", db.url());

    // Another session holds the people table locked: a stand-in for a slow accounts database.
    const blocker = await db.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE people IN ACCESS EXCLUSIVE MODE");
      const started = Date.now();
      expect(await readGranolaKeyForAsk(ann, { timeoutMs: 300 })).toBeNull();
      expect(Date.now() - started).toBeLessThan(2500);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
    }
    expect(await readGranolaKeyForAsk(ann)).toBe(ANN_KEY);
    for (const spy of logs) expect(spy).not.toHaveBeenCalled();
  });
});
