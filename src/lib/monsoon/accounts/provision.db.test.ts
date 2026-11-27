// The wall between clients in the shared database, proved as the client login itself: two clients
// are provisioned into one real Postgres database, and each one's own login is then asked to do
// everything a bug or an injected statement could try. Runs in a database made for this file (the
// provisioning revokes PUBLIC's use of `public` there), and removes only the schemas and logins it made.
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signSession } from "../auth";
import { pipelineClientConfig, withPipelineDb } from "../db";
import { makeAccountsTestDb, makeTestDb } from "../testing/db";
import { NotConnected, requireAccount } from "./account";
import { encryptSecret } from "./crypto";
import { ProvisionError, checkWall, clientNames, provisionSharedCrm } from "./provision";
import { runSetupChecks } from "./setup-check";
import { MONSOON_TABLES_V2 } from "./setup-script";
import { clearAccountCache } from "./store";

const shared = makeTestDb("provision");
const accounts = makeAccountsTestDb();

const vocabulary = {
  stages: [
    { key: "new", ord: 0, label: "New", terminal: false },
    { key: "won", ord: 1, label: "Won", terminal: true },
  ],
  roles: [{ key: "contact", label: "Contact" }],
  owners: [{ key: "AA", name: "Ada" }],
};

describe("clientNames", () => {
  it("derives the schema and login from the customer id alone", () => {
    expect(clientNames("0B9D2A47-6a3e-4c1f-9d55-2f7a3c1e8b10")).toEqual({
      schema: "c_0b9d2a476a3e4c1f9d552f7a3c1e8b10",
      role: "monsoon_c_0b9d2a476a3e4c1f9d552f7a3c1e8b10",
    });
  });

  it("refuses anything that is not a UUID", () => {
    for (const bad of ["", "acme", "0b9d2a476a3e4c1f9d552f7a3c1e8b10", "0b9d2a47-6a3e-4c1f-9d55-2f7a3c1e8b10; DROP SCHEMA public", "public", null, 7]) {
      expect(() => clientNames(bad as string), String(bad)).toThrow("invalid customer id");
    }
  });
});

