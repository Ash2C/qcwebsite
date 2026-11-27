import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientBase } from "pg";

const { t } = vi.hoisted(() => ({ t: { listTodos: vi.fn() } }));
vi.mock("../todos", async (orig) => ({ ...(await orig<typeof import("../todos")>()), ...t }));
const { n } = vi.hoisted(() => ({ n: { listNudges: vi.fn() } }));
vi.mock("../nudges", () => n);
const { a } = vi.hoisted(() => ({ a: { resolve: vi.fn(), proposeNote: vi.fn(), proposeStage: vi.fn() } }));
vi.mock("./actions", () => a);
const { p } = vi.hoisted(() => ({
  p: { proposeAddTodo: vi.fn(), proposeCompleteTodo: vi.fn(), proposeMoveTodo: vi.fn(), proposeDropTodo: vi.fn() },
}));
vi.mock("./todo-actions", () => p);

import { runTool, TODO_TOOLS, TOOLS, toolsFor, GRANOLA_TOOLS, type ToolContext } from "./tools";

const db = { fake: true } as unknown as ClientBase;
const CUSTOMER = "c0000000-0000-4000-8000-00000000000a";
const VIEWER = { ownerKey: "VF", solo: true, appOwnerKeys: ["VF"] };
const ctx: ToolContext = {
  db, customerId: CUSTOMER, estate: "traxo", defaultRole: "investor", today: "2026-11-26", nowMs: 1_000, todos: { viewer: VIEWER },
};
const ID = "11111111-1111-4111-8111-111111111111";
const TODO = "55555555-5555-4555-8555-555555555555";
const NAMES = ["list_todos", "list_nudges", "propose_todo", "propose_complete_todo", "propose_move_todo", "propose_drop_todo"];

beforeEach(() => {
  for (const f of [...Object.values(t), ...Object.values(n), ...Object.values(a), ...Object.values(p)]) f.mockReset();
});

function contact(over: Record<string, unknown> = {}) {
  return {
    memberId: ID, memberKind: "person", name: "Jane Tan", company: "Acme", personId: "22222222-2222-4222-8222-222222222222", orgId: null,
    aboutPersonId: null, aboutName: null, stage: "engaged", stageLabel: "Engaged", priority: "high",
    lastAction: { kind: "meeting", at: "2026-11-01T10:00:00.000Z" }, ...over,
  };
}
function todo(i: number, over: Record<string, unknown> = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, title: `Task ${i}`, dueDate: "2026-11-27", firstDueDate: "2026-11-27",
    movedCount: 0, status: "open", outcome: null, closedAt: null, owner: "VF", mine: true, due: "week", contact: contact(), ...over,
  };
}

describe("the tool list", () => {
  it("is unchanged without the to-do table, and gains exactly the six after the twelve with it", () => {
    expect(toolsFor(false)).toBe(TOOLS);
    expect(toolsFor(false, false)).toBe(TOOLS);
    expect(TODO_TOOLS.map((x) => x.name)).toEqual(NAMES);
    const ready = toolsFor(false, true);
    expect(ready.slice(0, 12)).toEqual(TOOLS);
    expect(ready.slice(12).map((x) => x.name)).toEqual(NAMES);
    const none = toolsFor(true, false).map((x) => x.name);
    for (const name of NAMES) expect(none).not.toContain(name);
    const both = toolsFor(true, true);
    expect(both.slice(12, 15)).toEqual(GRANOLA_TOOLS);
    expect(both.slice(15).map((x) => x.name)).toEqual(NAMES);
    // No tool of the old next-action kind exists beside the to-do tools.
    expect(ready.map((x) => x.name).filter((x) => /next/.test(x))).toEqual([]);
  });

  it("describes each to-do tool with an object schema and the right required inputs", () => {
    const req = (name: string) => TODO_TOOLS.find((x) => x.name === name)!.input_schema.required;
    expect(req("list_todos")).toEqual([]);
    expect(req("propose_todo")).toEqual(["title"]);
    expect(req("propose_complete_todo")).toEqual(["todo_id"]);
    expect(req("propose_move_todo")).toEqual(["todo_id", "due_date"]);
    expect(req("propose_drop_todo")).toEqual(["todo_id"]);
    for (const x of TODO_TOOLS) expect(x.description.length).toBeGreaterThan(20);
  });
});

