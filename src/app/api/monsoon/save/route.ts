import { NextResponse } from "next/server";
import { requireAccount } from "@/lib/monsoon/accounts/account";
import { readJson } from "@/lib/monsoon/body";
import { capture, type CaptureInput, type CaptureKind } from "@/lib/monsoon/capture";
import { ensureOwner } from "@/lib/monsoon/owners";
import { cleanOfferedTodos, MAX_OFFERED_TODOS } from "@/lib/monsoon/refine";
import { resolveToday } from "@/lib/monsoon/today";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_BODY = 65_536;
const KINDS: readonly string[] = ["card", "badge", "screen", "other"];

function invalid(error: string) {
  return NextResponse.json({ outcome: "invalid", error }, { status: 400 });
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export async function POST(request: Request) {
  const auth = await requireAccount(request);
  if (!auth.ok) return auth.response;
  const { account } = auth;

  const read = await readJson(request, MAX_BODY);
  if (!read.ok) {
    // Keep this route's own error shape.
    const error = read.response.status === 413 ? "Request too large" : "Invalid JSON";
    return NextResponse.json({ outcome: "invalid", error }, { status: read.response.status });
  }
  const body = read.body;
  if (typeof body !== "object" || body === null) return invalid("Invalid body");
  const b = body as Record<string, unknown>;

  const estate = account.pipeline(b.estate);
  if (!estate) return invalid("Unknown estate");
  if (typeof b.fields !== "object" || b.fields === null || Array.isArray(b.fields)) {
    return invalid("fields must be an object");
  }
  if (typeof b.role !== "string") return invalid("role must be a string");
  if (typeof b.captureId !== "string") return invalid("captureId must be a string");

  const f = b.fields as Record<string, unknown>;
  if (!(str(f.name) ?? "").trim()) return invalid("Name is required");
  for (const key of ["name", "title", "org", "email", "phone", "linkedin"]) {
    if ((str(f[key]) ?? "").length > 300) return invalid("Field too long");
  }
  if ((str(f.notes) ?? "").length > 2000) return invalid("Field too long");
  const extracted = b.extracted;
  const rawText =
    typeof extracted === "object" && extracted !== null
      ? str((extracted as Record<string, unknown>).raw_text)
      : undefined;

  // Offered to-dos come from the browser: a list of at most 5, cleaned the way the model's are.
  let todos: CaptureInput["todos"];
  if (b.todos !== undefined) {
    if (!Array.isArray(b.todos) || b.todos.length > MAX_OFFERED_TODOS) return invalid("todos must be a list of at most 5");
    todos = cleanOfferedTodos(b.todos, resolveToday(b.today, Date.now()));
  }

  const input: CaptureInput = {
    captureId: b.captureId,
    name: str(f.name) ?? "",
    role: b.role,
    org: str(f.org),
    title: str(f.title),
    email: str(f.email),
    phone: str(f.phone),
    linkedin: str(f.linkedin),
    notes: str(f.notes),
    rawText,
    extracted,
    newOrg: b.newOrg === true ? true : undefined,
    samePerson:
      typeof b.samePerson === "string" || b.samePerson === false
        ? b.samePerson
        : undefined,
    kind: typeof b.kind === "string" && KINDS.includes(b.kind) ? (b.kind as CaptureKind) : undefined,
    ...(todos ? { todos } : {}),
  };

  try {
    const result = await account.withDb(estate.key, async (db) => {
      // The owner key may never have reached this CRM (connected after sign-in, or that ensure failed).
      await ensureOwner(db, account.person.ownerKey, account.person.name);
      return capture(db, input, account.person.ownerKey);
    });
    // Only a save that wrote something counts as activity.
    if (result.outcome === "added" || result.outcome === "existing" || result.outcome === "filed") {
      await account.record(b.batch === true ? "batch_save" : "capture", estate.key);
    }
    return NextResponse.json(result, {
      status: result.outcome === "invalid" ? 400 : 200,
    });
  } catch (err) {
    // Name and code only: the message can carry connection details.
    console.error(
      `monsoon: save failed for ${estate.key}`,
      err instanceof Error ? err.name : "error",
      (err as { code?: string })?.code ?? ""
    );
    return NextResponse.json(
      { error: `Could not reach the ${estate.label} CRM` },
      { status: 502 }
    );
  }
}
