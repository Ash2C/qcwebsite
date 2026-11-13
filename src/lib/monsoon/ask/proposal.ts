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
    };

/** `text` is the suggested note text; it is not signed because the user may edit it on the card. */
export type SignedProposal = { proposal: Proposal; signature: string; text?: string };

export const PROPOSAL_TTL_MS = 30 * 60 * 1000;

const MIN_SECRET = 32;
const PREFIX = "monsoon-proposal-v1:";
const COMMON = ["kind", "estate", "memberId", "memberKind", "memberName", "company", "about", "expires"];
const KEYS: Record<string, readonly string[]> = {
  add_note: COMMON,
  move_stage: [...COMMON, "fromStage", "toStage"],
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

function wellFormed(p: unknown): p is Proposal {
  if (typeof p !== "object" || p === null || Array.isArray(p)) return false;
  const o = p as Record<string, unknown>;
  const keys = typeof o.kind === "string" && Object.hasOwn(KEYS, o.kind) ? KEYS[o.kind] : undefined;
  if (!keys) return false;
  const own = Object.keys(o);
  if (own.length !== keys.length || !keys.every((k) => Object.hasOwn(o, k))) return false;
  if (!estateByKey(o.estate)) return false;
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
