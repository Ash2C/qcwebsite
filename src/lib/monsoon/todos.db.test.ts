import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lastAction } from "./rules";
import { makeV1TestDb, testDb } from "./testing/db";
import {
  addTodo,
  completeTodo,
  dropTodo,
  editTodo,
  getTodo,
  listTodos,
  reopenTodo,
  setOutcome,
  todosReady,
  validDay,
  type Viewer,
  type WriteResult,
} from "./todos";

const TODAY = "2026-11-26";
function day(offset: number): string {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

const VF: Viewer = { ownerKey: "VF", solo: false, appOwnerKeys: ["VF", "AB"] };
const AB: Viewer = { ownerKey: "AB", solo: false, appOwnerKeys: ["VF", "AB"] };

function todoOf(r: WriteResult) {
  if (r.status !== "ok" && r.status !== "already") throw new Error(`expected a to-do, got ${r.status}`);
  return r.todo;
}

describe.skipIf(!testDb.available)("To-dos (real Postgres)", () => {
  let db: Client;
  const id = { raf: randomUUID(), mia: randomUUID(), sam: randomUUID(), mRaf: randomUUID(), mSam: randomUUID(), loose: randomUUID() };

  async function summaries(member: string): Promise<{ kind: string; summary: string; by_whom: string | null }[]> {
    return (await db.query("SELECT kind, summary, by_whom FROM touches WHERE member_id = $1 ORDER BY at, id", [member])).rows;
  }
  async function mirror(member: string) {
    return (await db.query("SELECT next_action, next_action_date::text AS d FROM members WHERE id = $1", [member])).rows[0];
  }

  beforeEach(async () => {
    await testDb.reset();
    db = await testDb.connect();
    await db.query("INSERT INTO owners (key, display_name) VALUES ('AB', 'Alex')");
    await db.query(
      `INSERT INTO orgs (id, name, name_key, source) VALUES ($1, 'Raffles Family Office', 'raffles family office', 'test')`,
      [id.raf],
    );
    await db.query(
      `INSERT INTO people (id, org_id, name, name_key, source) VALUES
         ($1, $3, 'Mia Chen', 'mia chen', 'test'), ($2, NULL, 'Sam Ortiz', 'sam ortiz', 'test'), ($4, NULL, 'Loose Lee', 'loose lee', 'test')`,
      [id.mia, id.sam, id.raf, id.loose],
    );
    await db.query(
      `INSERT INTO members (id, org_id, person_id, role, stage, priority, source) VALUES
         ($1, $3, NULL, 'investor', 'engaged', 'high', 'test'),
         ($2, NULL, $4, 'investor', 'contacted', NULL, 'test')`,
      [id.mRaf, id.mSam, id.raf, id.sam],
    );
  });
  afterEach(async () => {
    await db.end();
  });

  it("reports whether the to-do table is there from the schema version", async () => {
    expect(await todosReady(db)).toBe(true);
    const v1 = makeV1TestDb("todos_v1");
    await v1.reset();
    const old = await v1.connect();
    try {
      expect(await todosReady(old)).toBe(false);
    } finally {
      await old.end();
    }
  });

  it("checks a calendar day", () => {
    expect(validDay("2026-02-28")).toBe(true);
    expect(validDay("2026-02-30")).toBe(false);
    expect(validDay("2026-2-3")).toBe(false);
  });

  it("adds a to-do owned by the viewer and filed under the contact, with no timeline entry", async () => {
    const r = await addTodo(db, { title: "  Send deck  ", dueDate: day(2), target: { memberId: id.mRaf }, source: "app" }, VF, TODAY);
    expect(r.status).toBe("ok");
    const t = todoOf(r);
    expect(t).toMatchObject({
      title: "Send deck",
      dueDate: day(2),
      firstDueDate: day(2),
      movedCount: 0,
      status: "open",
      owner: "VF",
      mine: true,
      due: "week",
      contact: { memberId: id.mRaf, memberKind: "company", name: "Raffles Family Office", orgId: id.raf, personId: null, stage: "engaged", stageLabel: "Engaged", priority: "high", aboutName: null },
    });
    expect(await summaries(id.mRaf)).toEqual([]);
  });

  it("creates the owner row of a signed-in person that is not there yet", async () => {
    const r = await addTodo(db, { title: "Call", dueDate: null, source: "app" }, { ownerKey: "NEW", solo: true, appOwnerKeys: ["NEW"] }, TODAY);
    expect(r.status).toBe("ok");
    expect((await db.query("SELECT count(*)::int AS n FROM owners WHERE key = 'NEW'")).rows[0].n).toBe(1);
  });

  it("lists open to-dos overdue, today, week, later, undated, by date then creation", async () => {
    const add = (title: string, due: string | null) => addTodo(db, { title, dueDate: due, source: "app" }, VF, TODAY);
    await add("undated one", null);
    await add("later", day(30));
    await add("week b", day(5));
    await add("today", TODAY);
    await add("overdue", day(-3));
    await add("week a", day(2));
    await add("undated two", null);
    const { open } = await listTodos(db, VF, TODAY);
    expect(open.map((t) => [t.title, t.due])).toEqual([
      ["overdue", "overdue"],
      ["today", "today"],
      ["week a", "week"],
      ["week b", "week"],
      ["later", "later"],
      ["undated one", "undated"],
      ["undated two", "undated"],
    ]);
  });

  it("lists a to-do with no owner and one with an unknown owner key to a non-solo viewer", async () => {
    await db.query("INSERT INTO owners (key, display_name) VALUES ('ZZ', 'Core key')");
    await addTodo(db, { title: "mine", dueDate: null, source: "app" }, VF, TODAY);
    await addTodo(db, { title: "theirs", dueDate: null, source: "app" }, AB, TODAY);
    await db.query("INSERT INTO todos (title, source) VALUES ('no owner', 'core')");
    await db.query("INSERT INTO todos (title, owner, source) VALUES ('unknown key', 'ZZ', 'core')");
    const titles = async (v: Viewer) => (await listTodos(db, v, TODAY)).open.map((t) => t.title).sort();
    expect(await titles(VF)).toEqual(["mine", "no owner", "unknown key"]);
    expect(await titles({ ...VF, solo: true })).toEqual(["mine", "no owner", "theirs", "unknown key"]);
    const open = (await listTodos(db, VF, TODAY)).open;
    expect(open.find((t) => t.title === "mine")?.mine).toBe(true);
    expect(open.find((t) => t.title === "no owner")?.mine).toBe(false);
  });

  it("a profile lists all of a contact's to-dos whoever owns them", async () => {
    await addTodo(db, { title: "mine", dueDate: null, target: { memberId: id.mRaf }, source: "app" }, VF, TODAY);
    await addTodo(db, { title: "theirs", dueDate: null, target: { memberId: id.mRaf }, source: "app" }, AB, TODAY);
    await addTodo(db, { title: "other contact", dueDate: null, target: { memberId: id.mSam }, source: "app" }, AB, TODAY);
    const r = await listTodos(db, VF, TODAY, { memberId: id.mRaf });
    expect(r.open.map((t) => t.title).sort()).toEqual(["mine", "theirs"]);
  });

  it("ticking twice writes one 'To-do done' entry and answers already the second time", async () => {
    const t = todoOf(await addTodo(db, { title: "Send deck", dueDate: null, target: { memberId: id.mRaf }, source: "app" }, VF, TODAY));
    const first = await completeTodo(db, t.id, VF, TODAY);
    expect(first.status).toBe("ok");
    expect(todoOf(first)).toMatchObject({ status: "done" });
    expect(todoOf(first).closedAt).not.toBeNull();
    expect((await completeTodo(db, t.id, VF, TODAY)).status).toBe("already");
    expect(await summaries(id.mRaf)).toEqual([{ kind: "system", summary: "To-do done: Send deck", by_whom: "VF" }]);
  });

  it("a to-do for a person under a member company goes on the company's member, with the person's name first on the timeline", async () => {
    const t = todoOf(await addTodo(db, { title: "Send deck", dueDate: null, target: { personId: id.mia }, source: "app" }, VF, TODAY));
    expect(t.contact).toMatchObject({ memberId: id.mRaf, aboutPersonId: id.mia, aboutName: "Mia Chen" });
    await completeTodo(db, t.id, VF, TODAY);
    await setOutcome(db, t.id, "She wants terms", VF, TODAY);
    await reopenTodo(db, t.id, VF, TODAY);
    await dropTodo(db, t.id, VF, TODAY);
    expect((await summaries(id.mRaf)).map((s) => [s.kind, s.summary])).toEqual([
      ["system", "Mia Chen: To-do done: Send deck"],
      ["note", "Mia Chen: Send deck: She wants terms"],
      ["system", "Mia Chen: To-do reopened: Send deck"],
      ["system", "Mia Chen: To-do dropped: Send deck"],
    ]);
  });

  it("a target that resolves to nothing, or to a person not in the pipeline, gives missing", async () => {
    expect((await addTodo(db, { title: "x", dueDate: null, target: { memberId: randomUUID() }, source: "app" }, VF, TODAY)).status).toBe("missing");
    expect((await addTodo(db, { title: "x", dueDate: null, target: { personId: id.loose }, source: "app" }, VF, TODAY)).status).toBe("missing");
    expect((await completeTodo(db, randomUUID(), VF, TODAY)).status).toBe("missing");
    expect((await completeTodo(db, "not-a-uuid", VF, TODAY)).status).toBe("missing");
    expect((await db.query("SELECT count(*)::int AS n FROM todos")).rows[0].n).toBe(0);
  });

  it("a to-do with no contact writes no timeline entry and keeps its outcome on the row", async () => {
    const t = todoOf(await addTodo(db, { title: "Renew domain", dueDate: null, source: "app" }, VF, TODAY));
    await completeTodo(db, t.id, VF, TODAY);
    const r = await setOutcome(db, t.id, "Renewed for 2 years", VF, TODAY);
    expect(todoOf(r).outcome).toBe("Renewed for 2 years");
    expect((await getTodo(db, VF, t.id, TODAY))?.outcome).toBe("Renewed for 2 years");
    expect((await db.query("SELECT count(*)::int AS n FROM touches")).rows[0].n).toBe(0);
  });

  it("an outcome entry is kind note, so lastAction counts it; the done entry is system and does not", async () => {
    const t = todoOf(await addTodo(db, { title: "Call Sam", dueDate: null, target: { memberId: id.mSam }, source: "app" }, VF, TODAY));
    await completeTodo(db, t.id, VF, TODAY);
    expect((await getTodo(db, VF, t.id, TODAY))?.contact?.lastAction).toBeNull();
    const rows = (await db.query("SELECT kind, at FROM touches WHERE member_id = $1", [id.mSam])).rows;
    expect(lastAction(rows)).toBeNull();
    await setOutcome(db, t.id, "Spoke, he is in", VF, TODAY);
    const after = await getTodo(db, VF, t.id, TODAY);
    expect(after?.contact?.lastAction?.kind).toBe("note");
    const done = (await listTodos(db, VF, TODAY)).done;
    expect(done.map((d) => d.id)).toEqual([t.id]);
  });

  it("an outcome needs a done to-do, and a second identical one answers already and writes nothing", async () => {
    const t = todoOf(await addTodo(db, { title: "Call Sam", dueDate: null, target: { memberId: id.mSam }, source: "app" }, VF, TODAY));
    expect((await setOutcome(db, t.id, "early", VF, TODAY)).status).toBe("invalid");
    await completeTodo(db, t.id, VF, TODAY);
    expect((await setOutcome(db, t.id, "Went well", VF, TODAY)).status).toBe("ok");
    expect((await setOutcome(db, t.id, "Went well", VF, TODAY)).status).toBe("already");
    expect((await setOutcome(db, t.id, "  ", VF, TODAY)).status).toBe("invalid");
    expect((await setOutcome(db, t.id, "x".repeat(2001), VF, TODAY)).status).toBe("invalid");
    expect((await summaries(id.mSam)).map((s) => s.summary)).toEqual(["To-do done: Call Sam", "Call Sam: Went well"]);
  });

  it("dropping a dropped to-do and reopening an open one answer already with no entry", async () => {
    const t = todoOf(await addTodo(db, { title: "Chase", dueDate: null, target: { memberId: id.mSam }, source: "app" }, VF, TODAY));
    expect((await reopenTodo(db, t.id, VF, TODAY)).status).toBe("already");
    expect((await dropTodo(db, t.id, VF, TODAY)).status).toBe("ok");
    expect((await dropTodo(db, t.id, VF, TODAY)).status).toBe("already");
    expect((await summaries(id.mSam)).length).toBe(1);
    expect((await listTodos(db, VF, TODAY)).open).toEqual([]);
    expect((await listTodos(db, VF, TODAY)).done).toEqual([]);
  });

  it("lists done to-dos closed within doneDays, newest first", async () => {
    const a = todoOf(await addTodo(db, { title: "a", dueDate: null, source: "app" }, VF, TODAY));
    const b = todoOf(await addTodo(db, { title: "b", dueDate: null, source: "app" }, VF, TODAY));
    const old = todoOf(await addTodo(db, { title: "old", dueDate: null, source: "app" }, VF, TODAY));
    for (const t of [old, a, b]) await completeTodo(db, t.id, VF, TODAY);
    await db.query("UPDATE todos SET closed_at = now() - interval '40 days' WHERE id = $1", [old.id]);
    await db.query("UPDATE todos SET closed_at = now() - interval '1 day' WHERE id = $1", [a.id]);
    expect((await listTodos(db, VF, TODAY)).done.map((t) => t.title)).toEqual(["b", "a"]);
    expect((await listTodos(db, VF, TODAY, { doneDays: 90 })).done.map((t) => t.title)).toEqual(["b", "a", "old"]);
  });

  it("moving the date later twice shows movedCount 2 and the first date kept", async () => {
    const t = todoOf(await addTodo(db, { title: "Send deck", dueDate: day(1), source: "app" }, VF, TODAY));
    await editTodo(db, t.id, { dueDate: day(3) }, VF, TODAY);
    const r = await editTodo(db, t.id, { dueDate: day(10) }, VF, TODAY);
    expect(todoOf(r)).toMatchObject({ movedCount: 2, firstDueDate: day(1), dueDate: day(10) });
    const earlier = await editTodo(db, t.id, { dueDate: day(2) }, VF, TODAY);
    expect(todoOf(earlier)).toMatchObject({ movedCount: 2 });
    expect(todoOf(await editTodo(db, t.id, { dueDate: null }, VF, TODAY)).dueDate).toBeNull();
  });

  it("edits the title and the contact, leaves a field out unchanged, and writes no timeline entry", async () => {
    const t = todoOf(await addTodo(db, { title: "Send deck", dueDate: day(1), target: { memberId: id.mRaf }, source: "app" }, VF, TODAY));
    const r = await editTodo(db, t.id, { title: "Send the deck", target: { personId: id.mia } }, VF, TODAY);
    expect(todoOf(r)).toMatchObject({ title: "Send the deck", dueDate: day(1), contact: { memberId: id.mRaf, aboutName: "Mia Chen" } });
    expect(todoOf(await editTodo(db, t.id, { target: { memberId: id.mSam } }, VF, TODAY)).contact).toMatchObject({ memberId: id.mSam, aboutName: null });
    expect(todoOf(await editTodo(db, t.id, { target: null }, VF, TODAY)).contact).toBeNull();
    expect((await editTodo(db, t.id, { title: "Send the deck" }, VF, TODAY)).status).toBe("already");
    expect((await editTodo(db, t.id, { target: { memberId: randomUUID() } }, VF, TODAY)).status).toBe("missing");
    expect((await editTodo(db, randomUUID(), { title: "x" }, VF, TODAY)).status).toBe("missing");
    expect((await db.query("SELECT count(*)::int AS n FROM touches")).rows[0].n).toBe(0);
  });

  it("rejects an empty title, a 301-character title, and 2026-02-30 as a date with status invalid", async () => {
    expect((await addTodo(db, { title: "   ", dueDate: null, source: "app" }, VF, TODAY)).status).toBe("invalid");
    expect((await addTodo(db, { title: "x".repeat(301), dueDate: null, source: "app" }, VF, TODAY)).status).toBe("invalid");
    expect((await addTodo(db, { title: "x".repeat(300), dueDate: null, source: "app" }, VF, TODAY)).status).toBe("ok");
    const bad = await addTodo(db, { title: "ok", dueDate: "2026-02-30", source: "app" }, VF, TODAY);
    expect(bad).toMatchObject({ status: "invalid", reason: "That date is not a real day." });
    const t = todoOf(await addTodo(db, { title: "ok", dueDate: null, source: "app" }, VF, TODAY));
    expect((await editTodo(db, t.id, { title: "" }, VF, TODAY)).status).toBe("invalid");
    expect((await editTodo(db, t.id, { dueDate: "2026-13-01" }, VF, TODAY)).status).toBe("invalid");
    expect((await db.query("SELECT count(*)::int AS n FROM todos")).rows[0].n).toBe(2);
  });

  it("after adding, ticking and reopening, members.next_action matches the earliest open to-do", async () => {
    const target = { memberId: id.mRaf };
    const late = todoOf(await addTodo(db, { title: "Late", dueDate: day(9), target, source: "app" }, VF, TODAY));
    const soon = todoOf(await addTodo(db, { title: "Soon", dueDate: day(2), target, source: "app" }, VF, TODAY));
    expect(await mirror(id.mRaf)).toEqual({ next_action: "Soon", d: day(2) });
    await completeTodo(db, soon.id, VF, TODAY);
    expect(await mirror(id.mRaf)).toEqual({ next_action: "Late", d: day(9) });
    await reopenTodo(db, soon.id, VF, TODAY);
    expect(await mirror(id.mRaf)).toEqual({ next_action: "Soon", d: day(2) });
    await dropTodo(db, soon.id, VF, TODAY);
    await completeTodo(db, late.id, VF, TODAY);
    expect(await mirror(id.mRaf)).toEqual({ next_action: null, d: null });
  });

  it("leaves the connection outside a transaction after every call", async () => {
    const t = todoOf(await addTodo(db, { title: "x", dueDate: null, source: "app" }, VF, TODAY));
    await completeTodo(db, t.id, VF, TODAY);
    await completeTodo(db, t.id, VF, TODAY);
    await listTodos(db, VF, TODAY);
    await getTodo(db, VF, t.id, TODAY);
    expect((await db.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("off");
    await db.query("BEGIN");
    await db.query("ROLLBACK");
  });
});
