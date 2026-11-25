import { randomBytes } from "node:crypto";
import type { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAnonRole, makeAccountsTestDb, makeTestDb, testRoleName } from "@/lib/monsoon/testing/db";
import { decryptSecret, hashToken, newToken } from "@/lib/monsoon/accounts/crypto";
import { loginAndPoliciesScript } from "@/lib/monsoon/accounts/setup-script";
import { runSetupChecks } from "@/lib/monsoon/accounts/setup-check";
import { POST, maxDuration } from "./route";

const h = vi.hoisted(() => ({ create: vi.fn(), crmUrl: "" }));

vi.mock("@anthropic-ai/sdk", () => {
  class Anthropic {
    messages = { create: h.create };
    constructor(public opts: unknown) {}
  }
  return { default: Anthropic };
});

// The real address rules still run; the URL then points at the local test CRM as the test role.
vi.mock("@/lib/monsoon/accounts/address", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/monsoon/accounts/address")>();
  return {
    ...actual,
    buildPoolerUrl: vi.fn((input: { projectRef: string; poolerHost: string; password: string }) => {
      actual.buildPoolerUrl(input);
      const u = new URL(h.crmUrl);
      u.username = `${(globalThis as { __setupRole?: string }).__setupRole}`;
      u.password = encodeURIComponent(input.password);
      return u.toString();
    }),
  };
});

// Roles are cluster-wide, so tests use a per-worker role in place of monsoon_app.
vi.mock("@/lib/monsoon/accounts/setup-check", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/monsoon/accounts/setup-check")>();
  return {
    ...actual,
    runSetupChecks: vi.fn((input: Parameters<typeof actual.runSetupChecks>[0]) =>
      actual.runSetupChecks({ ...input, roleName: `${(globalThis as { __setupRole?: string }).__setupRole}` }),
    ),
  };
});

const PLACEHOLDER = "REPLACE-WITH-A-PASSWORD-OF-AT-LEAST-16-CHARACTERS";
const ROLE = `${testRoleName()}_rt`;
(globalThis as { __setupRole?: string }).__setupRole = ROLE;
const accounts = makeAccountsTestDb();
const crm = makeTestDb("setuproute");

const REF = "abcdefghij0123456789";
const HOST = "aws-1-us-east-1.pooler.supabase.com";
const KEY = "sk-ant-api03-SECRETKEYVALUE-0123456789";
const EXPIRED = "This setup link has expired. Ask for a new one.";
const TOO_MANY = "Too many attempts. Ask for a new setup link.";
const SUCCESS = "Connected. You can close this page.";
const TOO_MUCH = "The monsoon_app login has more access than Monsoon allows. Run the setup script again unchanged.";

