// Accounts database access: customer and person lookups, a 60-second cache of encrypted rows,
// sign-in attempts and activity. Holds no contact data. Nothing here decrypts anything.
import { Client } from "pg";
import { clientConfig } from "../db";

export type ActivityAction =
  | "sign_in"
  | "capture"
  | "batch_save"
  | "tidy"
  | "ask"
  | "act_note"
  | "act_stage"
  | "act_details"
  | "act_research"
  | "research"
  | "setup"
  | "replace"
  | "host"
  | "key"
  | "profile";

export type PipelineRow = {
  id: string;
  key: string;
  label: string;
  defaultRole: string;
  position: number;
  dbUrlEnc: string | null;
};

export type CustomerRow = {
  id: string;
  code: string;
  name: string;
  status: "active" | "suspended";
  model: string;
  claudeKeyEnc: string | null;
  /** The one person who may change the Claude key. */
  keyPersonId: string | null;
  /** The last real Claude result; null when nothing has been recorded since the key was saved. */
  claudeStatus: ClaudeStatus | null;
  claudeCheckedAt: Date | null;
};

export type ClaudeStatus = "ok" | "key_rejected" | "no_credit";

export type PersonRow = {
  id: string;
  customerId: string;
  displayName: string;
  ownerKey: string;
  passcodeHash: string;
  sessionNo: number;
  status: "active" | "suspended";
};

const CACHE_MS = 60_000;

/** One connection per call, always closed. The URL never appears in an error. */
export async function withAccountsDb<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const url = process.env.MONSOON_ACCOUNTS_DATABASE_URL;
  if (!url) throw new Error("MONSOON_ACCOUNTS_DATABASE_URL is not set");
  const client = new Client(clientConfig(url));
  try {
    await client.connect();
    return await fn(client);
  } finally {
    try {
      await client.end();
    } catch {
      // An error while closing must not mask the original outcome.
    }
  }
}

const CUSTOMER_COLUMNS = "id, code, name, status, model, claude_key_enc, key_person_id, claude_status, claude_checked_at";
const PERSON_COLUMNS = "id, customer_id, display_name, owner_key, passcode_hash, session_no, status";

type Raw = Record<string, unknown>;

function toCustomer(r: Raw): CustomerRow {
  return {
    id: r.id as string,
    code: r.code as string,
    name: r.name as string,
    status: r.status as CustomerRow["status"],
    model: r.model as string,
    claudeKeyEnc: (r.claude_key_enc as string | null) ?? null,
    keyPersonId: (r.key_person_id as string | null) ?? null,
    claudeStatus: (r.claude_status as ClaudeStatus | null) ?? null,
    claudeCheckedAt: (r.claude_checked_at as Date | null) ?? null,
  };
}

function toPerson(r: Raw): PersonRow {
  return {
    id: r.id as string,
    customerId: r.customer_id as string,
    displayName: r.display_name as string,
    ownerKey: r.owner_key as string,
    passcodeHash: r.passcode_hash as string,
    sessionNo: r.session_no as number,
    status: r.status as PersonRow["status"],
  };
}

function toPipeline(r: Raw): PipelineRow {
  return {
    id: r.id as string,
    key: r.key as string,
    label: r.label as string,
    defaultRole: r.default_role as string,
    position: r.position as number,
    dbUrlEnc: (r.db_url_enc as string | null) ?? null,
  };
}

export async function findCustomerByCode(
  db: Client,
  code: string,
): Promise<{ customer: CustomerRow; people: PersonRow[] } | null> {
  const c = await db.query(`SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE code = $1`, [code.toLowerCase()]);
  if (c.rowCount === 0) return null;
  const customer = toCustomer(c.rows[0]);
  const p = await db.query(`SELECT ${PERSON_COLUMNS} FROM people WHERE customer_id = $1 ORDER BY created_at, id`, [
    customer.id,
  ]);
  return { customer, people: p.rows.map(toPerson) };
}

type AccountRows = { customer: CustomerRow; person: PersonRow; pipelines: PipelineRow[] };
const cache = new Map<string, { at: number; value: AccountRows }>();

export function clearAccountCache(): void {
  cache.clear();
}

/** Drops every cached row of one customer (after its Claude key or key status changed). */
export function evictCustomer(customerId: string): void {
  for (const key of cache.keys()) if (key.startsWith(`${customerId}:`)) cache.delete(key);
}

