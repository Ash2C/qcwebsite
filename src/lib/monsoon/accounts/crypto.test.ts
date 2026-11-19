import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import {
  DUMMY_PASSCODE_HASH,
  decryptSecret,
  encryptSecret,
  generatePasscode,
  hashAddress,
  hashPasscode,
  hashToken,
  masterKeyConfigured,
  newToken,
  verifyPasscode,
} from "./crypto";
import { WORDS } from "./words";

const KEY = randomBytes(32).toString("base64");

beforeEach(() => {
  vi.stubEnv("MONSOON_MASTER_KEY", KEY);
  vi.stubEnv("MONSOON_SESSION_SECRET", "s".repeat(32));
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("encryptSecret / decryptSecret", () => {
  it("round trips", () => {
    const s = encryptSecret("sk-ant-secret", "cust1", "claude_key");
    expect(s.startsWith("k1.")).toBe(true);
    expect(s.split(".")).toHaveLength(4);
    expect(s).not.toContain("sk-ant-secret");
    expect(decryptSecret(s, "cust1", "claude_key")).toBe("sk-ant-secret");
  });
  it("fails for another customer id", () => {
    const s = encryptSecret("x", "cust1", "claude_key");
    expect(() => decryptSecret(s, "cust2", "claude_key")).toThrow("Could not decrypt");
  });
  it("fails for another field", () => {
    const s = encryptSecret("x", "cust1", "claude_key");
    expect(() => decryptSecret(s, "cust1", "pipeline:a")).toThrow("Could not decrypt");
  });
  it("fails when a ciphertext byte is flipped", () => {
    const s = encryptSecret("hello world", "c", "claude_key");
    const parts = s.split(".");
    const ct = Buffer.from(parts[2], "base64url");
    ct[0] ^= 1;
    parts[2] = ct.toString("base64url");
    expect(() => decryptSecret(parts.join("."), "c", "claude_key")).toThrow("Could not decrypt");
  });
  it("fails for a k2 prefix and garbage", () => {
    const s = encryptSecret("x", "c", "f");
    expect(() => decryptSecret("k2" + s.slice(2), "c", "f")).toThrow("Could not decrypt");
    expect(() => decryptSecret("nonsense", "c", "f")).toThrow("Could not decrypt");
  });
  it("fails with a different master key", () => {
    const s = encryptSecret("x", "c", "f");
    vi.stubEnv("MONSOON_MASTER_KEY", randomBytes(32).toString("base64"));
    expect(() => decryptSecret(s, "c", "f")).toThrow("Could not decrypt");
  });
  it("treats a missing or short key as not configured and refuses to encrypt", () => {
    vi.stubEnv("MONSOON_MASTER_KEY", "");
    expect(masterKeyConfigured()).toBe(false);
    expect(() => encryptSecret("x", "c", "f")).toThrow();
    vi.stubEnv("MONSOON_MASTER_KEY", randomBytes(16).toString("base64"));
    expect(masterKeyConfigured()).toBe(false);
    expect(() => encryptSecret("x", "c", "f")).toThrow();
    vi.stubEnv("MONSOON_MASTER_KEY", KEY);
    expect(masterKeyConfigured()).toBe(true);
  });
  it("never leaks the plaintext in errors", () => {
    vi.stubEnv("MONSOON_MASTER_KEY", "short");
    try {
      encryptSecret("topsecret", "c", "f");
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("topsecret");
      expect(String((e as Error).message)).not.toContain("short");
    }
  });
  it("produces different output for the same value", () => {
    expect(encryptSecret("x", "c", "f")).not.toBe(encryptSecret("x", "c", "f"));
  });
});

describe("passcodes", () => {
  it("verifies right and wrong", async () => {
    const h = await hashPasscode("alpha-beta-gamma-delta-omega");
    expect(h.startsWith("s1.")).toBe(true);
    expect(h.split(".")).toHaveLength(3);
    expect(await verifyPasscode("alpha-beta-gamma-delta-omega", h)).toBe(true);
    expect(await verifyPasscode("alpha-beta-gamma-delta-other", h)).toBe(false);
  });
  it("rejects malformed stored values and verifies against the dummy", async () => {
    expect(await verifyPasscode("x", "garbage")).toBe(false);
    expect(await verifyPasscode("x", "s2.a.b")).toBe(false);
    expect(await verifyPasscode("x", DUMMY_PASSCODE_HASH)).toBe(false);
  });
  it("generates five words from the list", () => {
    expect(WORDS.length).toBe(7772);
    for (const w of WORDS) expect(w).toMatch(/^[a-z]+$/);
    const parts = generatePasscode().split("-");
    expect(parts).toHaveLength(5);
    for (const p of parts) expect(WORDS).toContain(p);
  });
});

describe("tokens and addresses", () => {
  it("hashToken is 64 hex chars", () => {
    expect(hashToken("abc")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken("abc")).toBe(hashToken("abc"));
  });
  it("newToken is 32 bytes base64url and unique", () => {
    const t = newToken();
    expect(Buffer.from(t, "base64url")).toHaveLength(32);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(newToken()).not.toBe(t);
  });
  it("hashAddress is keyed hex", () => {
    const a = hashAddress("1.2.3.4");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAddress("1.2.3.4")).toBe(a);
    vi.stubEnv("MONSOON_SESSION_SECRET", "t".repeat(32));
    expect(hashAddress("1.2.3.4")).not.toBe(a);
  });
});
