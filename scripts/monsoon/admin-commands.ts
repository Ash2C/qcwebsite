// Command logic for the Monsoon admin tool. Takes its database and output as dependencies so tests can drive it.
// Never reads the master key, so it can never decrypt or print a stored credential.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClientBase } from "pg";
import { POOLER_HOST, PROJECT_REF } from "../../src/lib/monsoon/accounts/address";
import { generatePasscode, hashPasscode, hashToken, newToken } from "../../src/lib/monsoon/accounts/crypto";
import { generateSetupScript, loginAndPoliciesScript, type SetupVocabulary } from "../../src/lib/monsoon/accounts/setup-script";

export type PostReply = { status: number; body: { ok?: boolean; error?: string; failure?: string } };

export interface AdminDeps {
  db: ClientBase;
  out: (line: string) => void;
  env?: Record<string, string | undefined>;
  readFile?: (path: string) => string;
  now?: () => Date;
  /** Opens a connection to a client's Supabase project as its owner (`host`). */
  connectOwner?: (url: string) => Promise<ClientBase & { end(): Promise<void> }>;
  /** Posts JSON to the live server (`host` submits its setup link there). */
  post?: (url: string, body: Record<string, string>) => Promise<PostReply>;
  randomPassword?: () => string;
  /** Test-only: Postgres roles are cluster-wide, so tests give the login their own name. */
  appRole?: string;
}

const USAGE = [
  "Usage:",
  "  migrate",
  '  customer add <code> "<name>" [--model <id>]',
  '  person add <code> "<display name>" <OWNER> [--passcode-from-env MONSOON_PASSCODE]',
  "  person reset|suspend|resume <code> <OWNER>",
  '  pipeline add <code> <key> "<label>" --default-role <role> --stages <json> --roles <json>',
  "  host <code> <pipeline key> --ref <ref> --pooler <host> --owner-password-from-env <VAR> [--replace]",
  "  link <code>",
  "  script <code> <pipeline key> [--login-only]",
  "  status",
  "  people <code>",
  "  suspend|resume <code>",
  "  forget <code>",
];

const MAX_PEOPLE = 50;
const LINK_DAYS = 7;
const HOST_LINK_MINUTES = 15;
const NOT_CONNECTED = "The pipeline is not connected until host runs again successfully.";
const CODE_RE = /^[a-z0-9-]{3,32}$/;
const KEY_RE = /^[a-z0-9-]{2,32}$/;
const OWNER_RE = /^[A-Z]{2,4}$/;

class Fail extends Error {}
const fail = (msg: string): never => {
  throw new Fail(msg);
};

/** Any flag not listed for the command is refused, so a typo cannot silently change what it does. */
function parseArgs(
  args: string[],
  valueFlags: string[] = [],
  switches: string[] = [],
): { pos: string[]; flags: Map<string, string | true> } {
  const pos: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      if (valueFlags.includes(a)) {
        const v = args[++i];
        if (v === undefined) fail(`${a} needs a value`);
        flags.set(a, v);
      } else if (switches.includes(a)) flags.set(a, true);
      else fail(`unknown flag ${a}`);
    } else pos.push(a);
  }
  return { pos, flags };
}

function need(pos: string[], n: number): void {
  if (pos.length < n) fail("missing arguments");
}

function checkCode(code: string): string {
  if (!CODE_RE.test(code)) fail("company code must be 3-32 characters: a-z, 0-9, hyphen");
  return code;
}
function checkOwner(key: string): string {
  if (!OWNER_RE.test(key)) fail("owner key must be 2-4 capital letters");
  return key;
}

function parseJsonArray(raw: string | true | undefined, flag: string): unknown[] {
  if (typeof raw !== "string") return fail(`${flag} is required`);
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v;
  } catch {
    // fall through
  }
  return fail(`${flag} must be a JSON array`);
}

const VOCAB_KEY_RE = /^[a-z0-9_]{1,40}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const goodLabel = (v: unknown): v is string => typeof v === "string" && v.trim() !== "" && v.length <= 60;

