// A proposal is a change the server itself offered and the user was shown. The server signs it
// (HMAC-SHA256 with the session secret); `act` only carries out a change whose signature verifies.
// Every proposal names the customer it was made for and the pipeline key, both inside the signature,
// so a proposal made for one customer can never be carried out for another.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { MemberKind } from "./queries";

/** Who a proposal is for: the customer's id (uuid) and the pipeline key. Never from a request body. */
export type Binding = { customer: string; estate: string };

export type Proposal =
  | {
      kind: "add_note";
      customer: string;
      estate: string;
      memberId: string;
      memberKind: MemberKind;
      memberName: string;
      company: string | null;
      about: string | null;
      expires: number;
    }
  | {
      kind: "move_stage";
      customer: string;
      estate: string;
      memberId: string;
      memberKind: MemberKind;
      memberName: string;
      company: string | null;
      about: string | null;
      fromStage: string;
      toStage: string;
      expires: number;
    }
  | {
      kind: "set_next_action";
      customer: string;
      estate: string;
      memberId: string;
      memberKind: MemberKind;
      memberName: string;
      company: string | null;
      about: string | null;
      fromAction: string | null;
      fromDate: string | null; // YYYY-MM-DD
      toAction: string | null; // null clears the next action (and its date)
      toDate: string | null;
      expires: number;
    }
  | {
      kind: "set_role";
      customer: string;
      estate: string;
      memberId: string;
      memberKind: MemberKind;
      memberName: string;
      company: string | null;
      about: string | null;
      fromRole: string;
      toRole: string;
      expires: number;
    }
  | {
      kind: "set_priority";
      customer: string;
      estate: string;
      memberId: string;
      memberKind: MemberKind;
      memberName: string;
      company: string | null;
      about: string | null;
      fromPriority: Priority | null;
      toPriority: Priority | null;
      expires: number;
    }
  | {
      kind: "update_details";
      customer: string;
      estate: string;
      target: { type: "person" | "company"; id: string };
      targetName: string; // name as read when proposed
      company: string | null; // person targets: company name when proposed
      changes: DetailChange[]; // at least one, at most 8, no duplicate fields
      logMemberId: string | null; // the member whose timeline gets the log entry, when one exists
      addsToPipeline: string | null; // a role key when confirming also adds the person to the pipeline
      expires: number;
    }
  | {
      kind: "apply_research";
      customer: string;
      estate: string;
      person: { id: string; name: string };
      company: { id: string; name: string } | null; // the person's company when researched
      identity: string; // 1..400 chars, why this is the right person
      findings: ResearchFinding[]; // 0..8
      summarySources: string[]; // 0..6 https URLs
      logMemberId: string | null;
      addsToPipeline: string | null;
      expires: number;
    };

