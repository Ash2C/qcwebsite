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
    expect(text()).toContain("Schema already applied (version 6).");
    expect((await client.query("SELECT max(version)::int AS v FROM accounts_migrations")).rows[0].v).toBe(6);
  });

  it("migrate applies version 6 to an empty database and says so", async () => {
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
    expect(await run(["migrate"])).toBe(0);
    expect(text()).toBe("Schema applied (version 6).");
    expect((await client.query("SELECT to_regclass('public.person_notes') AS t")).rows[0].t).not.toBeNull();
  });

  it("migrate brings a version 3 database up to version 6", async () => {
    await client.query("DELETE FROM accounts_migrations WHERE version >= 4");
    expect(await run(["migrate"])).toBe(0);
    expect(text()).toBe("Schema applied (version 6).");
    expect(await run(["migrate"])).toBe(0);
    expect(text()).toBe("Schema already applied (version 6).");
  });

  it("migrate brings a version 4 database up to version 6", async () => {
    // A database as the live one is today: version 4 applied, with no Granola columns, the version 4
    // action list, a profile activity row, and no version 5 marker.
    await run(["customer", "add", "acme", "Acme"]);
    await run(["person", "add", "acme", "Ann", "AN"]);
    await client.query("INSERT INTO activity (customer_id, action) SELECT id, 'profile' FROM customers");
    await client.query("DELETE FROM accounts_migrations WHERE version >= 5");
    await client.query(
      "ALTER TABLE people DROP COLUMN granola_key_enc, DROP COLUMN granola_status, DROP COLUMN granola_checked_at, DROP COLUMN granola_key_set_at",
    );
    await client.query(
      `ALTER TABLE activity DROP CONSTRAINT activity_action_check,
         ADD CONSTRAINT activity_action_check CHECK (action IN (
           'sign_in', 'capture', 'batch_save', 'tidy', 'ask', 'act_note', 'act_stage',
           'act_details', 'act_research', 'research', 'setup', 'replace', 'host', 'key', 'profile'))`,
    );
    const granola = () => client.query("INSERT INTO activity (customer_id, action) SELECT id, 'granola' FROM customers");
    await expect(granola()).rejects.toMatchObject({ code: "23514" });

    expect(await run(["migrate"])).toBe(0);
    expect(text()).toBe("Schema applied (version 6).");
    expect((await client.query("SELECT max(version)::int AS v FROM accounts_migrations")).rows[0].v).toBe(6);
    const p = await client.query("SELECT display_name, granola_key_enc, granola_status, granola_checked_at, granola_key_set_at FROM people");
    expect(p.rows).toEqual([
      { display_name: "Ann", granola_key_enc: null, granola_status: null, granola_checked_at: null, granola_key_set_at: null },
    ]);
    await granola();
    expect(await run(["migrate"])).toBe(0);
    expect(text()).toBe("Schema already applied (version 6).");
  });

  it("migrate brings a version 5 database up to version 6, keeping people and their passcodes", async () => {
    // A database as the live one is today: version 5, no signups table, passcodes required, no Google
    // id, no shared schema, and the version 5 action list.
    await run(["customer", "add", "acme", "Acme"]);
    await run(["person", "add", "acme", "Ann", "AN"]);
    await client.query("INSERT INTO activity (customer_id, action) SELECT id, 'granola' FROM customers");
    await client.query("DROP TABLE signups");
    await client.query("ALTER TABLE people DROP COLUMN google_sub, ALTER COLUMN passcode_hash SET NOT NULL");
    await client.query("ALTER TABLE pipelines DROP COLUMN shared_schema");
    await client.query("DELETE FROM accounts_migrations WHERE version = 6");
    await client.query(
      `ALTER TABLE activity DROP CONSTRAINT activity_action_check,
         ADD CONSTRAINT activity_action_check CHECK (action IN (
           'sign_in', 'capture', 'batch_save', 'tidy', 'ask', 'act_note', 'act_stage',
           'act_details', 'act_research', 'research', 'setup', 'replace', 'host', 'key', 'profile', 'granola'))`,
    );
    const before = (await client.query("SELECT passcode_hash FROM people")).rows[0].passcode_hash;
    const approve = () => client.query("INSERT INTO activity (customer_id, action) SELECT id, 'approve' FROM customers");
    await expect(approve()).rejects.toMatchObject({ code: "23514" });

    expect(await run(["migrate"])).toBe(0);
    expect(text()).toBe("Schema applied (version 6).");
    const p = await client.query("SELECT display_name, passcode_hash, google_sub FROM people");
    expect(p.rows).toEqual([{ display_name: "Ann", passcode_hash: before, google_sub: null }]);
    expect((await client.query("SELECT to_regclass('public.signups') AS t")).rows[0].t).not.toBeNull();
    await approve();
    expect(await run(["migrate"])).toBe(0);
    expect(text()).toBe("Schema already applied (version 6).");
  });

  it("reset gives a passcode to a person who signed up with Google and had none", async () => {
    await run(["customer", "add", "acme", "Acme"]);
    const cid = (await client.query("SELECT id FROM customers")).rows[0].id;
    await client.query("INSERT INTO people (customer_id, display_name, owner_key, google_sub) VALUES ($1, 'Gil', 'GI', '4001')", [cid]);
    expect(await run(["person", "reset", "acme", "GI"])).toBe(0);
    const passcode = lines.find((l) => /^[a-z]+(-[a-z]+){4}$/.test(l.trim()))?.trim();
    const { rows } = await client.query("SELECT passcode_hash, session_no FROM people");
    expect(await verifyPasscode(passcode!, rows[0].passcode_hash)).toBe(true);
    expect(rows[0].session_no).toBe(2);
    await run(["people", "acme"]);
    expect(text()).toContain("Gil | GI | active");
  });

  it("forget clears the Google link of that customer's people, with or without a passcode, and leaves another customer's alone", async () => {
    await run(["customer", "add", "acme", "Acme"]);
    await run(["customer", "add", "other", "Other"]);
    await run(["person", "add", "acme", "Ann", "AN"]);
    await run(["person", "add", "other", "Oz", "OZ"]);
    const cid = (await client.query("SELECT id FROM customers WHERE code = 'acme'")).rows[0].id;
    await client.query("INSERT INTO people (customer_id, display_name, owner_key, google_sub) VALUES ($1, 'Gil', 'GI', '4001')", [cid]);
    await client.query("UPDATE people SET google_sub = '4002' WHERE owner_key = 'AN'");
    await client.query("UPDATE people SET google_sub = '4003' WHERE owner_key = 'OZ'");

    expect(await run(["forget", "acme"])).toBe(0);
    expect(text()).toContain("Google links cleared: 2.");
    expect(text()).not.toMatch(/400\d/);
    const people = await client.query("SELECT owner_key, google_sub, session_no FROM people ORDER BY owner_key");
    expect(people.rows).toEqual([
      { owner_key: "AN", google_sub: null, session_no: 2 },
      { owner_key: "GI", google_sub: null, session_no: 2 },
      { owner_key: "OZ", google_sub: "4003", session_no: 1 },
    ]);
    expect(await run(["forget", "acme"])).toBe(0);
    expect(text()).toContain("Google links cleared: 0.");
  });

  it("forget clears the Granola key of that customer's people and leaves another customer's alone", async () => {
    await run(["customer", "add", "acme", "Acme"]);
    await run(["customer", "add", "other", "Other"]);
    await run(["person", "add", "acme", "Ann", "AN"]);
    await run(["person", "add", "acme", "Bob", "BO"]);
    await run(["person", "add", "other", "Oz", "OZ"]);
    await client.query(
      "UPDATE people SET granola_key_enc = 'k1.ggg.hhh.iii', granola_status = 'ok', granola_checked_at = now(), granola_key_set_at = now() WHERE owner_key IN ('AN', 'OZ')",
    );

    expect(await run(["forget", "acme"])).toBe(0);
    expect(text()).toContain("Granola keys cleared: 1.");
    expect(text()).not.toMatch(/k1\./);
    const people = await client.query(
      "SELECT owner_key, granola_key_enc, granola_status, granola_checked_at IS NULL AS no_check, granola_key_set_at IS NULL AS no_set FROM people ORDER BY owner_key",
    );
    expect(people.rows).toEqual([
      { owner_key: "AN", granola_key_enc: null, granola_status: null, no_check: true, no_set: true },
      { owner_key: "BO", granola_key_enc: null, granola_status: null, no_check: true, no_set: true },
      { owner_key: "OZ", granola_key_enc: "k1.ggg.hhh.iii", granola_status: "ok", no_check: false, no_set: false },
    ]);
    expect(await run(["forget", "acme"])).toBe(0);
    expect(text()).toContain("Granola keys cleared: 0.");
  });

  it("forget blanks the user pages of that customer's people and leaves another customer's alone", async () => {
    await run(["customer", "add", "acme", "Acme"]);
    await run(["customer", "add", "other", "Other"]);
    await run(["person", "add", "acme", "Ann", "AN"]);
    await run(["person", "add", "acme", "Bob", "BO"]);
    await run(["person", "add", "other", "Oz", "OZ"]);
    for (const code of ["acme", "other"]) {
      await run(["pipeline", "add", code, "main", "Main", "--default-role", "investor", "--stages", STAGES, "--roles", ROLES]);
    }
    await run(["pipeline", "add", "acme", "side", "Side", "--default-role", "investor", "--stages", STAGES, "--roles", ROLES]);
    await client.query("UPDATE people SET phone = '+31 6 ' || owner_key, email = lower(owner_key) || '@example.com'");
    // Every person gets a work row and two notes in each pipeline of their own customer.
    await client.query(
      `INSERT INTO person_work (person_id, pipeline_id, company, website, role_objectives)
       SELECT p.id, l.id, 'Co', 'https://example.com', 'Sell more' FROM people p JOIN pipelines l ON l.customer_id = p.customer_id`,
    );
    await client.query(
      `INSERT INTO person_notes (person_id, pipeline_id, body)
       SELECT p.id, l.id, 'note ' || n FROM people p JOIN pipelines l ON l.customer_id = p.customer_id, generate_series(1, 2) n`,
    );

    expect(await run(["forget", "acme"])).toBe(0);
    expect(text()).toContain("User pages blanked: notes removed 8, work details removed 4, phone and email cleared for 2.");
    expect(text()).not.toMatch(/example\.com|\+31/);
    const left = async (table: string) =>
      (
        await client.query(
          `SELECT c.code, count(*)::int AS n FROM ${table} t JOIN people p ON p.id = t.person_id JOIN customers c ON c.id = p.customer_id GROUP BY c.code`,
        )
      ).rows;
    expect(await left("person_notes")).toEqual([{ code: "other", n: 2 }]);
    expect(await left("person_work")).toEqual([{ code: "other", n: 1 }]);
    const people = await client.query("SELECT owner_key, display_name, phone, email FROM people ORDER BY owner_key");
    expect(people.rows).toEqual([
      { owner_key: "AN", display_name: "Ann", phone: null, email: null },
      { owner_key: "BO", display_name: "Bob", phone: null, email: null },
      { owner_key: "OZ", display_name: "Oz", phone: "+31 6 OZ", email: "oz@example.com" },
    ]);
    // A second run finds nothing left to blank.
    expect(await run(["forget", "acme"])).toBe(0);
    expect(text()).toContain("User pages blanked: notes removed 0, work details removed 0, phone and email cleared for 0.");
  });

  it("the first person keeps the Claude key until keyholder names another", async () => {
    await run(["customer", "add", "acme", "Acme Ltd"]);
    await run(["person", "add", "acme", "Ann", "AN"]);
    await run(["person", "add", "acme", "Bob", "BO"]);
    const holder = async () =>
      (await client.query("SELECT p.owner_key FROM customers c JOIN people p ON p.id = c.key_person_id WHERE c.code = 'acme'")).rows[0]?.owner_key;
    expect(await holder()).toBe("AN");
    expect(await run(["keyholder", "acme", "BO"])).toBe(0);
    expect(await holder()).toBe("BO");
    expect(await run(["keyholder", "acme", "ZZ"])).not.toBe(0);
    expect(await holder()).toBe("BO");
    await run(["status"]);
    expect(text()).toContain("key holder BO");
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

  it("reset disconnects the person's Granola: a seat handed on does not carry the last holder's meetings", async () => {
    await run(["customer", "add", "acme", "Acme"]);
    await run(["person", "add", "acme", "Ann", "AN"]);
    await run(["person", "add", "acme", "Bob", "BO"]);
    await client.query(
      "UPDATE people SET granola_key_enc = 'k1.ggg.hhh.iii', granola_status = 'ok', granola_checked_at = now(), granola_key_set_at = now()",
    );
    await run(["person", "reset", "acme", "AN"]);
    const r = await client.query(
      "SELECT owner_key, granola_key_enc, granola_status, granola_checked_at IS NULL AS no_check, granola_key_set_at IS NULL AS no_set FROM people ORDER BY owner_key",
    );
    expect(r.rows).toEqual([
      { owner_key: "AN", granola_key_enc: null, granola_status: null, no_check: true, no_set: true },
      { owner_key: "BO", granola_key_enc: "k1.ggg.hhh.iii", granola_status: "ok", no_check: false, no_set: false },
    ]);
  });

  it("reset unlinks the person's Google account: a seat handed on is not reachable by the last holder's Google", async () => {
    await run(["customer", "add", "acme", "Acme"]);
    await run(["person", "add", "acme", "Ann", "AN"]);
    await run(["person", "add", "acme", "Bob", "BO"]);
    await client.query("UPDATE people SET google_sub = CASE owner_key WHEN 'AN' THEN '5001' ELSE '5002' END");
    await run(["person", "reset", "acme", "AN"]);
    const r = await client.query("SELECT owner_key, google_sub FROM people ORDER BY owner_key");
    expect(r.rows).toEqual([
      { owner_key: "AN", google_sub: null },
      { owner_key: "BO", google_sub: "5002" },
    ]);
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

    const OTHER_REF = "zyxwvutsrq9876543210";
    async function populateProject() {
      await crm.reset();
      const c = await crm.connect();
      await c.query("INSERT INTO people (name, name_key, source) VALUES ('Jane Tan', 'jane tan', 'test')");
      await c.end();
    }
    async function crmPeople(): Promise<number> {
      const c = await crm.connect();
      try {
        return (await c.query("SELECT count(*)::int AS n FROM people")).rows[0].n;
      } finally {
        await c.end();
      }
    }
    const hostLinks = async () =>
      (await client.query("SELECT count(*)::int AS n FROM setup_links WHERE purpose = 'host'")).rows[0].n as number;
    const markConnected = (ref: string) =>
      client.query("UPDATE pipelines SET db_url_enc = 'k1.ddd.eee.fff', connected_at = now(), project_ref = $1 WHERE key = 'main'", [ref]);

    it("refuses a project that already holds Monsoon people unless --replace", async () => {
      await populateProject();
      expect(await host()).toBe(1);
      expect(lines).toEqual(["Error: That project already holds Monsoon data. Check the project reference, or pass --replace."]);
      expect(posts).toHaveLength(0);
      expect(await hostLinks()).toBe(0);
    });

    it("--replace rebuilds over Monsoon people only in the project the pipeline already uses", async () => {
      await populateProject();
      await markConnected(REF);
      expect(await host(["--replace"])).toBe(0);
      expect(text()).toContain(`Pipeline main hosted on project ${REF}.`);
      expect(posts).toHaveLength(1);
      expect(await crmPeople()).toBe(1);
      noSecrets();
    });

    it("--replace refuses a populated project under a different, unrecorded ref and runs nothing", async () => {
      await populateProject();
      await markConnected(REF);
      expect(await run([...hostArgs(OTHER_REF), "--replace"], hostDeps())).toBe(1);
      expect(lines).toEqual(["Error: That project already holds Monsoon data. Check the project reference."]);
      expect(posts).toHaveLength(0);
      expect(await hostLinks()).toBe(0);
      expect(await crmPeople()).toBe(1);
      const r = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
      expect(r.rowCount).toBe(0);
    });

    it("--replace moves a connected pipeline onto an empty project with a new ref", async () => {
      await markConnected(REF);
      expect(await run([...hostArgs(OTHER_REF), "--replace"], hostDeps())).toBe(0);
      expect(text()).toContain(`Pipeline main hosted on project ${OTHER_REF}.`);
      expect(posts).toHaveLength(1);
      expect(posts[0].body.projectRef).toBe(OTHER_REF);
      noSecrets();
    });

    it.each([
      ["the server refuses", async (): Promise<Reply> => ({ status: 422, body: { failure: "can_delete", error: "The Monsoon login can remove rows." } })],
      [
        "the server cannot be reached",
        async (): Promise<Reply> => {
          throw new TypeError(`fetch failed for ${GENERATED}`);
        },
      ],
    ])("host --replace on a connected pipeline exits 1 and says it is not connected when %s", async (_label, fake) => {
      await markConnected(REF);
      reply = fake;
      expect(await host(["--replace"])).toBe(1);
      expect(lines).toContain("The pipeline is not connected until host runs again successfully.");
      expect(lines[lines.length - 1]).toBe("The pipeline is not connected until host runs again successfully.");
      expect(text()).not.toContain("hosted on project");
      expect(text()).not.toContain("fetch failed");
      noSecrets();
    });

    it("a failure after the script ran, such as the host link insert, also says the pipeline is not connected", async () => {
      const failing = Object.create(client) as Client;
      failing.query = ((text: unknown, ...rest: unknown[]) =>
        typeof text === "string" && text.includes("INSERT INTO setup_links")
          ? Promise.reject(Object.assign(new Error(`insert failed ${GENERATED}`), { code: "23505" }))
          : (client.query as (...a: unknown[]) => unknown)(text, ...rest)) as Client["query"];
      expect(await run(hostArgs(), { ...hostDeps(), db: failing })).toBe(1);
      expect(lines.slice(-2)).toEqual(["Error: Error (23505)", "The pipeline is not connected until host runs again successfully."]);
      expect(posts).toHaveLength(0);
      noSecrets();
    });

    it("an empty owner password variable fails before connecting", async () => {
      expect(await run(hostArgs(), hostDeps({ OWNER_PW_VAR: "" }))).toBe(1);
      expect(lines).toEqual(["Error: environment variable OWNER_PW_VAR is not set"]);
      expect(connects).toHaveLength(0);
    });

    it("refuses a MONSOON_PUBLIC_URL that is not https before connecting", async () => {
      expect(await run(hostArgs(), hostDeps({ MONSOON_PUBLIC_URL: "http://example.test" }))).toBe(1);
      expect(lines).toEqual(["Error: MONSOON_PUBLIC_URL must be an https address"]);
      expect(connects).toHaveLength(0);
      expect(posts).toHaveLength(0);
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

  it("the CLI source never mentions the master key, and deletes only the user pages in forget", () => {
    // forget blanks the user pages of a customer's people (the user page spec, 2026-11-24). Those two
    // statements, exactly as written and once each, are the only deletes the tool may hold.
    const pageDeletes = ["person_notes", "person_work"].map(
      (t) => `"DELETE FROM ${t} WHERE person_id IN (SELECT id FROM people WHERE customer_id = $1)"`,
    );
    for (const f of ["admin.ts", "admin-commands.ts"]) {
      let src = readFileSync(join(__dirname, f), "utf8");
      expect(src).not.toContain("MONSOON_MASTER_KEY");
      if (f === "admin-commands.ts") {
        for (const stmt of pageDeletes) {
          expect(src.split(stmt).length - 1, stmt).toBe(1);
          src = src.replace(stmt, " ");
        }
      }
      expect(src).not.toMatch(/\bDELETE\b/i);
    }
  });
});
