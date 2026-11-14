import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { runAsk, type AskMessage, type ModelClient } from "@/lib/monsoon/ask/loop";
import type { Ref } from "@/lib/monsoon/ask/tools";
import { requireSession } from "@/lib/monsoon/auth";
import { readJson } from "@/lib/monsoon/body";
import { withEstateDb } from "@/lib/monsoon/db";
import { estateByKey } from "@/lib/monsoon/estates";
import { resolveToday } from "@/lib/monsoon/today";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BODY = 262_144;
const MAX_MESSAGES = 30;
const MAX_TOTAL_CHARS = 60_000;
const MAX_USER_CHARS = 2000;
const MAX_REFS_PER_MESSAGE = 30;
const MAX_REF_TEXT = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bad(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Malformed refs are dropped silently, never rejected. */
function cleanRefs(value: unknown): Ref[] {
  if (!Array.isArray(value)) return [];
  const out: Ref[] = [];
  for (const r of value) {
    if (!isObj(r) || typeof r.memberId !== "string" || !UUID_RE.test(r.memberId)) continue;
    if (typeof r.name !== "string" || r.name.length === 0 || r.name.length > MAX_REF_TEXT) continue;
    if (r.kind !== "person" && r.kind !== "company") continue;
    if (r.company !== null && (typeof r.company !== "string" || r.company.length > MAX_REF_TEXT)) continue;
    // A person id that is not UUID-shaped is dropped; the rest of the ref is kept.
    const personId = typeof r.personId === "string" && UUID_RE.test(r.personId) ? r.personId : undefined;
    const orgId = typeof r.orgId === "string" && UUID_RE.test(r.orgId) ? r.orgId : undefined;
    out.push({
      memberId: r.memberId,
      name: r.name,
      company: r.company,
      kind: r.kind,
      ...(personId ? { personId } : {}),
      ...(orgId ? { orgId } : {}),
    });
    if (out.length >= MAX_REFS_PER_MESSAGE) break;
  }
  return out;
}

function parseMessages(value: unknown): AskMessage[] | string {
  if (!Array.isArray(value) || value.length === 0) return "messages must be a non-empty array";
  if (value.length > MAX_MESSAGES) return "Too many messages";
  const out: AskMessage[] = [];
  let total = 0;
  for (const m of value) {
    if (!isObj(m) || typeof m.content !== "string") return "Invalid message";
    total += m.content.length;
    if (m.role === "user") {
      if (m.content.trim().length < 1) return "Message is empty";
      if (m.content.length > MAX_USER_CHARS) return "Message is too long";
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const refs = cleanRefs(m.refs);
      for (const r of refs) total += r.memberId.length + r.name.length + (r.company?.length ?? 0) + (r.personId?.length ?? 0) + (r.orgId?.length ?? 0);
      out.push({ role: "assistant", content: m.content, refs });
    } else {
      return "Invalid message";
    }
  }
  if (out[0].role !== "user") return "The conversation must start with a user message";
  if (total > MAX_TOTAL_CHARS) return "Conversation is too long";
  if (out[out.length - 1].role !== "user") return "The last message must be from the user";
  return out;
}

export async function POST(request: Request) {
  const startedAt = Date.now(); // the loop's deadline counts from here, database connection included
  const denied = requireSession(request);
  if (denied) return denied;

  const read = await readJson(request, MAX_BODY);
  if (!read.ok) return read.response;
  if (!isObj(read.body)) return bad("Invalid body");
  const b = read.body;

  const estate = estateByKey(b.estate);
  if (!estate) return bad("Unknown estate");
  const messages = parseMessages(b.messages);
  if (typeof messages === "string") return bad(messages);
  const today = resolveToday(b.today, startedAt);

  try {
    const result = await withEstateDb(estate, async (db) => {
      const client = new Anthropic({ timeout: 20_000, maxRetries: 0 }).messages as unknown as ModelClient;
      return runAsk(
        { db, estate: estate.key, estateLabel: estate.label, today, client, now: () => Date.now(), startedAt },
        messages,
      );
    });
    return NextResponse.json(result);
  } catch (err) {
    // Name and status only: messages can carry questions, contact data or connection details.
    const status = (err as { status?: unknown })?.status;
    console.error("monsoon: ask failed", err instanceof Error ? err.name : "error", ...(typeof status === "number" ? [status] : []));
    return NextResponse.json({ error: "Could not get an answer" }, { status: 502 });
  }
}
