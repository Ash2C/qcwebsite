import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
import { makeAccountsTestDb } from "../testing/db";
import { buildAccount } from "./account";
import { loadClaudeKeyState, replaceClaudeKey, testStoredKey } from "./claude-key";
import { encryptSecret } from "./crypto";
import { clearAccountCache, loadAccountRows } from "./store";

const db = makeAccountsTestDb();
const OLD_KEY = "sk-ant-api03-OLDKEY-0123456789-wxyz";
const NEW_KEY = "sk-ant-api03-NEWKEY-0123456789-abcd";

describe.skipIf(!db.available)("the Claude key in the app", () => {
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
    clearAccountCache();
    await client.query("TRUNCATE activity, setup_links, pipelines, people, customers, sign_in_attempts CASCADE");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function seed(withKey = true): Promise<{ cid: string; ann: string; bob: string }> {
    const cid = (await client.query("INSERT INTO customers (code, name) VALUES ('acme-co', 'Acme') RETURNING id")).rows[0].id;
    const person = async (name: string, owner: string) =>
      (
        await client.query(
          "INSERT INTO people (customer_id, display_name, owner_key, passcode_hash) VALUES ($1, $2, $3, 'h') RETURNING id",
          [cid, name, owner],
        )
      ).rows[0].id as string;
    const ann = await person("Ann", "AN");
    const bob = await person("Bob", "BO");
    await client.query("UPDATE customers SET key_person_id = $2, claude_key_enc = $3 WHERE id = $1", [
      cid,
      ann,
      withKey ? encryptSecret(OLD_KEY, cid, "claude_key") : null,
    ]);
    return { cid, ann, bob };
  }
  const as = (cid: string, pid: string) => ({ customer: { id: cid, code: "acme-co", name: "Acme", model: "m" }, person: { id: pid, name: "x", ownerKey: "XX" } });

  it("reports a missing key, and a key with no result yet as connected", async () => {
    const none = await seed(false);
    expect(await loadClaudeKeyState(as(none.cid, none.ann))).toMatchObject({ status: "missing", last4: null, canChange: true, keyPerson: "Ann" });
    await client.query("TRUNCATE activity, setup_links, pipelines, people, customers, sign_in_attempts CASCADE");
    const { cid, ann, bob } = await seed();
    expect(await loadClaudeKeyState(as(cid, ann))).toEqual({
      status: "ok",
      last4: "wxyz",
      checkedAt: null,
      setAt: null,
      setBy: null,
      keyPerson: "Ann",
      canChange: true,
    });
    expect((await loadClaudeKeyState(as(cid, bob))).canChange).toBe(false);
  });

  it("only the key person can replace the key; the old one stays for anyone else", async () => {
    const { cid, ann, bob } = await seed();
    expect(await replaceClaudeKey(cid, bob, NEW_KEY)).toBe(false);
    expect((await loadClaudeKeyState(as(cid, ann))).last4).toBe("wxyz");

    expect(await replaceClaudeKey(cid, ann, NEW_KEY)).toBe(true);
    const state = await loadClaudeKeyState(as(cid, ann));
    expect(state).toMatchObject({ status: "ok", last4: "abcd", setBy: "Ann" });
    expect(state.setAt).not.toBeNull();
    expect(state.checkedAt).not.toBeNull();
    // Stored encrypted, and logged as activity by that person.
    const row = (await client.query("SELECT claude_key_enc FROM customers WHERE id = $1", [cid])).rows[0];
    expect(row.claude_key_enc).not.toContain("NEWKEY");
    const act = await client.query("SELECT person_id, action FROM activity WHERE customer_id = $1", [cid]);
    expect(act.rows).toEqual([{ person_id: ann, action: "key" }]);
  });

  it("testStoredKey answers missing without calling Claude when there is no key", async () => {
    const { cid } = await seed(false);
    expect(await testStoredKey(cid)).toBe("missing");
  });

  it("noteClaude records a refused key and out of credit, and the state shows it", async () => {
    const { cid, ann } = await seed();
    const account = async () => buildAccount((await loadAccountRows(cid, ann))!);
    expect((await account()).canChangeKey).toBe(true);

    await (await account()).noteClaude(Object.assign(new Error("x"), { status: 401 }));
    expect((await loadClaudeKeyState(as(cid, ann))).status).toBe("key_rejected");
    await (await account()).noteClaude(Object.assign(new Error("Your credit balance is too low"), { status: 400 }));
    expect((await loadClaudeKeyState(as(cid, ann))).status).toBe("no_credit");

    // A busy Claude or a database error says nothing about the key.
    await (await account()).noteClaude(Object.assign(new Error("x"), { status: 529 }));
    await (await account()).noteClaude(new Error("postgres"));
    expect((await loadClaudeKeyState(as(cid, ann))).status).toBe("no_credit");

    await (await account()).noteClaude();
    const ok = await loadClaudeKeyState(as(cid, ann));
    expect(ok.status).toBe("ok");
    expect(ok.checkedAt).not.toBeNull();
  });

  it("noteClaude does not write again while the same status is fresh", async () => {
    const { cid, ann } = await seed();
    await buildAccount((await loadAccountRows(cid, ann))!).noteClaude();
    const first = (await client.query("SELECT claude_checked_at FROM customers WHERE id = $1", [cid])).rows[0].claude_checked_at;
    await buildAccount((await loadAccountRows(cid, ann))!).noteClaude();
    const second = (await client.query("SELECT claude_checked_at FROM customers WHERE id = $1", [cid])).rows[0].claude_checked_at;
    expect(second).toEqual(first);
  });
});
