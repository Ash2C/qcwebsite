// Read-only lookup for the setup page: never consumes the link or counts an attempt.
import { hashToken } from "./crypto";
import { withAccountsDb } from "./store";

export const SETUP_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const SETUP_EXPIRED = "This setup link has expired. Ask for a new one.";
export const SETUP_MAX_ATTEMPTS = 10;

export type SetupPage =
  | { kind: "expired" }
  | { kind: "ok"; purpose: "key"; claudeKeyOnFile: boolean };

export async function loadSetupPage(token: string): Promise<SetupPage> {
  if (!SETUP_TOKEN.test(token)) return { kind: "expired" };
  return withAccountsDb(async (db) => {
    const r = await db.query(
      `SELECT (c.claude_key_enc IS NOT NULL) AS claude_key_on_file
         FROM setup_links l
         JOIN customers c ON c.id = l.customer_id
        WHERE l.token_hash = $1 AND l.purpose = 'key' AND l.used_at IS NULL AND l.expires_at > now() AND l.attempts < $2`,
      [hashToken(token), SETUP_MAX_ATTEMPTS],
    );
    if (r.rowCount !== 1) return { kind: "expired" };
    return { kind: "ok", purpose: "key", claudeKeyOnFile: r.rows[0].claude_key_on_file === true };
  });
}
