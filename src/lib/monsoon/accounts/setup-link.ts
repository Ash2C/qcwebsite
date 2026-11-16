// Read-only lookup for the setup page: never consumes the link or counts an attempt.
import { hashToken } from "./crypto";
import { generateSetupScript, type SetupVocabulary } from "./setup-script";
import { withAccountsDb } from "./store";

export const SETUP_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const SETUP_EXPIRED = "This setup link has expired. Ask for a new one.";
export const SETUP_MAX_ATTEMPTS = 10;

export type SetupPage =
  | { kind: "expired" }
  | { kind: "ok"; purpose: "connect" | "replace"; script: string | null; claudeKeyOnFile: boolean };

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";

function vocabulary(vocab: unknown): Pick<SetupVocabulary, "stages" | "roles"> {
  const v = isObj(vocab) ? vocab : {};
  const stages = (Array.isArray(v.stages) ? v.stages : [])
    .filter(isObj)
    .filter((s) => str(s.key) && str(s.label) && Number.isFinite(Number(s.ord)))
    .map((s) => ({ key: s.key as string, ord: Number(s.ord), label: s.label as string, terminal: s.terminal === true }));
  const roles = (Array.isArray(v.roles) ? v.roles : [])
    .filter(isObj)
    .filter((r) => str(r.key) && str(r.label))
    .map((r) => ({ key: r.key as string, label: r.label as string }));
  return { stages, roles };
}

export async function loadSetupPage(token: string): Promise<SetupPage> {
  if (!SETUP_TOKEN.test(token)) return { kind: "expired" };
  return withAccountsDb(async (db) => {
    const r = await db.query(
      `SELECT l.customer_id, l.purpose, p.vocab, (c.claude_key_enc IS NOT NULL) AS claude_key_on_file
         FROM setup_links l
         JOIN customers c ON c.id = l.customer_id
         LEFT JOIN pipelines p ON p.id = l.pipeline_id AND p.customer_id = l.customer_id
        WHERE l.token_hash = $1 AND l.used_at IS NULL AND l.expires_at > now() AND l.attempts < $2`,
      [hashToken(token), SETUP_MAX_ATTEMPTS],
    );
    if (r.rowCount !== 1) return { kind: "expired" };
    const link = r.rows[0];
    const claudeKeyOnFile = link.claude_key_on_file === true;
    if (link.purpose === "replace") return { kind: "ok", purpose: "replace", script: null, claudeKeyOnFile };
    const people = await db.query(
      "SELECT owner_key, display_name FROM people WHERE customer_id = $1 AND status = 'active' ORDER BY created_at, id",
      [link.customer_id],
    );
    const owners = people.rows.map((p) => ({ key: p.owner_key as string, name: p.display_name as string }));
    return {
      kind: "ok",
      purpose: "connect",
      script: generateSetupScript({ ...vocabulary(link.vocab), owners }),
      claudeKeyOnFile,
    };
  });
}
