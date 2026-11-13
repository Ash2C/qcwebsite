// Read-only, fixed-text, parameterised queries that Ask's tools call. Nothing here writes.
// Every exported query runs inside one `BEGIN TRANSACTION READ ONLY` with a local statement
// timeout, uses unnamed statements only (safe on a transaction-mode pooler), and leaves the
// connection outside a transaction whether it returns or throws.
import type { ClientBase } from "pg";
import { dueBucket, lastAction, type DueBucket } from "../rules";

export type MemberKind = "person" | "company";
export type MemberRef = { memberId: string; memberKind: MemberKind; role: string; stage: string };
export type Vocabulary = {
  stages: { key: string; label: string; ord: number; terminal: boolean }[];
  roles: { key: string; label: string }[];
  owners: { key: string; name: string }[];
};
export type ContactMatch = {
  kind: MemberKind;
  personId: string | null;
  orgId: string | null;
  name: string;
  company: string | null;
  email: string | null;
  member: MemberRef | null;
};
export type TimelineEntry = { at: string; kind: string; by: string | null; summary: string };
export type PipelineRow = {
  memberId: string;
  memberKind: MemberKind;
  name: string;
  company: string | null;
  role: string;
  stage: string;
  owner: string | null;
  lastActionAt: string | null;
  lastActionKind: string | null;
  nextAction: string | null;
  nextActionDate: string | null;
  due: DueBucket;
};
export type ContactDetail = PipelineRow & {
  priority: string | null;
  anchor: boolean;
  notes: string | null;
  person: {
    title: string | null;
    email: string | null;
    phone: string | null;
    linkedin: string | null;
    country: string | null;
    notes: string | null;
  } | null;
  org: {
    country: string | null;
    type: string | null;
    aumUsd: string | null;
    website: string | null;
    notes: string | null;
  } | null;
  people: { personId: string; name: string; title: string | null; email: string | null; phone: string | null }[];
  timeline: TimelineEntry[];
  timelineTotal: number;
};
export type PersonDetail = {
  personId: string;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  linkedin: string | null;
  country: string | null;
  notes: string | null;
  company: string | null;
  member: MemberRef | null;
};
export type Summary = {
  total: number;
  byStage: { stage: string; count: number }[];
  byRole: { role: string; count: number }[];
  byDue: Record<DueBucket, number>;
  noActionIn30Days: number;
  noActionIn90Days: number;
};
export type NoteHit = {
  member: MemberRef | null;
  name: string;
  company: string | null;
  where: "member notes" | "person notes" | "company notes" | "timeline";
  snippet: string;
  at: string | null;
};
export type ActivityRow = TimelineEntry & { memberId: string; name: string; company: string | null };

export const CUT = " …[cut]";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST_MAX = 50;
const NOTES_MAX = 6000;
const SUMMARY_MAX = 600;
const BUCKETS: DueBucket[] = ["overdue", "today", "week", "later", "undated", "none"];

/** Shorten `text` to `max` characters, appending CUT when something was removed. */
export function clip(text: string | null, max: number): string | null {
  if (text === null || text === undefined) return null;
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1; // do not split a surrogate pair
  return text.slice(0, end) + CUT;
}

