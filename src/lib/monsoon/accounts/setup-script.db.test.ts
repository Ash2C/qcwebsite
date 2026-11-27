import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Proposal } from "../ask/proposal";
import { addNote, moveStage } from "../ask/actions";
import { applyDetails } from "../details";
import { capture } from "../capture";
import { ensureOwner } from "../owners";
import { applyResearch } from "../research-apply";
import { makeTestDb, testDb, testRoleName } from "../testing/db";
import { CRM_LATEST_VERSION, CRM_SCHEMA_SQL } from "./crm-schema.generated";
import { MONSOON_TABLES_V2, generateSetupScript, loginAndPoliciesScript, todoGrantStatements } from "./setup-script";

const PLACEHOLDER = "REPLACE-WITH-A-PASSWORD-OF-AT-LEAST-16-CHARACTERS";
const CUSTOMER = "c0000000-0000-4000-8000-00000000000a";
const norm = (s: string) => s.replace(/\r\n/g, "\n");

const vocabulary = {
  stages: [
    { key: "uncontacted", ord: 0, label: "Uncontacted", terminal: false },
    { key: "contacted", ord: 1, label: "Contacted", terminal: false },
    { key: "client", ord: 2, label: "Client", terminal: true },
  ],
  roles: [
    { key: "investor", label: "Investor" },
    { key: "desk", label: "O'Brien Desk" },
  ],
  owners: [{ key: "VF", name: "Pat O'Brien" }],
};

type Details = Extract<Proposal, { kind: "update_details" }>;
type Research = Extract<Proposal, { kind: "apply_research" }>;

describe("generated schema", () => {
  const dir = join(__dirname, "..", "testing");
  const files = readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();

  it("equals every testing/NNNN_*.sql joined in order", () => {
    const joined = files.map((f) => norm(readFileSync(join(dir, f), "utf8")).replace(/\n+$/, "")).join("\n\n") + "\n";
    expect(norm(CRM_SCHEMA_SQL)).toBe(joined);
  });

  it("carries the latest version, 2, and both schema files", () => {
    expect(files).toEqual(["0001_init.sql", "0002_todos.sql"]);
    expect(CRM_LATEST_VERSION).toBe(2);
  });
});

