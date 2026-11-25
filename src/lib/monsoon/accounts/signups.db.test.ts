import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
import { makeAccountsTestDb } from "../testing/db";
import {
  GOOGLE_ATTEMPT_CODE,
  GOOGLE_ATTEMPT_LIMIT,
  beginGoogleAttempt,
  settleGoogleAttempt,
  declineSignup,
  findPersonByGoogleSub,
  findSignup,
  googleIdHeld,
  googleLinked,
  linkGoogle,
  listSignups,
  reopenSignup,
  requestSignup,
} from "./signups";

const db = makeAccountsTestDb();
const NONE = "00000000-0000-4000-8000-000000000000";

describe.skipIf(!db.available)("sign-up requests and Google links", { timeout: 20_000 }, () => {
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
    await client.query("TRUNCATE activity, setup_links, pipelines, people, customers, sign_in_attempts, signups CASCADE");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  type Who = { customerId: string; personId: string; sessionNo: number };
  async function seed(): Promise<{ ann: Who; bob: Who; oz: Who }> {
    const customer = async (code: string) =>
      (await client.query("INSERT INTO customers (code, name) VALUES ($1, $1) RETURNING id", [code])).rows[0].id as string;
    const person = async (customerId: string, name: string, owner: string): Promise<Who> => ({
      customerId,
      sessionNo: 1,
      personId: (
        await client.query(
          "INSERT INTO people (customer_id, display_name, owner_key, passcode_hash) VALUES ($1, $2, $3, 'h') RETURNING id",
          [customerId, name, owner],
        )
      ).rows[0].id as string,
    });
    const acme = await customer("acme-co");
    const other = await customer("other-co");
    return { ann: await person(acme, "Ann", "AN"), bob: await person(acme, "Bob", "BO"), oz: await person(other, "Oz", "OZ") };
  }
  const ask = (sub: string, addressHash = "addr-1", email = `${sub}@example.com`, name = `N${sub}`) =>
    requestSignup({ sub, email, name, addressHash });
  const subOf = async (who: Who) =>
    (await client.query("SELECT google_sub FROM people WHERE id = $1", [who.personId])).rows[0].google_sub as string | null;

  describe("requestSignup and findSignup", () => {
    it("creates a pending request that can be found by Google id only", async () => {
      expect(await findSignup("1001")).toBeNull();
      expect(await ask("1001", "addr-1", "gil@example.com", "Gil Hale")).toBe("created");
      const row = await findSignup("1001");
      expect(row).toMatchObject({ sub: "1001", email: "gil@example.com", name: "Gil Hale", status: "pending", customerId: null });
      expect(row?.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(row?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(Object.keys(row ?? {}).sort()).toEqual(["createdAt", "customerId", "email", "id", "name", "status", "sub"]);
      // Never by email.
      expect(await findSignup("gil@example.com")).toBeNull();
      const raw = await client.query("SELECT address_hash, decided_at FROM signups");
      expect(raw.rows).toEqual([{ address_hash: "addr-1", decided_at: null }]);
    });

    it("asking again with the same Google id adds no second row and changes nothing", async () => {
      expect(await ask("1001", "addr-1", "gil@example.com", "Gil")).toBe("created");
      expect(await ask("1001", "addr-2", "other@example.com", "Other")).toBe("created");
      const rows = await client.query("SELECT email, name, address_hash FROM signups");
      expect(rows.rows).toEqual([{ email: "gil@example.com", name: "Gil", address_hash: "addr-1" }]);
    });

    it("creates nothing for a Google id that already belongs to a person", async () => {
      const { ann } = await seed();
      await client.query("UPDATE people SET google_sub = '1001' WHERE id = $1", [ann.personId]);
      await ask("1001");
      expect((await client.query("SELECT count(*)::int AS n FROM signups")).rows[0].n).toBe(0);
    });

    it("refuses a Google id that is not digits, and clips a long name and email", async () => {
      await expect(ask("abc")).rejects.toThrow();
      await expect(ask("")).rejects.toThrow();
      await expect(ask("1".repeat(65))).rejects.toThrow();
      expect((await client.query("SELECT count(*)::int AS n FROM signups")).rows[0].n).toBe(0);
      expect(await ask("1002", "addr-1", "e".repeat(500), "n".repeat(500))).toBe("created");
      const row = await findSignup("1002");
      expect(row?.email.length).toBe(320);
      expect(row?.name.length).toBe(200);
    });

    it("too_many: the sixth request from one address within 24 hours, whatever became of the first five", async () => {
      for (let i = 0; i < 5; i++) expect(await ask(`20${i}`, "addr-busy")).toBe("created");
      await client.query("UPDATE signups SET status = 'declined', decided_at = now() WHERE google_sub = '200'");
      expect(await ask("206", "addr-busy")).toBe("too_many");
      expect(await findSignup("206")).toBeNull();
      // Another address is unaffected, and so is this one a day later.
      expect(await ask("207", "addr-quiet")).toBe("created");
      await client.query("UPDATE signups SET created_at = now() - interval '25 hours' WHERE google_sub = '201'");
      expect(await ask("208", "addr-busy")).toBe("created");
    });

    it("paused: at 200 pending requests no more are taken; declined and approved ones do not count", async () => {
      await client.query(
        `INSERT INTO signups (google_sub, email, name, address_hash)
         SELECT (5000 + g)::text, 'x@example.com', 'X', 'bulk-' || g FROM generate_series(1, 199) g`,
      );
      await client.query(
        `INSERT INTO signups (google_sub, email, name, address_hash, status)
         SELECT (6000 + g)::text, 'x@example.com', 'X', 'done-' || g, CASE WHEN g % 2 = 0 THEN 'declined' ELSE 'approved' END
           FROM generate_series(1, 50) g`,
      );
      expect(await ask("7001", "addr-a")).toBe("created");
      expect(await ask("7002", "addr-b")).toBe("paused");
      expect(await findSignup("7002")).toBeNull();
      await client.query("UPDATE signups SET status = 'declined' WHERE google_sub = '5001'");
      expect(await ask("7002", "addr-b")).toBe("created");
    });

    it("parallel requests cannot pass the cap", async () => {
      await client.query(
        `INSERT INTO signups (google_sub, email, name, address_hash)
         SELECT (5000 + g)::text, 'x@example.com', 'X', 'bulk-' || g FROM generate_series(1, 197) g`,
      );
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => ask(`800${i}`, `par-${i}`)));
      expect(results.filter((r) => r === "created")).toHaveLength(3);
      expect(results.filter((r) => r === "paused")).toHaveLength(7);
      expect((await client.query("SELECT count(*)::int AS n FROM signups WHERE status = 'pending'")).rows[0].n).toBe(200);
    });

    it("parallel requests from one address cannot pass the address limit", async () => {
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => ask(`900${i}`, "one-address")));
      expect(results.filter((r) => r === "created")).toHaveLength(5);
      expect(results.filter((r) => r === "too_many")).toHaveLength(5);
    });
  });

  describe("listSignups, declineSignup, reopenSignup", () => {
    it("lists pending first, newest first, at most 300", async () => {
      await client.query(
        `INSERT INTO signups (google_sub, email, name, address_hash, status, created_at) VALUES
           ('1', 'a@example.com', 'Old pending', 'h', 'pending', now() - interval '3 days'),
           ('2', 'b@example.com', 'New declined', 'h', 'declined', now() - interval '1 hour'),
           ('3', 'c@example.com', 'New pending', 'h', 'pending', now() - interval '2 hours'),
           ('4', 'd@example.com', 'Old approved', 'h', 'approved', now() - interval '5 days')`,
      );
      const rows = await listSignups();
      expect(rows.map((r) => r.name)).toEqual(["New pending", "Old pending", "New declined", "Old approved"]);
      expect(rows[0]).toMatchObject({ sub: "3", email: "c@example.com", status: "pending", customerId: null });
      await client.query(
        `INSERT INTO signups (google_sub, email, name, address_hash, status)
         SELECT (9000 + g)::text, 'x@example.com', 'X', 'h', 'declined' FROM generate_series(1, 320) g`,
      );
      const many = await listSignups();
      expect(many).toHaveLength(300);
      expect(many.slice(0, 2).map((r) => r.name)).toEqual(["New pending", "Old pending"]);
    });

    it("decline turns a pending request into declined, once, and deletes nothing", async () => {
      await ask("1001");
      const id = (await findSignup("1001"))!.id;
      expect(await declineSignup(id)).toBe(true);
      expect(await findSignup("1001")).toMatchObject({ status: "declined" });
      expect((await client.query("SELECT decided_at FROM signups")).rows[0].decided_at).toBeInstanceOf(Date);
      expect(await declineSignup(id)).toBe(false);
      expect(await declineSignup(NONE)).toBe(false);
      expect(await declineSignup("not-an-id")).toBe(false);
      expect((await client.query("SELECT count(*)::int AS n FROM signups")).rows[0].n).toBe(1);
    });

    it("decline never touches an approved request, and reopen only a declined one", async () => {
      const { ann } = await seed();
      await ask("1001");
      await ask("1002");
      const approved = (await findSignup("1001"))!.id;
      const pending = (await findSignup("1002"))!.id;
      await client.query("UPDATE signups SET status = 'approved', customer_id = $2, decided_at = now() WHERE id = $1", [approved, ann.customerId]);
      expect(await declineSignup(approved)).toBe(false);
      expect(await reopenSignup(approved)).toBe(false);
      expect(await reopenSignup(pending)).toBe(false);
      expect(await findSignup("1001")).toMatchObject({ status: "approved", customerId: ann.customerId });
      expect(await declineSignup(pending)).toBe(true);
      expect(await reopenSignup(pending)).toBe(true);
      expect(await findSignup("1002")).toMatchObject({ status: "pending" });
      expect((await client.query("SELECT decided_at FROM signups WHERE id = $1", [pending])).rows[0].decided_at).toBeNull();
      expect(await reopenSignup("not-an-id")).toBe(false);
    });
  });

  describe("findPersonByGoogleSub", () => {
    it("finds the person and customer by Google id, and nobody by email or an unknown id", async () => {
      const { ann } = await seed();
      await client.query("UPDATE people SET google_sub = '1001', email = 'ann@example.com' WHERE id = $1", [ann.personId]);
      const found = await findPersonByGoogleSub("1001");
      expect(found?.person).toMatchObject({ id: ann.personId, customerId: ann.customerId, displayName: "Ann", ownerKey: "AN", sessionNo: 1, status: "active" });
      expect(found?.customer).toMatchObject({ id: ann.customerId, code: "acme-co", status: "active" });
      expect(await findPersonByGoogleSub("1002")).toBeNull();
      expect(await findPersonByGoogleSub("ann@example.com")).toBeNull();
      expect(await findPersonByGoogleSub("")).toBeNull();
    });

    it("finds a person with no passcode", async () => {
      const { ann } = await seed();
      const id = (
        await client.query("INSERT INTO people (customer_id, display_name, owner_key, google_sub) VALUES ($1, 'Gil', 'GI', '1001') RETURNING id", [
          ann.customerId,
        ])
      ).rows[0].id;
      const found = await findPersonByGoogleSub("1001");
      expect(found?.person).toMatchObject({ id, passcodeHash: null });
    });

    it("finds nobody when the person or the customer is suspended", async () => {
      const { ann } = await seed();
      await client.query("UPDATE people SET google_sub = '1001' WHERE id = $1", [ann.personId]);
      await client.query("UPDATE people SET status = 'suspended' WHERE id = $1", [ann.personId]);
      expect(await findPersonByGoogleSub("1001")).toBeNull();
      await client.query("UPDATE people SET status = 'active' WHERE id = $1", [ann.personId]);
      await client.query("UPDATE customers SET status = 'suspended' WHERE id = $1", [ann.customerId]);
      expect(await findPersonByGoogleSub("1001")).toBeNull();
    });
  });

  describe("googleIdHeld", () => {
    it("is true for a Google id on any person, active or suspended, and false otherwise", async () => {
      const { ann } = await seed();
      expect(await googleIdHeld("1001")).toBe(false);
      await client.query("UPDATE people SET google_sub = '1001', status = 'suspended' WHERE id = $1", [ann.personId]);
      expect(await findPersonByGoogleSub("1001")).toBeNull();
      expect(await googleIdHeld("1001")).toBe(true);
      await client.query("UPDATE people SET status = 'active' WHERE id = $1", [ann.personId]);
      await client.query("UPDATE customers SET status = 'suspended' WHERE id = $1", [ann.customerId]);
      expect(await googleIdHeld("1001")).toBe(true);
      expect(await googleIdHeld("1002")).toBe(false);
      expect(await googleIdHeld("ann@example.com")).toBe(false);
    });
  });

  describe("Google callback attempts", () => {
    const failed = async (address: string, n: number) => {
      for (let i = 0; i < n; i++) expect(await beginGoogleAttempt(address)).toMatch(/^\d+$/);
    };

    it("records each attempt as a failure until it is settled, under a code no company can have", async () => {
      const id = await beginGoogleAttempt("addr-1");
      expect(id).toMatch(/^\d+$/);
      expect(GOOGLE_ATTEMPT_CODE).not.toMatch(/^[a-z0-9-]{3,32}$/);
      let rows = await client.query("SELECT code, address_hash, ok, person_id FROM sign_in_attempts");
      expect(rows.rows).toEqual([{ code: GOOGLE_ATTEMPT_CODE, address_hash: "addr-1", ok: false, person_id: null }]);
      await settleGoogleAttempt(id as string);
      rows = await client.query("SELECT ok FROM sign_in_attempts");
      expect(rows.rows).toEqual([{ ok: true }]);
    });

    it("refuses an address after ten failures in fifteen minutes; the refusal does not count", async () => {
      await failed("addr-busy", GOOGLE_ATTEMPT_LIMIT);
      expect(GOOGLE_ATTEMPT_LIMIT).toBe(10);
      expect(await beginGoogleAttempt("addr-busy")).toBeNull();
      expect(await beginGoogleAttempt("addr-busy")).toBeNull();
      const rows = await client.query("SELECT ok, count(*)::int AS n FROM sign_in_attempts GROUP BY ok ORDER BY ok NULLS LAST");
      expect(rows.rows).toEqual([{ ok: false, n: 10 }, { ok: null, n: 2 }]);
      // Another address is unaffected, and so is this one once the failures are old.
      expect(await beginGoogleAttempt("addr-quiet")).toMatch(/^\d+$/);
      await client.query("UPDATE sign_in_attempts SET at = now() - interval '16 minutes' WHERE address_hash = 'addr-busy'");
      expect(await beginGoogleAttempt("addr-busy")).toMatch(/^\d+$/);
    });

    it("successes do not count, and failed passcode sign-ins from the same address are separate", async () => {
      for (let i = 0; i < 15; i++) await settleGoogleAttempt((await beginGoogleAttempt("addr-ok")) as string);
      await client.query(
        "INSERT INTO sign_in_attempts (code, address_hash, ok) SELECT 'acme-co', 'addr-ok', false FROM generate_series(1, 30)",
      );
      expect(await beginGoogleAttempt("addr-ok")).toMatch(/^\d+$/);
    });

    it("parallel attempts from one address cannot pass the limit", async () => {
      const results = await Promise.all(Array.from({ length: 16 }, () => beginGoogleAttempt("addr-par")));
      expect(results.filter((r) => r !== null).length).toBeLessThanOrEqual(GOOGLE_ATTEMPT_LIMIT);
      expect(results.filter((r) => r === null).length).toBeGreaterThanOrEqual(6);
    });
  });

  describe("googleLinked", () => {
    it("is true only for the person who has a Google id, in their own customer", async () => {
      const { ann, bob, oz } = await seed();
      expect(await googleLinked(ann)).toBe(false);
      expect(await linkGoogle(ann, "1001")).toBe("linked");
      expect(await googleLinked(ann)).toBe(true);
      expect(await googleLinked(bob)).toBe(false);
      expect(await googleLinked(oz)).toBe(false);
      // The person's id under another customer is nobody.
      expect(await googleLinked({ customerId: oz.customerId, personId: ann.personId })).toBe(false);
    });

    it("is false for ids that are not ids, without asking the database", async () => {
      vi.stubEnv("MONSOON_ACCOUNTS_DATABASE_URL", "");
      expect(await googleLinked({ customerId: "x", personId: NONE })).toBe(false);
      expect(await googleLinked({ customerId: NONE, personId: "' OR 1=1" })).toBe(false);
    });
  });

  describe("linkGoogle", () => {
    it("links a free Google id to the person and records it", async () => {
      const { ann, bob } = await seed();
      expect(await linkGoogle(ann, "1001")).toBe("linked");
      expect(await subOf(ann)).toBe("1001");
      expect(await subOf(bob)).toBeNull();
      const activity = await client.query("SELECT customer_id, person_id, action FROM activity");
      expect(activity.rows).toEqual([{ customer_id: ann.customerId, person_id: ann.personId, action: "google_link" }]);
      // Again with the same id: still linked, no second activity row.
      expect(await linkGoogle(ann, "1001")).toBe("linked");
      expect((await client.query("SELECT count(*)::int AS n FROM activity")).rows[0].n).toBe(1);
    });

    it("taken: the Google id is on another person, in the same company or another", async () => {
      const { ann, bob, oz } = await seed();
      expect(await linkGoogle(ann, "1001")).toBe("linked");
      expect(await linkGoogle(bob, "1001")).toBe("taken");
      expect(await linkGoogle(oz, "1001")).toBe("taken");
      expect(await subOf(bob)).toBeNull();
      expect(await subOf(oz)).toBeNull();
      expect(await subOf(ann)).toBe("1001");
    });

    it("taken: the Google id is on an approved signup", async () => {
      const { ann } = await seed();
      await ask("1003");
      await client.query("UPDATE signups SET status = 'approved' WHERE google_sub = '1003'");
      expect(await linkGoogle(ann, "1003")).toBe("taken");
      expect(await subOf(ann)).toBeNull();
      expect(await findSignup("1003")).toMatchObject({ status: "approved" });
      expect((await client.query("SELECT count(*)::int AS n FROM activity")).rows[0].n).toBe(0);
    });

    it("a stray Sign in with Google does not block linking: a waiting request for that Google id becomes linked", async () => {
      const { ann } = await seed();
      // Ann tapped Sign in with Google before linking: a request now waits for her Google id.
      await ask("1001");
      expect(await linkGoogle(ann, "1001")).toBe("linked");
      expect(await subOf(ann)).toBe("1001");
      expect(await findPersonByGoogleSub("1001")).toMatchObject({ person: { id: ann.personId } });
      const row = (await client.query("SELECT status, customer_id, decided_at FROM signups WHERE google_sub = '1001'")).rows[0];
      expect(row).toMatchObject({ status: "linked", customer_id: null });
      expect(row.decided_at).toBeInstanceOf(Date);
      expect((await client.query("SELECT count(*)::int AS n FROM signups")).rows[0].n).toBe(1);
      expect((await client.query("SELECT action FROM activity")).rows).toEqual([{ action: "google_link" }]);
    });

    it("a declined request for that Google id does not block linking either", async () => {
      const { ann } = await seed();
      await ask("1002");
      await client.query("UPDATE signups SET status = 'declined', decided_at = now() WHERE google_sub = '1002'");
      expect(await linkGoogle(ann, "1002")).toBe("linked");
      expect(await subOf(ann)).toBe("1002");
      expect(await findSignup("1002")).toMatchObject({ status: "linked" });
    });

    it("a waiting request does not let a Google id onto a second person", async () => {
      const { ann, bob, oz } = await seed();
      await ask("1001");
      expect(await linkGoogle(ann, "1001")).toBe("linked");
      expect(await linkGoogle(bob, "1001")).toBe("taken");
      expect(await linkGoogle(oz, "1001")).toBe("taken");
      // The person who has it may ask again, and after a reset took the link away, link once more.
      expect(await linkGoogle(ann, "1001")).toBe("linked");
      await client.query("UPDATE people SET google_sub = NULL WHERE id = $1", [ann.personId]);
      expect(await linkGoogle(ann, "1001")).toBe("linked");
      expect(await subOf(ann)).toBe("1001");
      expect(await findSignup("1001")).toMatchObject({ status: "linked" });
    });

    it("a linked request is not listed, cannot be declined or re-opened, and does not count towards the 200", async () => {
      const { ann } = await seed();
      await ask("1001");
      const id = (await findSignup("1001"))!.id;
      expect(await linkGoogle(ann, "1001")).toBe("linked");
      expect(await listSignups()).toEqual([]);
      expect(await declineSignup(id)).toBe(false);
      expect(await reopenSignup(id)).toBe(false);
      expect(await findSignup("1001")).toMatchObject({ status: "linked" });
      await client.query(
        `INSERT INTO signups (google_sub, email, name, address_hash)
         SELECT (5000 + g)::text, 'x@example.com', 'X', 'bulk-' || g FROM generate_series(1, 199) g`,
      );
      expect(await ask("7001", "addr-a")).toBe("created");
      expect(await ask("7002", "addr-b")).toBe("paused");
      // Asking again with the linked Google id adds and changes nothing.
      expect(await ask("1001", "addr-c")).toBe("created");
      expect(await findSignup("1001")).toMatchObject({ status: "linked" });
    });

    it("two people linking a Google id that has a waiting request, at once: exactly one wins", async () => {
      const { ann, bob, oz } = await seed();
      await ask("1001");
      const results = await Promise.all([linkGoogle(ann, "1001"), linkGoogle(bob, "1001"), linkGoogle(oz, "1001")]);
      expect(results.filter((r) => r === "linked")).toHaveLength(1);
      expect(results.filter((r) => r === "taken")).toHaveLength(2);
      expect((await client.query("SELECT count(*)::int AS n FROM people WHERE google_sub = '1001'")).rows[0].n).toBe(1);
    });

    it("taken: the person already has a different Google id (a link is never replaced)", async () => {
      const { ann } = await seed();
      expect(await linkGoogle(ann, "1001")).toBe("linked");
      expect(await linkGoogle(ann, "1002")).toBe("taken");
      expect(await subOf(ann)).toBe("1001");
    });

    it("taken: the person is not in that customer, or the id is not a Google id", async () => {
      const { ann, oz } = await seed();
      expect(await linkGoogle({ customerId: oz.customerId, personId: ann.personId, sessionNo: 1 }, "1001")).toBe("taken");
      expect(await linkGoogle({ customerId: ann.customerId, personId: NONE, sessionNo: 1 }, "1001")).toBe("taken");
      expect(await linkGoogle(ann, "abc")).toBe("taken");
      expect(await linkGoogle(ann, "")).toBe("taken");
      expect(await subOf(ann)).toBeNull();
    });

    it("taken: the person or their customer has been suspended since the link was started", async () => {
      const { ann, oz } = await seed();
      await client.query("UPDATE people SET status = 'suspended' WHERE id = $1", [ann.personId]);
      await client.query("UPDATE customers SET status = 'suspended' WHERE id = $1", [oz.customerId]);
      expect(await linkGoogle(ann, "1001")).toBe("taken");
      expect(await linkGoogle(oz, "1002")).toBe("taken");
      expect(await subOf(ann)).toBeNull();
      expect(await subOf(oz)).toBeNull();
    });

    it("expired: the seat was reset after the link was started, so the link does nothing", async () => {
      const { ann } = await seed();
      await ask("1001");
      // The admin reset Ann's seat while she was at Google: her session number moved on.
      await client.query("UPDATE people SET session_no = session_no + 1 WHERE id = $1", [ann.personId]);
      expect(await linkGoogle(ann, "1001")).toBe("expired");
      expect(await linkGoogle(ann, "1002")).toBe("expired");
      expect(await subOf(ann)).toBeNull();
      expect(await findSignup("1001")).toMatchObject({ status: "pending" });
      expect((await client.query("SELECT count(*)::int AS n FROM activity")).rows[0].n).toBe(0);
      // A link started under the new session works.
      expect(await linkGoogle({ ...ann, sessionNo: 2 }, "1001")).toBe("linked");
      expect(await subOf(ann)).toBe("1001");
      // And asking again for a link that is already there, under an old session, is still expired.
      expect(await linkGoogle(ann, "1001")).toBe("expired");
      for (const sessionNo of [0, 1.5, NaN, "2"]) {
        expect(await linkGoogle({ ...ann, sessionNo: sessionNo as number }, "1001"), String(sessionNo)).toBe("expired");
      }
    });

    it("two people linking the same Google id at once: exactly one wins", async () => {
      const { ann, bob, oz } = await seed();
      const results = await Promise.all([linkGoogle(ann, "1001"), linkGoogle(bob, "1001"), linkGoogle(oz, "1001")]);
      expect(results.filter((r) => r === "linked")).toHaveLength(1);
      expect(results.filter((r) => r === "taken")).toHaveLength(2);
      expect((await client.query("SELECT count(*)::int AS n FROM people WHERE google_sub = '1001'")).rows[0].n).toBe(1);
    });

    it("a link and a request for the same Google id at once never leave both a person and a waiting request", async () => {
      const { ann } = await seed();
      await Promise.all([linkGoogle(ann, "1001"), ask("1001")]);
      // The link always lands. A request that got in first is marked linked; one that came second adds nothing.
      expect(await subOf(ann)).toBe("1001");
      const signups = (await client.query("SELECT status FROM signups WHERE google_sub = '1001'")).rows;
      expect(signups.length).toBeLessThanOrEqual(1);
      for (const s of signups) expect(s.status).toBe("linked");
    });
  });
});
