// The customer's Claude key as the app sees it: its state (never the key itself), a live test, and
// replacing it. Only the customer's one named key person may replace it; the database enforces that too.
import Anthropic from "@anthropic-ai/sdk";
import { claudeFailure, type ClaudeFailure } from "../claude-failure";
import type { Account } from "./account";
import { decryptSecret, encryptSecret } from "./crypto";
import { evictCustomer, withAccountsDb, type ClaudeStatus } from "./store";

export type ClaudeKeyState = {
  /** `missing`: no key on file. Otherwise the last real Claude result (a key with none yet was tested when saved). */
  status: "missing" | ClaudeStatus;
  /** The last four characters of the key on file, or null. */
  last4: string | null;
  /** ISO times; null when unknown. */
  checkedAt: string | null;
  setAt: string | null;
  /** Who entered the key in the app; null when it came through a setup link. */
  setBy: string | null;
  /** The one person who may change the key, by name; null when nobody is named. */
  keyPerson: string | null;
  /** Whether the signed-in person is that person. */
  canChange: boolean;
};

const iso = (d: unknown): string | null => (d instanceof Date ? d.toISOString() : null);

/** Read fresh from the accounts database (never the 60-second cache). */
export async function loadClaudeKeyState(account: Pick<Account, "customer" | "person">): Promise<ClaudeKeyState> {
  const row = await withAccountsDb(async (db) => {
    const r = await db.query(
      `SELECT c.claude_key_enc, c.claude_status, c.claude_checked_at, c.claude_key_set_at, c.key_person_id,
              (SELECT display_name FROM people s WHERE s.id = c.claude_key_set_by) AS set_by,
              (SELECT display_name FROM people k WHERE k.id = c.key_person_id) AS key_person
         FROM customers c WHERE c.id = $1`,
      [account.customer.id],
    );
    return r.rows[0] as Record<string, unknown> | undefined;
  });
  if (!row) throw new Error("Customer not found");
  const enc = (row.claude_key_enc as string | null) ?? null;
  return {
    status: enc === null ? "missing" : ((row.claude_status as ClaudeStatus | null) ?? "ok"),
    last4: enc === null ? null : decryptSecret(enc, account.customer.id, "claude_key").slice(-4),
    checkedAt: iso(row.claude_checked_at),
    setAt: iso(row.claude_key_set_at),
    setBy: (row.set_by as string | null) ?? null,
    keyPerson: (row.key_person as string | null) ?? null,
    canChange: row.key_person_id !== null && row.key_person_id === account.person.id,
  };
}

export type KeyTest = "ok" | ClaudeFailure | "unreachable";

/** One tiny real call with `apiKey`. Never throws and never logs: the error can carry the key. */
export async function testClaudeKey(apiKey: string): Promise<KeyTest> {
  try {
    await new Anthropic({ apiKey, timeout: 15_000, maxRetries: 0 }).messages.create({
      model: "claude-haiku-5-5",
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    });
    return "ok";
  } catch (err) {
    return claudeFailure(err) ?? "unreachable";
  }
}

/** Tests the key on file. `missing` when there is none. */
export async function testStoredKey(customerId: string): Promise<KeyTest | "missing"> {
  const enc = await withAccountsDb(async (db) => {
    const r = await db.query("SELECT claude_key_enc FROM customers WHERE id = $1", [customerId]);
    return (r.rows[0]?.claude_key_enc as string | null | undefined) ?? null;
  });
  if (enc === null) return "missing";
  return testClaudeKey(decryptSecret(enc, customerId, "claude_key"));
}

/**
 * Stores a key that has just passed its test. False when `personId` is not the customer's key
 * person (checked in the same statement that writes).
 */
export async function replaceClaudeKey(customerId: string, personId: string, apiKey: string): Promise<boolean> {
  const enc = encryptSecret(apiKey, customerId, "claude_key");
  const saved = await withAccountsDb(async (db) => {
    await db.query("BEGIN");
    try {
      const r = await db.query(
        `UPDATE customers
            SET claude_key_enc = $3, claude_status = 'ok', claude_checked_at = now(),
                claude_key_set_at = now(), claude_key_set_by = $2
          WHERE id = $1 AND key_person_id = $2`,
        [customerId, personId, enc],
      );
      if (r.rowCount !== 1) {
        await db.query("ROLLBACK");
        return false;
      }
      await db.query("INSERT INTO activity (customer_id, person_id, pipeline_key, action) VALUES ($1, $2, NULL, 'key')", [
        customerId,
        personId,
      ]);
      await db.query("COMMIT");
      return true;
    } catch (err) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
  });
  if (saved) evictCustomer(customerId);
  return saved;
}
