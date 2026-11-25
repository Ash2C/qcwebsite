import { afterEach, describe, expect, it, vi } from "vitest";
import { AddressError, assertAllowedDbUrl, buildPoolerUrl, buildSharedPoolerUrl } from "./address";

afterEach(() => vi.unstubAllEnvs());

const REF = "abcdefghij0123456789";
const HOST = "aws-1-us-east-1.pooler.supabase.com";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof AddressError ? e.code : "other";
  }
  return undefined;
}

describe("assertAllowedDbUrl", () => {
  it("accepts Supabase pooler hosts on 6543 and 5432 (and no port)", () => {
    expect(() => assertAllowedDbUrl(`postgresql://u:p@${HOST}:6543/postgres`)).not.toThrow();
    expect(() => assertAllowedDbUrl(`postgresql://u:p@${HOST}:5432/postgres`)).not.toThrow();
    expect(() => assertAllowedDbUrl(`postgresql://u:p@${HOST}/postgres`)).not.toThrow();
    expect(() =>
      assertAllowedDbUrl("postgresql://u:p@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres")
    ).not.toThrow();
    expect(() => assertAllowedDbUrl(`postgresql://u:p@${HOST.toUpperCase()}:6543/postgres`)).not.toThrow();
  });

  it.each([
    "postgresql://u:p@db.x.supabase.co:5432/postgres",
    "postgresql://u:p@evil.com:6543/postgres",
    "postgresql://u:p@pooler.supabase.com.evil.com:6543/postgres",
    "postgresql://u:p@x.pooler.supabase.com.evil.com:6543/postgres",
    "postgresql://u:p@10.0.0.1:6543/postgres",
    `postgresql://u:p@${HOST}:5433/postgres`,
    "not a url",
    `postgresql://u:p@${HOST}:6543/postgres?host=10.0.0.1`,
    `postgresql://u:p@${HOST}:6543/postgres?port=80`,
    `postgresql://u:p@${HOST}:6543/postgres?user=postgres`,
    `postgresql://u:p@${HOST}:6543/postgres?`,
    `postgresql://u:p@${HOST}:6543/postgres#frag`,
    `socket://${HOST}/var/run/postgresql`,
    `mysql://u:p@${HOST}:6543/postgres`,
    `http://u:p@${HOST}:6543/postgres`,
    `postgresql://u:p@${HOST}:6543/post gres`,
    `postgresql://u:p@${HOST}:6543/postgrés`,
  ])("rejects %s", (url) => {
    expect(codeOf(() => assertAllowedDbUrl(url))).toBe("not_allowed");
  });

  it("allows local hosts only with the switch and outside production", () => {
    vi.stubEnv("MONSOON_ALLOW_LOCAL_DB", "1");
    vi.stubEnv("NODE_ENV", "test");
    expect(() => assertAllowedDbUrl("postgresql://u:p@localhost:5432/x")).not.toThrow();
    expect(() => assertAllowedDbUrl("postgresql://u:p@127.0.0.1:55433/x")).not.toThrow();
    expect(() => assertAllowedDbUrl("postgresql://u:p@[::1]:5432/x")).not.toThrow();
    expect(codeOf(() => assertAllowedDbUrl("postgresql://u:p@10.0.0.1:5432/x"))).toBe("not_allowed");

    vi.stubEnv("NODE_ENV", "production");
    expect(codeOf(() => assertAllowedDbUrl("postgresql://u:p@localhost:5432/x"))).toBe("not_allowed");

    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("MONSOON_ALLOW_LOCAL_DB", "");
    expect(codeOf(() => assertAllowedDbUrl("postgresql://u:p@localhost:5432/x"))).toBe("not_allowed");
  });

  it("never puts the URL or password in the error", () => {
    try {
      assertAllowedDbUrl("postgresql://u:secret-pw@evil.com:6543/postgres");
    } catch (e) {
      expect(String(e)).not.toContain("secret-pw");
      expect(String(e)).not.toContain("evil.com");
    }
  });
});

