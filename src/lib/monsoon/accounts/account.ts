// The signed-in customer and person. Every route gets one from requireAccount. Secrets stay
// encrypted on this object; withDb and anthropic decrypt them for one call and drop them.
import Anthropic from "@anthropic-ai/sdk";
import type { Client } from "pg";
import { SESSION_COOKIE, accountsConfigured, cookieValue, verifySession } from "../auth";
import { withPipelineDb } from "../db";
import { claudeFailure } from "../claude-failure";
import { decryptSecret } from "./crypto";
import { NotConnected, TrialPaused } from "./not-connected";
import { sharedPipelineIsOwn } from "./shared-names";
import type { Viewer } from "../todos";
import {
  evictAccount,
  loadAccountRows,
  recordActivity,
  recordClaudeStatus,
  type ClaudeStatus,
  withAccountsDb,
  activeOwnerKeys,
  type ActivityAction,
  type CustomerRow,
  type PersonRow,
  type PipelineRow,
} from "./store";
import { beginTrialUse, noteTrialKey, trialKey, type AiKind } from "./trial";

export type PipelineInfo = { key: string; label: string; defaultRole: string; connected: boolean };

export type Account = {
  customer: { id: string; code: string; name: string; model: string };
  person: { id: string; name: string; ownerKey: string };
  pipelines: PipelineInfo[];
  pipeline(key: unknown): PipelineInfo | undefined;
  withDb<T>(key: string, fn: (db: Client) => Promise<T>): Promise<T>;
  /**
   * Await once per request, before the first Claude call. With a key of its own the customer needs
   * nothing and this does nothing. On the free trial it records one use and lets anthropic() use
   * the trial key for this request only. Otherwise (no trial, or a trial that is over) it changes
   * nothing: anthropic() then throws NotConnected("Claude key") as before. Throws TrialPaused while
   * the trial key is failing.
   */
  beginAi(kind: AiKind): Promise<void>;
  /** Throws NotConnected("Claude key") with no key of its own and no trial use granted by beginAi. */
  anthropic(opts: { timeout: number }): Anthropic;
  model(): string;
  /** Who is looking at the to-do list: this person, and the owner keys of the customer's active people. Cached for the request. */
  viewer(): Promise<Viewer>;
  record(action: ActivityAction, pipelineKey?: string | null): Promise<void>;
  /** True for the one person who may change the customer's Claude key. */
  canChangeKey: boolean;
  /**
   * Call after every real Claude call: with nothing when it worked, with the error when it failed.
   * Keeps the customer's "last real result" (what the app's chip shows). Never throws.
   */
  noteClaude(err?: unknown): Promise<void>;
  /**
   * What a failed AI call should be reported as: `err` itself, except that the trial key being
   * refused (401) or out of credit is the trial being paused, not a fault in the customer's key, and
   * any other refusal of a trial call (403) is an ordinary failure.
   */
  aiError(err: unknown): unknown;
};

// A status that has not changed is written again only this often, to keep "last checked" fresh.
const RECHECK_MS = 10 * 60_000;

