// Builds one client's CRM inside the shared database: a schema and a login of its own, derived from
// the customer id. The login can read, add to and change the tables in its own schema and has no
// rights anywhere else, so the wall between clients is kept by Postgres, not by any query here.
// Connects as the shared database's owner (MONSOON_SHARED_DB_ADMIN_URL), which nothing else uses.
// Safe to run again for the same customer: nothing is dropped, data stays, the login gets a new
// password. The password and both addresses are never logged, and never leave except as `dbUrl`.
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { pipelineClientConfig, withPipelineDb } from "../db";
import { buildSharedPoolerUrl } from "./address";
import { runSetupChecks, type SetupFailure } from "./setup-check";
import { setupStatements, type SetupVocabulary } from "./setup-script";
import { clientNames, type ClientNames } from "./shared-names";

export { clientNames, type ClientNames };

export type WallFailure = "identity" | "search_path" | "own_schema" | "other_schemas";
export type ProvisionFailure = "not_configured" | "address" | "build" | SetupFailure | WallFailure;

/** Carries which step failed and, for the build, Postgres's five-character error code. Nothing else. */
export class ProvisionError extends Error {
  constructor(
    readonly failure: ProvisionFailure,
    readonly sqlState: string | null = null,
  ) {
    super(sqlState ? `${failure} (${sqlState})` : failure);
    this.name = "ProvisionError";
  }
}

const BUILD_TIMEOUT_MS = 30_000;

// One provisioning at a time: two at once would both change who may use `public`.
const LOCK = "SELECT pg_advisory_xact_lock(hashtext('monsoon:provision'));";

function buildScript(names: ClientNames, vocabulary: SetupVocabulary, password: string): string {
  const { schema, role } = names;
  return [
    "BEGIN;",
    // Names in the vocabulary go into the script as quoted text: make sure a backslash is only a backslash.
    "SET LOCAL standard_conforming_strings = on;",
    LOCK,
    // Nobody gets into `public` by default. Asked for on every run; it changes nothing after the first.
    "REVOKE ALL ON SCHEMA public FROM PUBLIC;",
    // Before the search path moves, so it can never land inside a client's schema.
    "CREATE EXTENSION IF NOT EXISTS pgcrypto;",
    `CREATE SCHEMA IF NOT EXISTS ${schema};`,
    `REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC;`,
    // The CRM SQL names no schema: for this transaction only, everything it makes goes here.
    `SET LOCAL search_path TO ${schema};`,
    setupStatements({ stages: vocabulary.stages, roles: vocabulary.roles, owners: vocabulary.owners, roleName: role, password, schema }),
    `ALTER ROLE ${role} SET search_path TO ${schema};`,
    "COMMIT;",
  ].join("\n\n");
}

/**
 * Asks, as the client's own login on a plain connection, whether it is who it should be, finds its
 * tables without help, can create nothing, and can use no schema but its own. Null when all hold.
 * Exported for the tests.
 */
export async function checkWall(dbUrl: string, names: ClientNames): Promise<WallFailure | null> {
  return withPipelineDb(dbUrl, async (db) => {
    const r = await db.query(
      `SELECT current_user::text AS me,
              current_schemas(false)::text[] AS path,
              has_schema_privilege(current_user, $1, 'USAGE') AS own_usage,
              has_schema_privilege(current_user, $1, 'CREATE') AS own_create,
              has_database_privilege(current_user, current_database(), 'CREATE') AS db_create,
              (SELECT count(*)::int FROM pg_namespace n
                WHERE n.nspname <> $1 AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
                  AND (has_schema_privilege(current_user, n.oid, 'USAGE') OR has_schema_privilege(current_user, n.oid, 'CREATE'))) AS others`,
      [names.schema],
    );
    const row = r.rows[0] as { me: string; path: string[]; own_usage: boolean; own_create: boolean; db_create: boolean; others: number };
    if (row.me !== names.role) return "identity";
    if (row.others !== 0) return "other_schemas";
    if (row.own_usage !== true || row.own_create !== false || row.db_create !== false) return "own_schema";
    if (row.path.length !== 1 || row.path[0] !== names.schema) return "search_path";
    return null;
  });
}

/**
 * Creates (or completes) the customer's schema and login in the shared database and returns the
 * address that login uses. Throws ProvisionError naming the step that failed; the caller must then
 * store nothing. Throws a plain error for an id that is not a customer id, before connecting.
 */
export async function provisionSharedCrm(input: {
  customerId: string;
  vocabulary: SetupVocabulary;
  /** The pipeline's default role (default: the vocabulary's first role). It must be in the vocabulary. */
  defaultRole?: string;
}): Promise<{ dbUrl: string; schema: string }> {
  const names = clientNames(input.customerId);
  const adminUrl = process.env.MONSOON_SHARED_DB_ADMIN_URL;
  if (!adminUrl) throw new ProvisionError("not_configured");
  const defaultRole = input.defaultRole ?? input.vocabulary.roles[0]?.key;
  if (!defaultRole) throw new ProvisionError("vocabulary");

  // 32 random bytes as base64url: no "$" (the script carries it inside a dollar-quoted block).
  const password = randomBytes(32).toString("base64url");
  let dbUrl: string;
  let admin: Client;
  let script: string;
  try {
    dbUrl = buildSharedPoolerUrl({ adminUrl, role: names.role, password });
    admin = new Client({ ...pipelineClientConfig(adminUrl), query_timeout: BUILD_TIMEOUT_MS });
    script = buildScript(names, input.vocabulary, password);
  } catch {
    throw new ProvisionError("address");
  }

  // One transaction: a failure anywhere leaves the database as it was.
  try {
    await admin.connect();
    await admin.query(script);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    throw new ProvisionError("build", typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null);
  } finally {
    await admin.end().catch(() => undefined);
  }

  // Everything below runs as the new login itself, so it sees exactly what the client's requests will.
  const checks = await runSetupChecks({
    dbUrl,
    claudeKey: null,
    roleName: names.role,
    defaultRole,
    schema: names.schema,
    tryClaude: async () => false,
  });
  if (!checks.ok) throw new ProvisionError(checks.failure);

  let wall: WallFailure | null;
  try {
    wall = await checkWall(dbUrl, names);
  } catch {
    throw new ProvisionError("connect");
  }
  if (wall) throw new ProvisionError(wall);

  return { dbUrl, schema: names.schema };
}
