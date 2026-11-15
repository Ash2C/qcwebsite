import { afterEach, describe, expect, it, vi } from "vitest";
import { clientConfig, withEstateDb, withPipelineDb } from "./db";
import { ESTATES } from "./estates";
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

describe("withEstateDb", () => {
  it("rejects when the env var is empty", async () => {
    vi.stubEnv("TRAXO_CRM_DATABASE_URL", "");
    await expect(withEstateDb(ESTATES[0], async () => 1)).rejects.toThrow(
      "TRAXO_CRM_DATABASE_URL is not set"
    );
  });

  it.skipIf(!testDb.available)("runs fn against a connected client and ends it", async () => {
    vi.stubEnv(
      "TRAXO_CRM_DATABASE_URL",
      "postgresql://postgres:test@127.0.0.1:55433/postgres"
    );
    const result = await withEstateDb(ESTATES[0], async (db) => {
      const r = await db.query("SELECT 1 AS one");
      return r.rows[0].one;
    });
    expect(result).toBe(1);
  });

  it("rejects with the connect error and never runs fn when connect fails", async () => {
    vi.stubEnv("TRAXO_CRM_DATABASE_URL", "postgresql://u:p@127.0.0.1:1/x");
    const fn = vi.fn();
    await expect(withEstateDb(ESTATES[0], fn)).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("withPipelineDb", () => {
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
