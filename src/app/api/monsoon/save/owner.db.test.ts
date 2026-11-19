// A person whose owner key never reached a CRM (pipeline connected after sign-in, or the sign-in
// ensure failed) can still save and add notes: the write paths add the owner key first.
import { randomBytes } from "node:crypto";
import type { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAccountsTestDb, makeTestDb } from "@/lib/monsoon/testing/db";
import { SESSION_COOKIE, signSession } from "@/lib/monsoon/auth";
import { encryptSecret, hashPasscode } from "@/lib/monsoon/accounts/crypto";
import { clearAccountCache } from "@/lib/monsoon/accounts/store";
import { signProposal, type Proposal } from "@/lib/monsoon/ask/proposal";
import { POST as save } from "./route";
import { POST as act } from "../act/route";

const accounts = makeAccountsTestDb();
const crm = makeTestDb("owner_write");

describe.skipIf(!accounts.available)("write paths add a missing owner key", { timeout: 20_000 }, () => {
  let a: Client;
  let c: Client;
  let cid: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await accounts.reset();
    await crm.reset();
    a = await accounts.connect();
    c = await crm.connect();
  });
  afterAll(async () => {
    await a?.end();
    await c?.end();
  });
  beforeEach(async () => {
    vi.stubEnv("MONSOON_MASTER_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("MONSOON_ACCOUNTS_DATABASE_URL", accounts.url());
    vi.stubEnv("MONSOON_SESSION_SECRET", "x".repeat(32));
    clearAccountCache();
    await a.query("TRUNCATE activity, setup_links, pipelines, people, customers, sign_in_attempts CASCADE");
    cid = (await a.query("INSERT INTO customers (code, name) VALUES ('acme-co', 'Acme') RETURNING id")).rows[0].id;
    const hash = await hashPasscode("apple-banana-cherry-delta-echo");
    for (const [name, key] of [
      ["Ann", "AN"],
      ["Bob", "BO"],
    ]) {
      ids[key] = (
        await a.query(
          "INSERT INTO people (customer_id, display_name, owner_key, passcode_hash) VALUES ($1, $2, $3, $4) RETURNING id",
          [cid, name, key, hash],
        )
      ).rows[0].id;
    }
    const pid = (
      await a.query(
        "INSERT INTO pipelines (customer_id, key, label, default_role) VALUES ($1, 'main', 'Main', 'investor') RETURNING id",
        [cid],
      )
    ).rows[0].id;
    await a.query("UPDATE pipelines SET db_url_enc = $1, connected_at = now() WHERE id = $2", [
      encryptSecret(crm.url(), cid, `pipeline:${pid}`),
      pid,
    ]);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function request(path: string, ownerKey: string, body: unknown): Request {
    const cookie = signSession({ customerId: cid, personId: ids[ownerKey], sessionNo: 1 });
    return new Request(`http://localhost/api/monsoon/${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${cookie}` },
    });
  }

  async function owners(): Promise<string[]> {
    return (await c.query("SELECT key FROM owners ORDER BY key")).rows.map((r) => r.key);
  }

  it("save and add_note succeed for owners the CRM has never seen, and add them once", async () => {
    expect(await owners()).not.toContain("AN");
    const saved = await save(
      request("save", "AN", {
        estate: "main",
        captureId: "22222222-2222-4222-8222-222222222222",
        role: "investor",
        fields: { name: "Grace Hopper", org: "Navy Labs" },
        newOrg: true,
      }),
    );
    expect(saved.status).toBe(200);
    expect(["added", "existing", "filed"]).toContain((await saved.json()).outcome);
    expect(await owners()).toContain("AN");

    const member = (await c.query("SELECT id FROM members ORDER BY created_at DESC LIMIT 1")).rows[0].id as string;
    expect(await owners()).not.toContain("BO");
    const proposal = {
      kind: "add_note",
      customer: cid,
      estate: "main",
      memberId: member,
      memberKind: "person",
      memberName: "Grace Hopper",
      company: "Navy Labs",
      about: null,
      expires: Date.now() + 10 * 60 * 1000,
    } as Proposal;
    const res = await act(
      request("act", "BO", { estate: "main", proposal, signature: signProposal(proposal), text: "Met at the expo" }),
    );
    expect(res.status).toBe(200);
    const by = await c.query("SELECT by_whom FROM touches WHERE member_id = $1 AND kind = 'note'", [member]);
    expect(by.rows.map((r) => r.by_whom)).toContain("BO");
    expect(await owners()).toEqual(expect.arrayContaining(["AN", "BO", "VF"]));
  });
});
