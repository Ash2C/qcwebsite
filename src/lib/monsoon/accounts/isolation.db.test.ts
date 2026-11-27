// Review Focus 1: two customers, each with a pipeline keyed `main` on its own CRM database. Signed in
// as A, the real route handlers touch only A's database, use only A's Claude key, and never act on a
// change signed for B. Only the Anthropic SDK is replaced; accounts, sessions, crypto and Postgres are real.
import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// What the fake SDK saw: the key each client was built with, and the replies it hands back in order.
const sdk = vi.hoisted(() => ({
  apiKeys: [] as string[],
  replies: [] as Array<{ stop_reason: string; content: Array<Record<string, unknown>> }>,
}));
vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const real = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  class FakeAnthropic {
    apiKey: string;
    messages = {
      create: async () => {
        const next = sdk.replies.shift();
        if (!next) throw new Error("no scripted reply");
        return next;
      },
    };
    constructor(opts: { apiKey: string }) {
      this.apiKey = opts.apiKey;
      sdk.apiKeys.push(opts.apiKey);
    }
  }
  return { ...real, default: Object.assign(FakeAnthropic, real.default) };
});

import { POST as act } from "@/app/api/monsoon/act/route";
import { POST as ask } from "@/app/api/monsoon/ask/route";
import { GET as contacts } from "@/app/api/monsoon/contacts/route";
import { POST as propose } from "@/app/api/monsoon/propose/route";
import { POST as save } from "@/app/api/monsoon/save/route";
import { signSession } from "../auth";
import { makeAccountsTestDb, makeTestDb } from "../testing/db";
import { encryptSecret } from "./crypto";
import { clearAccountCache } from "./store";

const accounts = makeAccountsTestDb();
const crmA = makeTestDb("a");
const crmB = makeTestDb("b");
const KEY_A = "sk-ant-customer-a-0123456789";
const KEY_B = "sk-ant-customer-b-9876543210";
const TABLES = ["orgs", "people", "members", "touches", "captures"];

type Customer = { id: string; personId: string; cookie: string };