describe("without the to-do table", () => {
  it("the six tools are unknown to runTool and nothing is called", async () => {
    const bare: ToolContext = { ...ctx };
    delete bare.todos;
    for (const name of NAMES) {
      const r = await runTool(bare, name, { title: "x", todo_id: TODO, due_date: "" });
      expect(r.result).toEqual({ error: "Unknown tool." });
    }
    for (const f of [...Object.values(t), ...Object.values(n), ...Object.values(p)]) expect(f).not.toHaveBeenCalled();
  });
});

describe("list_todos", () => {
  it("lists the viewer's open to-dos with contact, bucket and refs, clipped", async () => {
    t.listTodos.mockResolvedValue({
      open: [todo(1, { title: "x".repeat(400), movedCount: 2 }), todo(2, { contact: null, due: "undated", dueDate: null })],
      done: [todo(3, { status: "done" })],
    });
    const out = await runTool(ctx, "list_todos", {});
    expect(t.listTodos).toHaveBeenCalledWith(db, VIEWER, "2026-11-26", {});
    const r = out.result as { todos: Record<string, unknown>[]; total: number };
    expect(r.total).toBe(2);
    expect(r.todos).toHaveLength(2);
    expect((r.todos[0].title as string).length).toBeLessThan(200);
    expect(r.todos[0]).toMatchObject({
      due: "week", movedCount: 2, memberId: ID, name: "Jane Tan", company: "Acme", stage: "Engaged", priority: "high", lastContact: "meeting 2026-11-01",
    });
    expect(r.todos[1]).not.toHaveProperty("memberId");
    expect(out.refs.map((x) => x.name)).toEqual(["Jane Tan"]);
  });

  it("filters by bucket, passes a contact's member id, and names a person filed under a company by the person", async () => {
    const PERSON = "33333333-3333-4333-8333-333333333333";
    a.resolve.mockResolvedValue({ ok: true, member: { memberId: ID, about: "Mia Chen" } });
    t.listTodos.mockResolvedValue({
      open: [
        todo(1, { due: "overdue", contact: contact({ memberKind: "company", name: "Raffles", company: null, personId: null, aboutPersonId: PERSON, aboutName: "Mia Chen" }) }),
        todo(2, { due: "overdue", contact: contact({ aboutPersonId: "44444444-4444-4444-8444-444444444444", aboutName: "Other" }) }),
        todo(3, { due: "later" }),
      ],
      done: [],
    });
    const out = await runTool(ctx, "list_todos", { due: "overdue", person_id: PERSON });
    expect(a.resolve).toHaveBeenCalledWith(db, { personId: PERSON });
    expect(t.listTodos).toHaveBeenCalledWith(db, VIEWER, "2026-11-26", { memberId: ID });
    const r = out.result as { todos: Record<string, unknown>[]; total: number };
    expect(r.total).toBe(1);
    expect(r.todos[0]).toMatchObject({ name: "Mia Chen", company: "Raffles", personId: PERSON });
  });

  it("says so when the contact is unknown, and rejects a bad bucket", async () => {
    a.resolve.mockResolvedValue({ ok: false, reason: "No such contact." });
    expect((await runTool(ctx, "list_todos", { member_id: ID })).result).toEqual({ error: "No such contact." });
    expect(t.listTodos).not.toHaveBeenCalled();
    expect(((await runTool(ctx, "list_todos", { due: "soon" })).result as { error: string }).error).toMatch(/one of/);
  });

  it("returns at most 50 to-dos and says how many are not shown", async () => {
    t.listTodos.mockResolvedValue({ open: Array.from({ length: 73 }, (_, i) => todo(i + 1)), done: [] });
    const r = (await runTool(ctx, "list_todos", {})).result as { todos: unknown[]; total: number; note: string };
    expect(r.todos).toHaveLength(50);
    expect(r.total).toBe(73);
    expect(r.note).toBe("Showing the first 50 of 73; 23 not shown.");
  });
});

