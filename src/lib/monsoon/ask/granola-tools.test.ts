import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientBase } from "pg";

const { g } = vi.hoisted(() => ({
  g: { searchGranolaNotes: vi.fn(), getGranolaNote: vi.fn(), searchGranolaTranscripts: vi.fn(), testGranolaKey: vi.fn() },
}));
vi.mock("../granola/client", async (orig) => ({ ...(await orig<typeof import("../granola/client")>()), ...g }));

import { GRANOLA_TOOLS, runTool, TOOLS, toolsFor, type ToolContext } from "./tools";

// Obviously fake: the shape of a key, never a real one.
const KEY = "grn_FAKE_test_key_0000000000";
const MEETING = "not_AAAAAAAAAAAAAA";
// The meeting tools must never touch the CRM: any use of the connection fails the test.
const db = new Proxy({}, { get: () => { throw new Error("the CRM was touched"); } }) as unknown as ClientBase;
const base: ToolContext = { db, customerId: "c0000000-0000-4000-8000-00000000000a", estate: "traxo", defaultRole: "lp_prospect", today: "2026-11-13", nowMs: 1_000 };
const onStatus = vi.fn();
const ctx: ToolContext = { ...base, granola: { key: KEY, onStatus } };
const NAMES = ["search_meetings", "get_meeting", "search_meeting_transcripts"];

beforeEach(() => {
  for (const f of Object.values(g)) f.mockReset();
  onStatus.mockReset();
});

describe("the tool list", () => {
  it("is today's twelve tools, byte for byte, without a Granola key", () => {
    expect(toolsFor(false)).toBe(TOOLS);
    // The list as it stood before the Granola connector (commit 36d6f89), as sent to the model.
    const sent = JSON.stringify(toolsFor(false));
    expect(sent).toHaveLength(6443);
    expect(createHash("sha256").update(sent).digest("hex")).toBe("c527c9608b3b15139b4b809c243eee18b2050254dda6e85617a0a1c2528a95a4");
  });

  it("adds exactly the three meeting tools, after the twelve, with a key", () => {
    const tools = toolsFor(true);
    expect(tools.slice(0, 12)).toEqual(TOOLS);
    expect(tools.slice(12).map((t) => t.name)).toEqual(NAMES);
    expect(GRANOLA_TOOLS.map((t) => t.name)).toEqual(NAMES);
    const schema = (n: string) => GRANOLA_TOOLS.find((t) => t.name === n)!.input_schema;
    expect(Object.keys(schema("search_meetings").properties)).toEqual(["keywords", "participant", "from_date", "to_date"]);
    expect(schema("search_meetings").required).toEqual([]);
    expect(Object.keys(schema("get_meeting").properties)).toEqual(["meeting_id"]);
    expect(schema("get_meeting").required).toEqual(["meeting_id"]);
    expect(Object.keys(schema("search_meeting_transcripts").properties)).toEqual(["keywords", "participant", "meeting_id", "from_date", "to_date"]);
    expect(schema("search_meeting_transcripts").required).toEqual(["keywords"]);
    for (const t of GRANOLA_TOOLS) {
      expect(t.description.length).toBeGreaterThan(20);
      for (const p of Object.values(t.input_schema.properties)) expect(p.type).toBe("string");
    }
  });
});

describe("the meeting tools without a key", () => {
  it("are unknown to runTool, and Granola is never called", async () => {
    for (const granola of [undefined, { key: "" }]) {
      for (const name of NAMES) {
        const out = await runTool({ ...base, ...(granola ? { granola } : {}) }, name, { keywords: "price", meeting_id: MEETING });
        expect(out).toEqual({ result: { error: "Unknown tool." }, refs: [] });
      }
    }
    for (const f of Object.values(g)) expect(f).not.toHaveBeenCalled();
  });
});

