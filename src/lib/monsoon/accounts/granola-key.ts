// A person's own Granola key as the app sees it: its state (never the key itself), saving a key
// that has just passed its test, the result of the last real Granola call, disconnecting, and the
// one read that hands the key to Ask. The key is personal: every statement is keyed on the person
// AND their customer, both from the session, and the key is encrypted under a field name that
// carries the person's id, so it cannot be read from any other row. Nothing here logs a key.
import { decryptSecret, encryptSecret } from "./crypto";
import type { Who } from "./profile";
import { withAccountsDb } from "./store";

export type GranolaStatus = "ok" | "key_rejected" | "no_access";

export type GranolaKeyState = {
  /** `missing`: no key on file. Otherwise the last real Granola result (a key with none yet was tested when saved). */
  status: "missing" | GranolaStatus;
  /** The last four characters of the key on file, or null. */
  last4: string | null;
  /** ISO times; null when unknown. */
  setAt: string | null;
  checkedAt: string | null;
};

const ASK_TIMEOUT_MS = 3000;
const RECORD = "INSERT INTO activity (customer_id, person_id, pipeline_key, action) VALUES ($1, $2, NULL, 'granola')";

const iso = (d: unknown): string | null => (d instanceof Date ? d.toISOString() : null);
const field = (who: Who): string => `granola:${who.personId}`;

/** Read fresh from the accounts database. Throws when the person is not this customer's. */
export async function loadGranolaKeyState(who: Who): Promise<GranolaKeyState> {
  const row = await withAccountsDb(async (db) => {
    const r = await db.query(
      "SELECT granola_key_enc, granola_status, granola_checked_at, granola_key_set_at FROM people WHERE id = $2 AND customer_id = $1",
      [who.customerId, who.personId],
    );
    return r.rows[0] as Record<string, unknown> | undefined;
  });
  if (!row) throw new Error("Person not found");
  const enc = (row.granola_key_enc as string | null) ?? null;
  if (enc === null) return { status: "missing", last4: null, setAt: null, checkedAt: null };
  return {
    status: (row.granola_status as GranolaStatus | null) ?? "ok",
    last4: decryptSecret(enc, who.customerId, field(who)).slice(-4),
    setAt: iso(row.granola_key_set_at),
    checkedAt: iso(row.granola_checked_at),
  };
}

/** The key on file, decrypted, to test it again; null when there is none. Throws like any lookup. */
export async function loadGranolaKey(who: Who): Promise<string | null> {
  const row = await withAccountsDb(async (db) => {
    const r = await db.query("SELECT granola_key_enc FROM people WHERE id = $2 AND customer_id = $1", [who.customerId, who.personId]);
    return r.rows[0] as { granola_key_enc: string | null } | undefined;
  });
  if (!row) throw new Error("Person not found");
  return row.granola_key_enc === null ? null : decryptSecret(row.granola_key_enc, who.customerId, field(who));
}

/** Stores a key that has just passed its test, replacing any other. False when the person is not this customer's. */
export async function saveGranolaKey(who: Who, key: string): Promise<boolean> {
  const enc = encryptSecret(key, who.customerId, field(who));
  return withAccountsDb(async (db) => {
    await db.query("BEGIN");
    try {
      const r = await db.query(
        `UPDATE people
            SET granola_key_enc = $3, granola_status = 'ok', granola_checked_at = now(), granola_key_set_at = now()
          WHERE id = $2 AND customer_id = $1`,
        [who.customerId, who.personId, enc],
      );
      if (r.rowCount !== 1) {
        await db.query("ROLLBACK");
        return false;
      }
      await db.query(RECORD, [who.customerId, who.personId]);
      await db.query("COMMIT");
      return true;
    } catch (err) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
  });
}

/**
 * Records the result of a real Granola call, only while a key is on file. Never throws; logs the
 * error class name only.
 */
export async function recordGranolaStatus(who: Who, status: GranolaStatus): Promise<void> {
  try {
    await withAccountsDb((db) =>
      db.query(
        `UPDATE people SET granola_status = $3, granola_checked_at = now()
          WHERE id = $2 AND customer_id = $1 AND granola_key_enc IS NOT NULL`,
        [who.customerId, who.personId, status],
      ),
    );
  } catch (err) {
    console.error(`monsoon: recordGranolaStatus failed (${err instanceof Error ? err.constructor.name : "Error"})`);
  }
}

/**
 * Disconnects: the four columns go back to empty (an UPDATE; the person stays). An activity row is
 * written when there was a key. False when the person is not this customer's.
 */
export async function disconnectGranolaKey(who: Who): Promise<boolean> {
  return withAccountsDb(async (db) => {
    await db.query("BEGIN");
    try {
      const before = await db.query(
        "SELECT granola_key_enc IS NOT NULL AS had_key FROM people WHERE id = $2 AND customer_id = $1 FOR UPDATE",
        [who.customerId, who.personId],
      );
      if (before.rowCount !== 1) {
        await db.query("ROLLBACK");
        return false;
      }
      await db.query(
        `UPDATE people
            SET granola_key_enc = NULL, granola_status = NULL, granola_checked_at = NULL, granola_key_set_at = NULL
          WHERE id = $2 AND customer_id = $1`,
        [who.customerId, who.personId],
      );
      if (before.rows[0].had_key) await db.query(RECORD, [who.customerId, who.personId]);
      await db.query("COMMIT");
      return true;
    } catch (err) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
  });
}

/**
 * The key for Ask, or null: no key, a person or customer that is not active, a key that will not
 * decrypt, any error, or a lookup longer than `timeoutMs` (3 seconds unless given). Never rejects
 * and never logs: meetings are a help to Ask, not a need.
 */
export async function readGranolaKeyForAsk(who: Who, opts?: { timeoutMs?: number }): Promise<string | null> {
  const timeoutMs = Math.max(1, Math.floor(opts?.timeoutMs ?? ASK_TIMEOUT_MS));
  const lookup = (async (): Promise<string | null> => {
    const enc = await withAccountsDb(async (db) => {
      // The limit is set inside a transaction, so it also holds behind a pooler in transaction mode.
      await db.query("BEGIN READ ONLY");
      try {
        await db.query("SELECT set_config('statement_timeout', $1, true)", [String(timeoutMs)]);
        const r = await db.query(
          `SELECT p.granola_key_enc
             FROM people p JOIN customers c ON c.id = p.customer_id
            WHERE p.id = $2 AND p.customer_id = $1 AND p.status = 'active' AND c.status = 'active'`,
          [who.customerId, who.personId],
        );
        return (r.rows[0]?.granola_key_enc as string | null | undefined) ?? null;
      } finally {
        await db.query("ROLLBACK").catch(() => undefined);
      }
    });
    return enc === null ? null : decryptSecret(enc, who.customerId, field(who));
  })().catch(() => null);
  // The statement limit does not cover connecting, so the whole lookup is also raced against a timer.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([lookup, expired]);
  } finally {
    clearTimeout(timer);
  }
}
