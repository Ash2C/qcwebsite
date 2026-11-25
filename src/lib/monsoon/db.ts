import { Client, type ClientConfig } from "pg";
import { SHARED_SCHEMA, parseAllowedDbUrl } from "./accounts/address";

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

/**
 * Runs fn on one connection to a pipeline's CRM. `sharedSchema` is given for a client in the shared
 * database: the search path is then set on the connection itself, so finding the client's tables
 * does not depend on the pooler passing on the login's own search path. This is not what keeps
 * clients apart (the login has no rights outside its schema, whatever the path says); it only makes
 * unqualified table names resolve. Only a client schema name is accepted (`c_` and 32 hex digits).
 */
export async function withPipelineDb<T>(
  dbUrl: string,
  fn: (db: Client) => Promise<T>,
  sharedSchema?: string
): Promise<T> {
  if (sharedSchema === undefined) return connectAndRun(pipelineClientConfig(dbUrl), fn);
  if (typeof sharedSchema !== "string" || !SHARED_SCHEMA.test(sharedSchema)) throw new Error("invalid schema name");
  return connectAndRun(pipelineClientConfig(dbUrl), async (db) => {
    // The name passed the pattern above: lower-case hex and an underscore, nothing to quote.
    await db.query(`SET search_path TO ${sharedSchema}`);
    return fn(db);
  });
}
