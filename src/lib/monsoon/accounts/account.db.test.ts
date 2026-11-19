import { createHmac, randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
import { makeAccountsTestDb, makeTestDb } from "../testing/db";
import { signSession } from "../auth";
import { encryptSecret } from "./crypto";
import { clearAccountCache } from "./store";
import { NotConnected, requireAccount, withCustomerPipelineDb, type Account } from "./account";

const accounts = makeAccountsTestDb();
const crm = makeTestDb("account");
const CLAUDE_KEY = "sk-ant-test-0123456789";

describe.skipIf(!accounts.available)("requireAccount", () => {
  let client: Client;
  let cid: string;
  let pid: string;
  let otherCid: string;

  beforeAll(async () => {
    await accounts.reset();
    await crm.reset();
    client = await accounts.connect();
  });
  afterAll(async () => {
    await client?.end();
  });
  beforeEach(async () => {
    vi.stubEnv("MONSOON_MASTER_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("MONSOON_ACCOUNTS_DATABASE_URL", accounts.url());
    vi.stubEnv("MONSOON_SESSION_SECRET", "x".repeat(32));
    clearAccountCache();
    await client.query("TRUNCATE activity, setup_links, pipelines, people, customers, sign_in_attempts CASCADE");
    cid = (await client.query("INSERT INTO customers (code, name) VALUES ('acme-co', 'Acme') RETURNING id")).rows[0].id;
    pid = (
      await client.query(
        "INSERT INTO people (customer_id, display_name, owner_key, passcode_hash) VALUES ($1, 'Ann', 'AN', 'h') RETURNING id",
        [cid],
      )
    ).rows[0].id;
    const main = (
      await client.query(
        `INSERT INTO pipelines (customer_id, key, label, default_role, position)
         VALUES ($1, 'main', 'Main', 'investor', 1) RETURNING id`,
        [cid],
      )
    ).rows[0].id;
    await client.query("UPDATE pipelines SET db_url_enc = $1 WHERE id = $2", [
      encryptSecret(crm.url(), cid, `pipeline:${main}`),
      main,
    ]);
    await client.query(
      "INSERT INTO pipelines (customer_id, key, label, default_role, position) VALUES ($1, 'later', 'Later', 'introducer', 2)",
      [cid],
    );
    otherCid = (await client.query("INSERT INTO customers (code, name) VALUES ('other-co', 'Other') RETURNING id"))
      .rows[0].id;
    const theirs = (
      await client.query(
        "INSERT INTO pipelines (customer_id, key, label, default_role) VALUES ($1, 'theirs', 'Theirs', 'investor') RETURNING id",
        [otherCid],
      )
    ).rows[0].id;
    await client.query("UPDATE pipelines SET db_url_enc = $1 WHERE id = $2", [
      encryptSecret(crm.url(), otherCid, `pipeline:${theirs}`),
      theirs,
    ]);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  function req(cookie?: string): Request {
    return new Request("http://localhost/api/monsoon/x", { headers: cookie ? { cookie } : {} });
  }
  function signed(sessionNo = 1): Request {
    return req(`monsoon_session=${signSession({ customerId: cid, personId: pid, sessionNo })}`);
  }
  async function account(): Promise<Account> {
    const r = await requireAccount(signed());
    if (!r.ok) throw new Error(`refused ${r.response.status}`);
    return r.account;
  }
  async function expectRefused(request: Request): Promise<void> {
    clearAccountCache();
    const r = await requireAccount(request);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(401);
    expect(await r.response.json()).toEqual({ error: "unauthorized" });
  }

  it("builds the account for a valid v2 cookie", async () => {
    const a = await account();
    expect(a.customer).toEqual({ id: cid, code: "acme-co", name: "Acme", model: "claude-haiku-5-5" });
    expect(a.person).toEqual({ id: pid, name: "Ann", ownerKey: "AN" });
    expect(a.pipelines).toEqual([
      { key: "main", label: "Main", defaultRole: "investor", connected: true },
      { key: "later", label: "Later", defaultRole: "introducer", connected: false },
    ]);
    expect(a.pipeline("main")?.label).toBe("Main");
    expect(a.pipeline("theirs")).toBeUndefined();
    expect(a.pipeline(5)).toBeUndefined();
    expect(a.model()).toBe("claude-haiku-5-5");
  });

  it("withDb decrypts this customer's pipeline only and refuses unconnected ones", async () => {
    const a = await account();
    const keys = await a.withDb("main", async (db) => (await db.query("SELECT key FROM owners")).rows.map((r) => r.key));
    expect(keys).toContain("VF");
    await expect(a.withDb("later", async () => 1)).rejects.toBeInstanceOf(NotConnected);
    await expect(a.withDb("theirs", async () => 1)).rejects.toBeInstanceOf(NotConnected);
  });

  it("anthropic() throws NotConnected without a key and builds a client with one", async () => {
    await expect(async () => (await account()).anthropic({ timeout: 1000 })).rejects.toBeInstanceOf(NotConnected);
    await client.query("UPDATE customers SET claude_key_enc = $1 WHERE id = $2", [
      encryptSecret(CLAUDE_KEY, cid, "claude_key"),
      cid,
    ]);
    clearAccountCache();
    const a = await account();
    const claude = a.anthropic({ timeout: 1234 });
    expect(claude.apiKey).toBe(CLAUDE_KEY);
    expect(claude.timeout).toBe(1234);
    expect(claude.maxRetries).toBe(0);
  });

  it("never keeps a decrypted value on the account", async () => {
    await client.query("UPDATE customers SET claude_key_enc = $1 WHERE id = $2", [
      encryptSecret(CLAUDE_KEY, cid, "claude_key"),
      cid,
    ]);
    clearAccountCache();
    const a = await account();
    a.anthropic({ timeout: 1000 });
    await a.withDb("main", async () => 1);
    const dump = JSON.stringify(a) + Object.values(a).map(String).join("");
    expect(dump).not.toContain(CLAUDE_KEY);
    expect(dump).not.toContain(crm.url());
    expect(dump).not.toContain("k1.");
  });

  it("model() refuses Opus and Fable for quantcloud only", async () => {
    await client.query("UPDATE customers SET model = 'claude-opus-5-5' WHERE id = $1", [cid]);
    clearAccountCache();
    expect((await account()).model()).toBe("claude-opus-5-5");
    for (const m of ["claude-opus-5-5", "Claude-FABLE-1"]) {
      await client.query("UPDATE customers SET code = 'quantcloud', model = $2 WHERE id = $1", [cid, m]);
      clearAccountCache();
      const a = await account();
      expect(() => a.model()).toThrow();
    }
  });

  it("record() writes an activity row", async () => {
    await (await account()).record("ask", "main");
    const r = await client.query("SELECT customer_id, person_id, pipeline_key, action FROM activity");
    expect(r.rows).toEqual([{ customer_id: cid, person_id: pid, pipeline_key: "main", action: "ask" }]);
  });

  it("refuses missing, invalid and v1 cookies", async () => {
    await expectRefused(req());
    await expectRefused(req("monsoon_session=v2.garbage"));
    const v1 = `v1.${Math.floor(Date.now() / 1000) + 3600}`;
    await expectRefused(req(`monsoon_session=${v1}.${createHmac("sha256", "x".repeat(32)).update(v1).digest("hex")}`));
  });

  it("refuses unknown rows and a person of another customer", async () => {
    await expectRefused(
      req(`monsoon_session=${signSession({ customerId: otherCid, personId: pid, sessionNo: 1 })}`),
    );
    await client.query("DELETE FROM people WHERE id = $1", [pid]);
    await expectRefused(signed());
  });

  it("refuses a suspended customer", async () => {
    await client.query("UPDATE customers SET status = 'suspended' WHERE id = $1", [cid]);
    await expectRefused(signed());
  });

  it("refuses a suspended person", async () => {
    await client.query("UPDATE people SET status = 'suspended' WHERE id = $1", [pid]);
    await expectRefused(signed());
  });

  it("refuses a raised session number", async () => {
    await client.query("UPDATE people SET session_no = 2 WHERE id = $1", [pid]);
    await expectRefused(signed(1));
    clearAccountCache();
    expect((await requireAccount(signed(2))).ok).toBe(true);
  });

  it("sees a suspension after the 60-second cache expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    expect((await requireAccount(signed())).ok).toBe(true);
    await client.query("UPDATE people SET status = 'suspended' WHERE id = $1", [pid]);
    expect((await requireAccount(signed())).ok).toBe(true);
    vi.setSystemTime(Date.now() + 61_000);
    expect((await requireAccount(signed())).ok).toBe(false);
  });

  it("answers 500 when not configured", async () => {
    vi.stubEnv("MONSOON_MASTER_KEY", "");
    const r = await requireAccount(signed());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(500);
  });

  it("withCustomerPipelineDb reaches a customer's connected pipeline by code and key, without a session", async () => {
    const keys = await withCustomerPipelineDb("acme-co", "main", async (db) =>
      (await db.query("SELECT key FROM owners")).rows.map((r) => r.key),
    );
    expect(keys).toContain("VF");
    expect(await withCustomerPipelineDb("ACME-CO", "main", async () => 1)).toBe(1);
  });

  it("withCustomerPipelineDb refuses an unknown code, another customer's key, an unconnected pipeline and a suspended customer", async () => {
    const fn = vi.fn(async () => 1);
    await expect(withCustomerPipelineDb("nobody", "main", fn)).rejects.toBeInstanceOf(NotConnected);
    await expect(withCustomerPipelineDb("acme-co", "theirs", fn)).rejects.toBeInstanceOf(NotConnected);
    await expect(withCustomerPipelineDb("acme-co", "later", fn)).rejects.toBeInstanceOf(NotConnected);
    await client.query("UPDATE customers SET status = 'suspended' WHERE id = $1", [cid]);
    await expect(withCustomerPipelineDb("acme-co", "main", fn)).rejects.toBeInstanceOf(NotConnected);
    expect(fn).not.toHaveBeenCalled();
  });
});
