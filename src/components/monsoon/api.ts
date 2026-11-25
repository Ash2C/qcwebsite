// Thin client for the /api/monsoon routes. Every call resolves with { status, body }; a
// non-2xx status is data, not an exception. Only a network failure rejects, and so does a
// request that runs past its time limit (it is aborted): callers treat both alike.
import type { CardFields, CardKind } from "@/lib/monsoon/extract";
import type { CardMatch } from "@/lib/monsoon/match";
import type { CaptureResult } from "@/lib/monsoon/capture";
import type { RefineInput, RefineOutput } from "@/lib/monsoon/refine";
import type { AskMessage, AskResult } from "@/lib/monsoon/ask/loop";
import type { Profile } from "@/lib/monsoon/contacts";
import type { SiftHit, Sort } from "@/lib/monsoon/sift";
import type { SignedProposal } from "@/lib/monsoon/ask/proposal";
import type { ClaudeKeyState } from "@/lib/monsoon/accounts/claude-key";
import type { GranolaKeyState } from "@/lib/monsoon/accounts/granola-key";
import type { PageInput, UserPage } from "@/lib/monsoon/accounts/profile";
import type { SignupRow } from "@/lib/monsoon/accounts/signups";
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
  quick: 15_000, // signIn, loadEstates, loadUserPage, loadGranolaKey
  standard: 35_000, // saveCard, refineCard, actOnCrm, proposeChange, saveUserPage, addUserNote, the Granola key posts
  upload: 90_000, // readCards: the photo upload on a weak connection counts against the limit
  ask: 70_000, // askCrm
  research: 70_000, // researchContact: one bounded web search
  approve: 70_000, // actOnRequest("approve"): builds a CRM in the shared database
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
    | { estates: EstateInfo[]; person?: { id: string; name: string }; customer?: { name: string }; claude?: { status: ClaudeChipStatus } }
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
  /** The contact open on screen, by id only; the server reads the rest itself. */
  viewing?: { memberId?: string; personId?: string; orgId?: string };
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
  kind: "add_note" | "move_stage" | "set_next_action" | "set_priority" | "set_role" | "update_details";
  target: { memberId?: string; personId?: string; orgId?: string };
  text?: string;
  stage?: string;
  priority?: "high" | "medium" | "low" | null; // set_priority: the new priority; null clears it
  role?: string; // set_role: the new contact type's key
  action?: string; // set_next_action: the next action's text; blank clears it
  date?: string | null; // set_next_action: its due date (YYYY-MM-DD), or null for none
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

// The phone's local date, never the UTC one (due dates are judged against it).
function localDay(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The Contacts list: a search when `q` has text, else the pipeline; `sift` filters and orders it. */
export async function searchContacts(
  estate: string,
  q: string,
  sift?: { high: boolean; sort: Sort },
): Promise<ApiResult<{ contacts: SiftHit[]; total?: number } | { error: string }>> {
  const params = new URLSearchParams({ estate, q, today: localDay() });
  if (sift?.high) params.set("high", "1");
  if (sift && sift.sort !== "recent") params.set("sort", sift.sort);
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

type GranolaReply = ApiResult<{ key: GranolaKeyState } | { error: string }>;
const granolaPost = async (body: Record<string, unknown>): Promise<GranolaReply> =>
  parse(
    await request(
      "/api/monsoon/granola-key",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      TIMEOUT_MS.standard,
    ),
  );

/** The signed-in person's own Granola key state (never the key). */
export async function loadGranolaKey(): Promise<GranolaReply> {
  return parse(await request("/api/monsoon/granola-key", { cache: "no-store" }, TIMEOUT_MS.quick));
}

/** Tests the Granola key on file with one real call. */
export function testGranolaKey(): Promise<GranolaReply> {
  return granolaPost({ test: true });
}

/** Tests a new Granola key and stores it only if Granola accepts it. */
export function saveGranolaKey(granolaKey: string): Promise<GranolaReply> {
  return granolaPost({ granolaKey });
}

/** Removes the person's Granola key. */
export function disconnectGranolaKey(): Promise<GranolaReply> {
  return granolaPost({ disconnect: true });
}

export type SignInOptions = { google: boolean; signups: boolean };
const NO_GOOGLE: SignInOptions = { google: false, signups: false };

/**
 * Whether Sign in with Google is on, and whether new sign-ups can be taken. Asked without a
 * session, by the passcode screen. Never rejects: anything but a clear yes is "off", which leaves
 * the passcode screen exactly as it is without Google.
 */
export async function loadSignInOptions(): Promise<SignInOptions> {
  try {
    const res = await request("/api/monsoon/version", { cache: "no-store" }, TIMEOUT_MS.quick);
    if (res.status !== 200) return NO_GOOGLE;
    const body = (await res.json()) as { google?: unknown; signups?: unknown } | null;
    return { google: body?.google === true, signups: body?.google === true && body?.signups === true };
  } catch {
    return NO_GOOGLE;
  }
}

/** One sign-up request as the Requests screen sees it: never the Google id. */
export type SignupRequest = Omit<SignupRow, "sub">;
export type RequestAction = "approve" | "decline" | "reopen";

/** Everyone who has asked to join, waiting first. Only the approver gets an answer; others a 404. */
export async function loadRequests(): Promise<ApiResult<{ requests: SignupRequest[]; configured: boolean } | { error: string }>> {
  return parse(await request("/api/monsoon/requests", { cache: "no-store" }, TIMEOUT_MS.quick));
}

/** Approves, declines or re-opens one request. Approving builds the person's CRM, so it may take a minute. */
export async function actOnRequest(id: string, action: RequestAction): Promise<ApiResult<{ ok: true } | { error: string } | null>> {
  return parse(
    await request(
      "/api/monsoon/requests",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action }) },
      action === "approve" ? TIMEOUT_MS.approve : TIMEOUT_MS.standard,
    ),
  );
}

/** With the page, on a read only: whether Google sign-in is on, whether this person has linked it, and whether they answer requests. */
type PageExtras = { googleConfigured?: boolean; googleLinked?: boolean; canApprove?: boolean };
type PageReply = ApiResult<({ page: UserPage } & PageExtras) | { error: string }>;

/** The signed-in person's own page for one CRM. */
export async function loadUserPage(estate: string): Promise<PageReply> {
  return parse(await request(`/api/monsoon/me?${new URLSearchParams({ estate })}`, { cache: "no-store" }, TIMEOUT_MS.quick));
}

/** Saves the page's fields and returns the page as it now stands. */
export async function saveUserPage(estate: string, input: PageInput): Promise<PageReply> {
  return parse(
    await request(
      "/api/monsoon/me",
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ estate, ...input }) },
      TIMEOUT_MS.standard,
    ),
  );
}

/** Adds one note about the person and returns the page, the new note first. */
export async function addUserNote(estate: string, body: string): Promise<PageReply> {
  return parse(
    await request(
      "/api/monsoon/me/notes",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ estate, body }) },
      TIMEOUT_MS.standard,
    ),
  );
}