/** Run `fn` in a read-only transaction; the connection is outside any transaction afterwards. */
export async function readOnly<T>(db: ClientBase, fn: () => Promise<T>): Promise<T> {
  await db.query("BEGIN TRANSACTION READ ONLY");
  try {
    await db.query("SET LOCAL statement_timeout = '8s'");
    const out = await fn();
    await db.query("COMMIT");
    return out;
  } catch (err) {
    try {
      await db.query("ROLLBACK");
    } catch {
      // the original error is the one that matters
    }
    throw err;
  }
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Start of the UTC day `days` before `today`, as an ISO instant. */
function cutoffIso(today: string, days: number): string {
  return `${addDays(today, -days)}T00:00:00.000Z`;
}

function iso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function ref(id: string | null, role: string | null, stage: string | null, kind: MemberKind): MemberRef | null {
  return id ? { memberId: id, memberKind: kind, role: role as string, stage: stage as string } : null;
}

// --- shared member selection -------------------------------------------------------------------

type MemberRow = {
  id: string;
  kind: MemberKind;
  name: string;
  company: string | null;
  role: string;
  stage: string;
  terminal: boolean;
  owner: string | null;
  next_action: string | null;
  next_action_date: string | null;
  created_at: Date | null;
};

const MEMBER_FROM = `
  FROM members m
  JOIN stages s ON s.key = m.stage
  LEFT JOIN people p ON p.id = m.person_id
  LEFT JOIN orgs po ON po.id = p.org_id
  LEFT JOIN orgs o ON o.id = m.org_id`;

const MEMBER_COLUMNS = `
  m.id, CASE WHEN m.person_id IS NOT NULL THEN 'person' ELSE 'company' END AS kind,
  COALESCE(p.name, o.name) AS name,
  CASE WHEN m.person_id IS NOT NULL THEN po.name END AS company,
  m.role, m.stage, s.terminal, m.owner, m.next_action,
  m.next_action_date::text AS next_action_date, m.created_at`;

const MEMBER_ORDER = "ORDER BY s.ord, m.created_at, m.id";

type ActionTouch = { member_id: string; at: string; kind: string };

/** Action entries (note, email, call, meeting) for the members, `at` as ISO so they compare in time order. */
async function actionTouches(db: ClientBase, ids: string[]): Promise<Map<string, ActionTouch[]>> {
  const out = new Map<string, ActionTouch[]>();
  if (ids.length === 0) return out;
  const r = await db.query(
    `SELECT member_id, at, kind FROM touches
      WHERE member_id = ANY($1::uuid[]) AND kind IN ('note', 'email', 'call', 'meeting')
      ORDER BY member_id, at, id`,
    [ids],
  );
  for (const row of r.rows) {
    const list = out.get(row.member_id) ?? [];
    list.push({ member_id: row.member_id, at: (row.at as Date).toISOString(), kind: row.kind });
    out.set(row.member_id, list);
  }
  return out;
}

function toPipelineRow(m: MemberRow, touches: ActionTouch[], today: string): PipelineRow {
  const last = lastAction(touches);
  return {
    memberId: m.id,
    memberKind: m.kind,
    name: m.name,
    company: m.company,
    role: m.role,
    stage: m.stage,
    owner: m.owner,
    lastActionAt: last ? last.at : null,
    lastActionKind: last ? last.kind : null,
    nextAction: m.next_action,
    nextActionDate: m.next_action_date,
    due: dueBucket(m, today),
  };
}

async function pipelineRows(db: ClientBase, members: MemberRow[], today: string): Promise<PipelineRow[]> {
  const touches = await actionTouches(db, members.map((m) => m.id));
  return members.map((m) => toPipelineRow(m, touches.get(m.id) ?? [], today));
}

// --- queries -----------------------------------------------------------------------------------

export function vocabulary(db: ClientBase): Promise<Vocabulary> {
  return readOnly(db, async () => {
    const stages = await db.query("SELECT key, label, ord, terminal FROM stages ORDER BY ord, key");
    const roles = await db.query("SELECT key, label FROM roles ORDER BY key");
    const owners = await db.query("SELECT key, display_name AS name FROM owners ORDER BY key");
    return {
      stages: stages.rows.map((r) => ({ key: r.key, label: r.label, ord: r.ord, terminal: r.terminal })),
      roles: roles.rows.map((r) => ({ key: r.key, label: r.label })),
      owners: owners.rows.map((r) => ({ key: r.key, name: r.name })),
    };
  });
}

export function findContacts(db: ClientBase, query: string): Promise<ContactMatch[]> {
  const q = (query ?? "").trim();
  if (q.length < 2) return Promise.resolve([]);
  const pattern = escapeLike(q);
  return readOnly(db, async () => {
    const people = await db.query(
      `SELECT p.id, p.name, p.email, p.org_id, po.name AS company,
              own.id AS own_id, own.role AS own_role, own.stage AS own_stage,
              cm.id AS co_id, cm.role AS co_role, cm.stage AS co_stage
         FROM people p
         LEFT JOIN orgs po ON po.id = p.org_id
         LEFT JOIN members own ON own.person_id = p.id
         LEFT JOIN members cm ON cm.org_id = p.org_id
        WHERE p.name ILIKE '%' || $1 || '%' OR p.email ILIKE '%' || $1 || '%'
        ORDER BY p.name, p.id
        LIMIT 20`,
      [pattern],
    );
    const out: ContactMatch[] = people.rows.map((r) => ({
      kind: "person" as const,
      personId: r.id,
      orgId: r.org_id,
      name: r.name,
      company: r.company,
      email: r.email,
      member: r.own_id
        ? ref(r.own_id, r.own_role, r.own_stage, "person")
        : ref(r.co_id, r.co_role, r.co_stage, "company"),
    }));
    const room = 20 - out.length;
    if (room > 0) {
      const orgs = await db.query(
        `SELECT o.id, o.name, m.id AS mid, m.role, m.stage
           FROM orgs o LEFT JOIN members m ON m.org_id = o.id
          WHERE o.name ILIKE '%' || $1 || '%'
          ORDER BY o.name, o.id
          LIMIT $2`,
        [pattern, room],
      );
      for (const r of orgs.rows) {
        out.push({
          kind: "company",
          personId: null,
          orgId: r.id,
          name: r.name,
          company: null,
          email: null,
          member: ref(r.mid, r.role, r.stage, "company"),
        });
      }
    }
    return out;
  });
}

export function getContact(db: ClientBase, memberId: string, today: string): Promise<ContactDetail | null> {
  if (!UUID_RE.test(memberId ?? "")) return Promise.resolve(null);
  return readOnly(db, async () => {
    const found = await db.query(
      `SELECT ${MEMBER_COLUMNS}, m.person_id, m.org_id, m.priority, m.anchor, m.notes AS member_notes
       ${MEMBER_FROM} WHERE m.id = $1`,
      [memberId],
    );
    const m = found.rows[0];
    if (!m) return null;
    const [row] = await pipelineRows(db, [m as MemberRow], today);

    let person: ContactDetail["person"] = null;
    let org: ContactDetail["org"] = null;
    let people: ContactDetail["people"] = [];
    if (m.person_id) {
      const r = (
        await db.query("SELECT title, email, phone, linkedin_url, country, notes FROM people WHERE id = $1", [m.person_id])
      ).rows[0];
      if (r) {
        person = {
          title: r.title,
          email: r.email,
          phone: r.phone,
          linkedin: r.linkedin_url,
          country: r.country,
          notes: clip(r.notes, NOTES_MAX),
        };
      }
    } else {
      const r = (
        await db.query("SELECT country, org_type, aum_usd::text AS aum_usd, website, notes FROM orgs WHERE id = $1", [m.org_id])
      ).rows[0];
      if (r) {
        org = { country: r.country, type: r.org_type, aumUsd: r.aum_usd, website: r.website, notes: clip(r.notes, NOTES_MAX) };
      }
      const pr = await db.query(
        "SELECT id, name, title, email, phone FROM people WHERE org_id = $1 ORDER BY name, id LIMIT 30",
        [m.org_id],
      );
      people = pr.rows.map((p) => ({ personId: p.id, name: p.name, title: p.title, email: p.email, phone: p.phone }));
    }

    const tl = await db.query(
      `SELECT at, kind, by_whom, summary FROM touches WHERE member_id = $1 ORDER BY at DESC, id DESC LIMIT ${LIST_MAX}`,
      [memberId],
    );
    const total = await db.query("SELECT count(*)::int AS n FROM touches WHERE member_id = $1", [memberId]);
    return {
      ...row,
      priority: m.priority,
      anchor: m.anchor,
      notes: clip(m.member_notes, NOTES_MAX),
      person,
      org,
      people,
      timeline: tl.rows.map((t) => ({
        at: iso(t.at) as string,
        kind: t.kind,
        by: t.by_whom,
        summary: clip(t.summary, SUMMARY_MAX) as string,
      })),
      timelineTotal: total.rows[0].n,
    };
  });
}

export function getPerson(db: ClientBase, personId: string): Promise<PersonDetail | null> {
  if (!UUID_RE.test(personId ?? "")) return Promise.resolve(null);
  return readOnly(db, async () => {
    const r = (
      await db.query(
        `SELECT p.id, p.name, p.title, p.email, p.phone, p.linkedin_url, p.country, p.notes, po.name AS company,
                own.id AS own_id, own.role AS own_role, own.stage AS own_stage,
                cm.id AS co_id, cm.role AS co_role, cm.stage AS co_stage
           FROM people p
           LEFT JOIN orgs po ON po.id = p.org_id
           LEFT JOIN members own ON own.person_id = p.id
           LEFT JOIN members cm ON cm.org_id = p.org_id
          WHERE p.id = $1`,
        [personId],
      )
    ).rows[0];
    if (!r) return null;
    return {
      personId: r.id,
      name: r.name,
      title: r.title,
      email: r.email,
      phone: r.phone,
      linkedin: r.linkedin_url,
      country: r.country,
      notes: clip(r.notes, NOTES_MAX),
      company: r.company,
      member: r.own_id
        ? ref(r.own_id, r.own_role, r.own_stage, "person")
        : ref(r.co_id, r.co_role, r.co_stage, "company"),
    };
  });
}

export function listPipeline(
  db: ClientBase,
  filter: { stage?: string; role?: string; owner?: string; due?: DueBucket },
  today: string,
): Promise<{ rows: PipelineRow[]; total: number }> {
  return readOnly(db, async () => {
    const r = await db.query(
      `SELECT ${MEMBER_COLUMNS} ${MEMBER_FROM}
        WHERE ($1::text IS NULL OR m.stage = $1)
          AND ($2::text IS NULL OR m.role = $2)
          AND ($3::text IS NULL OR m.owner = $3)
        ${MEMBER_ORDER}`,
      [filter.stage ?? null, filter.role ?? null, filter.owner ?? null],
    );
    let members = r.rows as MemberRow[];
    if (filter.due) members = members.filter((m) => dueBucket(m, today) === filter.due);
    return { rows: await pipelineRows(db, members.slice(0, LIST_MAX), today), total: members.length };
  });
}

export function pipelineSummary(db: ClientBase, today: string): Promise<Summary> {
  return readOnly(db, async () => {
    const r = await db.query(`SELECT ${MEMBER_COLUMNS} ${MEMBER_FROM} ${MEMBER_ORDER}`);
    const members = r.rows as MemberRow[];
    const touches = await actionTouches(db, members.map((m) => m.id));
    const byStage = new Map<string, number>();
    const byRole = new Map<string, number>();
    const byDue = Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<DueBucket, number>;
    const c30 = cutoffIso(today, 30);
    const c90 = cutoffIso(today, 90);
    let none30 = 0;
    let none90 = 0;
    for (const m of members) {
      byStage.set(m.stage, (byStage.get(m.stage) ?? 0) + 1); // members arrive in stage order
      byRole.set(m.role, (byRole.get(m.role) ?? 0) + 1);
      byDue[dueBucket(m, today)] += 1;
      const last = lastAction(touches.get(m.id) ?? []);
      if (!last || last.at < c30) none30 += 1;
      if (!last || last.at < c90) none90 += 1;
    }
    return {
      total: members.length,
      byStage: [...byStage].map(([stage, count]) => ({ stage, count })),
      byRole: [...byRole].sort(([a], [b]) => (a < b ? -1 : 1)).map(([role, count]) => ({ role, count })),
      byDue,
      noActionIn30Days: none30,
      noActionIn90Days: none90,
    };
  });
}

export function chaseList(
  db: ClientBase,
  filter: { owner?: string },
  today: string,
): Promise<{ due: PipelineRow[]; stale: PipelineRow[] }> {
  return readOnly(db, async () => {
    const r = await db.query(
      `SELECT ${MEMBER_COLUMNS} ${MEMBER_FROM}
        WHERE ($1::text IS NULL OR m.owner = $1 OR m.owner IS NULL)
        ${MEMBER_ORDER}`,
      [filter.owner ?? null],
    );
    const members = r.rows as MemberRow[];
    const touches = await actionTouches(db, members.map((m) => m.id));
    const rows = members.map((m) => ({ m, row: toPipelineRow(m, touches.get(m.id) ?? [], today) }));

    const rank: Record<string, number> = { overdue: 0, today: 1, week: 2 };
    const due = rows
      .filter((x) => x.row.due in rank)
      .sort(
        (a, b) =>
          rank[a.row.due] - rank[b.row.due] ||
          (a.row.nextActionDate ?? "").localeCompare(b.row.nextActionDate ?? "") ||
          a.row.name.localeCompare(b.row.name),
      )
      .slice(0, LIST_MAX)
      .map((x) => x.row);

    const c30 = cutoffIso(today, 30);
    const stale = rows
      .filter(
        (x) =>
          !x.m.terminal &&
          (x.row.due === "none" || x.row.due === "undated") &&
          (x.row.lastActionAt === null || x.row.lastActionAt < c30),
      )
      .sort(
        (a, b) =>
          (a.row.lastActionAt ?? "").localeCompare(b.row.lastActionAt ?? "") || a.row.name.localeCompare(b.row.name),
      )
      .slice(0, LIST_MAX)
      .map((x) => x.row);
    return { due, stale };
  });
}

function snippetAround(text: string, needle: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const idx = flat.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) return clip(flat, 160) as string;
  const start = Math.max(0, idx - 80);
  const end = Math.min(flat.length, idx + needle.length + 80);
  return (start > 0 ? "…" : "") + flat.slice(start, end) + (end < flat.length ? "…" : "");
}

