// Review Focus 4: the one-time bootstrap turns Vincent's env settings into customer `quantcloud`.
// Real accounts and CRM databases, real crypto, real session and save routes.
import { randomBytes } from "node:crypto";
import type { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The alpha sign-up is paused in production; this lets the test open it.
const gate = vi.hoisted(() => ({ open: false }));
vi.mock("@/lib/monsoon/alpha", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/monsoon/alpha")>();
  return {
    ...real,
    get SIGNUPS_OPEN() {
      return gate.open;
    },
  };
});

import { POST as alpha } from "@/app/api/monsoon/alpha/route";
import { POST as save } from "@/app/api/monsoon/save/route";
import { POST as signIn } from "@/app/api/monsoon/session/route";
import { decryptSecret } from "@/lib/monsoon/accounts/crypto";
import { clearAccountCache } from "@/lib/monsoon/accounts/store";
import { makeAccountsTestDb, makeTestDb } from "@/lib/monsoon/testing/db";
import { runAdmin } from "../../../../../scripts/monsoon/admin-commands";
import { POST } from "./route";

const accounts = makeAccountsTestDb();
const traxo = makeTestDb("boot_traxo");
const zeroone = makeTestDb("boot_zeroone");
const TOKEN = "t".repeat(40);
const CLAUDE_KEY = "sk-ant-bootstrap-0123456789";
const PASSCODE = "amber-river-stone-cloud-lamp";
const STAGES = JSON.stringify([
  { key: "uncontacted", ord: 0, label: "Uncontacted", terminal: false },
  { key: "client", ord: 1, label: "Client", terminal: true },
]);
const ROLES = JSON.stringify([{ key: "investor", label: "Investor" }]);

function boot(headers: Record<string, string> = { "x-monsoon-bootstrap": TOKEN }): Request {
  return new Request("http://localhost/api/monsoon/bootstrap", { method: "POST", headers });
}

