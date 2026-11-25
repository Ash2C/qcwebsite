import { afterEach, describe, expect, it, vi } from "vitest";
import { clientConfig, withPipelineDb, pipelineClientConfig } from "./db";
import { testDb } from "./testing/db";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("clientConfig", () => {
  it("verifies the certificate for remote hosts and drops sslmode", () => {
    const config = clientConfig(
      "postgresql://u:p@db.example.com:6543/postgres?sslmode=require"
    );
    expect(config.ssl).toEqual({ rejectUnauthorized: true });
    expect(config.connectionString).not.toContain("sslmode");
    expect(config.connectionString).toContain("db.example.com:6543");
    expect(config.connectionTimeoutMillis).toBe(8000);
    expect(config.query_timeout).toBe(10000);
    expect("statement_timeout" in config).toBe(false);
  });

  it("strips every ssl* query parameter so nothing overrides verification", () => {
    const config = clientConfig(
      "postgresql://u:p@db.example.com:6543/postgres?sslmode=disable&ssl=0&sslrootcert=x&SSLCert=y&application_name=m"
    );
    expect(config.ssl).toEqual({ rejectUnauthorized: true });
    expect(config.connectionString).not.toMatch(/ssl/i);
    expect(config.connectionString).toContain("application_name=m");
  });

  it("adds the CA certificate when MONSOON_DB_CA_CERT is set", () => {
    vi.stubEnv("MONSOON_DB_CA_CERT", "-----BEGIN CERTIFICATE-----\nabc\n");
    const config = clientConfig("postgresql://u:p@db.example.com:6543/postgres");
    expect(config.ssl).toEqual({
      rejectUnauthorized: true,
      ca: "-----BEGIN CERTIFICATE-----\nabc\n",
    });
  });

  it("uses no ssl for local hosts", () => {
    expect(clientConfig("postgresql://u:p@127.0.0.1:55433/x").ssl).toBeUndefined();
    expect(clientConfig("postgresql://u:p@localhost:5432/x").ssl).toBeUndefined();
    expect(clientConfig("postgresql://u:p@[::1]:5432/x").ssl).toBeUndefined();
  });

  it("does not leak the connection string when it cannot be parsed", () => {
    let message = "";
    try {
      clientConfig("not a url with secret-pw");
    } catch (e) {
      message = String(e);
    }
    expect(message).toContain("Invalid database URL");
    expect(message).not.toContain("secret-pw");
  });
});

describe("withPipelineDb", () => {
  it("rejects with the connect error and never runs fn when connect fails", async () => {
    const fn = vi.fn();
    await expect(withPipelineDb("postgresql://u:p@127.0.0.1:1/x", fn)).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });

  it("refuses a disallowed address before connecting", async () => {
    const fn = vi.fn();
    await expect(
      withPipelineDb("postgresql://u:p@evil.com:6543/postgres", fn)
    ).rejects.toMatchObject({ code: "not_allowed" });
    expect(fn).not.toHaveBeenCalled();
  });

  it.skipIf(!testDb.available)("runs fn against a local allowed database", async () => {
    const result = await withPipelineDb(
      "postgresql://postgres:test@127.0.0.1:55433/postgres",
      async (db) => (await db.query("SELECT 1 AS one")).rows[0].one
    );
    expect(result).toBe(1);
  });

  it("rejects with the connect error and never runs fn when connect fails", async () => {
    const fn = vi.fn();
    await expect(withPipelineDb("postgresql://u:p@127.0.0.1:1/x", fn)).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("withPipelineDb with a shared schema", () => {
  it("refuses a schema name that is not a client schema, before connecting", async () => {
    const fn = vi.fn();
    for (const schema of ["public", "c_1", "c_0B9D2A476A3E4C1F9D552F7A3C1E8B10", "c_0b9d2a476a3e4c1f9d552f7a3c1e8b10, public", "", "pg_catalog"]) {
      await expect(withPipelineDb("postgresql://u:p@127.0.0.1:1/x", fn, schema), schema).rejects.toThrow("invalid schema name");
    }
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("pipelineClientConfig", () => {
  it("uses explicit fields from the validated URL and no connectionString", () => {
    vi.stubEnv("MONSOON_DB_CA_CERT", "CA");
    const c = pipelineClientConfig(
      "postgresql://monsoon_app.abc:p%40ss%3A%2F@aws-1-us-east-1.pooler.supabase.com:6543/postgres"
    );
    expect("connectionString" in c).toBe(false);
    expect(c.host).toBe("aws-1-us-east-1.pooler.supabase.com");
    expect(c.port).toBe(6543);
    expect(c.user).toBe("monsoon_app.abc");
    expect(c.password).toBe("p@ss:/");
    expect(c.database).toBe("postgres");
    expect(c.ssl).toEqual({ rejectUnauthorized: true, ca: "CA" });
    expect(c.connectionTimeoutMillis).toBe(8000);
    expect(c.query_timeout).toBe(10000);
  });

  it("refuses query-string overrides", () => {
    expect(() =>
      pipelineClientConfig("postgresql://u:p@x.pooler.supabase.com:6543/postgres?host=169.254.169.254&port=80")
    ).toThrow();
  });

  it("uses no ssl for allowed local hosts", () => {
    expect(pipelineClientConfig("postgresql://u:p@[::1]:5432/x").ssl).toBeUndefined();
    expect(pipelineClientConfig("postgresql://u:p@[::1]:5432/x").host).toBe("::1");
  });
});
