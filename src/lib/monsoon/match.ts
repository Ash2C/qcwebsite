// Match before save: for each person read from a photo, is there already someone like them in the
// CRM? Read-only. One `readOnly` transaction for the whole batch and one set-based statement (arrays
// of name keys and emails, `= ANY`), not a query per card; the verdict per card is worked out here.
import type { ClientBase } from "pg";
import { readOnly, type MemberRef, type QueryOptions } from "./ask/queries";
import { nameKey } from "./rules";

export type MatchCandidate = {
  personId: string;
  name: string;
  title: string | null;
  company: string | null;
  email: string | null;
  member: MemberRef | null; // own membership, else the company's, else null
  memberOf: "self" | "company" | null;
  by: "name_company" | "email" | "name"; // why this person matched
  nameAgrees: boolean; // same name key as the card (false only for an email match under another name)
};
export type CardMatch = { match: "none" | "exact" | "same_name" | "several"; candidates: MatchCandidate[] };

const CANDIDATE_MAX = 5;

type Row = {
  id: string;
  name: string;
  name_key: string;
  title: string | null;
  email: string | null;
  email_lc: string | null;
  created_at: Date | string | null;
  company: string | null;
  org_key: string | null;
  own_id: string | null;
  own_role: string | null;
  own_stage: string | null;
  co_id: string | null;
  co_role: string | null;
  co_stage: string | null;
};

const stamp = (v: Date | string | null): number => (v === null ? Number.POSITIVE_INFINITY : new Date(v).getTime());
const byAge = (a: Row, b: Row): number => stamp(a.created_at) - stamp(b.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function candidate(r: Row, by: MatchCandidate["by"], key: string): MatchCandidate {
  const own: MemberRef | null = r.own_id
    ? { memberId: r.own_id, memberKind: "person", role: r.own_role as string, stage: r.own_stage as string }
    : null;
  const viaCompany: MemberRef | null = r.co_id
    ? { memberId: r.co_id, memberKind: "company", role: r.co_role as string, stage: r.co_stage as string }
    : null;
  return {
    personId: r.id,
    name: r.name,
    title: r.title,
    company: r.company,
    email: r.email,
    member: own ?? viaCompany,
    memberOf: own ? "self" : viaCompany ? "company" : null,
    by,
    nameAgrees: r.name_key === key,
  };
}

function verdict(card: { name: string; org: string; email: string }, rows: Row[]): CardMatch {
  const key = nameKey(card.name ?? "");
  if (key === "") return { match: "none", candidates: [] };
  const orgKey = nameKey(card.org ?? "");
  const email = (card.email ?? "").trim().toLowerCase();

  const sameName = rows.filter((r) => r.name_key === key);
  const viaEmail = email === "" ? [] : rows.filter((r) => r.email_lc === email);
  const emailIds = new Set(viaEmail.map((r) => r.id));
  const viaCompany = orgKey === "" ? [] : sameName.filter((r) => r.org_key === orgKey && !emailIds.has(r.id));

  const exact = [
    ...[...viaEmail].sort(byAge).map((r) => candidate(r, "email", key)),
    ...[...viaCompany].sort(byAge).map((r) => candidate(r, "name_company", key)),
  ];
  if (exact.length > 0) {
    return { match: exact.length === 1 ? "exact" : "several", candidates: exact.slice(0, CANDIDATE_MAX) };
  }
  const named = [...sameName].sort(byAge).map((r) => candidate(r, "name", key));
  if (named.length === 0) return { match: "none", candidates: [] };
  return { match: named.length === 1 ? "same_name" : "several", candidates: named.slice(0, CANDIDATE_MAX) };
}

/** One verdict per card, same order. Never writes; never throws for odd input (blank, long, `%`). */
export function matchCards(
  db: ClientBase,
  cards: { name: string; org: string; email: string }[],
  opts?: QueryOptions,
): Promise<CardMatch[]> {
  const keys = cards.map((c) => nameKey(c.name ?? "")).filter((k) => k !== "");
  const emails = cards.map((c) => (c.email ?? "").trim().toLowerCase()).filter((e) => e !== "");
  if (keys.length === 0) return Promise.resolve(cards.map(() => ({ match: "none" as const, candidates: [] })));
  return readOnly(
    db,
    async () => {
      const found = await db.query(
        `SELECT p.id, p.name, p.name_key, p.title, p.email, lower(btrim(p.email)) AS email_lc, p.created_at,
                po.name AS company, po.name_key AS org_key,
                own.id AS own_id, own.role AS own_role, own.stage AS own_stage,
                cm.id AS co_id, cm.role AS co_role, cm.stage AS co_stage
           FROM people p
           LEFT JOIN orgs po ON po.id = p.org_id
           LEFT JOIN members own ON own.person_id = p.id
           LEFT JOIN members cm ON cm.org_id = p.org_id
          WHERE p.name_key = ANY($1::text[]) OR lower(btrim(p.email)) = ANY($2::text[])`,
        [keys, emails],
      );
      return cards.map((c) => verdict(c, found.rows as Row[]));
    },
    opts,
  );
}
