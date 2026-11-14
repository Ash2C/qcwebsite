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
const { d } = vi.hoisted(() => ({ d: { proposeDetails: vi.fn() } }));
vi.mock("../details", async (orig) => ({ ...(await orig<typeof import("../details")>()), ...d }));

import { refKey, runTool, TOOLS, type ToolContext } from "./tools";

const db = { fake: true } as unknown as ClientBase;
const ctx: ToolContext = { db, estate: "traxo", today: "2026-11-13", nowMs: 1_000 };
const ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  for (const f of [...Object.values(q), ...Object.values(a), ...Object.values(d)]) f.mockReset();
});

describe("TOOLS", () => {
  it("has exactly the eleven tools, each with an object schema", () => {
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
      "propose_update",
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
    q.chaseList.mockResolvedValue({ due: [], stale: [], dueTotal: 0, staleTotal: 0 });
    q.searchNotes.mockResolvedValue({ hits: [], total: 0 });
    q.recentActivity.mockResolvedValue([]);

    await runTool(ctx, "find_contacts", { query: "jane" });
    expect(q.findContacts).toHaveBeenCalledWith(db, "jane", undefined);
    await runTool(ctx, "get_contact", { member_id: ID });
    expect(q.getContact).toHaveBeenCalledWith(db, ID, "2026-11-13", undefined);
    await runTool(ctx, "get_person", { person_id: ID });
    expect(q.getPerson).toHaveBeenCalledWith(db, ID, undefined);
    await runTool(ctx, "list_pipeline", { stage: "engaged", owner: "VF", due: "overdue" });
    expect(q.listPipeline).toHaveBeenCalledWith(db, { stage: "engaged", owner: "VF", due: "overdue" }, "2026-11-13", undefined);
    await runTool(ctx, "list_pipeline", {});
    expect(q.listPipeline).toHaveBeenLastCalledWith(db, {}, "2026-11-13", undefined);
    await runTool(ctx, "pipeline_summary", {});
    expect(q.pipelineSummary).toHaveBeenCalledWith(db, "2026-11-13", undefined);
    await runTool(ctx, "chase_list", { owner: "VF" });
    expect(q.chaseList).toHaveBeenCalledWith(db, { owner: "VF" }, "2026-11-13", undefined);
    await runTool(ctx, "search_notes", { text: "fund" });
    expect(q.searchNotes).toHaveBeenCalledWith(db, "fund", undefined);
    await runTool(ctx, "recent_activity", { days: 7 });
    expect(q.recentActivity).toHaveBeenCalledWith(db, 7, "2026-11-13", undefined);
  });

  it("returns the result and the members it names, in order", async () => {
    const rows = [
      { memberId: "m1", memberKind: "person", name: "Jane Tan", company: "Acme", owner: "unassigned" },
      { memberId: "m2", memberKind: "company", name: "Northwind", company: null },
    ];
    q.listPipeline.mockResolvedValue({ rows, total: 2 });
    const out = await runTool(ctx, "list_pipeline", {});
    expect(out.result).toEqual({
      rows: [
        { memberId: "m1", memberKind: "person", name: "Jane Tan", company: "Acme", owner: "unassigned" },
        { memberId: "m2", memberKind: "company", name: "Northwind", owner: "unassigned" },
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

  it("passes the remaining time to every query as a statement timeout, minus 3 seconds, at least 1 second", async () => {
    q.findContacts.mockResolvedValue([]);
    q.getContact.mockResolvedValue(null);
    q.getPerson.mockResolvedValue(null);
    q.listPipeline.mockResolvedValue({ rows: [], total: 0 });
    q.pipelineSummary.mockResolvedValue({ total: 0 });
    q.chaseList.mockResolvedValue({ due: [], stale: [], dueTotal: 0, staleTotal: 0 });
    q.searchNotes.mockResolvedValue({ hits: [], total: 0 });
    q.recentActivity.mockResolvedValue([]);
    let left = 20_000;
    const timed: ToolContext = { ...ctx, remainingMs: () => left };
    await runTool(timed, "find_contacts", { query: "jane" });
    expect(q.findContacts).toHaveBeenCalledWith(db, "jane", { timeoutMs: 17_000 });
    await runTool(timed, "get_contact", { member_id: ID });
    expect(q.getContact).toHaveBeenCalledWith(db, ID, "2026-11-13", { timeoutMs: 17_000 });
    await runTool(timed, "get_person", { person_id: ID });
    expect(q.getPerson).toHaveBeenCalledWith(db, ID, { timeoutMs: 17_000 });
    left = 9_000;
    await runTool(timed, "list_pipeline", { stage: "engaged" });
    expect(q.listPipeline).toHaveBeenCalledWith(db, { stage: "engaged" }, "2026-11-13", { timeoutMs: 6_000 });
    await runTool(timed, "pipeline_summary", {});
    expect(q.pipelineSummary).toHaveBeenCalledWith(db, "2026-11-13", { timeoutMs: 6_000 });
    await runTool(timed, "chase_list", {});
    expect(q.chaseList).toHaveBeenCalledWith(db, {}, "2026-11-13", { timeoutMs: 6_000 });
    left = 2_000;
    await runTool(timed, "search_notes", { text: "fund" });
    expect(q.searchNotes).toHaveBeenCalledWith(db, "fund", { timeoutMs: 1_000 });
    await runTool(timed, "recent_activity", { days: 7 });
    expect(q.recentActivity).toHaveBeenCalledWith(db, 7, "2026-11-13", { timeoutMs: 1_000 });
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

describe("refs for a person filed under a company (I1)", () => {
  const nw = { memberId: "m-nw", memberKind: "company", role: "investor", stage: "engaged" };
  const JANE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const OMAR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  it("gives each such person their own ref with the company's member and their person id", async () => {
    q.findContacts.mockResolvedValue([
      { kind: "person", personId: JANE, name: "Jane Tan", company: "Northwind", member: nw },
      { kind: "person", personId: OMAR, name: "Omar Reyes", company: "Northwind", member: nw },
      { kind: "person", personId: "p3", name: "Li Wei", company: "Acme", member: { memberId: "m-li", memberKind: "person", role: "x", stage: "y" } },
      { kind: "company", personId: null, name: "Northwind", company: null, member: nw },
    ]);
    const out = await runTool(ctx, "find_contacts", { query: "northwind" });
    expect(out.refs).toEqual([
      { memberId: "m-nw", name: "Jane Tan", company: "Northwind", kind: "company", personId: JANE },
      { memberId: "m-nw", name: "Omar Reyes", company: "Northwind", kind: "company", personId: OMAR },
      { memberId: "m-li", name: "Li Wei", company: "Acme", kind: "person" },
      { memberId: "m-nw", name: "Northwind", company: null, kind: "company" },
    ]);
    expect(out.refs.map(refKey)).toEqual([JANE, OMAR, "m-li", "m-nw"]);
    expect(new Set(out.refs.map(refKey)).size).toBe(4);
  });

  it("does the same for get_person and for a hit in a person's notes", async () => {
    q.getPerson.mockResolvedValue({ personId: JANE, name: "Jane Tan", company: "Northwind", member: nw });
    expect((await runTool(ctx, "get_person", { person_id: JANE })).refs).toEqual([
      { memberId: "m-nw", name: "Jane Tan", company: "Northwind", kind: "company", personId: JANE },
    ]);
    q.searchNotes.mockResolvedValue({
      hits: [
        { member: nw, personId: JANE, name: "Jane Tan", company: "Northwind", where: "person notes", snippet: "x", at: null },
        { member: nw, personId: null, name: "Northwind", company: null, where: "company notes", snippet: "y", at: null },
      ],
      total: 2,
    });
    expect((await runTool(ctx, "search_notes", { text: "long" })).refs).toEqual([
      { memberId: "m-nw", name: "Jane Tan", company: "Northwind", kind: "company", personId: JANE },
      { memberId: "m-nw", name: "Northwind", company: null, kind: "company" },
    ]);
  });
});

describe("refs that carry the company's id", () => {
  const ORG = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const JANE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const nw = { memberId: "m-nw", memberKind: "company", role: "investor", stage: "engaged" };

  it("fills orgId on find_contacts rows and keeps the person id of a person filed under a company", async () => {
    q.findContacts.mockResolvedValue([
      { kind: "person", personId: JANE, orgId: ORG, name: "Jane Tan", company: "Northwind", member: nw },
      { kind: "company", personId: null, orgId: ORG, name: "Northwind", company: null, member: nw },
    ]);
    const out = await runTool(ctx, "find_contacts", { query: "northwind" });
    expect(out.refs).toEqual([
      { memberId: "m-nw", name: "Jane Tan", company: "Northwind", kind: "company", personId: JANE, orgId: ORG },
      { memberId: "m-nw", name: "Northwind", company: null, kind: "company", orgId: ORG },
    ]);
    expect(JSON.stringify(out.result)).toContain(ORG);
  });

  it("takes orgId from a row that names a member directly, and ignores one that is not text", async () => {
    q.listPipeline.mockResolvedValue({
      rows: [
        { memberId: "m1", memberKind: "company", name: "Northwind", company: null, orgId: ORG },
        { memberId: "m2", memberKind: "company", name: "Acme", company: null, orgId: 5 },
      ],
      total: 2,
    });
    const out = await runTool(ctx, "list_pipeline", {});
    expect(out.refs).toEqual([
      { memberId: "m1", name: "Northwind", company: null, kind: "company", orgId: ORG },
      { memberId: "m2", name: "Acme", company: null, kind: "company" },
    ]);
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
      ["propose_update", { member_id: ID, title: 5 }],
      ["propose_update", { member_id: ID, org_id: 7 }],
      ["propose_update", { member_id: ID, new_company: "no" }],
    ];
    for (const [name, input] of cases) {
      const out = await runTool(ctx, name, input);
      expect(out.result).toEqual({ error: expect.any(String) });
      expect(out.refs).toEqual([]);
      expect(out.proposal).toBeUndefined();
    }
    for (const f of [...Object.values(q), ...Object.values(a), ...Object.values(d)]) expect(f).not.toHaveBeenCalled();
  });

  it("does not leak the message of a thrown query", async () => {
    q.searchNotes.mockRejectedValue(new Error("connection to postgres://u:secret@host failed"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = await runTool(ctx, "search_notes", { text: "fund" });
    expect(out).toEqual({ result: { error: "That lookup failed." }, refs: [] });
    a.proposeNote.mockRejectedValue(new Error("secret"));
    const p = await runTool(ctx, "propose_note", { member_id: ID, text: "hi" });
    expect(JSON.stringify(p)).not.toContain("secret");
    spy.mockRestore();
  });
});

describe("logging a failed tool (D12)", () => {
  it("logs the tool name, the error name and a numeric or SQLSTATE code, and nothing else", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const err = Object.assign(new Error("connection to postgres://u:secret@host failed for jane@x.com"), { code: "57014" });
    q.searchNotes.mockRejectedValue(err);
    await runTool(ctx, "search_notes", { text: "secret topic" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toEqual(["monsoon: ask tool failed", "search_notes", "Error", "57014"]);
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/secret|jane@x|postgres:/);

    spy.mockClear();
    q.getPerson.mockRejectedValue(Object.assign(new Error("m"), { code: "ECONNREFUSED with text", status: 503 }));
    await runTool(ctx, "get_person", { person_id: ID });
    expect(spy.mock.calls[0]).toEqual(["monsoon: ask tool failed", "get_person", "Error", 503]);

    spy.mockClear();
    q.getContact.mockRejectedValue("a string with secret");
    await runTool(ctx, "get_contact", { member_id: ID });
    expect(spy.mock.calls[0]).toEqual(["monsoon: ask tool failed", "get_contact", "error"]);
    spy.mockRestore();
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
    q.chaseList.mockResolvedValue({ due: many.slice(0, 50), stale: many.slice(50, 100), dueTotal: 73, staleTotal: 50 });
    const out = await runTool(ctx, "chase_list", {});
    const json = JSON.stringify(out.result);
    expect(json.length).toBeLessThan(24_000);
    const r = out.result as { due: Record<string, unknown>[]; stale: unknown[]; dueTotal: number; staleTotal: number; note: string };
    expect(r.due).toHaveLength(25);
    expect(r.stale).toHaveLength(15);
    expect(r.dueTotal).toBe(73);
    expect(r.staleTotal).toBe(50);
    // 73 - 25 + 50 - 15 = 83 left out of what is shown; the totals are true counts
    expect(r.note).toBe("Showing the 25 most urgent due and 15 longest-quiet of 73 due and 50 quiet; 83 not shown.");
    expect(r.note).not.toContain("or more");
    expect(r.due[0].memberId).toBeDefined();
    expect((r.due[0].nextAction as string).length).toBeLessThan(180);
    expect(r.due[0].nextAction).toContain("[cut]");
    expect(Object.values(r.due[0]).some((v) => v === null || v === "")).toBe(false);
    expect(out.refs).toHaveLength(40);
  });

  it("chase_list adds no note when everything fits", async () => {
    q.chaseList.mockResolvedValue({ due: many.slice(0, 3), stale: [], dueTotal: 3, staleTotal: 0 });
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
    q.searchNotes.mockResolvedValue({ hits: [{ member: null, name: "J", snippet: "y".repeat(400), at: null }], total: 1 });
    const { hits } = (await runTool(ctx, "search_notes", { text: "yy" })).result as { hits: { snippet: string }[] };
    expect(hits[0].snippet.length).toBeLessThan(180);
    q.recentActivity.mockResolvedValue([{ memberId: "m", name: "J", company: null, summary: "z".repeat(400), by: null }]);
    const act = (await runTool(ctx, "recent_activity", { days: 3 })).result as Record<string, string>[];
    expect(act[0].summary.length).toBeLessThan(180);
    expect(act[0]).not.toHaveProperty("by");
  });

  it("states in the chase_list description that owner includes unassigned contacts, with no stray space", () => {
    const d = TOOLS.find((t) => t.name === "chase_list")!.description;
    expect(d).toMatch(/includes unassigned/);
    expect(d).toContain("for one owner.");
    expect(d).not.toMatch(/ \./);
  });

  it("says outright that a row has no owner, in list_pipeline and chase_list", async () => {
    q.listPipeline.mockResolvedValue({ rows: [row(0, { owner: null }), row(1, { owner: "VF" })], total: 2 });
    const lp = (await runTool(ctx, "list_pipeline", {})).result as { rows: { owner: string }[] };
    expect(lp.rows.map((r) => r.owner)).toEqual(["unassigned", "VF"]);
    q.chaseList.mockResolvedValue({ due: [row(2, { owner: null })], stale: [row(3, { owner: null })], dueTotal: 1, staleTotal: 1 });
    const cl = (await runTool(ctx, "chase_list", {})).result as { due: { owner: string }[]; stale: { owner: string }[] };
    expect([cl.due[0].owner, cl.stale[0].owner]).toEqual(["unassigned", "unassigned"]);
  });

  it("search_notes passes the hits and the true total, with a left-out note only when some are not shown", async () => {
    const hit = (i: number) => ({ member: null, personId: null, name: `N${i}`, company: null, where: "timeline", snippet: `s${i}`, at: null });
    q.searchNotes.mockResolvedValue({ hits: [hit(1), hit(2)], total: 2 });
    const all = (await runTool(ctx, "search_notes", { text: "ab" })).result as Record<string, unknown>;
    expect(all.total).toBe(2);
    expect((all.hits as unknown[]).length).toBe(2);
    expect(all).not.toHaveProperty("note");
    q.searchNotes.mockResolvedValue({ hits: [hit(1), hit(2)], total: 47 });
    const some = (await runTool(ctx, "search_notes", { text: "ab" })).result as { total: number; note: string };
    expect(some.total).toBe(47);
    expect(some.note).toContain("2 newest of 47");
    expect(some.note).toContain("45 not shown");
  });
});

describe("propose_update", () => {
  const ORG = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const signed = {
    proposal: {
      kind: "update_details",
      estate: "traxo",
      target: { type: "person", id: ID },
      targetName: "Jane Tan",
      company: "Acme",
      changes: [
        { field: "title", from: null, to: "CFO" },
        { field: "phone", from: "123", to: null },
      ],
      logMemberId: "m1",
      addsToPipeline: null,
      expires: 5,
    },
    signature: "sig",
  };

  it("maps the arguments, takes an empty string as clear, and passes the estate's default role", async () => {
    d.proposeDetails.mockResolvedValue({ ok: true, signed });
    const out = await runTool(ctx, "propose_update", { member_id: ID, title: "CFO", phone: "", new_company: "yes" });
    expect(d.proposeDetails).toHaveBeenCalledWith(
      db,
      "traxo",
      { memberId: ID },
      { title: "CFO", phone: "" },
      { nowMs: 1_000, defaultRole: "lp_prospect", newCompany: true },
    );
    expect(out.proposal).toBe(signed);
    expect(out.refs).toEqual([]);
    expect(out.result).toEqual({
      status: "shown to the user for confirmation; not done yet",
      change: "Update the details of Jane Tan: Title: (empty) → CFO; Phone: 123 → (empty)",
    });
  });

  it("uses the Zero One default role, and addresses a person or a company by id", async () => {
    d.proposeDetails.mockResolvedValue({ ok: true, signed });
    await runTool({ ...ctx, estate: "zeroone" }, "propose_update", { person_id: ID, name: "Jane T" });
    expect(d.proposeDetails).toHaveBeenLastCalledWith(
      db,
      "zeroone",
      { personId: ID },
      { name: "Jane T" },
      { nowMs: 1_000, defaultRole: "investor", newCompany: false },
    );
    await runTool(ctx, "propose_update", { org_id: ORG, website: "acme.com", country: "" });
    expect(d.proposeDetails).toHaveBeenLastCalledWith(
      db,
      "traxo",
      { orgId: ORG },
      { website: "acme.com", country: "" },
      { nowMs: 1_000, defaultRole: "lp_prospect", newCompany: false },
    );
  });

  it("drops unknown keys and leaves absent fields out of the input", async () => {
    d.proposeDetails.mockResolvedValue({ ok: true, signed });
    await runTool(ctx, "propose_update", { member_id: ID, linkedin: "li.com/jane", notes: "x", stage: "passed", email: null });
    expect(d.proposeDetails.mock.calls[0][3]).toEqual({ linkedin: "li.com/jane" });
  });

  it("feeds a refusal back as the error and returns no proposal", async () => {
    d.proposeDetails.mockResolvedValue({ ok: false, reason: "Nothing to change." });
    const out = await runTool(ctx, "propose_update", { member_id: ID, title: "CFO" });
    expect(out).toEqual({ result: { error: "Nothing to change." }, refs: [] });
  });

  it("does not leak the message of a thrown error", async () => {
    d.proposeDetails.mockRejectedValue(new Error("secret"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = await runTool(ctx, "propose_update", { member_id: ID, title: "CFO" });
    expect(JSON.stringify(out)).not.toContain("secret");
    spy.mockRestore();
  });
});
