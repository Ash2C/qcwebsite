import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAnonRole, makeTestDb, testRoleName } from "../testing/db";
import { SETUP_MESSAGES, runSetupChecks, type SetupFailure } from "./setup-check";
import { loginAndPoliciesScript } from "./setup-script";

const PLACEHOLDER = "REPLACE-WITH-A-PASSWORD-OF-AT-LEAST-16-CHARACTERS";
const db = makeTestDb("setupcheck");
const ROLE = `${testRoleName()}_chk`;

describe.skipIf(!db.available)("runSetupChecks (real Postgres)", { timeout: 20_000 }, () => {
  let password: string;
  let admin: Client;

  const urlFor = (pw: string) => {
    const u = new URL(db.url());
    return `postgresql://${ROLE}:${encodeURIComponent(pw)}@${u.hostname}:${u.port}${u.pathname}`;
  };
  const check = (
    opts: { claudeKey?: string | null; tryClaude?: (k: string) => Promise<boolean>; dbUrl?: string; defaultRole?: string } = {},
  ) =>
    runSetupChecks({
      dbUrl: opts.dbUrl ?? urlFor(password),
      defaultRole: opts.defaultRole ?? "investor",
      claudeKey: opts.claudeKey === undefined ? "sk-ant-test-key" : opts.claudeKey,
      roleName: ROLE,
      tryClaude: opts.tryClaude ?? (async () => true),
    });
  const failure = (f: SetupFailure) => ({ ok: false, failure: f });

  async function dropRole(c: Client) {
    const found = await c.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [ROLE]);
    if (found.rowCount) {
      await c.query(`DROP OWNED BY ${ROLE}`);
      await c.query(`DROP ROLE ${ROLE}`);
    }
  }

  beforeEach(async () => {
    password = randomBytes(18).toString("base64url");
    await db.reset();
    admin?.end().catch(() => undefined);
    admin = await db.connect();
    await dropRole(admin);
    await admin.query(loginAndPoliciesScript(ROLE).replace(PLACEHOLDER, password));
  });
  afterAll(async () => {
    if (!admin) return;
    await dropRole(admin);
    await admin.end();
  });

  it("passes a freshly set-up database and tries the Claude key", async () => {
    const tryClaude = vi.fn(async () => true);
    expect(await check({ tryClaude })).toEqual({ ok: true });
    expect(tryClaude).toHaveBeenCalledWith("sk-ant-test-key");
  });

  it("skips the Claude key when none is given", async () => {
    const tryClaude = vi.fn(async () => true);
    expect(await check({ claudeKey: null, tryClaude })).toEqual({ ok: true });
    expect(tryClaude).not.toHaveBeenCalled();
  });

  it("address: refuses a host that is not a pooler", async () => {
    const tryClaude = vi.fn(async () => true);
    const r = await check({ dbUrl: `postgresql://${ROLE}:x@db.example.com:5432/postgres`, tryClaude });
    expect(r).toEqual(failure("address"));
    expect(tryClaude).not.toHaveBeenCalled();
  });

  it("connect: wrong password", async () => {
    expect(await check({ dbUrl: urlFor("not-the-password-123") })).toEqual(failure("connect"));
  });

  it("tables: a Monsoon table is missing", async () => {
    await admin.query("DROP TABLE member_tags");
    expect(await check()).toEqual(failure("tables"));
  });

  it("version: no schema version recorded", async () => {
    await admin.query("DELETE FROM schema_migrations");
    expect(await check()).toEqual(failure("version"));
  });

  it("vocabulary: no stage a contact can sit in (all terminal)", async () => {
    await admin.query("UPDATE stages SET terminal = true");
    expect(await check()).toEqual(failure("vocabulary"));
  });

  it("vocabulary: no stages at all", async () => {
    await admin.query("TRUNCATE stages CASCADE");
    expect(await check()).toEqual(failure("vocabulary"));
  });

  it("vocabulary: the pipeline's default role is not in roles", async () => {
    expect(await check({ defaultRole: "lp_prospect" })).toEqual(failure("vocabulary"));
  });

  it("can_delete: the role was granted DELETE", async () => {
    await admin.query(`GRANT DELETE ON touches TO ${ROLE}`);
    expect(await check()).toEqual(failure("can_delete"));
    // The probe never removes anything.
    expect((await admin.query("SELECT count(*)::int AS n FROM stages")).rows[0].n).toBe(5);
  });

  it("privileges: DELETE or TRUNCATE on any Monsoon table", async () => {
    await admin.query(`GRANT TRUNCATE ON tags TO ${ROLE}`);
    expect(await check()).toEqual(failure("privileges"));
    await admin.query(`REVOKE TRUNCATE ON tags FROM ${ROLE}`);
    await admin.query(`GRANT DELETE ON stages TO ${ROLE}`);
    expect(await check()).toEqual(failure("privileges"));
  });

  it("role_flags: CREATEDB", async () => {
    await admin.query(`ALTER ROLE ${ROLE} CREATEDB`);
    expect(await check()).toEqual(failure("role_flags"));
  });

  it("role_flags: member of another role", async () => {
    await admin.query(`GRANT pg_monitor TO ${ROLE}`);
    try {
      expect(await check()).toEqual(failure("role_flags"));
    } finally {
      await admin.query(`REVOKE pg_monitor FROM ${ROLE}`);
    }
  });

  it("public_policies: a policy for anon", async () => {
    await ensureAnonRole(admin);
    await admin.query("CREATE POLICY open_read ON orgs FOR SELECT TO anon USING (true)");
    expect(await check()).toEqual(failure("public_policies"));
  });

  it("claude_key: tryClaude returns false or throws", async () => {
    expect(await check({ tryClaude: async () => false })).toEqual(failure("claude_key"));
    expect(await check({ tryClaude: async () => Promise.reject(new Error("network")) })).toEqual(failure("claude_key"));
  });

  it("has the fixed message for every failure", () => {
    expect(SETUP_MESSAGES.address).toBe(
      "That pooler host isn't a Supabase pooler address. Copy it from Supabase's Connect screen.",
    );
    expect(SETUP_MESSAGES.connect).toBe(
      "Couldn't sign in to your database as monsoon_app. Check the project reference, pooler host and password.",
    );
    expect(SETUP_MESSAGES.tables).toBe("The Monsoon tables aren't there yet. Run the setup script first.");
    expect(SETUP_MESSAGES.version).toBe(SETUP_MESSAGES.tables);
    expect(SETUP_MESSAGES.vocabulary).toBe(
      "Your Monsoon tables are missing stages or roles. Run the setup script again unchanged.",
    );
    const tooMuch = "The monsoon_app login has more access than Monsoon allows. Run the setup script again unchanged.";
    expect([SETUP_MESSAGES.can_delete, SETUP_MESSAGES.privileges, SETUP_MESSAGES.role_flags]).toEqual([tooMuch, tooMuch, tooMuch]);
    expect(SETUP_MESSAGES.public_policies).toBe(
      "Your database lets the public API read Monsoon tables. Remove the policies for anon and authenticated.",
    );
    expect(SETUP_MESSAGES.claude_key).toBe("That Claude key didn't work. Check it in your Anthropic console.");
  });
});
