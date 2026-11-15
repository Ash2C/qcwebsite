// The signed-in customer and person. Every route gets one from requireAccount. Secrets stay
// encrypted on this object; withDb and anthropic decrypt them for one call and drop them.
import Anthropic from "@anthropic-ai/sdk";
import type { Client } from "pg";
import { SESSION_COOKIE, accountsConfigured, cookieValue, verifySession } from "../auth";
import { withPipelineDb } from "../db";
import { decryptSecret } from "./crypto";
import { NotConnected } from "./not-connected";
import {
  loadAccountRows,
  recordActivity,
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

  let rows: Awaited<ReturnType<typeof loadAccountRows>>;
  try {
    rows = await loadAccountRows(claims.customerId, claims.personId);
  } catch (err) {
    // Name and code only: the message can carry connection details.
    console.error(
      "monsoon: account lookup failed",
      err instanceof Error ? err.name : "error",
      (err as { code?: string })?.code ?? "",
    );
    return refuse("Could not reach the accounts database", 502);
  }
  if (
    !rows ||
    rows.customer.status !== "active" ||
    rows.person.status !== "active" ||
    rows.person.sessionNo !== claims.sessionNo
  ) {
    return refuse("unauthorized", 401);
  }
  return { ok: true, account: buildAccount(rows) };
}
