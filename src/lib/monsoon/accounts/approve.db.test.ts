// Approving a request: real accounts database, real crypto. The shared database is replaced by an
// injected provisioning function everywhere except one end-to-end test, which provisions for real
// into a database made for this file and signs the new person in. The Zero One CRM is always a mock.
import { randomBytes } from "node:crypto";
import type { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { checkVocabulary } from "../../../../scripts/monsoon/admin-commands";
import { signSession } from "../auth";
import { makeAccountsTestDb, makeTestDb } from "../testing/db";
import { requireAccount } from "./account";
import { DEFAULT_PIPELINE, DEFAULT_VOCABULARY, approveSignup, customerCode, ownerKeyFor, type ApproveDeps } from "./approve";
import { decryptSecret } from "./crypto";
import { ProvisionError, clientNames, provisionSharedCrm } from "./provision";
import { declineSignup, findPersonByGoogleSub, linkGoogle, requestSignup } from "./signups";
import { clearAccountCache } from "./store";

const accounts = makeAccountsTestDb();
const shared = makeTestDb("approve");
const NONE = "00000000-0000-4000-8000-000000000000";

describe("customerCode", () => {
  it("is a slug of the name plus four random characters, and always a valid code", () => {
    expect(customerCode("Gil Hale")).toMatch(/^gil-hale-[a-z0-9]{4}$/);
    expect(customerCode("  Élodie   O'Brien-Smith  ")).toMatch(/^elodie-o-brien-smith-[a-z0-9]{4}$/);
    expect(customerCode("李雷")).toMatch(/^client-[a-z0-9]{4}$/);
    expect(customerCode("")).toMatch(/^client-[a-z0-9]{4}$/);
    for (const name of ["x".repeat(200), "a b c d e f g h i j k l m n o p q r s t u v w x y z", "---", "A", "quantcloud", "Quant Cloud"]) {
      const code = customerCode(name);
      expect(code, name).toMatch(/^[a-z0-9-]{3,32}$/);
      expect(code, name).toMatch(/-[a-z0-9]{4}$/);
      expect(code).not.toMatch(/--/);
    }
    expect(customerCode("Gil Hale")).not.toBe(customerCode("Gil Hale"));
  });

  it("can never be the code quantcloud, whatever the name", () => {
    for (const name of ["quantcloud", "QuantCloud", "quantcloud-", "quant cloud"]) {
      for (let i = 0; i < 20; i++) expect(customerCode(name)).not.toBe("quantcloud");
    }
  });
});

describe("ownerKeyFor", () => {
  it("takes the initials, two to four capital letters", () => {
    expect(ownerKeyFor("Gil Hale", NONE)).toBe("GH");
    expect(ownerKeyFor("élodie de la tour martin", NONE)).toBe("EDLT");
    expect(ownerKeyFor("Jean-Luc Picard", NONE)).toBe("JLP");
    expect(ownerKeyFor("Madonna", NONE)).toBe("MA");
  });

  it("generates letters for a name without two Latin letters, the same ones every time for one customer", () => {
    for (const name of ["李雷", "X", "", "7 8", "!!"]) {
      const key = ownerKeyFor(name, NONE);
      expect(key, name).toMatch(/^[A-Z]{3}$/);
      expect(ownerKeyFor(name, NONE)).toBe(key);
    }
    expect(ownerKeyFor("李雷", "11111111-1111-4111-8111-111111111111")).toMatch(/^[A-Z]{3}$/);
  });
});

describe("the default pipeline", () => {
  it("passes the admin tool's vocabulary check", async () => {
    expect(() => checkVocabulary(DEFAULT_VOCABULARY.stages, DEFAULT_VOCABULARY.roles, DEFAULT_PIPELINE.defaultRole)).not.toThrow();
    expect(() => checkVocabulary(DEFAULT_VOCABULARY.stages, DEFAULT_VOCABULARY.roles, "nobody")).toThrow();
    expect(DEFAULT_PIPELINE.key).toMatch(/^[a-z0-9-]{2,32}$/);
    expect(DEFAULT_PIPELINE).toEqual({ key: "pipeline", label: "Pipeline", defaultRole: DEFAULT_VOCABULARY.roles[0].key });
    expect(DEFAULT_VOCABULARY.stages.some((s) => !s.terminal)).toBe(true);
  });
});

describe.skipIf(!accounts.available)("approveSignup (real accounts database)", { timeout: 60_000 }, () => {
  let db: Client;
  const made: string[] = [];
  let provision: ReturnType<typeof vi.fn>;
  let recordInCrm: ReturnType<typeof vi.fn>;
  let deps: ApproveDeps;

  /** What the shared database would hand back, without touching one. */
  const fakeProvision = async (input: { customerId: string }) => {
    const n = clientNames(input.customerId);
    return { dbUrl: `postgresql://${n.role}:pw-${input.customerId}@127.0.0.1:55433/monsoon_nowhere_test`, schema: n.schema };
  };
  async function ask(sub: string, name = "Gil Hale", email = "gil@example.com"): Promise<string> {
    expect(await requestSignup({ sub, email, name, addressHash: `addr-${sub}` })).toBe("created");
    return (await db.query("SELECT id FROM signups WHERE google_sub = $1", [sub])).rows[0].id;
  }
  const count = async (table: string) => (await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number;
  /** A passcode user in a company that already exists. */
  async function existingPerson(): Promise<{ customerId: string; personId: string }> {
    const customerId = (await db.query("INSERT INTO customers (code, name) VALUES ('old-co', 'Old Co') RETURNING id")).rows[0].id as string;
    const personId = (
      await db.query("INSERT INTO people (customer_id, display_name, owner_key, passcode_hash) VALUES ($1, 'Ann', 'AN', 'h') RETURNING id", [customerId])
    ).rows[0].id as string;
    return { customerId, personId };
  }
  const signup = async (id: string) => (await db.query("SELECT status, customer_id, decided_at FROM signups WHERE id = $1", [id])).rows[0];

  beforeAll(async () => {
    await accounts.reset();
    db = await accounts.connect();
  });
  afterAll(async () => {
    await db?.end();
    if (!made.length) return;
    const admin = await shared.connect();
    try {
      for (const id of made) {
        const n = clientNames(id);
        await admin.query(`DROP SCHEMA IF EXISTS ${n.schema} CASCADE`);
        const found = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [n.role]);
        if (found.rowCount) {
          await admin.query(`DROP OWNED BY ${n.role}`);
          await admin.query(`DROP ROLE ${n.role}`);
        }
      }
    } finally {
      await admin.end();
    }
  });
  beforeEach(async () => {
    vi.stubEnv("MONSOON_MASTER_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("MONSOON_ACCOUNTS_DATABASE_URL", accounts.url());
    vi.stubEnv("MONSOON_SESSION_SECRET", "s".repeat(32));
    clearAccountCache();
    await db.query("TRUNCATE activity, setup_links, pipelines, people, customers, sign_in_attempts, signups CASCADE");
    provision = vi.fn(fakeProvision);
    recordInCrm = vi.fn(async () => undefined);
    deps = { provision: provision as unknown as ApproveDeps["provision"], recordInCrm: recordInCrm as unknown as ApproveDeps["recordInCrm"] };
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("creates the company, the person, the pipeline and its connection, and marks the request approved", async () => {
    const id = await ask("7001");
    const r = await approveSignup(id, deps);
    expect(r).toEqual({ ok: true, customerId: expect.any(String), already: false });
    const customerId = (r as { customerId: string }).customerId;

    const c = (await db.query("SELECT id, code, name, status, key_person_id, claude_key_enc FROM customers")).rows;
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ id: customerId, name: "Gil Hale", status: "active", claude_key_enc: null });
    expect(c[0].code).toMatch(/^gil-hale-[a-z0-9]{4}$/);

    const p = (await db.query("SELECT id, customer_id, display_name, owner_key, google_sub, passcode_hash, status, session_no FROM people")).rows;
    expect(p).toEqual([
      { id: c[0].key_person_id, customer_id: customerId, display_name: "Gil Hale", owner_key: "GH", google_sub: "7001", passcode_hash: null, status: "active", session_no: 1 },
    ]);

    const pl = (await db.query("SELECT id, key, label, default_role, vocab, db_url_enc, shared_schema, connected_at, project_ref FROM pipelines")).rows;
    expect(pl).toHaveLength(1);
    expect(pl[0]).toMatchObject({ key: "pipeline", label: "Pipeline", default_role: DEFAULT_PIPELINE.defaultRole, shared_schema: clientNames(customerId).schema, project_ref: null });
    expect(pl[0].vocab).toEqual(DEFAULT_VOCABULARY);
    expect(pl[0].connected_at).toBeInstanceOf(Date);
    // Stored encrypted, under the field name the app decrypts a pipeline's address with.
    expect(pl[0].db_url_enc).toMatch(/^k1\./);
    expect(pl[0].db_url_enc).not.toContain("pw-");
    expect(decryptSecret(pl[0].db_url_enc, customerId, `pipeline:${pl[0].id}`)).toBe((await fakeProvision({ customerId })).dbUrl);

    expect(await signup(id)).toMatchObject({ status: "approved", customer_id: customerId, decided_at: expect.any(Date) });
    expect(provision).toHaveBeenCalledTimes(1);
    expect(provision).toHaveBeenCalledWith({
      customerId,
      vocabulary: { ...DEFAULT_VOCABULARY, owners: [{ key: "GH", name: "Gil Hale" }] },
      defaultRole: DEFAULT_PIPELINE.defaultRole,
    });
    expect((await db.query("SELECT customer_id, person_id, action FROM activity")).rows).toEqual([
      { customer_id: customerId, person_id: c[0].key_person_id, action: "approve" },
    ]);
    // The person can now sign in with Google.
    expect((await findPersonByGoogleSub("7001"))?.person.id).toBe(c[0].key_person_id);
  });

  it("records the activity under the approver when one is named", async () => {
    const approver = (await db.query("INSERT INTO customers (code, name) VALUES ('quantcloud', 'Quantcloud') RETURNING id")).rows[0].id;
    const person = (await db.query("INSERT INTO people (customer_id, display_name, owner_key, passcode_hash) VALUES ($1, 'Vincent', 'VF', 'h') RETURNING id", [approver])).rows[0].id;
    await approveSignup(await ask("7001"), { ...deps, approver: { customerId: approver, personId: person } });
    expect((await db.query("SELECT customer_id, person_id, action FROM activity")).rows).toEqual([{ customer_id: approver, person_id: person, action: "approve" }]);
  });

  it("two people with the same name get two companies with different codes", async () => {
    const a = await approveSignup(await ask("7001", "Sam Lee", "sam1@example.com"), deps);
    const b = await approveSignup(await ask("7002", "Sam Lee", "sam2@example.com"), deps);
    expect(a.ok && b.ok).toBe(true);
    const codes = (await db.query("SELECT code FROM customers")).rows.map((r) => r.code);
    expect(new Set(codes).size).toBe(2);
    expect(await count("people")).toBe(2);
  });

  it("a failure while building the CRM leaves the request pending with no way in; calling again finishes it without doubling", async () => {
    const id = await ask("7001");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    provision.mockRejectedValueOnce(new ProvisionError("build", "42501"));
    expect(await approveSignup(id, deps)).toEqual({ ok: false, reason: "failed" });
    const half = await signup(id);
    expect(half).toMatchObject({ status: "pending", decided_at: null });
    expect(half.customer_id).toEqual(expect.any(String));
    expect(await count("customers")).toBe(1);
    expect(await count("people")).toBe(0);
    expect((await db.query("SELECT db_url_enc, shared_schema, connected_at FROM pipelines")).rows).toEqual([{ db_url_enc: null, shared_schema: null, connected_at: null }]);
    expect(await findPersonByGoogleSub("7001")).toBeNull();
    expect(recordInCrm).not.toHaveBeenCalled();
    expect(await count("activity")).toBe(0);
    // The log names the step and Postgres's code: never the person, the Google id or an address.
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).toContain("build");
    for (const secret of ["gil@example.com", "7001", "Gil Hale", "postgresql://", "pw-"]) expect(logged).not.toContain(secret);

    expect(await approveSignup(id, deps)).toEqual({ ok: true, customerId: half.customer_id, already: false });
    expect(provision).toHaveBeenCalledTimes(2);
    expect(provision.mock.calls[1][0].customerId).toBe(provision.mock.calls[0][0].customerId);
    for (const t of ["customers", "people", "pipelines"]) expect(await count(t), t).toBe(1);
    expect(await signup(id)).toMatchObject({ status: "approved", customer_id: half.customer_id });
  });

  it("a failure after the CRM was built is finished by calling again, without building it a second time", async () => {
    const id = await ask("7001");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // The last step cannot finish: another person turns out to hold this Google id.
    const other = (await db.query("INSERT INTO customers (code, name) VALUES ('other-co', 'Other') RETURNING id")).rows[0].id;
    const squatter = (await db.query("INSERT INTO people (customer_id, display_name, owner_key, passcode_hash) VALUES ($1, 'Otto', 'OT', 'h') RETURNING id", [other])).rows[0].id;
    await db.query("UPDATE people SET google_sub = '7001' WHERE id = $1", [squatter]);
    expect(await approveSignup(id, deps)).toEqual({ ok: false, reason: "failed" });
    expect(await signup(id)).toMatchObject({ status: "pending" });
    expect(await count("people")).toBe(1);
    expect((await db.query("SELECT db_url_enc IS NOT NULL AS connected FROM pipelines")).rows).toEqual([{ connected: true }]);
    expect(provision).toHaveBeenCalledTimes(1);

    await db.query("UPDATE people SET google_sub = NULL WHERE id = $1", [squatter]);
    expect((await approveSignup(id, deps)).ok).toBe(true);
    expect(provision).toHaveBeenCalledTimes(1);
    expect(await count("people")).toBe(2);
    expect((await db.query("SELECT count(*)::int AS n FROM pipelines WHERE db_url_enc IS NOT NULL")).rows[0].n).toBe(1);
    expect(await signup(id)).toMatchObject({ status: "approved" });
  });

  it("called twice at once it approves once: one company, one person, one pipeline, one CRM", async () => {
    const id = await ask("7001");
    provision.mockImplementation(async (input: { customerId: string }) => {
      await new Promise((r) => setTimeout(r, 400));
      return fakeProvision(input);
    });
    const results = await Promise.all([approveSignup(id, deps), approveSignup(id, deps), approveSignup(id, deps)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([
      { ok: false, reason: "busy" },
      { ok: false, reason: "busy" },
    ]);
    expect(provision).toHaveBeenCalledTimes(1);
    for (const t of ["customers", "people", "pipelines", "activity"]) expect(await count(t), t).toBe(1);
    expect(recordInCrm).toHaveBeenCalledTimes(1);
  });

  it("approving an approved request again changes nothing", async () => {
    const id = await ask("7001");
    const first = await approveSignup(id, deps);
    const before = (await db.query("SELECT db_url_enc FROM pipelines")).rows[0].db_url_enc;
    expect(await approveSignup(id, deps)).toEqual({ ok: true, customerId: (first as { customerId: string }).customerId, already: true });
    expect(provision).toHaveBeenCalledTimes(1);
    expect(recordInCrm).toHaveBeenCalledTimes(1);
    for (const t of ["customers", "people", "pipelines", "activity"]) expect(await count(t), t).toBe(1);
    expect((await db.query("SELECT db_url_enc FROM pipelines")).rows[0].db_url_enc).toBe(before);
  });

  it("refuses a declined request, an unknown one and an id that is not one, creating nothing", async () => {
    const id = await ask("7001");
    await declineSignup(id);
    expect(await approveSignup(id, deps)).toEqual({ ok: false, reason: "declined" });
    expect(await approveSignup(NONE, deps)).toEqual({ ok: false, reason: "not_found" });
    expect(await approveSignup("1; DROP TABLE signups", deps)).toEqual({ ok: false, reason: "not_found" });
    expect(await approveSignup(undefined as unknown as string, deps)).toEqual({ ok: false, reason: "not_found" });
    expect(provision).not.toHaveBeenCalled();
    for (const t of ["customers", "people", "pipelines", "activity"]) expect(await count(t), t).toBe(0);
  });

  it("a request declined while its CRM was being built stays declined: nobody gets in", async () => {
    const id = await ask("7001");
    provision.mockImplementation(async (input: { customerId: string }) => {
      await declineSignup(id);
      return fakeProvision(input);
    });
    expect(await approveSignup(id, deps)).toEqual({ ok: false, reason: "declined" });
    expect(await signup(id)).toMatchObject({ status: "declined" });
    expect(await count("people")).toBe(0);
    expect(await findPersonByGoogleSub("7001")).toBeNull();
    expect(recordInCrm).not.toHaveBeenCalled();
  });

  it("a request whose Google id was linked to an existing person can no longer be approved, and makes nothing", async () => {
    const id = await ask("7001");
    const who = await existingPerson();
    expect(await linkGoogle(who, "7001")).toBe("linked");
    expect(await approveSignup(id, deps)).toEqual({ ok: false, reason: "not_found" });
    expect(provision).not.toHaveBeenCalled();
    expect(await signup(id)).toMatchObject({ status: "linked", customer_id: null });
    expect(await count("customers")).toBe(1);
    expect(await count("people")).toBe(1);
    expect(recordInCrm).not.toHaveBeenCalled();
  });

  it("a link made while the CRM was being built wins: the approval makes no person and the request is linked", async () => {
    const id = await ask("7001");
    const who = await existingPerson();
    provision.mockImplementation(async (input: { customerId: string }) => {
      expect(await linkGoogle(who, "7001")).toBe("linked");
      return fakeProvision(input);
    });
    expect(await approveSignup(id, deps)).toEqual({ ok: false, reason: "not_found" });
    expect(await signup(id)).toMatchObject({ status: "linked" });
    expect((await db.query("SELECT id FROM people WHERE google_sub = '7001'")).rows).toEqual([{ id: who.personId }]);
    expect(await count("people")).toBe(1);
    expect(recordInCrm).not.toHaveBeenCalled();
    // Run again, it still does nothing.
    expect(await approveSignup(id, deps)).toEqual({ ok: false, reason: "not_found" });
    expect(await count("people")).toBe(1);
  });

  it("an approval that finished first wins: the Google id can no longer be linked to someone else", async () => {
    const id = await ask("7001");
    const who = await existingPerson();
    expect(await approveSignup(id, deps)).toMatchObject({ ok: true, already: false });
    expect(await linkGoogle(who, "7001")).toBe("taken");
    expect(await signup(id)).toMatchObject({ status: "approved" });
    expect((await db.query("SELECT google_sub FROM people WHERE id = $1", [who.personId])).rows[0].google_sub).toBeNull();
  });

  it("a link and an approval of the same request at the same moment never both win", async () => {
    const id = await ask("7001");
    const who = await existingPerson();
    const [approved, linked] = await Promise.all([approveSignup(id, deps), linkGoogle(who, "7001")]);
    const holders = (await db.query("SELECT id FROM people WHERE google_sub = '7001'")).rows;
    expect(holders).toHaveLength(1);
    if (linked === "linked") {
      expect(approved).toEqual({ ok: false, reason: "not_found" });
      expect(holders[0].id).toBe(who.personId);
      expect(await signup(id)).toMatchObject({ status: "linked" });
    } else {
      expect(approved).toMatchObject({ ok: true });
      expect(holders[0].id).not.toBe(who.personId);
      expect(await signup(id)).toMatchObject({ status: "approved" });
    }
  });

  describe("the contact in the Zero One CRM", () => {
    it("is written once, after approval, with the email and the name", async () => {
      await approveSignup(await ask("7001", "Gil Hale", "gil@example.com"), deps);
      expect(recordInCrm).toHaveBeenCalledTimes(1);
      expect(recordInCrm).toHaveBeenCalledWith({ email: "gil@example.com", name: "Gil Hale" });
    });

    it("never fails the approval when it throws", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      recordInCrm.mockRejectedValue(new Error("the CRM is down at postgresql://secret"));
      const id = await ask("7001");
      expect((await approveSignup(id, deps)).ok).toBe(true);
      expect(await signup(id)).toMatchObject({ status: "approved" });
    });

    it("never holds the approval up past a short cap when it hangs", async () => {
      recordInCrm.mockImplementation(() => new Promise(() => undefined));
      const id = await ask("7001");
      const started = Date.now();
      expect((await approveSignup(id, { ...deps, crmCapMs: 100 })).ok).toBe(true);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(await signup(id)).toMatchObject({ status: "approved" });
    });
  });

  it.skipIf(!shared.available)("end to end: the approved person signs in and reaches a CRM of their own in the shared database", async () => {
    await shared.reset();
    vi.stubEnv("MONSOON_SHARED_DB_ADMIN_URL", shared.url());
    const id = await ask("7001", "Gil O'Hale \\'; DROP SCHEMA public CASCADE; --", "gil@example.com");
    const real = vi.fn(provisionSharedCrm);
    const r = await approveSignup(id, { provision: real, recordInCrm: recordInCrm as unknown as ApproveDeps["recordInCrm"] });
    if (r.ok) made.push(r.customerId);
    expect(r.ok).toBe(true);
    const found = await findPersonByGoogleSub("7001");
    const cookie = `monsoon_session=${signSession({ customerId: found!.customer.id, personId: found!.person.id, sessionNo: found!.person.sessionNo })}`;
    const auth = await requireAccount(new Request("http://localhost/api/monsoon/x", { headers: { cookie } }));
    if (!auth.ok) throw new Error("refused");
    expect(auth.account.canChangeKey).toBe(true);
    expect(auth.account.pipelines).toEqual([{ key: "pipeline", label: "Pipeline", defaultRole: DEFAULT_PIPELINE.defaultRole, connected: true }]);
    const seen = await auth.account.withDb("pipeline", async (crm) => ({
      owners: (await crm.query("SELECT key, display_name FROM owners")).rows,
      stages: (await crm.query("SELECT key, ord, label, terminal FROM stages ORDER BY ord")).rows,
      roles: (await crm.query("SELECT key, label FROM roles ORDER BY key")).rows,
      schema: (await crm.query("SELECT current_schema() AS s")).rows[0].s,
      me: (await crm.query("SELECT current_user::text AS u")).rows[0].u,
    }));
    const n = clientNames(found!.customer.id);
    expect(seen.schema).toBe(n.schema);
    expect(seen.me).toBe(n.role);
    // The name went into the script as text and came out as the same text.
    expect(seen.owners).toEqual([{ key: "GODS", display_name: "Gil O'Hale \\'; DROP SCHEMA public CASCADE; --" }]);
    expect(seen.stages).toEqual(DEFAULT_VOCABULARY.stages);
    expect(seen.roles).toEqual([...DEFAULT_VOCABULARY.roles].sort((a, b) => a.key.localeCompare(b.key)));
    const admin = await shared.connect();
    try {
      expect((await admin.query("SELECT to_regclass('public.people') AS t")).rows[0].t).not.toBeNull();
    } finally {
      await admin.end();
    }
  });
});
