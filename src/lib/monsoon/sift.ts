// Sifting the Contacts list: each row's priority, next action and last action, the high-priority
// filter and the sorts. Read-only, fixed-text, parameterised queries inside `readOnly`, like contacts.ts.
import type { ClientBase } from "pg";
import { readOnly, type QueryOptions } from "./ask/queries";
import type { ContactHit } from "./contacts";
import { RECENT_AT_SQL } from "./import/entries";
import { actionLabel, dueBucket, type DueBucket } from "./rules";

export const SORTS = ["recent", "next", "last", "stage"] as const;
export type Sort = (typeof SORTS)[number];

/** What there is to do with a pipeline member. A blank field is null, never missing. */
export type Work = {
  priority: "high" | "medium" | "low" | null;
  nextAction: string | null;
  nextActionDate: string | null; // YYYY-MM-DD
  due: DueBucket;
  /** The newest call, meeting, email or note. */
  lastKind: string | null;
  lastAt: string | null; // ISO time
  /** The stage's place in the pipeline order. */
  stageOrd: number;
  /** The newer of the member's last update and newest timeline entry, an import's own entries aside (the "recent" order). */
  recentAt: string | null;
};

/** A Contacts row: `work` is its pipeline member's (its own, else its company's); null off the pipeline. */
export type SiftHit = ContactHit & { work: Work | null };

const LIST_MAX = 100;
const MEMBERS_MAX = 2000;

const WORK_COLUMNS = `m.priority, m.next_action, m.next_action_date::text AS next_action_date, s.ord AS stage_ord,
       la.kind AS last_kind, la.summary AS last_summary, la.at AS last_at,
       ${RECENT_AT_SQL} AS recent_at`;
const WORK_JOINS = `JOIN stages s ON s.key = m.stage
  LEFT JOIN LATERAL (
    SELECT t.kind, t.summary, t.at FROM touches t
     WHERE t.member_id = m.id AND t.kind IN ('note', 'email', 'call', 'meeting')
     ORDER BY t.at DESC LIMIT 1
  ) la ON true`;

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v ? String(v) : null);

function toWork(r: Record<string, unknown>, today: string): Work {
  const nextAction = typeof r.next_action === "string" && r.next_action.trim() !== "" ? r.next_action.trim() : null;
  const nextActionDate = nextAction && r.next_action_date ? String(r.next_action_date).slice(0, 10) : null;
  return {
    priority: (r.priority as Work["priority"]) ?? null,
    nextAction,
    nextActionDate,
    due: dueBucket({ next_action: nextAction, next_action_date: nextActionDate }, today),
    lastKind: typeof r.last_kind === "string" ? actionLabel(r.last_kind, r.last_summary as string | null) : null,
    lastAt: iso(r.last_at),
    stageOrd: Number(r.stage_ord),
    recentAt: iso(r.recent_at),
  };
}

const byName = (a: SiftHit, b: SiftHit): number =>
  a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || (a.personId ?? a.orgId ?? "").localeCompare(b.personId ?? b.orgId ?? "");

// Blank values sort after every real one, whichever way the real ones run.
function blanksLast(a: string | number | null, b: string | number | null, dir: 1 | -1): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return a < b ? -dir : a > b ? dir : 0;
}

/**
 * `next`: the soonest dated next action first, then next actions with no date, then none.
 * `last`: the most recent last action first, then none. `stage`: in pipeline order.
 * `recent`: most recently touched or updated first. Rows off the pipeline come last; ties by name.
 */
export function sortHits(hits: SiftHit[], sort: Sort): SiftHit[] {
  const key = (h: SiftHit): [string | number | null, string | number | null] => {
    const w = h.work;
    if (!w) return [null, null];
    if (sort === "next") return [w.nextActionDate, w.nextAction ? 0 : null];
    if (sort === "last") return [w.lastAt, null];
    if (sort === "stage") return [w.stageOrd, null];
    return [w.recentAt, null];
  };
  const dir: 1 | -1 = sort === "next" || sort === "stage" ? 1 : -1;
  return [...hits].sort((a, b) => {
    const [a1, a2] = key(a);
    const [b1, b2] = key(b);
    return blanksLast(a1, b1, dir) || blanksLast(a2, b2, 1) || byName(a, b);
  });
}

/** Adds each hit's work from its pipeline member. One query for all of them. */
export function withWork(db: ClientBase, hits: ContactHit[], today: string, opts?: QueryOptions): Promise<SiftHit[]> {
  const ids = [...new Set(hits.map((h) => h.member?.memberId).filter((x): x is string => typeof x === "string"))];
  if (ids.length === 0) return Promise.resolve(hits.map((h) => ({ ...h, work: null })));
  return readOnly(
    db,
    async () => {
      const r = await db.query(
        `SELECT m.id, ${WORK_COLUMNS}
           FROM members m
           ${WORK_JOINS}
          WHERE m.id = ANY($1::uuid[])`,
        [ids],
      );
      const byId = new Map<string, Work>(r.rows.map((x) => [x.id as string, toWork(x, today)]));
      return hits.map((h) => ({ ...h, work: (h.member && byId.get(h.member.memberId)) || null }));
    },
    opts,
  );
}

/**
 * The pipeline's members (a person or a company each), optionally only the high-priority ones,
 * in the given order. At most 100 rows; `total` counts all that matched.
 */
