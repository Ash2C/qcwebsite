// Thin client for the /api/monsoon routes. Every call resolves with { status, body }; a
// non-2xx status is data, not an exception. Only a network failure rejects, and so does a
// request that runs past its time limit (it is aborted): callers treat both alike.
import type { CardFields, CardKind } from "@/lib/monsoon/extract";
import type { CardMatch } from "@/lib/monsoon/match";
import type { CaptureResult } from "@/lib/monsoon/capture";
import type { RefineInput, RefineOutput } from "@/lib/monsoon/refine";
import type { AskMessage, AskResult } from "@/lib/monsoon/ask/loop";
import type { ContactHit, Profile } from "@/lib/monsoon/contacts";
import type { SignedProposal } from "@/lib/monsoon/ask/proposal";
import type { ClaudeKeyState } from "@/lib/monsoon/accounts/claude-key";
import { claudeStatusOf, reportClaudeStatus, type ClaudeChipStatus } from "./claudeStatus";

export type EstateInfo = {
  key: string;
  label: string;
  defaultRole: string;
  available: boolean;
  roles: { key: string; label: string }[];
};

export type SaveBody = {
  estate: string;
  captureId: string;
  role: string;
  fields: {
    name: string;
    title?: string;
    org?: string;
    email?: string;
    phone?: string;
    linkedin?: string;
    notes?: string;
  };
  extracted?: CardFields;
  newOrg?: boolean;
  samePerson?: string | false;
  kind?: CardKind;
  batch?: boolean;
};

export type ApiResult<T> = { status: number; body: T };

// How long each call may take before it is aborted, in milliseconds. A little over each route's
// own limit, so the server answers first when it can.
const TIMEOUT_MS = {
  quick: 15_000, // signIn, loadEstates
  standard: 35_000, // saveCard, refineCard, actOnCrm, proposeChange
  upload: 90_000, // readCards: the photo upload on a weak connection counts against the limit
  ask: 70_000, // askCrm
  research: 70_000, // researchContact: one bounded web search
} as const;

// The one place a request is made: every call gets a timeout signal. Older iOS Safari has no
// AbortSignal.timeout, so there an AbortController aborted by a timer does the same job (the timer
// is cleared once the request settles).
async function request(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  if (typeof AbortSignal.timeout === "function") {
    return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
    timeoutMs,
  );
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function parse<T>(response: Response): Promise<ApiResult<T>> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body: body as T };
}

// For the routes that call Claude: tells the header chip what the result says about the key.
function noted<T>(res: ApiResult<T>, worked = true): ApiResult<T> {
  const status = claudeStatusOf(res, worked);
  if (status) reportClaudeStatus(status);
  return res;
}

export async function signIn(
  code: string,
  passcode: string,
): Promise<ApiResult<{ ok: true } | { error: string }>> {
  return parse(
    await request(
      "/api/monsoon/session",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, passcode }) },
      TIMEOUT_MS.quick,
    ),
  );
}

export async function loadEstates(): Promise<
  ApiResult<
    | { estates: EstateInfo[]; person?: { name: string }; customer?: { name: string }; claude?: { status: ClaudeChipStatus } }
    | { error: string }
  >
> {
  return parse(await request("/api/monsoon/estates", { cache: "no-store" }, TIMEOUT_MS.quick));
}

export async function readCards(
  image: Blob,
  estate: string,
): Promise<ApiResult<{ cards: CardFields[]; matches?: CardMatch[] | null } | { error: string }>> {
  const form = new FormData();
  form.append("image", image, "card.jpg");
  form.append("estate", estate);
  return noted(await parse(await request("/api/monsoon/read", { method: "POST", body: form }, TIMEOUT_MS.upload)));
}

export async function saveCard(
  body: SaveBody,
): Promise<ApiResult<CaptureResult | { error: string }>> {
  return parse(
    await request(
      "/api/monsoon/save",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      TIMEOUT_MS.standard,
    ),
  );
}

