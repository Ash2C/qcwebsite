// Test harness: throwaway databases on the local Docker Postgres (container `monsoon-test`).
// Never points at anything but a database whose name contains "test".
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

const ADMIN_URL = process.env.MONSOON_TEST_DB ?? "postgresql://postgres:test@127.0.0.1:55433/postgres";
// One database per vitest worker: test files run in parallel workers and each reset() drops the schema.
const POOL_ID = /^\d+$/.test(process.env.VITEST_POOL_ID ?? "") ? (process.env.VITEST_POOL_ID as string) : "0";
const SCHEMA_SQL = join(__dirname, "0001_init.sql");
const ACCOUNTS_SCHEMA_SQL = join(__dirname, "..", "accounts", "schema.sql");

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function assertLocalAdminUrl(): void {
  // reset() drops the public schema: never allow it near a remote server.
  let host: string;
  try {
    host = new URL(ADMIN_URL).hostname;
  } catch {
    throw new Error("MONSOON_TEST_DB is not a valid URL");
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error("refusing to run the test harness against a non-local host");
  }
}

assertLocalAdminUrl();

export interface TestDb {
  available: boolean;
  reason: string;
  url(): string;
  connect(): Promise<Client>;
  reset(): Promise<void>;
}

// Roles are cluster-wide, so each vitest worker needs its own.
export function testRoleName(): string {
  return `monsoon_app_w${POOL_ID}`;
}

/** Creates Supabase's `anon` role once per cluster; parallel workers may race, so duplicates are fine. */
export async function ensureAnonRole(c: Client): Promise<void> {
  try {
    await c.query("DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$");
  } catch (err) {
    if ((err as { code?: string }).code !== "23505") throw err;
  }
}

async function ensureDatabase(dbName: string): Promise<void> {
  if (!dbName.includes("test")) throw new Error("refusing to use a database whose name lacks 'test'");
  const admin = new Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
  await admin.connect();
  try {
    const found = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (found.rowCount === 0) await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.end();
  }
}

async function probe(): Promise<{ available: boolean; reason: string }> {
  try {
    const admin = new Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
    await admin.connect();
    await admin.end();
    return { available: true, reason: "" };
  } catch (err) {
    return { available: false, reason: `test Postgres unreachable: ${(err as Error).message}` };
  }
}

// Probed once at import so `describe.skipIf(!db.available)` can read it synchronously.
const state = await probe();
if (!state.available) console.info(`monsoon: DB tests skipped, ${state.reason}`);

function makeNamedDb(dbName: string, populate: (client: Client) => Promise<void>): TestDb {
  if (!/^monsoon_[a-z0-9_]*test[a-z0-9_]*$/.test(dbName)) throw new Error("refusing an unsafe test database name");
  let ensured: Promise<void> | undefined;
  const db: TestDb = {
    available: state.available,
    reason: state.reason,
    url(): string {
      const url = new URL(ADMIN_URL);
      url.pathname = `/${dbName}`;
      return url.toString();
    },
    async connect(): Promise<Client> {
      ensured ??= ensureDatabase(dbName);
      await ensured;
      const client = new Client({ connectionString: db.url() });
      await client.connect();
      return client;
    },
    async reset(): Promise<void> {
      const client = await db.connect();
      try {
        await client.query("DROP SCHEMA public CASCADE");
        await client.query("CREATE SCHEMA public");
        await populate(client);
      } finally {
        await client.end();
      }
    },
  };
  return db;
}

async function populateCrm(client: Client): Promise<void> {
  await client.query(readFileSync(SCHEMA_SQL, "utf8"));
  await client.query(
    `INSERT INTO stages (key, ord, label, terminal) VALUES
       ('uncontacted', 0, 'Uncontacted', false), ('contacted', 1, 'Contacted', false),
       ('engaged', 2, 'Engaged', false), ('client', 3, 'Client', true), ('passed', 4, 'Passed', true)`,
  );
  await client.query("INSERT INTO roles (key, label) VALUES ('investor', 'Investor'), ('introducer', 'Introducer')");
  await client.query("INSERT INTO owners (key, display_name) VALUES ('VF', 'Vincent')");
  await client.query("INSERT INTO schema_migrations (version) VALUES (1)");
}

async function populateAccounts(client: Client): Promise<void> {
  await client.query(readFileSync(ACCOUNTS_SCHEMA_SQL, "utf8"));
}

export function makeTestDb(name: string): TestDb {
  return makeNamedDb(`monsoon_${name}_test_w${POOL_ID}`, populateCrm);
}

export function makeAccountsTestDb(): TestDb {
  return makeNamedDb(`monsoon_accounts_test_w${POOL_ID}`, populateAccounts);
}

// The original CRM database keeps its name so existing tests are unchanged.
export const testDb: TestDb = makeNamedDb(`monsoon_test_w${POOL_ID}`, populateCrm);