/** The vocabulary the setup script writes into the customer's stages and roles tables. */
function checkVocabulary(stages: unknown[], roles: unknown[], defaultRole: string): void {
  if (stages.length === 0) fail("--stages must list at least one stage");
  const keys = new Set<string>();
  const ords = new Set<number>();
  for (const st of stages) {
    if (!isRecord(st)) return fail("each stage must be an object with key, ord, label, terminal");
    const { key, ord, label, terminal } = st;
    if (typeof key !== "string" || !VOCAB_KEY_RE.test(key)) return fail("stage keys must be 1-40 characters: a-z, 0-9, underscore");
    if (typeof ord !== "number" || !Number.isInteger(ord)) return fail(`stage ${key}: ord must be a whole number`);
    if (!goodLabel(label)) fail(`stage ${key}: label must be 1-60 characters`);
    if (typeof terminal !== "boolean") fail(`stage ${key}: terminal must be true or false`);
    if (keys.has(key)) fail(`stage ${key} is listed twice`);
    if (ords.has(ord)) fail(`stage ord ${ord} is used twice`);
    keys.add(key);
    ords.add(ord);
  }
  if (roles.length === 0) fail("--roles must list at least one role");
  const roleKeys = new Set<string>();
  for (const r of roles) {
    if (!isRecord(r)) return fail("each role must be an object with key and label");
    const { key, label } = r;
    if (typeof key !== "string" || !VOCAB_KEY_RE.test(key)) return fail("role keys must be 1-40 characters: a-z, 0-9, underscore");
    if (!goodLabel(label)) fail(`role ${key}: label must be 1-60 characters`);
    if (roleKeys.has(key)) fail(`role ${key} is listed twice`);
    roleKeys.add(key);
  }
  if (!roleKeys.has(defaultRole)) fail("--default-role must be one of the keys in --roles");
}

function parseEnvFile(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    let v = t.slice(eq + 1).trim();
    if (/^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
    m.set(t.slice(0, eq).trim(), v);
  }
  return m;
}

function errorLine(err: unknown): string {
  if (err instanceof Fail) return `Error: ${err.message}`;
  // Never echo driver messages: they can carry connection details.
  const code = (err as { code?: string } | null)?.code;
  const name = err instanceof Error ? err.name : "Error";
  return `Error: ${name}${typeof code === "string" && code.length === 5 ? ` (${code})` : ""}`;
}

function usage(out: (line: string) => void): number {
  for (const l of USAGE) out(l);
  return 1;
}

