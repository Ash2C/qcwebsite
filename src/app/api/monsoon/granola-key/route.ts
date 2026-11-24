import { requireAccount } from "@/lib/monsoon/accounts/account";
import {
  disconnectGranolaKey,
  loadGranolaKey,
  loadGranolaKeyState,
  recordGranolaStatus,
  saveGranolaKey,
} from "@/lib/monsoon/accounts/granola-key";
import { readJson } from "@/lib/monsoon/body";
import { GRANOLA_KEY_SHAPE, testGranolaKey, type GranolaFailure } from "@/lib/monsoon/granola/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_BODY = 2_000;

function reply(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function logError(where: string, err: unknown): Response {
  // Name and code only: the message can carry connection details.
  const code = (err as { code?: unknown })?.code;
  console.error(`monsoon: granola-key ${where} failed`, err instanceof Error ? err.name : "error", typeof code === "string" ? code.slice(0, 5) : "");
  return reply({ error: "Could not reach the accounts database" }, 502);
}

/** The signed-in person's Granola key state. Never the key: only its last four characters. */
export async function GET(request: Request): Promise<Response> {
  const auth = await requireAccount(request);
  if (!auth.ok) return auth.response;
  const who = { customerId: auth.account.customer.id, personId: auth.account.person.id };
  try {
    return reply({ key: await loadGranolaKeyState(who) });
  } catch (err) {
    return logError("read", err);
  }
}

// What a failed test of a new key answers: 422 for a key that will not work, 503 when Granola could not say.
function refused(failure: GranolaFailure): Response {
  if (failure === "key_rejected") return reply({ error: "granola_key_rejected" }, 422);
  if (failure === "no_access") return reply({ error: "granola_no_access" }, 422);
  return reply({ error: "granola_busy" }, 503);
}

/**
 * One action per request, always for the signed-in person (never a person named in the body):
 * `{ granolaKey }` tests a new key and, only if Granola accepts it, stores it in place of any other;
 * `{ test: true }` tests the key on file and records the result;
 * `{ disconnect: true }` empties the key.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = await requireAccount(request);
  if (!auth.ok) return auth.response;
  const who = { customerId: auth.account.customer.id, personId: auth.account.person.id };

  const read = await readJson(request, MAX_BODY);
  if (!read.ok) return reply({ error: "Invalid request" }, 400);
  if (typeof read.body !== "object" || read.body === null || Array.isArray(read.body)) return reply({ error: "Invalid request" }, 400);
  const body = read.body as Record<string, unknown>;
  const actions = [body.disconnect === true, body.test === true, "granolaKey" in body].filter(Boolean).length;
  if (actions !== 1) return reply({ error: "Invalid request" }, 400);

  try {
    if (body.disconnect === true) {
      if (!(await disconnectGranolaKey(who))) return reply({ error: "unauthorized" }, 401);
      return reply({ key: await loadGranolaKeyState(who) });
    }

    if (body.test === true) {
      const stored = await loadGranolaKey(who);
      if (stored === null) return reply({ error: "granola_key_missing" }, 422);
      const test = await testGranolaKey(stored);
      if (test.ok) await recordGranolaStatus(who, "ok");
      else if (test.failure === "key_rejected" || test.failure === "no_access") await recordGranolaStatus(who, test.failure);
      else return refused(test.failure);
      return reply({ key: await loadGranolaKeyState(who) });
    }

    const granolaKey = typeof body.granolaKey === "string" ? body.granolaKey.trim() : "";
    if (!GRANOLA_KEY_SHAPE.test(granolaKey)) return reply({ error: "granola_key_rejected" }, 422);
    const test = await testGranolaKey(granolaKey);
    if (!test.ok) return refused(test.failure);
    if (!(await saveGranolaKey(who, granolaKey))) return reply({ error: "unauthorized" }, 401);
    return reply({ key: await loadGranolaKeyState(who) });
  } catch (err) {
    return logError("write", err);
  }
}
