// Builds the SQL a customer runs once in their own Supabase SQL editor: the CRM tables, their
// vocabulary, and a restricted login that can read, insert and update but never remove rows or
// change structure.
import { CRM_SCHEMA_SQL } from "./crm-schema.generated";

export type SetupVocabulary = {
  stages: { key: string; ord: number; label: string; terminal: boolean }[];
  roles: { key: string; label: string }[];
  owners: { key: string; name: string }[];
  roleName?: string;
  /** When set, the script carries this password and runs unedited (Monsoon's own `host` command). */
  password?: string;
};

const DEFAULT_ROLE = "monsoon_app";
const PASSWORD_PLACEHOLDER = "REPLACE-WITH-A-PASSWORD-OF-AT-LEAST-16-CHARACTERS";

/** The eleven Monsoon CRM tables. */
export const MONSOON_TABLES: readonly string[] = [
  "schema_migrations", "stages", "roles", "owners", "orgs", "people",
  "members", "touches", "tags", "member_tags", "captures",
];
const ALL_TABLES = MONSOON_TABLES;
const INSERT_TABLES = ["orgs", "people", "members", "touches", "captures", "owners"];
const UPDATE_TABLES = ["orgs", "people", "members", "touches"];

const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;

function checkRole(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error("invalid role name");
  return name;
}

function loginPart(role: string, password: string = PASSWORD_PLACEHOLDER): string {
  const policies: string[] = [];
  const policy = (table: string, action: "select" | "insert" | "update") => {
    const name = `${role}_${action}`;
    const clause =
      action === "select" ? "FOR SELECT" + ` TO ${role} USING (true)`
      : action === "insert" ? "FOR INSERT" + ` TO ${role} WITH CHECK (true)`
      : "FOR UPDATE" + ` TO ${role} USING (true) WITH CHECK (true)`;
    policies.push(`DROP POLICY IF EXISTS ${name} ON ${table};`, `CREATE POLICY ${name} ON ${table} ${clause};`);
  };
  for (const t of ALL_TABLES) policy(t, "select");
  for (const t of INSERT_TABLES) policy(t, "insert");
  for (const t of UPDATE_TABLES) policy(t, "update");

  return `DO $$
DECLARE
  -- Put your own password between the quotes on the next line (at least 16 characters).
  pw text := ${lit(password)};
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

GRANT USAGE ON SCHEMA public TO ${role};
REVOKE ALL ON ${ALL_TABLES.join(", ")} FROM ${role};
GRANT SELECT ON ${ALL_TABLES.join(", ")} TO ${role};
GRANT INSERT ON ${INSERT_TABLES.join(", ")} TO ${role};
GRANT UPDATE ON ${UPDATE_TABLES.join(", ")} TO ${role};

${policies.join("\n")}
`;
}

/** Only the role, grants and policies, for a database that already holds the Monsoon tables. */
export function loginAndPoliciesScript(roleName: string = DEFAULT_ROLE): string {
  return `BEGIN;\n\n${loginPart(checkRole(roleName))}\nCOMMIT;\n`;
}

export function generateSetupScript(v: SetupVocabulary): string {
  const role = checkRole(v.roleName ?? DEFAULT_ROLE);
  // The password sits inside a dollar-quoted DO block, so a "$" could end the block early.
  if (v.password !== undefined && (v.password.length < 16 || v.password.includes("$"))) throw new Error("invalid password");
  const rows = (items: string[]) => items.join(",\n  ");
  const parts = [
    "BEGIN;",
    CRM_SCHEMA_SQL,
    "INSERT INTO schema_migrations (version) VALUES (1) ON CONFLICT DO NOTHING;",
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
  parts.push(loginPart(role, v.password), "COMMIT;");
  return parts.join("\n\n") + "\n";
}
