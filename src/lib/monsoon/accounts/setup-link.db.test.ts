import type { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAccountsTestDb } from "../testing/db";
import { hashToken, newToken } from "./crypto";
import { loadSetupPage } from "./setup-link";

const accounts = makeAccountsTestDb();

describe.skipIf(!accounts.available)("loadSetupPage", () => {
  let client: Client;
  let cid: string;
  let pid: string;

  async function link(opts: { purpose?: string; expires?: string; used?: boolean; attempts?: number } = {}) {
    const t = newToken();
    await client.query(
      `INSERT INTO setup_links (customer_id, pipeline_id, token_hash, purpose, expires_at, used_at, attempts)
       VALUES ($1, $2, $3, $4, now() + $5::interval, $6, $7)`,
      [cid, pid, hashToken(t), opts.purpose ?? "key", opts.expires ?? "7 days", opts.used ? new Date() : null, opts.attempts ?? 0],
    );
    return t;
  }

  beforeAll(async () => {
    await accounts.reset();
    client = await accounts.connect();
  });
  afterAll(async () => {
    await client?.end();
  });
  beforeEach(async () => {
    vi.stubEnv("MONSOON_ACCOUNTS_DATABASE_URL", accounts.url());
    await client.query("TRUNCATE activity, setup_links, pipelines, people, customers, sign_in_attempts CASCADE");
    cid = (await client.query("INSERT INTO customers (code, name) VALUES ('acme-co', 'Acme') RETURNING id")).rows[0].id;
    const vocab = {
      stages: [{ key: "new", ord: 0, label: "New Lead", terminal: false }],
      roles: [{ key: "buyer", label: "Buyer Desk" }],
    };
    pid = (
      await client.query(
        "INSERT INTO pipelines (customer_id, key, label, default_role, vocab) VALUES ($1, 'main', 'Main', 'buyer', $2) RETURNING id",
        [cid, JSON.stringify(vocab)],
      )
    ).rows[0].id;
    for (const [name, key, status] of [["Ann Lee", "AL", "active"], ["Sam Old", "SO", "suspended"]]) {
      await client.query(
        "INSERT INTO people (customer_id, display_name, owner_key, passcode_hash, status) VALUES ($1, $2, $3, 'x', $4)",
        [cid, name, key, status],
      );
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("a key link loads with claudeKeyOnFile", async () => {
    expect(await loadSetupPage(await link({ purpose: "key" }))).toEqual({ kind: "ok", purpose: "key", claudeKeyOnFile: false });
    await client.query("UPDATE customers SET claude_key_enc = 'k1.a.b.c' WHERE id = $1", [cid]);
    const after = await loadSetupPage(await link({ purpose: "key" }));
    expect(after).toEqual({ kind: "ok", purpose: "key", claudeKeyOnFile: true });
    expect(JSON.stringify(after)).not.toContain("k1.");
  });

  it("host, connect and replace links load as expired", async () => {
    for (const purpose of ["host", "connect", "replace"]) {
      expect(await loadSetupPage(await link({ purpose }))).toEqual({ kind: "expired" });
    }
  });

  it("does not consume the link or count an attempt", async () => {
    const t = await link();
    await loadSetupPage(t);
    const row = (await client.query("SELECT used_at, attempts FROM setup_links WHERE token_hash = $1", [hashToken(t)])).rows[0];
    expect(row).toEqual({ used_at: null, attempts: 0 });
  });

  it("treats expired, used, spent, unknown and malformed links as expired", async () => {
    for (const t of [
      await link({ expires: "-1 minute" }),
      await link({ used: true }),
      await link({ attempts: 10 }),
      newToken(),
      "not-a-token",
    ]) {
      expect(await loadSetupPage(t)).toEqual({ kind: "expired" });
    }
  });
});