// Lives in its own file so the test helper can share the class without importing this module.
export { NotConnected, TrialPaused };

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
  // The free trial, for this account object only (one per request). The trial key is handed out
  // only after beginAi recorded a use here: a route that forgets the gate gets no key.
  let trialGranted = false;
  let trialProbe = false;
  let trialUsed = false;
  let viewerPromise: Promise<Viewer> | null = null;
  // Which of the key's own faults `err` is, if any.
  const keyFault = (err: unknown): ClaudeStatus | null => {
    const reason = claudeFailure(err);
    return reason === "claude_key_rejected" ? "key_rejected" : reason === "claude_no_credit" ? "no_credit" : null;
  };
  // The same for a call made with the trial key, which every trial client shares: only a 401 says
  // the key itself is refused. A 403 can be a permission one feature lacks (a tool not enabled for
  // the organisation), so it must not pause the trial for everyone.
  const trialKeyFault = (err: unknown): ClaudeStatus | null => {
    const fault = keyFault(err);
    return fault === "key_rejected" && (err as { status?: unknown } | null)?.status !== 401 ? null : fault;
  };

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
      return connectPipeline(decryptSecret(row.dbUrlEnc, customer.id, `pipeline:${row.id}`), row.sharedSchema, customer.id, fn);
    },
    async beginAi(kind) {
      if (customer.claudeKeyEnc !== null || trialGranted) return;
      const use = await beginTrialUse(customer.id, person.id, kind);
      trialGranted = use.granted;
      trialProbe = use.probe;
    },
    anthropic({ timeout }) {
      if (customer.claudeKeyEnc === null) {
        const key = trialGranted ? trialKey() : null;
        if (key === null) throw new NotConnected("Claude key");
        trialUsed = true;
        return new Anthropic({ apiKey: key, timeout, maxRetries: 0 });
      }
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
    viewer() {
      viewerPromise ??= activeOwnerKeys(customer.id).then((keys) => {
        const appOwnerKeys = [...new Set([person.ownerKey, ...keys])];
        return { ownerKey: person.ownerKey, appOwnerKeys, solo: appOwnerKeys.length === 1 };
      });
      // A failed lookup is not kept: the next call asks again.
      viewerPromise.catch(() => {
        viewerPromise = null;
      });
      return viewerPromise;
    },
    record(action, pipelineKey = null) {
      return recordActivity({ customerId: customer.id, personId: person.id, pipelineKey, action });
    },
    canChangeKey: customer.keyPersonId !== null && customer.keyPersonId === person.id,
    async noteClaude(...args) {
      // A missing key, a busy Claude or another failure says nothing about the key.
      if (customer.claudeKeyEnc === null) {
        // The call, if there was one, used the trial key: its result is never written onto the customer.
        const health = args.length === 0 ? "ok" : trialKeyFault(args[0]);
        if (trialUsed && health !== null) await noteTrialKey(health, trialProbe);
        return;
      }
      const status = args.length === 0 ? "ok" : keyFault(args[0]);
      if (status === null) return;
      const fresh = customer.claudeCheckedAt !== null && Date.now() - customer.claudeCheckedAt.getTime() < RECHECK_MS;
      if (customer.claudeStatus === status && fresh) return;
      await recordClaudeStatus(customer.id, status);
    },
    aiError(err) {
      if (!trialUsed || keyFault(err) === null) return err;
      // A refusal that is not the trial key's own fault is an ordinary failure: the client has no
      // key of its own to be told about, so the status that would name one is left off.
      return trialKeyFault(err) !== null ? new TrialPaused() : new Error("Claude refused the request");
    },
  };
}

/**
 * A pipeline with a database of its own connects as before. A pipeline in the shared database
 * connects only when its stored schema and login are the ones derived from this customer's id, and
 * with the search path set on the connection.
 */
function connectPipeline<T>(dbUrl: string, sharedSchema: string | null, customerId: string, fn: (db: Client) => Promise<T>): Promise<T> {
  if (sharedSchema === null) return withPipelineDb(dbUrl, fn);
  if (!sharedPipelineIsOwn(customerId, sharedSchema, dbUrl)) throw new NotConnected("Pipeline");
  return withPipelineDb(dbUrl, fn, sharedSchema);
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
      `SELECT c.id AS customer_id, p.id AS pipeline_id, p.db_url_enc, p.shared_schema
         FROM customers c JOIN pipelines p ON p.customer_id = c.id
        WHERE c.code = $1 AND c.status = 'active' AND p.key = $2`,
      [code.toLowerCase(), key],
    );
    return r.rows[0] as { customer_id: string; pipeline_id: string; db_url_enc: string | null; shared_schema: string | null } | undefined;
  });
  if (!row || row.db_url_enc === null) throw new NotConnected("Pipeline");
  const dbUrl = decryptSecret(row.db_url_enc, row.customer_id, `pipeline:${row.pipeline_id}`);
  return connectPipeline(dbUrl, row.shared_schema ?? null, row.customer_id, fn);
}
