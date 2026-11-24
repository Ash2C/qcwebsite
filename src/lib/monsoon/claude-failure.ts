import { NextResponse } from "next/server";
import { NotConnected } from "./accounts/not-connected";

/**
 * A failure whose cause is the customer's Claude account, not the request: the app shows these by
 * name, so nobody retries a photo or blames the signal when the key is the problem.
 */
export type ClaudeFailure = "claude_key_missing" | "claude_key_rejected" | "claude_no_credit" | "claude_busy";

/** Which Claude problem `err` is, or null when it is something else (database, timeout, bad output). */
export function claudeFailure(err: unknown): ClaudeFailure | null {
  // An unconnected pipeline is a NotConnected too; only the missing key is a Claude problem.
  if (err instanceof NotConnected) return err.message.startsWith("Claude key") ? "claude_key_missing" : null;
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status !== "number") return null;
  // The message is read here to tell "no credit" apart; it is never logged or returned.
  const message = err instanceof Error ? err.message : "";
  if (status === 402 || ((status === 400 || status === 403) && /credit balance/i.test(message))) return "claude_no_credit";
  if (status === 401 || status === 403) return "claude_key_rejected";
  if (status === 429 || status >= 500) return "claude_busy";
  return null;
}

/**
 * The response for a Claude problem, or null. 409 for the account's own state (never 401: the app
 * reads that as "signed out"), 503 when Claude is busy. The body carries the reason only.
 */
export function claudeFailureResponse(err: unknown): NextResponse | null {
  const reason = claudeFailure(err);
  if (reason === null) return null;
  return NextResponse.json({ error: reason }, { status: reason === "claude_busy" ? 503 : 409 });
}