function post(body: unknown): Request {
  return new Request("http://localhost/api/monsoon/setup", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe.skipIf(!accounts.available)("POST /api/monsoon/setup", { timeout: 30_000 }, () => {
  let client: Client;
  let crmAdmin: Client;
  let password: string;
  let cid: string;
  let pid: string;
  let token: string;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const bodies: string[] = [];

  const body = (extra: Record<string, unknown> = {}) => ({ token, projectRef: REF, poolerHost: HOST, password, ...extra });
  const keyBody = (extra: Record<string, unknown> = {}) => ({ token, claudeKey: KEY, ...extra });
  async function send(b: unknown): Promise<{ status: number; json: Record<string, unknown>; res: Response }> {
    const res = await POST(post(b));
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, json: JSON.parse(text), res };
  }
  async function link(opts: { purpose?: string; expires?: string; used?: boolean; attempts?: number; pipeline?: string | null } = {}) {
    const t = newToken();
    await client.query(
      `INSERT INTO setup_links (customer_id, pipeline_id, token_hash, purpose, expires_at, used_at, attempts)
       VALUES ($1, $2, $3, $4, now() + $5::interval, $6, $7)`,
      [
        cid,
        opts.pipeline === undefined ? pid : opts.pipeline,
        hashToken(t),
        opts.purpose ?? "host",
        opts.expires ?? "7 days",
        opts.used ? new Date() : null,
        opts.attempts ?? 0,
      ],
    );
    return t;
  }
  async function stored() {
    const p = (await client.query("SELECT db_url_enc, connected_at, project_ref FROM pipelines WHERE id = $1", [pid])).rows[0];
    const c = (await client.query("SELECT claude_key_enc FROM customers WHERE id = $1", [cid])).rows[0];
    const l = (await client.query("SELECT used_at, attempts FROM setup_links WHERE token_hash = $1", [hashToken(token)])).rows[0];
    const a = (await client.query("SELECT action, pipeline_key, person_id FROM activity ORDER BY id")).rows;
    return { dbUrlEnc: p.db_url_enc, connectedAt: p.connected_at, projectRef: p.project_ref, claudeKeyEnc: c.claude_key_enc, usedAt: l?.used_at ?? null, attempts: l?.attempts, activity: a };
  }
  async function expectNothingStored() {
    const s = await stored();
    expect(s.dbUrlEnc).toBeNull();
    expect(s.connectedAt).toBeNull();
    expect(s.projectRef).toBeNull();
    expect(s.claudeKeyEnc).toBeNull();
    expect(s.usedAt).toBeNull();
    expect(s.activity).toEqual([]);
  }
  async function dropRole() {
    const found = await crmAdmin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [ROLE]);
    if (found.rowCount) {
      await crmAdmin.query(`DROP OWNED BY ${ROLE}`);
      await crmAdmin.query(`DROP ROLE ${ROLE}`);
    }
  }

  beforeAll(async () => {
    await accounts.reset();
    client = await accounts.connect();
    h.crmUrl = crm.url();
  });
  afterAll(async () => {
    if (crmAdmin) {
      await dropRole();
      await crmAdmin.end();
    }
    await client?.end();
    // No response ever carried a credential.
    for (const b of bodies) {
      expect(b).not.toContain(KEY);
    }
  });
  beforeEach(async () => {
    vi.stubEnv("MONSOON_MASTER_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("MONSOON_ACCOUNTS_DATABASE_URL", accounts.url());
    vi.stubEnv("MONSOON_SESSION_SECRET", "x".repeat(32));
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.create.mockReset();
    h.create.mockResolvedValue({ id: "msg", content: [] });
    password = randomBytes(18).toString("base64url");

    await crm.reset();
    crmAdmin?.end().catch(() => undefined);
    crmAdmin = await crm.connect();
    await dropRole();
    await crmAdmin.query(loginAndPoliciesScript(ROLE).replace(PLACEHOLDER, password));

    await client.query("TRUNCATE activity, setup_links, pipelines, people, customers, sign_in_attempts CASCADE");
    cid = (await client.query("INSERT INTO customers (code, name) VALUES ('acme-co', 'Acme') RETURNING id")).rows[0].id;
    pid = (
      await client.query(
        "INSERT INTO pipelines (customer_id, key, label, default_role) VALUES ($1, 'main', 'Main', 'investor') RETURNING id",
        [cid],
      )
    ).rows[0].id;
    token = await link();
  });
  afterEach(() => {
    for (const call of errorSpy.mock.calls) {
      const line = call.map(String).join(" ");
      expect(line).not.toContain(password);
      expect(line).not.toContain(KEY);
    }
    for (const b of bodies) expect(b).not.toContain(password);
    bodies.length = 0;
    errorSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("host: stores the address encrypted and the project ref, consumes the link, records host", async () => {
    const { status, json, res } = await send(body());
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true, message: SUCCESS });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(vi.mocked(runSetupChecks).mock.calls[0][0]).toMatchObject({ roleName: "monsoon_app", claudeKey: null });
    expect(h.create).not.toHaveBeenCalled();

    const s = await stored();
    expect(s.usedAt).not.toBeNull();
    expect(s.connectedAt).not.toBeNull();
    expect(s.projectRef).toBe(REF);
    expect(s.dbUrlEnc).toMatch(/^k1\./);
    expect(s.dbUrlEnc).not.toContain(password);
    const url = new URL(decryptSecret(s.dbUrlEnc, cid, `pipeline:${pid}`));
    expect(decodeURIComponent(url.password)).toBe(password);
    expect(url.username).toBe(ROLE);
    expect(s.claudeKeyEnc).toBeNull();
    expect(s.activity).toEqual([{ action: "host", pipeline_key: "main", person_id: null }]);

    const again = await send(body());
    expect(again.status).toBe(410);
    expect(again.json.error).toBe(EXPIRED);
  });

  it("host: a pipeline that was in the shared database stops naming its schema there", async () => {
    await client.query("UPDATE pipelines SET db_url_enc = 'k1.old.old.old', shared_schema = 'c_0b9d2a476a3e4c1f9d552f7a3c1e8b10' WHERE id = $1", [pid]);
    expect((await send(body())).status).toBe(200);
    const p = (await client.query("SELECT db_url_enc, shared_schema FROM pipelines WHERE id = $1", [pid])).rows[0];
    expect(p.db_url_enc).not.toBe("k1.old.old.old");
    expect(new URL(decryptSecret(p.db_url_enc, cid, `pipeline:${pid}`)).username).toBe(ROLE);
    expect(p.shared_schema).toBeNull();
  });

  it("host: a project ref used by another pipeline is refused with 409 and nothing stored", async () => {
    await client.query(
      "INSERT INTO pipelines (customer_id, key, label, default_role, project_ref) VALUES ($1, 'other', 'Other', 'investor', $2)",
      [cid, REF],
    );
    const { status, json } = await send(body());
    expect(status).toBe(409);
    expect(json).toEqual({ error: "That project is already used by another pipeline." });
    await expectNothingStored();
  });

  it("host: missing password is refused with 422 connect", async () => {
    const { status, json } = await send(body({ password: "" }));
    expect(status).toBe(422);
    expect(json.failure).toBe("connect");
    await expectNothingStored();
  });

  it("host: a link without a pipeline is refused with 400", async () => {
    token = await link({ pipeline: null });
    const { status } = await send(body());
    expect(status).toBe(400);
  });

  it("host: a Claude key in the body is ignored and Anthropic is never called", async () => {
    const { status } = await send(body({ claudeKey: KEY }));
    expect(status).toBe(200);
    expect(h.create).not.toHaveBeenCalled();
    expect((await stored()).claudeKeyEnc).toBeNull();
  });

  it("vocabulary: the pipeline's default role missing from the CRM's roles is refused, 422", async () => {
    await client.query("UPDATE pipelines SET default_role = 'lp_prospect' WHERE id = $1", [pid]);
    const r = await send(body());
    expect(r.status).toBe(422);
    expect(r.json).toEqual({
      error: "Your Monsoon tables are missing stages or roles. Run the setup script again unchanged.",
      failure: "vocabulary",
    });
    await expectNothingStored();
  });

  it("can_delete: a role granted DELETE is refused and nothing is stored", async () => {
    await crmAdmin.query(`GRANT DELETE ON touches TO ${ROLE}`);
    const { status, json } = await send(body());
    expect(status).toBe(422);
    expect(json).toEqual({ error: TOO_MUCH, failure: "can_delete" });
    await expectNothingStored();
    expect((await stored()).attempts).toBe(1);
  });

  it("role_flags: a role with CREATEDB is refused and nothing is stored", async () => {
    await crmAdmin.query(`ALTER ROLE ${ROLE} CREATEDB`);
    const { status, json } = await send(body());
    expect(status).toBe(422);
    expect(json).toEqual({ error: TOO_MUCH, failure: "role_flags" });
    await expectNothingStored();
  });

  it("public_policies: a policy TO anon is refused and nothing is stored", async () => {
    await ensureAnonRole(crmAdmin);
    await crmAdmin.query("CREATE POLICY open_read ON people FOR SELECT TO anon USING (true)");
    const { status, json } = await send(body());
    expect(status).toBe(422);
    expect(json).toEqual({
      error: "Your database lets the public API read Monsoon tables. Remove the policies for anon and authenticated.",
      failure: "public_policies",
    });
    await expectNothingStored();
  });

  it("key: stores the Claude key encrypted, records key", async () => {
    token = await link({ purpose: "key", pipeline: null });
    const { status, json } = await send(keyBody());
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true, message: SUCCESS });
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-haiku-5-5", max_tokens: 1 }));
    expect(runSetupChecks).not.toHaveBeenCalled();
    const s = await stored();
    expect(decryptSecret(s.claudeKeyEnc, cid, "claude_key")).toBe(KEY);
    expect(s.dbUrlEnc).toBeNull();
    expect(s.usedAt).not.toBeNull();
    expect(s.activity).toEqual([{ action: "key", pipeline_key: null, person_id: null }]);
  });

  it("key: a key Anthropic refuses is 422 claude_key and nothing stored", async () => {
    token = await link({ purpose: "key", pipeline: null });
    h.create.mockRejectedValue(Object.assign(new Error(`401 invalid x-api-key ${KEY}`), { status: 401 }));
    const { status, json } = await send(keyBody());
    expect(status).toBe(422);
    expect(json).toEqual({ error: "That Claude key didn't work. Check it in the Claude Console.", failure: "claude_key" });
    await expectNothingStored();
  });

  it("key: blank key is 422 claude_key", async () => {
    token = await link({ purpose: "key", pipeline: null });
    const { status, json } = await send(keyBody({ claudeKey: "  " }));
    expect(status).toBe(422);
    expect(json.failure).toBe("claude_key");
    expect(h.create).not.toHaveBeenCalled();
    await expectNothingStored();
  });

  it("key: database fields on a key link are refused with 400", async () => {
    token = await link({ purpose: "key", pipeline: null });
    const { status, json } = await send(keyBody({ projectRef: REF, poolerHost: HOST, password }));
    expect(status).toBe(400);
    expect(json).toEqual({ error: "Invalid request" });
    expect(h.create).not.toHaveBeenCalled();
    await expectNothingStored();
  });

  it("key: empty database fields (as the current form posts them) are not database fields", async () => {
    token = await link({ purpose: "key", pipeline: null });
    const { status } = await send(keyBody({ projectRef: "", poolerHost: "", password: "" }));
    expect(status).toBe(200);
  });

  it("key: replaces a key already on file", async () => {
    await client.query("UPDATE customers SET claude_key_enc = 'k1.kept.on.file' WHERE id = $1", [cid]);
    token = await link({ purpose: "key", pipeline: null });
    const { status } = await send(keyBody());
    expect(status).toBe(200);
    expect(decryptSecret((await stored()).claudeKeyEnc, cid, "claude_key")).toBe(KEY);
  });

  it("legacy connect and replace links are refused as expired", async () => {
    for (const purpose of ["connect", "replace"]) {
      const t = await link({ purpose });
      const { status, json } = await send(body({ token: t, claudeKey: KEY }));
      expect(status).toBe(410);
      expect(json).toEqual({ error: EXPIRED });
      const row = (await client.query("SELECT used_at, attempts FROM setup_links WHERE token_hash = $1", [hashToken(t)])).rows[0];
      expect(row).toEqual({ used_at: null, attempts: 0 });
    }
    expect(h.create).not.toHaveBeenCalled();
    expect(runSetupChecks).not.toHaveBeenCalled();
  });

  it("address: a host that isn't a pooler", async () => {
    const { status, json } = await send(body({ poolerHost: "db.example.com" }));
    expect(status).toBe(422);
    expect(json).toEqual({
      error: "That pooler host isn't a Supabase pooler address. Copy it from Supabase's Connect screen.",
      failure: "address",
    });
  });

  it("host: a wrong password", async () => {
    const { status, json } = await send(body({ password: "not-the-right-password-1" }));
    expect(status).toBe(422);
    expect(json.failure).toBe("connect");
    await expectNothingStored();
  });

  it("expired, used, unknown and malformed links get the expired message without running checks", async () => {
    for (const t of [
      await link({ expires: "-1 minute" }),
      await link({ used: true }),
      newToken(),
      "short",
      `${"a".repeat(42)}!`,
    ]) {
      const { status, json, res } = await send(body({ token: t }));
      expect(status).toBe(410);
      expect(json).toEqual({ error: EXPIRED });
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(runSetupChecks).not.toHaveBeenCalled();
  });

  it("allows ten attempts, then 429", async () => {
    await client.query("UPDATE setup_links SET attempts = 9 WHERE token_hash = $1", [hashToken(token)]);
    const tenth = await send(body({ password: "not-the-right-password-1" }));
    expect(tenth.status).toBe(422);
    vi.mocked(runSetupChecks).mockClear();
    const eleventh = await send(body());
    expect(eleventh.status).toBe(429);
    expect(eleventh.json).toEqual({ error: TOO_MANY });
    expect(eleventh.res.headers.get("Cache-Control")).toBe("no-store");
    expect(runSetupChecks).not.toHaveBeenCalled();
    await expectNothingStored();
  });

  it("two concurrent submissions: exactly one succeeds and one activity row is written", async () => {
    const results = await Promise.all([send(body()), send(body())]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 410]);
    expect(results.find((r) => r.status === 410)?.json).toEqual({ error: EXPIRED });
    expect((await stored()).activity).toHaveLength(1);
  });

  it("rejects a malformed body", async () => {
    for (const b of ["not json", { token, projectRef: 5 }, [1, 2], "x".repeat(5000)]) {
      const { status, json, res } = await send(b);
      expect(status).toBe(400);
      expect(json).toEqual({ error: "Invalid request" });
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("an unreachable accounts database logs no credential", async () => {
    vi.stubEnv("MONSOON_ACCOUNTS_DATABASE_URL", "postgresql://postgres:test@127.0.0.1:1/nothing_test");
    const { status } = await send(body());
    expect(status).toBe(502);
    expect(errorSpy).toHaveBeenCalled();
  });

  beforeEach(() => {
    vi.mocked(runSetupChecks).mockClear();
  });
});

describe("setup route config", () => {
  it("has a 60 s maxDuration", () => {
    expect(maxDuration).toBe(60);
  });
});
