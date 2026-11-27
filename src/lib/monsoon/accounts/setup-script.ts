// Builds the SQL a customer runs once in their own Supabase SQL editor: the CRM tables, their
// vocabulary, and a restricted login that can read, insert and update but never remove rows or
// change structure.
import { CRM_LATEST_VERSION, CRM_SCHEMA_SQL } from "./crm-schema.generated";

export type SetupVocabulary = {
  stages: { key: string; ord: number; label: string; terminal: boolean }[];
  roles: { key: string; label: string }[];
  owners: { key: string; name: string }[];
  roleName?: string;
  /** When set, the script carries this password and runs unedited (Monsoon's own `host` command). */
  password?: string;
  /**
   * The schema the login is given USAGE on (default `public`). The tables themselves are created
   * wherever the search path points when the script runs: the caller sets that for another schema.
   */
  schema?: string;
};

const DEFAULT_ROLE = "monsoon_app";
const DEFAULT_SCHEMA = "public";
const PASSWORD_PLACEHOLDER = "REPLACE-WITH-A-PASSWORD-OF-AT-LEAST-16-CHARACTERS";

/** The eleven Monsoon CRM tables. */
export const MONSOON_TABLES: readonly string[] = [
  "schema_migrations", "stages", "roles", "owners", "orgs", "people",
  "members", "touches", "tags", "member_tags", "captures",
];
/** The to-do table, added at schema version 2. */
export const TODO_TABLE = "todos";
/** The eleven tables plus the to-do table: what a version 2 CRM holds. */
export const MONSOON_TABLES_V2: readonly string[] = [...MONSOON_TABLES, TODO_TABLE];
const ALL_TABLES = MONSOON_TABLES_V2;
// The triggers on members and todos run as the invoking login, so it needs to read, insert and
// update todos (and be let through by row security) for a direct next_action write to work.
const INSERT_TABLES = ["orgs", "people", "members", "touches", "captures", "owners", TODO_TABLE];
const UPDATE_TABLES = ["orgs", "people", "members", "touches", TODO_TABLE];

const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;

function checkRole(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error("invalid role name");
  return name;
}

/** A plain lower-case identifier that is not one of Postgres's own schemas. Throws otherwise. */
export function checkSchemaName(name: string): string {
  if (typeof name !== "string" || !/^[a-z_][a-z0-9_]{0,62}$/.test(name) || name.startsWith("pg_") || name === "information_schema") {
    throw new Error("invalid schema name");
  }
  return name;
}

// `passwordSql`, when given, is a fixed SQL expression the block reads the password from, in place
// of the quoted password: the password itself is then nowhere in the script.
function policyStatements(role: string, tables: readonly string[], insertTables: readonly string[], updateTables: readonly string[]): string[] {
  const policies: string[] = [];
  const policy = (table: string, action: "select" | "insert" | "update") => {
    const name = `${role}_${action}`;
    const clause =
      action === "select" ? "FOR SELECT" + ` TO ${role} USING (true)`
      : action === "insert" ? "FOR INSERT" + ` TO ${role} WITH CHECK (true)`
      : "FOR UPDATE" + ` TO ${role} USING (true) WITH CHECK (true)`;
    policies.push(`DROP POLICY IF EXISTS ${name} ON ${table};`, `CREATE POLICY ${name} ON ${table} ${clause};`);
  };
  for (const t of tables) policy(t, "select");
  for (const t of insertTables) policy(t, "insert");
  for (const t of updateTables) policy(t, "update");
  return policies;
}

function loginPart(role: string, password: string = PASSWORD_PLACEHOLDER, schema: string = DEFAULT_SCHEMA, passwordSql?: string): string {
  const policies = policyStatements(role, ALL_TABLES, INSERT_TABLES, UPDATE_TABLES);

  return `DO $$
DECLARE
  -- Put your own password between the quotes on the next line (at least 16 characters).
  pw text := ${passwordSql ?? lit(password)};
BEGIN
  IF pw IS NULL OR pw LIKE 'REPLACE-%' OR length(pw) < 16 THEN
    RAISE EXCEPTION 'Set your own password for ${role} on the marked line, then run the script again.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${lit(role)}) THEN
    IF EXISTS (
      SELECT 1 FROM pg_roles r
       WHERE r.rolname = ${lit(role)}
         AND (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls OR r.rolreplication OR r.rolinherit
              OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid))
    ) THEN
      RAISE EXCEPTION 'The existing ${role} login has extra access. Drop it or clean it up first, then run the script again.';
    END IF;
    EXECUTE format('ALTER ROLE %I PASSWORD %L', ${lit(role)}, pw);
  ELSE
    EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT PASSWORD %L', ${lit(role)}, pw);
  END IF;
END
$$;

-- Supabase grants new tables to its public API roles. Row security hides rows from them, but
-- emptying a whole table bypasses it, so they get nothing on Monsoon tables. Skipped where they do not exist.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ${ALL_TABLES.join(", ")} FROM %I', r);
    END IF;
  END LOOP;
END
$$;

GRANT USAGE ON SCHEMA ${schema} TO ${role};
REVOKE ALL ON ${ALL_TABLES.join(", ")} FROM ${role};
GRANT SELECT ON ${ALL_TABLES.join(", ")} TO ${role};
GRANT INSERT ON ${INSERT_TABLES.join(", ")} TO ${role};
GRANT UPDATE ON ${UPDATE_TABLES.join(", ")} TO ${role};

${policies.join("\n")}
`;
}