export function listMembers(
  db: ClientBase,
  o: { high: boolean; sort: Sort; today: string },
  opts?: QueryOptions,
): Promise<{ contacts: SiftHit[]; total: number }> {
  return readOnly(
    db,
    async () => {
      const r = await db.query(
        `SELECT m.id AS mid, m.role, m.stage, m.person_id, m.org_id AS member_org_id,
                p.name AS person_name, p.title, p.email, p.org_id AS person_org_id,
                po.name AS company, o.name AS org_name,
                ${WORK_COLUMNS}
           FROM members m
           ${WORK_JOINS}
           LEFT JOIN people p ON p.id = m.person_id
           LEFT JOIN orgs po ON po.id = p.org_id
           LEFT JOIN orgs o ON o.id = m.org_id
          WHERE ($1::boolean IS NOT TRUE OR m.priority = 'high')
          LIMIT ${MEMBERS_MAX}`,
        [o.high],
      );
      const hits = r.rows.map((x): SiftHit => {
        const person = x.person_id !== null;
        return {
          kind: person ? "person" : "company",
          personId: person ? x.person_id : null,
          orgId: person ? x.person_org_id : x.member_org_id,
          name: person ? x.person_name : x.org_name,
          title: person ? x.title : null,
          company: person ? x.company : null,
          email: person ? x.email : null,
          member: { memberId: x.mid, memberKind: person ? "person" : "company", role: x.role, stage: x.stage },
          memberOf: "self",
          work: toWork(x, o.today),
        };
      });
      return { contacts: sortHits(hits, o.sort).slice(0, LIST_MAX), total: hits.length };
    },
    opts,
  );
}

// --- imports -------------------------------------------------------------------------------------

/** One bulk import, as the Contacts tab's Imports filter lists it. */
export type ImportInfo = {
  label: string;
  /** People that came in with it (all imports that used this label together). */
  count: number;
  /** When its newest contact was added (ISO time). */
  at: string | null;
};

const IMPORT_PREFIX = "import:";
const IMPORTS_MAX = 200;
const IMPORTED_MAX = 5000;

/** The imports, newest first: every label a contact's source carries (`import:<label>`), with its count. */
export function listImports(db: ClientBase, opts?: QueryOptions): Promise<ImportInfo[]> {
  return readOnly(
    db,
    async () => {
      const r = await db.query(
        `SELECT substr(p.source, ${IMPORT_PREFIX.length + 1}) AS label, count(*)::int AS n, max(p.created_at) AS at
           FROM people p
          WHERE left(p.source, ${IMPORT_PREFIX.length}) = $1 AND length(p.source) > ${IMPORT_PREFIX.length}
          GROUP BY p.source
          ORDER BY max(p.created_at) DESC, p.source
          LIMIT ${IMPORTS_MAX}`,
        [IMPORT_PREFIX],
      );
      return r.rows.map((x) => ({ label: x.label as string, count: x.n as number, at: iso(x.at) }));
    },
    opts,
  );
}

/**
 * The people who came in with one import (its label, compared exactly), each with the work of their
 * pipeline entry: their own, else their company's. Optionally only the high-priority ones, in the
 * given order. At most 100 rows; `total` counts all that matched.
 */
export function listImported(
  db: ClientBase,
  o: { label: string; high: boolean; sort: Sort; today: string },
  opts?: QueryOptions,
): Promise<{ contacts: SiftHit[]; total: number }> {
  if (o.label === "") return Promise.resolve({ contacts: [], total: 0 });
  return readOnly(
    db,
    async () => {
      const r = await db.query(
        `SELECT p.id AS person_id, p.name, p.title, p.email, p.org_id, po.name AS company,
                own.id AS own_id, m.id AS mid, m.role, m.stage,
                ${WORK_COLUMNS}
           FROM people p
           LEFT JOIN orgs po ON po.id = p.org_id
           LEFT JOIN members own ON own.person_id = p.id
           LEFT JOIN members co ON co.org_id = p.org_id AND own.id IS NULL
           LEFT JOIN members m ON m.id = COALESCE(own.id, co.id)
           LEFT JOIN stages s ON s.key = m.stage
           LEFT JOIN LATERAL (
             SELECT t.kind, t.summary, t.at FROM touches t
              WHERE t.member_id = m.id AND t.kind IN ('note', 'email', 'call', 'meeting')
              ORDER BY t.at DESC LIMIT 1
           ) la ON true
          WHERE p.source = $1 AND ($2::boolean IS NOT TRUE OR m.priority = 'high')
          LIMIT ${IMPORTED_MAX}`,
        [IMPORT_PREFIX + o.label, o.high],
      );
      const hits = r.rows.map((x): SiftHit => {
        const memberKind = x.own_id !== null ? "person" : "company";
        return {
          kind: "person",
          personId: x.person_id,
          orgId: x.org_id,
          name: x.name,
          title: x.title,
          company: x.company,
          email: x.email,
          member: x.mid === null ? null : { memberId: x.mid, memberKind, role: x.role, stage: x.stage },
          memberOf: x.mid === null ? null : x.own_id !== null ? "self" : "company",
          work: x.mid === null ? null : toWork(x, o.today),
        };
      });
      return { contacts: sortHits(hits, o.sort).slice(0, LIST_MAX), total: hits.length };
    },
    opts,
  );
}
