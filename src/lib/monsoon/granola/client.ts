// The only code in Monsoon that talks to Granola, and it only reads. Four fixed endpoints on one
// fixed host: list one note (the key test), search notes, get a note, search transcripts. Granola's
// API also has write paths (webhooks, legal holds); nothing here can reach them, because no caller
// can pass a path or a method: the four are spelled out in `target` below.
// The key travels only in the Authorization header. Nothing is logged and nothing is thrown: every
// failure comes back as one of four words. Replies are untrusted: each field is checked for its
// type and clipped, and only the fields named here leave this file. Private notes and whole
// transcripts are never asked for and never returned.

export const GRANOLA_HOST = "https://public-api.granola.ai";
/** Shape only: the real check is a call. */
export const GRANOLA_KEY_SHAPE = /^grn_[A-Za-z0-9_-]{10,300}$/;
export const GRANOLA_NOTE_ID = /^not_[A-Za-z0-9]{14}$/;
export const GRANOLA_TIMEOUT_MS = 8000;

export type GranolaFailure = "key_rejected" | "no_access" | "busy" | "not_found";
export type GranolaFailed = { ok: false; failure: GranolaFailure };
export type GranolaOptions = { /** Milliseconds for the whole call; 8,000 unless given. */ timeoutMs?: number };

/** `date` is an ISO time: when the meeting was held, else when the note was made. */
export type GranolaMeeting = { id: string; title: string | null; date: string | null };
export type GranolaAttendee = { name: string | null; email: string | null };
export type GranolaNote = {
  title: string | null;
  date: string | null;
  /** At most ten. */
  attendees: GranolaAttendee[];
  /** How many attendees were left out of `attendees`. */
  moreAttendees: number;
  /** The meeting's summary, clipped to 6,000 characters. */
  summary: string | null;
  /** The note's page at Granola (https only). */
  url: string | null;
};
export type GranolaPassage = { text: string; start_time: string | null };
export type GranolaTranscriptHit = GranolaMeeting & { passages: GranolaPassage[] };

export type GranolaNoteSearch = { keywords?: string[]; participant?: string; fromDate?: string; toDate?: string };
export type GranolaTranscriptSearch = {
  keywords: string[];
  /** Only these meetings. Ids that are not note ids are dropped; if none is left, nothing is searched. */
  noteIds?: string[];
  participant?: string;
  fromDate?: string;
  toDate?: string;
};

const MAX_LIST = 10;
const MAX_SUMMARY = 6000;
const MAX_TITLE = 300;
const MAX_NAME = 200;
const MAX_PASSAGE = 300;
const MAX_URL = 500;
const MAX_KEYWORDS = 20;
const MAX_NOTE_KEYWORD = 200;
const MAX_TRANSCRIPT_KEYWORD = 100;
const MAX_PARTICIPANT = 200;
const MAX_NOTE_IDS = 100;
const MAX_REPLY_CHARS = 2_000_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

type Endpoint =
  | { kind: "list" }
  | { kind: "search"; body: Record<string, unknown> }
  | { kind: "note"; id: string }
  | { kind: "transcripts"; body: Record<string, unknown> };

/** The whole of what this module can ask Granola. Null when a note id is not one. */
function target(e: Endpoint): { method: "GET" | "POST"; path: string; body?: string } | null {
  switch (e.kind) {
    case "list":
      return { method: "GET", path: "/v1/notes?page_size=1" };
    case "search":
      return { method: "POST", path: "/v1/notes/search", body: JSON.stringify(e.body) };
    case "note":
      return GRANOLA_NOTE_ID.test(e.id) ? { method: "GET", path: `/v1/notes/${e.id}` } : null;
    case "transcripts":
      return { method: "POST", path: "/v1/notes/transcripts/search", body: JSON.stringify(e.body) };
  }
}

const failed = (failure: GranolaFailure): GranolaFailed => ({ ok: false, failure });

