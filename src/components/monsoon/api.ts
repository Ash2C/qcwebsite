// Thin client for the /api/monsoon routes. Every call resolves with { status, body }; a
// non-2xx status is data, not an exception. Only a network failure rejects, and so does a
// request that runs past its time limit (it is aborted): callers treat both alike.
import type { CardFields } from "@/lib/monsoon/extract";
import type { CaptureResult } from "@/lib/monsoon/capture";
import type { RefineInput, RefineOutput } from "@/lib/monsoon/refine";
import type { AskMessage, AskResult } from "@/lib/monsoon/ask/loop";
import type { SignedProposal } from "@/lib/monsoon/ask/proposal";

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
};

export type ApiResult<T> = { status: number; body: T };

// How long each call may take before it is aborted, in milliseconds. A little over each route's
// own limit, so the server answers first when it can.
const TIMEOUT_MS = {
  quick: 15_000, // signIn, loadEstates
  standard: 35_000, // readCards, saveCard, refineCard, actOnCrm
  ask: 70_000, // askCrm
} as const;

// The one place a request is made: every call gets a timeout signal.
function request(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
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

export async function signIn(
  passcode: string,
): Promise<ApiResult<{ ok: true } | { error: string }>> {
  return parse(
    await request(
      "/api/monsoon/session",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ passcode }) },
      TIMEOUT_MS.quick,
    ),
  );
}

export async function loadEstates(): Promise<
  ApiResult<{ estates: EstateInfo[] } | { error: string }>
> {
  return parse(await request("/api/monsoon/estates", { cache: "no-store" }, TIMEOUT_MS.quick));
}

export async function readCards(
  image: Blob,
): Promise<ApiResult<{ cards: CardFields[] } | { error: string }>> {
  const form = new FormData();
  form.append("image", image, "card.jpg");
  return parse(await request("/api/monsoon/read", { method: "POST", body: form }, TIMEOUT_MS.standard));
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
  return parse(
    await request(
      "/api/monsoon/refine",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      TIMEOUT_MS.standard,
    ),
  );
}

export async function askCrm(body: {
  estate: string;
  today: string;
  messages: AskMessage[];
}): Promise<ApiResult<AskResult | { error: string }>> {
  return parse(
    await request(
      "/api/monsoon/ask",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      TIMEOUT_MS.ask,
    ),
  );
}

export async function actOnCrm(body: {
  estate: string;
  proposal: SignedProposal["proposal"];
  signature: string;
  text?: string;
}): Promise<ApiResult<{ status: string; message: string } | { error: string }>> {
  return parse(
    await request(
      "/api/monsoon/act",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      TIMEOUT_MS.standard,
    ),
  );
}
