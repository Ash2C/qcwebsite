import { NextResponse } from "next/server";
import type { Client } from "pg";
import { requireAccount } from "@/lib/monsoon/accounts/account";
import { readJson } from "@/lib/monsoon/body";
import { listNudges, snoozeNudge } from "@/lib/monsoon/nudges";
import { ensureOwner } from "@/lib/monsoon/owners";
import { resolveToday } from "@/lib/monsoon/today";
import {
  addTodo,
  completeTodo,
  dropTodo,
  editTodo,
  listTodos,
  reopenTodo,
  setOutcome,
  todosReady,
  type Viewer,
  type WriteResult,
} from "@/lib/monsoon/todos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_BODY = 16_384;
const ALL_NUDGES = 200;
const NOT_READY = "To do is being set up for this CRM.";
const GONE = "That to-do is no longer there.";
const NEEDS_ID = ["complete", "outcome", "edit", "drop", "reopen"];

type Target = { memberId?: string; personId?: string };
type Run = (db: Client, viewer: Viewer) => Promise<WriteResult | { snooze: "ok" | "missing" }>;

function bad(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Only string ids are kept; anything else in the target is a malformed body. */
function parseTarget(value: unknown): Target | undefined {
  if (!isObj(value)) return undefined;
  const out: Target = {};
  for (const key of ["memberId", "personId"] as const) {
    const v = value[key];
    if (v === undefined) continue;
    if (typeof v !== "string") return undefined;
    out[key] = v;
  }
  return out;
}

function reply(result: WriteResult) {
  if (result.status === "invalid") return bad(result.reason);
  if (result.status === "missing") return NextResponse.json({ error: GONE }, { status: 404 });
  return NextResponse.json({ status: result.status, todo: result.todo });
}

function unreachable(estate: { key: string; label: string }, err: unknown) {
  // Name and code only: the message can carry connection details or contact data.
  console.error(
    `monsoon: todos failed for ${estate.key}`,
    err instanceof Error ? err.name : "error",
    (err as { code?: string })?.code ?? "",
  );
  return NextResponse.json({ error: `Could not reach the ${estate.label} CRM` }, { status: 502 });
}

/** The list and the nudges; with `member`, only that contact's to-dos. `{ ready: false }` below CRM version 2. */
export async function GET(request: Request) {
  const auth = await requireAccount(request);
  if (!auth.ok) return auth.response;
  const { account } = auth;

  const params = new URL(request.url).searchParams;
  const estate = account.pipeline(params.get("estate"));
  if (!estate) return bad("Unknown estate");
  const today = resolveToday(params.get("today"), Date.now());
  const member = params.get("member");
  const limit = params.get("nudges") === "all" ? ALL_NUDGES : undefined;

  try {
    const viewer = await account.viewer();
    const body = await account.withDb(estate.key, async (db) => {
      if (!(await todosReady(db))) return { ready: false as const };
      const { open, done } = await listTodos(db, viewer, today, member !== null ? { memberId: member } : undefined);
      if (member !== null) return { ready: true as const, open, done };
      return { ready: true as const, open, done, nudges: await listNudges(db, viewer, today, { limit }) };
    });
    return NextResponse.json(body);
  } catch (err) {
    return unreachable(estate, err);
  }
}

/** Turns a body into the call to make, or a 400. The library checks limits (length, real dates). */
function plan(b: Record<string, unknown>, today: string): Run | Response {
  const action = b.action;
  const id = typeof b.id === "string" ? b.id : "";
  if (typeof action === "string" && NEEDS_ID.includes(action) && id === "") return bad("Invalid to-do");

  if (action === "add") {
    if (typeof b.title !== "string") return bad("Invalid title");
    if (b.dueDate !== null && b.dueDate !== undefined && typeof b.dueDate !== "string") return bad("Invalid date");
    let target: Target | undefined;
    if (b.target !== undefined && b.target !== null) {
      target = parseTarget(b.target);
      if (!target) return bad("Invalid target");
    }
    // "ask" and "notes" are set by other server code, never by the browser.
    if (b.source !== undefined && b.source !== "app" && b.source !== "next") return bad("Invalid source");
    const source = b.source === "next" ? "next" : "app";
    const title = b.title;
    const dueDate = (b.dueDate ?? null) as string | null;
    return (db, viewer) => addTodo(db, { title, dueDate, target, source }, viewer, today);
  }
  if (action === "complete") return (db, viewer) => completeTodo(db, id, viewer, today);
  if (action === "drop") return (db, viewer) => dropTodo(db, id, viewer, today);
  if (action === "reopen") return (db, viewer) => reopenTodo(db, id, viewer, today);
  if (action === "outcome") {
    if (typeof b.outcome !== "string") return bad("Invalid outcome");
    const outcome = b.outcome;
    return (db, viewer) => setOutcome(db, id, outcome, viewer, today);
  }
  if (action === "edit") {
    const patch: { title?: string; dueDate?: string | null; target?: Target | null } = {};
    if (b.title !== undefined) {
      if (typeof b.title !== "string") return bad("Invalid title");
      patch.title = b.title;
    }
    if (b.dueDate !== undefined) {
      if (b.dueDate !== null && typeof b.dueDate !== "string") return bad("Invalid date");
      patch.dueDate = b.dueDate;
    }
    if (b.target !== undefined) {
      if (b.target === null) patch.target = null;
      else {
        const target = parseTarget(b.target);
        if (!target) return bad("Invalid target");
        patch.target = target;
      }
    }
    return (db, viewer) => editTodo(db, id, patch, viewer, today);
  }
  if (action === "snooze") {
    if (typeof b.memberId !== "string") return bad("Invalid contact");
    const memberId = b.memberId;
    return async (db) => ({ snooze: (await snoozeNudge(db, memberId, today)).status });
  }
  return bad("Unknown action");
}

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
  const run = plan(b, resolveToday(b.today, Date.now()));
  if (run instanceof Response) return run;

  try {
    const viewer = await account.viewer();
    const result = await account.withDb(estate.key, async (db) => {
      if (!(await todosReady(db))) return null;
      // The owner key may never have reached this CRM, and the library would name it by its key.
      await ensureOwner(db, account.person.ownerKey, account.person.name);
      return run(db, viewer);
    });
    if (result === null) return NextResponse.json({ error: NOT_READY }, { status: 409 });
    if ("snooze" in result) {
      if (result.snooze === "missing") return NextResponse.json({ error: GONE }, { status: 404 });
      await account.record("act_details", estate.key);
      return NextResponse.json({ status: "ok" });
    }
    if (result.status === "ok") await account.record("act_details", estate.key);
    return reply(result);
  } catch (err) {
    return unreachable(estate, err);
  }
}