/** Never throws; logs the error class name only. Records the result of a real Claude call. */
export async function recordClaudeStatus(customerId: string, status: ClaudeStatus): Promise<void> {
  try {
    await withAccountsDb((db) =>
      db.query("UPDATE customers SET claude_status = $2, claude_checked_at = now() WHERE id = $1", [customerId, status]),
    );
    evictCustomer(customerId);
  } catch (err) {
    console.error(`monsoon: recordClaudeStatus failed (${err instanceof Error ? err.constructor.name : "Error"})`);
  }
}

/** Drops one person's cached rows, so the next lookup reads the database (after a fresh sign-in). */
export function evictAccount(customerId: string, personId: string): void {
  cache.delete(`${customerId}:${personId}`);
}

/** Cached for 60 seconds per customer and person. The cache holds encrypted strings only. */
export async function loadAccountRows(customerId: string, personId: string): Promise<AccountRows | null> {
  const key = `${customerId}:${personId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await withAccountsDb(async (db): Promise<AccountRows | null> => {
    const c = await db.query(`SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE id = $1`, [customerId]);
    const p = await db.query(`SELECT ${PERSON_COLUMNS} FROM people WHERE id = $1 AND customer_id = $2`, [
      personId,
      customerId,
    ]);
    if (c.rowCount === 0 || p.rowCount === 0) return null;
    const pl = await db.query(
      "SELECT id, key, label, default_role, position, db_url_enc FROM pipelines WHERE customer_id = $1 ORDER BY position, key",
      [customerId],
    );
    return { customer: toCustomer(c.rows[0]), person: toPerson(p.rows[0]), pipelines: pl.rows.map(toPipeline) };
  });
  if (value) cache.set(key, { at: Date.now(), value });
  else cache.delete(key);
  return value;
}

/** Failed attempts since the epoch-millisecond time `sinceMs`: for the pair and for the code alone. */
export async function failuresSince(
  db: Client,
  code: string,
  addressHash: string,
  sinceMs: number,
): Promise<{ pair: number; code: number }> {
  const r = await db.query(
    `SELECT count(*) FILTER (WHERE address_hash = $2)::int AS pair, count(*)::int AS code
       FROM sign_in_attempts
      WHERE code = $1 AND ok = false AND at >= to_timestamp($3::double precision / 1000.0)`,
    [code, addressHash, sinceMs],
  );
  return { pair: r.rows[0].pair, code: r.rows[0].code };
}

async function pruneAttempts(db: Client): Promise<void> {
  await db.query("DELETE FROM sign_in_attempts WHERE at < now() - interval '30 days'");
}

export async function recordAttempt(
  db: Client,
  a: { code: string; personId: string | null; addressHash: string; ok: boolean },
): Promise<void> {
  await db.query("INSERT INTO sign_in_attempts (code, person_id, address_hash, ok) VALUES ($1, $2, $3, $4)", [
    a.code,
    a.personId,
    a.addressHash,
    a.ok,
  ]);
  await pruneAttempts(db);
}

/**
 * Records a provisional failed attempt before anything is checked, so concurrent attempts each see
 * the others when they count. Returns its id; settle it with `settleAttempt`.
 */
export async function beginAttempt(db: Client, a: { code: string; addressHash: string }): Promise<string> {
  const r = await db.query(
    "INSERT INTO sign_in_attempts (code, person_id, address_hash, ok) VALUES ($1, NULL, $2, false) RETURNING id",
    [a.code, a.addressHash],
  );
  await pruneAttempts(db);
  return String(r.rows[0].id);
}

/**
 * Settles a provisional attempt: `true` signed in, `null` refused while locked (kept as a record but
 * not counted, so a locked person does not extend their own lock). A failure stays `false`.
 */
export async function settleAttempt(db: Client, id: string, ok: true | null, personId: string | null = null): Promise<void> {
  await db.query("UPDATE sign_in_attempts SET ok = $2, person_id = $3 WHERE id = $1", [id, ok, personId]);
}

/** Never throws; logs the error class name only. */
export async function recordActivity(a: {
  customerId: string;
  personId: string | null;
  pipelineKey: string | null;
  action: ActivityAction;
}): Promise<void> {
  try {
    await withAccountsDb((db) =>
      db.query("INSERT INTO activity (customer_id, person_id, pipeline_key, action) VALUES ($1, $2, $3, $4)", [
        a.customerId,
        a.personId,
        a.pipelineKey,
        a.action,
      ]),
    );
  } catch (err) {
    console.error(`monsoon: recordActivity failed (${err instanceof Error ? err.constructor.name : "Error"})`);
  }
}