export async function runAdmin(argv: string[], deps: AdminDeps): Promise<number> {
  const { db, out } = deps;
  const env = deps.env ?? process.env;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const now = deps.now ?? (() => new Date());

  async function customer(code: string): Promise<{ id: string; name: string }> {
    const r = await db.query("SELECT id, name FROM customers WHERE code = $1", [checkCode(code)]);
    return r.rows[0] ?? fail(`no customer with code ${code}`);
  }
  async function pipeline(customerId: string, key: string) {
    const r = await db.query(
      "SELECT id, vocab, label, project_ref, (db_url_enc IS NOT NULL) AS connected FROM pipelines WHERE customer_id = $1 AND key = $2",
      [customerId, key],
    );
    return r.rows[0] ?? fail(`no pipeline ${key}`);
  }
  /** What the setup script writes: the pipeline's stages and roles, and the customer's active people as owners. */
  async function setupVocabulary(
    customerId: string,
    p: { vocab?: { stages?: SetupVocabulary["stages"]; roles?: SetupVocabulary["roles"] } | null },
  ): Promise<SetupVocabulary> {
    const people = await db.query(
      "SELECT owner_key, display_name FROM people WHERE customer_id = $1 AND status = 'active' ORDER BY owner_key",
      [customerId],
    );
    return {
      stages: p.vocab?.stages ?? [],
      roles: p.vocab?.roles ?? [],
      owners: people.rows.map((r: { owner_key: string; display_name: string }) => ({ key: r.owner_key, name: r.display_name })),
    };
  }
  const publicBase = () => (env.MONSOON_PUBLIC_URL || "https://quantcloud.com").replace(/\/+$/, "");

  try {
    const [cmd, sub] = argv;
    switch (cmd) {
      case "migrate": {
        parseArgs(argv.slice(1));
        const t = await db.query("SELECT to_regclass('public.accounts_migrations') AS t");
        if (t.rows[0].t) {
          const v = await db.query("SELECT 1 FROM accounts_migrations WHERE version = 6");
          if (v.rowCount) {
            out("Schema already applied (version 6).");
            return 0;
          }
        }
        await db.query(readFile(join(process.cwd(), "src", "lib", "monsoon", "accounts", "schema.sql")));
        out("Schema applied (version 6).");
        return 0;
      }
      case "customer": {
        if (sub !== "add") return usage(out);
        const { pos, flags } = parseArgs(argv.slice(2), ["--model"]);
        need(pos, 2);
        const code = checkCode(pos[0]);
        const model = typeof flags.get("--model") === "string" ? (flags.get("--model") as string) : null;
        if (code === "quantcloud" && model && /opus|fable/i.test(model)) fail("that model is not allowed for quantcloud");
        const r = model
          ? await db.query("INSERT INTO customers (code, name, model) VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING RETURNING id", [code, pos[1], model])
          : await db.query("INSERT INTO customers (code, name) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING RETURNING id", [code, pos[1]]);
        if (!r.rowCount) fail(`customer ${code} already exists`);
        out(`Customer ${code} added.`);
        return 0;
      }
      case "person": {
        const { pos, flags } = parseArgs(argv.slice(2), sub === "add" ? ["--passcode-from-env"] : []);
        if (sub === "add") {
          need(pos, 3);
          const c = await customer(pos[0]);
          const owner = checkOwner(pos[2]);
          const count = await db.query("SELECT count(*)::int AS n FROM people WHERE customer_id = $1", [c.id]);
          if (count.rows[0].n >= MAX_PEOPLE) fail(`a customer can have at most ${MAX_PEOPLE} people`);
          let passcode: string;
          const fromEnv = flags.get("--passcode-from-env");
          if (typeof fromEnv === "string") {
            const file = parseEnvFile(readFile(join(homedir(), ".quantcloud", "monsoon.env")));
            passcode = file.get(fromEnv) ?? fail(`${fromEnv} not found in monsoon.env`);
          } else passcode = generatePasscode();
          const hash = await hashPasscode(passcode);
          const r = await db.query(
            "INSERT INTO people (customer_id, display_name, owner_key, passcode_hash) VALUES ($1, $2, $3, $4) ON CONFLICT (customer_id, owner_key) DO NOTHING RETURNING id",
            [c.id, pos[1], owner, hash],
          );
          if (!r.rowCount) fail(`${owner} already exists for ${pos[0]}`);
          // The first person of a customer keeps its Claude key until `keyholder` names someone else.
          await db.query("UPDATE customers SET key_person_id = $2 WHERE id = $1 AND key_person_id IS NULL", [c.id, r.rows[0].id]);
          out(`Person ${owner} added.`);
          if (typeof fromEnv === "string") out(`Passcode set from ${fromEnv}`);
          else {
            out(passcode);
            out("Send this passcode to the person now. It cannot be shown again.");
          }
          return 0;
        }
        if (sub === "reset" || sub === "suspend" || sub === "resume") {
          need(pos, 2);
          const c = await customer(pos[0]);
          const owner = checkOwner(pos[1]);
          let r;
          if (sub === "reset") {
            const passcode = generatePasscode();
            r = await db.query(
              // A reset can hand the seat to someone else: their Granola connection does not go with it.
              "UPDATE people SET passcode_hash = $3, session_no = session_no + 1, granola_key_enc = NULL, granola_status = NULL, granola_checked_at = NULL, granola_key_set_at = NULL WHERE customer_id = $1 AND owner_key = $2 RETURNING id",
              [c.id, owner, await hashPasscode(passcode)],
            );
            if (r.rowCount) {
              out(passcode);
              out("Send this passcode to the person now. It cannot be shown again.");
            }
          } else if (sub === "suspend") {
            r = await db.query(
              "UPDATE people SET status = 'suspended', session_no = session_no + 1 WHERE customer_id = $1 AND owner_key = $2 RETURNING id",
              [c.id, owner],
            );
            if (r.rowCount) out(`Person ${owner} suspended.`);
          } else {
            r = await db.query("UPDATE people SET status = 'active' WHERE customer_id = $1 AND owner_key = $2 RETURNING id", [c.id, owner]);
            if (r.rowCount) out(`Person ${owner} resumed.`);
          }
          if (!r.rowCount) fail(`no person ${owner} for ${pos[0]}`);
          return 0;
        }
        return usage(out);
      }
      case "keyholder": {
        // Names the one person who may change the customer's Claude key in the app.
        const { pos } = parseArgs(argv.slice(1));
        need(pos, 2);
        const c = await customer(pos[0]);
        const owner = checkOwner(pos[1]);
        const r = await db.query(
          "UPDATE customers SET key_person_id = (SELECT id FROM people WHERE customer_id = $1 AND owner_key = $2) WHERE id = $1 AND EXISTS (SELECT 1 FROM people WHERE customer_id = $1 AND owner_key = $2) RETURNING id",
          [c.id, owner],
        );
        if (!r.rowCount) fail(`no person ${owner} for ${pos[0]}`);
        out(`${owner} now keeps the Claude key for ${pos[0]}.`);
        return 0;
      }
      case "pipeline": {
        if (sub !== "add") return usage(out);
        const { pos, flags } = parseArgs(argv.slice(2), ["--default-role", "--stages", "--roles"]);
        need(pos, 3);
        const c = await customer(pos[0]);
        if (!KEY_RE.test(pos[1])) fail("pipeline key must be 2-32 characters: a-z, 0-9, hyphen");
        const role = flags.get("--default-role");
        if (typeof role !== "string") fail("--default-role is required");
        const stages = parseJsonArray(flags.get("--stages"), "--stages");
        const roles = parseJsonArray(flags.get("--roles"), "--roles");
        checkVocabulary(stages, roles, role as string);
        const r = await db.query(
          `INSERT INTO pipelines (customer_id, key, label, default_role, position, vocab)
           VALUES ($1, $2, $3, $4, (SELECT COALESCE(MAX(position), 0) + 1 FROM pipelines WHERE customer_id = $1), $5)
           ON CONFLICT (customer_id, key) DO NOTHING RETURNING id`,
          [c.id, pos[1], pos[2], role, JSON.stringify({ stages, roles })],
        );
        if (!r.rowCount) fail(`pipeline ${pos[1]} already exists`);
        out(`Pipeline ${pos[1]} added.`);
        return 0;
      }
      case "link": {
        // A key link carries the customer's Claude key only; databases are set up with `host`.
        const { pos } = parseArgs(argv.slice(1));
        need(pos, 1);
        if (pos.length > 1) fail("link takes only the company code; use host for a pipeline's database");
        const c = await customer(pos[0]);
        const token = newToken();
        const expires = new Date(now().getTime() + LINK_DAYS * 86400_000);
        await db.query(
          "INSERT INTO setup_links (customer_id, pipeline_id, token_hash, purpose, expires_at) VALUES ($1, NULL, $2, 'key', $3)",
          [c.id, hashToken(token), expires],
        );
        out(`${publicBase()}/monsoon/setup/${token}`);
        out(`Valid ${LINK_DAYS} days, single use. It cannot be shown again.`);
        return 0;
      }
      case "host": {
        // Builds the client's CRM in their Supabase project as its owner, then hands the project, pooler and a
        // generated login password to the live server, which checks the login and stores the connection encrypted.
        const { pos, flags } = parseArgs(argv.slice(1), ["--ref", "--pooler", "--owner-password-from-env"], ["--replace"]);
        need(pos, 2);
        if (pos.length > 2) fail("host takes a company code and a pipeline key");
        const ref = flags.get("--ref");
        if (typeof ref !== "string") return fail("--ref is required");
        if (!PROJECT_REF.test(ref)) fail("--ref must be a 20-character project reference: a-z, 0-9");
        const poolerFlag = flags.get("--pooler");
        if (typeof poolerFlag !== "string") return fail("--pooler is required");
        const pooler = poolerFlag.toLowerCase();
        if (!POOLER_HOST.test(pooler)) fail("--pooler must be a Supabase pooler host ending in .pooler.supabase.com");
        const pwVar = flags.get("--owner-password-from-env");
        if (typeof pwVar !== "string") return fail("--owner-password-from-env is required");
        const replace = flags.has("--replace");
        const ownerPassword = env[pwVar];
        if (!ownerPassword) return fail(`environment variable ${pwVar} is not set`);
        const { connectOwner, post } = deps;
        if (!connectOwner || !post) return fail("host is not available here");
        let publicUrl: URL | null = null;
        try {
          publicUrl = new URL(publicBase());
        } catch {
          publicUrl = null;
        }
        if (!publicUrl || (publicUrl.protocol !== "https:" && publicUrl.hostname !== "localhost" && publicUrl.hostname !== "127.0.0.1")) {
          return fail("MONSOON_PUBLIC_URL must be an https address");
        }

        const c = await customer(pos[0]);
        const p = await pipeline(c.id, pos[1]);
        if (p.connected && !replace) fail(`pipeline ${pos[1]} is already connected. Pass --replace to host it again.`);
        const taken = await db.query("SELECT 1 FROM pipelines WHERE project_ref = $1 AND id <> $2", [ref, p.id]);
        if (taken.rowCount) fail("That project is already used by another pipeline.");

        const vocabulary = await setupVocabulary(c.id, p);
        const password = (deps.randomPassword ?? (() => randomBytes(32).toString("base64url")))();
        const owner = await connectOwner(`postgresql://postgres.${ref}:${encodeURIComponent(ownerPassword)}@${pooler}:5432/postgres`);
        try {
          const t = await owner.query("SELECT to_regclass('public.people') AS t");
          if (t.rows[0].t) {
            const held = await owner.query("SELECT EXISTS (SELECT 1 FROM public.people) AS found");
            // --replace may rebuild over existing people only in the project this pipeline already uses.
            if (held.rows[0].found && !replace) {
              fail("That project already holds Monsoon data. Check the project reference, or pass --replace.");
            }
            if (held.rows[0].found && ref !== p.project_ref) fail("That project already holds Monsoon data. Check the project reference.");
          }
          await owner.query(generateSetupScript({ ...vocabulary, roleName: deps.appRole ?? "monsoon_app", password }));
          out(`CRM built in project ${ref}.`);

          // From here the login's password has changed: every failure also says the pipeline is not connected.
          try {
            const token = newToken();
            await db.query(
              "INSERT INTO setup_links (customer_id, pipeline_id, token_hash, purpose, expires_at) VALUES ($1, $2, $3, 'host', $4)",
              [c.id, p.id, hashToken(token), new Date(now().getTime() + HOST_LINK_MINUTES * 60_000)],
            );
            let reply: PostReply;
            try {
              reply = await post(`${publicBase()}/api/monsoon/setup`, { token, projectRef: ref, poolerHost: pooler, password });
            } catch (err) {
              // A network error can echo the request, so only its class name is shown.
              out(`Error: could not reach the setup route (${err instanceof Error ? err.name : "error"}).`);
              out(NOT_CONNECTED);
              return 1;
            }
            if (reply.status !== 200 || reply.body?.ok !== true) {
              const error = typeof reply.body?.error === "string" ? reply.body.error : `the server refused (status ${reply.status})`;
              out(`Error: ${error}`);
              out(NOT_CONNECTED);
              return 1;
            }
            out(`Pipeline ${pos[1]} hosted on project ${ref}.`);
            return 0;
          } catch (err) {
            out(errorLine(err));
            out(NOT_CONNECTED);
            return 1;
          }
        } finally {
          await owner.end().catch(() => undefined);
        }
      }
      case "script": {
        const { pos, flags } = parseArgs(argv.slice(1), [], ["--login-only"]);
        if (flags.has("--login-only")) {
          out(loginAndPoliciesScript());
          return 0;
        }
        need(pos, 2);
        const c = await customer(pos[0]);
        const p = await pipeline(c.id, pos[1]);
        out(generateSetupScript(await setupVocabulary(c.id, p)));
        return 0;
      }
      case "status": {
        parseArgs(argv.slice(1));
        const cs = await db.query(
          `SELECT c.id, c.code, c.status, (c.claude_key_enc IS NOT NULL) AS has_key,
                  (SELECT owner_key FROM people k WHERE k.id = c.key_person_id) AS key_person,
                  (SELECT count(*)::int FROM people p WHERE p.customer_id = c.id) AS people
           FROM customers c ORDER BY c.code`,
        );
        for (const c of cs.rows) {
          const ps = await db.query(
            "SELECT key, (db_url_enc IS NOT NULL) AS connected, connected_at FROM pipelines WHERE customer_id = $1 ORDER BY position",
            [c.id],
          );
          const pipes = ps.rows
            .map((p: { key: string; connected: boolean; connected_at: Date | null }) =>
              p.connected && p.connected_at ? `${p.key} connected ${p.connected_at.toISOString().slice(0, 10)}` : `${p.key} not connected`,
            )
            .join(", ");
          out(`${c.code} | ${c.status} | ${c.people} people | ${pipes || "no pipelines"} | Claude key ${c.has_key ? "set" : "missing"} | key holder ${c.key_person ?? "none"}`);
        }
        if (cs.rowCount === 0) out("No customers.");
        return 0;
      }
      case "suspend":
      case "resume": {
        const { pos } = parseArgs(argv.slice(1));
        need(pos, 1);
        const c = await customer(pos[0]);
        await db.query("UPDATE customers SET status = $2 WHERE id = $1", [c.id, cmd === "suspend" ? "suspended" : "active"]);
        if (cmd === "suspend") {
          const l = await db.query(
            "UPDATE setup_links SET expires_at = now() WHERE customer_id = $1 AND used_at IS NULL AND expires_at > now()",
            [c.id],
          );
          out(`Customer ${pos[0]} suspended; unused setup links expired: ${l.rowCount ?? 0}.`);
        } else out(`Customer ${pos[0]} resumed.`);
        return 0;
      }
      case "people": {
        const { pos } = parseArgs(argv.slice(1));
        need(pos, 1);
        const c = await customer(pos[0]);
        const r = await db.query(
          "SELECT display_name, owner_key, status FROM people WHERE customer_id = $1 ORDER BY owner_key",
          [c.id],
        );
        for (const p of r.rows) out(`${p.display_name} | ${p.owner_key} | ${p.status}`);
        if (r.rowCount === 0) out(`No people for ${pos[0]}.`);
        return 0;
      }
      case "forget": {
        // Offboarding: clears every stored secret and signs everyone out, and blanks the user pages of the
        // customer's people. Account rows stay (UPDATE only); only the page's work details and notes are removed.
        const { pos } = parseArgs(argv.slice(1));
        need(pos, 1);
        const c = await customer(pos[0]);
        await db.query("BEGIN");
        try {
          const before = await db.query("SELECT claude_key_enc IS NOT NULL AS had_key FROM customers WHERE id = $1 FOR UPDATE", [c.id]);
          const pipes = await db.query(
            "SELECT key, db_url_enc IS NOT NULL AS had_address FROM pipelines WHERE customer_id = $1 ORDER BY position, key FOR UPDATE",
            [c.id],
          );
          await db.query("UPDATE customers SET claude_key_enc = NULL, status = 'suspended' WHERE id = $1", [c.id]);
          await db.query("UPDATE pipelines SET db_url_enc = NULL, connected_at = NULL WHERE customer_id = $1", [c.id]);
          const people = await db.query("UPDATE people SET session_no = session_no + 1 WHERE customer_id = $1", [c.id]);
          // The user page (docs/superpowers/specs/2026-11-24-monsoon-user-page-design.md): an administrator
          // erasing people, not the app deleting a note. The names stay; they are the account, not the page.
          const notes = await db.query("DELETE FROM person_notes WHERE person_id IN (SELECT id FROM people WHERE customer_id = $1)", [c.id]);
          const work = await db.query("DELETE FROM person_work WHERE person_id IN (SELECT id FROM people WHERE customer_id = $1)", [c.id]);
          const details = await db.query(
            "UPDATE people SET phone = NULL, email = NULL WHERE customer_id = $1 AND (phone IS NOT NULL OR email IS NOT NULL)",
            [c.id],
          );
          // Each person's own Granola key: cleared like every other stored secret (an UPDATE; the person stays).
          const granola = await db.query(
            `UPDATE people
                SET granola_key_enc = NULL, granola_status = NULL, granola_checked_at = NULL, granola_key_set_at = NULL
              WHERE customer_id = $1
                AND (granola_key_enc IS NOT NULL OR granola_status IS NOT NULL OR granola_checked_at IS NOT NULL OR granola_key_set_at IS NOT NULL)`,
            [c.id],
          );
          // The Google link goes too: a forgotten customer's people cannot sign back in with Google.
          const google = await db.query("UPDATE people SET google_sub = NULL WHERE customer_id = $1 AND google_sub IS NOT NULL", [c.id]);
          const links = await db.query(
            "UPDATE setup_links SET expires_at = now() WHERE customer_id = $1 AND used_at IS NULL AND expires_at > now()",
            [c.id],
          );
          await db.query("COMMIT");
          out(`Customer ${pos[0]} suspended.`);
          out(`Claude key: ${before.rows[0]?.had_key ? "cleared" : "was not set"}.`);
          for (const row of pipes.rows as { key: string; had_address: boolean }[]) {
            out(`Pipeline ${row.key}: database address ${row.had_address ? "cleared" : "was not set"}.`);
          }
          out(`People signed out: ${people.rowCount ?? 0}. Unused setup links expired: ${links.rowCount ?? 0}.`);
          out(`Granola keys cleared: ${granola.rowCount ?? 0}.`);
          out(`Google links cleared: ${google.rowCount ?? 0}.`);
          out(
            `User pages blanked: notes removed ${notes.rowCount ?? 0}, work details removed ${work.rowCount ?? 0}, phone and email cleared for ${details.rowCount ?? 0}.`,
          );
        } catch (err) {
          await db.query("ROLLBACK").catch(() => undefined);
          throw err;
        }
        return 0;
      }
      default:
        return usage(out);
    }
  } catch (err) {
    out(errorLine(err));
    return 1;
  }
}
