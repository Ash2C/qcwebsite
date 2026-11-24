import { requireAccount } from "@/lib/monsoon/accounts/account";
import {
  loadClaudeKeyState,
  replaceClaudeKey,
  testClaudeKey,
  testStoredKey,
  type KeyTest,
} from "@/lib/monsoon/accounts/claude-key";
import { recordClaudeStatus } from "@/lib/monsoon/accounts/store";
import { readJson } from "@/lib/monsoon/body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_BODY = 2_000;
// Shape only: the real check is the test call. Long enough to be a key, short enough to be one.
const KEY = /^sk-ant-[A-Za-z0-9_-]{20,300}$/;

function reply(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function logError(where: string, err: unknown): Response {
  // Name and code only: the message can carry connection details.
  const code = (err as { code?: unknown })?.code;
  console.error(`monsoon: claude-key ${where} failed`, err instanceof Error ? err.name : "error", typeof code === "string" ? code.slice(0, 5) : "");
  return reply({ error: "Could not reach the accounts database" }, 502);
}

/** The key's state for the signed-in person. Never the key: only its last four characters. */
export async function GET(request: Request): Promise<Response> {
  const auth = await requireAccount(request);
  if (!auth.ok) return auth.response;
  try {
    return reply({ key: await loadClaudeKeyState(auth.account) });
  } catch (err) {
    return logError("read", err);
  }
}

// What a failed test answers: 422 for a key that will not work, 503 when Claude could not say.
function refused(test: Exclude<KeyTest, "ok">): Response {
  if (test === "claude_busy" || test === "unreachable") return reply({ error: "claude_busy" }, 503);
  return reply({ error: test }, 422);
}

/**
 * `{ test: true }` tests the key on file (anyone signed in) and records the result.
 * `{ claudeKey }` tests a new key and, only if Claude accepts it, replaces the one on file
 * (the customer's key person only). The key on file keeps working until the new one passes.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = await requireAccount(request);
  if (!auth.ok) return auth.response;
  const { account } = auth;

  const read = await readJson(request, MAX_BODY);
  if (!read.ok) return reply({ error: "Invalid request" }, 400);
  const body = (typeof read.body === "object" && read.body !== null ? read.body : {}) as Record<string, unknown>;

  try {
    if (body.test === true) {
      const test = await testStoredKey(account.customer.id);
      if (test === "missing") return reply({ error: "claude_key_missing" }, 422);
      if (test === "ok") await recordClaudeStatus(account.customer.id, "ok");
      else if (test === "claude_key_rejected") await recordClaudeStatus(account.customer.id, "key_rejected");
      else if (test === "claude_no_credit") await recordClaudeStatus(account.customer.id, "no_credit");
      else return refused(test);
      return reply({ key: await loadClaudeKeyState(account) });
    }

    if (!account.canChangeKey) return reply({ error: "not_key_person" }, 403);
    const claudeKey = typeof body.claudeKey === "string" ? body.claudeKey.trim() : "";
    if (!KEY.test(claudeKey)) return reply({ error: "claude_key_rejected" }, 422);
    const test = await testClaudeKey(claudeKey);
    if (test !== "ok") return refused(test);
    if (!(await replaceClaudeKey(account.customer.id, account.person.id, claudeKey))) {
      return reply({ error: "not_key_person" }, 403);
    }
    return reply({ key: await loadClaudeKeyState(account) });
  } catch (err) {
    return logError("write", err);
  }
}
