import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashToken, verifyPasscode } from "@/lib/monsoon/accounts/crypto";
import { makeAccountsTestDb } from "@/lib/monsoon/testing/db";
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
    expect(text()).toMatch(/already/i);
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

  it("adds a pipeline, makes a link, prints a script", async () => {
    await run(["customer", "add", "acme", "Acme"]);
    await run(["person", "add", "acme", "Ann", "AN"]);
    expect(
      await run(["pipeline", "add", "acme", "main", "Main", "--default-role", "investor", "--stages", STAGES, "--roles", ROLES]),
    ).toBe(0);
    const p = await client.query("SELECT position, vocab FROM pipelines");
    expect(p.rows[0].position).toBe(1);
    expect(p.rows[0].vocab.roles).toHaveLength(1);

    expect(await run(["link", "acme", "main"], { env: { MONSOON_PUBLIC_URL: "https://example.test" } })).toBe(0);
    const url = lines.find((l) => l.includes("/monsoon/setup/"))!.trim();
    expect(url.startsWith("https://example.test/monsoon/setup/")).toBe(true);
    const token = url.split("/").pop()!;
    const l = await client.query("SELECT token_hash, purpose, EXTRACT(EPOCH FROM (expires_at - now())) AS span FROM setup_links");
    expect(l.rows[0].token_hash).toBe(hashToken(token));
    expect(l.rows[0].purpose).toBe("connect");
    expect(Number(l.rows[0].span)).toBeGreaterThan(6.99 * 86400);

    await run(["link", "acme", "main", "--replace"]);
    const n = await client.query("SELECT purpose FROM setup_links ORDER BY created_at");
    expect(n.rows.map((r) => r.purpose)).toEqual(["connect", "replace"]);

    expect(await run(["script", "acme", "main"])).toBe(0);
    expect(text()).toContain("Ann");
    expect(await run(["script", "acme", "main", "--login-only"])).toBe(0);
    expect(text()).toContain("monsoon_app");
    expect(text()).not.toContain("Ann");
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
