// The app's view of the account's Claude key: the result of the last real Claude call. The api
// client reports each result here; the chip in the header listens.
export type ClaudeChipStatus = "ok" | "missing" | "key_rejected" | "no_credit";

const listeners = new Set<(status: ClaudeChipStatus) => void>();

/** Subscribes to results; returns the unsubscribe. */
export function onClaudeStatus(fn: (status: ClaudeChipStatus) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function reportClaudeStatus(status: ClaudeChipStatus): void {
  for (const fn of listeners) fn(status);
}

/**
 * What a response from a route that calls Claude says about the key, or null when it says nothing
 * (a busy Claude, a lost connection, a database failure). `worked` is false for a 200 that did not
 * reach Claude.
 */
export function claudeStatusOf(res: { status: number; body: unknown }, worked = true): ClaudeChipStatus | null {
  const error = (res.body as { error?: unknown } | null)?.error;
  if (error === "claude_key_missing") return "missing";
  if (error === "claude_key_rejected") return "key_rejected";
  if (error === "claude_no_credit") return "no_credit";
  return res.status === 200 && worked ? "ok" : null;
}
