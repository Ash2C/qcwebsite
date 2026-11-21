// The signed-in customer and person. Every route gets one from requireAccount. Secrets stay
// encrypted on this object; withDb and anthropic decrypt them for one call and drop them.
import Anthropic from "@anthropic-ai/sdk";
import type { Client } from "pg";
import { SESSION_COOKIE, accountsConfigured, cookieValue, verifySession } from "../auth";
import { withPipelineDb } from "../db";
import { decryptSecret } from "./crypto";
import { NotConnected } from "./not-connected";
import {
  evictAccount,
  loadAccountRows,
  recordActivity,
  withAccountsDb,
  type ActivityAction,
  type CustomerRow,
  type PersonRow,
  type PipelineRow,
} from "./store";

export type PipelineInfo = { key: string; label: string; defaultRole: string; connected: boolean };

export type Account = {
  customer: { id: string; code: string; name: string; model: string };
  person: { id: string; name: string; ownerKey: string };
  pipelines: PipelineInfo[];
  pipeline(key: unknown): PipelineInfo | undefined;
  withDb<T>(key: string, fn: (db: Client) => Promise<T>): Promise<T>;
  anthropic(opts: { timeout: number }): Anthropic;
  model(): string;
  record(action: ActivityAction, pipelineKey?: string | null): Promise<void>;
};

// Lives in its own file so the test helper can share the class without importing this module.
export { NotConnected };

/** The CRM schema version Monsoon needs: max(version) in a customer's schema_migrations. */
export const CRM_SCHEMA_VERSION = 1;

const REFUSED_FOR_QUANTCLOUD = /opus|fable/i;

/** Builds an Account from loaded rows. Exported for the session route; routes use requireAccount. */
export function buildAccount(rows: { customer: CustomerRow; person: PersonRow; pipelines: PipelineRow[] }): Account {
  const { customer, person, pipelines: rawPipelines } = rows;
  const pipelines: PipelineInfo[] = rawPipelines.map((p) => ({
    key: p.key,
    label: p.label,
    defaultRole: p.defaultRole,
    connected: p.dbUrlEnc !== null,
  }));
  // Kept in the closure, not on the object, so a stray JSON.stringify(account) shows nothing encrypted.
  const rowFor = (key: unknown) => (typeof key === "string" ? rawPipelines.find((p) => p.key === key) : undefined);

  return {
    customer: { id: customer.id, code: customer.code, name: customer.name, model: customer.model },
    person: { id: person.id, name: person.displayName, ownerKey: person.ownerKey },
    pipelines,
    pipeline(key) {
      return typeof key === "string" ? pipelines.find((p) => p.key === key) : undefined;
    },
    async withDb(key, fn) {
      const row = rowFor(key);
      if (!row || row.dbUrlEnc === null) throw new NotConnected("Pipeline");
      return withPipelineDb(decryptSecret(row.dbUrlEnc, customer.id, `pipeline:${row.id}`), fn);
    },
    anthropic({ timeout }) {
      if (customer.claudeKeyEnc === null) throw new NotConnected("Claude key");
      return new Anthropic({
        apiKey: decryptSecret(customer.claudeKeyEnc, customer.id, "claude_key"),
        timeout,
        maxRetries: 0,
      });
    },
    model() {
      if (customer.code === "quantcloud" && REFUSED_FOR_QUANTCLOUD.test(customer.model)) {
        throw new Error("This model is not allowed for this customer");
      }
      return customer.model;
    },
    record(action, pipelineKey = null) {
      return recordActivity({ customerId: customer.id, personId: person.id, pipelineKey, action });
    },
  };
}

function refuse(error: string, status: number): { ok: false; response: Response } {
  return { ok: false, response: Response.json({ error }, { status }) };
}

export async function requireAccount(
  request: Request,
): Promise<{ ok: true; account: Account } | { ok: false; response: Response }> {
  if (!accountsConfigured()) return refuse("Monsoon is not configured", 500);
  const claims = verifySession(cookieValue(request, SESSION_COOKIE));
  if (!claims) return refuse("unauthorized", 401);

  const matches = (r: Awaited<ReturnType<typeof loadAccountRows>>): r is NonNullable<typeof r> =>
    r !== null &&
    r.customer.status === "active" &&
    r.person.status === "active" &&
    r.person.sessionNo === claims.sessionNo;

  let rows: Awaited<ReturnType<typeof loadAccountRows>>;
  try {
    rows = await loadAccountRows(claims.customerId, claims.personId);
    if (!matches(rows)) {
      // The cached row may predate a reset or reinstatement made on another server instance.
      // Evict and read the database once; refuse only if the fresh row still does not match.
      evictAccount(claims.customerId, claims.personId);
      rows = await loadAccountRows(claims.customerId, claims.personId);
    }
  } catch (err) {
    // Name and code only: the message can carry connection details.
    console.error(
      "monsoon: account lookup failed",
      err instanceof Error ? err.name : "error",
      (err as { code?: string })?.code ?? "",
    );
    return refuse("Could not reach the accounts database", 502);
  }
  if (!matches(rows)) return refuse("unauthorized", 401);
  return { ok: true, account: buildAccount(rows) };
}

/**
 * Server-internal only (no session): runs fn on customer `code`'s pipeline `key`. Refuses with
 * NotConnected unless the customer is active and the pipeline has a stored address. Never wire this
 * to a value a visitor chooses: callers pass fixed literals.
 */
export async function withCustomerPipelineDb<T>(code: string, key: string, fn: (db: Client) => Promise<T>): Promise<T> {
  const row = await withAccountsDb(async (db) => {
    const r = await db.query(
      `SELECT c.id AS customer_id, p.id AS pipeline_id, p.db_url_enc
         FROM customers c JOIN pipelines p ON p.customer_id = c.id
        WHERE c.code = $1 AND c.status = 'active' AND p.key = $2`,
      [code.toLowerCase(), key],
    );
    return r.rows[0] as { customer_id: string; pipeline_id: string; db_url_enc: string | null } | undefined;
  });
  if (!row || row.db_url_enc === null) throw new NotConnected("Pipeline");
  return withPipelineDb(decryptSecret(row.db_url_enc, row.customer_id, `pipeline:${row.pipeline_id}`), fn);
}