describe("search_meetings", () => {
  it("splits keywords on commas into at most five, each clipped to 100 characters, and passes the filters", async () => {
    g.searchGranolaNotes.mockResolvedValue({ ok: true, meetings: [{ id: MEETING, title: "Pricing call", date: "2026-11-02T10:00:00.000Z" }] });
    const out = await runTool(ctx, "search_meetings", {
      keywords: ` budget review, renewal ,, ${"k".repeat(150)}, d, e, f`,
      participant: " acme.com ",
      from_date: "2026-11-01",
      to_date: "2026-11-20",
    });
    expect(g.searchGranolaNotes).toHaveBeenCalledWith(
      KEY,
      { keywords: ["budget review", "renewal", "k".repeat(100), "d", "e"], participant: "acme.com", fromDate: "2026-11-01", toDate: "2026-11-20" },
      { timeoutMs: 8000 },
    );
    expect(out).toEqual({
      result: { source: "Granola", meetings: [{ meeting_id: MEETING, title: "Pricing call", date: "2026-11-02T10:00:00.000Z" }] },
      refs: [],
    });
    expect(out.proposal).toBeUndefined();
    expect(out.research).toBeUndefined();
  });

  it("works with no input at all, and treats blank inputs as left out", async () => {
    g.searchGranolaNotes.mockResolvedValue({ ok: true, meetings: [] });
    expect((await runTool(ctx, "search_meetings", {})).result).toEqual({ source: "Granola", meetings: [] });
    expect(g.searchGranolaNotes).toHaveBeenLastCalledWith(KEY, {}, { timeoutMs: 8000 });
    await runTool(ctx, "search_meetings", { keywords: " , ", participant: "  ", from_date: "", to_date: " " });
    expect(g.searchGranolaNotes).toHaveBeenLastCalledWith(KEY, {}, { timeoutMs: 8000 });
  });

  it("rejects a date that is not YYYY-MM-DD before calling Granola", async () => {
    for (const [key, value] of [
      ["from_date", "last week"],
      ["from_date", "2026-11-01T00:00:00Z"],
      ["to_date", "01/11/2026"],
      ["to_date", "2026-13-45"],
      ["to_date", 20261101],
    ] as const) {
      const out = await runTool(ctx, "search_meetings", { [key]: value });
      expect((out.result as { error: string }).error, String(value)).toMatch(new RegExp(`^${key} must be `));
    }
    const t = await runTool(ctx, "search_meeting_transcripts", { keywords: "price", from_date: "soon" });
    expect((t.result as { error: string }).error).toMatch(/^from_date must be /);
    expect(g.searchGranolaNotes).not.toHaveBeenCalled();
    expect(g.searchGranolaTranscripts).not.toHaveBeenCalled();
  });
});

describe("get_meeting", () => {
  it("returns title, date, attendees, summary and link, and no refs", async () => {
    g.getGranolaNote.mockResolvedValue({
      ok: true,
      note: {
        title: "Quarterly review",
        date: "2026-11-02T10:00:00.000Z",
        attendees: [{ name: "Jane Doe", email: "jane@example.com" }],
        moreAttendees: 3,
        summary: "We agreed the price.",
        url: "https://notes.granola.ai/d/00000000-0000-4000-8000-000000000000",
      },
    });
    const out = await runTool(ctx, "get_meeting", { meeting_id: MEETING });
    expect(g.getGranolaNote).toHaveBeenCalledWith(KEY, MEETING, { timeoutMs: 8000 });
    expect(out).toEqual({
      result: {
        source: "Granola",
        meeting: {
          title: "Quarterly review",
          date: "2026-11-02T10:00:00.000Z",
          attendees: [{ name: "Jane Doe", email: "jane@example.com" }],
          attendees_not_shown: 3,
          summary: "We agreed the price.",
          link: "https://notes.granola.ai/d/00000000-0000-4000-8000-000000000000",
        },
      },
      refs: [],
    });
  });

  it("names no contact even when an attendee looks like a CRM row", async () => {
    g.getGranolaNote.mockResolvedValue({
      ok: true,
      note: { title: "T", date: null, attendees: [{ name: "Jane", email: null, memberId: "m1" }], moreAttendees: 0, summary: null, url: null },
    });
    const out = await runTool(ctx, "get_meeting", { meeting_id: MEETING });
    expect(out.refs).toEqual([]);
    expect(out.proposal).toBeUndefined();
  });

  it("needs a meeting id", async () => {
    expect((await runTool(ctx, "get_meeting", {})).result).toEqual({ error: "Missing required input: meeting_id." });
    expect(g.getGranolaNote).not.toHaveBeenCalled();
  });
});

describe("search_meeting_transcripts", () => {
  it("needs keywords, passes one meeting id and the filters, and returns the passages", async () => {
    expect((await runTool(ctx, "search_meeting_transcripts", {})).result).toEqual({ error: "Missing required input: keywords." });
    expect((await runTool(ctx, "search_meeting_transcripts", { keywords: " , " })).result).toEqual({ error: "keywords must not be empty." });
    expect(g.searchGranolaTranscripts).not.toHaveBeenCalled();

    const passages = Array.from({ length: 5 }, (_, i) => ({ text: `passage ${i}`, start_time: i === 0 ? "2026-11-02T10:05:00.000Z" : null }));
    g.searchGranolaTranscripts.mockResolvedValue({ ok: true, meetings: [{ id: MEETING, title: "Pricing call", date: "2026-11-02T10:00:00.000Z", passages }] });
    const out = await runTool(ctx, "search_meeting_transcripts", {
      keywords: "price, January",
      participant: "jane@example.com",
      meeting_id: MEETING,
      from_date: "2026-11-01",
      to_date: "2026-11-30",
    });
    expect(g.searchGranolaTranscripts).toHaveBeenCalledWith(
      KEY,
      { keywords: ["price", "January"], noteIds: [MEETING], participant: "jane@example.com", fromDate: "2026-11-01", toDate: "2026-11-30" },
      { timeoutMs: 8000 },
    );
    expect(out).toEqual({
      result: {
        source: "Granola",
        meetings: [
          {
            meeting_id: MEETING,
            title: "Pricing call",
            date: "2026-11-02T10:00:00.000Z",
            // At most three passages a meeting, so ten meetings always fit the loop's size cap.
            passages: [
              { text: "passage 0", start_time: "2026-11-02T10:05:00.000Z" },
              { text: "passage 1", start_time: null },
              { text: "passage 2", start_time: null },
            ],
          },
        ],
      },
      refs: [],
    });

    await runTool(ctx, "search_meeting_transcripts", { keywords: "price" });
    expect(g.searchGranolaTranscripts).toHaveBeenLastCalledWith(KEY, { keywords: ["price"] }, { timeoutMs: 8000 });
  });

  it("stays under the loop's 24,000 character cap at its largest", async () => {
    const meetings = Array.from({ length: 10 }, (_, i) => ({
      id: `not_${String(i).padStart(14, "0")}`,
      title: "T".repeat(300),
      date: "2026-11-02T10:00:00.000Z",
      passages: Array.from({ length: 10 }, () => ({ text: "p".repeat(300), start_time: "2026-11-02T10:05:00.000Z" })),
    }));
    g.searchGranolaTranscripts.mockResolvedValue({ ok: true, meetings });
    const out = await runTool(ctx, "search_meeting_transcripts", { keywords: "price" });
    expect(JSON.stringify(out.result).length).toBeLessThan(24_000);
  });
});

