import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "./testing/db";
import { listNudges, snoozeNudge, NUDGE_PAGE, QUIET_DAYS, SNOOZE_DAYS } from "./nudges";
import type { Viewer } from "./todos";

const TODAY = "2026-11-26";
function day(offset: number, from = TODAY): string {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

const VF: Viewer = { ownerKey: "VF", solo: false, appOwnerKeys: ["VF", "AB"] };
const SOLO: Viewer = { ownerKey: "VF", solo: true, appOwnerKeys: ["VF"] };

type Opts = {
  stage?: string;
  priority?: "high" | "medium" | "low" | null;
  owner?: string;
  createdAt?: string; // ISO timestamp
  nudgeAfter?: string | null;
};

describe.skipIf(!testDb.available)("Nudges (real Postgres)", () => {
  let db: Client;

  /** A person-contact in the pipeline; returns the member id. */
  async function member(name: string, o: Opts = {}): Promise<string> {
    const pid = randomUUID();
    const mid = randomUUID();
    await db.query("INSERT INTO people (id, name, name_key, source) VALUES ($1, $2, $3, 'test')", [pid, name, name.toLowerCase()]);
    await db.query(
      `INSERT INTO members (id, person_id, role, stage, owner, priority, source, created_at, nudge_after)
       VALUES ($1, $2, 'investor', $3, $4, $5, 'test', $6::timestamptz, $7::date)`,
      [
        mid,
        pid,
        o.stage ?? "contacted",
        o.owner ?? "VF",
        o.priority ?? null,
        o.createdAt ?? `${day(-1)}T12:00:00Z`,
        o.nudgeAfter ?? null,
      ],
    );
    return mid;
  }
  async function touch(mid: string, kind: string, at: string): Promise<void> {
    await db.query("INSERT INTO touches (member_id, kind, at, summary) VALUES ($1, $2, $3::timestamptz, 'x')", [mid, kind, at]);
  }
  async function openTodo(mid: string): Promise<void> {
    await db.query("INSERT INTO todos (title, member_id, owner, source) VALUES ('Call back', $1, 'VF', 'app')", [mid]);
  }
  const names = (rows: { contact: { name: string } }[]) => rows.map((n) => n.contact.name);

  beforeEach(async () => {
    await testDb.reset();
    db = await testDb.connect();
    await db.query("INSERT INTO owners (key, display_name) VALUES ('AB', 'Alex')");
  });
  afterEach(async () => {
    await db.end();
  });

  it("exports the constants", () => {
    expect(NUDGE_PAGE).toBe(10);
    expect(SNOOZE_DAYS).toBe(14);
    expect(QUIET_DAYS).toEqual({ high: 30, medium: 60 });
  });

  it("does not nudge a first-stage contact with no priority and no to-do, but nudges a first-stage high-priority one", async () => {
    await member("Cold Lead", { stage: "uncontacted" });
    await member("Hot Lead", { stage: "uncontacted", priority: "high" });
    const n = await listNudges(db, VF, TODAY);
    expect(names(n.noNextStep)).toEqual(["Hot Lead"]);
    expect(n.noNextStepTotal).toBe(1);
  });

  it("nudges a contact past the first stage with no open to-do, and not one that has an open to-do", async () => {
    const a = await member("Has Todo", { stage: "engaged" });
    await member("No Todo", { stage: "contacted" });
    await openTodo(a);
    const n = await listNudges(db, VF, TODAY);
    expect(names(n.noNextStep)).toEqual(["No Todo"]);
    expect(n.noNextStep[0]).toMatchObject({ kind: "no_next_step", quietDays: null });
    expect(n.noNextStep[0].contact).toMatchObject({ stage: "contacted", stageLabel: "Contacted", memberKind: "person" });
  });

  it("a done or dropped to-do does not count as a next step", async () => {
    const a = await member("Done Todo", { stage: "engaged" });
    await openTodo(a);
    await db.query("UPDATE todos SET status = 'done' WHERE member_id = $1", [a]);
    const n = await listNudges(db, VF, TODAY);
    expect(names(n.noNextStep)).toEqual(["Done Todo"]);
  });

  it("leaves out contacts in a terminal stage", async () => {
    await member("Client", { stage: "client", priority: "high" });
    await member("Passed", { stage: "passed", priority: "high" });
    const n = await listNudges(db, VF, TODAY);
    expect(n.noNextStep).toEqual([]);
    expect(n.quiet).toEqual([]);
  });

  it("a high-priority contact last contacted 29 days ago is not quiet, and 30 days ago is", async () => {
    const a = await member("Twenty Nine", { stage: "engaged", priority: "high", createdAt: `${day(-90)}T10:00:00Z` });
    const b = await member("Thirty", { stage: "engaged", priority: "high", createdAt: `${day(-90)}T10:00:00Z` });
    await openTodo(a);
    await openTodo(b);
    await touch(a, "call", `${day(-29)}T00:00:00Z`);
    await touch(b, "call", `${day(-30)}T23:59:00Z`);
    const n = await listNudges(db, VF, TODAY);
    expect(names(n.quiet)).toEqual(["Thirty"]);
    expect(n.quiet[0]).toMatchObject({ kind: "quiet", quietDays: 30 });
    expect(n.quietTotal).toBe(1);
  });

  it("medium priority goes quiet at 60 days; low priority never does", async () => {
    const a = await member("Med 59", { stage: "engaged", priority: "medium" });
    const b = await member("Med 60", { stage: "engaged", priority: "medium" });
    const c = await member("Low Old", { stage: "engaged", priority: "low" });
    const d = await member("None Old", { stage: "engaged" });
    for (const m of [a, b, c, d]) await openTodo(m);
    await touch(a, "email", `${day(-59)}T12:00:00Z`);
    await touch(b, "email", `${day(-60)}T12:00:00Z`);
    await touch(c, "email", `${day(-400)}T12:00:00Z`);
    await touch(d, "email", `${day(-400)}T12:00:00Z`);
    const n = await listNudges(db, VF, TODAY);
    expect(names(n.quiet)).toEqual(["Med 60"]);
    expect(n.quiet[0].quietDays).toBe(60);
  });

  it("measures from the newest real contact and ignores system and stage entries", async () => {
    const a = await member("Recent System", { stage: "engaged", priority: "high" });
    await openTodo(a);
    await touch(a, "meeting", `${day(-100)}T12:00:00Z`);
    await touch(a, "system", `${day(-1)}T12:00:00Z`);
    await touch(a, "stage", `${day(-2)}T12:00:00Z`);
    const b = await member("Recent Note", { stage: "engaged", priority: "high" });
    await openTodo(b);
    await touch(b, "meeting", `${day(-100)}T12:00:00Z`);
    await touch(b, "note", `${day(-3)}T12:00:00Z`);
    const n = await listNudges(db, VF, TODAY);
    expect(names(n.quiet)).toEqual(["Recent System"]);
    expect(n.quiet[0].quietDays).toBe(100);
    expect(n.quiet[0].contact.lastAction).toMatchObject({ kind: "meeting" });
  });

  it("counts an imported contact (system entries only) from the day it was added", async () => {
    const a = await member("Imported", { stage: "engaged", priority: "high", createdAt: `${day(-31)}T09:00:00Z` });
    const b = await member("Fresh Import", { stage: "engaged", priority: "high", createdAt: `${day(-29)}T09:00:00Z` });
    await openTodo(a);
    await openTodo(b);
    await touch(a, "system", `${day(-5)}T09:00:00Z`);
    await touch(b, "system", `${day(-5)}T09:00:00Z`);
    const n = await listNudges(db, VF, TODAY);
    expect(names(n.quiet)).toEqual(["Imported"]);
    expect(n.quiet[0]).toMatchObject({ quietDays: 31 });
    expect(n.quiet[0].contact.lastAction).toBeNull();
  });

  it("compares a touch by its UTC calendar day", async () => {
    const a = await member("Late Night", { stage: "engaged", priority: "high" });
    await openTodo(a);
    await touch(a, "call", `${day(-29)}T23:59:59Z`);
    const b = await member("Early Morning", { stage: "engaged", priority: "high" });
    await openTodo(b);
    await touch(b, "call", `${day(-30)}T00:00:01Z`);
    const n = await listNudges(db, VF, TODAY);
    expect(names(n.quiet)).toEqual(["Early Morning"]);
  });

  it("a contact in both lists appears only under noNextStep", async () => {
    await member("Both", { stage: "engaged", priority: "high", createdAt: `${day(-90)}T10:00:00Z` });
    const n = await listNudges(db, VF, TODAY);
    expect(names(n.noNextStep)).toEqual(["Both"]);
    expect(n.quiet).toEqual([]);
    expect(n.quietTotal).toBe(0);
  });

  it("sorts by priority, then stage furthest first, then name", async () => {
    await member("Zed", { stage: "engaged", priority: "high" });
    await member("Amy", { stage: "contacted", priority: "high" });
    await member("Bob", { stage: "engaged", priority: "high" });
    await member("Med", { stage: "engaged", priority: "medium" });
    await member("Low", { stage: "engaged", priority: "low" });
    await member("None", { stage: "engaged" });
    const n = await listNudges(db, VF, TODAY);
    expect(names(n.noNextStep)).toEqual(["Bob", "Zed", "Amy", "Med", "Low", "None"]);
  });

  it("gives 10 rows and the full total when 12 qualify, and honours a limit", async () => {
    for (let i = 0; i < 12; i++) await member(`Lead ${String(i).padStart(2, "0")}`, { stage: "engaged" });
    const n = await listNudges(db, VF, TODAY);
    expect(n.noNextStep).toHaveLength(10);
    expect(n.noNextStepTotal).toBe(12);
    const all = await listNudges(db, VF, TODAY, { limit: 50 });
    expect(all.noNextStep).toHaveLength(12);
    const few = await listNudges(db, VF, TODAY, { limit: 3 });
    expect(few.noNextStep).toHaveLength(3);
    expect(few.noNextStepTotal).toBe(12);
  });

  it("caps the quiet list too, with its own total", async () => {
    for (let i = 0; i < 12; i++) {
      const m = await member(`Quiet ${String(i).padStart(2, "0")}`, { stage: "engaged", priority: "high", createdAt: `${day(-90)}T10:00:00Z` });
      await openTodo(m);
    }
    const n = await listNudges(db, VF, TODAY);
    expect(n.quiet).toHaveLength(10);
    expect(n.quietTotal).toBe(12);
    expect(n.noNextStepTotal).toBe(0);
  });

  it("hides a snoozed contact for 14 days and shows it again on day 14", async () => {
    const m = await member("Snoozed", { stage: "engaged" });
    expect((await snoozeNudge(db, m, TODAY)).status).toBe("ok");
    const row = (await db.query("SELECT nudge_after::text AS d FROM members WHERE id = $1", [m])).rows[0];
    expect(row.d).toBe(day(14));
    expect(names((await listNudges(db, VF, TODAY)).noNextStep)).toEqual([]);
    expect(names((await listNudges(db, VF, day(13))).noNextStep)).toEqual([]);
    expect(names((await listNudges(db, VF, day(14))).noNextStep)).toEqual(["Snoozed"]);
  });

  it("a snooze hides the contact from the quiet list as well", async () => {
    const m = await member("Snoozed Quiet", { stage: "engaged", priority: "high", createdAt: `${day(-90)}T10:00:00Z` });
    await openTodo(m);
    await snoozeNudge(db, m, TODAY);
    expect((await listNudges(db, VF, TODAY)).quiet).toEqual([]);
    expect(names((await listNudges(db, VF, day(14))).quiet)).toEqual(["Snoozed Quiet"]);
  });

  it("snooze leaves next_action and the timeline alone", async () => {
    const m = await member("Mirror", { stage: "engaged" });
    await openTodo(m);
    await snoozeNudge(db, m, TODAY);
    const row = (await db.query("SELECT next_action FROM members WHERE id = $1", [m])).rows[0];
    expect(row.next_action).toBe("Call back");
    expect((await db.query("SELECT count(*)::int AS n FROM todos WHERE member_id = $1", [m])).rows[0].n).toBe(1);
    expect((await db.query("SELECT count(*)::int AS n FROM touches WHERE member_id = $1", [m])).rows[0].n).toBe(0);
  });

  it("snooze reports missing for an unknown or malformed id", async () => {
    expect((await snoozeNudge(db, randomUUID(), TODAY)).status).toBe("missing");
    expect((await snoozeNudge(db, "not-a-uuid", TODAY)).status).toBe("missing");
  });

  it("a team viewer does not get another owner's contacts; a solo viewer gets all", async () => {
    await member("Mine", { stage: "engaged", owner: "VF" });
    await member("Theirs", { stage: "engaged", owner: "AB" });
    const mine = await listNudges(db, VF, TODAY);
    expect(names(mine.noNextStep)).toEqual(["Mine"]);
    expect(mine.noNextStepTotal).toBe(1);
    const solo = await listNudges(db, SOLO, TODAY);
    expect(names(solo.noNextStep).sort()).toEqual(["Mine", "Theirs"]);
  });

  it("builds the contact for a company member, with the person's company and last action", async () => {
    const oid = randomUUID();
    const pid = randomUUID();
    await db.query("INSERT INTO orgs (id, name, name_key, source) VALUES ($1, 'Acme Capital', 'acme capital', 'test')", [oid]);
    await db.query("INSERT INTO people (id, org_id, name, name_key, source) VALUES ($1, $2, 'Pat Poe', 'pat poe', 'test')", [pid, oid]);
    const mp = randomUUID();
    const mo = randomUUID();
    await db.query(`INSERT INTO members (id, person_id, role, stage, owner, source) VALUES ($1, $2, 'investor', 'engaged', 'VF', 'test')`, [mp, pid]);
    await db.query(`INSERT INTO members (id, org_id, role, stage, owner, source) VALUES ($1, $2, 'investor', 'engaged', 'VF', 'test')`, [mo, oid]);
    await touch(mp, "email", `${day(-3)}T12:00:00Z`);
    const n = await listNudges(db, VF, TODAY);
    const pat = n.noNextStep.find((x) => x.contact.name === "Pat Poe")!;
    expect(pat.contact).toMatchObject({ memberKind: "person", company: "Acme Capital", personId: pid, orgId: null, aboutPersonId: null });
    expect(pat.contact.lastAction).toEqual({ kind: "email", at: `${day(-3)}T12:00:00.000Z` });
    const acme = n.noNextStep.find((x) => x.contact.name === "Acme Capital")!;
    expect(acme.contact).toMatchObject({ memberKind: "company", company: null, personId: null, orgId: oid });
  });
});
