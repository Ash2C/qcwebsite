// One-time setup link. A `host` link carries the database details (submitted by Monsoon's own
// admin tool); a `key` link carries the customer's Claude key. Each is checked, then stored encrypted. No credential is
// ever logged or returned: log lines carry the error class name and Postgres code only.
import Anthropic from "@anthropic-ai/sdk";
import type { Client } from "pg";
import { accountsConfigured } from "@/lib/monsoon/auth";
import { AddressError, buildPoolerUrl } from "@/lib/monsoon/accounts/address";
import { encryptSecret, hashToken } from "@/lib/monsoon/accounts/crypto";
import {
  SETUP_MESSAGES,
  SETUP_SUCCESS,
  runSetupChecks,
  type SetupFailure,
} from "@/lib/monsoon/accounts/setup-check";
import { SETUP_EXPIRED, SETUP_MAX_ATTEMPTS, SETUP_TOKEN } from "@/lib/monsoon/accounts/setup-link";
import { clearAccountCache, withAccountsDb } from "@/lib/monsoon/accounts/store";
import { readJson } from "@/lib/monsoon/body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BODY = 4096;
const MAX_ATTEMPTS = SETUP_MAX_ATTEMPTS;
const ROLE_NAME = "monsoon_app";
const TOKEN = SETUP_TOKEN;
const EXPIRED = SETUP_EXPIRED;
const TOO_MANY = "Too many attempts. Ask for a new setup link.";

function reply(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
const invalid = () => reply({ error: "Invalid request" }, 400);
const expired = () => reply({ error: EXPIRED }, 410);
const failed = (failure: SetupFailure) => reply({ error: SETUP_MESSAGES[failure], failure }, 422);

function logError(where: string, err: unknown): void {
  const name = err instanceof Error ? err.name : "error";
  const code = (err as { code?: unknown })?.code;
  console.error(`monsoon: setup ${where} failed`, name, typeof code === "string" ? code.slice(0, 5) : "");
}

async function tryClaude(apiKey: string): Promise<boolean> {
  try {
    await new Anthropic({ apiKey, timeout: 15_000, maxRetries: 0 }).messages.create({
      model: "claude-haiku-5-5",
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    });
    return true;
  } catch {
    // 401/403 mean a bad key; a network or server error cannot confirm it either.
    return false;
  }
}

type Link = {
  id: string;
  customerId: string;
  pipelineId: string | null;
  pipelineKey: string | null;
  defaultRole: string | null;
  claudeKeyOnFile: boolean;
  purpose: "host" | "key";
};

/** Counts this attempt first, in its own statement, so failed checks still use one up. */
async function claimAttempt(tokenHash: string): Promise<Link | "expired" | "too_many"> {
  // Legacy connect/replace links are expired for every purpose: they neither count nor load.
  return withAccountsDb(async (db) => {
    const r = await db.query(
      `UPDATE setup_links l SET attempts = attempts + 1
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() AND attempts < $2
          AND purpose IN ('host', 'key')
        RETURNING l.id, l.customer_id, l.pipeline_id, l.purpose,
                  (SELECT p.key FROM pipelines p WHERE p.id = l.pipeline_id AND p.customer_id = l.customer_id) AS pipeline_key,
                  (SELECT p.default_role FROM pipelines p WHERE p.id = l.pipeline_id AND p.customer_id = l.customer_id) AS default_role,
                  (SELECT c.claude_key_enc IS NOT NULL FROM customers c WHERE c.id = l.customer_id) AS claude_key_on_file`,
      [tokenHash, MAX_ATTEMPTS],
    );
    if (r.rowCount === 1) {
      const row = r.rows[0];
      return {
        id: row.id,
        customerId: row.customer_id,
        pipelineId: row.pipeline_id,
        pipelineKey: row.pipeline_key,
        defaultRole: row.default_role,
        claudeKeyOnFile: row.claude_key_on_file === true,
        purpose: row.purpose,
      };
    }
    const spent = await db.query(
      "SELECT 1 FROM setup_links WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() AND attempts >= $2 AND purpose IN ('host', 'key')",
      [tokenHash, MAX_ATTEMPTS],
    );
    return spent.rowCount ? "too_many" : "expired";
  });
}

/** One transaction: the link is consumed first, so two racing submissions cannot both store. */
async function store(link: Link, dbUrl: string | null, projectRef: string | null, claudeKey: string | null): Promise<boolean | "project_taken"> {
  const dbUrlEnc = dbUrl === null ? null : encryptSecret(dbUrl, link.customerId, `pipeline:${link.pipelineId}`);
  const claudeKeyEnc = claudeKey === null ? null : encryptSecret(claudeKey, link.customerId, "claude_key");
  return withAccountsDb(async (db: Client) => {
    await db.query("BEGIN");
    try {
      const used = await db.query(
        "UPDATE setup_links SET used_at = now() WHERE id = $1 AND used_at IS NULL AND expires_at > now() RETURNING id",
        [link.id],
      );
      if (used.rowCount !== 1) {
        await db.query("ROLLBACK");
        return false;
      }
      if (dbUrlEnc !== null) {
        const p = await db.query(
          "UPDATE pipelines SET db_url_enc = $1, connected_at = now(), project_ref = $4 WHERE id = $2 AND customer_id = $3",
          [dbUrlEnc, link.pipelineId, link.customerId, projectRef],
        );
        if (p.rowCount !== 1) throw new Error("Pipeline not found");
      }
      if (claudeKeyEnc !== null) {
        await db.query(
          "UPDATE customers SET claude_key_enc = $1, claude_status = 'ok', claude_checked_at = now(), claude_key_set_at = now(), claude_key_set_by = NULL WHERE id = $2",
          [claudeKeyEnc, link.customerId],
        );
      }
      await db.query("INSERT INTO activity (customer_id, person_id, pipeline_key, action) VALUES ($1, NULL, $2, $3)", [
        link.customerId,
        link.pipelineKey,
        link.purpose,
      ]);
      await db.query("COMMIT");
      return true;
    } catch (err) {
      await db.query("ROLLBACK").catch(() => undefined);
      const e = err as { code?: unknown; table?: unknown };
      if (e.code === "23505" && e.table === "pipelines") return "project_taken";
      throw err;
    }
  });
}

type Input = { token: string; projectRef: string; poolerHost: string; password: string; claudeKey: string };

function parseBody(raw: unknown): Input | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  const text = (v: unknown): string | null => (v === undefined || v === null ? "" : typeof v === "string" ? v : null);
  const fields = [b.token, b.projectRef, b.poolerHost, b.password, b.claudeKey].map(text);
  if (fields.some((f) => f === null)) return null;
  const [token, projectRef, poolerHost, password, claudeKey] = fields as string[];
  return { token, projectRef: projectRef.trim(), poolerHost: poolerHost.trim(), password, claudeKey: claudeKey.trim() };
}

