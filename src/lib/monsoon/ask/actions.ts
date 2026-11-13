// The two changes Ask can make. A propose function only reads; the write functions run in one
// transaction each and are called by `act` after a signed proposal has been verified.
import type { ClientBase } from "pg";
import type { EstateKey } from "../estates";
import { PROPOSAL_TTL_MS, signProposal, type Proposal, type SignedProposal } from "./proposal";
import { readOnly, vocabulary, type MemberKind } from "./queries";

export type Target = { memberId?: string; personId?: string };
export type ProposeResult = { ok: true; signed: SignedProposal } | { ok: false; reason: string };

const OWNER = "VF";
const MAX_NOTE = 2000;
const DUPLICATE_WINDOW = "2 minutes";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_CONTACT = "No such contact.";

type Resolved = {
  memberId: string;
  memberKind: MemberKind;
  memberName: string;
  company: string | null;
  about: string | null;
  stage: string;
};
type Resolution = { ok: true; member: Resolved } | { ok: false; reason: string };

const MEMBER_SELECT = `SELECT m.id, m.stage, o.name AS org_name, p.name AS person_name, po.name AS person_company
                         FROM members m
                         LEFT JOIN orgs o ON o.id = m.org_id
                         LEFT JOIN people p ON p.id = m.person_id
                         LEFT JOIN orgs po ON po.id = p.org_id`;

function resolved(row: Record<string, string | null>, about: string | null): Resolved {
  const person = row.person_name !== null;
  return {
    memberId: row.id as string,
    memberKind: person ? "person" : "company",
    memberName: (person ? row.person_name : row.org_name) as string,
    company: person ? row.person_company : null,
    about,
    stage: row.stage as string,
  };
}

/** Read-only: the member a change applies to, from a member id or a person id. */
async function resolve(db: ClientBase, target: Target): Promise<Resolution> {
  const { memberId, personId } = target;
  if (typeof memberId === "string") {
    if (!UUID_RE.test(memberId)) return { ok: false, reason: NO_CONTACT };
    return readOnly(db, async () => {
      const r = await db.query(`${MEMBER_SELECT} WHERE m.id = $1`, [memberId]);
      return r.rows[0] ? { ok: true, member: resolved(r.rows[0], null) } : { ok: false, reason: NO_CONTACT };
    });
  }
  if (typeof personId === "string") {
    if (!UUID_RE.test(personId)) return { ok: false, reason: NO_CONTACT };
    return readOnly(db, async () => {
      const person = await db.query("SELECT id, name, org_id FROM people WHERE id = $1", [personId]);
      const p = person.rows[0];
      if (!p) return { ok: false, reason: NO_CONTACT };
      const own = await db.query(`${MEMBER_SELECT} WHERE m.person_id = $1`, [personId]);
      if (own.rows[0]) return { ok: true, member: resolved(own.rows[0], null) };
      if (p.org_id) {
        const company = await db.query(`${MEMBER_SELECT} WHERE m.org_id = $1`, [p.org_id]);
        if (company.rows[0]) return { ok: true, member: resolved(company.rows[0], p.name) };
      }
      return {
        ok: false,
        reason: `${p.name} is on file but not on the pipeline, so there is no timeline to change. Capture can add them.`,
      };
    });
  }
  return { ok: false, reason: NO_CONTACT };
}

function sign(member: Resolved, estate: EstateKey, nowMs: number, extra?: { fromStage: string; toStage: string }): SignedProposal {
  const base = {
    estate,
    memberId: member.memberId,
    memberKind: member.memberKind,
    memberName: member.memberName,
    company: member.company,
    about: member.about,
    expires: nowMs + PROPOSAL_TTL_MS,
  };
  const proposal: Proposal = extra ? { kind: "move_stage", ...base, ...extra } : { kind: "add_note", ...base };
  return { proposal, signature: signProposal(proposal) };
}