export async function refineCard(
  body: RefineInput,
): Promise<ApiResult<RefineOutput | { error: string }>> {
  return noted(
    await parse(
      await request(
        "/api/monsoon/refine",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
        TIMEOUT_MS.standard,
      ),
    ),
  );
}

export async function askCrm(body: {
  estate: string;
  today: string;
  messages: AskMessage[];
}): Promise<ApiResult<AskResult | { error: string }>> {
  return noted(
    await parse(
      await request(
        "/api/monsoon/ask",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
        TIMEOUT_MS.ask,
      ),
    ),
  );
}

export async function actOnCrm(body: {
  estate: string;
  proposal: SignedProposal["proposal"];
  signature: string;
  text?: string;
  ticked?: string[];
}): Promise<ApiResult<{ status: string; message: string } | { error: string }>> {
  return parse(
    await request(
      "/api/monsoon/act",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      TIMEOUT_MS.standard,
    ),
  );
}

export type ProposeBody = {
  estate: string;
  kind: "add_note" | "move_stage" | "update_details";
  target: { memberId?: string; personId?: string; orgId?: string };
  text?: string;
  stage?: string;
  changes?: Record<string, string>; // field -> new value; an empty string clears the field
  newCompany?: boolean;
};

export async function proposeChange(
  body: ProposeBody,
): Promise<ApiResult<{ ok: true; signed: SignedProposal } | { ok: false; reason: string } | { error: string }>> {
  return parse(
    await request(
      "/api/monsoon/propose",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      TIMEOUT_MS.standard,
    ),
  );
}

export async function searchContacts(
  estate: string,
  q: string,
): Promise<ApiResult<{ contacts: ContactHit[] } | { error: string }>> {
  const params = new URLSearchParams({ estate, q });
  return parse(await request(`/api/monsoon/contacts?${params}`, { cache: "no-store" }, TIMEOUT_MS.quick));
}

export async function loadProfile(
  estate: string,
  target: { memberId?: string; personId?: string; orgId?: string },
  today: string,
): Promise<ApiResult<{ profile: Profile } | { error: string }>> {
  const params = new URLSearchParams({ estate, today });
  if (target.memberId) params.set("memberId", target.memberId);
  if (target.personId) params.set("personId", target.personId);
  if (target.orgId) params.set("orgId", target.orgId);
  return parse(await request(`/api/monsoon/contact?${params}`, { cache: "no-store" }, TIMEOUT_MS.quick));
}

export type ResearchResponse =
  | { status: "findings"; signed: SignedProposal; summary: string }
  | { status: "none"; message: string };

export async function researchContact(body: {
  estate: string;
  memberId?: string;
  personId?: string;
}): Promise<ApiResult<ResearchResponse | { error: string } | null>> {
  const res: ApiResult<ResearchResponse | { error: string } | null> = await parse(
    await request(
      "/api/monsoon/research",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      TIMEOUT_MS.research,
    ),
  );
  // A "none" answer can come back before Claude is asked (nothing to search on): it proves nothing.
  return noted(res, res.body !== null && "status" in res.body && res.body.status === "findings");
}

type KeyReply = ApiResult<{ key: ClaudeKeyState } | { error: string }>;
const keyPost = async (body: Record<string, unknown>): Promise<KeyReply> =>
  parse(
    await request(
      "/api/monsoon/claude-key",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      TIMEOUT_MS.standard,
    ),
  );

/** The account's Claude key state (never the key). */
export async function loadClaudeKey(): Promise<KeyReply> {
  return parse(await request("/api/monsoon/claude-key", { cache: "no-store" }, TIMEOUT_MS.quick));
}

/** Tests the key on file with one tiny real call. */
export function testClaudeKey(): Promise<KeyReply> {
  return keyPost({ test: true });
}

/** Tests a new key and replaces the one on file only if Claude accepts it. */
export function saveClaudeKey(claudeKey: string): Promise<KeyReply> {
  return keyPost({ claudeKey });
}
