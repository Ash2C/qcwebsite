import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientBase } from "pg";

const { q, a } = vi.hoisted(() => ({ q: {
  findContacts: vi.fn(),
  getContact: vi.fn(),
  getPerson: vi.fn(),
  listPipeline: vi.fn(),
  pipelineSummary: vi.fn(),
  chaseList: vi.fn(),
  searchNotes: vi.fn(),
  recentActivity: vi.fn(),
}, a: { proposeNote: vi.fn(), proposeStage: vi.fn() } }));
vi.mock("./queries", async (orig) => ({ ...(await orig<typeof import("./queries")>()), ...q }));
vi.mock("./actions", () => a);

import { runTool, TOOLS, type ToolContext } from "./tools";

const db = { fake: true } as unknown as ClientBase;
const ctx: ToolContext = { db, estate: "traxo", today: "2026-11-13", nowMs: 1_000 };
const ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  for (const f of [...Object.values(q), ...Object.values(a)]) f.mockReset();
});

describe("TOOLS", () => {
  it("has exactly the ten tools, each with an object schema", () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      "find_contacts",
      "get_contact",
      "get_person",
      "list_pipeline",
      "pipeline_summary",
      "chase_list",
      "search_notes",
      "recent_activity",
      "propose_note",
      "propose_stage",
    ]);
    for (const t of TOOLS) {
      expect(t.input_schema).toMatchObject({ type: "object" });
      expect(t.description.length).toBeGreaterThan(20);
    }
  });
});

describe("read tools", () => {
  it("call their query with mapped arguments and today", async () => {
    q.findContacts.mockResolvedValue([]);
    q.getContact.mockResolvedValue(null);
    q.getPerson.mockResolvedValue(null);
    q.listPipeline.mockResolvedValue({ rows: [], total: 0 });
    q.pipelineSummary.mockResolvedValue({ total: 0 });
    q.chaseList.mockResolvedValue({ due: [], stale: [] });
    q.searchNotes.mockResolvedValue([]);
    q.recentActivity.mockResolvedValue([]);

    await runTool(ctx, "find_contacts", { query: "jane" });
    expect(q.findContacts).toHaveBeenCalledWith(db, "jane");
    await runTool(ctx, "get_contact", { member_id: ID });
    expect(q.getContact).toHaveBeenCalledWith(db, ID, "2026-11-13");
    await runTool(ctx, "get_person", { person_id: ID });
    expect(q.getPerson).toHaveBeenCalledWith(db, ID);
    await runTool(ctx, "list_pipeline", { stage: "engaged", owner: "VF", due: "overdue" });
    expect(q.listPipeline).toHaveBeenCalledWith(db, { stage: "engaged", owner: "VF", due: "overdue" }, "2026-11-13");
    await runTool(ctx, "list_pipeline", {});
    expect(q.listPipeline).toHaveBeenLastCalledWith(db, {}, "2026-11-13");
    await runTool(ctx, "pipeline_summary", {});
    expect(q.pipelineSummary).toHaveBeenCalledWith(db, "2026-11-13");
    await runTool(ctx, "chase_list", { owner: "VF" });
    expect(q.chaseList).toHaveBeenCalledWith(db, { owner: "VF" }, "2026-11-13");
    await runTool(ctx, "search_notes", { text: "fund" });
    expect(q.searchNotes).toHaveBeenCalledWith(db, "fund");
    await runTool(ctx, "recent_activity", { days: 7 });
    expect(q.recentActivity).toHaveBeenCalledWith(db, 7, "2026-11-13");
  });

  it("returns the result and the members it names, in order", async () => {
    const rows = [
      { memberId: "m1", memberKind: "person", name: "Jane Tan", company: "Acme" },
      { memberId: "m2", memberKind: "company", name: "Northwind", company: null },
    ];
    q.listPipeline.mockResolvedValue({ rows, total: 2 });
    const out = await runTool(ctx, "list_pipeline", {});
    expect(out.result).toEqual({
      rows: [
        { memberId: "m1", memberKind: "person", name: "Jane Tan", company: "Acme" },
        { memberId: "m2", memberKind: "company", name: "Northwind" },
      ],
      total: 2,
    });
    expect(out.refs).toEqual([
      { memberId: "m1", name: "Jane Tan", company: "Acme", kind: "person" },
      { memberId: "m2", name: "Northwind", company: null, kind: "company" },
    ]);
  });

  it("takes refs from a member object beside a name, and gives results without members none", async () => {
    q.findContacts.mockResolvedValue([
      { kind: "person", name: "Jane Tan", company: "Acme", member: { memberId: "m1", memberKind: "company", role: "x", stage: "y" } },
      { kind: "person", name: "Jane Roe", company: null, member: null },
    ]);
    const out = await runTool(ctx, "find_contacts", { query: "jane" });
    expect(out.refs).toEqual([{ memberId: "m1", name: "Jane Tan", company: "Acme", kind: "company" }]);
    q.pipelineSummary.mockResolvedValue({ total: 3, byStage: [] });
    expect((await runTool(ctx, "pipeline_summary", {})).refs).toEqual([]);
  });

  it("infers the kind of an activity row, which has no memberKind", async () => {
    q.recentActivity.mockResolvedValue([
      { memberId: "m1", name: "Jane", company: "Acme", summary: "x" },
      { memberId: "m2", name: "Northwind", company: null, summary: "y" },
    ]);
    const out = await runTool(ctx, "recent_activity", { days: 3 });
    expect(out.refs.map((r) => r.kind)).toEqual(["person", "company"]);
  });
});

