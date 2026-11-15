import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { makeAccountsTestDb } from "../testing/db";

const db = makeAccountsTestDb();
const TABLES = ["accounts_migrations", "customers", "people", "pipelines", "setup_links", "sign_in_attempts", "activity"];

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

  it("creates all seven tables and records migration 1", async () => {
    const r = await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
    expect(r.rows.map((x) => x.tablename).sort()).toEqual([...TABLES].sort());
    const m = await client.query("SELECT version FROM accounts_migrations");
    expect(m.rows.map((x) => x.version)).toEqual([1]);
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
    expect(r.rows).toHaveLength(7);
    for (const row of r.rows) expect(row.relrowsecurity).toBe(true);
    const p = await client.query("SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public'");
    expect(p.rows[0].n).toBe(0);
  });

  it("applies cleanly twice", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    await client.query(readFileSync(join(__dirname, "schema.sql"), "utf8"));
    const m = await client.query("SELECT count(*)::int AS n FROM accounts_migrations");
    expect(m.rows[0].n).toBe(1);
  });
});
