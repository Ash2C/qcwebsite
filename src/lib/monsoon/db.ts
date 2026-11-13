import { Client, type ClientConfig } from "pg";
import type { ESTATES } from "./estates";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function clientConfig(url: string): ClientConfig {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Never echo the value: it may be a connection string with a password.
    throw new Error("Invalid database URL");
  }
  parsed.searchParams.delete("sslmode");

  const config: ClientConfig = {
    connectionString: parsed.toString(),
    connectionTimeoutMillis: 8000,
    statement_timeout: 10000,
  };
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    const ca = process.env.MONSOON_DB_CA_CERT;
    config.ssl = ca
      ? { rejectUnauthorized: true, ca }
      : { rejectUnauthorized: true };
  }
  return config;
}

export async function withEstateDb<T>(
  estate: (typeof ESTATES)[number],
  fn: (db: Client) => Promise<T>
): Promise<T> {
  const url = process.env[estate.dbEnv];
  if (!url) throw new Error(`${estate.dbEnv} is not set`);

  const client = new Client(clientConfig(url));
  try {
    await client.connect();
    return await fn(client);
  } finally {
    try {
      await client.end();
    } catch {
      // An error while closing must not mask the original outcome.
    }
  }
}
