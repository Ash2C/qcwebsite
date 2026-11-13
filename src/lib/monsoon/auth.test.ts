import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_SECONDS,
  authConfigured,
  checkPasscode,
  requireSession,
  signSession,
  verifySession,
} from "./auth";

const PASSCODE = "correct-horse-battery-staple";
const SECRET = "x".repeat(32);

beforeEach(() => {
  vi.stubEnv("MONSOON_PASSCODE", PASSCODE);
  vi.stubEnv("MONSOON_SESSION_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("session tokens", () => {
  const now = 1_800_000_000_000;

  it("verifies a fresh token", () => {
    expect(verifySession(signSession(now), now)).toBe(true);
  });

  it("expires after the session length", () => {
    const token = signSession(now);
    expect(verifySession(token, now + SESSION_SECONDS * 1000 + 1000)).toBe(
      false
    );
  });

  it("rejects a token with a changed signature character", () => {
    const token = signSession(now);
    const last = token.slice(-1);
    const tampered = token.slice(0, -1) + (last === "0" ? "1" : "0");
    expect(verifySession(tampered, now)).toBe(false);
  });

  it("rejects a token whose expiry was edited upward", () => {
    const [v, expiry, sig] = signSession(now).split(".");
    const edited = [v, String(Number(expiry) + 1000), sig].join(".");
    expect(verifySession(edited, now)).toBe(false);
  });

  it("rejects missing and malformed tokens without throwing", () => {
    expect(verifySession(undefined, now)).toBe(false);
    expect(verifySession("", now)).toBe(false);
    expect(verifySession("v1.abc", now)).toBe(false);
    expect(verifySession("v1.123.zz", now)).toBe(false);
    expect(verifySession("v1.123.abcd", now)).toBe(false);
  });

  it("rejects a token signed under a different secret", () => {
    const token = signSession(now);
    vi.stubEnv("MONSOON_SESSION_SECRET", "y".repeat(32));
    expect(verifySession(token, now)).toBe(false);
  });
});

describe("checkPasscode", () => {
  it("accepts only the exact passcode", () => {
    expect(checkPasscode(PASSCODE)).toBe(true);
    expect(checkPasscode(PASSCODE.slice(0, -1))).toBe(false);
    expect(checkPasscode(PASSCODE + "x")).toBe(false);
    expect(checkPasscode("")).toBe(false);
  });
});

describe("authConfigured", () => {
  it("is true with a 16-char passcode and 32-char secret", () => {
    expect(authConfigured()).toBe(true);
  });

  it("is false with a 15-char passcode", () => {
    vi.stubEnv("MONSOON_PASSCODE", "a".repeat(15));
    expect(authConfigured()).toBe(false);
  });

  it("is false with a 31-char secret", () => {
    vi.stubEnv("MONSOON_SESSION_SECRET", "x".repeat(31));
    expect(authConfigured()).toBe(false);
  });
});

describe("requireSession", () => {
  function withCookie(cookie?: string): Request {
    return new Request("http://localhost/api/monsoon/x", {
      headers: cookie ? { cookie } : {},
    });
  }

  it("returns null for a valid cookie among other cookies", () => {
    const cookie = `a=1; monsoon_session=${signSession()}; b=2`;
    expect(requireSession(withCookie(cookie))).toBeNull();
  });

  it("returns 401 without a cookie", async () => {
    const res = requireSession(withCookie());
    expect(res?.status).toBe(401);
    expect(await res?.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 401 for an invalid cookie", () => {
    const res = requireSession(withCookie("monsoon_session=v1.1.deadbeef"));
    expect(res?.status).toBe(401);
  });
});
