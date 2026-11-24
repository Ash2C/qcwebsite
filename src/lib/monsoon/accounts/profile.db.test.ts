import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
import { makeAccountsTestDb } from "../testing/db";
import { addUserNote, loadAskContext, loadUserPage, saveUserPage, type PageInput } from "./profile";
import { clearAccountCache, loadAccountRows } from "./store";

const db = makeAccountsTestDb();

const INPUT: PageInput = {
  name: "Ann Lee",
  phone: "+31 6 1234 5678",
  email: "ann@example.com",
  company: "Acme Ltd",
  website: "https://acme.example",
  roleObjectives: "Partner.\nRaise the next fund.",
};
const EMPTY_WORK = { company: null, website: null, roleObjectives: null };

describe.skipIf(!db.available)("the user's own page", () => {
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
    clearAccountCache();
    await client.query("TRUNCATE activity, setup_links, pipelines, people, customers, sign_in_attempts CASCADE");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Two customers; two people and two pipelines at Acme; Other has a pipeline with the same key.
  async function seed() {
    const cust = async (code: string) =>
      (await client.query("INSERT INTO customers (code, name) VALUES ($1, $1) RETURNING id", [code])).rows[0].id as string;
    const person = async (cid: string, name: string, owner: string) =>
      (
        await client.query(
          "INSERT INTO people (customer_id, display_name, owner_key, passcode_hash) VALUES ($1, $2, $3, 'h') RETURNING id",
          [cid, name, owner],
        )
      ).rows[0].id as string;
    const pipe = async (cid: string, key: string) =>
      (
        await client.query(
          "INSERT INTO pipelines (customer_id, key, label, default_role, position) VALUES ($1, $2, $2, 'investor', 0) RETURNING id",
          [cid, key],
        )
      ).rows[0].id as string;
    const acme = await cust("acme-co");
    const other = await cust("other-co");
    const ann = { customerId: acme, personId: await person(acme, "Ann", "AN") };
    const bob = { customerId: acme, personId: await person(acme, "Bob", "BO") };
    const oz = { customerId: other, personId: await person(other, "Oz", "OZ") };
    await pipe(acme, "main");
    await pipe(acme, "side");
    await pipe(other, "main");
    await pipe(other, "theirs");
    return { acme, other, ann, bob, oz };
  }

  /** Everything the page tables and the people table hold, to prove a call changed nothing. */
  async function snapshot(): Promise<string> {
    const q = async (sql: string) => (await client.query(sql)).rows;
    return JSON.stringify({
      people: await q("SELECT id, display_name, phone, email FROM people ORDER BY id"),
      work: await q("SELECT * FROM person_work ORDER BY person_id, pipeline_id"),
      notes: await q("SELECT * FROM person_notes ORDER BY id"),
      activity: await q("SELECT customer_id, person_id, pipeline_key, action FROM activity ORDER BY id"),
    });
  }
  const profileActivity = async () =>
    (
      await client.query(
        "SELECT a.customer_id, a.person_id, a.pipeline_key FROM activity a WHERE a.action = 'profile' ORDER BY a.id",
      )
    ).rows;

  it("a person with nothing saved gets their name, empty fields and no notes", async () => {
    const { ann } = await seed();
    expect(await loadUserPage(ann, "main")).toEqual({
      person: { name: "Ann", phone: null, email: null },
      work: EMPTY_WORK,
      notes: [],
      notesTotal: 0,
    });
    // Reading writes nothing.
    expect((await client.query("SELECT count(*)::int AS n FROM person_work")).rows[0].n).toBe(0);
    expect(await profileActivity()).toEqual([]);
  });

  it("an unknown pipeline is null", async () => {
    const { ann } = await seed();
    expect(await loadUserPage(ann, "nope")).toBeNull();
    expect(await loadUserPage(ann, "")).toBeNull();
  });

  it("save writes the details to the person and the work to that pipeline only, and records one profile activity", async () => {
    const { acme, ann } = await seed();
    const saved = await saveUserPage(ann, "main", INPUT);
    expect(saved).toEqual({
      person: { name: "Ann Lee", phone: "+31 6 1234 5678", email: "ann@example.com" },
      work: { company: "Acme Ltd", website: "https://acme.example", roleObjectives: "Partner.\nRaise the next fund." },
      notes: [],
      notesTotal: 0,
    });
    expect(await loadUserPage(ann, "main")).toEqual(saved);
    // The other pipeline shares the personal details and has no work of its own.
    expect(await loadUserPage(ann, "side")).toEqual({ ...saved, work: EMPTY_WORK });
    const row = (await client.query("SELECT display_name, phone, email FROM people WHERE id = $1", [ann.personId])).rows[0];
    expect(row).toEqual({ display_name: "Ann Lee", phone: "+31 6 1234 5678", email: "ann@example.com" });
    expect(await profileActivity()).toEqual([{ customer_id: acme, person_id: ann.personId, pipeline_key: "main" }]);
  });

  it("a second save rewrites the fields, stores an empty one as NULL, and leaves the other pipeline's work as it was", async () => {
    const { ann } = await seed();
    await saveUserPage(ann, "side", { ...INPUT, company: "Side Co", website: null, roleObjectives: "Advisor" });
    await saveUserPage(ann, "main", INPUT);
    const again = await saveUserPage(ann, "main", { ...INPUT, name: "Ann L", phone: null, company: null, roleObjectives: "Managing partner" });
    expect(again?.person).toEqual({ name: "Ann L", phone: null, email: "ann@example.com" });
    expect(again?.work).toEqual({ company: null, website: "https://acme.example", roleObjectives: "Managing partner" });
    expect((await loadUserPage(ann, "side"))?.work).toEqual({ company: "Side Co", website: null, roleObjectives: "Advisor" });
    const rows = await client.query(
      "SELECT l.key, w.company, w.role_objectives FROM person_work w JOIN pipelines l ON l.id = w.pipeline_id WHERE w.person_id = $1 ORDER BY l.key",
      [ann.personId],
    );
    expect(rows.rows).toEqual([
      { key: "main", company: null, role_objectives: "Managing partner" },
      { key: "side", company: "Side Co", role_objectives: "Advisor" },
    ]);
    expect(await profileActivity()).toHaveLength(3);
  });

  it("save drops the cached account rows, so the new name shows at once", async () => {
    const { ann, bob } = await seed();
    expect((await loadAccountRows(ann.customerId, ann.personId))?.person.displayName).toBe("Ann");
    expect((await loadAccountRows(bob.customerId, bob.personId))?.person.displayName).toBe("Bob");
    await saveUserPage(ann, "main", INPUT);
    expect((await loadAccountRows(ann.customerId, ann.personId))?.person.displayName).toBe("Ann Lee");
  });

  it("notes are appended, newest first, per pipeline, each with a profile activity", async () => {
    const { ann } = await seed();
    const one = await addUserNote(ann, "main", "First note");
    expect(one?.notes.map((n) => n.body)).toEqual(["First note"]);
    const two = await addUserNote(ann, "main", "Second\nnote");
    expect(two?.notes.map((n) => n.body)).toEqual(["Second\nnote", "First note"]);
    expect(two?.notesTotal).toBe(2);
    for (const n of two!.notes) {
      expect(n.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(new Date(n.at).toISOString()).toBe(n.at);
    }
    // The first note is the same row as before: nothing was rewritten.
    expect(two!.notes[1]).toEqual(one!.notes[0]);
    await addUserNote(ann, "side", "Side note");
    expect((await loadUserPage(ann, "side"))?.notes.map((n) => n.body)).toEqual(["Side note"]);
    expect((await loadUserPage(ann, "main"))?.notes.map((n) => n.body)).toEqual(["Second\nnote", "First note"]);
    expect((await profileActivity()).map((a) => a.pipeline_key)).toEqual(["main", "main", "side"]);
  });

  it("51 notes come back as the 50 newest with a total of 51", async () => {
    const { ann } = await seed();
    await client.query(
      `INSERT INTO person_notes (person_id, pipeline_id, body, created_at)
       SELECT $1, l.id, 'note ' || n, now() - make_interval(mins => 100 - n)
         FROM pipelines l, generate_series(1, 50) n WHERE l.customer_id = $2 AND l.key = 'main'`,
      [ann.personId, ann.customerId],
    );
    const page = await addUserNote(ann, "main", "note 51");
    expect(page?.notesTotal).toBe(51);
    expect(page?.notes).toHaveLength(50);
    expect(page?.notes[0].body).toBe("note 51");
    expect(page?.notes[49].body).toBe("note 2");
    expect((await loadUserPage(ann, "main"))?.notes.map((n) => n.body)).toEqual(page?.notes.map((n) => n.body));
  });

  it("isolation: a colleague's calls never return or change another person's rows", async () => {
    const { ann, bob } = await seed();
    await saveUserPage(ann, "main", INPUT);
    await addUserNote(ann, "main", "Ann's private note");
    const annBefore = await loadUserPage(ann, "main");

    expect(await loadUserPage(bob, "main")).toEqual({
      person: { name: "Bob", phone: null, email: null },
      work: EMPTY_WORK,
      notes: [],
      notesTotal: 0,
    });
    const bobSaved = await saveUserPage(bob, "main", { ...INPUT, name: "Bob B", email: "bob@example.com", company: "Bob Co" });
    expect(JSON.stringify(bobSaved)).not.toContain("Ann");
    const bobNoted = await addUserNote(bob, "main", "Bob's note");
    expect(bobNoted?.notes.map((n) => n.body)).toEqual(["Bob's note"]);
    expect(bobNoted?.notesTotal).toBe(1);

    expect(await loadUserPage(ann, "main")).toEqual(annBefore);
    expect((await loadAskContext(bob, "main"))?.page).toEqual(bobNoted);
    expect(JSON.stringify((await loadAskContext(bob, "main"))?.page)).not.toContain("private");
  });

  it("isolation: a pipeline key that belongs to another customer is null and writes nothing", async () => {
    const { ann, oz } = await seed();
    await saveUserPage(oz, "theirs", { ...INPUT, name: "Oz", company: "Other Co" });
    await addUserNote(oz, "theirs", "Oz's note");
    const before = await snapshot();
    clearAccountCache();

    expect(await loadUserPage(ann, "theirs")).toBeNull();
    expect(await saveUserPage(ann, "theirs", INPUT)).toBeNull();
    expect(await addUserNote(ann, "theirs", "should not land")).toBeNull();
    expect(await loadAskContext(ann, "theirs")).toBeNull();
    expect(await snapshot()).toBe(before);

    // Both customers have a pipeline called main: each person reaches only their own customer's.
    await addUserNote(ann, "main", "Ann at Acme");
    expect((await loadUserPage(oz, "main"))?.notes).toEqual([]);
    expect((await loadUserPage(oz, "theirs"))?.notes.map((n) => n.body)).toEqual(["Oz's note"]);
  });

  it("isolation: a person id paired with another customer's id reads and changes nothing", async () => {
    const { ann, oz, other } = await seed();
    await saveUserPage(ann, "main", INPUT);
    await addUserNote(ann, "main", "Ann's note");
    const before = await snapshot();
    // Ann's person id with Other's customer id (a forged or stale session), on Other's pipeline.
    const forged = { customerId: other, personId: ann.personId };
    await expect(loadUserPage(forged, "theirs")).rejects.toThrow();
    await expect(saveUserPage(forged, "theirs", { ...INPUT, name: "Mallory" })).rejects.toThrow();
    await expect(addUserNote(forged, "theirs", "forged")).rejects.toThrow();
    await expect(loadAskContext(forged, "theirs")).rejects.toThrow();
    expect(await snapshot()).toBe(before);
    expect((await loadUserPage(oz, "theirs"))?.person.name).toBe("Oz");
  });

  it("a failed save changes nothing at all", async () => {
    const { ann } = await seed();
    await saveUserPage(ann, "main", INPUT);
    const before = await snapshot();
    // A NUL byte cannot be stored: the work upsert fails after the person was updated.
    await expect(saveUserPage(ann, "main", { ...INPUT, name: "Changed", company: "bad\u0000" })).rejects.toThrow();
    expect(await snapshot()).toBe(before);
  });

  it("loadAskContext returns the page and the owner names of that customer's active people only", async () => {
    const { ann } = await seed();
    await saveUserPage(ann, "main", INPUT);
    await addUserNote(ann, "main", "A note");
    expect((await loadAskContext(ann, "main", { timeoutMs: 3000 }))?.ownerNames).toEqual({ AN: "Ann Lee", BO: "Bob" });
    // A suspended colleague's name no longer reaches anyone's assistant.
    await client.query("UPDATE people SET status = 'suspended' WHERE owner_key = 'BO'");
    const ctx = await loadAskContext(ann, "main", { timeoutMs: 3000 });
    expect(ctx?.page).toEqual(await loadUserPage(ann, "main"));
    expect(ctx?.ownerNames).toEqual({ AN: "Ann Lee" });
    expect(await loadAskContext(ann, "nope")).toBeNull();
  });

  it("loadAskContext gives up after its time limit", async () => {
    const { ann } = await seed();
    // Another session holds the people table locked, so the read of it waits: a stand-in for a slow
    // accounts database. The lookup must fail near its limit, not wait for the lock to go.
    const blocker = await db.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE people IN ACCESS EXCLUSIVE MODE");
      const started = Date.now();
      await expect(loadAskContext(ann, "main", { timeoutMs: 300 })).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(2500);
      // The database gave up on the statement too: nothing is left waiting for the lock.
      const waiting = async () =>
        (
          await blocker.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
          )
        ).rows[0].n as number;
      for (let i = 0; i < 20 && (await waiting()) > 0; i++) await new Promise((r) => setTimeout(r, 50));
      expect(await waiting()).toBe(0);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
    }
    expect((await loadAskContext(ann, "main", { timeoutMs: 3000 }))?.page.person.name).toBe("Ann");
  });

  it("the module never updates or deletes a note", () => {
    const source = readFileSync(join(__dirname, "profile.ts"), "utf8");
    expect(source).toMatch(/INSERT INTO person_notes/);
    expect(source).not.toMatch(/UPDATE\s+(?:ONLY\s+)?(?:"?\w+"?\.)?"?person_notes/i);
    expect(source).not.toMatch(/\bDELETE\b/i);
    expect(source).not.toMatch(/\bTRUNCATE\b/i);
    // The only upsert is the work row; nothing is ever written to a CRM's owners table.
    expect(source.match(/ON CONFLICT/gi) ?? []).toHaveLength(1);
    expect(source).not.toMatch(/\bowners\b/i);
  });
});
