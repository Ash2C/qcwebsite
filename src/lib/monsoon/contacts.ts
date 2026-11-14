// Contacts tab lookups: search, recent pipeline members and one contact's profile. Read-only,
// fixed-text, parameterised queries; each export runs inside `readOnly` (one read-only transaction,
// unnamed statements, connection left outside a transaction on return or throw). Nothing here writes.
import type { ClientBase } from "pg";
import { clip, readOnly, type MemberKind, type MemberRef, type QueryOptions, type TimelineEntry } from "./ask/queries";
import { dueBucket, type DueBucket } from "./rules";

export type ContactHit = {
  kind: MemberKind; // a person or a company
  personId: string | null;
  orgId: string | null; // the company's id for a company hit; the person's company for a person hit
  name: string;
  title: string | null;
  company: string | null; // person hits: their company name
  email: string | null;
  member: MemberRef | null; // own membership, else the company's, else null
  memberOf: "self" | "company" | null;
};

export type Profile = {
  kind: MemberKind;
  personId: string | null;
  orgId: string | null; // company profile: its id; person profile: their company's id
  name: string;
  title: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  linkedin: string | null;
  country: string | null;
  website: string | null; // company profile; for a person, their company's website
  notes: string | null; // the person's or company's own notes field
  member:
    | (MemberRef & {
        owner: string | null;
        priority: string | null;
        nextAction: string | null;
        nextActionDate: string | null;
        due: DueBucket;
        notes: string | null;
      })
    | null;
  memberOf: "self" | "company" | null;
  timelineOf: string | null; // the company's name when the timeline shown is the company's
  timeline: TimelineEntry[]; // newest first, up to 50, summaries clipped to 600
  timelineTotal: number;
  people: { personId: string; name: string; title: string | null; email: string | null; phone: string | null }[]; // company profile, up to 50
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEARCH_MAX = 30;
const RECENT_MAX = 20;
const LIST_MAX = 50;
const NOTES_MAX = 6000;
const SUMMARY_MAX = 600;

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function ref(id: string | null, role: string | null, stage: string | null, kind: MemberKind): MemberRef | null {
  return id ? { memberId: id, memberKind: kind, role: role as string, stage: stage as string } : null;
}

// --- search ------------------------------------------------------------------------------------

type Ranked = { rank: number; hit: ContactHit };

const byRankThenName = (a: Ranked, b: Ranked): number =>
  a.rank - b.rank ||
  a.hit.name.toLowerCase().localeCompare(b.hit.name.toLowerCase()) ||
  (a.hit.personId ?? a.hit.orgId ?? "").localeCompare(b.hit.personId ?? b.hit.orgId ?? "");

/**
 * Case-insensitive substring search over a person's name, email and company name, and over company
 * names. Rows whose name starts with the text come first, then rows whose name contains it, then rows
 * matched only through the company or the email; within each, by name. At most 30.
 */
export function searchContacts(db: ClientBase, q: string, opts?: QueryOptions): Promise<ContactHit[]> {
  const text = (q ?? "").trim();
  if (text.length === 0) return Promise.resolve([]);
  const pattern = escapeLike(text);
  return readOnly(
    db,
    async () => {
      // Each source keeps its own best 30, so the best 30 of the two together are among them.
      const people = await db.query(
        `SELECT p.id, p.name, p.title, p.email, p.org_id, po.name AS company,
                CASE WHEN p.name ILIKE $1 || '%' ESCAPE '\\' THEN 0
                     WHEN p.name ILIKE '%' || $1 || '%' ESCAPE '\\' THEN 1 ELSE 2 END AS rank,
                own.id AS own_id, own.role AS own_role, own.stage AS own_stage,
                cm.id AS co_id, cm.role AS co_role, cm.stage AS co_stage
           FROM people p
           LEFT JOIN orgs po ON po.id = p.org_id
           LEFT JOIN members own ON own.person_id = p.id
           LEFT JOIN members cm ON cm.org_id = p.org_id
          WHERE p.name ILIKE '%' || $1 || '%' ESCAPE '\\'
             OR p.email ILIKE '%' || $1 || '%' ESCAPE '\\'
             OR po.name ILIKE '%' || $1 || '%' ESCAPE '\\'
          ORDER BY rank, lower(p.name), p.id
          LIMIT ${SEARCH_MAX}`,
        [pattern],
      );
      const orgs = await db.query(
        `SELECT o.id, o.name,
                CASE WHEN o.name ILIKE $1 || '%' ESCAPE '\\' THEN 0 ELSE 1 END AS rank,
                m.id AS mid, m.role, m.stage
           FROM orgs o LEFT JOIN members m ON m.org_id = o.id
          WHERE o.name ILIKE '%' || $1 || '%' ESCAPE '\\'
          ORDER BY rank, lower(o.name), o.id
          LIMIT ${SEARCH_MAX}`,
        [pattern],
      );
      const found: Ranked[] = [];
      for (const r of people.rows) {
        const own = ref(r.own_id, r.own_role, r.own_stage, "person");
        const viaCompany = ref(r.co_id, r.co_role, r.co_stage, "company");
        found.push({
          rank: r.rank,
          hit: {
            kind: "person",
            personId: r.id,
            orgId: r.org_id,
            name: r.name,
            title: r.title,
            company: r.company,
            email: r.email,
            member: own ?? viaCompany,
            memberOf: own ? "self" : viaCompany ? "company" : null,
          },
        });
      }
      for (const r of orgs.rows) {
        const own = ref(r.mid, r.role, r.stage, "company");
        found.push({
          rank: r.rank,
          hit: {
            kind: "company",
            personId: null,
            orgId: r.id,
            name: r.name,
            title: null,
            company: null,
            email: null,
            member: own,
            memberOf: own ? "self" : null,
          },
        });
      }
      return found.sort(byRankThenName).slice(0, SEARCH_MAX).map((f) => f.hit);
    },
    opts,
  );
}

// --- recent ------------------------------------------------------------------------------------

/** The 20 pipeline members touched or updated most recently, a person or a company each. */
export function recentContacts(db: ClientBase, opts?: QueryOptions): Promise<ContactHit[]> {
  return readOnly(
    db,
    async () => {
      const r = await db.query(
        `SELECT m.id AS mid, m.role, m.stage, m.person_id, m.org_id AS member_org_id,
                p.name AS person_name, p.title, p.email, p.org_id AS person_org_id,
                po.name AS company, o.name AS org_name
           FROM members m
           LEFT JOIN people p ON p.id = m.person_id
           LEFT JOIN orgs po ON po.id = p.org_id
           LEFT JOIN orgs o ON o.id = m.org_id
          ORDER BY GREATEST(m.updated_at, (SELECT max(t.at) FROM touches t WHERE t.member_id = m.id)) DESC NULLS LAST,
                   lower(COALESCE(p.name, o.name)), m.id
          LIMIT ${RECENT_MAX}`,
      );
      return r.rows.map((x): ContactHit => {
        const person = x.person_id !== null;
        return {
          kind: person ? "person" : "company",
          personId: person ? x.person_id : null,
          orgId: person ? x.person_org_id : x.member_org_id,
          name: person ? x.person_name : x.org_name,
          title: person ? x.title : null,
          company: person ? x.company : null,
          email: person ? x.email : null,
          member: ref(x.mid, x.role, x.stage, person ? "person" : "company"),
          memberOf: "self",
        };
      });
    },
    opts,
  );
}

// --- profile -----------------------------------------------------------------------------------

type Target = { memberId?: string; personId?: string; orgId?: string };
type ProfileMember = NonNullable<Profile["member"]>;

async function loadMember(
  db: ClientBase,
  memberId: string,
  today: string,
): Promise<{ member: ProfileMember; timeline: TimelineEntry[]; total: number }> {
  const m = (
    await db.query(
      `SELECT id, person_id, role, stage, owner, priority, next_action, next_action_date::text AS next_action_date, notes
         FROM members WHERE id = $1`,
      [memberId],
    )
  ).rows[0];
  const tl = await db.query(
    `SELECT at, kind, by_whom, summary FROM touches WHERE member_id = $1 ORDER BY at DESC, id DESC LIMIT ${LIST_MAX}`,
    [memberId],
  );
  const total = await db.query("SELECT count(*)::int AS n FROM touches WHERE member_id = $1", [memberId]);
  return {
    member: {
      memberId: m.id,
      memberKind: m.person_id ? "person" : "company",
      role: m.role,
      stage: m.stage,
      owner: m.owner,
      priority: m.priority,
      nextAction: m.next_action,
      nextActionDate: m.next_action_date,
      due: dueBucket(m, today),
      notes: clip(m.notes, NOTES_MAX),
    },
    timeline: tl.rows.map((t) => ({
      at: iso(t.at),
      kind: t.kind,
      by: t.by_whom,
      summary: clip(t.summary, SUMMARY_MAX) as string,
    })),
    total: total.rows[0].n,
  };
}

async function personProfile(db: ClientBase, personId: string, today: string): Promise<Profile | null> {
  const r = (
    await db.query(
      `SELECT p.id, p.org_id, p.name, p.title, p.email, p.phone, p.linkedin_url, p.country, p.notes,
              po.name AS company, po.website, own.id AS own_id, cm.id AS co_id
         FROM people p
         LEFT JOIN orgs po ON po.id = p.org_id
         LEFT JOIN members own ON own.person_id = p.id
         LEFT JOIN members cm ON cm.org_id = p.org_id
        WHERE p.id = $1`,
      [personId],
    )
  ).rows[0];
  if (!r) return null;
  const memberOf: Profile["memberOf"] = r.own_id ? "self" : r.co_id ? "company" : null;
  const loaded = memberOf ? await loadMember(db, (r.own_id ?? r.co_id) as string, today) : null;
  return {
    kind: "person",
    personId: r.id,
    orgId: r.org_id,
    name: r.name,
    title: r.title,
    company: r.company,
    email: r.email,
    phone: r.phone,
    linkedin: r.linkedin_url,
    country: r.country,
    website: r.website,
    notes: clip(r.notes, NOTES_MAX),
    member: loaded?.member ?? null,
    memberOf,
    timelineOf: memberOf === "company" ? r.company : null,
    timeline: loaded?.timeline ?? [],
    timelineTotal: loaded?.total ?? 0,
    people: [],
  };
}

async function companyProfile(db: ClientBase, orgId: string, today: string): Promise<Profile | null> {
  const r = (
    await db.query(
      `SELECT o.id, o.name, o.country, o.website, o.notes, m.id AS mid
         FROM orgs o LEFT JOIN members m ON m.org_id = o.id WHERE o.id = $1`,
      [orgId],
    )
  ).rows[0];
  if (!r) return null;
  const loaded = r.mid ? await loadMember(db, r.mid, today) : null;
  const people = await db.query(
    `SELECT id, name, title, email, phone FROM people WHERE org_id = $1 ORDER BY name, id LIMIT ${LIST_MAX}`,
    [orgId],
  );
  return {
    kind: "company",
    personId: null,
    orgId: r.id,
    name: r.name,
    title: null,
    company: null,
    email: null,
    phone: null,
    linkedin: null,
    country: r.country,
    website: r.website,
    notes: clip(r.notes, NOTES_MAX),
    member: loaded?.member ?? null,
    memberOf: loaded ? "self" : null,
    timelineOf: null,
    timeline: loaded?.timeline ?? [],
    timelineTotal: loaded?.total ?? 0,
    people: people.rows.map((p) => ({ personId: p.id, name: p.name, title: p.title, email: p.email, phone: p.phone })),
  };
}

/**
 * One contact's profile and timeline, by member, person or company id (the first given is used).
 * A malformed id answers null without querying, as does an id that matches nothing.
 */
export function getProfile(db: ClientBase, target: Target, today: string, opts?: QueryOptions): Promise<Profile | null> {
  const valid = (v: string | undefined): v is string => typeof v === "string" && UUID_RE.test(v);
  const key = (["memberId", "personId", "orgId"] as const).find((k) => target?.[k] !== undefined);
  if (!key || !valid(target[key])) return Promise.resolve(null);
  const id = target[key] as string;
  return readOnly(
    db,
    async () => {
      if (key === "personId") return personProfile(db, id, today);
      if (key === "orgId") return companyProfile(db, id, today);
      const m = (await db.query("SELECT person_id, org_id FROM members WHERE id = $1", [id])).rows[0];
      if (!m) return null;
      return m.person_id ? personProfile(db, m.person_id, today) : companyProfile(db, m.org_id, today);
    },
    opts,
  );
}
