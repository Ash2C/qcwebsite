import { NextResponse } from "next/server";
import { requireAccount } from "@/lib/monsoon/accounts/account";
import { claudeFailureResponse } from "@/lib/monsoon/claude-failure";
import type { Client } from "pg";
import { runAsk, type AboutUser, type AskMessage, type ModelClient, type Viewing } from "@/lib/monsoon/ask/loop";
import { loadAskContext, type AskContext, type UserPage, type Who } from "@/lib/monsoon/accounts/profile";
import { getProfile } from "@/lib/monsoon/contacts";
import type { Ref } from "@/lib/monsoon/ask/tools";
import { readJson } from "@/lib/monsoon/body";
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

// The lookup is a hint for the model: it must not eat the time the answer needs.
const VIEWING_TIMEOUT_MS = 3000;

type ViewingTarget = { memberId?: string; personId?: string; orgId?: string };

/** The one id the phone says is open on screen: the first UUID-shaped one, nothing else from the body. */
function cleanViewing(value: unknown): ViewingTarget | null {
  if (!isObj(value)) return null;
  for (const key of ["personId", "orgId", "memberId"] as const) {
    const id = value[key];
    if (typeof id === "string" && UUID_RE.test(id)) return { [key]: id };
  }
  return null;
}

/** That contact as this customer's database holds it, or undefined: not found and failures are both silent. */
async function resolveViewing(db: Client, target: ViewingTarget | null, today: string): Promise<Viewing | undefined> {
  if (!target) return undefined;
  try {
    const p = await getProfile(db, target, today, { timeoutMs: VIEWING_TIMEOUT_MS });
    if (!p) return undefined;
    return {
      kind: p.kind,
      name: p.name,
      company: p.company,
      personId: p.personId,
      orgId: p.orgId,
      memberId: p.member?.memberId ?? null,
    };
  } catch {
    return undefined;
  }
}

// Like the contact lookup, the user's own page is a help, not a need: capped, and silent when it fails.
const ABOUT_TIMEOUT_MS = 3000;

/**
 * The user's own page and their colleagues' account names, or null. Never rejects: a slow or
 * unreachable accounts database must not stop the answer, and nothing is logged (an error from
 * there can carry what the person wrote).
 */
async function askContext(who: Who, estateKey: string): Promise<AskContext | null> {
  try {
    return await loadAskContext(who, estateKey, { timeoutMs: ABOUT_TIMEOUT_MS });
  } catch {
    return null;
  }
}

/** What the prompt is told about the user. Their name is not here: it comes from the session. */
function aboutOf(page: UserPage): AboutUser {
  return {
    phone: page.person.phone,
    email: page.person.email,
    company: page.work.company,
    website: page.work.website,
    roleObjectives: page.work.roleObjectives,
    notes: page.notes.map((n) => ({ body: n.body, at: n.at })),
    notesTotal: page.notesTotal,
  };
}

export async function POST(request: Request) {
  const startedAt = Date.now(); // the loop's deadline counts from here, database connection included
  const auth = await requireAccount(request);
  if (!auth.ok) return auth.response;
  const { account } = auth;

  const read = await readJson(request, MAX_BODY);
  if (!read.ok) return read.response;
  if (!isObj(read.body)) return bad("Invalid body");
  const b = read.body;

  const estate = account.pipeline(b.estate);
  if (!estate) return bad("Unknown estate");
  const messages = parseMessages(b.messages);
  if (typeof messages === "string") return bad(messages);
  const today = resolveToday(b.today, startedAt);
  const viewingTarget = cleanViewing(b.viewing);

  try {
    // The customer's own key and model; the customer id comes from the session, never the body.
    const client = account.anthropic({ timeout: 20_000 }).messages as unknown as ModelClient;
    const model = account.model();
    // Started before the CRM connection and awaited inside it, so the two waits overlap. The person
    // and customer come from the session, never the body.
    const pendingContext = askContext({ customerId: account.customer.id, personId: account.person.id }, estate.key);
    const result = await account.withDb(estate.key, async (db) => {
      const [viewing, context] = await Promise.all([resolveViewing(db, viewingTarget, today), pendingContext]);
      return runAsk(
        {
          db,
          customerId: account.customer.id,
          estate: estate.key,
          estateLabel: estate.label,
          defaultRole: estate.defaultRole,
          person: { name: account.person.name, ownerKey: account.person.ownerKey },
          model,
          today,
          client,
          now: () => Date.now(),
          startedAt,
          viewing,
          ...(context ? { about: aboutOf(context.page), ownerNames: context.ownerNames } : {}),
        },
        messages,
      );
    });
    await account.noteClaude();
    await account.record("ask", estate.key);
    return NextResponse.json(result);
  } catch (err) {
    // Name and status only: messages can carry questions, contact data or connection details.
    const status = (err as { status?: unknown })?.status;
    console.error("monsoon: ask failed", err instanceof Error ? err.name : "error", ...(typeof status === "number" ? [status] : []));
    await account.noteClaude(err);
    return claudeFailureResponse(err) ?? NextResponse.json({ error: "Could not get an answer" }, { status: 502 });
  }
}