describe.skipIf(!accounts.available)("two customers stay apart (real routes, real databases)", () => {
  let admin: Client;
  let dbA: Client;
  let dbB: Client;
  let A: Customer;
  let B: Customer;
  let memberB: string;

  async function addCustomer(code: string, ownerKey: string, crmUrl: string, claudeKey: string, extraKey?: string): Promise<Customer> {
    const id = (await admin.query("INSERT INTO customers (code, name) VALUES ($1, $1) RETURNING id", [code])).rows[0].id;
    await admin.query("UPDATE customers SET claude_key_enc = $1 WHERE id = $2", [encryptSecret(claudeKey, id, "claude_key"), id]);
    const personId = (
      await admin.query(
        "INSERT INTO people (customer_id, display_name, owner_key, passcode_hash) VALUES ($1, $2, $3, 'h') RETURNING id",
        [id, `Person ${ownerKey}`, ownerKey],
      )
    ).rows[0].id;
    for (const [i, key] of [["0", "main"], ["1", extraKey]] as const) {
      if (!key) continue;
      const pid = (
        await admin.query(
          "INSERT INTO pipelines (customer_id, key, label, default_role, position) VALUES ($1, $2, $2, 'investor', $3) RETURNING id",
          [id, key, Number(i)],
        )
      ).rows[0].id;
      await admin.query("UPDATE pipelines SET db_url_enc = $1 WHERE id = $2", [encryptSecret(crmUrl, id, `pipeline:${pid}`), pid]);
    }
    const cookie = `monsoon_session=${signSession({ customerId: id, personId, sessionNo: 1 })}`;
    return { id, personId, cookie };
  }

  function post(path: string, who: Customer, body: unknown): Request {
    return new Request(`http://localhost/api/monsoon/${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", cookie: who.cookie },
    });
  }

  async function counts(db: Client): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const t of TABLES) out[t] = (await db.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
    return out;
  }

  async function saveAs(who: Customer, name: string, extra: Record<string, unknown> = {}): Promise<Response> {
    return save(post("save", who, { estate: "main", captureId: randomUUID(), role: "investor", fields: { name, org: "Shared Name Capital" }, ...extra }));
  }

  beforeAll(async () => {
    await Promise.all([accounts.reset(), crmA.reset(), crmB.reset()]);
    [admin, dbA, dbB] = await Promise.all([accounts.connect(), crmA.connect(), crmB.connect()]);
    await dbA.query("INSERT INTO owners (key, display_name) VALUES ('AN', 'Person AN')");
    await dbB.query("INSERT INTO owners (key, display_name) VALUES ('BO', 'Person BO')");
  });
  afterAll(async () => {
    await Promise.all([admin?.end(), dbA?.end(), dbB?.end()]);
  });
  beforeEach(async () => {
    vi.stubEnv("MONSOON_MASTER_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("MONSOON_ACCOUNTS_DATABASE_URL", accounts.url());
    vi.stubEnv("MONSOON_SESSION_SECRET", "s".repeat(32));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    clearAccountCache();
    sdk.apiKeys.length = 0;
    sdk.replies.length = 0;
    await admin.query("TRUNCATE activity, setup_links, pipelines, people, customers, sign_in_attempts CASCADE");
    for (const db of [dbA, dbB]) await db.query("TRUNCATE orgs, people, members, touches, captures, todos CASCADE");
    A = await addCustomer("customer-a", "AN", crmA.url(), KEY_A);
    B = await addCustomer("customer-b", "BO", crmB.url(), KEY_B, "bonly");
    // B has a contact with the same name A will save, so a leak would show up in A's results.
    expect((await saveAs(B, "Ada Lovelace")).status).toBe(200);
    memberB = (await dbB.query("SELECT id FROM members LIMIT 1")).rows[0].id;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("save as A writes only to A's database, with A's owner key", async () => {
    const before = await counts(dbB);
    const res = await saveAs(A, "Ada Lovelace");
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe("added");
    expect(await counts(dbB)).toEqual(before);
    expect((await dbA.query("SELECT owner FROM members")).rows).toEqual([{ owner: "AN" }]);
  });

  it("a to-do in B's database is not in A's: each customer's to-dos live in their own database", async () => {
    await dbB.query("INSERT INTO todos (title, member_id, source) VALUES ('B only follow-up', $1, 'app')", [memberB]);
    expect((await dbB.query("SELECT count(*)::int AS n FROM todos WHERE title = 'B only follow-up'")).rows[0].n).toBe(1);
    expect((await dbA.query("SELECT count(*)::int AS n FROM todos")).rows[0].n).toBe(0);
    // A saves a contact with the same name: B's to-do does not attach to it.
    expect((await saveAs(A, "Ada Lovelace")).status).toBe(200);
    expect((await dbA.query("SELECT count(*)::int AS n FROM todos")).rows[0].n).toBe(0);
  });

  it("contacts as A lists only A's contacts", async () => {
    await saveAs(A, "Ada Lovelace");
    const idA = (await dbA.query("SELECT id FROM people")).rows[0].id;
    const res = await contacts(new Request("http://localhost/api/monsoon/contacts?estate=main&q=Ada", { headers: { cookie: A.cookie } }));
    expect(res.status).toBe(200);
    const ids = JSON.stringify(await res.json());
    expect(ids).toContain(idA);
    const idB = (await dbB.query("SELECT id FROM people")).rows[0].id;
    expect(ids).not.toContain(idB);
  });

  it("ask and act as A read and write only A's database, with a proposal bound to A", async () => {
    await saveAs(A, "Ada Lovelace");
    const memberA = (await dbA.query("SELECT id FROM members")).rows[0].id;
    const before = await counts(dbB);
    sdk.replies.push(
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "find_contacts", input: { query: "Ada" } }] },
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t2", name: "propose_note", input: { member_id: memberA, text: "called back" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Ready to confirm." }] },
    );
    const asked = await ask(post("ask", A, { estate: "main", messages: [{ role: "user", content: "note on Ada: called back" }], customer: B.id }));
    expect(asked.status).toBe(200);
    const result = await asked.json();
    expect(JSON.stringify(result.refs)).not.toContain(memberB);
    const signed = result.proposals[0];
    expect(signed.proposal.customer).toBe(A.id);

    const done = await act(post("act", A, { estate: "main", proposal: signed.proposal, signature: signed.signature, text: "called back" }));
    expect(done.status).toBe(200);
    expect((await done.json()).status).toBe("added");
    expect((await dbA.query("SELECT by_whom FROM touches WHERE kind = 'note'")).rows).toEqual([{ by_whom: "AN" }]);
    expect(await counts(dbB)).toEqual(before);
  });

  it("a body naming B's customer id is ignored and B's own pipeline key is refused", async () => {
    const before = await counts(dbB);
    expect((await saveAs(A, "Grace Hopper", { customer: B.id, customerId: B.id })).status).toBe(200);
    expect((await dbA.query("SELECT name FROM people")).rows).toEqual([{ name: "Grace Hopper" }]);
    const bOnly = await save(post("save", A, { estate: "bonly", captureId: randomUUID(), role: "investor", fields: { name: "Grace Hopper" } }));
    expect(bOnly.status).toBe(400);
    expect(await counts(dbB)).toEqual(before);
  });

  it("act as A refuses a proposal signed for B, even under the same pipeline key", async () => {
    const offered = await propose(post("propose", B, { estate: "main", kind: "add_note", target: { memberId: memberB }, text: "from B" }));
    const { signed } = await offered.json();
    expect(signed.proposal.customer).toBe(B.id);
    const before = await counts(dbB);
    const res = await act(post("act", A, { estate: "main", proposal: signed.proposal, signature: signed.signature, text: "from A" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "This change has expired. Ask again." });
    expect(await counts(dbB)).toEqual(before);
    expect((await dbA.query("SELECT count(*)::int AS n FROM touches")).rows[0].n).toBe(0);
  });

  it("the Anthropic client is built with A's decrypted key when A asks", async () => {
    sdk.replies.push({ stop_reason: "end_turn", content: [{ type: "text", text: "Hello." }] });
    const res = await ask(post("ask", A, { estate: "main", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200);
    expect(sdk.apiKeys).toEqual([KEY_A]);
  });
});