/** One request, no retry. Resolves with the parsed reply or a failure; never rejects. */
async function call(key: string, endpoint: Endpoint, opts?: GranolaOptions): Promise<{ ok: true; data: unknown } | GranolaFailed> {
  // A key of another shape is never sent anywhere (and could not break out of the header).
  if (typeof key !== "string" || !GRANOLA_KEY_SHAPE.test(key)) return failed("key_rejected");
  const t = target(endpoint);
  if (!t) return failed("not_found");
  const ms = Math.floor(opts?.timeoutMs ?? GRANOLA_TIMEOUT_MS);
  if (!(ms >= 1)) return failed("busy");
  try {
    const res = await fetch(GRANOLA_HOST + t.path, {
      method: t.method,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        ...(t.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(t.body !== undefined ? { body: t.body } : {}),
      // A redirect could carry the key to another host: refuse to follow one.
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(ms),
    });
    if (res.status !== 200) {
      // The refusal's body is never read: it is not needed and must not be logged.
      void res.body?.cancel().catch(() => undefined);
      if (res.status === 401) return failed("key_rejected");
      if (res.status === 403) return failed("no_access");
      if (res.status === 404) return failed("not_found");
      return failed("busy");
    }
    const text = await res.text();
    if (text.length > MAX_REPLY_CHARS) return failed("busy");
    return { ok: true, data: JSON.parse(text) as unknown };
  } catch {
    // Timeout, network, a refused redirect or a reply that is not JSON. The error is dropped unread.
    return failed("busy");
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A string field, trimmed and clipped; anything else, or blank, is null. */
function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t.slice(0, max);
}

/** A time field as an ISO time; anything that is not one is null. */
function time(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 40 || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** A calendar day the caller gave, or null. */
function day(v: unknown): string | null {
  return typeof v === "string" && DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : null;
}

function words(v: unknown, maxEach: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const w of v) {
    const s = str(w, maxEach);
    if (s !== null) out.push(s);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

/** The filters both searches share. A bare `to_date` would mean that day's first instant, so the day's end is sent. */
function filters(q: { participant?: string; fromDate?: string; toDate?: string }): Record<string, unknown> {
  const participant = str(q.participant, MAX_PARTICIPANT);
  const from = day(q.fromDate);
  const to = day(q.toDate);
  return {
    ...(participant !== null ? { participant } : {}),
    ...(from !== null ? { from_date: from } : {}),
    ...(to !== null ? { to_date: `${to}T23:59:59Z` } : {}),
    page_size: MAX_LIST,
  };
}

/** A live note row reduced to id, title and date; null when it has no usable id or was deleted. */
function meetingOf(row: unknown): GranolaMeeting | null {
  if (!isObj(row) || typeof row.id !== "string" || !GRANOLA_NOTE_ID.test(row.id)) return null;
  if (typeof row.deleted_at === "string" && row.deleted_at !== "") return null;
  return { id: row.id, title: str(row.title, MAX_TITLE), date: time(row.meeting_at) ?? time(row.created_at) };
}

/** Tests a key with the smallest read there is. */
export async function testGranolaKey(key: string, opts?: GranolaOptions): Promise<{ ok: true } | GranolaFailed> {
  const r = await call(key, { kind: "list" }, opts);
  if (!r.ok) return r;
  return isObj(r.data) ? { ok: true } : failed("busy");
}

/** Up to ten meetings matching the filters, as Granola ranks them. */
export async function searchGranolaNotes(
  key: string,
  query: GranolaNoteSearch,
  opts?: GranolaOptions,
): Promise<{ ok: true; meetings: GranolaMeeting[] } | GranolaFailed> {
  const keywords = words(query.keywords, MAX_NOTE_KEYWORD);
  const r = await call(key, { kind: "search", body: { ...(keywords.length > 0 ? { keywords } : {}), ...filters(query) } }, opts);
  if (!r.ok) return r;
  if (!isObj(r.data) || !Array.isArray(r.data.notes)) return failed("busy");
  const meetings: GranolaMeeting[] = [];
  for (const row of r.data.notes) {
    const m = meetingOf(row);
    if (m) meetings.push(m);
    if (meetings.length >= MAX_LIST) break;
  }
  return { ok: true, meetings };
}

/** One meeting's title, date, attendees, summary and link. */
export async function getGranolaNote(key: string, id: string, opts?: GranolaOptions): Promise<{ ok: true; note: GranolaNote } | GranolaFailed> {
  const r = await call(key, { kind: "note", id: typeof id === "string" ? id : "" }, opts);
  if (!r.ok) return r;
  const d = r.data;
  if (!isObj(d)) return failed("busy");
  if (typeof d.deleted_at === "string" && d.deleted_at !== "") return failed("not_found");
  const all: GranolaAttendee[] = [];
  for (const a of Array.isArray(d.attendees) ? d.attendees : []) {
    if (!isObj(a)) continue;
    const who = { name: str(a.name, MAX_NAME), email: str(a.email, MAX_NAME) };
    if (who.name !== null || who.email !== null) all.push(who);
  }
  const url = str(d.web_url, MAX_URL);
  const scheduled = isObj(d.calendar_event) ? time(d.calendar_event.scheduled_start_time) : null;
  return {
    ok: true,
    note: {
      title: str(d.title, MAX_TITLE),
      date: time(d.meeting_at) ?? scheduled ?? time(d.created_at),
      attendees: all.slice(0, MAX_LIST),
      moreAttendees: Math.max(0, all.length - MAX_LIST),
      summary: str(d.summary_markdown, MAX_SUMMARY) ?? str(d.summary_text, MAX_SUMMARY),
      url: url !== null && /^https:\/\//i.test(url) ? url : null,
    },
  };
}

/** Up to ten meetings whose transcripts hold a keyword, each with its matching passages (never the transcript). */
export async function searchGranolaTranscripts(
  key: string,
  query: GranolaTranscriptSearch,
  opts?: GranolaOptions,
): Promise<{ ok: true; meetings: GranolaTranscriptHit[] } | GranolaFailed> {
  const keywords = words(query.keywords, MAX_TRANSCRIPT_KEYWORD);
  if (keywords.length === 0) return { ok: true, meetings: [] };
  let noteIds: string[] | null = null;
  if (query.noteIds !== undefined) {
    noteIds = (Array.isArray(query.noteIds) ? query.noteIds : [])
      .filter((id): id is string => typeof id === "string" && GRANOLA_NOTE_ID.test(id))
      .slice(0, MAX_NOTE_IDS);
    // Asked for one meeting that is not a meeting: searching every meeting instead would be wrong.
    if (noteIds.length === 0) return failed("not_found");
  }
  const body = { keywords, ...(noteIds ? { note_ids: noteIds } : {}), ...filters(query) };
  const r = await call(key, { kind: "transcripts", body }, opts);
  if (!r.ok) return r;
  if (!isObj(r.data) || !Array.isArray(r.data.notes)) return failed("busy");
  const meetings: GranolaTranscriptHit[] = [];
  for (const row of r.data.notes) {
    const m = meetingOf(row);
    if (!m) continue;
    const passages: GranolaPassage[] = [];
    for (const p of Array.isArray((row as Record<string, unknown>).passages) ? ((row as Record<string, unknown>).passages as unknown[]) : []) {
      if (!isObj(p)) continue;
      const text = str(p.text, MAX_PASSAGE);
      if (text !== null) passages.push({ text, start_time: time(p.start_time) });
      if (passages.length >= MAX_LIST) break;
    }
    meetings.push({ ...m, passages });
    if (meetings.length >= MAX_LIST) break;
  }
  return { ok: true, meetings };
}
