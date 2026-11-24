// What to tell the person when the server names the account's Claude key as the problem
// (see src/lib/monsoon/claude-failure.ts). `lead` says what could not be done, e.g.
// "Photos cannot be read". Null when the body names no Claude problem.
export function claudeFailureText(body: unknown, lead: string): string | null {
  const reason = (body as { error?: unknown } | null)?.error;
  switch (reason) {
    case "claude_key_missing":
      return `${lead} yet: this account has no Claude API key. Add it with your Monsoon setup link.`;
    case "claude_key_rejected":
      return `${lead}: Claude did not accept this account's API key. It may have expired, been revoked or lack permission.`;
    case "claude_no_credit":
      return `${lead}: this account's Claude API key is out of credit. Add credit in the Claude Console.`;
    case "claude_busy":
      return `${lead} right now: Claude is busy or this account's rate limit was reached. Try again in a minute.`;
    default:
      return null;
  }
}
