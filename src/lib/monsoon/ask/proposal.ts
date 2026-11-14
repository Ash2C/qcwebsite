// A proposal is a change the server itself offered and the user was shown. The server signs it
// (HMAC-SHA256 with the session secret); `act` only carries out a change whose signature verifies.
import { createHmac, timingSafeEqual } from "node:crypto";
import { estateByKey, type EstateKey } from "../estates";
import type { MemberKind } from "./queries";

export type Proposal =
  | {
      kind: "add_note";
      estate: EstateKey;
      memberId: string;
      memberKind: MemberKind;
      memberName: string;
      company: string | null;
      about: string | null;
      expires: number;
    }
  | {
      kind: "move_stage";
      estate: EstateKey;
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
      kind: "update_details";
      estate: EstateKey;
      target: { type: "person" | "company"; id: string };
      targetName: string; // name as read when proposed
      company: string | null; // person targets: company name when proposed
      changes: DetailChange[]; // at least one, at most 8, no duplicate fields
      logMemberId: string | null; // the member whose timeline gets the log entry, when one exists
      addsToPipeline: string | null; // a role key when confirming also adds the person to the pipeline
      expires: number;
    };

export type DetailField = "name" | "title" | "email" | "phone" | "linkedin" | "country" | "company" | "website";
export type DetailChange = { field: DetailField; from: string | null; to: string | null };

const PERSON_FIELDS: readonly string[] = ["name", "title", "email", "phone", "linkedin", "country", "company"];
const COMPANY_FIELDS: readonly string[] = ["website", "country"];
const MAX_DETAIL = 300;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `text` is the suggested note text; it is not signed because the user may edit it on the card. */
export type SignedProposal = { proposal: Proposal; signature: string; text?: string };

export const PROPOSAL_TTL_MS = 30 * 60 * 1000;

const MIN_SECRET = 32;
const PREFIX = "monsoon-proposal-v1:";
const COMMON = ["kind", "estate", "memberId", "memberKind", "memberName", "company", "about", "expires"];
const KEYS: Record<string, readonly string[]> = {
  add_note: COMMON,
  move_stage: [...COMMON, "fromStage", "toStage"],
  update_details: ["kind", "estate", "target", "targetName", "company", "changes", "logMemberId", "addsToPipeline", "expires"],
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
    if ((c.from?.length ?? 0) > MAX_DETAIL || (c.to?.length ?? 0) > MAX_DETAIL) return false;
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
  if (!estateByKey(o.estate)) return false;
  if (typeof o.expires !== "number" || !Number.isFinite(o.expires)) return false;
  if (o.kind === "update_details") return wellFormedDetails(o);
  if (!isString(o.memberId) || !isString(o.memberName)) return false;
  if (o.memberKind !== "person" && o.memberKind !== "company") return false;
  if (!isStringOrNull(o.company) || !isStringOrNull(o.about)) return false;
  if (typeof o.expires !== "number" || !Number.isFinite(o.expires)) return false;
  if (o.kind === "move_stage" && (!isString(o.fromStage) || !isString(o.toStage))) return false;
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