describe("bad calls", () => {
  it("returns an error result and never throws", async () => {
    const cases: [string, unknown][] = [
      ["no_such_tool", {}],
      ["find_contacts", {}],
      ["find_contacts", { query: 5 }],
      ["find_contacts", { query: "  " }],
      ["find_contacts", null],
      ["recent_activity", { days: "7" }],
      ["recent_activity", { days: 1.5 }],
      ["list_pipeline", { due: "someday" }],
      ["propose_note", { member_id: ID }],
    ];
    for (const [name, input] of cases) {
      const out = await runTool(ctx, name, input);
      expect(out.result).toEqual({ error: expect.any(String) });
      expect(out.refs).toEqual([]);
      expect(out.proposal).toBeUndefined();
    }
    for (const f of [...Object.values(q), ...Object.values(a)]) expect(f).not.toHaveBeenCalled();
  });

  it("does not leak the message of a thrown query", async () => {
    q.searchNotes.mockRejectedValue(new Error("connection to postgres://u:secret@host failed"));
    const out = await runTool(ctx, "search_notes", { text: "fund" });
    expect(out).toEqual({ result: { error: "That lookup failed." }, refs: [] });
    a.proposeNote.mockRejectedValue(new Error("secret"));
    const p = await runTool(ctx, "propose_note", { member_id: ID, text: "hi" });
    expect(JSON.stringify(p)).not.toContain("secret");
  });
});

describe("propose tools", () => {
  const signed = {
    proposal: {
      kind: "add_note",
      estate: "traxo",
      memberId: ID,
      memberKind: "person",
      memberName: "Jane Tan",
      company: "Acme",
      about: null,
      expires: 5,
    },
    signature: "sig",
    text: "Call back Tuesday",
  };

  it("propose_note returns the proposal and says it is not done yet", async () => {
    a.proposeNote.mockResolvedValue({ ok: true, signed });
    const out = await runTool(ctx, "propose_note", { member_id: ID, text: "Call back Tuesday" });
    expect(a.proposeNote).toHaveBeenCalledWith(db, "traxo", { memberId: ID }, "Call back Tuesday", 1_000);
    expect(out.proposal).toBe(signed);
    expect(out.result).toEqual({
      status: "shown to the user for confirmation; not done yet",
      change: "Add a note to Jane Tan (Acme): Call back Tuesday",
    });
  });

  it("propose_stage maps person_id and describes the move", async () => {
    a.proposeStage.mockResolvedValue({
      ok: true,
      signed: {
        proposal: { ...signed.proposal, kind: "move_stage", fromStage: "contacted", toStage: "engaged" },
        signature: "s",
      },
    });
    const out = await runTool(ctx, "propose_stage", { person_id: ID, stage: "engaged" });
    expect(a.proposeStage).toHaveBeenCalledWith(db, "traxo", { personId: ID }, "engaged", 1_000);
    expect(out.result).toMatchObject({ change: "Move Jane Tan (Acme) from contacted to engaged" });
  });

  it("returns a refusal as an error and no proposal", async () => {
    a.proposeStage.mockResolvedValue({ ok: false, reason: "Jane is already in engaged." });
    const out = await runTool(ctx, "propose_stage", { member_id: ID, stage: "engaged" });
    expect(out).toEqual({ result: { error: "Jane is already in engaged." }, refs: [] });
  });
});