export function searchNotes(db: ClientBase, text: string): Promise<NoteHit[]> {
  const q = (text ?? "").trim();
  if (q.length < 2) return Promise.resolve([]);
  const pattern = escapeLike(q);
  return readOnly(db, async () => {
    const hits: NoteHit[] = [];
    const memberNotes = await db.query(
      `SELECT ${MEMBER_COLUMNS}, m.notes AS body ${MEMBER_FROM}
        WHERE m.notes ILIKE '%' || $1 || '%' ORDER BY m.id LIMIT 30`,
      [pattern],
    );
    for (const r of memberNotes.rows) {
      hits.push({
        member: ref(r.id, r.role, r.stage, r.kind),
        name: r.name,
        company: r.company,
        where: "member notes",
        snippet: snippetAround(r.body, q),
        at: null,
      });
    }
    const personNotes = await db.query(
      `SELECT p.name, p.notes AS body, po.name AS company,
              own.id AS own_id, own.role AS own_role, own.stage AS own_stage,
              cm.id AS co_id, cm.role AS co_role, cm.stage AS co_stage
         FROM people p
         LEFT JOIN orgs po ON po.id = p.org_id
         LEFT JOIN members own ON own.person_id = p.id
         LEFT JOIN members cm ON cm.org_id = p.org_id
        WHERE p.notes ILIKE '%' || $1 || '%' ORDER BY p.name, p.id LIMIT 30`,
      [pattern],
    );
    for (const r of personNotes.rows) {
      hits.push({
        member: r.own_id
          ? ref(r.own_id, r.own_role, r.own_stage, "person")
          : ref(r.co_id, r.co_role, r.co_stage, "company"),
        name: r.name,
        company: r.company,
        where: "person notes",
        snippet: snippetAround(r.body, q),
        at: null,
      });
    }
    const orgNotes = await db.query(
      `SELECT o.name, o.notes AS body, m.id AS mid, m.role, m.stage
         FROM orgs o LEFT JOIN members m ON m.org_id = o.id
        WHERE o.notes ILIKE '%' || $1 || '%' ORDER BY o.name, o.id LIMIT 30`,
      [pattern],
    );
    for (const r of orgNotes.rows) {
      hits.push({
        member: ref(r.mid, r.role, r.stage, "company"),
        name: r.name,
        company: null,
        where: "company notes",
        snippet: snippetAround(r.body, q),
        at: null,
      });
    }
    const timeline = await db.query(
      `SELECT ${MEMBER_COLUMNS}, t.summary AS body, t.at AS touch_at
         FROM touches t
         JOIN members m ON m.id = t.member_id
         JOIN stages s ON s.key = m.stage
         LEFT JOIN people p ON p.id = m.person_id
         LEFT JOIN orgs po ON po.id = p.org_id
         LEFT JOIN orgs o ON o.id = m.org_id
        WHERE t.summary ILIKE '%' || $1 || '%' ORDER BY t.at DESC, t.id DESC LIMIT 30`,
      [pattern],
    );
    for (const r of timeline.rows) {
      hits.push({
        member: ref(r.id, r.role, r.stage, r.kind),
        name: r.name,
        company: r.company,
        where: "timeline",
        snippet: snippetAround(r.body, q),
        at: iso(r.touch_at),
      });
    }
    return hits.slice(0, 30);
  });
}

export function recentActivity(db: ClientBase, days: number, today: string): Promise<ActivityRow[]> {
  const n = Number.isFinite(days) ? Math.min(90, Math.max(1, Math.trunc(days))) : 7;
  const since = cutoffIso(today, n);
  return readOnly(db, async () => {
    const r = await db.query(
      `SELECT m.id AS member_id, COALESCE(p.name, o.name) AS name,
              CASE WHEN m.person_id IS NOT NULL THEN po.name END AS company,
              t.at, t.kind, t.by_whom, t.summary
         FROM touches t
         JOIN members m ON m.id = t.member_id
         LEFT JOIN people p ON p.id = m.person_id
         LEFT JOIN orgs po ON po.id = p.org_id
         LEFT JOIN orgs o ON o.id = m.org_id
        WHERE t.at >= $1::timestamptz
        ORDER BY t.at DESC, t.id DESC
        LIMIT ${LIST_MAX}`,
      [since],
    );
    return r.rows.map((x) => ({
      at: iso(x.at) as string,
      kind: x.kind,
      by: x.by_whom,
      summary: clip(x.summary, SUMMARY_MAX) as string,
      memberId: x.member_id,
      name: x.name,
      company: x.company,
    }));
  });
}