describe("time and failures", () => {
  it("gives each call eight seconds, or what is left of the request less three", async () => {
    g.searchGranolaNotes.mockResolvedValue({ ok: true, meetings: [] });
    for (const [left, timeoutMs] of [
      [50_000, 8000],
      [11_000, 8000],
      [9_000, 6000],
      [2_000, -1000],
    ]) {
      await runTool({ ...ctx, remainingMs: () => left }, "search_meetings", {});
      expect(g.searchGranolaNotes).toHaveBeenLastCalledWith(KEY, {}, { timeoutMs });
    }
  });

  it("a refused key is said plainly and its status passed on; a busy Granola is said plainly and nothing is recorded", async () => {
    const calls: [string, (typeof g)[keyof typeof g], Record<string, string>][] = [
      ["search_meetings", g.searchGranolaNotes, {}],
      ["get_meeting", g.getGranolaNote, { meeting_id: MEETING }],
      ["search_meeting_transcripts", g.searchGranolaTranscripts, { keywords: "price" }],
    ];
    for (const [name, fn, input] of calls) {
      for (const failure of ["key_rejected", "no_access"]) {
        onStatus.mockReset();
        fn.mockResolvedValue({ ok: false, failure });
        expect(await runTool(ctx, name, input)).toEqual({ result: { error: "The Granola key was refused." }, refs: [] });
        expect(onStatus.mock.calls).toEqual([[failure]]);
      }
      onStatus.mockReset();
      fn.mockResolvedValue({ ok: false, failure: "busy" });
      expect(await runTool(ctx, name, input)).toEqual({ result: { error: "Granola could not be reached." }, refs: [] });
      expect(onStatus).not.toHaveBeenCalled();
    }
  });

  it("a meeting that does not exist is said plainly; a search Granola will not run for this key reads as refused, unrecorded", async () => {
    g.getGranolaNote.mockResolvedValue({ ok: false, failure: "not_found" });
    expect((await runTool(ctx, "get_meeting", { meeting_id: "not a meeting" })).result).toEqual({ error: "No such meeting." });
    g.searchGranolaTranscripts.mockResolvedValue({ ok: false, failure: "not_found" });
    expect((await runTool(ctx, "search_meeting_transcripts", { keywords: "x", meeting_id: "nope" })).result).toEqual({ error: "No such meeting." });

    expect((await runTool(ctx, "search_meeting_transcripts", { keywords: "x" })).result).toEqual({ error: "The Granola key was refused." });
    g.searchGranolaNotes.mockResolvedValue({ ok: false, failure: "not_found" });
    expect((await runTool(ctx, "search_meetings", {})).result).toEqual({ error: "The Granola key was refused." });
    expect(onStatus).not.toHaveBeenCalled();
  });

  it("works without a status listener, and one that throws does not break the answer", async () => {
    g.searchGranolaNotes.mockResolvedValue({ ok: false, failure: "key_rejected" });
    expect((await runTool({ ...base, granola: { key: KEY } }, "search_meetings", {})).result).toEqual({ error: "The Granola key was refused." });
    const angry = { key: KEY, onStatus: () => { throw new Error("listener"); } };
    expect((await runTool({ ...base, granola: angry }, "search_meetings", {})).result).toEqual({ error: "The Granola key was refused." });
  });

  it("never logs or returns the key, even when the client throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    g.getGranolaNote.mockRejectedValue(new Error(`boom ${KEY}`));
    const out = await runTool(ctx, "get_meeting", { meeting_id: MEETING });
    expect(out).toEqual({ result: { error: "That lookup failed." }, refs: [] });
    expect(JSON.stringify(spy.mock.calls)).not.toContain(KEY);
    spy.mockRestore();
  });
});
