import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeAccountsTestDb } from "../testing/db";

const db = makeAccountsTestDb();
const TABLES = [
  "accounts_migrations", "customers", "people", "pipelines", "setup_links", "sign_in_attempts", "activity",
  "person_work", "person_notes", "signups", "trial_uses", "trial_key_health",
];

describe.skipIf(!db.available)("accounts schema", () => {
  let client: Client;
  beforeAll(async () => {
    await db.reset();
    client = await db.connect();
  });
  afterAll(async () => {
    await client?.end();
  });
  beforeEach(async () => {
    await client.query("TRUNCATE activity, setup_links, pipelines, people, customers, sign_in_attempts CASCADE");
  });

  async function customer(code = "acme-co"): Promise<string> {
    const r = await client.query("INSERT INTO customers (code, name) VALUES ($1, 'Acme') RETURNING id", [code]);
    return r.rows[0].id;
  }

  it("creates all twelve tables and records migrations 1 to 7", async () => {
    const r = await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
    expect(r.rows.map((x) => x.tablename).sort()).toEqual([...TABLES].sort());
    const m = await client.query("SELECT version FROM accounts_migrations");
    expect(m.rows.map((x) => x.version).sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("applies defaults to customers", async () => {
    const id = await customer();
    const r = await client.query("SELECT status, model, claude_key_enc FROM customers WHERE id = $1", [id]);
    expect(r.rows[0]).toEqual({ status: "active", model: "claude-haiku-5-5", claude_key_enc: null });
  });

  it("rejects a duplicate or malformed customer code", async () => {
    await customer("acme-co");
    await expect(customer("acme-co")).rejects.toMatchObject({ code: "23505" });
    await expect(customer("AB")).rejects.toMatchObject({ code: "23514" });
    await expect(customer("Has Space")).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects a bad owner_key and a duplicate owner_key per customer", async () => {
    const id = await customer();
    const ins = (k: string) =>
      client.query("INSERT INTO people (customer_id, display_name, owner_key, passcode_hash) VALUES ($1,'P',$2,'h')", [id, k]);
    await expect(ins("vf")).rejects.toMatchObject({ code: "23514" });
    await expect(ins("V")).rejects.toMatchObject({ code: "23514" });
    await ins("VF");
    await expect(ins("VF")).rejects.toMatchObject({ code: "23505" });
    const r = await client.query("SELECT session_no, status FROM people");
    expect(r.rows[0]).toEqual({ session_no: 1, status: "active" });
  });

  it("enforces pipeline keys and uniqueness", async () => {
    const id = await customer();
    const ins = (k: string) =>
      client.query("INSERT INTO pipelines (customer_id, key, label, default_role, position) VALUES ($1,$2,'L','investor',0)", [id, k]);
    await expect(ins("X")).rejects.toMatchObject({ code: "23514" });
    await ins("main");
    await expect(ins("main")).rejects.toMatchObject({ code: "23505" });
    const r = await client.query("SELECT vocab, db_url_enc, connected_at FROM pipelines");
    expect(r.rows[0]).toEqual({ vocab: {}, db_url_enc: null, connected_at: null });
  });

  it("enforces setup link purpose, unique token and foreign keys", async () => {
    const id = await customer();
    const ins = (hash: string, purpose: string, cust = id) =>
      client.query(
        "INSERT INTO setup_links (customer_id, token_hash, purpose, expires_at) VALUES ($1,$2,$3, now() + interval '7 days')",
        [cust, hash, purpose],
      );
    await expect(ins("t1", "other")).rejects.toMatchObject({ code: "23514" });
    await ins("t1", "connect");
    await expect(ins("t1", "replace")).rejects.toMatchObject({ code: "23505" });
    await expect(ins("t2", "connect", "00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({ code: "23503" });
    const r = await client.query("SELECT attempts, used_at, pipeline_id FROM setup_links");
    expect(r.rows[0]).toEqual({ attempts: 0, used_at: null, pipeline_id: null });
  });

  it("restricts activity actions", async () => {
    const id = await customer();
    const ins = (a: string) => client.query("INSERT INTO activity (customer_id, action) VALUES ($1,$2)", [id, a]);
    await expect(ins("delete")).rejects.toMatchObject({ code: "23514" });
    for (const a of ["sign_in", "capture", "batch_save", "tidy", "ask", "act_note", "act_stage", "act_details", "act_research", "research", "setup", "replace"]) {
      await ins(a);
    }
  });

  it("records sign-in attempts with indexes", async () => {
    await client.query("INSERT INTO sign_in_attempts (code, address_hash, ok) VALUES ('acme-co','a',false)");
    const r = await client.query("SELECT id, at FROM sign_in_attempts");
    expect(r.rows[0].at).toBeInstanceOf(Date);
    const idx = await client.query("SELECT indexdef FROM pg_indexes WHERE tablename = 'sign_in_attempts'");
    const defs = idx.rows.map((x) => x.indexdef).join("\n");
    expect(defs).toContain("(code, at)");
    expect(defs).toContain("(code, address_hash, at)");
  });

  it("has row level security on every table and no policies", async () => {
    const r = await client.query(
      "SELECT relname, relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'",
    );
    expect(r.rows.map((x) => x.relname).sort()).toEqual([...TABLES].sort());
    for (const row of r.rows) expect(row.relrowsecurity).toBe(true);
    const p = await client.query("SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public'");
    expect(p.rows[0].n).toBe(0);
  });

  it("applies cleanly twice", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    await client.query(readFileSync(join(__dirname, "schema.sql"), "utf8"));
    const m = await client.query("SELECT count(*)::int AS n FROM accounts_migrations");
    expect(m.rows[0].n).toBe(7);
  });

  it("version 4: people gain phone and email, and the two page tables have their columns", async () => {
    const cols = async (table: string) =>
      (
        await client.query(
          "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY column_name",
          [table],
        )
      ).rows.map((x) => `${x.column_name} ${x.data_type} ${x.is_nullable}`);
    const people = await cols("people");
    expect(people).toContain("phone text YES");
    expect(people).toContain("email text YES");
    expect(await cols("person_work")).toEqual([
      "company text YES",
      "person_id uuid NO",
      "pipeline_id uuid NO",
      "role_objectives text YES",
      "updated_at timestamp with time zone NO",
      "website text YES",
    ]);
    expect(await cols("person_notes")).toEqual([
      "body text NO",
      "created_at timestamp with time zone NO",
      "id uuid NO",
      "person_id uuid NO",
      "pipeline_id uuid NO",
    ]);
    const idx = await client.query("SELECT indexdef FROM pg_indexes WHERE tablename = 'person_notes'");
    expect(idx.rows.map((x) => x.indexdef).join("\n")).toContain("(person_id, pipeline_id, created_at DESC)");
  });

  it("version 4: one work row per person and pipeline, and both tables point at real rows", async () => {
    const id = await customer();
    const person = (
      await client.query("INSERT INTO people (customer_id, display_name, owner_key, passcode_hash) VALUES ($1,'P','PP','h') RETURNING id", [id])
    ).rows[0].id;
    const pipe = (
      await client.query("INSERT INTO pipelines (customer_id, key, label, default_role, position) VALUES ($1,'main','L','investor',0) RETURNING id", [id])
    ).rows[0].id;
    const work = (p: string, l: string) => client.query("INSERT INTO person_work (person_id, pipeline_id, company) VALUES ($1,$2,'Acme')", [p, l]);
    const note = (p: string, l: string) => client.query("INSERT INTO person_notes (person_id, pipeline_id, body) VALUES ($1,$2,'n')", [p, l]);
    const NONE = "00000000-0000-0000-0000-000000000000";
    await work(person, pipe);
    await expect(work(person, pipe)).rejects.toMatchObject({ code: "23505" });
    await expect(work(NONE, pipe)).rejects.toMatchObject({ code: "23503" });
    await expect(work(person, NONE)).rejects.toMatchObject({ code: "23503" });
    await note(person, pipe);
    await note(person, pipe);
    await expect(note(NONE, pipe)).rejects.toMatchObject({ code: "23503" });
    await expect(note(person, NONE)).rejects.toMatchObject({ code: "23503" });
    const w = await client.query("SELECT website, role_objectives, updated_at FROM person_work");
    expect(w.rows[0].website).toBeNull();
    expect(w.rows[0].role_objectives).toBeNull();
    expect(w.rows[0].updated_at).toBeInstanceOf(Date);
    const n = await client.query("SELECT id, created_at FROM person_notes");
    expect(n.rows).toHaveLength(2);
    expect(n.rows[0].created_at).toBeInstanceOf(Date);
  });

  it("version 4: activity accepts the profile action", async () => {
    const id = await customer();
    await client.query("INSERT INTO activity (customer_id, action) VALUES ($1, 'profile')", [id]);
    await expect(client.query("INSERT INTO activity (customer_id, action) VALUES ($1, 'delete')", [id])).rejects.toMatchObject({ code: "23514" });
  });

  // The trap: the earlier version blocks re-add the action check on every run. Any of them with a
  // list that lacks 'profile' fails here, because the row already in the table breaks the check.
  it("version 4: the whole file applies again with a profile activity row already present", async () => {
    const id = await customer();
    await client.query("INSERT INTO activity (customer_id, action) VALUES ($1, 'profile')", [id]);
    expect((await client.query("SELECT count(*)::int AS n FROM activity WHERE action = 'profile'")).rows[0].n).toBe(1);
    const sql = readFileSync(join(__dirname, "schema.sql"), "utf8");
    await client.query(sql);
    await client.query(sql);
    expect((await client.query("SELECT count(*)::int AS n FROM activity WHERE action = 'profile'")).rows[0].n).toBe(1);
    await client.query("INSERT INTO activity (customer_id, action) VALUES ($1, 'profile')", [id]);
    // Every list in the file names it, so no block can narrow the check part-way through a run.
    const lists = sql.match(/action IN \([^)]*\)/g) ?? [];
    expect(lists.length).toBeGreaterThanOrEqual(3);
    for (const l of lists) expect(l).toContain("'profile'");
  });

  it("version 5: people gain the four Granola columns, all empty by default", async () => {
    const cols = (
      await client.query(
        "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'people' ORDER BY column_name",
      )
    ).rows.map((x) => `${x.column_name} ${x.data_type} ${x.is_nullable}`);
    expect(cols).toContain("granola_key_enc text YES");
    expect(cols).toContain("granola_status text YES");
    expect(cols).toContain("granola_checked_at timestamp with time zone YES");
    expect(cols).toContain("granola_key_set_at timestamp with time zone YES");
    const id = await customer();
    await client.query("INSERT INTO people (customer_id, display_name, owner_key, passcode_hash) VALUES ($1,'P','PP','h')", [id]);
    const r = await client.query("SELECT granola_key_enc, granola_status, granola_checked_at, granola_key_set_at FROM people");
    expect(r.rows[0]).toEqual({ granola_key_enc: null, granola_status: null, granola_checked_at: null, granola_key_set_at: null });
  });

  it("version 5: the Granola status takes only known values", async () => {
    const id = await customer();
    await client.query("INSERT INTO people (customer_id, display_name, owner_key, passcode_hash) VALUES ($1,'P','PP','h')", [id]);
    for (const s of ["ok", "key_rejected", "no_access"]) await client.query("UPDATE people SET granola_status = $1", [s]);
    await expect(client.query("UPDATE people SET granola_status = 'no_credit'")).rejects.toMatchObject({ code: "23514" });
    await expect(client.query("UPDATE people SET granola_status = 'weird'")).rejects.toMatchObject({ code: "23514" });
  });

  it("version 5: activity accepts the granola action", async () => {
    const id = await customer();
    await client.query("INSERT INTO activity (customer_id, action) VALUES ($1, 'granola')", [id]);
    await expect(client.query("INSERT INTO activity (customer_id, action) VALUES ($1, 'delete')", [id])).rejects.toMatchObject({ code: "23514" });
  });

  // The same trap as version 4: every copy of the action list must name 'granola'.
  it("version 5: the whole file applies again with a granola activity row and a Granola status present", async () => {
    const id = await customer();
    await client.query(
      "INSERT INTO people (customer_id, display_name, owner_key, passcode_hash, granola_key_enc, granola_status) VALUES ($1,'P','PP','h','k1.a.b.c','no_access')",
      [id],
    );
    await client.query("INSERT INTO activity (customer_id, action) VALUES ($1, 'granola')", [id]);
    const sql = readFileSync(join(__dirname, "schema.sql"), "utf8");
    await client.query(sql);
    await client.query(sql);
    expect((await client.query("SELECT count(*)::int AS n FROM activity WHERE action = 'granola'")).rows[0].n).toBe(1);
    expect((await client.query("SELECT granola_key_enc, granola_status FROM people")).rows[0]).toEqual({
      granola_key_enc: "k1.a.b.c",
      granola_status: "no_access",
    });
    const lists = sql.match(/action IN \([^)]*\)/g) ?? [];
    expect(lists.length).toBeGreaterThanOrEqual(4);
    for (const l of lists) expect(l).toContain("'granola'");
  });

  it("version 6: signups has its columns, defaults and checks", async () => {
    const cols = (
      await client.query(
        "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'signups' ORDER BY column_name",
      )
    ).rows.map((x) => `${x.column_name} ${x.data_type} ${x.is_nullable}`);
    expect(cols).toEqual([
      "address_hash text NO",
      "created_at timestamp with time zone NO",
      "customer_id uuid YES",
      "decided_at timestamp with time zone YES",
      "email text NO",
      "google_sub text NO",
      "id uuid NO",
      "name text NO",
      "status text NO",
    ]);
    const ins = (sub: string, status?: string) =>
      status
        ? client.query("INSERT INTO signups (google_sub, email, name, address_hash, status) VALUES ($1,'a@b.co','A','h',$2)", [sub, status])
        : client.query("INSERT INTO signups (google_sub, email, name, address_hash) VALUES ($1,'a@b.co','A','h')", [sub]);
    await ins("1001");
    await expect(ins("1001")).rejects.toMatchObject({ code: "23505" });
    await ins("1002", "approved");
    await ins("1003", "declined");
    await ins("1005", "linked");
    await expect(ins("1004", "weird")).rejects.toMatchObject({ code: "23514" });
    const r = await client.query("SELECT status, customer_id, decided_at, created_at FROM signups WHERE google_sub = '1001'");
    expect(r.rows[0]).toMatchObject({ status: "pending", customer_id: null, decided_at: null });
    expect(r.rows[0].created_at).toBeInstanceOf(Date);
    await expect(
      client.query("UPDATE signups SET customer_id = '00000000-0000-0000-0000-000000000000' WHERE google_sub = '1001'"),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("version 6: a person may have no passcode, and a Google id belongs to one person only", async () => {
    const id = await customer();
    const ins = (owner: string, sub: string | null) =>
      client.query("INSERT INTO people (customer_id, display_name, owner_key, google_sub) VALUES ($1,'P',$2,$3)", [id, owner, sub]);
    await ins("AA", "2001");
    await expect(ins("BB", "2001")).rejects.toMatchObject({ code: "23505" });
    await ins("CC", null);
    await ins("DD", null);
    const r = await client.query("SELECT passcode_hash, google_sub FROM people WHERE owner_key = 'CC'");
    expect(r.rows[0]).toEqual({ passcode_hash: null, google_sub: null });
  });

  it("version 6: a pipeline can name its schema in the shared database", async () => {
    const id = await customer();
    await client.query("INSERT INTO pipelines (customer_id, key, label, default_role) VALUES ($1,'aa','L','investor')", [id]);
    await client.query("INSERT INTO pipelines (customer_id, key, label, default_role, shared_schema) VALUES ($1,'bb','L','investor','c_abc')", [id]);
    const r = await client.query("SELECT key, shared_schema FROM pipelines ORDER BY key");
    expect(r.rows).toEqual([{ key: "aa", shared_schema: null }, { key: "bb", shared_schema: "c_abc" }]);
  });

  // The same trap as versions 4 and 5: every copy of the action list must name the new actions.
  it("version 6: activity accepts google_link and approve, and the whole file applies again with them present", async () => {
    const id = await customer();
    await client.query("INSERT INTO people (customer_id, display_name, owner_key, google_sub) VALUES ($1,'P','PP','3001')", [id]);
    await client.query("INSERT INTO signups (google_sub, email, name, address_hash, status) VALUES ('3002','a@b.co','A','h','declined')");
    await client.query("INSERT INTO activity (customer_id, action) VALUES ($1, 'google_link'), ($1, 'approve')", [id]);
    await expect(client.query("INSERT INTO activity (customer_id, action) VALUES ($1, 'delete')", [id])).rejects.toMatchObject({ code: "23514" });
    const sql = readFileSync(join(__dirname, "schema.sql"), "utf8");
    await client.query(sql);
    await client.query(sql);
    expect((await client.query("SELECT count(*)::int AS n FROM activity")).rows[0].n).toBe(2);
    expect((await client.query("SELECT passcode_hash, google_sub FROM people")).rows[0]).toEqual({ passcode_hash: null, google_sub: "3001" });
    expect((await client.query("SELECT status FROM signups")).rows[0].status).toBe("declined");
    const lists = sql.match(/action IN \([^)]*\)/g) ?? [];
    expect(lists.length).toBeGreaterThanOrEqual(5);
    for (const l of lists) {
      expect(l).toContain("'google_link'");
      expect(l).toContain("'approve'");
    }
  });

  it("version 7: a customer has no trial unless one is given, uses are counted per customer, and the trial key's health is one row", async () => {
    const id = await customer();
    const c = await client.query("SELECT trial_uses_limit, trial_started_at, trial_ends_at FROM customers WHERE id = $1", [id]);
    expect(c.rows[0]).toEqual({ trial_uses_limit: null, trial_started_at: null, trial_ends_at: null });
    await client.query("UPDATE customers SET trial_uses_limit = 150, trial_started_at = now(), trial_ends_at = now() + interval '14 days' WHERE id = $1", [id]);

    await client.query("INSERT INTO trial_uses (customer_id, kind) VALUES ($1, 'ask')", [id]);
    const u = await client.query("SELECT id, person_id, kind, at FROM trial_uses");
    expect(u.rows[0]).toMatchObject({ person_id: null, kind: "ask" });
    expect(u.rows[0].at).toBeInstanceOf(Date);
    await expect(client.query("INSERT INTO trial_uses (customer_id, kind) VALUES (gen_random_uuid(), 'ask')")).rejects.toMatchObject({ code: "23503" });
    await expect(client.query("INSERT INTO trial_uses (customer_id) VALUES ($1)", [id])).rejects.toMatchObject({ code: "23502" });
    const ix = await client.query("SELECT indexdef FROM pg_indexes WHERE tablename = 'trial_uses'");
    expect(ix.rows.some((r) => /\(customer_id\)/.test(r.indexdef))).toBe(true);

    await client.query("INSERT INTO trial_key_health (status) VALUES ('no_credit')");
    await expect(client.query("INSERT INTO trial_key_health (status) VALUES ('ok')")).rejects.toMatchObject({ code: "23505" });
    await expect(client.query("INSERT INTO trial_key_health (id, status) VALUES (false, 'ok')")).rejects.toMatchObject({ code: "23514" });
    await expect(client.query("UPDATE trial_key_health SET status = 'weird'")).rejects.toMatchObject({ code: "23514" });
    const h = await client.query("SELECT id, status, checked_at FROM trial_key_health");
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ id: true, status: "no_credit" });

    // The whole file applies again with all of it present, and nothing is lost.
    const sql = readFileSync(join(__dirname, "schema.sql"), "utf8");
    await client.query(sql);
    expect((await client.query("SELECT trial_uses_limit FROM customers WHERE id = $1", [id])).rows[0].trial_uses_limit).toBe(150);
    expect((await client.query("SELECT count(*)::int AS n FROM trial_uses")).rows[0].n).toBe(1);
    expect((await client.query("SELECT status FROM trial_key_health")).rows[0].status).toBe("no_credit");
    await client.query("TRUNCATE trial_key_health");
  });

  it("version 3: the earliest person is named key person, and the status takes only known values", async () => {
    const id = await customer();
    const late = await client.query(
      "INSERT INTO people (customer_id, display_name, owner_key, passcode_hash, created_at) VALUES ($1, 'Bob', 'BO', 'h', now()) RETURNING id",
      [id],
    );
    const early = await client.query(
      "INSERT INTO people (customer_id, display_name, owner_key, passcode_hash, created_at) VALUES ($1, 'Ann', 'AN', 'h', now() - interval '1 day') RETURNING id",
      [id],
    );
    await client.query(readFileSync(join(process.cwd(), "src", "lib", "monsoon", "accounts", "schema.sql"), "utf8"));
    const r = await client.query("SELECT key_person_id, claude_status FROM customers WHERE id = $1", [id]);
    expect(r.rows[0]).toEqual({ key_person_id: early.rows[0].id, claude_status: null });
    // A second run leaves a named key person alone.
    await client.query("UPDATE customers SET key_person_id = $2 WHERE id = $1", [id, late.rows[0].id]);
    await client.query(readFileSync(join(process.cwd(), "src", "lib", "monsoon", "accounts", "schema.sql"), "utf8"));
    expect((await client.query("SELECT key_person_id FROM customers WHERE id = $1", [id])).rows[0].key_person_id).toBe(late.rows[0].id);
    await expect(client.query("UPDATE customers SET claude_status = 'weird' WHERE id = $1", [id])).rejects.toThrow();
  });

  it("version 2: setup_links accepts host and key purposes", async () => {
    const id = await customer();
    const ins = (hash: string, purpose: string) =>
      client.query(
        "INSERT INTO setup_links (customer_id, token_hash, purpose, expires_at) VALUES ($1,$2,$3, now() + interval '7 days')",
        [id, hash, purpose],
      );
    await ins("h1", "host");
    await ins("k1", "key");
    await expect(ins("o1", "other")).rejects.toMatchObject({ code: "23514" });
  });

  it("version 2: activity accepts host and key actions", async () => {
    const id = await customer();
    const ins = (a: string) => client.query("INSERT INTO activity (customer_id, action) VALUES ($1,$2)", [id, a]);
    await ins("host");
    await ins("key");
    await expect(ins("delete")).rejects.toMatchObject({ code: "23514" });
  });

  it("version 2: a project ref can be recorded on only one pipeline", async () => {
    const id = await customer();
    const ins = (k: string, ref: string | null) =>
      client.query("INSERT INTO pipelines (customer_id, key, label, default_role, position, project_ref) VALUES ($1,$2,'L','investor',0,$3)", [id, k, ref]);
    await ins("aa", "abcdefghij");
    await expect(ins("bb", "abcdefghij")).rejects.toMatchObject({ code: "23505" });
    await ins("cc", null);
    await ins("dd", null);
  });

  it("version 2 applies over a version 1 database", async () => {
    await db.reset();
    const c2 = await db.connect();
    try {
      await c2.query(readFileSync(join(__dirname, "..", "testing", "accounts-schema-v1.sql"), "utf8"));
      const cu = await c2.query("INSERT INTO customers (code, name) VALUES ('acme-co','Acme') RETURNING id");
      await c2.query(
        "INSERT INTO setup_links (customer_id, token_hash, purpose, expires_at) VALUES ($1,'v1tok','connect', now() + interval '7 days')",
        [cu.rows[0].id],
      );
      await c2.query(readFileSync(join(__dirname, "schema.sql"), "utf8"));
      const l = await c2.query("SELECT purpose FROM setup_links WHERE token_hash = 'v1tok'");
      expect(l.rows[0].purpose).toBe("connect");
      const m = await c2.query("SELECT max(version)::int AS v FROM accounts_migrations");
      expect(m.rows[0].v).toBe(7);
    } finally {
      await c2.end();
      await db.reset();
    }
  });
});