describe("result shaping for the model", () => {
  const row = (i: number, over: Record<string, unknown> = {}) => ({
    memberId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    memberKind: "person",
    name: `Contact Number ${i}`,
    company: `Company ${i}`,
    role: "investor",
    stage: "engaged",
    owner: i % 2 ? "VF" : null,
    lastActionAt: "2026-10-01T09:00:00.000Z",
    lastActionKind: "email",
    nextAction: "x".repeat(600),
    nextActionDate: "2026-11-01",
    due: "overdue",
    ...over,
  });
  const many = Array.from({ length: 120 }, (_, i) => row(i));

  it("chase_list fits the cap with totals, a note, clipped text and no empty fields", async () => {
    q.chaseList.mockResolvedValue({ due: many.slice(0, 50), stale: many.slice(50, 100) });
    const out = await runTool(ctx, "chase_list", {});
    const json = JSON.stringify(out.result);
    expect(json.length).toBeLessThan(24_000);
    const r = out.result as { due: Record<string, unknown>[]; stale: unknown[]; dueTotal: number; staleTotal: number; note: string };
    expect(r.due).toHaveLength(25);
    expect(r.stale).toHaveLength(15);
    expect(r.dueTotal).toBe(50);
    expect(r.staleTotal).toBe(50);
    expect(r.note).toContain("50 or more");
    expect(r.due[0].memberId).toBeDefined();
    expect((r.due[0].nextAction as string).length).toBeLessThan(180);
    expect(r.due[0].nextAction).toContain("[cut]");
    expect(Object.values(r.due[0]).some((v) => v === null || v === "")).toBe(false);
    expect(out.refs).toHaveLength(40);
  });

  it("chase_list adds no note when everything fits", async () => {
    q.chaseList.mockResolvedValue({ due: many.slice(0, 3), stale: [] });
    const out = await runTool(ctx, "chase_list", { owner: "VF" });
    expect(out.result).toMatchObject({ dueTotal: 3, staleTotal: 0 });
    expect(out.result).not.toHaveProperty("note");
  });

  it("list_pipeline fits the cap with 40 rows, the total and a note", async () => {
    q.listPipeline.mockResolvedValue({ rows: many.slice(0, 50), total: 120 });
    const out = await runTool(ctx, "list_pipeline", {});
    expect(JSON.stringify(out.result).length).toBeLessThan(24_000);
    const r = out.result as { rows: unknown[]; total: number; note: string };
    expect(r.rows).toHaveLength(40);
    expect(r.total).toBe(120);
    expect(r.note).toContain("120");
  });

  it("clips free text in find_contacts, search_notes and recent_activity rows", async () => {
    q.findContacts.mockResolvedValue([{ kind: "person", name: "J", email: null, company: "", member: null }]);
    expect((await runTool(ctx, "find_contacts", { query: "jj" })).result).toEqual([{ kind: "person", name: "J" }]);
    q.searchNotes.mockResolvedValue([{ member: null, name: "J", snippet: "y".repeat(400), at: null }]);
    const hits = (await runTool(ctx, "search_notes", { text: "yy" })).result as { snippet: string }[];
    expect(hits[0].snippet.length).toBeLessThan(180);
    q.recentActivity.mockResolvedValue([{ memberId: "m", name: "J", company: null, summary: "z".repeat(400), by: null }]);
    const act = (await runTool(ctx, "recent_activity", { days: 3 })).result as Record<string, string>[];
    expect(act[0].summary.length).toBeLessThan(180);
    expect(act[0]).not.toHaveProperty("by");
  });

  it("states in the chase_list description that owner includes unassigned contacts", () => {
    expect(TOOLS.find((t) => t.name === "chase_list")!.description).toMatch(/includes unassigned/);
  });
});
