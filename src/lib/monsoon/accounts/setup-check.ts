// Checks a customer's database and Claude key before Monsoon stores them. Connects as the
// restricted login itself, so every check sees exactly what Monsoon will be able to do.
// Nothing here logs, returns or throws a credential: the outcome is a failure code only.
import type { Client } from "pg";
import { parseAllowedDbUrl } from "./address";
import { withPipelineDb } from "../db";
import { MONSOON_TABLES, MONSOON_TABLES_V2, checkSchemaName } from "./setup-script";

export type SetupFailure =
  | "address"
  | "connect"
  | "tables"
  | "version"
  | "vocabulary"
  | "can_delete"
  | "privileges"
  | "role_flags"
  | "public_policies"
  | "claude_key";

export type SetupCheckResult = { ok: true } | { ok: false; failure: SetupFailure };

const TOO_MUCH = "The monsoon_app login has more access than Monsoon allows. Run the setup script again unchanged.";
const NO_TABLES = "The Monsoon tables aren't there yet. Run the setup script first.";

export const SETUP_MESSAGES: Record<SetupFailure, string> = {
  address: "That pooler host isn't a Supabase pooler address. Copy it from Supabase's Connect screen.",
  connect: "Couldn't sign in to your database as monsoon_app. Check the project reference, pooler host and password.",
  tables: NO_TABLES,
  version: NO_TABLES,
  vocabulary: "Your Monsoon tables are missing stages or roles. Run the setup script again unchanged.",
  can_delete: TOO_MUCH,
  privileges: TOO_MUCH,
  role_flags: TOO_MUCH,
  public_policies: "Your database lets the public API read Monsoon tables. Remove the policies for anon and authenticated.",
  claude_key: "That Claude key didn't work. Check it in the Claude Console.",
};

export const SETUP_SUCCESS = "Connected. You can close this page.";

// A failed step: carries the failure code only, never the driver's message.
class StepFailed extends Error {
  constructor(readonly failure: SetupFailure) {
    super(failure);
    this.name = "StepFailed";
  }
}

async function step<T>(failure: SetupFailure, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch {
    throw new StepFailed(failure);
  }
}

// The statements below are written for `public`, exactly as they were before a schema could be
// named, and are sent unchanged for it. For a client's schema in the shared database the two places
// that name `public` are rewritten. `schema` is a checked identifier (checkSchemaName).
function inSchema(sql: string, schema: string): string {
  if (schema === "public") return sql;
  return sql.split("'public.'").join(`'${schema}.'`).split("schemaname = 'public'").join(`schemaname = '${schema}'`);
}

async function checkDatabase(db: Client, roleName: string, defaultRole: string, schema: string): Promise<SetupFailure | null> {
  // The version says which tables to expect: the eleven at version 1, plus todos from version 2.
  // A database with no schema_migrations table yet reads as no version, and fails on its tables.
  let latest = 0;
  try {
    latest = Number((await db.query("SELECT max(version) AS v FROM schema_migrations")).rows[0].v);
  } catch {
    latest = 0;
  }
  const TABLES = latest >= 2 ? [...MONSOON_TABLES_V2] : [...MONSOON_TABLES];

  const present = await step("tables", () =>
    db.query(inSchema("SELECT count(*)::int AS n FROM unnest($1::text[]) AS t(name) WHERE to_regclass('public.' || t.name) IS NOT NULL", schema), [
      TABLES,
    ]),
  );
  if (present.rows[0].n !== TABLES.length) return "tables";

  if (!(latest >= 1)) return "version";

  // A contact needs a stage to start in, and new contacts get the pipeline's default role.
  const vocab = await step("vocabulary", () =>
    db.query(
      `SELECT EXISTS (SELECT 1 FROM stages WHERE NOT terminal) AS open_stage,
              EXISTS (SELECT 1 FROM roles WHERE key = $1) AS default_role`,
      [defaultRole],
    ),
  );
  if (vocab.rows[0].open_stage !== true || vocab.rows[0].default_role !== true) return "vocabulary";

  // A delete that matches nothing must still be refused by privilege. Always rolled back.
  let deleteCode: string | undefined;
  try {
    await db.query("BEGIN");
    await db.query("DELETE FROM touches WHERE false");
  } catch (err) {
    deleteCode = (err as { code?: string }).code;
  } finally {
    await db.query("ROLLBACK").catch(() => undefined);
  }
  if (deleteCode !== "42501") return "can_delete";

  // Backstop for grants another role made: nothing may remove rows from any Monsoon table.
  const privileges = await step("privileges", () =>
    db.query(
      inSchema(
        `SELECT count(*)::int AS n FROM unnest($2::text[]) AS t(name)
        WHERE has_table_privilege($1, 'public.' || quote_ident(t.name), 'DELETE')
           OR has_table_privilege($1, 'public.' || quote_ident(t.name), 'TRUNCATE')`,
        schema,
      ),
      [roleName, TABLES],
    ),
  );
  if (privileges.rows[0].n !== 0) return "privileges";

  const flags = await step("role_flags", () =>
    db.query(
      `SELECT r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication
              OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid) AS extra
         FROM pg_roles r WHERE r.rolname = $1`,
      [roleName],
    ),
  );
  if (flags.rowCount !== 1 || flags.rows[0].extra !== false) return "role_flags";

  // A policy for PUBLIC applies to anon and authenticated too.
  const policies = await step("public_policies", () =>
    db.query(
      inSchema(
        `SELECT count(*)::int AS n FROM pg_policies
        WHERE schemaname = 'public' AND tablename = ANY($1::text[])
          AND roles && ARRAY['anon', 'authenticated', 'public']::name[]`,
        schema,
      ),
      [TABLES],
    ),
  );
  if (policies.rows[0].n !== 0) return "public_policies";

  return null;
}

export async function runSetupChecks(input: {
  dbUrl: string;
  claudeKey: string | null;
  roleName: string;
  /** The pipeline's default role: it must exist in the customer's roles table. */
  defaultRole: string;
  /**
   * Where the Monsoon tables are (default `public`). Any other schema is a client's schema in the
   * shared database: it is also handed to the connection, the way the app itself connects.
   */
  schema?: string;
  tryClaude: (key: string) => Promise<boolean>;
}): Promise<SetupCheckResult> {
  let schema: string;
  try {
    parseAllowedDbUrl(input.dbUrl);
    schema = checkSchemaName(input.schema ?? "public");
  } catch {
    return { ok: false, failure: "address" };
  }

  let failure: SetupFailure | null;
  try {
    const run = (db: Client) => checkDatabase(db, input.roleName, input.defaultRole, schema);
    failure = schema === "public" ? await withPipelineDb(input.dbUrl, run) : await withPipelineDb(input.dbUrl, run, schema);
  } catch (err) {
    // Anything thrown outside a named step happened while signing in.
    failure = err instanceof StepFailed ? err.failure : "connect";
  }
  if (failure) return { ok: false, failure };

  if (input.claudeKey !== null) {
    let works = false;
    try {
      works = await input.tryClaude(input.claudeKey);
    } catch {
      works = false;
    }
    if (!works) return { ok: false, failure: "claude_key" };
  }
  return { ok: true };
}