export async function POST(request: Request): Promise<Response> {
  if (!accountsConfigured()) return reply({ error: "Monsoon is not configured" }, 500);

  const read = await readJson(request, MAX_BODY);
  if (!read.ok) return invalid();
  const input = parseBody(read.body);
  if (!input) return invalid();
  // Not a token Monsoon could have issued: no database lookup.
  if (!TOKEN.test(input.token)) return expired();

  let link: Awaited<ReturnType<typeof claimAttempt>>;
  try {
    link = await claimAttempt(hashToken(input.token));
  } catch (err) {
    logError("lookup", err);
    return reply({ error: "Could not reach the accounts database" }, 502);
  }
  if (link === "expired") return expired();
  if (link === "too_many") return reply({ error: TOO_MANY }, 429);

  const wantsDb = input.projectRef !== "" || input.poolerHost !== "" || input.password !== "";
  const claudeKey = input.claudeKey === "" ? null : input.claudeKey;
  let dbUrl: string | null = null;
  let projectRef: string | null = null;

  if (link.purpose === "host") {
    if (link.pipelineId === null || link.pipelineKey === null) return invalid();
    if (input.projectRef === "" || input.poolerHost === "" || input.password === "") return failed("connect");
    try {
      dbUrl = buildPoolerUrl(input);
    } catch (err) {
      if (err instanceof AddressError && err.code === "bad_host") return failed("address");
      return failed("connect");
    }
    projectRef = input.projectRef;
    const result = await runSetupChecks({
      dbUrl,
      claudeKey: null,
      roleName: ROLE_NAME,
      defaultRole: link.defaultRole ?? "",
      tryClaude,
    });
    if (!result.ok) return failed(result.failure);
  } else {
    if (wantsDb) return invalid();
    if (claudeKey === null || !(await tryClaude(claudeKey))) return failed("claude_key");
  }

  let saved: boolean | "project_taken";
  try {
    saved = await store(link, dbUrl, projectRef, link.purpose === "key" ? claudeKey : null);
  } catch (err) {
    logError("store", err);
    return reply({ error: "Could not reach the accounts database" }, 502);
  }
  if (saved === "project_taken") return reply({ error: "That project is already used by another pipeline." }, 409);
  if (!saved) return expired();
  clearAccountCache();
  return reply({ ok: true, message: SETUP_SUCCESS }, 200);
}
