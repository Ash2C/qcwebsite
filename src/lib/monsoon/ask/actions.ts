// The two changes Ask can make. A propose function only reads; the write functions run in one
// transaction each and are called by `act` after a signed proposal has been verified.
import type { ClientBase } from "pg";
import {
  MAX_NEXT_ACTION,
  PROPOSAL_TTL_MS,
  signProposal,
  type Binding,
  type Priority,
  type Proposal,
  type SignedProposal,
} from "./proposal";
import { readOnly, vocabulary, type MemberKind } from "./queries";

export type Target = { memberId?: string; personId?: string };
export type ProposeResult = { ok: true; signed: SignedProposal } | { ok: false; reason: string };

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
  role: string;
  priority: Priority | null;
  nextAction: string | null;
  nextDate: string | null;
};
type Resolution = { ok: true; member: Resolved } | { ok: false; reason: string };

const MEMBER_SELECT = `SELECT m.id, m.stage, m.role, m.priority, m.next_action, m.next_action_date::text AS next_action_date, o.name AS org_name, p.name AS person_name, po.name AS person_company
                         FROM members m
                         LEFT JOIN orgs o ON o.id = m.org_id
                         LEFT JOIN people p ON p.id = m.person_id
                         LEFT JOIN orgs po ON po.id = p.org_id`;

/** A member's next action as stored, normalised: a blank action is none, and none has no date. */
function nextOf(action: unknown, date: unknown): { nextAction: string | null; nextDate: string | null } {
  const nextAction = typeof action === "string" && action.trim() !== "" ? action : null;
  return { nextAction, nextDate: nextAction && date ? String(date).slice(0, 10) : null };
}