export const PRIORITIES = ["high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];
const isPriorityOrNull = (v: unknown): v is Priority | null => v === null || (PRIORITIES as readonly unknown[]).includes(v);

export type ResearchField = "title" | "linkedin" | "country" | "email" | "phone" | "website";
export type ResearchFinding = {
  id: string; // "f1".."f8", unique in the proposal
  target: "person" | "company"; // "company" only for field "website"
  field: ResearchField;
  from: string | null; // value on file when researched
  to: string; // 1..300 chars
  source: string; // https URL, <= 500 chars
};

export type DetailField = "name" | "title" | "email" | "phone" | "linkedin" | "country" | "company" | "website";
export type DetailChange = { field: DetailField; from: string | null; to: string | null };

const PERSON_FIELDS: readonly string[] = ["name", "title", "email", "phone", "linkedin", "country", "company"];
const COMPANY_FIELDS: readonly string[] = ["website", "country"];
const MAX_DETAIL = 300;
export const MAX_NEXT_ACTION = 300;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_FROM = 2000;
const MAX_IDENTITY = 400;
const MAX_URL = 500;
const RESEARCH_FIELDS: readonly string[] = ["title", "linkedin", "country", "email", "phone", "website"];
const FINDING_ID_RE = /^f[1-8]$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ESTATE_RE = /^[a-z0-9-]{2,32}$/;

/** `text` is the suggested note text; it is not signed because the user may edit it on the card. */
export type SignedProposal = { proposal: Proposal; signature: string; text?: string };

export const PROPOSAL_TTL_MS = 30 * 60 * 1000;

const MIN_SECRET = 32;
const PREFIX = "monsoon-proposal-v1:";
const COMMON = ["kind", "customer", "estate", "memberId", "memberKind", "memberName", "company", "about", "expires"];
const KEYS: Record<string, readonly string[]> = {
  add_note: COMMON,
  move_stage: [...COMMON, "fromStage", "toStage"],
  set_priority: [...COMMON, "fromPriority", "toPriority"],
  set_role: [...COMMON, "fromRole", "toRole"],
  set_next_action: [...COMMON, "fromAction", "fromDate", "toAction", "toDate"],
  update_details: ["kind", "customer", "estate", "target", "targetName", "company", "changes", "logMemberId", "addsToPipeline", "expires"],
  apply_research: ["kind", "customer", "estate", "person", "company", "identity", "findings", "summarySources", "logMemberId", "addsToPipeline", "expires"],
};

function secret(): string {
  const s = process.env.MONSOON_SESSION_SECRET ?? "";
  if (s.length < MIN_SECRET) throw new Error("MONSOON_SESSION_SECRET is not configured");
  return s;
}

/** JSON with object keys sorted at every level, so key order never changes the signature. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function mac(proposal: unknown): Buffer {
  return createHmac("sha256", secret()).update(PREFIX + canonical(proposal)).digest();
}

export function signProposal(proposal: Proposal): string {
  return mac(proposal).toString("hex");
}

const isString = (v: unknown): v is string => typeof v === "string";
const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function wellFormedDetails(o: Record<string, unknown>): boolean {
  const target = o.target;
  if (!isObject(target) || Object.keys(target).length !== 2) return false;
  if (target.type !== "person" && target.type !== "company") return false;
  if (!isString(target.id) || !UUID_RE.test(target.id)) return false;
  if (!isString(o.targetName) || !isStringOrNull(o.company)) return false;
  if (o.logMemberId !== null && !(isString(o.logMemberId) && UUID_RE.test(o.logMemberId))) return false;
  if (!isStringOrNull(o.addsToPipeline)) return false;
  const allowed = target.type === "person" ? PERSON_FIELDS : COMPANY_FIELDS;
  const changes = o.changes;
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 8) return false;
  const seen = new Set<string>();
  for (const c of changes) {
    if (!isObject(c) || Object.keys(c).length !== 3) return false;
    if (!isString(c.field) || !allowed.includes(c.field) || seen.has(c.field)) return false;
    seen.add(c.field);
    if (!isStringOrNull(c.from) || !isStringOrNull(c.to) || c.from === c.to) return false;
    if (c.field === "name" && c.to === null) return false;
    // `from` is whatever is stored, so it only gets a bound that keeps the body small.
    if ((c.from?.length ?? 0) > MAX_FROM || (c.to?.length ?? 0) > MAX_DETAIL) return false;
  }
  return true;
}

function isHttpsUrl(v: unknown): boolean {
  if (!isString(v) || v.length > MAX_URL) return false;
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
}

function isRef(v: unknown): boolean {
  return isObject(v) && Object.keys(v).length === 2 && isString(v.id) && UUID_RE.test(v.id) && isString(v.name);
}

function wellFormedResearch(o: Record<string, unknown>): boolean {
  if (!isRef(o.person)) return false;
  if (o.company !== null && !isRef(o.company)) return false;
  if (!isString(o.identity) || o.identity.length < 1 || o.identity.length > MAX_IDENTITY) return false;
  if (o.logMemberId !== null && !(isString(o.logMemberId) && UUID_RE.test(o.logMemberId))) return false;
  if (!isStringOrNull(o.addsToPipeline)) return false;
  const { findings, summarySources } = o;
  if (!Array.isArray(findings) || findings.length > 8) return false;
  if (!Array.isArray(summarySources) || summarySources.length > 6 || !summarySources.every(isHttpsUrl)) return false;
  if (findings.length === 0 && summarySources.length === 0) return false;
  const ids = new Set<string>();
  const pairs = new Set<string>();
  for (const f of findings) {
    if (!isObject(f) || Object.keys(f).length !== 6) return false;
    if (!isString(f.id) || !FINDING_ID_RE.test(f.id) || ids.has(f.id)) return false;
    ids.add(f.id);
    if (f.target !== "person" && f.target !== "company") return false;
    if (!isString(f.field) || !RESEARCH_FIELDS.includes(f.field)) return false;
    if ((f.field === "website") !== (f.target === "company")) return false;
    if (f.target === "company" && o.company === null) return false;
    const pair = `${f.target}:${f.field}`;
    if (pairs.has(pair)) return false;
    pairs.add(pair);
    if (!isStringOrNull(f.from) || (f.from?.length ?? 0) > MAX_FROM) return false;
    if (!isString(f.to) || f.to.length < 1 || f.to.length > MAX_DETAIL || f.from === f.to) return false;
    if (!isHttpsUrl(f.source)) return false;
  }
  return true;
}

function wellFormed(p: unknown): p is Proposal {
  if (typeof p !== "object" || p === null || Array.isArray(p)) return false;
  const o = p as Record<string, unknown>;
  const keys = typeof o.kind === "string" && Object.hasOwn(KEYS, o.kind) ? KEYS[o.kind] : undefined;
  if (!keys) return false;
  const own = Object.keys(o);
  if (own.length !== keys.length || !keys.every((k) => Object.hasOwn(o, k))) return false;
  if (!isString(o.customer) || !UUID_RE.test(o.customer)) return false;
  if (!isString(o.estate) || !ESTATE_RE.test(o.estate)) return false;
  if (typeof o.expires !== "number" || !Number.isFinite(o.expires)) return false;
  if (o.kind === "update_details") return wellFormedDetails(o);
  if (o.kind === "apply_research") return wellFormedResearch(o);
  if (!isString(o.memberId) || !isString(o.memberName)) return false;
  if (o.memberKind !== "person" && o.memberKind !== "company") return false;
  if (!isStringOrNull(o.company) || !isStringOrNull(o.about)) return false;
  if (typeof o.expires !== "number" || !Number.isFinite(o.expires)) return false;
  if (o.kind === "move_stage" && (!isString(o.fromStage) || !isString(o.toStage))) return false;
  if (o.kind === "set_next_action") {
    const day = (v: unknown) => v === null || (isString(v) && DAY_RE.test(v));
    if (!isStringOrNull(o.fromAction) || !isStringOrNull(o.toAction) || !day(o.fromDate) || !day(o.toDate)) return false;
    if ((o.fromAction?.length ?? 0) > MAX_FROM) return false;
    if (o.toAction !== null && (o.toAction.trim() === "" || o.toAction.length > MAX_NEXT_ACTION)) return false;
    if (o.toAction === null && o.toDate !== null) return false;
    if (o.fromAction === o.toAction && o.fromDate === o.toDate) return false;
  }
  if (o.kind === "set_role" && (!isString(o.fromRole) || !isString(o.toRole) || o.fromRole === o.toRole)) return false;
  if (o.kind === "set_priority" && (!isPriorityOrNull(o.fromPriority) || !isPriorityOrNull(o.toPriority) || o.fromPriority === o.toPriority)) {
    return false;
  }
  return true;
}

export function verifyProposal(proposal: unknown, signature: unknown, nowMs: number): proposal is Proposal {
  try {
    if (!wellFormed(proposal)) return false;
    if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) return false;
    const expected = mac(proposal);
    const actual = Buffer.from(signature, "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
    return proposal.expires > nowMs;
  } catch {
    return false;
  }
}