describe.skipIf(!testDb.available)("Setup script and restricted login (real Postgres)", () => {
  const setupDb = makeTestDb("setup");
  const roleA = testRoleName();
  const roleB = `${testRoleName()}_b`;
  const roleOwner = `${testRoleName()}_owner`;
  let password: string;
  let admin: Client;

  const withPassword = (sql: string) => sql.replace(PLACEHOLDER, password);
  async function dropRoles() {
    for (const db of [setupDb, testDb]) {
      const c = await db.connect();
      try {
        for (const r of [roleA, roleB, roleOwner]) {
          const found = await c.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [r]);
          if (found.rowCount) {
            await c.query("ALTER SCHEMA public OWNER TO CURRENT_USER");
            await c.query(`DROP OWNED BY ${r}`);
          }
        }
      } finally {
        await c.end();
      }
    }
    const c = await setupDb.connect();
    try {
      for (const r of [roleA, roleB, roleOwner]) await c.query(`DROP ROLE IF EXISTS ${r}`);
    } finally {
      await c.end();
    }
  }
  async function asRole(db: typeof setupDb, role: string): Promise<Client> {
    const url = new URL(db.url());
    const c = new Client({ host: url.hostname, port: Number(url.port), database: url.pathname.slice(1), user: role, password });
    await c.connect();
    return c;
  }
  async function code(c: Client, sql: string): Promise<string | undefined> {
    try {
      await c.query(sql);
    } catch (err) {
      return (err as { code?: string }).code;
    }
    return undefined;
  }

  beforeEach(async () => {
    password = randomBytes(18).toString("base64url");
    await setupDb.reset();
    await testDb.reset();
    await dropRoles();
    // The setup script builds the schema itself, so start the setup database empty.
    const c = await setupDb.connect();
    await c.query("DROP SCHEMA IF EXISTS public CASCADE");
    await c.query("CREATE SCHEMA public");
    await c.end();
    admin = await setupDb.connect();
  });
  afterEach(async () => {
    await admin.end();
    await dropRoles();
  });

  it("refuses the unedited script and creates nothing", async () => {
    const script = generateSetupScript({ ...vocabulary, roleName: roleA });
    await expect(admin.query(script)).rejects.toThrow(/Set your own password/);
    await admin.query("ROLLBACK").catch(() => undefined);
    expect((await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [roleA])).rowCount).toBe(0);
    expect((await admin.query("SELECT to_regclass('public.orgs') AS t")).rows[0].t).toBeNull();
  });

  it("runs with a password, is re-runnable, and round-trips vocabulary", async () => {
    const script = withPassword(generateSetupScript({ ...vocabulary, roleName: roleA }));
    await admin.query(script);
    await admin.query(script);
    expect((await admin.query("SELECT label FROM roles WHERE key = 'desk'")).rows[0].label).toBe("O'Brien Desk");
    expect((await admin.query("SELECT display_name FROM owners WHERE key = 'VF'")).rows[0].display_name).toBe("Pat O'Brien");
    expect((await admin.query("SELECT count(*)::int AS n FROM stages")).rows[0].n).toBe(3);
    expect((await admin.query("SELECT version FROM schema_migrations ORDER BY version")).rows).toEqual([{ version: 1 }, { version: 2 }]);
    expect((await admin.query("SELECT to_regclass('todos') AS t")).rows[0].t).toBe("todos");
    const role = (
      await admin.query(
        "SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolinherit FROM pg_roles WHERE rolname = $1",
        [roleA],
      )
    ).rows[0];
    expect(role).toEqual({ rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false, rolinherit: false });
    await (await asRole(setupDb, roleA)).end();
  });

  it("lets the restricted login do the app's work", async () => {
    await admin.query(withPassword(generateSetupScript({ ...vocabulary, roleName: roleA })));
    const c = await asRole(setupDb, roleA);
    try {
      await ensureOwner(c, "AB", "Alex B");
      const cap = await capture(
        c,
        { captureId: randomUUID(), name: "Jane Tan", role: "investor", org: "Northwind Capital", newOrg: true, email: "jane@nw.example" },
        "VF",
      );
      expect(["added", "filed"]).toContain(cap.outcome);
      const member = (await c.query("SELECT id, stage FROM members")).rows[0];
      const person = (await c.query("SELECT id, org_id FROM people WHERE name = 'Jane Tan'")).rows[0];
      expect((await addNote(c, member.id, "Called back", "VF")).status).toBe("added");

      expect((await moveStage(c, member.id, member.stage, "contacted", "VF")).status).toBe("moved");
      expect((await c.query("SELECT by_whom FROM touches WHERE kind = 'stage'")).rows).toEqual([{ by_whom: "VF" }]);

      const details = (target: Details["target"], changes: Details["changes"]): Details => ({
        kind: "update_details",
        customer: CUSTOMER,
        estate: "zeroone",
        target,
        targetName: "x",
        company: null,
        changes,
        logMemberId: member.id,
        addsToPipeline: null,
        expires: 0,
      });
      const p = await applyDetails(c, details({ type: "person", id: person.id }, [{ field: "title", from: null, to: "Director" }]), "VF");
      expect(p.written).toHaveLength(1);
      // A company edit is logged on the company's own member, so the company needs one.
      await admin.query("INSERT INTO members (org_id, role, stage, owner, source) VALUES ($1, 'investor', 'contacted', 'VF', 'test')", [person.org_id]);
      const o = await applyDetails(
        c,
        details({ type: "company", id: person.org_id }, [
          { field: "website", from: null, to: "https://nw.example" },
          { field: "country", from: null, to: "UK" },
        ]),
        "VF",
      );
      expect(o.written).toHaveLength(2);
      expect((await c.query("SELECT website, country FROM orgs WHERE id = $1", [person.org_id])).rows[0]).toEqual({
        website: "https://nw.example",
        country: "UK",
      });

      const research: Research = {
        kind: "apply_research",
        customer: CUSTOMER,
        estate: "zeroone",
        person: { id: person.id, name: "Jane Tan" },
        company: { id: person.org_id, name: "Northwind Capital" },
        identity: "Same person.",
        findings: [
          { id: "f1", target: "person", field: "linkedin", from: null, to: "https://linkedin.com/in/jane", source: "https://example.com/a" },
          { id: "f2", target: "company", field: "website", from: "https://nw.example", to: "https://northwind.example", source: "https://example.com/b" },
        ],
        summarySources: [],
        logMemberId: member.id,
        addsToPipeline: null,
        expires: 0,
      };
      expect((await applyResearch(c, research, ["f1", "f2"], "", "VF")).status).toBe("saved");
      expect((await c.query("SELECT website FROM orgs WHERE id = $1", [person.org_id])).rows[0].website).toBe("https://northwind.example");
    } finally {
      await c.end();
    }
  });

  it("is denied destructive and out-of-scope statements", async () => {
    await admin.query(withPassword(generateSetupScript({ ...vocabulary, roleName: roleA })));
    await admin.query("INSERT INTO orgs (name, name_key, source) VALUES ('A', 'a', 't')");
    const c = await asRole(setupDb, roleA);
    try {
      expect(await code(c, "DELETE FROM touches")).toBe("42501");
      expect(await code(c, "TRUNCATE touches")).toBe("42501");
      expect(await code(c, "DELETE FROM orgs")).toBe("42501");
      expect(await code(c, "ALTER TABLE people ADD COLUMN x int")).toBeDefined();
      expect(await code(c, "DROP TABLE people")).toBeDefined();
      expect(await code(c, "INSERT INTO tags (key, label) VALUES ('k', 'l')")).toBe("42501");
      expect(await code(c, "UPDATE stages SET label = 'x'")).toBe("42501");
      expect(await code(c, "INSERT INTO stages (key, ord, label) VALUES ('z', 9, 'z')")).toBe("42501");
      expect(await code(c, "CREATE TABLE evil (id int)")).toBeDefined();
    } finally {
      await c.end();
    }
  });

  it("the restricted login can add and change a to-do but not remove one", async () => {
    await admin.query(withPassword(generateSetupScript({ ...vocabulary, roleName: roleA })));
    const c = await asRole(setupDb, roleA);
    try {
      const id = (await c.query("INSERT INTO todos (title, source) VALUES ('Send deck', 'app') RETURNING id")).rows[0].id;
      expect((await c.query("UPDATE todos SET status = 'done' WHERE id = $1", [id])).rowCount).toBe(1);
      expect((await c.query("SELECT status FROM todos WHERE id = $1", [id])).rows).toEqual([{ status: "done" }]);
      expect(await code(c, "DELETE FROM todos")).toBe("42501");
      expect(await code(c, "TRUNCATE todos")).toBe("42501");
    } finally {
      await c.end();
    }
  });

  it("a direct write to members.next_action by the restricted login makes a to-do, through row security", async () => {
    await admin.query(withPassword(generateSetupScript({ ...vocabulary, roleName: roleA })));
    const c = await asRole(setupDb, roleA);
    try {
      await ensureOwner(c, "AB", "Alex B");
      const person = (await c.query("INSERT INTO people (name, name_key, source) VALUES ('Jane', 'jane', 'test') RETURNING id")).rows[0].id;
      const member = (
        await c.query("INSERT INTO members (person_id, role, stage, owner, source) VALUES ($1, 'investor', 'uncontacted', 'AB', 'test') RETURNING id", [person])
      ).rows[0].id;
      await c.query("UPDATE members SET next_action = 'Call Jane', next_action_date = '2026-12-01' WHERE id = $1", [member]);
      expect((await c.query("SELECT title, due_date::text AS due, status, source, owner FROM todos WHERE member_id = $1", [member])).rows).toEqual([
        { title: "Call Jane", due: "2026-12-01", status: "open", source: "core", owner: "AB" },
      ]);
      // Clearing it drops the to-do again, and the mirror stays empty.
      await c.query("UPDATE members SET next_action = NULL, next_action_date = NULL WHERE id = $1", [member]);
      expect((await c.query("SELECT status FROM todos WHERE member_id = $1", [member])).rows).toEqual([{ status: "dropped" }]);
      expect((await c.query("SELECT next_action FROM members WHERE id = $1", [member])).rows).toEqual([{ next_action: null }]);
    } finally {
      await c.end();
    }
  });

  it("todoGrantStatements gives an existing login its to-do rights, and is safe to repeat", async () => {
    await admin.query(withPassword(generateSetupScript({ ...vocabulary, roleName: roleA })));
    await admin.query(`REVOKE ALL ON todos FROM ${roleA}`);
    await admin.query(`DROP POLICY ${roleA}_select ON todos`);
    await admin.query(`DROP POLICY ${roleA}_insert ON todos`);
    await admin.query(`DROP POLICY ${roleA}_update ON todos`);
    const c = await asRole(setupDb, roleA);
    try {
      expect(await code(c, "SELECT 1 FROM todos")).toBe("42501");
      await admin.query(todoGrantStatements(roleA, "public"));
      await admin.query(todoGrantStatements(roleA, "public"));
      expect(await code(c, "INSERT INTO todos (title, source) VALUES ('x', 'app')")).toBeUndefined();
      expect((await c.query("SELECT count(*)::int AS n FROM todos")).rows[0].n).toBe(1);
      expect(await code(c, "DELETE FROM todos")).toBe("42501");
    } finally {
      await c.end();
    }
    expect(() => todoGrantStatements("Bad Role", "public")).toThrow("invalid role name");
    expect(() => todoGrantStatements(roleA, "pg_catalog")).toThrow("invalid schema name");
  });

  // A role shaped like Supabase's `postgres`: not a superuser, but may create roles and bypass RLS.
  async function makeOwner(db: typeof setupDb, ownTables: boolean): Promise<Client> {
    const a = await db.connect();
    try {
      const found = await a.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [roleOwner]);
      if (!found.rowCount) await a.query(`CREATE ROLE ${roleOwner} LOGIN NOSUPERUSER CREATEROLE CREATEDB BYPASSRLS REPLICATION PASSWORD '${password}'`);
      // Supabase projects ship with pgcrypto installed, so the script's IF NOT EXISTS skips it.
      await a.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
      await a.query(`ALTER SCHEMA public OWNER TO ${roleOwner}`);
      if (ownTables) {
        const t = await a.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
        for (const r of t.rows) await a.query(`ALTER TABLE public.${r.tablename} OWNER TO ${roleOwner}`);
      }
    } finally {
      await a.end();
    }
    return asRole(db, roleOwner);
  }

  it("runs, and re-runs, as a non-superuser owner like Supabase's postgres", async () => {
    const o = await makeOwner(setupDb, false);
    try {
      const script = withPassword(generateSetupScript({ ...vocabulary, roleName: roleA }));
      await o.query(script);
      await o.query(script);
      expect(await code(await asRole(setupDb, roleA), "DELETE FROM touches")).toBe("42501");
    } finally {
      await o.end();
    }
  });

  it("loginAndPoliciesScript runs, and re-runs, as a non-superuser owner", async () => {
    const o = await makeOwner(testDb, true);
    try {
      const script = withPassword(loginAndPoliciesScript(roleB));
      await o.query(script);
      await o.query(script);
      const c = await asRole(testDb, roleB);
      try {
        expect(await code(c, "DELETE FROM touches")).toBe("42501");
      } finally {
        await c.end();
      }
    } finally {
      await o.end();
    }
  });

  describe("public API roles", () => {
    const PUBLIC_ROLES = ["anon", "authenticated"];
    const ALL_PRIVS = "SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER";
    async function ensurePublicRoles(c: Client) {
      for (const r of PUBLIC_ROLES) {
        try {
          await c.query(`DO $$ BEGIN CREATE ROLE ${r} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
        } catch (err) {
          if ((err as { code?: string }).code !== "23505") throw err;
        }
      }
    }
    async function grantedTables(c: Client): Promise<string[]> {
      const r = await c.query(
        `SELECT r.role || ':' || t.name AS g
           FROM unnest($1::text[]) AS r(role), unnest($2::text[]) AS t(name)
          WHERE has_table_privilege(r.role, 'public.' || t.name, $3)`,
        [PUBLIC_ROLES, [...MONSOON_TABLES_V2], ALL_PRIVS],
      );
      return r.rows.map((x) => x.g);
    }

    it("the setup script revokes everything anon and authenticated were granted on Monsoon tables", async () => {
      await ensurePublicRoles(admin);
      const script = withPassword(generateSetupScript({ ...vocabulary, roleName: roleA }));
      await admin.query(script);
      await admin.query("GRANT ALL ON touches, orgs, people TO anon");
      await admin.query("GRANT TRUNCATE, SELECT ON members, captures TO authenticated");
      expect((await grantedTables(admin)).length).toBeGreaterThan(0);
      await admin.query(script);
      expect(await grantedTables(admin)).toEqual([]);
    });

    it("loginAndPoliciesScript does the same on an existing database, run by a non-superuser owner", async () => {
      const a = await testDb.connect();
      try {
        await ensurePublicRoles(a);
        await a.query("GRANT ALL ON touches, stages TO anon, authenticated");
        expect((await grantedTables(a)).length).toBeGreaterThan(0);
      } finally {
        await a.end();
      }
      const o = await makeOwner(testDb, true);
      try {
        await o.query("GRANT ALL ON orgs TO anon");
        await o.query(withPassword(loginAndPoliciesScript(roleB)));
        expect(await grantedTables(o)).toEqual([]);
      } finally {
        await o.end();
      }
    });
  });

  it("refuses a null password", async () => {
    const script = generateSetupScript({ ...vocabulary, roleName: roleA }).replace(`'${PLACEHOLDER}'`, "NULL");
    await expect(admin.query(script)).rejects.toThrow(/Set your own password/);
  });

  it("a script with a password runs unedited and the login signs in with it", async () => {
    const script = generateSetupScript({ ...vocabulary, roleName: roleA, password });
    expect(script).not.toContain(PLACEHOLDER);
    await admin.query(script);
    expect((await admin.query("SELECT count(*)::int AS n FROM stages")).rows[0].n).toBe(3);
    await (await asRole(setupDb, roleA)).end();
  });

  it("a password under 16 characters is refused", () => {
    expect(() => generateSetupScript({ ...vocabulary, roleName: roleA, password: "x".repeat(15) })).toThrow("invalid password");
    expect(() => generateSetupScript({ ...vocabulary, roleName: roleA, password: "" })).toThrow("invalid password");
  });

  it("a password containing $ is refused, since it sits inside a DO $$ block", () => {
    for (const pw of ["abcdefgh$$ijklmnop", "$".repeat(20), "abcdefghijklmnop$"]) {
      expect(() => generateSetupScript({ ...vocabulary, roleName: roleA, password: pw })).toThrow("invalid password");
    }
  });

  it("refuses a pre-existing login that is a member of another role, and changes nothing", async () => {
    await admin.query(`CREATE ROLE ${roleA} LOGIN PASSWORD 'old-password-123456'`);
    await admin.query(`GRANT pg_read_all_data TO ${roleA}`);
    await expect(admin.query(withPassword(generateSetupScript({ ...vocabulary, roleName: roleA })))).rejects.toThrow(/extra access/);
    await admin.query("ROLLBACK").catch(() => undefined);
    expect((await admin.query("SELECT to_regclass('public.orgs') AS t")).rows[0].t).toBeNull();
  });

  it("refuses a pre-existing login with extra attributes", async () => {
    await admin.query(`CREATE ROLE ${roleA} LOGIN REPLICATION NOINHERIT PASSWORD 'old-password-123456'`);
    await expect(admin.query(withPassword(generateSetupScript({ ...vocabulary, roleName: roleA })))).rejects.toThrow(/extra access/);
  });

  it("a re-run removes a stale extra grant", async () => {
    const script = withPassword(generateSetupScript({ ...vocabulary, roleName: roleA }));
    await admin.query(script);
    await admin.query(`GRANT DELETE ON touches TO ${roleA}`);
    await admin.query(script);
    const c = await asRole(setupDb, roleA);
    try {
      expect(await code(c, "DELETE FROM touches")).toBe("42501");
    } finally {
      await c.end();
    }
  });

  it("loginAndPoliciesScript gives the same privileges on a database built by reset()", async () => {
    await admin.query(withPassword(generateSetupScript({ ...vocabulary, roleName: roleA })));
    const other = await testDb.connect();
    try {
      await other.query(withPassword(loginAndPoliciesScript(roleB)));
      const privs = async (db: Client, role: string) =>
        (
          await db.query(
            `SELECT table_name, privilege_type FROM information_schema.role_table_grants
              WHERE grantee = $1 AND table_schema = 'public' ORDER BY 1, 2`,
            [role],
          )
        ).rows;
      const pols = async (db: Client, role: string) =>
        (
          await db.query(
            "SELECT tablename, cmd, qual, with_check FROM pg_policies WHERE $1 = ANY(roles::text[]) ORDER BY 1, 2",
            [role],
          )
        ).rows;
      expect(await privs(other, roleB)).toEqual(await privs(admin, roleA));
      expect(await pols(other, roleB)).toEqual(await pols(admin, roleA));
      expect((await privs(other, roleB)).length).toBe(12 + 7 + 5);
      const c = await asRole(testDb, roleB);
      try {
        expect(await code(c, "DELETE FROM touches")).toBe("42501");
        expect((await c.query("SELECT count(*)::int AS n FROM stages")).rows[0].n).toBe(5);
      } finally {
        await c.end();
      }
    } finally {
      await other.end();
    }
  });
});
