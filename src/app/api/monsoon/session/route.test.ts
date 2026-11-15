import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
import { makeAccountsTestDb, makeTestDb } from "@/lib/monsoon/testing/db";
import { verifySession } from "@/lib/monsoon/auth";
import { DUMMY_PASSCODE_HASH, encryptSecret, hashAddress, hashPasscode, verifyPasscode } from "@/lib/monsoon/accounts/crypto";
import { clearAccountCache, recordAttempt } from "@/lib/monsoon/accounts/store";
import { DELETE, POST } from "./route";

vi.mock("@/lib/monsoon/accounts/crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/monsoon/accounts/crypto")>();
  return { ...actual, verifyPasscode: vi.fn(actual.verifyPasscode) };
});

const accounts = makeAccountsTestDb();
const crm = makeTestDb("session");

const ANN = "apple-banana-cherry-delta-echo";
const BOB = "fig-grape-hazel-iris-juniper";
const CARA = "kiwi-lemon-mango-nectar-olive";
const WRONG = "this-is-not-the-passcode-at-all";
const WRONG_MSG = "Wrong company code or passcode.";
const LOCKED_MSG = "Wrong company code or passcode. Try again later.";

function post(body: unknown, address = "203.0.113.7"): Request {
  return new Request("http://localhost/api/monsoon/session", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json", "x-forwarded-for": `${address}, 10.0.0.1` },
  });
}

