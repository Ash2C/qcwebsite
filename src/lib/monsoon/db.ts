import { Client, type ClientConfig } from "pg";
import { parseAllowedDbUrl } from "./accounts/address";
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
  // Nothing in the URL may weaken or override the TLS settings applied below.
  for (const name of [...parsed.searchParams.keys()]) {
    if (name.toLowerCase().startsWith("ssl")) parsed.searchParams.delete(name);
  }

  const config: ClientConfig = {
    connectionString: parsed.toString(),
    connectionTimeoutMillis: 8000,
    // Client-side: poolers in transaction mode may reject a startup statement_timeout.
    query_timeout: 10000,
  };
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    const ca = process.env.MONSOON_DB_CA_CERT;
    config.ssl = ca
      ? { rejectUnauthorized: true, ca }
      : { rejectUnauthorized: true };
  }
  return config;
}

function tlsFor(host: string): ClientConfig["ssl"] {
  if (LOCAL_HOSTS.has(host)) return undefined;
  const ca = process.env.MONSOON_DB_CA_CERT;
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}

// Explicit fields from the validated parse; no connectionString for pg to re-parse.
export function pipelineClientConfig(dbUrl: string): ClientConfig {
  const u = parseAllowedDbUrl(dbUrl);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const config: ClientConfig = {
    host,
    port: u.port === "" ? 5432 : Number(u.port),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, "")) || undefined,
    connectionTimeoutMillis: 8000,
    query_timeout: 10000,
  };
  const ssl = tlsFor(u.hostname);
  if (ssl) config.ssl = ssl;
  return config;
}

async function connectAndRun<T>(config: ClientConfig, fn: (db: Client) => Promise<T>): Promise<T> {
  const client = new Client(config);
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

export async function withEstateDb<T>(
  estate: (typeof ESTATES)[number],
  fn: (db: Client) => Promise<T>
): Promise<T> {
  const url = process.env[estate.dbEnv];
  if (!url) throw new Error(`${estate.dbEnv} is not set`);
  return connectAndRun(clientConfig(url), fn);
}

export async function withPipelineDb<T>(
  dbUrl: string,
  fn: (db: Client) => Promise<T>
): Promise<T> {
  return connectAndRun(pipelineClientConfig(dbUrl), fn);
}
