import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
import { makeAccountsTestDb } from "../testing/db";
import { claudeFailure, claudeFailureResponse } from "../claude-failure";
import { buildAccount, NotConnected, type Account } from "./account";
import { loadClaudeKeyState, replaceClaudeKey } from "./claude-key";
import { encryptSecret } from "./crypto";
import { TrialPaused } from "./not-connected";
import { clearAccountCache, loadAccountRows } from "./store";
import { TRIAL_DAYS, TRIAL_USES, beginTrialUse, noteTrialKey, resetTrialMemo, startTrialClock, trialKeyHealth } from "./trial";

const db = makeAccountsTestDb();
const TRIAL_KEY = "sk-ant-api03-TRIALKEY-0123456789-tttt";
const OWN_KEY = "sk-ant-api03-OWNKEY-0123456789-oooo";
const PAUSED = "The free trial is paused. Add your own Claude key, or try again later.";

const refused = () => Object.assign(new Error("invalid x-api-key"), { status: 401 });
const noCredit = () => Object.assign(new Error("Your credit balance is too low"), { status: 400 });

describe.skipIf(!db.available)("the free trial", () => {
  let client: Client;
  beforeAll(async () => {
    await db.reset();
    client = await db.connect();
  });
  afterAll(async () => {
    await client?.end();
  });
  beforeEach(async () => {
    vi.stubEnv("MONSOON_ACCOUNTS_DATABASE_URL", db.url());
    vi.stubEnv("MONSOON_MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
    vi.stubEnv("MONSOON_TRIAL_CLAUDE_KEY", TRIAL_KEY);
    clearAccountCache();
    resetTrialMemo();
    await client.query("TRUNCATE trial_uses, trial_key_health, activity, setup_links, pipelines, people, customers, sign_in_attempts CASCADE");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** A customer with one person (its key person). `limit` null is a customer from before the trial. */
  async function seed(over: { limit?: number | null; started?: boolean; code?: string } = {}): Promise<{ cid: string; pid: string }> {
    const limit = over.limit === undefined ? 150 : over.limit;
    const cid = (await client.query("INSERT INTO customers (code, name, trial_uses_limit) VALUES ($1, 'Acme', $2) RETURNING id", [over.code ?? "acme-co", limit])).rows[0].id as string;
    const pid = (await client.query("INSERT INTO people (customer_id, display_name, owner_key, google_sub) VALUES ($1, 'Ann', 'AN', $2) RETURNING id", [cid, String(Date.now()) + Math.floor(Math.random() * 1e6)])).rows[0].id as string;
    await client.query("UPDATE customers SET key_person_id = $2 WHERE id = $1", [cid, pid]);
    if (over.started !== false && limit !== null) await startTrialClock(cid);
    return { cid, pid };
  }
  async function account(cid: string, pid: string): Promise<Account> {
    clearAccountCache();
    const rows = await loadAccountRows(cid, pid);
    if (!rows) throw new Error("no rows");
    return buildAccount(rows);
  }
  const uses = async (cid: string) => (await client.query("SELECT count(*)::int AS n FROM trial_uses WHERE customer_id = $1", [cid])).rows[0].n as number;
  const customerStatus = async (cid: string) => (await client.query("SELECT claude_status, claude_checked_at FROM customers WHERE id = $1", [cid])).rows[0];
  const health = async () => (await client.query("SELECT status FROM trial_key_health")).rows[0]?.status ?? null;
  const state = (cid: string, pid: string) => loadClaudeKeyState({ customer: { id: cid, code: "acme-co", name: "Acme", model: "m" }, person: { id: pid, name: "Ann", ownerKey: "AN" } });

  it("is 14 days or 150 uses", () => {
    expect([TRIAL_DAYS, TRIAL_USES]).toEqual([14, 150]);
  });

  describe("the clock", () => {
    it("starts once, for 14 days, and only for a customer who was given a trial", async () => {
      const { cid } = await seed({ started: false });
      const none = await client.query("SELECT trial_started_at, trial_ends_at FROM customers WHERE id = $1", [cid]);
      expect(none.rows[0]).toEqual({ trial_started_at: null, trial_ends_at: null });

      await startTrialClock(cid);
      const first = (await client.query("SELECT trial_started_at, trial_ends_at, (trial_ends_at - trial_started_at) = interval '14 days' AS two_weeks FROM customers WHERE id = $1", [cid])).rows[0];
      expect(first.trial_started_at).toBeInstanceOf(Date);
      expect(first.two_weeks).toBe(true);

      await startTrialClock(cid);
      const again = (await client.query("SELECT trial_started_at, trial_ends_at FROM customers WHERE id = $1", [cid])).rows[0];
      expect(again.trial_started_at).toEqual(first.trial_started_at);
      expect(again.trial_ends_at).toEqual(first.trial_ends_at);

      const old = await seed({ limit: null, code: "old-co" });
      await startTrialClock(old.cid);
      expect((await client.query("SELECT trial_started_at FROM customers WHERE id = $1", [old.cid])).rows[0].trial_started_at).toBeNull();
    });

    it("does not start while there is no trial key, and never throws", async () => {
      const { cid } = await seed({ started: false });
      vi.stubEnv("MONSOON_TRIAL_CLAUDE_KEY", "");
      await startTrialClock(cid);
      expect((await client.query("SELECT trial_started_at FROM customers WHERE id = $1", [cid])).rows[0].trial_started_at).toBeNull();
      vi.stubEnv("MONSOON_TRIAL_CLAUDE_KEY", TRIAL_KEY);
      vi.stubEnv("MONSOON_ACCOUNTS_DATABASE_URL", "");
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      await expect(startTrialClock(cid)).resolves.toBeUndefined();
    });
  });

  describe("the gate", () => {
    it("anthropic() refuses the trial key until the gate has run on this account, then uses it and records one use", async () => {
      const { cid, pid } = await seed();
      const a = await account(cid, pid);
      expect(() => a.anthropic({ timeout: 1000 })).toThrow(NotConnected);
      expect(await uses(cid)).toBe(0);

      await a.beginAi("read");
      expect(a.anthropic({ timeout: 1000 }).apiKey).toBe(TRIAL_KEY);
      const rows = await client.query("SELECT customer_id, person_id, kind FROM trial_uses");
      expect(rows.rows).toEqual([{ customer_id: cid, person_id: pid, kind: "read" }]);

      // The next request is a new account object: it starts closed again.
      const b = await account(cid, pid);
      expect(() => b.anthropic({ timeout: 1000 })).toThrow(NotConnected);
      expect(await uses(cid)).toBe(1);
    });

    it("an existing customer (no trial given) never gets the trial key, even with it set", async () => {
      const { cid, pid } = await seed({ limit: null });
      const a = await account(cid, pid);
      await a.beginAi("ask");
      expect(() => a.anthropic({ timeout: 1000 })).toThrow(NotConnected);
      expect(await uses(cid)).toBe(0);
      expect(await beginTrialUse(cid, pid, "ask")).toEqual({ granted: false, probe: false });
    });

    it("with no trial key set there is no trial for anyone", async () => {
      const { cid, pid } = await seed();
      vi.stubEnv("MONSOON_TRIAL_CLAUDE_KEY", "  ");
      const a = await account(cid, pid);
      await a.beginAi("ask");
      expect(() => a.anthropic({ timeout: 1000 })).toThrow(NotConnected);
      expect(await uses(cid)).toBe(0);
    });

    it("a trial that has not started, has run out of days, or of uses, is the missing key of today", async () => {
      const early = await seed({ started: false });
      const a = await account(early.cid, early.pid);
      await a.beginAi("ask");
      expect(() => a.anthropic({ timeout: 1000 })).toThrow(NotConnected);

      const late = await seed({ code: "late-co" });
      await client.query("UPDATE customers SET trial_started_at = now() - interval '15 days', trial_ends_at = now() - interval '1 day' WHERE id = $1", [late.cid]);
      const b = await account(late.cid, late.pid);
      await b.beginAi("ask");
      expect(() => b.anthropic({ timeout: 1000 })).toThrow(NotConnected);

      const spent = await seed({ limit: 2, code: "spent-co" });
      for (const kind of ["read", "tidy"] as const) {
        const c = await account(spent.cid, spent.pid);
        await c.beginAi(kind);
        expect(c.anthropic({ timeout: 1000 }).apiKey).toBe(TRIAL_KEY);
      }
      const d = await account(spent.cid, spent.pid);
      await d.beginAi("research");
      let thrown: unknown;
      try {
        d.anthropic({ timeout: 1000 });
      } catch (err) {
        thrown = err;
      }
      expect(claudeFailure(thrown)).toBe("claude_key_missing");
      expect(await uses(early.cid)).toBe(0);
      expect(await uses(late.cid)).toBe(0);
      expect(await uses(spent.cid)).toBe(2);
    });

    it("parallel requests at the limit do not run past it, and nothing is granted afterwards", async () => {
      const { cid, pid } = await seed({ limit: 5 });
      for (let i = 0; i < 3; i++) expect((await beginTrialUse(cid, pid, "ask")).granted).toBe(true);
      const inFlight = 12;
      const results = await Promise.all(Array.from({ length: inFlight }, () => beginTrialUse(cid, pid, "read")));
      const granted = results.filter((r) => r.granted).length;
      expect(granted).toBeGreaterThanOrEqual(1);
      // Never more than the uses that were left plus the requests in flight; in practice the two left.
      expect(granted).toBeLessThanOrEqual(2 + inFlight);
      expect(granted).toBeLessThanOrEqual(2 + 2);
      const after = await uses(cid);
      expect(after).toBeLessThanOrEqual(3 + inFlight);
      for (let i = 0; i < 5; i++) expect((await beginTrialUse(cid, pid, "ask")).granted).toBe(false);
      expect(await uses(cid)).toBe(after);
    });

    it("an own key always wins: the gate records nothing and the client uses the customer's key", async () => {
      const { cid, pid } = await seed();
      expect(await replaceClaudeKey(cid, pid, OWN_KEY)).toBe(true);
      const a = await account(cid, pid);
      await a.beginAi("ask");
      expect(a.anthropic({ timeout: 1000 }).apiKey).toBe(OWN_KEY);
      expect(await uses(cid)).toBe(0);
      // Even for an account object built before the key was saved, the database decides.
      expect(await beginTrialUse(cid, pid, "ask")).toEqual({ granted: false, probe: false });
    });

    it("a suspended customer gets nothing", async () => {
      const { cid, pid } = await seed();
      await client.query("UPDATE customers SET status = 'suspended' WHERE id = $1", [cid]);
      expect((await beginTrialUse(cid, pid, "ask")).granted).toBe(false);
    });
  });

  describe("the trial key's health", () => {
    it("a trial call's failure goes to the trial key's health, never onto the customer", async () => {
      const { cid, pid } = await seed();
      const a = await account(cid, pid);
      await a.beginAi("read");
      a.anthropic({ timeout: 1000 });
      await a.noteClaude(refused());
      expect(await health()).toBe("key_rejected");
      expect(await customerStatus(cid)).toEqual({ claude_status: null, claude_checked_at: null });
      // What the person is told is the pause, not that their key was refused.
      expect(claudeFailure(a.aiError(refused()))).toBe("claude_trial_paused");

      await client.query("UPDATE trial_key_health SET checked_at = now() - interval '2 minutes'");
      const b = await account(cid, pid);
      await b.beginAi("read");
      b.anthropic({ timeout: 1000 });
      await b.noteClaude(noCredit());
      expect(await health()).toBe("no_credit");
      expect(await customerStatus(cid)).toEqual({ claude_status: null, claude_checked_at: null });
    });

    it("a trial call that worked records ok on the trial key, at most once a minute, and not on the customer", async () => {
      const { cid, pid } = await seed();
      const a = await account(cid, pid);
      await a.beginAi("read");
      a.anthropic({ timeout: 1000 });
      await a.noteClaude();
      expect(await health()).toBe("ok");
      expect(await customerStatus(cid)).toEqual({ claude_status: null, claude_checked_at: null });
      const first = (await client.query("SELECT checked_at FROM trial_key_health")).rows[0].checked_at as Date;

      const b = await account(cid, pid);
      await b.beginAi("read");
      b.anthropic({ timeout: 1000 });
      await b.noteClaude();
      expect((await client.query("SELECT checked_at FROM trial_key_health")).rows[0].checked_at).toEqual(first);
    });

    it("an own key's result is still written onto the customer, and a busy Claude says nothing about the trial key", async () => {
      const own = await seed({ limit: null });
      await client.query("UPDATE customers SET claude_key_enc = $2 WHERE id = $1", [own.cid, encryptSecret(OWN_KEY, own.cid, "claude_key")]);
      const a = await account(own.cid, own.pid);
      await a.beginAi("ask");
      await a.noteClaude(refused());
      expect((await customerStatus(own.cid)).claude_status).toBe("key_rejected");
      expect(await health()).toBeNull();
      expect(a.aiError(refused())).toMatchObject({ status: 401 });

      const { cid, pid } = await seed({ code: "trial-co" });
      const b = await account(cid, pid);
      await b.beginAi("ask");
      b.anthropic({ timeout: 1000 });
      const busy = Object.assign(new Error("overloaded"), { status: 529 });
      await b.noteClaude(busy);
      expect(await health()).toBeNull();
      expect(claudeFailure(b.aiError(busy))).toBe("claude_busy");
    });

    it("while the trial key is failing, trial requests are paused without a use; one a minute may try again", async () => {
      const { cid, pid } = await seed();
      await noteTrialKey("key_rejected");

      const a = await account(cid, pid);
      const err = await a.beginAi("ask").then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(TrialPaused);
      expect((err as Error).message).toBe(PAUSED);
      expect(() => a.anthropic({ timeout: 1000 })).toThrow(NotConnected);
      expect(await uses(cid)).toBe(0);
      const res = claudeFailureResponse(err)!;
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "claude_trial_paused" });

      // A minute on: one of several parallel requests gets through, the rest stay paused.
      await client.query("UPDATE trial_key_health SET checked_at = now() - interval '61 seconds'");
      const tries = await Promise.all(
        Array.from({ length: 6 }, () =>
          beginTrialUse(cid, pid, "ask").then(
            (r) => r,
            (e: unknown) => e,
          ),
        ),
      );
      expect(tries.filter((t) => t instanceof TrialPaused)).toHaveLength(5);
      expect(tries.filter((t) => !(t instanceof TrialPaused))).toEqual([{ granted: true, probe: true }]);
      expect(await uses(cid)).toBe(1);

      // That one call worked: the key is healthy again at once, whatever was noted a moment ago.
      await noteTrialKey("ok", true);
      expect(await health()).toBe("ok");
      expect(await beginTrialUse(cid, pid, "ask")).toEqual({ granted: true, probe: false });
    });

    it("a failing trial key pauses nobody who is not on trial", async () => {
      await noteTrialKey("no_credit");
      const old = await seed({ limit: null });
      const a = await account(old.cid, old.pid);
      await a.beginAi("ask");
      expect(() => a.anthropic({ timeout: 1000 })).toThrow(NotConnected);
    });

    it("trialKeyHealth says unset, ok, or what went wrong", async () => {
      expect(await trialKeyHealth()).toBe("ok");
      await noteTrialKey("no_credit");
      expect(await trialKeyHealth()).toBe("no_credit");
      await noteTrialKey("key_rejected");
      expect(await trialKeyHealth()).toBe("key_rejected");
      vi.stubEnv("MONSOON_TRIAL_CLAUDE_KEY", "");
      expect(await trialKeyHealth()).toBe("unset");
    });
  });
});