describe.skipIf(!accounts.available)("POST /api/monsoon/session", { timeout: 20_000 }, () => {
  let client: Client;
  let hashes: { ann: string; bob: string; cara: string };
  let cid: string;
  let annId: string;
  let bobId: string;

  beforeAll(async () => {
    await accounts.reset();
    await crm.reset();
    client = await accounts.connect();
    hashes = { ann: await hashPasscode(ANN), bob: await hashPasscode(BOB), cara: await hashPasscode(CARA) };
  });
  afterAll(async () => {
    await client?.end();
  });
  beforeEach(async () => {
    vi.stubEnv("MONSOON_MASTER_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("MONSOON_ACCOUNTS_DATABASE_URL", accounts.url());
    vi.stubEnv("MONSOON_SESSION_SECRET", "x".repeat(32));
    clearAccountCache();
    vi.mocked(verifyPasscode).mockClear();
    await client.query("TRUNCATE activity, setup_links, pipelines, people, customers, sign_in_attempts CASCADE");
    cid = (await client.query("INSERT INTO customers (code, name) VALUES ('acme-co', 'Acme') RETURNING id")).rows[0].id;
    const person = async (name: string, key: string, hash: string, status = "active") =>
      (
        await client.query(
          "INSERT INTO people (customer_id, display_name, owner_key, passcode_hash, status, session_no) VALUES ($1, $2, $3, $4, $5, 4) RETURNING id",
          [cid, name, key, hash, status],
        )
      ).rows[0].id as string;
    annId = await person("Ann", "AN", hashes.ann);
    bobId = await person("Bob", "BO", hashes.bob);
    await person("Cara", "CA", hashes.cara, "suspended");
    const main = (
      await client.query(
        "INSERT INTO pipelines (customer_id, key, label, default_role) VALUES ($1, 'main', 'Main', 'investor') RETURNING id",
        [cid],
      )
    ).rows[0].id;
    await client.query("UPDATE pipelines SET db_url_enc = $1 WHERE id = $2", [
      encryptSecret(crm.url(), cid, `pipeline:${main}`),
      main,
    ]);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function failAt(address: string, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await recordAttempt(client, { code: "acme-co", personId: null, addressHash: hashAddress(address), ok: false });
    }
  }

  async function expectWrong(res: Response, started: number): Promise<void> {
    expect(Date.now() - started).toBeGreaterThanOrEqual(990);
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: WRONG_MSG });
    for (const p of [ANN, BOB, CARA, WRONG]) expect(text).not.toContain(p);
    expect(res.headers.get("set-cookie")).toBeNull();
  }

  it("signs in with the right passcode: hardened v2 cookie, attempt, activity, owner", async () => {
    const res = await POST(post({ code: "acme-co", passcode: ANN }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true });
    expect(text).not.toContain(ANN);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("monsoon_session=v2.");
    for (const part of ["HttpOnly", "Secure", "SameSite=strict", "Max-Age=15552000", "Path=/"]) {
      expect(cookie.toLowerCase()).toContain(part.toLowerCase());
    }
    const token = /monsoon_session=([^;]+)/.exec(cookie)?.[1];
    expect(verifySession(token)).toEqual({ customerId: cid, personId: annId, sessionNo: 4 });

    const attempts = await client.query("SELECT code, person_id, address_hash, ok FROM sign_in_attempts");
    expect(attempts.rows).toEqual([
      { code: "acme-co", person_id: annId, address_hash: hashAddress("203.0.113.7"), ok: true },
    ]);
    const activity = await client.query("SELECT customer_id, person_id, action FROM activity");
    expect(activity.rows).toEqual([{ customer_id: cid, person_id: annId, action: "sign_in" }]);

    const c = await crm.connect();
    try {
      const owners = await c.query("SELECT display_name FROM owners WHERE key = 'AN'");
      expect(owners.rows).toEqual([{ display_name: "Ann" }]);
    } finally {
      await c.end();
    }
  });

  it("finds the person by passcode and accepts a code in any case with spaces", async () => {
    const res = await POST(post({ code: "  ACME-Co ", passcode: BOB }));
    expect(res.status).toBe(200);
    const token = /monsoon_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    expect(verifySession(token)?.personId).toBe(bobId);
  });

  it("still signs in when a connected pipeline cannot be reached", async () => {
    const dead = (
      await client.query(
        "INSERT INTO pipelines (customer_id, key, label, default_role, position) VALUES ($1, 'dead', 'Dead', 'investor', 0) RETURNING id",
        [cid],
      )
    ).rows[0].id;
    await client.query("UPDATE pipelines SET db_url_enc = $1 WHERE id = $2", [
      encryptSecret("postgresql://u:p@127.0.0.1:1/x", cid, `pipeline:${dead}`),
      dead,
    ]);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await POST(post({ code: "acme-co", passcode: ANN }));
    expect(res.status).toBe(200);
    expect(log.mock.calls.flat().join(" ")).not.toContain("127.0.0.1");
    log.mockRestore();
  });

  it("refuses a wrong passcode after the 1 s delay and records the failure", async () => {
    const started = Date.now();
    await expectWrong(await POST(post({ code: "acme-co", passcode: WRONG })), started);
    const r = await client.query("SELECT ok, person_id FROM sign_in_attempts");
    expect(r.rows).toEqual([{ ok: false, person_id: null }]);
  });

  it("refuses a non-string passcode the same way", async () => {
    const started = Date.now();
    await expectWrong(await POST(post({ code: "acme-co", passcode: 5 })), started);
  });

  it("refuses an unknown code after exactly one dummy verification", async () => {
    const started = Date.now();
    await expectWrong(await POST(post({ code: "nobody", passcode: ANN })), started);
    expect(vi.mocked(verifyPasscode)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(verifyPasscode).mock.calls[0][1]).toBe(DUMMY_PASSCODE_HASH);
  });

  it("refuses a suspended person and a suspended customer", async () => {
    let started = Date.now();
    await expectWrong(await POST(post({ code: "acme-co", passcode: CARA })), started);
    await client.query("UPDATE customers SET status = 'suspended' WHERE id = $1", [cid]);
    vi.mocked(verifyPasscode).mockClear();
    started = Date.now();
    await expectWrong(await POST(post({ code: "acme-co", passcode: ANN })), started);
    expect(vi.mocked(verifyPasscode)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(verifyPasscode).mock.calls[0][1]).toBe(DUMMY_PASSCODE_HASH);
  });

  it("locks the pair after 5 failures from one address, without verifying", async () => {
    await Promise.all(Array.from({ length: 5 }, () => POST(post({ code: "acme-co", passcode: WRONG }))));
    vi.mocked(verifyPasscode).mockClear();
    const res = await POST(post({ code: "ACME-CO", passcode: ANN }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: LOCKED_MSG });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(vi.mocked(verifyPasscode)).not.toHaveBeenCalled();
    // Another address is unaffected.
    expect((await POST(post({ code: "acme-co", passcode: ANN }, "198.51.100.1"))).status).toBe(200);
  });

  it("does not lock a sixth address after 5 failures from five addresses", async () => {
    await Promise.all(
      ["1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4", "5.5.5.5"].map((a) =>
        POST(post({ code: "acme-co", passcode: WRONG }, a)),
      ),
    );
    expect((await POST(post({ code: "acme-co", passcode: ANN }, "6.6.6.6"))).status).toBe(200);
  });

  it("locks the code after 50 failures across addresses", async () => {
    for (let i = 0; i < 50; i++) await failAt(`10.1.0.${i}`, 1);
    const res = await POST(post({ code: "acme-co", passcode: ANN }, "192.0.2.99"));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: LOCKED_MSG });
  });

  it("49 failures across addresses do not lock the code; old failures do not count", async () => {
    for (let i = 0; i < 49; i++) await failAt(`10.2.0.${i}`, 1);
    await failAt("203.0.113.7", 5);
    await client.query("UPDATE sign_in_attempts SET at = now() - interval '16 minutes' WHERE address_hash = $1", [
      hashAddress("203.0.113.7"),
    ]);
    expect((await POST(post({ code: "acme-co", passcode: ANN }))).status).toBe(200);
  });

  it("takes the address from x-real-ip, else 'unknown'", async () => {
    const viaRealIp = new Request("http://localhost/api/monsoon/session", {
      method: "POST",
      body: JSON.stringify({ code: "acme-co", passcode: ANN }),
      headers: { "x-real-ip": "198.51.100.23" },
    });
    expect((await POST(viaRealIp)).status).toBe(200);
    const bare = new Request("http://localhost/api/monsoon/session", {
      method: "POST",
      body: JSON.stringify({ code: "acme-co", passcode: ANN }),
    });
    expect((await POST(bare)).status).toBe(200);
    const r = await client.query("SELECT address_hash FROM sign_in_attempts ORDER BY id");
    expect(r.rows.map((x) => x.address_hash)).toEqual([hashAddress("198.51.100.23"), hashAddress("unknown")]);
  });

  it("returns 500 immediately when not configured", async () => {
    vi.stubEnv("MONSOON_MASTER_KEY", "");
    const res = await POST(post({ code: "acme-co", passcode: ANN }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Monsoon is not configured" });
  });

  it("returns 400 for bad JSON and 413 for an over-cap body", async () => {
    expect((await POST(post("{"))).status).toBe(400);
    const big = JSON.stringify({ code: "acme-co", passcode: "x".repeat(4096) });
    const res = await POST(post(big));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "Request too large" });
  });
});

describe("DELETE /api/monsoon/session", () => {
  it("clears the cookie", async () => {
    const res = await DELETE();
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("monsoon_session=");
    expect(cookie).toContain("Max-Age=0");
  });
});