describe.skipIf(!accounts.available)("POST /api/monsoon/bootstrap", () => {
  let admin: Client;
  let zero: Client;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  const run = (argv: string[]) =>
    runAdmin(argv, { db: admin, out: () => undefined, env: {}, readFile: () => `MONSOON_PASSCODE=${PASSCODE}\n` });

  async function rows() {
    const c = (await admin.query("SELECT id, claude_key_enc FROM customers WHERE code = 'quantcloud'")).rows[0];
    const p = (
      await admin.query("SELECT id, key, db_url_enc, connected_at FROM pipelines WHERE customer_id = $1 ORDER BY key", [c.id])
    ).rows;
    return { c, p };
  }

  beforeAll(async () => {
    await Promise.all([accounts.reset(), traxo.reset(), zeroone.reset()]);
    [admin, zero] = await Promise.all([accounts.connect(), zeroone.connect()]);
    await zero.query("INSERT INTO roles (key, label) VALUES ('reader', 'Reader') ON CONFLICT DO NOTHING");
  });
  afterAll(async () => {
    await Promise.all([admin?.end(), zero?.end()]);
  });
  beforeEach(async () => {
    vi.stubEnv("MONSOON_MASTER_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("MONSOON_ACCOUNTS_DATABASE_URL", accounts.url());
    vi.stubEnv("MONSOON_SESSION_SECRET", "s".repeat(32));
    vi.stubEnv("MONSOON_BOOTSTRAP_TOKEN", TOKEN);
    vi.stubEnv("TRAXO_CRM_DATABASE_URL", traxo.url());
    vi.stubEnv("ZEROONE_CRM_DATABASE_URL", zeroone.url());
    vi.stubEnv("ANTHROPIC_API_KEY", CLAUDE_KEY);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    gate.open = false;
    clearAccountCache();
    await admin.query("TRUNCATE activity, setup_links, pipelines, people, customers, sign_in_attempts CASCADE");
    await zero.query("TRUNCATE orgs, people, members, touches, captures CASCADE");
    expect(await run(["customer", "add", "quantcloud", "Quantcloud"])).toBe(0);
    for (const key of ["traxo", "zeroone"]) {
      expect(await run(["pipeline", "add", "quantcloud", key, key, "--default-role", "investor", "--stages", STAGES, "--roles", ROLES])).toBe(0);
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    ["no header", {}],
    ["a wrong token", { "x-monsoon-bootstrap": "x".repeat(40) }],
    ["a prefix of the token", { "x-monsoon-bootstrap": TOKEN.slice(0, 39) }],
  ])("answers 404 for %s and writes nothing", async (_label, headers) => {
    const res = await POST(boot(headers));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
    expect((await rows()).c.claude_key_enc).toBeNull();
  });

  it.each([["unset", ""], ["shorter than 32 characters", "short-token"]])(
    "answers 404 when the token setting is %s, even to a matching header",
    async (_label, value) => {
      vi.stubEnv("MONSOON_BOOTSTRAP_TOKEN", value);
      const res = await POST(boot({ "x-monsoon-bootstrap": value }));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found" });
    },
  );

  it("encrypts the three settings into the rows, and they decrypt back", async () => {
    const res = await POST(boot());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { c, p } = await rows();
    expect(c.claude_key_enc).toMatch(/^k1\./);
    expect(decryptSecret(c.claude_key_enc, c.id, "claude_key")).toBe(CLAUDE_KEY);
    const [t, z] = p;
    expect(t.key).toBe("traxo");
    expect(decryptSecret(t.db_url_enc, c.id, `pipeline:${t.id}`)).toBe(traxo.url());
    expect(decryptSecret(z.db_url_enc, c.id, `pipeline:${z.id}`)).toBe(zeroone.url());
    expect(t.connected_at).not.toBeNull();
    expect(z.connected_at).not.toBeNull();
    const act = (await admin.query("SELECT customer_id, person_id, action FROM activity")).rows;
    expect(act).toEqual([{ customer_id: c.id, person_id: null, action: "setup" }]);
  });

  it("a pipeline that named a schema in the shared database no longer does once its own address is stored", async () => {
    await admin.query("UPDATE pipelines SET shared_schema = 'c_0b9d2a476a3e4c1f9d552f7a3c1e8b10'");
    expect((await POST(boot())).status).toBe(200);
    const p = (await admin.query("SELECT db_url_enc, shared_schema FROM pipelines ORDER BY key")).rows;
    expect(p.length).toBeGreaterThanOrEqual(2);
    for (const row of p) {
      expect(row.db_url_enc).toMatch(/^k1\./);
      expect(row.shared_schema).toBeNull();
    }
  });

  it("trims trailing whitespace and newlines from the three settings before storing", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", `${CLAUDE_KEY}
`);
    vi.stubEnv("TRAXO_CRM_DATABASE_URL", `${traxo.url()}
`);
    vi.stubEnv("ZEROONE_CRM_DATABASE_URL", ` ${zeroone.url()}
`);
    const res = await POST(boot());
    expect(res.status).toBe(200);
    const { c, p } = await rows();
    expect(decryptSecret(c.claude_key_enc, c.id, "claude_key")).toBe(CLAUDE_KEY);
    expect(decryptSecret(p[0].db_url_enc, c.id, `pipeline:${p[0].id}`)).toBe(traxo.url());
    expect(decryptSecret(p[1].db_url_enc, c.id, `pipeline:${p[1].id}`)).toBe(zeroone.url());
  });

  it("refuses a second call with 409 and changes nothing", async () => {
    expect((await POST(boot())).status).toBe(200);
    const before = await rows();
    const res = await POST(boot());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Already done" });
    expect(await rows()).toEqual(before);
  });

  it("refuses without customer quantcloud", async () => {
    await admin.query("TRUNCATE pipelines, customers CASCADE");
    const res = await POST(boot());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Customer not found" });
  });

  it("refuses when a pipeline is missing and writes nothing", async () => {
    await admin.query("UPDATE pipelines SET key = 'other' WHERE key = 'zeroone'");
    const res = await POST(boot());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Pipelines not found" });
    const { c, p } = await rows();
    expect(c.claude_key_enc).toBeNull();
    expect(p.every((r: { db_url_enc: string | null }) => r.db_url_enc === null)).toBe(true);
  });

  it.each(["TRAXO_CRM_DATABASE_URL", "ZEROONE_CRM_DATABASE_URL", "ANTHROPIC_API_KEY"])(
    "refuses when %s is missing and writes nothing",
    async (name) => {
      vi.stubEnv(name, "");
      const res = await POST(boot());
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "Settings missing" });
      expect((await rows()).c.claude_key_enc).toBeNull();
    },
  );

  it("refuses an address the guard rejects, without echoing it, and writes nothing", async () => {
    const bad = "postgresql://u:secretpw@db.example.com:5432/postgres";
    vi.stubEnv("ZEROONE_CRM_DATABASE_URL", bad);
    const res = await POST(boot());
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "Address not allowed" });
    expect(text).not.toContain("example.com");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("secretpw");
    const { c, p } = await rows();
    expect(c.claude_key_enc).toBeNull();
    expect(p.every((r: { db_url_enc: string | null }) => r.db_url_enc === null)).toBe(true);
  });

  it("refuses with 409 when the master key is not configured", async () => {
    vi.stubEnv("MONSOON_MASTER_KEY", "");
    const res = await POST(boot());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Not configured" });
  });

  it("an unreachable accounts database answers 502 and logs no address", async () => {
    vi.stubEnv("MONSOON_ACCOUNTS_DATABASE_URL", "postgresql://u:hiddenpw@127.0.0.1:1/postgres");
    const res = await POST(boot());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Could not reach the accounts database" });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("hiddenpw");
    expect(errorSpy.mock.calls[0][0]).toBe("monsoon: bootstrap failed");
  });

  it("after bootstrap, Vincent signs in with the env passcode and a saved card lands in Zero One with owner VF", async () => {
    expect(await run(["person", "add", "quantcloud", "Vincent", "VF", "--passcode-from-env", "MONSOON_PASSCODE"])).toBe(0);
    expect((await POST(boot())).status).toBe(200);

    const signed = await signIn(
      new Request("http://localhost/api/monsoon/session", {
        method: "POST",
        body: JSON.stringify({ code: "quantcloud", passcode: PASSCODE }),
        headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.9" },
      }),
    );
    expect(signed.status).toBe(200);
    const token = /monsoon_session=([^;]+)/.exec(signed.headers.get("set-cookie") ?? "")?.[1];
    expect(token).toMatch(/^v2\./);

    const res = await save(
      new Request("http://localhost/api/monsoon/save", {
        method: "POST",
        body: JSON.stringify({
          estate: "zeroone",
          captureId: "6f1c1d5e-6a43-4c0b-9a52-1f0f4b0f2a11",
          role: "investor",
          fields: { name: "Ada Lovelace", org: "Analytical Capital" },
        }),
        headers: { "Content-Type": "application/json", cookie: `monsoon_session=${token}` },
      }),
    );
    expect(res.status).toBe(200);
    expect((await zero.query("SELECT owner FROM members")).rows).toEqual([{ owner: "VF" }]);
  });

  it("after bootstrap, an open alpha sign-up is recorded in Zero One with owner VF", async () => {
    expect((await POST(boot())).status).toBe(200);
    gate.open = true;
    const body = JSON.stringify({ email: "Jane@Example.com" });
    const res = await alpha(
      new Request("http://localhost/api/monsoon/alpha", {
        method: "POST",
        body,
        headers: { "Content-Type": "application/json", "Content-Length": String(body.length), Origin: "https://monsooncrm.com" },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await zero.query("SELECT p.email, m.owner FROM members m JOIN people p ON p.id = m.person_id")).rows).toEqual([
      { email: "jane@example.com", owner: "VF" },
    ]);
  });
});
