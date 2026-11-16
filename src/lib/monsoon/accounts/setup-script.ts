// Builds the SQL a customer runs once in their own Supabase SQL editor: the CRM tables, their
// vocabulary, and a restricted login that can read, insert and update but never remove rows or
// change structure.
import { CRM_SCHEMA_SQL } from "./crm-schema.generated";

export type SetupVocabulary = {
  stages: { key: string; ord: number; label: string; terminal: boolean }[];
  roles: { key: string; label: string }[];
  owners: { key: string; name: string }[];
  roleName?: string;
};

const DEFAULT_ROLE = "monsoon_app";
const PASSWORD_PLACEHOLDER = "REPLACE-WITH-A-PASSWORD-OF-AT-LEAST-16-CHARACTERS";

const ALL_TABLES = [
  "schema_migrations", "stages", "roles", "owners", "orgs", "people",
  "members", "touches", "tags", "member_tags", "captures",
];
const INSERT_TABLES = ["orgs", "people", "members", "touches", "captures", "owners"];
const UPDATE_TABLES = ["orgs", "people", "members", "touches"];

const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;

function checkRole(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error("invalid role name");
  return name;
}

function loginPart(role: string): string {
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
  pw text := ${lit(PASSWORD_PLACEHOLDER)};
BEGIN
  IF pw LIKE 'REPLACE-%' OR length(pw) < 16 THEN
    RAISE EXCEPTION 'Set your own password for ${role} on the marked line, then run the script again.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${lit(role)}) THEN
    EXECUTE format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT PASSWORD %L', ${lit(role)}, pw);
  ELSE
    EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT PASSWORD %L', ${lit(role)}, pw);
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO ${role};
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${role};
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
  parts.push(loginPart(role), "COMMIT;");
  return parts.join("\n\n") + "\n";
}
