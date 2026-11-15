import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_SECONDS,
  accountsConfigured,
  cookieValue,
  requireSession,
  signLegacySession,
  signSession,
  verifyLegacySession,
  verifySession,
} from "./auth";

const SECRET = "x".repeat(32);
const CUSTOMER = "0b9d2a47-6a3e-4c1f-9d55-2f7a3c1e8b10";
const PERSON = "7c3e1f2a-1b2c-4d5e-8f90-a1b2c3d4e5f6";
const C = { customerId: CUSTOMER, personId: PERSON, sessionNo: 3 };

beforeEach(() => {
  vi.stubEnv("MONSOON_SESSION_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function resign(payload: string): string {
  return `${payload}.${createHmac("sha256", SECRET).update(payload).digest("hex")}`;
}

describe("v2 session tokens", () => {
  const now = 1_800_000_000_000;

  it("round-trips customer, person and session number", () => {
    const token = signSession(C, now);
    expect(token.startsWith(`v2.${CUSTOMER}.${PERSON}.3.`)).toBe(true);
    expect(verifySession(token, now)).toEqual(C);
  });

  it("refuses a v1 token", () => {
    expect(verifySession(signLegacySession(now), now)).toBeNull();
  });

  it("expires after the session length", () => {
    const token = signSession(C, now);
    expect(verifySession(token, now + SESSION_SECONDS * 1000 - 1000)).toEqual(C);
    expect(verifySession(token, now + SESSION_SECONDS * 1000 + 1000)).toBeNull();
  });

  it("refuses a changed signature character", () => {
    const token = signSession(C, now);
    const last = token.slice(-1);
    expect(verifySession(token.slice(0, -1) + (last === "0" ? "1" : "0"), now)).toBeNull();
  });

  it("refuses an edited field under the old signature", () => {
    const parts = signSession(C, now).split(".");
    for (const [i, v] of [
      [1, PERSON],
      [2, CUSTOMER],
      [3, "4"],
      [4, String(Number(parts[4]) + 1000)],
    ] as const) {
      const edited = [...parts];
      edited[i] = v;
      expect(verifySession(edited.join("."), now)).toBeNull();
    }
  });

  it("refuses non-UUID ids and bad session numbers even when correctly signed", () => {
    const exp = Math.floor(now / 1000) + 100;
    expect(verifySession(resign(`v2.not-a-uuid.${PERSON}.1.${exp}`), now)).toBeNull();
    expect(verifySession(resign(`v2.${CUSTOMER}.${PERSON.toUpperCase()}x.1.${exp}`), now)).toBeNull();
    expect(verifySession(resign(`v2.${CUSTOMER}.${PERSON}.0.${exp}`), now)).toBeNull();
    expect(verifySession(resign(`v2.${CUSTOMER}.${PERSON}.-1.${exp}`), now)).toBeNull();
    expect(verifySession(resign(`v2.${CUSTOMER}.${PERSON}.1x.${exp}`), now)).toBeNull();
    expect(verifySession(resign(`v2.${CUSTOMER}.${PERSON}.1.${exp}`), now)).toEqual({
      customerId: CUSTOMER,
      personId: PERSON,
      sessionNo: 1,
    });
  });

  it("refuses missing and malformed tokens without throwing", () => {
    for (const t of [undefined, "", "v2", "v2.a.b.c.d.e", "v2.....",`v2.${CUSTOMER}.${PERSON}.1.1.zz`]) {
      expect(verifySession(t, now)).toBeNull();
    }
  });

  it("refuses a token signed under a different secret, and everything with a short secret", () => {
    const token = signSession(C, now);
    vi.stubEnv("MONSOON_SESSION_SECRET", "y".repeat(32));
    expect(verifySession(token, now)).toBeNull();
    vi.stubEnv("MONSOON_SESSION_SECRET", "x".repeat(31));
    expect(verifySession(token, now)).toBeNull();
  });
});

describe("legacy v1 tokens (until Task 9)", () => {
  const now = 1_800_000_000_000;

  it("still verify, and v2 tokens are not accepted as v1", () => {
    expect(verifyLegacySession(signLegacySession(now), now)).toBe(true);
    expect(verifyLegacySession(signSession(C, now), now)).toBe(false);
  });

  it("requireSession accepts a v1 cookie and refuses none", async () => {
    const ok = new Request("http://localhost/x", {
      headers: { cookie: `a=1; monsoon_session=${signLegacySession()}; b=2` },
    });
    expect(requireSession(ok)).toBeNull();
    const res = requireSession(new Request("http://localhost/x"));
    expect(res?.status).toBe(401);
    expect(await res?.json()).toEqual({ error: "unauthorized" });
  });
});

describe("cookieValue", () => {
  it("finds a named cookie among others", () => {
    const req = new Request("http://localhost/x", { headers: { cookie: "a=1; monsoon_session=abc; b=2" } });
    expect(cookieValue(req, "monsoon_session")).toBe("abc");
    expect(cookieValue(req, "missing")).toBeUndefined();
    expect(cookieValue(new Request("http://localhost/x"), "a")).toBeUndefined();
  });
});

describe("accountsConfigured", () => {
  beforeEach(() => {
    vi.stubEnv("MONSOON_MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
    vi.stubEnv("MONSOON_ACCOUNTS_DATABASE_URL", "postgresql://u:p@127.0.0.1:5432/accounts_test");
  });

  it("is true with a 32-char secret, a master key and an accounts URL", () => {
    expect(accountsConfigured()).toBe(true);
  });

  it("is false when any one is missing or short", () => {
    vi.stubEnv("MONSOON_SESSION_SECRET", "x".repeat(31));
    expect(accountsConfigured()).toBe(false);
    vi.stubEnv("MONSOON_SESSION_SECRET", SECRET);
    vi.stubEnv("MONSOON_MASTER_KEY", "");
    expect(accountsConfigured()).toBe(false);
    vi.stubEnv("MONSOON_MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
    vi.stubEnv("MONSOON_ACCOUNTS_DATABASE_URL", "");
    expect(accountsConfigured()).toBe(false);
  });
});
