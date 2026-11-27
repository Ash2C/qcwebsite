import { NextResponse } from "next/server";
import { requireAccount } from "@/lib/monsoon/accounts/account";
import { FEEDBACK_KINDS, type FeedbackKind } from "@/lib/monsoon/accounts/store";
import { readJson } from "@/lib/monsoon/body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 2048;
const MAX_DETAIL = 200;
/** Only these kinds carry a reason; for the others anything sent is dropped. */
const DETAIL_KINDS: readonly FeedbackKind[] = ["no_speech", "mic_blocked", "unsupported"];

/** Terminal escape sequences and line breaks have no place in a stored reason. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

const bad = (error: string) => NextResponse.json({ error }, { status: 400 });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Records one Ask rating or voice failure. Never touches the customer's CRM; answers 204 even when the daily limit dropped the row. */
export async function POST(request: Request) {
  const auth = await requireAccount(request);
  if (!auth.ok) return auth.response;
  const { account } = auth;

  const read = await readJson(request, MAX_BODY);
  if (!read.ok) return read.response;
  if (!isObj(read.body)) return bad("Invalid body");
  const b = read.body;

  const estate = account.pipeline(b.estate);
  if (!estate) return bad("Unknown estate");
  const kind = FEEDBACK_KINDS.find((k) => k === b.kind);
  if (!kind) return bad("Unknown kind");
  if (b.mode !== "voice" && b.mode !== "typed") return bad("Unknown mode");

  const detail = DETAIL_KINDS.includes(kind) && typeof b.detail === "string" ? b.detail.replace(CONTROL_CHARS, "").slice(0, MAX_DETAIL) : null;
  await account.feedback({ pipelineKey: estate.key, kind, mode: b.mode, detail });
  return new NextResponse(null, { status: 204 });
}
