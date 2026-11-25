// Vincent's Requests screen: who has asked to join, and Approve, Decline and Re-open. Only the key
// person of the customer `quantcloud` may use it; every other signed-in person gets a 404 for every
// method, as if it were not there. Nothing here returns a Google id, a connection address or the
// detail of an error.
import { requireAccount, type Account } from "@/lib/monsoon/accounts/account";
import { approveSignup } from "@/lib/monsoon/accounts/approve";
import { canApprove } from "@/lib/monsoon/accounts/approver";
import { declineSignup, listSignups, reopenSignup } from "@/lib/monsoon/accounts/signups";
import { readJson } from "@/lib/monsoon/body";
import { signupsConfigured } from "@/lib/monsoon/google";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Approving builds a CRM in the shared database and checks it as the new login.
export const maxDuration = 60;

const MAX_BODY = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(["approve", "decline", "reopen"]);

function reply(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** The signed-in key person of quantcloud, or the response to send instead (401 signed out, else 404). */
async function approver(request: Request): Promise<{ ok: true; account: Account } | { ok: false; response: Response }> {
  const auth = await requireAccount(request);
  if (!auth.ok) return auth;
  const { account } = auth;
  if (!canApprove(account)) {
    return { ok: false, response: reply({ error: "Not found" }, 404) };
  }
  return { ok: true, account };
}

function failed(where: string, err: unknown, error: string): Response {
  // Name and code only: the message can carry connection details.
  const code = (err as { code?: unknown })?.code;
  console.error(`monsoon: requests ${where} failed`, err instanceof Error ? err.name : "error", typeof code === "string" ? code.slice(0, 5) : "");
  return reply({ error }, 502);
}

export async function GET(request: Request): Promise<Response> {
  const auth = await approver(request);
  if (!auth.ok) return auth.response;
  try {
    const rows = await listSignups();
    // Field by field, so the Google id (or anything added to the row later) never leaves.
    const requests = rows.map((r) => ({ id: r.id, email: r.email, name: r.name, status: r.status, customerId: r.customerId, createdAt: r.createdAt }));
    return reply({ requests, configured: signupsConfigured() });
  } catch (err) {
    return failed("list", err, "Could not reach the accounts database");
  }
}

export async function POST(request: Request): Promise<Response> {
  const auth = await approver(request);
  if (!auth.ok) return auth.response;
  const { account } = auth;

  const read = await readJson(request, MAX_BODY);
  if (!read.ok) return reply({ error: "Invalid request" }, 400);
  const body = (typeof read.body === "object" && read.body !== null && !Array.isArray(read.body) ? read.body : {}) as Record<string, unknown>;
  const { id, action } = body;
  if (typeof id !== "string" || !UUID.test(id) || typeof action !== "string" || !ACTIONS.has(action)) {
    return reply({ error: "Invalid request" }, 400);
  }

  if (action === "approve") {
    if (!signupsConfigured()) return reply({ error: "Sign-ups are not set up" }, 503);
    try {
      const result = await approveSignup(id, { approver: { customerId: account.customer.id, personId: account.person.id } });
      if (result.ok) return reply({ ok: true });
      if (result.reason === "not_found") return reply({ error: "No such request" }, 404);
      if (result.reason === "busy") return reply({ error: "This request is being approved right now." }, 409);
      if (result.reason === "declined") return reply({ error: "This request was declined. Re-open it first." }, 409);
      return reply({ error: "Could not finish. Try again." }, 502);
    } catch (err) {
      return failed("approve", err, "Could not finish. Try again.");
    }
  }

  try {
    const changed = action === "decline" ? await declineSignup(id) : await reopenSignup(id);
    if (!changed) return reply({ error: "That request has already changed. Refresh and try again." }, 409);
    return reply({ ok: true });
  } catch (err) {
    return failed(action, err, "Could not reach the accounts database");
  }
}

// No other method exists here, for anyone: signed out is 401 like every route, the rest 404.
async function none(request: Request): Promise<Response> {
  const auth = await approver(request);
  if (!auth.ok) return auth.response;
  return reply({ error: "Not found" }, 404);
}
export const PUT = none;
export const PATCH = none;
export const DELETE = none;
