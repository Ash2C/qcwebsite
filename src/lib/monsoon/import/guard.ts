// Bulk import: one import running per person at a time. The guard is a transaction-scoped advisory
// lock held on a connection of its own for as long as the work runs. It is let go when that
// transaction ends, which also happens when the request dies and its connection closes, and it
// behaves the same behind a pooler that hands out a server connection per transaction.
import type { ClientBase } from "pg";

export type Guarded<T> = { locked: false } | { locked: true; value: T };

/**
 * Runs `work` unless this person already has an import running in this CRM (then `locked: false`,
 * at once, without waiting). `db` must not be the connection `work` uses: it stays inside a
 * transaction until the work is done.
 */
export async function withImportLock<T>(db: ClientBase, personId: string, work: () => Promise<T>): Promise<Guarded<T>> {
  await db.query("BEGIN");
  try {
    const got = await db.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS got", [
      `monsoon-import-running:${personId}`,
    ]);
    if (got.rows[0]?.got !== true) return { locked: false };
    return { locked: true, value: await work() };
  } finally {
    // Nothing was written on this connection; ending the transaction lets the lock go.
    await db.query("ROLLBACK").catch(() => undefined);
  }
}