describe.skipIf(!shared.available)("the wall between clients in the shared database (real Postgres)", { timeout: 60_000 }, () => {
  const made: string[] = [];
  const newCustomer = () => {
    const id = randomUUID();
    made.push(id);
    return id;
  };
  const A = newCustomer();
  const B = newCustomer();
  const namesA = clientNames(A);
  const namesB = clientNames(B);
  let admin: Client;
  let urlA: string;
  let urlB: string;
  const open: Client[] = [];

  /** A plain connection as the client's own login: nothing is set on it by the test or the app. */
  async function login(url: string): Promise<Client> {
    const c = new Client(pipelineClientConfig(url));
    await c.connect();
    open.push(c);
    return c;
  }
  /** The SQLSTATE a statement fails with, or undefined when it runs. */
  async function code(c: Client, sql: string): Promise<string | undefined> {
    try {
      await c.query(sql);
      return undefined;
    } catch (err) {
      return (err as { code?: string }).code ?? "unknown";
    }
  }
  const DENIED = "42501";
  const NO_SUCH_TABLE = "42P01";
  const names = async (c: Client) => (await c.query("SELECT name FROM people ORDER BY name")).rows.map((r) => r.name);

  beforeAll(async () => {
    await shared.reset();
    admin = await shared.connect();
    // As in a fresh database: everyone may use `public`, and here even read a table in it.
    await admin.query("GRANT USAGE ON SCHEMA public TO PUBLIC");
    await admin.query("GRANT SELECT ON public.people TO PUBLIC");
    await admin.query("INSERT INTO public.people (name, name_key, source) VALUES ('Public Pat', 'public pat', 'test')");
    vi.stubEnv("MONSOON_SHARED_DB_ADMIN_URL", shared.url());
    urlA = (await provisionSharedCrm({ customerId: A, vocabulary })).dbUrl;
    urlB = (await provisionSharedCrm({ customerId: B, vocabulary })).dbUrl;
    const a = await login(urlA);
    await a.query("INSERT INTO people (name, name_key, source) VALUES ('Ada of A', 'ada of a', 'test')");
    const b = await login(urlB);
    await b.query("INSERT INTO people (name, name_key, source) VALUES ('Bob of B', 'bob of b', 'test')");
  });
  beforeEach(() => {
    vi.stubEnv("MONSOON_SHARED_DB_ADMIN_URL", shared.url());
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await Promise.all(open.map((c) => c.end().catch(() => undefined)));
    if (!admin) return;
    // Only what this file made: each id in `made` was generated here.
    for (const id of made) {
      const n = clientNames(id);
      await admin.query(`DROP SCHEMA IF EXISTS ${n.schema} CASCADE`);
      const found = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [n.role]);
      if (found.rowCount) {
        await admin.query(`DROP OWNED BY ${n.role}`);
        await admin.query(`DROP ROLE ${n.role}`);
      }
    }
    await admin.end();
  });

  it("returns the schema and an address for the client's own login, with a fresh 32-byte password", async () => {
    const again = newCustomer();
    const r = await provisionSharedCrm({ customerId: again, vocabulary });
    expect(r.schema).toBe(clientNames(again).schema);
    const u = new URL(r.dbUrl);
    expect(u.username).toBe(clientNames(again).role);
    expect(u.password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.password).not.toBe(new URL(shared.url()).password);
    expect(u.pathname).toBe(new URL(shared.url()).pathname);
  });

  it("the login finds its own tables with nothing set on the connection, and each client sees only its own rows", async () => {
    const a = await login(urlA);
    const b = await login(urlB);
    expect((await a.query("SELECT current_user::text AS me, current_schemas(false)::text[] AS path")).rows[0]).toEqual({
      me: namesA.role,
      path: [namesA.schema],
    });
    expect(await names(a)).toEqual(["Ada of A"]);
    expect(await names(b)).toEqual(["Bob of B"]);
    expect((await a.query("SELECT key FROM stages ORDER BY ord")).rows.map((r) => r.key)).toEqual(["new", "won"]);
    expect((await a.query("SELECT key FROM owners")).rows).toEqual([{ key: "AA" }]);
  });

  it("the login reads and writes its own tables as far as the grants allow: it can add and change, never remove", async () => {
    const a = await login(urlA);
    for (const t of MONSOON_TABLES_V2) expect(await code(a, `SELECT 1 FROM ${t} LIMIT 1`), t).toBeUndefined();
    const org = (await a.query("INSERT INTO orgs (name, name_key, source) VALUES ('Acme', 'acme', 'test') RETURNING id")).rows[0].id;
    const person = (await a.query("INSERT INTO people (name, name_key, source) VALUES ('Carl', 'carl', 'test') RETURNING id")).rows[0].id;
    const member = (
      await a.query("INSERT INTO members (person_id, role, stage, owner, source) VALUES ($1, 'contact', 'new', 'AA', 'test') RETURNING id", [person])
    ).rows[0].id;
    await a.query("INSERT INTO touches (member_id, kind, by_whom, summary) VALUES ($1, 'note', 'AA', 'hello')", [member]);
    expect((await a.query("UPDATE people SET title = 'Dr' WHERE id = $1", [person])).rowCount).toBe(1);
    // A stage change leaves its footprint through the trigger, inside this client's schema.
    await a.query("UPDATE members SET stage = 'won' WHERE id = $1", [member]);
    expect((await a.query("SELECT count(*)::int AS n FROM touches WHERE member_id = $1 AND kind = 'stage'", [member])).rows[0].n).toBe(1);
    expect((await a.query("UPDATE orgs SET country = 'NL' WHERE id = $1", [org])).rowCount).toBe(1);
    for (const t of MONSOON_TABLES_V2) {
      expect(await code(a, `DELETE FROM ${t}`), t).toBe(DENIED);
      expect(await code(a, `TRUNCATE ${t} CASCADE`), t).toBe(DENIED);
    }
    for (const t of ["stages", "roles", "tags"]) expect(await code(a, `UPDATE ${t} SET key = key`), t).toBe(DENIED);
    // None of it reached the other client.
    expect(await names(await login(urlB))).toEqual(["Bob of B"]);
  });

  it("another client's tables, named in full, are refused with a permission error: every table, every kind of statement, both ways", async () => {
    for (const [url, other] of [
      [urlA, namesB],
      [urlB, namesA],
    ] as const) {
      const c = await login(url);
      for (const t of MONSOON_TABLES_V2) expect(await code(c, `SELECT * FROM ${other.schema}.${t}`), t).toBe(DENIED);
      expect(await code(c, `INSERT INTO ${other.schema}.todos (title, source) VALUES ('x', 'app')`)).toBe(DENIED);
      expect(await code(c, `UPDATE ${other.schema}.todos SET title = 'x'`)).toBe(DENIED);
      expect(await code(c, `SELECT count(*) FROM ${other.schema}.people`)).toBe(DENIED);
      expect(await code(c, `INSERT INTO ${other.schema}.people (name, name_key, source) VALUES ('x', 'x', 'x')`)).toBe(DENIED);
      expect(await code(c, `UPDATE ${other.schema}.people SET name = 'x'`)).toBe(DENIED);
      expect(await code(c, `DELETE FROM ${other.schema}.people`)).toBe(DENIED);
      expect(await code(c, `TRUNCATE ${other.schema}.people CASCADE`)).toBe(DENIED);
      expect(await code(c, `SELECT ${other.schema}.set_updated_at()`)).toBe(DENIED);
      expect(await code(c, `SELECT * FROM people p JOIN ${other.schema}.people q ON true`)).toBe(DENIED);
      expect(await code(c, `COPY ${other.schema}.people TO STDOUT`)).toBe(DENIED);
      expect(await code(c, `CREATE VIEW peek AS SELECT * FROM ${other.schema}.people`)).toBe(DENIED);
    }
    expect((await admin.query(`SELECT name FROM ${namesB.schema}.people`)).rows).toEqual([{ name: "Bob of B" }]);
    expect((await admin.query(`SELECT name FROM ${namesA.schema}.people WHERE name = 'x'`)).rowCount).toBe(0);
  });

  it("tables in public are refused, even one that was readable by everyone before", async () => {
    for (const url of [urlA, urlB]) {
      const c = await login(url);
      expect(await code(c, "SELECT * FROM public.people")).toBe(DENIED);
      expect(await code(c, "SELECT * FROM public.touches")).toBe(DENIED);
      expect(await code(c, "INSERT INTO public.people (name, name_key, source) VALUES ('x', 'x', 'x')")).toBe(DENIED);
      expect(await code(c, "SELECT public.set_updated_at()")).toBe(DENIED);
    }
    expect((await admin.query("SELECT name FROM public.people")).rows).toEqual([{ name: "Public Pat" }]);
  });

  it("changing the search path does not help", async () => {
    const a = await login(urlA);
    await a.query(`SET search_path TO ${namesB.schema}`);
    expect(await code(a, "SELECT * FROM people")).toBe(NO_SUCH_TABLE);
    await a.query("SET search_path TO public");
    expect(await code(a, "SELECT * FROM people")).toBe(NO_SUCH_TABLE);
    // With its own schema behind the other's, the name resolves to its own table only.
    await a.query(`SET search_path TO ${namesB.schema}, public, ${namesA.schema}`);
    expect(await names(a)).not.toContain("Bob of B");
    expect(await names(a)).not.toContain("Public Pat");
    expect(await names(a)).toContain("Ada of A");
    expect(await code(a, `SELECT set_config('search_path', '${namesB.schema}', false)`)).toBeUndefined();
    expect(await code(a, "SELECT * FROM people")).toBe(NO_SUCH_TABLE);
  });

  it("it cannot become another login: not the other client's, not the owner's", async () => {
    const a = await login(urlA);
    expect(await code(a, `SET ROLE ${namesB.role}`)).toBe(DENIED);
    expect(await code(a, "SET ROLE postgres")).toBe(DENIED);
    expect(await code(a, `SET SESSION AUTHORIZATION ${namesB.role}`)).toBe(DENIED);
    expect(await code(a, `SET LOCAL ROLE ${namesB.role}`)).toBe(DENIED);
    expect(await code(a, `GRANT ${namesB.role} TO ${namesA.role}`)).toBe(DENIED);
    expect(await code(a, `ALTER ROLE ${namesB.role} PASSWORD 'known-password-0123456789'`)).toBe(DENIED);
    expect(await code(a, `ALTER ROLE ${namesA.role} SUPERUSER`)).toBe(DENIED);
    expect(await code(a, `ALTER ROLE ${namesA.role} BYPASSRLS`)).toBe(DENIED);
    expect(await code(a, "SELECT rolpassword FROM pg_authid")).toBe(DENIED);
    expect((await a.query("SELECT current_user::text AS me")).rows[0].me).toBe(namesA.role);
    const flags = await admin.query(
      `SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication, rolinherit,
              EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid) AS member
         FROM pg_roles r WHERE rolname = ANY($1::text[])`,
      [[namesA.role, namesB.role]],
    );
    expect(flags.rowCount).toBe(2);
    for (const row of flags.rows) expect(Object.values(row)).toEqual([false, false, false, false, false, false, false]);
  });

  it("it can create or change nothing: not in its own schema, not anywhere else", async () => {
    const a = await login(urlA);
    expect(await code(a, "CREATE TABLE mine (id int)")).toBe(DENIED);
    expect(await code(a, `CREATE TABLE ${namesA.schema}.mine (id int)`)).toBe(DENIED);
    expect(await code(a, `CREATE TABLE ${namesB.schema}.mine (id int)`)).toBe(DENIED);
    expect(await code(a, "CREATE TABLE public.mine (id int)")).toBe(DENIED);
    expect(await code(a, "CREATE SCHEMA mine")).toBe(DENIED);
    expect(await code(a, "CREATE VIEW mine AS SELECT 1")).toBe(DENIED);
    expect(await code(a, "CREATE FUNCTION mine() RETURNS int LANGUAGE sql AS 'SELECT 1'")).toBe(DENIED);
    expect(await code(a, "CREATE SEQUENCE mine")).toBe(DENIED);
    expect(await code(a, "CREATE INDEX mine ON people (title)")).toBe(DENIED);
    expect(await code(a, "ALTER TABLE people ADD COLUMN mine text")).toBe(DENIED);
    expect(await code(a, "ALTER TABLE people DISABLE ROW LEVEL SECURITY")).toBe(DENIED);
    expect(await code(a, "DROP TABLE people")).toBe(DENIED);
    expect(await code(a, `DROP SCHEMA ${namesA.schema} CASCADE`)).toBe(DENIED);
    expect(await code(a, `CREATE POLICY mine ON people FOR DELETE TO ${namesA.role} USING (true)`)).toBe(DENIED);
    expect(await code(a, "CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'")).toBe(DENIED);
    expect(await code(a, "CREATE EXTENSION dblink")).toBe(DENIED);
    expect(await code(a, `ALTER SCHEMA ${namesA.schema} OWNER TO ${namesA.role}`)).toBe(DENIED);
    // Handing its own rights on is at most a warning, and gives the other client nothing.
    await code(a, `GRANT USAGE ON SCHEMA ${namesA.schema} TO ${namesB.role}`);
    await code(a, `GRANT SELECT ON people TO ${namesB.role}`);
    await code(a, `GRANT USAGE ON SCHEMA ${namesA.schema} TO PUBLIC`);
    const b = await login(urlB);
    expect(await code(b, `SELECT * FROM ${namesA.schema}.people`)).toBe(DENIED);
    expect((await admin.query("SELECT has_schema_privilege($1, $2, 'USAGE') AS can", [namesB.role, namesA.schema])).rows[0].can).toBe(false);
  });

  it("the wall check passes for each client, as that client", async () => {
    expect(await checkWall(urlA, namesA)).toBeNull();
    expect(await checkWall(urlB, namesB)).toBeNull();
    // Asked about a schema that is not its own, the same login fails the check.
    expect(await checkWall(urlA, namesB)).not.toBeNull();
  });

  it("provisioning a second time keeps the data, gives a new password and ends the old one", async () => {
    const before = await names(await login(urlA));
    const r = await provisionSharedCrm({ customerId: A, vocabulary });
    expect(r.schema).toBe(namesA.schema);
    expect(r.dbUrl).not.toBe(urlA);
    await expect(login(urlA)).rejects.toMatchObject({ code: "28P01" });
    urlA = r.dbUrl;
    expect(await names(await login(urlA))).toEqual(before);
    expect((await (await login(urlA)).query("SELECT count(*)::int AS n FROM stages")).rows[0].n).toBe(2);
    // The other client is untouched and its address still works.
    expect(await names(await login(urlB))).toEqual(["Bob of B"]);
    expect(await code(await login(urlA), `SELECT * FROM ${namesB.schema}.people`)).toBe(DENIED);
  });

  it("waits for a pooler that still refuses the new password for a moment, then finishes", async () => {
    // Supabase's pooler accepts a changed password a few seconds late: the first sign-ins are refused.
    const before = await names(await login(urlA));
    let calls = 0;
    const checks: typeof runSetupChecks = async (input) => {
      calls += 1;
      return calls <= 2 ? { ok: false, failure: "connect" } : runSetupChecks(input);
    };
    const r = await provisionSharedCrm({ customerId: A, vocabulary }, { runChecks: checks, settleWaitMs: 1 });
    expect(calls).toBe(3);
    urlA = r.dbUrl;
    expect(await names(await login(urlA))).toEqual(before);
  });

  it("gives up after a bounded number of refused sign-ins, and any other failed check is not retried", async () => {
    let calls = 0;
    const never: typeof runSetupChecks = async () => {
      calls += 1;
      return { ok: false, failure: "connect" };
    };
    const err = await provisionSharedCrm({ customerId: newCustomer(), vocabulary }, { runChecks: never, settleWaitMs: 1 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as ProvisionError).failure).toBe("connect");
    expect(calls).toBe(8);

    calls = 0;
    const tables: typeof runSetupChecks = async () => {
      calls += 1;
      return { ok: false, failure: "tables" };
    };
    const other = await provisionSharedCrm({ customerId: newCustomer(), vocabulary }, { runChecks: tables, settleWaitMs: 1 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect((other as ProvisionError).failure).toBe("tables");
    expect(calls).toBe(1);
  });

  it("two clients provisioned at the same moment both come out whole", async () => {
    const [c, d] = [newCustomer(), newCustomer()];
    const [rc, rd] = await Promise.all([
      provisionSharedCrm({ customerId: c, vocabulary }),
      provisionSharedCrm({ customerId: d, vocabulary }),
    ]);
    expect(await checkWall(rc.dbUrl, clientNames(c))).toBeNull();
    expect(await checkWall(rd.dbUrl, clientNames(d))).toBeNull();
    expect(await code(await login(rc.dbUrl), `SELECT * FROM ${clientNames(d).schema}.people`)).toBe(DENIED);
  });

  it("refuses to finish when the new login can use any other schema, and says only which check failed", async () => {
    const leak = `leak_${randomBytes(6).toString("hex")}`;
    await admin.query(`CREATE SCHEMA ${leak}`);
    await admin.query(`GRANT USAGE ON SCHEMA ${leak} TO PUBLIC`);
    try {
      const err = await provisionSharedCrm({ customerId: newCustomer(), vocabulary }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ProvisionError);
      expect((err as ProvisionError).failure).toBe("other_schemas");
      expect(String(err)).not.toContain(new URL(shared.url()).password + "@");
      expect(String(err)).not.toContain("127.0.0.1");
      expect(String((err as Error).stack)).not.toContain("postgresql://");
    } finally {
      await admin.query(`DROP SCHEMA ${leak}`);
    }
  });

  it("the search path set on the connection finds the tables even when the login's own setting is lost", async () => {
    await admin.query(`ALTER ROLE ${namesA.role} RESET search_path`);
    try {
      expect(await code(await login(urlA), "SELECT * FROM people")).toBe(NO_SUCH_TABLE);
      expect(await checkWall(urlA, namesA)).toBe("search_path");
      const seen = await withPipelineDb(urlA, (db) => names(db), namesA.schema);
      expect(seen).toContain("Ada of A");
      // Naming the other client's schema on the connection gives nothing: the login has no rights there.
      await expect(withPipelineDb(urlA, (db) => names(db), namesB.schema)).rejects.toMatchObject({ code: NO_SUCH_TABLE });
    } finally {
      await admin.query(`ALTER ROLE ${namesA.role} SET search_path TO ${namesA.schema}`);
    }
  });

  it("does nothing without the shared database setting or with an id that is not a customer id", async () => {
    await expect(provisionSharedCrm({ customerId: "not-a-uuid", vocabulary })).rejects.toThrow("invalid customer id");
    vi.stubEnv("MONSOON_SHARED_DB_ADMIN_URL", "");
    const err = await provisionSharedCrm({ customerId: A, vocabulary }).catch((e: unknown) => e);
    expect((err as ProvisionError).failure).toBe("not_configured");
    vi.stubEnv("MONSOON_SHARED_DB_ADMIN_URL", "postgresql://postgres.abcdefghij0123456789:pw@evil.example.com:5432/postgres");
    const bad = await provisionSharedCrm({ customerId: A, vocabulary }).catch((e: unknown) => e);
    expect((bad as ProvisionError).failure).toBe("address");
    // Neither attempt touched the login: the address from before still works.
    expect(await names(await login(urlA))).toContain("Ada of A");
  });

  it("a name with a backslash and a quote is stored as plain text and adds nothing, even where a backslash escapes a quote", async () => {
    const dbName = new URL(shared.url()).pathname.slice(1);
    const id = newCustomer();
    const n = clientNames(id);
    const name = "\\'); CREATE TABLE pwned(x int); --";
    const label = "\\'); CREATE TABLE pwned_too(x int); --";
    // New connections to this file's own database now read a backslash and a quote as an escaped quote.
    await admin.query(`ALTER DATABASE ${dbName} SET standard_conforming_strings = off`);
    try {
      const fresh = await shared.connect();
      expect((await fresh.query("SHOW standard_conforming_strings")).rows[0].standard_conforming_strings).toBe("off");
      await fresh.end();
      await provisionSharedCrm({
        customerId: id,
        vocabulary: { ...vocabulary, roles: [{ key: "contact", label }], owners: [{ key: "PW", name }] },
      });
    } finally {
      await admin.query(`ALTER DATABASE ${dbName} RESET standard_conforming_strings`);
    }
    expect((await admin.query("SELECT relname FROM pg_class WHERE relname LIKE 'pwned%'")).rows).toEqual([]);
    const tables = await admin.query("SELECT tablename::text AS t FROM pg_tables WHERE schemaname = $1 ORDER BY 1", [n.schema]);
    expect(tables.rows.map((r) => r.t)).toEqual([...MONSOON_TABLES_V2].sort());
    expect((await admin.query(`SELECT key, display_name FROM ${n.schema}.owners`)).rows).toEqual([{ key: "PW", display_name: name }]);
    expect((await admin.query(`SELECT key, label FROM ${n.schema}.roles`)).rows).toEqual([{ key: "contact", label }]);
  });

  it("no name or label from the vocabulary is ever part of the SQL text sent to the shared database", async () => {
    const id = newCustomer();
    const texts: string[] = [];
    const real = Client.prototype.query;
    const spy = vi.spyOn(Client.prototype, "query").mockImplementation(function (this: Client, ...args: unknown[]) {
      const first = args[0] as string | { text?: string };
      texts.push(typeof first === "string" ? first : String(first?.text ?? ""));
      return (real as (...a: unknown[]) => unknown).apply(this, args);
    } as never);
    try {
      await provisionSharedCrm({
        customerId: id,
        vocabulary: {
          stages: [{ key: "zzstagekey", ord: 0, label: "Zzstagelabel", terminal: false }],
          roles: [{ key: "zzrolekey", label: "Zzrolelabel" }],
          owners: [{ key: "ZZ", name: "Zzownername" }],
        },
      });
    } finally {
      spy.mockRestore();
    }
    expect(texts.length).toBeGreaterThan(5);
    for (const t of texts) expect(t).not.toMatch(/zzstagekey|Zzstagelabel|zzrolekey|Zzrolelabel|Zzownername/);
    const n = clientNames(id);
    expect((await admin.query(`SELECT key, ord, label, terminal FROM ${n.schema}.stages`)).rows).toEqual([
      { key: "zzstagekey", ord: 0, label: "Zzstagelabel", terminal: false },
    ]);
  });

  it("the new password is never part of the SQL text: it travels as a parameter, and the login works", async () => {
    const id = newCustomer();
    const sent: { text: string; values: unknown[] }[] = [];
    const real = Client.prototype.query;
    const spy = vi.spyOn(Client.prototype, "query").mockImplementation(function (this: Client, ...args: unknown[]) {
      const first = args[0] as string | { text?: string; values?: unknown[] };
      sent.push({
        text: typeof first === "string" ? first : String(first?.text ?? ""),
        values: Array.isArray(args[1]) ? args[1] : typeof first === "object" && Array.isArray(first?.values) ? first.values : [],
      });
      return (real as (...a: unknown[]) => unknown).apply(this, args);
    } as never);
    let dbUrl: string;
    try {
      dbUrl = (await provisionSharedCrm({ customerId: id, vocabulary })).dbUrl;
    } finally {
      spy.mockRestore();
    }
    const password = decodeURIComponent(new URL(dbUrl).password);
    expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const q of sent) expect(q.text.includes(password), q.text.slice(0, 60)).toBe(false);
    // It went once, as a value, into a setting that lasts only for the transaction, and was cleared after use.
    const carried = sent.filter((q) => q.values.includes(password));
    expect(carried.map((q) => q.text)).toEqual(["SELECT set_config('monsoon.new_password', $1, true)"]);
    const at = sent.indexOf(carried[0]);
    expect(sent.slice(at + 1).map((q) => q.text)).toContain("SELECT set_config('monsoon.new_password', '', true)");
    const c = await login(dbUrl);
    expect((await c.query("SELECT current_user::text AS me, current_setting('monsoon.new_password', true) AS left_over")).rows[0]).toEqual({
      me: clientNames(id).role,
      left_over: null,
    });
    expect(await code(c, "SELECT * FROM people")).toBeUndefined();
  });

  it("builds nothing unless the connection confirms that a backslash is only a backslash", async () => {
    const id = newCustomer();
    const real = Client.prototype.query;
    const seen: string[] = [];
    const spy = vi.spyOn(Client.prototype, "query").mockImplementation(function (this: Client, ...args: unknown[]) {
      if (typeof args[0] === "string") seen.push(args[0]);
      if (args[0] === "SHOW standard_conforming_strings") return Promise.resolve({ rows: [{ standard_conforming_strings: "off" }], rowCount: 1 });
      return (real as (...a: unknown[]) => unknown).apply(this, args);
    } as never);
    let err: unknown;
    try {
      err = await provisionSharedCrm({ customerId: id, vocabulary }).catch((e: unknown) => e);
    } finally {
      spy.mockRestore();
    }
    expect(err).toBeInstanceOf(ProvisionError);
    expect((err as ProvisionError).failure).toBe("build");
    // The setting was asked for on its own, before anything else, and nothing followed the refusal.
    expect(seen).toEqual(["SET standard_conforming_strings = on", "SHOW standard_conforming_strings"]);
    expect((await admin.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [clientNames(id).schema])).rowCount).toBe(0);
  });

  describe.skipIf(!accounts.available)("through the signed-in account", () => {
    let db: Client;
    let cookie: string;
    let pipelineId: string;

    beforeAll(async () => {
      await accounts.reset();
      db = await accounts.connect();
    });
    afterAll(async () => {
      await db?.end();
    });
    beforeEach(async () => {
      vi.stubEnv("MONSOON_MASTER_KEY", randomBytes(32).toString("base64"));
      vi.stubEnv("MONSOON_ACCOUNTS_DATABASE_URL", accounts.url());
      vi.stubEnv("MONSOON_SESSION_SECRET", "s".repeat(32));
      clearAccountCache();
      await db.query("TRUNCATE activity, setup_links, pipelines, people, customers, sign_in_attempts, signups CASCADE");
      await db.query("INSERT INTO customers (id, code, name) VALUES ($1, 'client-a', 'Client A')", [A]);
      const person = (await db.query("INSERT INTO people (customer_id, display_name, owner_key) VALUES ($1, 'Ada', 'AA') RETURNING id", [A])).rows[0].id;
      pipelineId = (
        await db.query(
          "INSERT INTO pipelines (customer_id, key, label, default_role, shared_schema) VALUES ($1, 'pipeline', 'Pipeline', 'contact', $2) RETURNING id",
          [A, namesA.schema],
        )
      ).rows[0].id;
      await db.query("UPDATE pipelines SET db_url_enc = $1 WHERE id = $2", [encryptSecret(urlA, A, `pipeline:${pipelineId}`), pipelineId]);
      cookie = `monsoon_session=${signSession({ customerId: A, personId: person, sessionNo: 1 })}`;
    });

    async function account() {
      clearAccountCache();
      const r = await requireAccount(new Request("http://localhost/api/monsoon/x", { headers: { cookie } }));
      if (!r.ok) throw new Error(`refused ${r.response.status}`);
      return r.account;
    }

    it("withDb reaches the client's own schema, with the search path set on the connection", async () => {
      const a = await account();
      const seen = await a.withDb("pipeline", async (c) => ({
        names: await names(c),
        path: (await c.query("SELECT current_schemas(false)::text[] AS p")).rows[0].p,
        other: await code(c, `SELECT * FROM ${namesB.schema}.people`),
      }));
      expect(seen.names).toContain("Ada of A");
      expect(seen.names).not.toContain("Bob of B");
      expect(seen.path).toEqual([namesA.schema]);
      expect(seen.other).toBe(DENIED);
    });

    it("an accounts row that names another client's schema, or a login that is not this customer's, is refused before connecting", async () => {
      const fn = vi.fn();
      await db.query("UPDATE pipelines SET shared_schema = $1 WHERE id = $2", [namesB.schema, pipelineId]);
      await expect((await account()).withDb("pipeline", fn)).rejects.toBeInstanceOf(NotConnected);
      await db.query("UPDATE pipelines SET shared_schema = 'public' WHERE id = $1", [pipelineId]);
      await expect((await account()).withDb("pipeline", fn)).rejects.toBeInstanceOf(NotConnected);
      // The right schema with the other client's address stored under this customer.
      await db.query("UPDATE pipelines SET shared_schema = $1, db_url_enc = $2 WHERE id = $3", [
        namesA.schema,
        encryptSecret(urlB, A, `pipeline:${pipelineId}`),
        pipelineId,
      ]);
      await expect((await account()).withDb("pipeline", fn)).rejects.toBeInstanceOf(NotConnected);
      expect(fn).not.toHaveBeenCalled();
    });
  });
});