describe("list_nudges", () => {
  it("returns both lists with their totals and the contacts as refs", async () => {
    n.listNudges.mockResolvedValue({
      noNextStep: [{ kind: "no_next_step", contact: contact(), quietDays: null }],
      quiet: [{ kind: "quiet", contact: contact({ memberId: TODO, name: "Sam", company: null, personId: null, stageLabel: "Contacted" }), quietDays: 45 }],
      noNextStepTotal: 12,
      quietTotal: 3,
    });
    const out = await runTool(ctx, "list_nudges", {});
    expect(n.listNudges).toHaveBeenCalledWith(db, VIEWER, "2026-11-26", undefined);
    const r = out.result as Record<string, unknown>;
    expect(r).toMatchObject({ noNextStepTotal: 12, quietTotal: 3 });
    expect((r.quiet as Record<string, unknown>[])[0]).toMatchObject({ name: "Sam", quietDays: 45, reason: "quiet" });
    expect(out.refs.map((x) => x.name)).toEqual(["Jane Tan", "Sam"]);
  });
});

describe("the four propose tools", () => {
  const signed = { proposal: { kind: "drop_todo" }, signature: "s" };

  it("propose_todo passes the title, date and contact, and a loose to-do has no target", async () => {
    p.proposeAddTodo.mockResolvedValue({ ok: true, signed: { proposal: { kind: "add_todo", title: "Send deck", dueDate: "2026-12-01", memberName: "Jane Tan", about: null }, signature: "s" } });
    const out = await runTool(ctx, "propose_todo", { title: "Send deck", due_date: "2026-12-01", member_id: ID });
    expect(p.proposeAddTodo).toHaveBeenCalledWith(db, { customer: CUSTOMER, estate: "traxo" }, { memberId: ID }, "Send deck", "2026-12-01", 1_000);
    expect(out.proposal).toBeDefined();
    expect(out.result).toMatchObject({ status: "shown to the user for confirmation; not done yet" });
    await runTool(ctx, "propose_todo", { title: "Renew", due_date: "" });
    expect(p.proposeAddTodo).toHaveBeenLastCalledWith(db, { customer: CUSTOMER, estate: "traxo" }, undefined, "Renew", null, 1_000);
  });

  it("propose_complete_todo, propose_move_todo and propose_drop_todo pass the viewer and ids", async () => {
    p.proposeCompleteTodo.mockResolvedValue({ ok: true, signed: { proposal: { kind: "complete_todo", title: "T", memberName: null, outcome: "Sent" }, signature: "s" } });
    p.proposeMoveTodo.mockResolvedValue({ ok: true, signed: { proposal: { kind: "move_todo", title: "T", memberName: null, fromDate: null, toDate: null }, signature: "s" } });
    p.proposeDropTodo.mockResolvedValue({ ok: true, signed });
    const bind = { customer: CUSTOMER, estate: "traxo" };
    await runTool(ctx, "propose_complete_todo", { todo_id: TODO, outcome: " Sent " });
    expect(p.proposeCompleteTodo).toHaveBeenCalledWith(db, bind, VIEWER, TODO, "Sent", 1_000);
    await runTool(ctx, "propose_complete_todo", { todo_id: TODO });
    expect(p.proposeCompleteTodo).toHaveBeenLastCalledWith(db, bind, VIEWER, TODO, null, 1_000);
    await runTool(ctx, "propose_move_todo", { todo_id: TODO, due_date: "2026-12-08" });
    expect(p.proposeMoveTodo).toHaveBeenLastCalledWith(db, bind, VIEWER, TODO, "2026-12-08", 1_000);
    await runTool(ctx, "propose_move_todo", { todo_id: TODO, due_date: "" });
    expect(p.proposeMoveTodo).toHaveBeenLastCalledWith(db, bind, VIEWER, TODO, null, 1_000);
    const dropped = await runTool(ctx, "propose_drop_todo", { todo_id: TODO });
    expect(p.proposeDropTodo).toHaveBeenCalledWith(db, bind, VIEWER, TODO, 1_000);
    expect(dropped.proposal).toEqual(signed);
  });

  it("a refusal is returned as an error, with no proposal; a move needs its date key", async () => {
    p.proposeDropTodo.mockResolvedValue({ ok: false, reason: "That to-do is already done." });
    const out = await runTool(ctx, "propose_drop_todo", { todo_id: TODO });
    expect(out.result).toEqual({ error: "That to-do is already done." });
    expect(out.proposal).toBeUndefined();
    expect(((await runTool(ctx, "propose_move_todo", { todo_id: TODO })).result as { error: string }).error).toMatch(/due_date/);
    expect(((await runTool(ctx, "propose_todo", { title: "  " })).result as { error: string }).error).toMatch(/title/);
  });
});