export async function proposeNote(
  db: ClientBase,
  estate: EstateKey,
  target: Target,
  text: string,
  nowMs: number,
): Promise<ProposeResult> {
  const note = typeof text === "string" ? text.trim() : "";
  if (note.length < 1) return { ok: false, reason: "The note is empty." };
  if (note.length > MAX_NOTE) return { ok: false, reason: `The note is too long (limit ${MAX_NOTE} characters).` };
  const found = await resolve(db, target);
  if (!found.ok) return found;
  const signed = sign(found.member, estate, nowMs);
  const { about } = found.member;
  // The card shows this as the suggested text: about a person filed under a company, lead with their name.
  signed.text = about && !note.startsWith(about) ? `${about}: ${note}` : note;
  return { ok: true, signed };
}

export async function proposeStage(
  db: ClientBase,
  estate: EstateKey,
  target: Target,
  stage: string,
  nowMs: number,
): Promise<ProposeResult> {
  const found = await resolve(db, target);
  if (!found.ok) return found;
  const { stages } = await vocabulary(db);
  if (!stages.some((s) => s.key === stage)) {
    return { ok: false, reason: `Unknown stage. Stages are: ${stages.map((s) => s.key).join(", ")}.` };
  }
  if (stage === found.member.stage) return { ok: false, reason: `${found.member.memberName} is already in ${stage}.` };
  return { ok: true, signed: sign(found.member, estate, nowMs, { fromStage: found.member.stage, toStage: stage }) };
}

/** Run `fn` in one read-committed transaction; commit when it asks to, otherwise roll back. */
async function transaction<T>(db: ClientBase, fn: () => Promise<{ value: T; commit: boolean }>): Promise<T> {
  await db.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    await db.query("SET LOCAL statement_timeout = '10s'");
    const { value, commit } = await fn();
    await db.query(commit ? "COMMIT" : "ROLLBACK");
    return value;
  } catch (err) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
}

export function addNote(db: ClientBase, memberId: string, text: string): Promise<{ status: "added" | "duplicate" }> {
  return transaction<{ status: "added" | "duplicate" }>(db, async () => {
    // Serialise taps on the same member so a double tap on two connections cannot both insert.
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [memberId]);
    const dup = await db.query(
      `SELECT 1 FROM touches
        WHERE member_id = $1 AND kind = 'note' AND by_whom = $2 AND summary = $3
          AND at > clock_timestamp() - interval '${DUPLICATE_WINDOW}'
        LIMIT 1`,
      [memberId, OWNER, text],
    );
    if (dup.rows.length > 0) return { value: { status: "duplicate" as const }, commit: false };
    await db.query("INSERT INTO touches (member_id, kind, by_whom, summary) VALUES ($1, 'note', $2, $3)", [
      memberId,
      OWNER,
      text,
    ]);
    return { value: { status: "added" as const }, commit: true };
  });
}

type MoveStatus = "moved" | "already" | "changed" | "missing";
type MoveResult = { status: MoveStatus; stage: string | null };

export function moveStage(
  db: ClientBase,
  memberId: string,
  fromStage: string,
  toStage: string,
): Promise<MoveResult> {
  return transaction<MoveResult>(db, async () => {
    const found = await db.query("SELECT stage FROM members WHERE id = $1 FOR UPDATE", [memberId]);
    if (found.rows.length === 0) return { value: { status: "missing" as const, stage: null }, commit: false };
    const current: string = found.rows[0].stage;
    if (current === toStage) return { value: { status: "already" as const, stage: current }, commit: false };
    if (current !== fromStage) return { value: { status: "changed" as const, stage: current }, commit: false };
    // The stage trigger writes the timeline entry; here it only gets the mover's name, as Crm.set_stage does.
    await db.query("UPDATE members SET stage = $1 WHERE id = $2", [toStage, memberId]);
    await db.query(
      `UPDATE touches SET by_whom = $2
        WHERE id = (SELECT id FROM touches WHERE member_id = $1 AND kind = 'stage'
                     ORDER BY at DESC, id DESC LIMIT 1)`,
      [memberId, OWNER],
    );
    return { value: { status: "moved" as const, stage: toStage }, commit: true };
  });
}
