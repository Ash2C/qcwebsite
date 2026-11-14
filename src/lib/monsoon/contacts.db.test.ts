import { randomUUID } from "node:crypto";
import type { Client, ClientBase } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CUT } from "./ask/queries";
import { getProfile, recentContacts, searchContacts } from "./contacts";
import { testDb } from "./testing/db";

const TODAY = "2026-11-13";

function day(offset: number): string {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
/** A timestamp `daysAgo` days before TODAY, at noon UTC (or at `time`). */
function ago(daysAgo: number, time = "12:00:00"): string {
  return `${day(-daysAgo)}T${time}Z`;
}

describe.skipIf(!testDb.available)("Contact lookups (real Postgres)", () => {
  let db: Client;
  const id = {
    raf: randomUUID(),
    ev: randomUUID(),
    orphan: randomUUID(),
    mia: randomUUID(),
    lauren: randomUUID(),
    miaD: randomUUID(),
    sam: randomUUID(),
    raj: randomUUID(),
    jamia: randomUUID(),
    mRaf: randomUUID(),
    mMiaD: randomUUID(),
    mRaj: randomUUID(),
  };

  async function addPerson(
    pid: string,
    name: string,
    org: string | null,
    email: string | null = null,
    title: string | null = null,
    notes: string | null = null,
  ) {
    await db.query(
      `INSERT INTO people (id, org_id, name, name_key, email, title, notes, phone, linkedin_url, country, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '+65 5550 0000', 'https://linkedin.example/in/x', 'SG', 'test')`,
      [pid, org, name, name.toLowerCase() + pid, email, title, notes],
    );
  }
  async function touch(member: string, at: string, kind: string, summary: string, by: string | null = null) {
    await db.query("INSERT INTO touches (member_id, at, kind, by_whom, summary) VALUES ($1, $2, $3, $4, $5)", [
      member,
      at,
      kind,
      by,
      summary,
    ]);
  }
  async function counts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const t of ["orgs", "people", "members", "touches"]) {
      out[t] = (await db.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
    }
    return out;
  }
  /** Outside a transaction: a read-only transaction would report transaction_read_only on. */
  async function outsideTransaction() {
    expect((await db.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("off");
  }
  async function unchanged(fn: () => Promise<unknown>) {
    const before = await counts();
    await fn();
    expect(await counts()).toEqual(before);
    await outsideTransaction();
  }

  beforeEach(async () => {
    await testDb.reset();
    db = await testDb.connect();
    await db.query(
      `INSERT INTO orgs (id, name, name_key, country, website, notes, source) VALUES
         ($1, 'Raffles Family Office', 'raffles family office', 'SG', 'https://raffles.example', 'Raffles company notes', 'test'),
         ($2, 'Everberg Capital', 'everberg capital', 'DE', NULL, NULL, 'test'),
         ($3, 'Orphan Co', 'orphan co', NULL, NULL, NULL, 'test')`,
      [id.raf, id.ev, id.orphan],
    );
    await addPerson(id.mia, "Mia Chen", id.raf, "mia@raffles.example", "CIO");
    await addPerson(id.lauren, "Lauren Ho", id.raf, null, "Analyst");
    await addPerson(id.miaD, "Mia Ditrolio", id.ev, "ditrolio@everberg.example", "Partner", "Mia D personal notes");
    await addPerson(id.sam, "Sam Ortiz", id.orphan);
    await addPerson(id.raj, "Raj Mehta", null, "raj@example.com");
    await addPerson(id.jamia, "Jamia Park", id.orphan);
    // updated_at is set on INSERT (the update trigger does not fire), so recency is deterministic.
    await db.query(
      `INSERT INTO members (id, org_id, person_id, role, stage, owner, next_action, next_action_date, notes, priority, source, updated_at) VALUES
         ($1, $4, NULL, 'investor', 'engaged', 'VF', 'Send deck', $7, 'Raffles member notes', 'high', 'test', $8),
         ($2, NULL, $5, 'investor', 'uncontacted', NULL, NULL, NULL, NULL, NULL, 'test', $9),
         ($3, NULL, $6, 'introducer', 'contacted', NULL, NULL, NULL, NULL, NULL, 'test', $10)`,
      [id.mRaf, id.mMiaD, id.mRaj, id.raf, id.miaD, id.raj, day(-3), ago(30), ago(1), ago(20)],
    );
    await touch(id.mRaf, ago(10), "email", "Sent intro email", "VF");
    await touch(id.mRaf, ago(2), "meeting", "Coffee, discussed fund terms", "VF");
    await touch(id.mRaf, ago(2, "20:00:00"), "system", "Details updated: Phone: (empty) → 123", "VF");
    await touch(id.mRaj, ago(0), "note", "Met at the conference");
  });
  afterEach(async () => {
    await db.end();
  });

  describe("searchContacts", () => {
    it("finds people by name, name-prefix first and then by name", async () => {
      const hits = await searchContacts(db, "mia");
      expect(hits.map((h) => h.name)).toEqual(["Mia Chen", "Mia Ditrolio", "Jamia Park"]);
      const [chen, ditrolio] = hits;
      expect(chen).toMatchObject({
        kind: "person",
        personId: id.mia,
        orgId: id.raf,
        title: "CIO",
        company: "Raffles Family Office",
        email: "mia@raffles.example",
        memberOf: "company",
        member: { memberId: id.mRaf, memberKind: "company", role: "investor", stage: "engaged" },
      });
      expect(ditrolio).toMatchObject({
        memberOf: "self",
        member: { memberId: id.mMiaD, memberKind: "person", stage: "uncontacted" },
      });
      expect(hits[2]).toMatchObject({ member: null, memberOf: null });
      await outsideTransaction();
    });

    it("returns a company match first, then the people filed at it", async () => {
      const hits = await searchContacts(db, "raffles");
      expect(hits.map((h) => [h.kind, h.name, h.memberOf])).toEqual([
        ["company", "Raffles Family Office", "self"],
        ["person", "Lauren Ho", "company"],
        ["person", "Mia Chen", "company"],
      ]);
      expect(hits[0]).toMatchObject({ personId: null, orgId: id.raf, title: null, company: null, email: null });
      expect(hits[0].member).toMatchObject({ memberId: id.mRaf, memberKind: "company" });
    });

    it("lists a company with no membership, then the people matched only through it, by name", async () => {
      const hits = await searchContacts(db, "orphan");
      expect(hits.map((h) => h.name)).toEqual(["Orphan Co", "Jamia Park", "Sam Ortiz"]);
      expect(hits[0]).toMatchObject({ kind: "company", member: null, memberOf: null });
    });

    it("searches email, case-insensitively", async () => {
      expect((await searchContacts(db, "DITROLIO@EVERBERG")).map((h) => h.name)).toEqual(["Mia Ditrolio"]);
    });

    it("treats %, _ and backslash literally", async () => {
      await addPerson(randomUUID(), "Pat 50% Fund", null);
      await addPerson(randomUUID(), "Pat 500 Fund", null);
      expect((await searchContacts(db, "50%")).map((h) => h.name)).toEqual(["Pat 50% Fund"]);
      expect(await searchContacts(db, "m_a")).toEqual([]);
      expect(await searchContacts(db, "\\")).toEqual([]);
    });

    it("returns nothing for an empty query", async () => {
      expect(await searchContacts(db, "   ")).toEqual([]);
    });

    it("caps the result at 30, people and companies together", async () => {
      for (let i = 0; i < 40; i++) await addPerson(randomUUID(), `Zed ${String(i).padStart(2, "0")}`, null);
      for (let i = 0; i < 5; i++) {
        await db.query("INSERT INTO orgs (name, name_key, source) VALUES ($1, $2, 'test')", [`Zed Co ${i}`, `zed co ${i}`]);
      }
      const hits = await searchContacts(db, "zed");
      expect(hits).toHaveLength(30);
      expect(hits[0].name).toBe("Zed 00");
      expect(hits.every((h) => h.kind === "person")).toBe(true); // "Zed 29" sorts before "Zed Co 0"
    });

    it("writes nothing and leaves the connection outside a transaction, even when it throws", async () => {
      await unchanged(() => searchContacts(db, "mia"));
      const failing = {
        query: (sql: string, params?: unknown[]) =>
          /FROM orgs/.test(sql) && /ILIKE/.test(sql) ? Promise.reject(new Error("boom")) : db.query(sql, params),
      } as unknown as ClientBase;
      await expect(searchContacts(failing, "raffles")).rejects.toThrow("boom");
      await outsideTransaction();
    });
  });

  describe("recentContacts", () => {
    it("lists only members, ordered by the newer of update and newest touch", async () => {
      const hits = await recentContacts(db);
      // Raj: touch today; Mia Ditrolio: updated yesterday; Raffles: touch 2 days ago (update 30 days ago).
      expect(hits.map((h) => h.name)).toEqual(["Raj Mehta", "Mia Ditrolio", "Raffles Family Office"]);
      expect(hits[0]).toMatchObject({ kind: "person", orgId: null, company: null, memberOf: "self", email: "raj@example.com" });
      expect(hits[1]).toMatchObject({ kind: "person", orgId: id.ev, company: "Everberg Capital", title: "Partner" });
      expect(hits[2]).toMatchObject({ kind: "company", personId: null, orgId: id.raf, memberOf: "self" });
      expect(hits[2].member).toMatchObject({ memberId: id.mRaf, memberKind: "company", stage: "engaged" });
      await unchanged(() => recentContacts(db));
    });

    it("returns at most 20 rows", async () => {
      for (let i = 0; i < 25; i++) {
        const pid = randomUUID();
        await addPerson(pid, `Member ${i}`, null);
        await db.query("INSERT INTO members (person_id, role, stage, source) VALUES ($1, 'investor', 'uncontacted', 'test')", [pid]);
      }
      expect(await recentContacts(db)).toHaveLength(20);
    });
  });

  describe("getProfile", () => {
    it("loads a company member by memberId with its people and timeline", async () => {
      const p = await getProfile(db, { memberId: id.mRaf }, TODAY);
      expect(p).toMatchObject({
        kind: "company",
        personId: null,
        orgId: id.raf,
        name: "Raffles Family Office",
        title: null,
        company: null,
        email: null,
        country: "SG",
        website: "https://raffles.example",
        notes: "Raffles company notes",
        memberOf: "self",
        timelineOf: null,
        timelineTotal: 3,
        member: {
          memberId: id.mRaf,
          memberKind: "company",
          role: "investor",
          stage: "engaged",
          owner: "VF",
          priority: "high",
          nextAction: "Send deck",
          nextActionDate: day(-3),
          due: "overdue",
          notes: "Raffles member notes",
        },
      });
      expect(p!.people.map((x) => x.name)).toEqual(["Lauren Ho", "Mia Chen"]);
      expect(p!.people[1]).toEqual({
        personId: id.mia,
        name: "Mia Chen",
        title: "CIO",
        email: "mia@raffles.example",
        phone: "+65 5550 0000",
      });
      expect(p!.timeline.map((t) => t.kind)).toEqual(["system", "meeting", "email"]);
      expect(p!.timeline[0]).toEqual({
        at: new Date(ago(2, "20:00:00")).toISOString(),
        kind: "system",
        by: "VF",
        summary: "Details updated: Phone: (empty) → 123",
      });
      await unchanged(() => getProfile(db, { memberId: id.mRaf }, TODAY));
    });

    it("loads a person member by memberId as a person profile", async () => {
      const p = await getProfile(db, { memberId: id.mMiaD }, TODAY);
      expect(p).toMatchObject({
        kind: "person",
        personId: id.miaD,
        orgId: id.ev,
        name: "Mia Ditrolio",
        title: "Partner",
        company: "Everberg Capital",
        email: "ditrolio@everberg.example",
        phone: "+65 5550 0000",
        linkedin: "https://linkedin.example/in/x",
        country: "SG",
        website: null,
        notes: "Mia D personal notes",
        memberOf: "self",
        timelineOf: null,
        timeline: [],
        timelineTotal: 0,
        people: [],
        member: { memberId: id.mMiaD, memberKind: "person", stage: "uncontacted", due: "none", notes: null },
      });
    });

    it("shows a person under a member company with the company's timeline", async () => {
      const p = await getProfile(db, { personId: id.mia }, TODAY);
      expect(p).toMatchObject({
        kind: "person",
        personId: id.mia,
        orgId: id.raf,
        company: "Raffles Family Office",
        website: "https://raffles.example",
        memberOf: "company",
        timelineOf: "Raffles Family Office",
        timelineTotal: 3,
        member: { memberId: id.mRaf, memberKind: "company", due: "overdue" },
      });
      expect(p!.timeline).toHaveLength(3);
      expect(p!.people).toEqual([]);
    });

    it("shows a person with no membership and no company membership", async () => {
      const p = await getProfile(db, { personId: id.sam }, TODAY);
      expect(p).toMatchObject({
        kind: "person",
        name: "Sam Ortiz",
        member: null,
        memberOf: null,
        timelineOf: null,
        timeline: [],
        timelineTotal: 0,
      });
    });

    it("shows a company-less person's own membership", async () => {
      const p = await getProfile(db, { personId: id.raj }, TODAY);
      expect(p).toMatchObject({ orgId: null, company: null, memberOf: "self", timelineTotal: 1, member: { memberId: id.mRaj } });
    });

    it("carries every stage of the estate in pipeline order, for every kind of target", async () => {
      const expected = [
        { key: "uncontacted", label: "Uncontacted", terminal: false },
        { key: "contacted", label: "Contacted", terminal: false },
        { key: "engaged", label: "Engaged", terminal: false },
        { key: "client", label: "Client", terminal: true },
        { key: "passed", label: "Passed", terminal: true },
      ];
      for (const target of [{ memberId: id.mRaf }, { personId: id.sam }, { orgId: id.ev }]) {
        expect((await getProfile(db, target, TODAY))!.stages).toEqual(expected);
      }
      await db.query("UPDATE stages SET ord = 9 WHERE key = 'uncontacted'");
      expect((await getProfile(db, { orgId: id.raf }, TODAY))!.stages.map((s) => s.key)).toEqual([
        "contacted", "engaged", "client", "passed", "uncontacted",
      ]);
    });

    it("loads a company by orgId, with or without a membership", async () => {
      const ev = await getProfile(db, { orgId: id.ev }, TODAY);
      expect(ev).toMatchObject({ kind: "company", name: "Everberg Capital", member: null, memberOf: null, timeline: [], timelineTotal: 0 });
      expect(ev!.people.map((x) => x.name)).toEqual(["Mia Ditrolio"]);
      const raf = await getProfile(db, { orgId: id.raf }, TODAY);
      expect(raf).toMatchObject({ memberOf: "self", member: { memberId: id.mRaf } });
    });

    it("caps the timeline at 50 and the people at 50, counting every entry", async () => {
      for (let i = 0; i < 55; i++) {
        await touch(id.mRaf, ago(100 + i), "note", `Old note ${i}`);
        await addPerson(randomUUID(), `Staff ${String(i).padStart(2, "0")}`, id.raf);
      }
      const p = await getProfile(db, { memberId: id.mRaf }, TODAY);
      expect(p!.timeline).toHaveLength(50);
      expect(p!.timelineTotal).toBe(58);
      expect(p!.people).toHaveLength(50);
    });

    it("clips long summaries and notes", async () => {
      await touch(id.mRaf, ago(0), "note", "x".repeat(700));
      await db.query("UPDATE orgs SET notes = $1 WHERE id = $2", ["n".repeat(7000), id.raf]);
      const p = await getProfile(db, { orgId: id.raf }, TODAY);
      expect(p!.timeline[0].summary).toBe("x".repeat(600) + CUT);
      expect(p!.notes).toBe("n".repeat(6000) + CUT);
    });

    it("returns null for malformed ids without querying, and for ids that match nothing", async () => {
      const seen: string[] = [];
      const spy = {
        query: (sql: string, params?: unknown[]) => {
          seen.push(sql);
          return db.query(sql, params);
        },
      } as unknown as ClientBase;
      for (const target of [{ memberId: "nope" }, { personId: "1234" }, { orgId: "x; DROP TABLE orgs" }, {}]) {
        expect(await getProfile(spy, target, TODAY)).toBeNull();
      }
      expect(seen).toEqual([]);
      const ghost = randomUUID();
      for (const target of [{ memberId: ghost }, { personId: ghost }, { orgId: ghost }]) {
        expect(await getProfile(db, target, TODAY)).toBeNull();
        await outsideTransaction();
      }
    });

    it("leaves the connection outside a transaction when it throws", async () => {
      const failing = {
        query: (sql: string, params?: unknown[]) =>
          /FROM touches/.test(sql) ? Promise.reject(new Error("boom")) : db.query(sql, params),
      } as unknown as ClientBase;
      await expect(getProfile(failing, { memberId: id.mRaf }, TODAY)).rejects.toThrow("boom");
      await outsideTransaction();
    });
  });
});
