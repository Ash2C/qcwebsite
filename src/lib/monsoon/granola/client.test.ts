import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "./client";
import {
  GRANOLA_HOST,
  getGranolaNote,
  searchGranolaNotes,
  searchGranolaTranscripts,
  testGranolaKey,
} from "./client";

// Obviously fake: the shape of a key, never a real one.
const KEY = "grn_FAKE_test_key_0000000000";
const ID = "not_AAAAAAAAAAAAAA";
const ID2 = "not_BBBBBBBBBBBBBB";

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
type Sent = { url: string; init: RequestInit & { headers: Record<string, string> } };
const sent = (n = 0): Sent => ({ url: String(fetchMock.mock.calls[n][0]), init: fetchMock.mock.calls[n][1] });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("every Granola request", () => {
  it("goes to the fixed host with the key only in the Authorization header, no redirects, a timeout and no retry", async () => {
    fetchMock.mockResolvedValue(json({ notes: [], hasMore: false, cursor: null }));
    expect(GRANOLA_HOST).toBe("https://public-api.granola.ai");
    expect(await testGranolaKey(KEY)).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init } = sent();
    expect(url).toBe("https://public-api.granola.ai/v1/notes?page_size=1");
    expect(url).not.toContain(KEY);
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.body).toBeUndefined();
  });

  it("maps each refusal to its failure and never tries again", async () => {
    const cases: [number, string][] = [
      [401, "key_rejected"],
      [403, "no_access"],
      [404, "not_found"],
      [429, "busy"],
      [500, "busy"],
      [503, "busy"],
      [400, "busy"],
      [302, "busy"],
    ];
    for (const [status, failure] of cases) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(json({ code: "X", message: `secret ${KEY}` }, status));
      expect(await testGranolaKey(KEY), String(status)).toEqual({ ok: false, failure });
      expect(await getGranolaNote(KEY, ID), String(status)).toEqual({ ok: false, failure });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  });

  it("answers busy, without throwing or logging, on a network error, a timeout and a reply that is not JSON", async () => {
    const log = [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "log"), vi.spyOn(console, "info")];
    fetchMock.mockRejectedValueOnce(new TypeError(`fetch failed ${KEY}`));
    expect(await searchGranolaNotes(KEY, { keywords: ["x"] })).toEqual({ ok: false, failure: "busy" });

    fetchMock.mockResolvedValueOnce(new Response("<html>not json</html>", { status: 200 }));
    expect(await searchGranolaNotes(KEY, { keywords: ["x"] })).toEqual({ ok: false, failure: "busy" });

    fetchMock.mockResolvedValueOnce(json(["not", "an", "object"]));
    expect(await searchGranolaNotes(KEY, { keywords: ["x"] })).toEqual({ ok: false, failure: "busy" });
    fetchMock.mockResolvedValueOnce(json({ notes: "nope" }));
    expect(await searchGranolaTranscripts(KEY, { keywords: ["x"] })).toEqual({ ok: false, failure: "busy" });
    fetchMock.mockResolvedValueOnce(json(null));
    expect(await testGranolaKey(KEY)).toEqual({ ok: false, failure: "busy" });

    // A server that never answers: the caller's timeout ends the wait.
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const started = Date.now();
    expect(await getGranolaNote(KEY, ID, { timeoutMs: 30 })).toEqual({ ok: false, failure: "busy" });
    expect(Date.now() - started).toBeLessThan(2000);
    for (const spy of log) expect(spy).not.toHaveBeenCalled();
  });

  it("makes no request when there is no time left", async () => {
    for (const timeoutMs of [0, -5, Number.NaN]) {
      expect(await testGranolaKey(KEY, { timeoutMs })).toEqual({ ok: false, failure: "busy" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a key that is not shaped like one without sending it anywhere", async () => {
    for (const bad of ["", "sk-ant-api03-nope", "grn_short", `${KEY}\r\nX-Evil: 1`, `grn_${"a".repeat(400)}`]) {
      expect(await testGranolaKey(bad)).toEqual({ ok: false, failure: "key_rejected" });
      expect(await searchGranolaNotes(bad, {})).toEqual({ ok: false, failure: "key_rejected" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reaches only the four read endpoints, whatever it is given", async () => {
    fetchMock.mockImplementation(async () => json({ notes: [] }));
    const hostile = ["../webhooks", "not_AAAAAAAAAAAAAA/../../webhooks", "not_AAAAAAAAAAAAA?x=1", "", "legal-holds", "not_AAAAAAAAAAAAAA#", " not_AAAAAAAAAAAAAA"];
    for (const id of hostile) {
      expect(await getGranolaNote(KEY, id)).toEqual({ ok: false, failure: "not_found" });
    }
    expect(fetchMock).not.toHaveBeenCalled();

    await testGranolaKey(KEY);
    await getGranolaNote(KEY, ID);
    await searchGranolaNotes(KEY, { keywords: ["/v1/webhooks"], participant: "../x", fromDate: "DELETE", toDate: "2026-01-01" });
    await searchGranolaTranscripts(KEY, { keywords: ["a"], noteIds: [ID, "../webhooks", "not_short"], participant: "?x" });
    const allowed = new Set([
      "GET https://public-api.granola.ai/v1/notes?page_size=1",
      `GET https://public-api.granola.ai/v1/notes/${ID}`,
      "POST https://public-api.granola.ai/v1/notes/search",
      "POST https://public-api.granola.ai/v1/notes/transcripts/search",
    ]);
    const made = fetchMock.mock.calls.map((c) => `${c[1].method} ${c[0]}`);
    expect(made).toHaveLength(4);
    expect(new Set(made)).toEqual(allowed);
    // Nothing exported can be handed a path or a method.
    expect(Object.keys(client).sort()).toEqual([
      "GRANOLA_HOST",
      "GRANOLA_KEY_SHAPE",
      "GRANOLA_NOTE_ID",
      "GRANOLA_TIMEOUT_MS",
      "getGranolaNote",
      "searchGranolaNotes",
      "searchGranolaTranscripts",
      "testGranolaKey",
    ]);
  });
});

describe("searchGranolaNotes", () => {
  it("posts only the filters given, tidied, and returns id, title and date for at most ten meetings", async () => {
    const notes = Array.from({ length: 14 }, (_, i) => ({
      id: `not_${String(i).padStart(14, "0")}`,
      object: "note",
      title: `Meeting ${i}`,
      owner: { name: "Owner", email: "owner@example.com" },
      created_at: "2026-11-01T09:00:00Z",
      meeting_at: "2026-11-02T10:00:00Z",
      deleted_at: null,
    }));
    fetchMock.mockResolvedValue(json({ notes, hasMore: true, cursor: "c", completion_status: "more_available" }));
    const r = await searchGranolaNotes(KEY, {
      keywords: [" budget ", "", "x".repeat(300), 7 as unknown as string],
      participant: "  acme.com ",
      fromDate: "2026-11-01",
      toDate: "2026-11-20",
    });
    const { url, init } = sent();
    expect(url).toBe("https://public-api.granola.ai/v1/notes/search");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({
      keywords: ["budget", "x".repeat(200)],
      participant: "acme.com",
      from_date: "2026-11-01",
      // The whole of the last day: a bare date would mean its first instant.
      to_date: "2026-11-20T23:59:59Z",
      page_size: 10,
    });
    if (!r.ok) throw new Error("expected ok");
    expect(r.meetings).toHaveLength(10);
    expect(r.meetings[0]).toEqual({ id: "not_00000000000000", title: "Meeting 0", date: "2026-11-02T10:00:00.000Z" });
  });

  it("sends an empty search as page_size only, and leaves out dates that are not dates", async () => {
    fetchMock.mockImplementation(async () => json({ notes: [] }));
    expect(await searchGranolaNotes(KEY, {})).toEqual({ ok: true, meetings: [] });
    expect(JSON.parse(String(sent(0).init.body))).toEqual({ page_size: 10 });
    await searchGranolaNotes(KEY, { keywords: [], participant: "   ", fromDate: "yesterday", toDate: "2026-13-45T00:00" });
    expect(JSON.parse(String(sent(1).init.body))).toEqual({ page_size: 10 });
  });

  it("treats every field of the reply as untrusted", async () => {
    fetchMock.mockResolvedValue(
      json({
        notes: [
          null,
          "text",
          { id: "../../etc", title: "bad id", meeting_at: "2026-11-02T10:00:00Z" },
          { id: ID, title: { nested: "object" }, meeting_at: 12345, created_at: "2026-11-01T09:00:00Z", private_notes_text: "secret", owner: { email: "o@example.com" } },
          { id: ID2, title: "T".repeat(900), meeting_at: "not a date", created_at: ["x"] },
          { id: "not_CCCCCCCCCCCCCC", title: "Deleted", meeting_at: "2026-11-02T10:00:00Z", deleted_at: "2026-11-03T10:00:00Z" },
        ],
      }),
    );
    const r = await searchGranolaNotes(KEY, { keywords: ["x"] });
    if (!r.ok) throw new Error("expected ok");
    expect(r.meetings).toEqual([
      { id: ID, title: null, date: "2026-11-01T09:00:00.000Z" },
      { id: ID2, title: "T".repeat(300), date: null },
    ]);
    expect(JSON.stringify(r)).not.toContain("secret");
  });
});

describe("getGranolaNote", () => {
  const NOTE = {
    id: ID,
    object: "note",
    title: "Quarterly review",
    owner: { name: "Owner", email: "owner@example.com" },
    created_at: "2026-11-01T09:00:00Z",
    web_url: "https://notes.granola.ai/d/00000000-0000-4000-8000-000000000000",
    calendar_event: { event_title: "Review", scheduled_start_time: "2026-11-02T10:00:00Z", invitees: [{ email: "i@example.com" }] },
    attendees: [
      { name: "Jane Doe", email: "jane@example.com" },
      { name: null, email: "sam@example.com" },
    ],
    summary_text: "Plain summary.",
    summary_markdown: "## Summary\nWe agreed the price.",
    private_notes_text: "PRIVATE-TEXT push back on the forecast",
    private_notes_markdown: "PRIVATE-MD",
    transcript: [{ speaker: { source: "microphone" }, text: "TRANSCRIPT-LINE", start_time: "2026-11-02T10:00:01Z", end_time: "2026-11-02T10:00:02Z" }],
    attachments: [{ id: "att_AAAAAAAAAAAAAA", url: "https://example.com/a.png" }],
  };

  it("gets one note by id and returns title, date, attendees, summary and link, and nothing else", async () => {
    fetchMock.mockResolvedValue(json(NOTE));
    const r = await getGranolaNote(KEY, ID);
    expect(sent().url).toBe(`https://public-api.granola.ai/v1/notes/${ID}`);
    expect(sent().init.method).toBe("GET");
    expect(sent().init.body).toBeUndefined();
    expect(r).toEqual({
      ok: true,
      note: {
        title: "Quarterly review",
        date: "2026-11-02T10:00:00.000Z",
        attendees: [
          { name: "Jane Doe", email: "jane@example.com" },
          { name: null, email: "sam@example.com" },
        ],
        moreAttendees: 0,
        summary: "## Summary\nWe agreed the price.",
        url: "https://notes.granola.ai/d/00000000-0000-4000-8000-000000000000",
      },
    });
    const text = JSON.stringify(r);
    for (const leak of ["PRIVATE", "TRANSCRIPT-LINE", "att_", "i@example.com", "owner@example.com"]) expect(text).not.toContain(leak);
  });

  it("falls back to the plain summary and the creation time, clips the summary to 6,000 characters and the attendees to ten", async () => {
    fetchMock.mockResolvedValue(
      json({
        ...NOTE,
        calendar_event: null,
        summary_markdown: null,
        summary_text: "s".repeat(9000),
        attendees: Array.from({ length: 13 }, (_, i) => ({ name: `P${i}`, email: `p${i}@example.com` })),
      }),
    );
    const r = await getGranolaNote(KEY, ID);
    if (!r.ok) throw new Error("expected ok");
    expect(r.note.summary).toHaveLength(6000);
    expect(r.note.date).toBe("2026-11-01T09:00:00.000Z");
    expect(r.note.attendees).toHaveLength(10);
    expect(r.note.moreAttendees).toBe(3);
  });

  it("prefers meeting_at when the note carries one", async () => {
    fetchMock.mockResolvedValue(json({ ...NOTE, meeting_at: "2026-11-05T08:00:00Z" }));
    const r = await getGranolaNote(KEY, ID);
    if (!r.ok) throw new Error("expected ok");
    expect(r.note.date).toBe("2026-11-05T08:00:00.000Z");
  });

  it("drops fields of the wrong type and a link that is not https", async () => {
    fetchMock.mockResolvedValue(
      json({
        id: ID,
        title: 42,
        created_at: {},
        web_url: "javascript:alert(1)",
        attendees: [null, "x", { name: 5, email: [] }, { name: "N".repeat(500), email: 9 }, { email: "only@example.com" }],
        summary_text: { a: 1 },
        summary_markdown: 7,
      }),
    );
    expect(await getGranolaNote(KEY, ID)).toEqual({
      ok: true,
      note: {
        title: null,
        date: null,
        attendees: [
          { name: "N".repeat(200), email: null },
          { name: null, email: "only@example.com" },
        ],
        moreAttendees: 0,
        summary: null,
        url: null,
      },
    });
    fetchMock.mockResolvedValue(json({ ...NOTE, attendees: "nobody" }));
    const r = await getGranolaNote(KEY, ID);
    if (!r.ok) throw new Error("expected ok");
    expect(r.note.attendees).toEqual([]);
  });

  it("a deleted note is not found", async () => {
    fetchMock.mockResolvedValue(json({ ...NOTE, deleted_at: "2026-11-03T10:00:00Z" }));
    expect(await getGranolaNote(KEY, ID)).toEqual({ ok: false, failure: "not_found" });
  });
});

describe("searchGranolaTranscripts", () => {
  it("posts keywords and filters, and returns each meeting with its passages", async () => {
    fetchMock.mockResolvedValue(
      json({
        notes: [
          {
            id: ID,
            title: "Pricing call",
            created_at: "2026-11-01T09:00:00Z",
            meeting_at: "2026-11-02T10:00:00Z",
            passages: [
              { text: "the price goes up in January", start_time: "2026-11-02T10:05:00Z", matched_keywords: ["price"] },
              { text: "p".repeat(900), start_time: null, matched_keywords: [] },
              { text: 5, start_time: "2026-11-02T10:06:00Z" },
              "junk",
            ],
            private_notes_text: "PRIVATE",
          },
          { id: ID2, title: null, meeting_at: "2026-11-03T10:00:00Z", passages: "none" },
          { id: "bad", passages: [{ text: "x", start_time: null }] },
        ],
        hasMore: false,
        cursor: null,
        completion_status: "exhausted",
      }),
    );
    const r = await searchGranolaTranscripts(KEY, {
      keywords: ["price", "k".repeat(150), " "],
      noteIds: [ID, "nope"],
      participant: "jane@example.com",
      fromDate: "2026-11-01",
      toDate: "2026-11-30",
    });
    expect(sent().url).toBe("https://public-api.granola.ai/v1/notes/transcripts/search");
    expect(sent().init.method).toBe("POST");
    expect(JSON.parse(String(sent().init.body))).toEqual({
      keywords: ["price", "k".repeat(100)],
      note_ids: [ID],
      participant: "jane@example.com",
      from_date: "2026-11-01",
      to_date: "2026-11-30T23:59:59Z",
      page_size: 10,
    });
    expect(r).toEqual({
      ok: true,
      meetings: [
        {
          id: ID,
          title: "Pricing call",
          date: "2026-11-02T10:00:00.000Z",
          passages: [
            { text: "the price goes up in January", start_time: "2026-11-02T10:05:00.000Z" },
            { text: "p".repeat(300), start_time: null },
          ],
        },
        { id: ID2, title: null, date: "2026-11-03T10:00:00.000Z", passages: [] },
      ],
    });
  });

  it("caps the meetings and each meeting's passages at ten", async () => {
    const passages = Array.from({ length: 15 }, (_, i) => ({ text: `passage ${i}`, start_time: null }));
    const notes = Array.from({ length: 12 }, (_, i) => ({ id: `not_${String(i).padStart(14, "0")}`, title: "T", meeting_at: "2026-11-02T10:00:00Z", passages }));
    fetchMock.mockResolvedValue(json({ notes }));
    const r = await searchGranolaTranscripts(KEY, { keywords: ["x"] });
    if (!r.ok) throw new Error("expected ok");
    expect(r.meetings).toHaveLength(10);
    expect(r.meetings[0].passages).toHaveLength(10);
  });

  it("asks nothing and finds nothing without a keyword, or when the only meeting named is not a meeting id", async () => {
    expect(await searchGranolaTranscripts(KEY, { keywords: [" ", ""] })).toEqual({ ok: true, meetings: [] });
    expect(await searchGranolaTranscripts(KEY, { keywords: ["x"], noteIds: ["../webhooks"] })).toEqual({ ok: false, failure: "not_found" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