describe("buildPoolerUrl", () => {
  it("builds the URL with the monsoon_app user and an encoded password", () => {
    const url = buildPoolerUrl({ projectRef: REF, poolerHost: HOST, password: "p@ss:/word" });
    expect(url).toBe(`postgresql://monsoon_app.${REF}:${encodeURIComponent("p@ss:/word")}@${HOST}:6543/postgres`);
    const parsed = new URL(url);
    expect(decodeURIComponent(parsed.password)).toBe("p@ss:/word");
    expect(() => assertAllowedDbUrl(url)).not.toThrow();
  });

  it("rejects a bad project ref", () => {
    for (const projectRef of ["ABC", "short", `${REF}x`, "abcdefghij012345678!"]) {
      expect(codeOf(() => buildPoolerUrl({ projectRef, poolerHost: HOST, password: "x" }))).toBe("bad_ref");
    }
  });

  it("rejects a bad host", () => {
    for (const poolerHost of ["evil.com", `${HOST}.evil.com`, "db.x.supabase.co", `${HOST}:6543`, ""]) {
      expect(codeOf(() => buildPoolerUrl({ projectRef: REF, poolerHost, password: "x" }))).toBe("bad_host");
    }
  });

  it("rejects an empty, long or control-character password without echoing it", () => {
    for (const password of ["", "a".repeat(201), "ab\ncd", "ab\u0000cd", "ab\u007fcd"]) {
      expect(codeOf(() => buildPoolerUrl({ projectRef: REF, poolerHost: HOST, password }))).toBe("bad_password");
    }
    try {
      buildPoolerUrl({ projectRef: REF, poolerHost: HOST, password: "secret\n" });
    } catch (e) {
      expect(String(e)).not.toContain("secret");
    }
    expect(() => buildPoolerUrl({ projectRef: REF, poolerHost: HOST, password: "a".repeat(200) })).not.toThrow();
  });
});

describe("buildSharedPoolerUrl", () => {
  const ADMIN = `postgresql://postgres.${REF}:owner-pw@${HOST}:5432/postgres`;
  const ROLE = "monsoon_c_0b9d2a476a3e4c1f9d552f7a3c1e8b10";

  it("builds the transaction-mode address for the role on the admin address's project and host", () => {
    const url = buildSharedPoolerUrl({ adminUrl: ADMIN, role: ROLE, password: "p@ss:/word" });
    expect(url).toBe(`postgresql://${ROLE}.${REF}:${encodeURIComponent("p@ss:/word")}@${HOST}:6543/postgres`);
    expect(() => assertAllowedDbUrl(url)).not.toThrow();
    expect(url).not.toContain("owner-pw");
  });

  it("refuses an admin address that is not a Supabase pooler address for postgres.<ref>", () => {
    const bad = [
      `postgresql://postgres.${REF}:pw@evil.com:5432/postgres`,
      `postgresql://postgres.${REF}:pw@db.${REF}.supabase.co:5432/postgres`,
      `postgresql://postgres.${REF}:pw@${HOST}:5432/postgres?host=evil.com`,
      "not a url",
      "",
    ];
    for (const adminUrl of bad) expect(codeOf(() => buildSharedPoolerUrl({ adminUrl, role: ROLE, password: "x" })), adminUrl).toBe("not_allowed");
    for (const user of ["postgres", "postgres.short", `someone.${REF}`, `postgres.${REF}.x`, `postgres.${REF.toUpperCase()}`]) {
      expect(codeOf(() => buildSharedPoolerUrl({ adminUrl: `postgresql://${user}:pw@${HOST}:5432/postgres`, role: ROLE, password: "x" })), user).toBe("bad_ref");
    }
  });

  it("refuses a role that is not a client login name", () => {
    for (const role of ["monsoon_app", "postgres", "monsoon_c_", `${ROLE}x`, "monsoon_c_0B9D2A476A3E4C1F9D552F7A3C1E8B10", `${ROLE}.other`, ""]) {
      expect(codeOf(() => buildSharedPoolerUrl({ adminUrl: ADMIN, role, password: "x" })), role).toBe("not_allowed");
    }
  });

  it("refuses an empty, long or control-character password without echoing it or the admin password", () => {
    for (const password of ["", "a".repeat(201), "ab\ncd"]) {
      expect(codeOf(() => buildSharedPoolerUrl({ adminUrl: ADMIN, role: ROLE, password }))).toBe("bad_password");
    }
    try {
      buildSharedPoolerUrl({ adminUrl: `postgresql://postgres:owner-pw@${HOST}:5432/postgres`, role: ROLE, password: "x" });
    } catch (e) {
      expect(String(e)).not.toContain("owner-pw");
    }
  });

  it("in development, a local admin address gives the role on the same local database", () => {
    vi.stubEnv("MONSOON_ALLOW_LOCAL_DB", "1");
    vi.stubEnv("NODE_ENV", "test");
    const url = buildSharedPoolerUrl({ adminUrl: "postgresql://postgres:test@127.0.0.1:55433/monsoon_x_test", role: ROLE, password: "pw-1" });
    expect(url).toBe(`postgresql://${ROLE}:pw-1@127.0.0.1:55433/monsoon_x_test`);
    vi.stubEnv("NODE_ENV", "production");
    expect(codeOf(() => buildSharedPoolerUrl({ adminUrl: "postgresql://postgres:test@127.0.0.1:55433/monsoon_x_test", role: ROLE, password: "pw-1" }))).toBe("not_allowed");
  });
});
