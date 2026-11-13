import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dueBucket } from "../rules";
import { testDb } from "../testing/db";
import {
  CUT,
  chaseList,
  clip,
  findContacts,
  getContact,
  getPerson,
  listPipeline,
  pipelineSummary,
  readOnly,
  recentActivity,
  searchNotes,
  vocabulary,
} from "./queries";

const TODAY = "2026-11-13";

function day(offset: number): string {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
/** A timestamp `daysAgo` days before TODAY, at noon UTC. */
function ago(daysAgo: number): string {
  return `${day(-daysAgo)}T12:00:00Z`;
}

describe("clip", () => {
  it("leaves short text alone and marks a cut", () => {
    expect(clip(null, 5)).toBeNull();
    expect(clip("abcde", 5)).toBe("abcde");
    expect(clip("abcdef", 5)).toBe(`abcde${CUT}`);
    expect(CUT).toBe(" …[cut]");
  });
});

describe.skipIf(!testDb.available)("Ask read queries (real Postgres)", () => {
  let db: Client;
  const id = {
    nw: randomUUID(),
    acme: randomUUID(),
    orphan: randomUUID(),
    jane: randomUUID(),
    omar: randomUUID(),
    liwei: randomUUID(),
    sam: randomUUID(),
    raj: randomUUID(),
    mNw: randomUUID(),
    mLi: randomUUID(),
    mRaj: randomUUID(),
  };

  async function addPerson(name: string, org: string | null, extra: Record<string, unknown> = {}): Promise<string> {
    const pid = randomUUID();
    await db.query(
      `INSERT INTO people (id, org_id, name, name_key, email, title, notes, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'test')`,
      [pid, org, name, name.toLowerCase() + pid, extra.email ?? null, extra.title ?? null, extra.notes ?? null],
    );
    return pid;
  }
  async function addMember(
    target: { person?: string; org?: string },
    over: {
      role?: string;
      stage?: string;
      owner?: string | null;
      action?: string | null;
      date?: string | null;
      notes?: string | null;
    } = {},
  ): Promise<string> {
    const mid = randomUUID();
    await db.query(
      `INSERT INTO members (id, org_id, person_id, role, stage, owner, next_action, next_action_date, notes, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'test')`,
      [
        mid,
        target.org ?? null,
        target.person ?? null,
        over.role ?? "investor",
        over.stage ?? "uncontacted",
        over.owner ?? null,
        over.action ?? null,
        over.date ?? null,
        over.notes ?? null,
      ],
    );
    return mid;
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

  beforeEach(async () => {
    await testDb.reset();
    db = await testDb.connect();
    await db.query("INSERT INTO owners (key, display_name) VALUES ('BM', 'Bea')");
    await db.query(
      `INSERT INTO orgs (id, name, name_key, country, org_type, aum_usd, website, notes, source) VALUES
         ($1, 'Northwind Capital', 'northwind capital', 'SG', 'family office', 250000000, 'https://northwind.example', 'Northwind keeps a quarterly review', 'test'),
         ($2, 'Acme Capital', 'acme capital', NULL, NULL, NULL, NULL, NULL, 'test'),
         ($3, 'Orphan Co', 'orphan co', NULL, NULL, NULL, NULL, NULL, 'test')`,
      [id.nw, id.acme, id.orphan],
    );
    const insertPerson = async (pid: string, name: string, org: string | null, email: string | null, notes: string | null) =>
      db.query(
        "INSERT INTO people (id, org_id, name, name_key, email, notes, title, source) VALUES ($1,$2,$3,$4,$5,$6,'Partner','test')",
        [pid, org, name, name.toLowerCase(), email, notes],
      );
    await insertPerson(id.jane, "Jane Tan", id.nw, "jane@northwind.example", "Jane prefers long-form research");
    await insertPerson(id.omar, "Omar Reyes", id.nw, null, null);
    await insertPerson(id.liwei, "Li Wei", id.acme, "liwei@acme.example", null);
    await insertPerson(id.sam, "Sam Ortiz", id.orphan, null, null);
    await insertPerson(id.raj, "Raj Mehta", null, null, null);
    await db.query(
      `INSERT INTO members (id, org_id, person_id, role, stage, owner, next_action, next_action_date, notes, priority, anchor, source) VALUES
         ($1, $4, NULL, 'investor', 'engaged', 'VF', 'Send deck', $7, 'family offices are the target', 'high', true, 'test'),
         ($2, NULL, $5, 'investor', 'contacted', 'BM', 'Call back', $8, NULL, NULL, false, 'test'),
         ($3, NULL, $6, 'introducer', 'uncontacted', NULL, NULL, NULL, NULL, NULL, false, 'test')`,
      [id.mNw, id.mLi, id.mRaj, id.nw, id.liwei, id.raj, day(-3), day(0)],
    );
    await touch(id.mNw, ago(10), "email", "Sent intro email", "VF");
    await touch(id.mNw, ago(2), "meeting", "Coffee, discussed fund terms", "VF");
    await touch(id.mNw, ago(1), "stage", "contacted -> engaged", "VF");
    await touch(id.mLi, ago(40), "call", "Short call about timing", "BM");
  });
  afterEach(async () => {
    await db.end();
  });

  it("vocabulary returns stages in order with terminal flags, roles and owners", async () => {
    const v = await vocabulary(db);
    expect(v.stages.map((s) => s.key)).toEqual(["uncontacted", "contacted", "engaged", "client", "passed"]);
    expect(v.stages.map((s) => s.terminal)).toEqual([false, false, false, true, true]);
    expect(v.stages[0]).toEqual({ key: "uncontacted", label: "Uncontacted", ord: 0, terminal: false });
    expect(v.roles).toEqual([
      { key: "introducer", label: "Introducer" },
      { key: "investor", label: "Investor" },
    ]);
    expect(v.owners).toEqual([
      { key: "BM", name: "Bea" },
      { key: "VF", name: "Vincent" },
    ]);
  });

  describe("findContacts", () => {
    it("matches part of a person name, case-insensitively", async () => {
      const r = await findContacts(db, "  jANE ");
      expect(r.map((m) => m.name)).toEqual(["Jane Tan"]);
      expect(r[0]).toMatchObject({ kind: "person", personId: id.jane, orgId: id.nw, company: "Northwind Capital" });
    });
    it("matches by email", async () => {
      const r = await findContacts(db, "liwei@acme");
      expect(r.map((m) => m.name)).toEqual(["Li Wei"]);
      expect(r[0].email).toBe("liwei@acme.example");
    });
    it("matches by company name, people first then companies", async () => {
      const r = await findContacts(db, "northwind");
      expect(r.map((m) => [m.kind, m.name])).toEqual([
        ["person", "Jane Tan"], // by email
        ["company", "Northwind Capital"],
      ]);
      expect(r[1]).toMatchObject({ personId: null, orgId: id.nw, company: null, email: null });
      expect(r[1].member).toEqual({ memberId: id.mNw, memberKind: "company", role: "investor", stage: "engaged" });
    });
    it("gives a person without a membership their company's member", async () => {
      const [jane] = await findContacts(db, "Jane Tan");
      expect(jane.member).toEqual({ memberId: id.mNw, memberKind: "company", role: "investor", stage: "engaged" });
    });
    it("gives a person member their own membership", async () => {
      const [li] = await findContacts(db, "Li Wei");
      expect(li.member).toEqual({ memberId: id.mLi, memberKind: "person", role: "investor", stage: "contacted" });
    });
    it("returns member null for someone who is not in the pipeline", async () => {
      const [sam] = await findContacts(db, "Sam Ortiz");
      expect(sam.member).toBeNull();
      const [orphan] = await findContacts(db, "Orphan");
      expect(orphan).toMatchObject({ kind: "company", name: "Orphan Co", member: null });
    });
    it("treats % and _ literally", async () => {
      await addPerson("Pct 5%", null);
      await addPerson("Pct 55", null);
      await addPerson("Under_score", null);
      await addPerson("Underscore", null);
      expect((await findContacts(db, "5%")).map((m) => m.name)).toEqual(["Pct 5%"]);
      expect((await findContacts(db, "er_s")).map((m) => m.name)).toEqual(["Under_score"]);
      expect(await findContacts(db, "a\\")).toEqual([]);
    });
    it("returns [] for a query under two characters", async () => {
      expect(await findContacts(db, "J")).toEqual([]);
      expect(await findContacts(db, "  x  ")).toEqual([]);
      expect(await findContacts(db, "%")).toEqual([]);
    });
    it("caps at 20, people before companies", async () => {
      for (let i = 0; i < 25; i++) await addPerson(`Bulk Person ${String(i).padStart(2, "0")}`, null);
      const r = await findContacts(db, "Bulk Person");
      expect(r).toHaveLength(20);
      expect(r[0].name).toBe("Bulk Person 00");
      expect(r.every((m) => m.kind === "person")).toBe(true);
    });
  });

  describe("getContact", () => {
    it("returns a person member with person fields and its company name", async () => {
      const c = await getContact(db, id.mLi, TODAY);
      expect(c).toMatchObject({
        memberId: id.mLi,
        memberKind: "person",
        name: "Li Wei",
        company: "Acme Capital",
        role: "investor",
        stage: "contacted",
        owner: "BM",
        nextAction: "Call back",
        nextActionDate: TODAY,
        due: "today",
        lastActionKind: "call",
        lastActionAt: ago(40).replace("Z", ".000Z"),
        priority: null,
        anchor: false,
        org: null,
        people: [],
      });
      expect(c!.person).toEqual({
        title: "Partner",
        email: "liwei@acme.example",
        phone: null,
        linkedin: null,
        country: null,
        notes: null,
      });
    });
    it("returns a company member with org fields and its people", async () => {
      const c = await getContact(db, id.mNw, TODAY);
      expect(c).toMatchObject({
        memberKind: "company",
        name: "Northwind Capital",
        company: null,
        due: "overdue",
        nextActionDate: day(-3),
        priority: "high",
        anchor: true,
        notes: "family offices are the target",
        person: null,
        lastActionKind: "meeting",
      });
      expect(c!.org).toEqual({
        country: "SG",
        type: "family office",
        aumUsd: "250000000.00",
        website: "https://northwind.example",
        notes: "Northwind keeps a quarterly review",
      });
      expect(c!.people.map((p) => p.name)).toEqual(["Jane Tan", "Omar Reyes"]);
      expect(c!.people[0]).toMatchObject({ personId: id.jane, email: "jane@northwind.example" });
    });
    it("lists the timeline newest first, with the stage entry (not an action) included", async () => {
      const c = await getContact(db, id.mNw, TODAY);
      expect(c!.timeline.map((t) => t.kind)).toEqual(["stage", "meeting", "email"]);
      expect(c!.timeline[1]).toEqual({
        at: ago(2).replace("Z", ".000Z"),
        kind: "meeting",
        by: "VF",
        summary: "Coffee, discussed fund terms",
      });
      expect(c!.timelineTotal).toBe(3);
    });
    it("shows 50 entries but counts them all", async () => {
      for (let i = 0; i < 55; i++) await touch(id.mRaj, ago(100 - i), "note", `note ${i}`);
      const c = await getContact(db, id.mRaj, TODAY);
      expect(c!.timeline).toHaveLength(50);
      expect(c!.timelineTotal).toBe(55);
      expect(c!.timeline[0].summary).toBe("note 54");
    });
    it("clips long notes and summaries and marks the cut", async () => {
      await db.query("UPDATE members SET notes = $2 WHERE id = $1", [id.mRaj, "m".repeat(7000)]);
      await db.query("UPDATE people SET notes = $2 WHERE id = $1", [id.raj, "p".repeat(7000)]);
      await touch(id.mRaj, ago(1), "note", "s".repeat(700));
      const c = await getContact(db, id.mRaj, TODAY);
      expect(c!.notes).toBe("m".repeat(6000) + CUT);
      expect(c!.person!.notes).toBe("p".repeat(6000) + CUT);
      expect(c!.timeline[0].summary).toBe("s".repeat(600) + CUT);
    });
    it("returns null for an unknown or malformed id, without querying", async () => {
      expect(await getContact(db, randomUUID(), TODAY)).toBeNull();
      const seen: string[] = [];
      const orig = db.query.bind(db) as (...a: unknown[]) => Promise<unknown>;
      (db as unknown as { query: unknown }).query = (...a: unknown[]) => {
        seen.push(String(a[0]));
        return orig(...a);
      };
      expect(await getContact(db, "not-a-uuid", TODAY)).toBeNull();
      expect(await getContact(db, "'; DROP TABLE members; --", TODAY)).toBeNull();
      expect(await getPerson(db, "nope")).toBeNull();
      expect(seen).toEqual([]);
    });
  });

  describe("getPerson", () => {
    it("returns Jane with Northwind's member", async () => {
      expect(await getPerson(db, id.jane)).toEqual({
        personId: id.jane,
        name: "Jane Tan",
        title: "Partner",
        email: "jane@northwind.example",
        phone: null,
        linkedin: null,
        country: null,
        notes: "Jane prefers long-form research",
        company: "Northwind Capital",
        member: { memberId: id.mNw, memberKind: "company", role: "investor", stage: "engaged" },
      });
    });
    it("returns member null for a person outside the pipeline, null for an unknown id", async () => {
      expect((await getPerson(db, id.sam))!.member).toBeNull();
      expect((await getPerson(db, id.raj))!.company).toBeNull();
      expect(await getPerson(db, randomUUID())).toBeNull();
    });
  });

  describe("listPipeline", () => {
    it("returns everyone in stage order with display names", async () => {
      const r = await listPipeline(db, {}, TODAY);
      expect(r.total).toBe(3);
      expect(r.rows.map((x) => [x.name, x.stage])).toEqual([
        ["Raj Mehta", "uncontacted"],
        ["Li Wei", "contacted"],
        ["Northwind Capital", "engaged"],
      ]);
      expect(r.rows[1]).toMatchObject({ memberKind: "person", company: "Acme Capital", owner: "BM" });
      expect(r.rows[2]).toMatchObject({ memberKind: "company", company: null, lastActionKind: "meeting" });
      expect(r.rows[0]).toMatchObject({ lastActionAt: null, lastActionKind: null, nextActionDate: null, due: "none" });
    });
    it("narrows by stage, role, owner and due", async () => {
      expect((await listPipeline(db, { stage: "engaged" }, TODAY)).rows.map((x) => x.name)).toEqual(["Northwind Capital"]);
      expect((await listPipeline(db, { role: "introducer" }, TODAY)).rows.map((x) => x.name)).toEqual(["Raj Mehta"]);
      expect((await listPipeline(db, { owner: "BM" }, TODAY)).rows.map((x) => x.name)).toEqual(["Li Wei"]);
      expect((await listPipeline(db, { due: "today" }, TODAY)).rows.map((x) => x.name)).toEqual(["Li Wei"]);
      expect((await listPipeline(db, { stage: "engaged", role: "introducer" }, TODAY)).total).toBe(0);
    });
    it("evaluates due against the given today", async () => {
      expect((await listPipeline(db, { due: "overdue" }, TODAY)).rows.map((x) => x.name)).toEqual(["Northwind Capital"]);
      expect((await listPipeline(db, { due: "overdue" }, day(-10))).total).toBe(0);
      expect((await listPipeline(db, { due: "overdue" }, day(1))).total).toBe(2);
    });
    it("reports the unclipped total and 50 rows", async () => {
      for (let i = 0; i < 60; i++) await addMember({ person: await addPerson(`Many ${i}`, null) }, { stage: "contacted" });
      const r = await listPipeline(db, {}, TODAY);
      expect(r.rows).toHaveLength(50);
      expect(r.total).toBe(63);
    });
    it("matches nothing for an unknown stage or role", async () => {
      expect(await listPipeline(db, { stage: "nope" }, TODAY)).toEqual({ rows: [], total: 0 });
      expect((await listPipeline(db, { role: "nope" }, TODAY)).total).toBe(0);
    });
  });

  describe("pipelineSummary", () => {
    it("counts stages and roles that add up to the total", async () => {
      const s = await pipelineSummary(db, TODAY);
      expect(s.total).toBe(3);
      expect(s.byStage).toEqual([
        { stage: "uncontacted", count: 1 },
        { stage: "contacted", count: 1 },
        { stage: "engaged", count: 1 },
      ]);
      expect(s.byRole).toEqual([
        { role: "introducer", count: 1 },
        { role: "investor", count: 2 },
      ]);
      expect(s.byStage.reduce((a, b) => a + b.count, 0)).toBe(s.total);
      expect(s.byRole.reduce((a, b) => a + b.count, 0)).toBe(s.total);
    });
    it("puts the due buckets on the right side of today and of today+7, agreeing with dueBucket", async () => {
      const cases: [string, string | null, string | null][] = [
        ["Call", day(-1), "overdue"],
        ["Call", day(0), "today"],
        ["Call", day(1), "week"],
        ["Call", day(7), "week"],
        ["Call", day(8), "later"],
        ["Call", null, "undated"],
        ["   ", day(2), "none"],
      ];
      for (const [action, date] of cases) {
        await addMember({ person: await addPerson(`P ${action}${date}`, null) }, { action, date });
      }
      const s = await pipelineSummary(db, TODAY);
      // seed: Northwind overdue, Li Wei today, Raj none
      expect(s.byDue).toEqual({ overdue: 2, today: 2, week: 2, later: 1, undated: 1, none: 2 });
      expect(Object.values(s.byDue).reduce((a, b) => a + b, 0)).toBe(s.total);
      for (const [action, date, bucket] of cases) expect(dueBucket({ next_action: action, next_action_date: date }, TODAY)).toBe(bucket);
    });
    it("counts members with no action in 30 and 90 days (stage and system entries do not count)", async () => {
      const a = await addMember({ person: await addPerson("Recent", null) });
      await touch(a, ago(29), "email", "recent");
      const b = await addMember({ person: await addPerson("Mid", null) });
      await touch(b, ago(31), "email", "mid");
      const c = await addMember({ person: await addPerson("Old", null) });
      await touch(c, ago(91), "email", "old");
      await touch(c, ago(1), "system", "backfill");
      const s = await pipelineSummary(db, TODAY);
      // Northwind (2 days ago) is current; Li Wei (40), Raj (never), Mid (31), Old (91) lack a 30-day action
      expect(s.noActionIn30Days).toBe(4);
      // Raj (never) and Old (91) lack a 90-day action
      expect(s.noActionIn90Days).toBe(2);
    });
  });

  describe("chaseList", () => {
    it("orders due as overdue, today, then week", async () => {
      await addMember({ person: await addPerson("Week Soon", null) }, { action: "x", date: day(2), owner: "VF" });
      await addMember({ person: await addPerson("Week Later", null) }, { action: "x", date: day(6), owner: "VF" });
      await addMember({ person: await addPerson("Overdue Old", null) }, { action: "x", date: day(-9), owner: "VF" });
      await addMember({ person: await addPerson("Far Out", null) }, { action: "x", date: day(30), owner: "VF" });
      const r = await chaseList(db, {}, TODAY);
      expect(r.due.map((x) => [x.name, x.due])).toEqual([
        ["Overdue Old", "overdue"],
        ["Northwind Capital", "overdue"],
        ["Li Wei", "today"],
        ["Week Soon", "week"],
        ["Week Later", "week"],
      ]);
    });
    it("never lists a terminal-stage member as stale", async () => {
      await addMember({ person: await addPerson("Won Client", null) }, { stage: "client" });
      await addMember({ person: await addPerson("Passed", null) }, { stage: "passed" });
      const r = await chaseList(db, {}, TODAY);
      expect(r.stale.map((x) => x.name)).not.toContain("Won Client");
      expect(r.stale.map((x) => x.name)).not.toContain("Passed");
    });
    it("is stale after 31 days without an action, not after 29; never having one counts", async () => {
      const fresh = await addMember({ person: await addPerson("Fresh 29", null) }, { stage: "contacted" });
      await touch(fresh, ago(29), "call", "c");
      const old = await addMember({ person: await addPerson("Old 31", null) }, { stage: "contacted" });
      await touch(old, ago(31), "call", "c");
      const sysOnly = await addMember({ person: await addPerson("System Only", null) }, { stage: "contacted" });
      await touch(sysOnly, ago(2), "system", "s");
      await touch(sysOnly, ago(1), "stage", "a -> b");
      const undated = await addMember({ person: await addPerson("Undated", null) }, { stage: "contacted", action: "Think" });
      await touch(undated, ago(60), "note", "n");
      const r = await chaseList(db, {}, TODAY);
      const names = r.stale.map((x) => x.name);
      expect(names).not.toContain("Fresh 29");
      expect(names).toContain("Old 31");
      expect(names).toContain("System Only");
      expect(names).toContain("Undated");
      // oldest last action first; never-actioned (Raj, System Only) lead
      expect(names.indexOf("Old 31")).toBeGreaterThan(names.indexOf("Raj Mehta"));
      expect(names.indexOf("Undated")).toBeLessThan(names.indexOf("Old 31"));
      // a member with a dated next action is due-list material, not stale
      expect(names).not.toContain("Northwind Capital");
      expect(names).not.toContain("Li Wei");
    });
    it("owner filter keeps that owner's and unowned members and drops the others", async () => {
      const vf = await chaseList(db, { owner: "VF" }, TODAY);
      expect(vf.due.map((x) => x.name)).toEqual(["Northwind Capital"]);
      expect(vf.stale.map((x) => x.name)).toEqual(["Raj Mehta"]);
      const bm = await chaseList(db, { owner: "BM" }, TODAY);
      expect(bm.due.map((x) => x.name)).toEqual(["Li Wei"]);
      const all = await chaseList(db, {}, TODAY);
      expect(all.due.map((x) => x.name)).toEqual(["Northwind Capital", "Li Wei"]);
    });
    it("caps each list at 50", async () => {
      for (let i = 0; i < 55; i++) await addMember({ person: await addPerson(`Due ${i}`, null) }, { action: "x", date: day(1) });
      for (let i = 0; i < 55; i++) await addMember({ person: await addPerson(`Idle ${i}`, null) });
      const r = await chaseList(db, {}, TODAY);
      expect(r.due).toHaveLength(50);
      expect(r.stale).toHaveLength(50);
    });
  });

  describe("searchNotes", () => {
    it("finds a hit in each of the four places", async () => {
      await db.query("UPDATE orgs SET notes = 'Acme loves quantum widgets' WHERE id = $1", [id.acme]);
      await db.query("UPDATE members SET notes = 'quantum angle via member' WHERE id = $1", [id.mRaj]);
      await db.query("UPDATE people SET notes = 'quantum fan' WHERE id = $1", [id.liwei]);
      await touch(id.mNw, ago(3), "note", "Mentioned QUANTUM computing at lunch", "VF");
      const hits = await searchNotes(db, "quantum");
      expect(hits.map((h) => h.where)).toEqual(["member notes", "person notes", "company notes", "timeline"]);
      const [mem, per, org, tl] = hits;
      expect(mem).toMatchObject({ name: "Raj Mehta", at: null });
      expect(mem.member).toEqual({ memberId: id.mRaj, memberKind: "person", role: "introducer", stage: "uncontacted" });
      expect(per).toMatchObject({ name: "Li Wei", company: "Acme Capital", at: null });
      expect(per.member!.memberId).toBe(id.mLi);
      expect(org).toMatchObject({ name: "Acme Capital", company: null, member: null });
      expect(tl).toMatchObject({ name: "Northwind Capital", at: ago(3).replace("Z", ".000Z") });
      expect(tl.snippet).toContain("QUANTUM");
    });
    it("carries the company's member for a person-note hit on Jane", async () => {
      const hits = await searchNotes(db, "long-form");
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ name: "Jane Tan", company: "Northwind Capital", where: "person notes" });
      expect(hits[0].member).toEqual({ memberId: id.mNw, memberKind: "company", role: "investor", stage: "engaged" });
    });
    it("cuts the snippet to 80 characters either side with ellipses", async () => {
      await db.query("UPDATE members SET notes = $2 WHERE id = $1", [id.mRaj, `${"a".repeat(200)} NEEDLE ${"b".repeat(200)}`]);
      const [h] = await searchNotes(db, "needle");
      expect(h.snippet).toBe(`…${"a".repeat(79)} NEEDLE ${"b".repeat(79)}…`);
      expect(h.snippet.replace(/…/g, "")).toContain("NEEDLE");
      const [short] = await searchNotes(db, "family offices");
      expect(short.snippet).toBe("family offices are the target");
    });
    it("treats wildcards literally, ignores one-character queries, and caps at 30", async () => {
      expect(await searchNotes(db, "q")).toEqual([]);
      expect(await searchNotes(db, "fam%")).toEqual([]);
      for (let i = 0; i < 35; i++) await touch(id.mRaj, ago(i), "note", `bulk marker ${i}`);
      expect(await searchNotes(db, "bulk marker")).toHaveLength(30);
    });
  });

  describe("recentActivity", () => {
    it("returns only entries inside the window, newest first", async () => {
      const r = await recentActivity(db, 7, TODAY);
      expect(r.map((x) => x.summary)).toEqual(["contacted -> engaged", "Coffee, discussed fund terms"]);
      expect(r[0]).toMatchObject({ memberId: id.mNw, name: "Northwind Capital", company: null, kind: "stage", by: "VF" });
      const wide = await recentActivity(db, 30, TODAY);
      expect(wide).toHaveLength(3);
      expect(wide[2].summary).toBe("Sent intro email");
      expect((await recentActivity(db, 45, TODAY)).map((x) => x.name)).toContain("Li Wei");
      expect((await recentActivity(db, 45, TODAY)).find((x) => x.name === "Li Wei")!.company).toBe("Acme Capital");
    });
    it("clamps days to 1..90", async () => {
      expect((await recentActivity(db, 0, TODAY)).map((x) => x.summary)).toEqual(["contacted -> engaged"]);
      const lone = await addMember({ person: await addPerson("Long Ago", null) });
      await touch(lone, ago(89), "note", "eighty-nine");
      await touch(lone, ago(95), "note", "ninety-five");
      const r = await recentActivity(db, 500, TODAY);
      expect(r.map((x) => x.summary)).toContain("eighty-nine");
      expect(r.map((x) => x.summary)).not.toContain("ninety-five");
      expect(await recentActivity(db, Number.NaN, TODAY)).toHaveLength(2);
    });
    it("caps at 50", async () => {
      for (let i = 0; i < 60; i++) await touch(id.mRaj, ago(1), "note", `n${i}`);
      expect(await recentActivity(db, 7, TODAY)).toHaveLength(50);
    });
  });

  describe("no query writes", () => {
    async function counts(): Promise<Record<string, number>> {
      const out: Record<string, number> = {};
      for (const t of ["orgs", "people", "members", "touches", "owners", "stages", "roles", "captures", "tags", "member_tags"]) {
        out[t] = (await db.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
      }
      return out;
    }
    async function outsideTransaction() {
      expect((await db.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("off");
      expect((await db.query("SHOW statement_timeout")).rows[0].statement_timeout).toBe("0");
      await db.query("BEGIN");
      await db.query("ROLLBACK");
    }

    it("leaves every table untouched and the connection outside a transaction after each call", async () => {
      const before = await counts();
      const calls: (() => Promise<unknown>)[] = [
        () => vocabulary(db),
        () => findContacts(db, "Jane"),
        () => getContact(db, id.mNw, TODAY),
        () => getPerson(db, id.jane),
        () => listPipeline(db, { due: "overdue" }, TODAY),
        () => pipelineSummary(db, TODAY),
        () => chaseList(db, { owner: "VF" }, TODAY),
        () => searchNotes(db, "family"),
        () => recentActivity(db, 30, TODAY),
      ];
      for (const call of calls) {
        await call();
        await outsideTransaction();
      }
      expect(await counts()).toEqual(before);
    });

    it("rejects a write inside the helper's transaction and still leaves the connection usable", async () => {
      const before = await counts();
      await expect(
        readOnly(db, async () => {
          await db.query("INSERT INTO owners (key, display_name) VALUES ('ZZ', 'Intruder')");
        }),
      ).rejects.toThrow(/read-only transaction/);
      await outsideTransaction();
      expect(await counts()).toEqual(before);
    });

    it("rolls back and rethrows when a query fails, leaving the connection outside a transaction", async () => {
      await expect(readOnly(db, async () => void (await db.query("SELECT * FROM no_such_table")))).rejects.toThrow(/no_such_table/);
      await outsideTransaction();
    });

    it("applies the 8 second statement timeout inside the transaction", async () => {
      const seen = await readOnly(db, async () => (await db.query("SHOW statement_timeout")).rows[0].statement_timeout);
      expect(seen).toBe("8s");
    });
  });
});
