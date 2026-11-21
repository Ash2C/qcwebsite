import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashToken, verifyPasscode } from "@/lib/monsoon/accounts/crypto";
import { makeAccountsTestDb, makeTestDb, testRoleName } from "@/lib/monsoon/testing/db";
import { runAdmin } from "./admin-commands";

const db = makeAccountsTestDb();
const STAGES = JSON.stringify([
  { key: "new", ord: 0, label: "New", terminal: false },
  { key: "won", ord: 1, label: "Won", terminal: true },
]);
const ROLES = JSON.stringify([{ key: "investor", label: "Investor" }]);

describe.skipIf(!db.available)("monsoon admin", () => {
  let client: Client;
  let lines: string[];
  const run = async (argv: string[], extra: Record<string, unknown> = {}) => {
    lines = [];
    const code = await runAdmin(argv, { db: client, out: (l) => lines.push(l), env: {}, ...extra });
    return code;
  };
  const text = () => lines.join("\n");

  beforeAll(async () => {
    client = await db.connect();
  });
  afterAll(async () => {
    await client.end();
  });
  beforeEach(async () => {
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
    await run(["migrate"]);
  });

  it("migrate is idempotent", async () => {
    expect(await run(["migrate"])).toBe(0);
    expect(text()).toContain("Schema already applied (version 2).");
  });

  it("adds a customer and a person whose passcode verifies", async () => {
    expect(await run(["customer", "add", "acme", "Acme Ltd"])).toBe(0);
    expect(await run(["person", "add", "acme", "Ann", "AN"])).toBe(0);
    const passcode = lines.find((l) => /^[a-z]+(-[a-z]+){4}$/.test(l.trim()))?.trim();
    expect(passcode).toBeTruthy();
    expect(text()).toMatch(/cannot be shown again/i);
    const { rows } = await client.query("SELECT passcode_hash, session_no FROM people");
    expect(await verifyPasscode(passcode!, rows[0].passcode_hash)).toBe(true);
    expect(rows[0].session_no).toBe(1);
  });

  it("reset and suspend raise session_no; resume does not", async () => {
    await run(["customer", "add", "acme", "Acme"]);
    await run(["person", "add", "acme", "Ann", "AN"]);
    await run(["person", "reset", "acme", "AN"]);
    let r = await client.query("SELECT session_no, status FROM people");
    expect(r.rows[0].session_no).toBe(2);
    await run(["person", "suspend", "acme", "AN"]);
    r = await client.query("SELECT session_no, status FROM people");
    expect(r.rows[0]).toMatchObject({ session_no: 3, status: "suspended" });
    await run(["person", "resume", "acme", "AN"]);
    r = await client.query("SELECT session_no, status FROM people");
    expect(r.rows[0]).toMatchObject({ session_no: 3, status: "active" });
  });

  it("passcode-from-env hashes without printing the value", async () => {
    await run(["customer", "add", "acme", "Acme"]);
    const code = await run(["person", "add", "acme", "Vince", "VF", "--passcode-from-env", "MONSOON_PASSCODE"], {
      readFile: () => "# c\nOTHER=x\nMONSOON_PASSCODE=hunter2-secret\n",
    });
    expect(code).toBe(0);
    expect(text()).toContain("Passcode set from MONSOON_PASSCODE");
    expect(text()).not.toContain("hunter2");
    const { rows } = await client.query("SELECT passcode_hash FROM people");
    expect(await verifyPasscode("hunter2-secret", rows[0].passcode_hash)).toBe(true);
  });

  it("refuses the 51st person", async () => {
    await run(["customer", "add", "acme", "Acme"]);
    await client.query(
      `INSERT INTO people (customer_id, display_name, owner_key, passcode_hash)
       SELECT c.id, 'P' || g, 'A' || chr(65 + (g % 26)) || chr(65 + (g / 26)), 'x'
       FROM customers c, generate_series(1, 50) g`,
    );
    expect(await run(["person", "add", "acme", "Extra", "ZZ"])).toBe(1);
    expect(text()).toMatch(/50/);
  });

  it("validates codes and owner keys", async () => {
    expect(await run(["customer", "add", "A", "x"])).toBe(1);
    await run(["customer", "add", "acme", "Acme"]);
    expect(await run(["person", "add", "acme", "Ann", "a"])).toBe(1);
    expect(await run(["person", "add", "nope", "Ann", "AN"])).toBe(1);
  });

  it("adds a pipeline and prints a script", async () => {
    await run(["customer", "add", "acme", "Acme"]);
    await run(["person", "add", "acme", "Ann", "AN"]);
    expect(
      await run(["pipeline", "add", "acme", "main", "Main", "--default-role", "investor", "--stages", STAGES, "--roles", ROLES]),
    ).toBe(0);
    const p = await client.query("SELECT position, vocab FROM pipelines");
    expect(p.rows[0].position).toBe(1);
    expect(p.rows[0].vocab.roles).toHaveLength(1);

    expect(await run(["script", "acme", "main"])).toBe(0);
    expect(text()).toContain("Ann");
    expect(await run(["script", "acme", "main", "--login-only"])).toBe(0);
    expect(text()).toContain("monsoon_app");
    expect(text()).not.toContain("Ann");
  });

  it("link makes a 7-day key link for the customer", async () => {
    await run(["customer", "add", "acme", "Acme"]);
    expect(await run(["link", "acme"], { env: { MONSOON_PUBLIC_URL: "https://example.test" } })).toBe(0);
    const url = lines.find((l) => l.includes("/monsoon/setup/"))!.trim();
    expect(url.startsWith("https://example.test/monsoon/setup/")).toBe(true);
    const token = url.split("/").pop()!;
    const l = await client.query(
      "SELECT token_hash, purpose, pipeline_id, EXTRACT(EPOCH FROM (expires_at - now())) AS span FROM setup_links",
    );
    expect(l.rows[0].token_hash).toBe(hashToken(token));
    expect(l.rows[0].purpose).toBe("key");
    expect(l.rows[0].pipeline_id).toBeNull();
    expect(Number(l.rows[0].span)).toBeGreaterThan(6.99 * 86400);
    expect(Number(l.rows[0].span)).toBeLessThanOrEqual(7 * 86400);

    expect(await run(["link", "acme", "main"])).toBe(1);
    expect(await run(["link", "acme", "--replace"])).toBe(1);
    expect(lines).toEqual(["Error: unknown flag --replace"]);
    expect((await client.query("SELECT count(*)::int AS n FROM setup_links")).rows[0].n).toBe(1);
  });

  it("status prints no encrypted values", async () => {
    await run(["customer", "add", "acme", "Acme"]);
    await run(["pipeline", "add", "acme", "main", "Main", "--default-role", "investor", "--stages", STAGES, "--roles", ROLES]);
    await client.query("UPDATE customers SET claude_key_enc = 'k1.aaa.bbb.ccc'");
    await client.query("UPDATE pipelines SET db_url_enc = 'k1.ddd.eee.fff', connected_at = now()");
    expect(await run(["status"])).toBe(0);
    expect(text()).not.toMatch(/k1\./);
    expect(text()).toContain("acme");
    expect(text()).toMatch(/main connected \d{4}-\d{2}-\d{2}/);
    expect(text()).toContain("set");
  });

  it("suspends and resumes a customer", async () => {
    await run(["customer", "add", "acme", "Acme"]);
    await run(["suspend", "acme"]);
    expect((await client.query("SELECT status FROM customers")).rows[0].status).toBe("suspended");
    await run(["resume", "acme"]);
    expect((await client.query("SELECT status FROM customers")).rows[0].status).toBe("active");
  });

  it("rejects a flag the command does not accept, with a one-line error and exit 1", async () => {
    await run(["customer", "add", "acme", "Acme"]);
    await run(["pipeline", "add", "acme", "main", "Main", "--default-role", "investor", "--stages", STAGES, "--roles", ROLES]);
    expect(await run(["link", "acme", "--replce"])).toBe(1);
    expect(lines).toEqual(["Error: unknown flag --replce"]);
    expect((await client.query("SELECT count(*)::int AS n FROM setup_links")).rows[0].n).toBe(0);
    expect(await run(["customer", "add", "beta", "Beta", "--modle", "x"])).toBe(1);
    expect(await run(["person", "reset", "acme", "AN", "--passcode-from-env", "X"])).toBe(1);
    expect(await run(["script", "acme", "main", "--replace"])).toBe(1);
    expect(await run(["suspend", "acme", "--now"])).toBe(1);
    expect(await run(["status", "--all"])).toBe(1);
    expect((await client.query("SELECT status FROM customers")).rows[0].status).toBe("active");
    expect(await run(["link", "acme"])).toBe(0);
  });

  describe("pipeline vocabulary", () => {
    beforeEach(async () => {
      await run(["customer", "add", "acme", "Acme"]);
    });
    const add = (stages: unknown, roles: unknown, role = "investor") =>
      run([
        "pipeline", "add", "acme", "main", "Main", "--default-role", role,
        "--stages", typeof stages === "string" ? stages : JSON.stringify(stages),
        "--roles", typeof roles === "string" ? roles : JSON.stringify(roles),
      ]);
    const stage = (key: string, ord: number, terminal = false, label = key) => ({ key, ord, label, terminal });
    const okRoles = [{ key: "investor", label: "Investor" }];

    it.each([
      ["empty stages", [], okRoles],
      ["a bad stage key", [stage("New Stage", 0)], okRoles],
      ["a stage key over 40 characters", [stage("a".repeat(41), 0)], okRoles],
      ["a non-integer ord", [stage("new", 1.5)], okRoles],
      ["an empty label", [stage("new", 0, false, "")], okRoles],
      ["a label over 60 characters", [stage("new", 0, false, "x".repeat(61))], okRoles],
      ["a non-boolean terminal", [{ key: "new", ord: 0, label: "New", terminal: "no" }], okRoles],
      ["duplicate stage keys", [stage("new", 0), stage("new", 1)], okRoles],
      ["duplicate ords", [stage("new", 0), stage("old", 0)], okRoles],
      ["empty roles", [stage("new", 0)], []],
      ["a role without a label", [stage("new", 0)], [{ key: "investor" }]],
      ["duplicate role keys", [stage("new", 0)], [...okRoles, ...okRoles]],
    ])("refuses %s and adds nothing", async (_label, stages, roles) => {
      expect(await add(stages, roles)).toBe(1);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^Error: /);
      expect((await client.query("SELECT count(*)::int AS n FROM pipelines")).rows[0].n).toBe(0);
    });

    it("refuses a default role that is not one of the roles", async () => {
      expect(await add([stage("new", 0)], okRoles, "lp_prospect")).toBe(1);
      expect(text()).toMatch(/--default-role/);
    });

    it("accepts a valid vocabulary", async () => {
      expect(await add(STAGES, ROLES)).toBe(0);
    });
  });

  it("people lists display name, owner key and status, and no hashes", async () => {
    await run(["customer", "add", "acme", "Acme"]);
    await run(["person", "add", "acme", "Ann", "AN"]);
    await run(["person", "add", "acme", "Bob", "BO"]);
    await run(["person", "suspend", "acme", "BO"]);
    expect(await run(["people", "acme"])).toBe(0);
    expect(text()).toContain("Ann | AN | active");
    expect(text()).toContain("Bob | BO | suspended");
    expect(text()).not.toMatch(/s1\./);
  });

  it("forget clears the stored secrets, suspends and signs everyone out, without removing rows", async () => {
    await run(["customer", "add", "acme", "Acme"]);
    await run(["customer", "add", "other", "Other"]);
    await run(["person", "add", "acme", "Ann", "AN"]);
    await run(["person", "add", "other", "Oz", "OZ"]);
    await run(["pipeline", "add", "acme", "main", "Main", "--default-role", "investor", "--stages", STAGES, "--roles", ROLES]);
    await run(["pipeline", "add", "acme", "side", "Side", "--default-role", "investor", "--stages", STAGES, "--roles", ROLES]);
    await run(["pipeline", "add", "other", "main", "Main", "--default-role", "investor", "--stages", STAGES, "--roles", ROLES]);
    await client.query("UPDATE customers SET claude_key_enc = 'k1.aaa.bbb.ccc'");
    await client.query("UPDATE pipelines SET db_url_enc = 'k1.ddd.eee.fff', connected_at = now()");

    expect(await run(["forget", "acme"])).toBe(0);
    expect(text()).not.toMatch(/k1\./);
    expect(text()).toMatch(/Claude key/);
    expect(text()).toMatch(/main/);
    const c = await client.query("SELECT code, status, claude_key_enc FROM customers ORDER BY code");
    expect(c.rows).toEqual([
      { code: "acme", status: "suspended", claude_key_enc: null },
      { code: "other", status: "active", claude_key_enc: "k1.aaa.bbb.ccc" },
    ]);
    const p = await client.query(
      "SELECT c.code, p.key, p.db_url_enc, p.connected_at FROM pipelines p JOIN customers c ON c.id = p.customer_id ORDER BY c.code, p.key",
    );
    expect(p.rows.map((r) => [r.code, r.key, r.db_url_enc, r.connected_at === null])).toEqual([
      ["acme", "main", null, true],
      ["acme", "side", null, true],
      ["other", "main", "k1.ddd.eee.fff", false],
    ]);
    const people = await client.query("SELECT owner_key, session_no FROM people ORDER BY owner_key");
    expect(people.rows).toEqual([
      { owner_key: "AN", session_no: 2 },
      { owner_key: "OZ", session_no: 1 },
    ]);
  });

  it("suspend also expires the customer's unused setup links", async () => {
    await run(["customer", "add", "acme", "Acme"]);
    await run(["customer", "add", "other", "Other"]);
    await run(["pipeline", "add", "acme", "main", "Main", "--default-role", "investor", "--stages", STAGES, "--roles", ROLES]);
    await run(["pipeline", "add", "other", "main", "Main", "--default-role", "investor", "--stages", STAGES, "--roles", ROLES]);
    await run(["link", "acme"]);
    await run(["link", "acme"]);
    await run(["link", "other"]);
    await client.query(
      "UPDATE setup_links SET used_at = now() - interval '1 day' WHERE id = (SELECT id FROM setup_links ORDER BY created_at LIMIT 1)",
    );
    expect(await run(["suspend", "acme"])).toBe(0);
    const r = await client.query(
      `SELECT c.code, l.used_at IS NOT NULL AS used, l.expires_at <= now() AS expired
         FROM setup_links l JOIN customers c ON c.id = l.customer_id ORDER BY l.created_at`,
    );
    expect(r.rows).toEqual([
      { code: "acme", used: true, expired: false },
      { code: "acme", used: false, expired: true },
      { code: "other", used: false, expired: false },
    ]);
  });

  describe("host", () => {
    const crm = makeTestDb("host");
    const role = `${testRoleName()}_host`;
    const REF = "abcdefghij0123456789";
    const POOLER = "aws-0-eu-west-1.pooler.supabase.com";
    const GENERATED = "Gx7_".repeat(10) + "abc";
    const OWNER_PW = "owner p@ss/word:with#odd?chars";
    const PUBLIC = "https://example.test";
    type Reply = { status: number; body: { ok?: boolean; error?: string; failure?: string } };
    let connects: string[];
    let posts: { url: string; body: Record<string, string> }[];
    let reply: () => Promise<Reply>;
    let owners: Client[];

    async function dropRole() {
      const c = await crm.connect();
      try {
        if ((await c.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rowCount) {
          await c.query(`DROP OWNED BY ${role}`);
          await c.query(`DROP ROLE ${role}`);
        }
      } finally {
        await c.end();
      }
    }
    const hostDeps = (env: Record<string, string> = {}) => ({
      env: { MONSOON_PUBLIC_URL: PUBLIC, OWNER_PW_VAR: OWNER_PW, ...env },
      appRole: role,
      randomPassword: () => GENERATED,
      connectOwner: async (url: string) => {
        connects.push(url);
        const c = await crm.connect();
        owners.push(c);
        return c;
      },
      post: async (url: string, body: Record<string, string>) => {
        posts.push({ url, body });
        return reply();
      },
    });
    const hostArgs = (ref = REF, pooler = POOLER) => ["host", "acme", "main", "--ref", ref, "--pooler", pooler, "--owner-password-from-env", "OWNER_PW_VAR"];
    const host = (extra: string[] = []) => run([...hostArgs(), ...extra], hostDeps());
    const noSecrets = () => {
      for (const l of lines) {
        expect(l).not.toContain(GENERATED);
        expect(l).not.toContain(OWNER_PW);
        expect(l).not.toContain(encodeURIComponent(OWNER_PW));
      }
    };

    beforeEach(async () => {
      connects = [];
      posts = [];
      owners = [];
      reply = async () => ({ status: 200, body: { ok: true } });
      await dropRole();
      const c = await crm.connect();
      await c.query("DROP SCHEMA IF EXISTS public CASCADE");
      await c.query("CREATE SCHEMA public");
      await c.end();
      await run(["customer", "add", "acme", "Acme"]);
      await run(["person", "add", "acme", "Ann", "AN"]);
      await run(["person", "add", "acme", "Bob", "BO"]);
      await run(["pipeline", "add", "acme", "main", "Main", "--default-role", "investor", "--stages", STAGES, "--roles", ROLES]);
    });
    afterEach(async () => {
      for (const o of owners) await o.end().catch(() => undefined);
      await dropRole();
    });

    it("host builds the CRM, posts ref, pooler and generated password to the setup route on a host link, prints no secret", async () => {
      expect(await host()).toBe(0);
      expect(text()).toContain(`Pipeline main hosted on project ${REF}.`);
      noSecrets();

      expect(connects).toEqual([`postgresql://postgres.${REF}:${encodeURIComponent(OWNER_PW)}@${POOLER}:5432/postgres`]);
      const c = await crm.connect();
      try {
        const t = await c.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'");
        expect(t.rows[0].n).toBe(11);
        expect((await c.query("SELECT key FROM stages ORDER BY ord")).rows.map((r) => r.key)).toEqual(["new", "won"]);
        expect((await c.query("SELECT key FROM roles")).rows.map((r) => r.key)).toEqual(["investor"]);
        expect((await c.query("SELECT key, display_name FROM owners ORDER BY key")).rows).toEqual([
          { key: "AN", display_name: "Ann" },
          { key: "BO", display_name: "Bob" },
        ]);
      } finally {
        await c.end();
      }
      const url = new URL(crm.url());
      const login = new Client({ host: url.hostname, port: Number(url.port), database: url.pathname.slice(1), user: role, password: GENERATED });
      await login.connect();
      await login.end();

      expect(posts).toHaveLength(1);
      expect(posts[0].url).toBe(`${PUBLIC}/api/monsoon/setup`);
      expect(posts[0].body).toEqual({ token: expect.any(String), projectRef: REF, poolerHost: POOLER, password: GENERATED });
      const l = await client.query(
        `SELECT l.purpose, p.key, EXTRACT(EPOCH FROM (l.expires_at - now())) AS span
           FROM setup_links l JOIN pipelines p ON p.id = l.pipeline_id WHERE l.token_hash = $1`,
        [hashToken(posts[0].body.token)],
      );
      expect(l.rows).toHaveLength(1);
      expect(l.rows[0]).toMatchObject({ purpose: "host", key: "main" });
      expect(Number(l.rows[0].span)).toBeGreaterThan(0);
      expect(Number(l.rows[0].span)).toBeLessThanOrEqual(15 * 60);
    });

    it("refuses a project ref already used by a pipeline", async () => {
      await run(["pipeline", "add", "acme", "side", "Side", "--default-role", "investor", "--stages", STAGES, "--roles", ROLES]);
      await client.query("UPDATE pipelines SET project_ref = $1 WHERE key = 'side'", [REF]);
      expect(await host()).toBe(1);
      expect(text()).toContain("That project is already used by another pipeline.");
      expect(connects).toHaveLength(0);
      expect(posts).toHaveLength(0);
    });

    it("refuses a project that already holds Monsoon people unless --replace", async () => {
      await crm.reset();
      const c = await crm.connect();
      await c.query("INSERT INTO people (name, name_key, source) VALUES ('Jane Tan', 'jane tan', 'test')");
      await c.end();
      expect(await host()).toBe(1);
      expect(text()).toContain("That project already holds Monsoon data. Check the project reference, or pass --replace.");
      expect(posts).toHaveLength(0);
      expect(await host(["--replace"])).toBe(0);
      expect(posts).toHaveLength(1);
      noSecrets();
    });

    it("refuses a pipeline that is already connected unless --replace", async () => {
      await client.query("UPDATE pipelines SET db_url_enc = 'k1.ddd.eee.fff', connected_at = now(), project_ref = $1", [REF]);
      expect(await host()).toBe(1);
      expect(text()).toMatch(/already connected/);
      expect(text()).toContain("--replace");
      expect(connects).toHaveLength(0);
      expect(await host(["--replace"])).toBe(0);
      expect(posts).toHaveLength(1);
    });

    it("a server refusal after the script ran exits 1 and says to run host again", async () => {
      reply = async () => ({ status: 422, body: { failure: "can_delete", error: "The Monsoon login can remove rows." } });
      expect(await host()).toBe(1);
      expect(text()).toContain("The Monsoon login can remove rows.");
      expect(text()).toContain("The pipeline is not connected until host runs again successfully.");
      expect(text()).not.toContain("hosted on project");
      noSecrets();
    });

    it("an unreachable server exits 1 with the error class only and says to run host again", async () => {
      reply = async () => {
        throw new TypeError(`fetch failed for ${GENERATED}`);
      };
      expect(await host()).toBe(1);
      expect(text()).toContain("TypeError");
      expect(text()).toContain("The pipeline is not connected until host runs again successfully.");
      expect(text()).not.toContain("fetch failed");
      noSecrets();
    });

    it("a missing owner password variable fails before connecting", async () => {
      expect(await run(["host", "acme", "main", "--ref", REF, "--pooler", POOLER, "--owner-password-from-env", "X"], hostDeps())).toBe(1);
      expect(lines).toEqual(["Error: environment variable X is not set"]);
      expect(connects).toHaveLength(0);
    });

    it("refuses a malformed ref or a non-pooler host before connecting", async () => {
      const cases: [string, string][] = [
        ["ABCDEFGHIJ0123456789", POOLER],
        ["abc", POOLER],
        [`${REF}x`, POOLER],
        [REF, "db.abcdefghij0123456789.supabase.co"],
        [REF, "evil.example.com"],
        [REF, "x.pooler.supabase.com.evil.example"],
      ];
      for (const [ref, pooler] of cases) {
        expect(await run(hostArgs(ref, pooler), hostDeps())).toBe(1);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/^Error: --(ref|pooler) /);
      }
      expect(await run(["host", "acme", "main", "--pooler", POOLER, "--owner-password-from-env", "OWNER_PW_VAR"], hostDeps())).toBe(1);
      expect(connects).toHaveLength(0);
      expect(posts).toHaveLength(0);
    });

    it("a driver error is reported by class and code only", async () => {
      const deps = {
        ...hostDeps(),
        connectOwner: async (): Promise<Client> => {
          throw Object.assign(new Error(`password authentication failed for ${OWNER_PW}`), { code: "28P01" });
        },
      };
      expect(await run(hostArgs(), deps)).toBe(1);
      expect(lines).toEqual(["Error: Error (28P01)"]);
    });
  });

  it("unknown command prints usage and exits 1", async () => {
    expect(await run(["bogus"])).toBe(1);
    expect(text()).toMatch(/usage/i);
  });

  it("the CLI source never mentions the master key or deletes", () => {
    for (const f of ["admin.ts", "admin-commands.ts"]) {
      const src = readFileSync(join(__dirname, f), "utf8");
      expect(src).not.toContain("MONSOON_MASTER_KEY");
      expect(src).not.toMatch(/\bDELETE\b/i);
    }
  });
});