/**
 * Grants and row-security policies on the to-do table for a login that already exists, such as
 * a client whose CRM was just upgraded to version 2. Safe to repeat.
 */
export function todoGrantStatements(roleName: string, schema: string): string {
  const role = checkRole(roleName);
  const sch = checkSchemaName(schema);
  return `DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ${TODO_TABLE} FROM %I', r);
    END IF;
  END LOOP;
END
$$;

GRANT USAGE ON SCHEMA ${sch} TO ${role};
REVOKE ALL ON ${TODO_TABLE} FROM ${role};
GRANT SELECT, INSERT, UPDATE ON ${TODO_TABLE} TO ${role};

${policyStatements(role, [TODO_TABLE], [TODO_TABLE], [TODO_TABLE]).join("\n")}
`;
}

/** Records every schema version up to the latest this app carries. */
const MIGRATION_ROWS = Array.from({ length: CRM_LATEST_VERSION }, (_, i) => i + 1)
  .map((v) => `INSERT INTO schema_migrations (version) VALUES (${v}) ON CONFLICT DO NOTHING;`)
  .join("\n");

/** Only the role, grants and policies, for a database that already holds the Monsoon tables. */
export function loginAndPoliciesScript(roleName: string = DEFAULT_ROLE, schema: string = DEFAULT_SCHEMA): string {
  return `BEGIN;\n\n${loginPart(checkRole(roleName), undefined, checkSchemaName(schema))}\nCOMMIT;\n`;
}

export function generateSetupScript(v: SetupVocabulary): string {
  return `BEGIN;\n\n${setupStatements(v)}\n\nCOMMIT;\n`;
}

/**
 * The tables alone, for the shared database. Fixed text: it carries no vocabulary, because the
 * shared database's rows are added with parameterised queries, never as quoted text.
 */
export function schemaStatements(): string {
  return [CRM_SCHEMA_SQL, MIGRATION_ROWS].join("\n\n");
}

/** The setting the shared database's login script reads the new password from. Set it for the transaction only. */
export const NEW_PASSWORD_SETTING = "monsoon.new_password";

/**
 * The login, its grants and its policies for the shared database. Built from the two checked names
 * only: the password is read from `NEW_PASSWORD_SETTING`, so it is never in this text, and a
 * statement that fails cannot carry it into a log.
 */
export function loginStatements(roleName: string, schema: string): string {
  return loginPart(checkRole(roleName), undefined, checkSchemaName(schema), `current_setting('${NEW_PASSWORD_SETTING}')`);
}

/** Everything the setup script runs, without its BEGIN and COMMIT, for a caller with its own transaction. */
export function setupStatements(v: SetupVocabulary): string {
  const role = checkRole(v.roleName ?? DEFAULT_ROLE);
  const schema = checkSchemaName(v.schema ?? DEFAULT_SCHEMA);
  // The password sits inside a dollar-quoted DO block, so a "$" could end the block early.
  if (v.password !== undefined && (v.password.length < 16 || v.password.includes("$"))) throw new Error("invalid password");
  const rows = (items: string[]) => items.join(",\n  ");
  const parts = [
    CRM_SCHEMA_SQL,
    MIGRATION_ROWS,
  ];
  if (v.stages.length > 0) {
    const values = v.stages.map((s) => `(${lit(s.key)}, ${Math.trunc(s.ord)}, ${lit(s.label)}, ${s.terminal ? "true" : "false"})`);
    parts.push(`INSERT INTO stages (key, ord, label, terminal) VALUES\n  ${rows(values)}\nON CONFLICT DO NOTHING;`);
  }
  if (v.roles.length > 0) {
    const values = v.roles.map((r) => `(${lit(r.key)}, ${lit(r.label)})`);
    parts.push(`INSERT INTO roles (key, label) VALUES\n  ${rows(values)}\nON CONFLICT DO NOTHING;`);
  }
  if (v.owners.length > 0) {
    const values = v.owners.map((o) => `(${lit(o.key)}, ${lit(o.name)})`);
    parts.push(`INSERT INTO owners (key, display_name) VALUES\n  ${rows(values)}\nON CONFLICT DO NOTHING;`);
  }
  parts.push(loginPart(role, v.password, schema));
  return parts.join("\n\n");
}