function resolved(row: Record<string, string | null>, about: string | null): Resolved {
  const person = row.person_name !== null;
  return {
    memberId: row.id as string,
    memberKind: person ? "person" : "company",
    memberName: (person ? row.person_name : row.org_name) as string,
    company: person ? row.person_company : null,
    about,
    stage: row.stage as string,
    role: row.role as string,
    priority: (row.priority as Priority | null) ?? null,
    ...nextOf(row.next_action, row.next_action_date),
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

function sign(
  member: Resolved,
  bind: Binding,
  nowMs: number,
  extra?:
    | { fromStage: string; toStage: string }
    | { fromRole: string; toRole: string }
    | { fromAction: string | null; fromDate: string | null; toAction: string | null; toDate: string | null }
    | { fromPriority: Priority | null; toPriority: Priority | null },
): SignedProposal {
  const base = {
    customer: bind.customer,
    estate: bind.estate,
    memberId: member.memberId,
    memberKind: member.memberKind,
    memberName: member.memberName,
    company: member.company,
    about: member.about,
    expires: nowMs + PROPOSAL_TTL_MS,
  };
  const proposal: Proposal = !extra
    ? { kind: "add_note", ...base }
    : "toStage" in extra
      ? { kind: "move_stage", ...base, ...extra }
      : "toAction" in extra
        ? { kind: "set_next_action", ...base, ...extra }
      : "toRole" in extra
        ? { kind: "set_role", ...base, ...extra }
        : { kind: "set_priority", ...base, ...extra };
  return { proposal, signature: signProposal(proposal) };
}

/** True when `text` begins with `name` (any case) followed by something other than a letter, or by nothing. */
function startsWithName(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
  return new RegExp(`^${escaped}(?![\\p{L}])`, "iu").test(text);
}

export async function proposeNote(
  db: ClientBase,
  bind: Binding,
  target: Target,
  text: string,
  nowMs: number,
): Promise<ProposeResult> {
  const note = typeof text === "string" ? text.trim() : "";
  if (note.length < 1) return { ok: false, reason: "The note is empty." };
  if (note.length > MAX_NOTE) return { ok: false, reason: `The note is too long (limit ${MAX_NOTE} characters).` };
  const found = await resolve(db, target);
  if (!found.ok) return found;
  const signed = sign(found.member, bind, nowMs);
  const { about } = found.member;
  // The card shows this as the suggested text: about a person filed under a company, lead with their name.
  signed.text = about && !startsWithName(note, about) ? `${about}: ${note}` : note;
  return { ok: true, signed };
}

export async function proposeStage(
  db: ClientBase,
  bind: Binding,
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
  return { ok: true, signed: sign(found.member, bind, nowMs, { fromStage: found.member.stage, toStage: stage }) };
}

/** True for a YYYY-MM-DD string that names a real calendar day. */
function realDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === value;
}

/**
 * The next action for the member a contact belongs to, with an optional due date. Blank text
 * clears it, and its date with it.
 */
export async function proposeNextAction(
  db: ClientBase,
  bind: Binding,
  target: Target,
  action: string,
  date: string | null,
  nowMs: number,
): Promise<ProposeResult> {
  const text = typeof action === "string" ? action.trim() : "";
  if (text.length > MAX_NEXT_ACTION) return { ok: false, reason: `The next action is too long (limit ${MAX_NEXT_ACTION} characters).` };
  if (date !== null && !realDay(date)) return { ok: false, reason: "That date is not a real day." };
  const found = await resolve(db, target);
  if (!found.ok) return found;
  const toAction = text === "" ? null : text;
  const toDate = toAction ? date : null;
  const { nextAction, nextDate } = found.member;
  if (toAction === nextAction && toDate === nextDate) return { ok: false, reason: "Nothing to change." };
  return { ok: true, signed: sign(found.member, bind, nowMs, { fromAction: nextAction, fromDate: nextDate, toAction, toDate }) };
}

/** A different contact type (role) for the member a contact belongs to; it must be one of the estate's roles. */
export async function proposeRole(db: ClientBase, bind: Binding, target: Target, role: string, nowMs: number): Promise<ProposeResult> {
  const found = await resolve(db, target);
  if (!found.ok) return found;
  const { roles } = await vocabulary(db);
  if (!roles.some((r) => r.key === role)) {
    return { ok: false, reason: `Unknown contact type. Types are: ${roles.map((r) => r.key).join(", ")}.` };
  }
  if (role === found.member.role) return { ok: false, reason: `${found.member.memberName} is already ${role.replace(/_/g, " ")}.` };
  return { ok: true, signed: sign(found.member, bind, nowMs, { fromRole: found.member.role, toRole: role }) };
}

/** A priority (high, medium or low) for the member a contact belongs to; null clears it. */
export async function proposePriority(
  db: ClientBase,
  bind: Binding,
  target: Target,
  to: Priority | null,
  nowMs: number,
): Promise<ProposeResult> {
  const found = await resolve(db, target);
  if (!found.ok) return found;
  const { memberName, priority } = found.member;
  if (to === priority) {
    return { ok: false, reason: to ? `${memberName} is already ${to} priority.` : `${memberName} has no priority set.` };
  }
  return { ok: true, signed: sign(found.member, bind, nowMs, { fromPriority: priority, toPriority: to }) };
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

export function addNote(db: ClientBase, memberId: string, text: string, owner: string): Promise<{ status: "added" | "duplicate" }> {
  return transaction<{ status: "added" | "duplicate" }>(db, async () => {
    // Serialise taps on the same member so a double tap on two connections cannot both insert.
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [memberId]);
    const dup = await db.query(
      `SELECT 1 FROM touches
        WHERE member_id = $1 AND kind = 'note' AND by_whom = $2 AND summary = $3
          AND at > clock_timestamp() - interval '${DUPLICATE_WINDOW}'
        LIMIT 1`,
      [memberId, owner, text],
    );
    if (dup.rows.length > 0) return { value: { status: "duplicate" as const }, commit: false };
    await db.query("INSERT INTO touches (member_id, kind, by_whom, summary) VALUES ($1, 'note', $2, $3)", [
      memberId,
      owner,
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
  owner: string,
): Promise<MoveResult> {
  return transaction<MoveResult>(db, async () => {
    const found = await db.query("SELECT stage FROM members WHERE id = $1 FOR UPDATE", [memberId]);
    if (found.rows.length === 0) return { value: { status: "missing" as const, stage: null }, commit: false };
    const current: string = found.rows[0].stage;
    if (current === toStage) return { value: { status: "already" as const, stage: current }, commit: false };
    if (current !== fromStage) return { value: { status: "changed" as const, stage: current }, commit: false };
    // The stage trigger writes the timeline entry; here it only gets the mover's name, as Crm.set_stage does.
    // The summary match ties the stamp to this move, so an older entry is never restamped.
    await db.query("UPDATE members SET stage = $1 WHERE id = $2", [toStage, memberId]);
    await db.query(
      `UPDATE touches SET by_whom = $2
        WHERE id = (SELECT id FROM touches
                     WHERE member_id = $1 AND kind = 'stage' AND summary = $3::text || ' -> ' || $4::text
                     ORDER BY at DESC, id DESC LIMIT 1)`,
      [memberId, owner, fromStage, toStage],
    );
    return { value: { status: "moved" as const, stage: toStage }, commit: true };
  });
}

type PriorityStatus = "set" | "already" | "changed" | "missing";
type PriorityResult = { status: PriorityStatus; priority: Priority | null };

/**
 * Sets a member's priority when it still is what the proposal saw. The change is logged on the
 * timeline as a system entry (so it does not count as contact), with who made it.
 */
export function setPriority(
  db: ClientBase,
  memberId: string,
  from: Priority | null,
  to: Priority | null,
  owner: string,
): Promise<PriorityResult> {
  return transaction<PriorityResult>(db, async () => {
    const found = await db.query("SELECT priority FROM members WHERE id = $1 FOR UPDATE", [memberId]);
    if (found.rows.length === 0) return { value: { status: "missing" as const, priority: null }, commit: false };
    const current: Priority | null = found.rows[0].priority ?? null;
    if (current === to) return { value: { status: "already" as const, priority: current }, commit: false };
    if (current !== from) return { value: { status: "changed" as const, priority: current }, commit: false };
    await db.query("UPDATE members SET priority = $1 WHERE id = $2", [to, memberId]);
    await db.query("INSERT INTO touches (member_id, kind, by_whom, summary) VALUES ($1, 'system', $2, $3)", [
      memberId,
      owner,
      `Priority: ${from ?? "(none)"} → ${to ?? "(none)"}`,
    ]);
    return { value: { status: "set" as const, priority: to }, commit: true };
  });
}

type RoleStatus = "set" | "already" | "changed" | "missing";
type RoleResult = { status: RoleStatus; role: string | null };

/**
 * Sets a member's contact type (role) when it still is what the proposal saw. Logged on the
 * timeline as a system entry, with who made the change.
 */
export function setRole(db: ClientBase, memberId: string, from: string, to: string, owner: string): Promise<RoleResult> {
  return transaction<RoleResult>(db, async () => {
    const found = await db.query("SELECT role FROM members WHERE id = $1 FOR UPDATE", [memberId]);
    if (found.rows.length === 0) return { value: { status: "missing" as const, role: null }, commit: false };
    const current: string = found.rows[0].role;
    if (current === to) return { value: { status: "already" as const, role: current }, commit: false };
    if (current !== from) return { value: { status: "changed" as const, role: current }, commit: false };
    await db.query("UPDATE members SET role = $1 WHERE id = $2", [to, memberId]);
    await db.query("INSERT INTO touches (member_id, kind, by_whom, summary) VALUES ($1, 'system', $2, $3)", [
      memberId,
      owner,
      `Type: ${from} → ${to}`,
    ]);
    return { value: { status: "set" as const, role: to }, commit: true };
  });
}

type NextStatus = "set" | "already" | "changed" | "missing";
type Next = { action: string | null; date: string | null };

/**
 * Sets a member's next action and its due date when they still are what the proposal saw. Logged
 * on the timeline as a system entry (so it does not count as contact), with who made the change.
 */
export function setNextAction(db: ClientBase, memberId: string, from: Next, to: Next, owner: string): Promise<{ status: NextStatus }> {
  return transaction<{ status: NextStatus }>(db, async () => {
    const found = await db.query(
      "SELECT next_action, next_action_date::text AS next_action_date FROM members WHERE id = $1 FOR UPDATE",
      [memberId],
    );
    if (found.rows.length === 0) return { value: { status: "missing" as const }, commit: false };
    const now = nextOf(found.rows[0].next_action, found.rows[0].next_action_date);
    const same = (n: Next) => n.action === now.nextAction && n.date === now.nextDate;
    if (same(to)) return { value: { status: "already" as const }, commit: false };
    if (!same(from)) return { value: { status: "changed" as const }, commit: false };
    await db.query("UPDATE members SET next_action = $1, next_action_date = $2::date WHERE id = $3", [to.action, to.date, memberId]);
    await db.query("INSERT INTO touches (member_id, kind, by_whom, summary) VALUES ($1, 'system', $2, $3)", [
      memberId,
      owner,
      to.action ? `Next action: ${to.action}${to.date ? ` (due ${to.date})` : ""}` : "Next action cleared",
    ]);
    return { value: { status: "set" as const }, commit: true };
  });
}
