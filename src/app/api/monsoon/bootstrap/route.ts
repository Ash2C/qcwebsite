import { createHash, timingSafeEqual } from "node:crypto";
import { assertAllowedDbUrl } from "@/lib/monsoon/accounts/address";
import { encryptSecret, masterKeyConfigured } from "@/lib/monsoon/accounts/crypto";
import { clearAccountCache, recordActivity, withAccountsDb } from "@/lib/monsoon/accounts/store";

// One-time route: turns Vincent's existing env settings (two CRM addresses and his Claude key) into
// encrypted values on customer `quantcloud`. Only the server holds the master key, so this has to run
// here. Answers 404 to anyone without MONSOON_BOOTSTRAP_TOKEN; that setting is removed once it has run.
// Never echoes a value: refusals carry a fixed short reason, success carries { ok: true } only.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADER = "x-monsoon-bootstrap";
const MIN_TOKEN = 32;
const CODE = "quantcloud";
const PIPELINES = [
  { key: "traxo", env: "TRAXO_CRM_DATABASE_URL" },
  { key: "zeroone", env: "ZEROONE_CRM_DATABASE_URL" },
] as const;

function answer(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Both sides hashed first, so the compare takes the same time whatever the lengths. */
function tokenMatches(request: Request): boolean {
  const expected = process.env.MONSOON_BOOTSTRAP_TOKEN ?? "";
  const given = request.headers.get(HEADER);
  const ok = timingSafeEqual(sha256(expected), sha256(given ?? ""));
  return ok && expected.length >= MIN_TOKEN && given !== null;
}

class Refusal extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "Refusal";
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!tokenMatches(request)) return answer({ error: "Not found" }, 404);
  if (!masterKeyConfigured() || !process.env.MONSOON_ACCOUNTS_DATABASE_URL) {
    return answer({ error: "Not configured" }, 409);
  }

  const claudeKey = process.env.ANTHROPIC_API_KEY ?? "";
  const urls = PIPELINES.map((p) => process.env[p.env] ?? "");
  if (!claudeKey || urls.some((u) => !u)) return answer({ error: "Settings missing" }, 409);
  try {
    for (const u of urls) assertAllowedDbUrl(u);
  } catch {
    return answer({ error: "Address not allowed" }, 409);
  }

  try {
    const customerId = await withAccountsDb(async (db) => {
      await db.query("BEGIN");
      try {
        const c = await db.query("SELECT id, claude_key_enc FROM customers WHERE code = $1 FOR UPDATE", [CODE]);
        if (c.rowCount === 0) throw new Refusal("Customer not found");
        const id = c.rows[0].id as string;
        const p = await db.query(
          "SELECT id, key, connected_at FROM pipelines WHERE customer_id = $1 AND key = ANY($2::text[]) FOR UPDATE",
          [id, PIPELINES.map((x) => x.key)],
        );
        const rows = PIPELINES.map((x) => p.rows.find((r) => r.key === x.key) as { id: string; connected_at: Date | null } | undefined);
        if (rows.some((r) => !r)) throw new Refusal("Pipelines not found");
        if (c.rows[0].claude_key_enc !== null && rows.every((r) => r!.connected_at !== null)) {
          throw new Refusal("Already done");
        }
        await db.query("UPDATE customers SET claude_key_enc = $1 WHERE id = $2", [
          encryptSecret(claudeKey, id, "claude_key"),
          id,
        ]);
        for (const [i, row] of rows.entries()) {
          await db.query("UPDATE pipelines SET db_url_enc = $1, connected_at = now() WHERE id = $2 AND customer_id = $3", [
            encryptSecret(urls[i], id, `pipeline:${row!.id}`),
            row!.id,
            id,
          ]);
        }
        await db.query("COMMIT");
        return id;
      } catch (err) {
        await db.query("ROLLBACK").catch(() => undefined);
        throw err;
      }
    });
    clearAccountCache();
    await recordActivity({ customerId, personId: null, pipelineKey: null, action: "setup" });
    return answer({ ok: true }, 200);
  } catch (err) {
    if (err instanceof Refusal) return answer({ error: err.reason }, 409);
    // Name and code only: the message can carry connection details.
    const code = (err as { code?: unknown })?.code;
    console.error(
      "monsoon: bootstrap failed",
      err instanceof Error ? err.name : "error",
      typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : "",
    );
    return answer({ error: "Could not reach the accounts database" }, 502);
  }
}
