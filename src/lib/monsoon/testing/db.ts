// Test harness: a throwaway `monsoon_test` database on the local Docker Postgres (container
// `monsoon-test`). Never points at anything but a database whose name contains "test".
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

const ADMIN_URL = process.env.MONSOON_TEST_DB ?? "postgresql://postgres:test@127.0.0.1:55433/postgres";
// One database per vitest worker: test files run in parallel workers and each reset() drops the schema.
const TEST_DB = `monsoon_test_w${process.env.VITEST_POOL_ID ?? "0"}`;
const SCHEMA_SQL = join(__dirname, "0001_init.sql");

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

function testUrl(): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${TEST_DB}`;
  return url.toString();
}

async function ensureDatabase(): Promise<void> {
  if (!TEST_DB.includes("test")) throw new Error("refusing to use a database whose name lacks 'test'");
  const admin = new Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
  await admin.connect();
  try {
    const found = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [TEST_DB]);
    if (found.rowCount === 0) await admin.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end();
  }
}

async function probe(): Promise<{ available: boolean; reason: string }> {
  try {
    await ensureDatabase();
    return { available: true, reason: "" };
  } catch (err) {
    return { available: false, reason: `test Postgres unreachable: ${(err as Error).message}` };
  }
}

// Probed once at import so `describe.skipIf(!testDb.available)` can read it synchronously.
const state = await probe();
if (!state.available) console.info(`monsoon: DB tests skipped, ${state.reason}`);

export const testDb = {
  available: state.available,
  reason: state.reason,

  async connect(): Promise<Client> {
    const client = new Client({ connectionString: testUrl() });
    await client.connect();
    return client;
  },

  async reset(): Promise<void> {
    const client = await testDb.connect();
    try {
      await client.query("DROP SCHEMA public CASCADE");
      await client.query("CREATE SCHEMA public");
      await client.query(readFileSync(SCHEMA_SQL, "utf8"));
      await client.query(
        `INSERT INTO stages (key, ord, label, terminal) VALUES
           ('uncontacted', 0, 'Uncontacted', false), ('contacted', 1, 'Contacted', false),
           ('engaged', 2, 'Engaged', false), ('client', 3, 'Client', true), ('passed', 4, 'Passed', true)`,
      );
      await client.query("INSERT INTO roles (key, label) VALUES ('investor', 'Investor'), ('introducer', 'Introducer')");
      await client.query("INSERT INTO owners (key, display_name) VALUES ('VF', 'Vincent')");
    } finally {
      await client.end();
    }
  },
};
