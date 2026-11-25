import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signSession, verifySession } from "./auth";
import {
  GOOGLE_NONCE_COOKIE,
  GOOGLE_STATE_SECONDS,
  authUrl,
  exchangeCode,
  googleConfigured,
  newNonce,
  sameNonce,
  signState,
  signupsConfigured,
  verifyState,
} from "./google";

const SECRET = "x".repeat(32);
const CLIENT_ID = "1234-fake.apps.googleusercontent.com";
// Obviously fake: the shape only.
const CLIENT_SECRET = "FAKE-client-secret-000000";
const REDIRECT = "https://quantcloud.com/api/monsoon/google/callback";
const CUSTOMER = "0b9d2a47-6a3e-4c1f-9d55-2f7a3c1e8b10";
const PERSON = "7c3e1f2a-1b2c-4d5e-8f90-a1b2c3d4e5f6";
const NOW = 1_800_000_000_000;

beforeEach(() => {
  vi.stubEnv("MONSOON_SESSION_SECRET", SECRET);
  vi.stubEnv("MONSOON_MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("MONSOON_ACCOUNTS_DATABASE_URL", "postgresql://u:p@127.0.0.1:1/x");
  vi.stubEnv("MONSOON_GOOGLE_CLIENT_ID", CLIENT_ID);
  vi.stubEnv("MONSOON_GOOGLE_CLIENT_SECRET", CLIENT_SECRET);
  vi.stubEnv("MONSOON_GOOGLE_REDIRECT_URI", REDIRECT);
  vi.stubEnv("MONSOON_SHARED_DB_ADMIN_URL", "postgresql://postgres.abcdefghijklmnopqrst:pw@aws-0-eu.pooler.supabase.com:5432/postgres");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("googleConfigured", () => {
  it("is on only with every setting present", () => {
    expect(googleConfigured()).toBe(true);
    for (const name of [
      "MONSOON_GOOGLE_CLIENT_ID",
      "MONSOON_GOOGLE_CLIENT_SECRET",
      "MONSOON_GOOGLE_REDIRECT_URI",
      "MONSOON_SESSION_SECRET",
      "MONSOON_MASTER_KEY",
      "MONSOON_ACCOUNTS_DATABASE_URL",
    ]) {
      const before = process.env[name] as string;
      vi.stubEnv(name, "");
      expect(googleConfigured(), name).toBe(false);
      vi.stubEnv(name, before);
    }
    expect(googleConfigured()).toBe(true);
  });

  it("is off when the redirect address is not a fixed https address (or localhost)", () => {
    for (const bad of ["not a url", "http://quantcloud.com/api/monsoon/google/callback", "javascript:alert(1)", "https://quantcloud.com/cb#frag"]) {
      vi.stubEnv("MONSOON_GOOGLE_REDIRECT_URI", bad);
      expect(googleConfigured(), bad).toBe(false);
    }
    vi.stubEnv("MONSOON_GOOGLE_REDIRECT_URI", "http://localhost:3000/api/monsoon/google/callback");
    expect(googleConfigured()).toBe(true);
  });
});

describe("signupsConfigured", () => {
  it("signing in and linking do not need the shared database; new requests and approving do", () => {
    expect(signupsConfigured()).toBe(true);
    vi.stubEnv("MONSOON_SHARED_DB_ADMIN_URL", "");
    expect(googleConfigured()).toBe(true);
    expect(signupsConfigured()).toBe(false);
  });

  it("is off whenever Sign in with Google is off", () => {
    vi.stubEnv("MONSOON_GOOGLE_CLIENT_ID", "");
    expect(signupsConfigured()).toBe(false);
  });
});

describe("the signed state", () => {
  it("round-trips a nonce, with and without a link", () => {
    const nonce = newNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newNonce()).not.toBe(nonce);
    expect(verifyState(signState({ nonce }, NOW), NOW)).toEqual({ nonce });
    const link = { customerId: CUSTOMER, personId: PERSON, sessionNo: 3 };
    expect(verifyState(signState({ nonce, link }, NOW), NOW)).toEqual({ nonce, link });
    expect(signState({ nonce }, NOW)).toMatch(/^[A-Za-z0-9._~-]+$/);
  });

  it("lasts ten minutes and no longer", () => {
    expect(GOOGLE_STATE_SECONDS).toBe(600);
    const state = signState({ nonce: newNonce() }, NOW);
    expect(verifyState(state, NOW + 599_000)).not.toBeNull();
    expect(verifyState(state, NOW + 600_000)).toBeNull();
    expect(verifyState(state, NOW + 86_400_000)).toBeNull();
  });

  it("refuses anything tampered with, malformed or missing", () => {
    const nonce = newNonce();
    const state = signState({ nonce }, NOW);
    const parts = state.split(".");
    const other = newNonce();
    const swap = (i: number, v: string) => parts.map((p, j) => (j === i ? v : p)).join(".");
    expect(verifyState(swap(1, other), NOW)).toBeNull();
    expect(verifyState(swap(2, String(Number(parts[2]) + 1)), NOW)).toBeNull();
    expect(verifyState(swap(3, `${CUSTOMER}~${PERSON}~3`), NOW)).toBeNull();
    expect(verifyState(swap(4, "0".repeat(64)), NOW)).toBeNull();
    expect(verifyState(swap(0, "g2"), NOW)).toBeNull();
    expect(verifyState(state + "0", NOW)).toBeNull();
    expect(verifyState(state.slice(0, -1), NOW)).toBeNull();
    for (const bad of [undefined, null, "", "a.b.c.d.e", ".....", 5, {}, [state]]) {
      expect(verifyState(bad as unknown as string, NOW)).toBeNull();
    }
    expect(verifyState("x".repeat(5000), NOW)).toBeNull();
  });

  it("a link cannot be added to a signed state, or moved to another person", () => {
    const nonce = newNonce();
    const plain = signState({ nonce }, NOW).split(".");
    const linked = signState({ nonce, link: { customerId: CUSTOMER, personId: PERSON, sessionNo: 3 } }, NOW).split(".");
    expect(verifyState([plain[0], plain[1], plain[2], linked[3], plain[4]].join("."), NOW)).toBeNull();
    expect(verifyState([linked[0], linked[1], linked[2], plain[3], linked[4]].join("."), NOW)).toBeNull();
    const elsewhere = `${CUSTOMER}~${PERSON.replace(/^7/, "8")}~3`;
    expect(verifyState([linked[0], linked[1], linked[2], elsewhere, linked[4]].join("."), NOW)).toBeNull();
  });

  it("a link carries the session number it was started under, and that number cannot be changed or left out", () => {
    const nonce = newNonce();
    const state = signState({ nonce, link: { customerId: CUSTOMER, personId: PERSON, sessionNo: 41 } }, NOW);
    expect(verifyState(state, NOW)).toEqual({ nonce, link: { customerId: CUSTOMER, personId: PERSON, sessionNo: 41 } });
    const parts = state.split(".");
    expect(parts[3]).toBe(`${CUSTOMER}~${PERSON}~41`);
    for (const link of [`${CUSTOMER}~${PERSON}~42`, `${CUSTOMER}~${PERSON}`, `${CUSTOMER}~${PERSON}~`]) {
      expect(verifyState([parts[0], parts[1], parts[2], link, parts[4]].join("."), NOW), link).toBeNull();
    }
    for (const sessionNo of [0, -1, 1.5, NaN, 2 ** 31, "1", undefined]) {
      expect(() => signState({ nonce, link: { customerId: CUSTOMER, personId: PERSON, sessionNo: sessionNo as number } }, NOW), String(sessionNo)).toThrow();
    }
  });

  it("refuses to sign a malformed nonce or link", () => {
    expect(() => signState({ nonce: "short" }, NOW)).toThrow();
    expect(() => signState({ nonce: "a.b".padEnd(43, "x") }, NOW)).toThrow();
    expect(() => signState({ nonce: newNonce(), link: { customerId: "nope", personId: PERSON, sessionNo: 3 } }, NOW)).toThrow();
  });

  it("a state is never a session, and a session is never a state", () => {
    const nonce = newNonce();
    const state = signState({ nonce, link: { customerId: CUSTOMER, personId: PERSON, sessionNo: 3 } }, NOW);
    expect(verifySession(state, NOW)).toBeNull();
    const session = signSession({ customerId: CUSTOMER, personId: PERSON, sessionNo: 1 }, NOW);
    expect(verifySession(session, NOW)).not.toBeNull();
    expect(verifyState(session, NOW)).toBeNull();
    // The same secret without the state prefix (how a session is signed) does not make a state.
    const payload = state.split(".").slice(0, 4).join(".");
    const asSession = `${payload}.${createHmac("sha256", SECRET).update(payload).digest("hex")}`;
    expect(verifyState(asSession, NOW)).toBeNull();
    const asState = `${payload}.${createHmac("sha256", SECRET).update(`google-state:${payload}`).digest("hex")}`;
    expect(verifyState(asState, NOW)).not.toBeNull();
  });

  it("verifies nothing without a session secret", () => {
    const state = signState({ nonce: newNonce() }, NOW);
    vi.stubEnv("MONSOON_SESSION_SECRET", "short");
    expect(verifyState(state, NOW)).toBeNull();
    expect(() => signState({ nonce: newNonce() }, NOW)).toThrow();
  });

  it("sameNonce compares whole values and never throws", () => {
    const nonce = newNonce();
    expect(sameNonce(nonce, nonce)).toBe(true);
    expect(sameNonce(nonce, newNonce())).toBe(false);
    expect(sameNonce(nonce, nonce.slice(0, -1))).toBe(false);
    expect(sameNonce(nonce, undefined)).toBe(false);
    expect(sameNonce("", "")).toBe(false);
    expect(sameNonce(undefined, undefined)).toBe(false);
    expect(GOOGLE_NONCE_COOKIE).toBe("monsoon_g");
  });
});

describe("authUrl", () => {
  it("points at Google with the fixed redirect address and the three scopes", () => {
    const state = signState({ nonce: newNonce() }, NOW);
    const url = new URL(authUrl(state));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      response_type: "code",
      scope: "openid email profile",
      state,
      prompt: "select_account",
    });
    expect(url.toString()).not.toContain(CLIENT_SECRET);
  });
});

describe("exchangeCode", () => {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const claims = (over: Record<string, unknown> = {}) => ({
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: "109876543210987654321",
    email: "gil@example.com",
    email_verified: true,
    name: "Gil Hale",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...over,
  });
  const idToken = (c: unknown) => `${b64({ alg: "RS256" })}.${b64(c)}.c2lnbmF0dXJl`;
  const reply = (body: unknown, status = 200) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  function stubFetch(impl: (...a: unknown[]) => unknown) {
    const f = vi.fn(impl);
    vi.stubGlobal("fetch", f);
    return f;
  }
  const answers = (c: unknown) => stubFetch(async () => reply({ access_token: "ya29.FAKE", id_token: idToken(c), token_type: "Bearer" }));

  it("posts the code to Google's fixed token address and returns the id, email and name", async () => {
    const f = answers(claims());
    expect(await exchangeCode("4/FAKE-code")).toEqual({ ok: true, sub: "109876543210987654321", email: "gil@example.com", name: "Gil Hale" });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(init.body as string))).toEqual({
      code: "4/FAKE-code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT,
      grant_type: "authorization_code",
    });
  });

  it("accepts either issuer spelling, and falls back to the email's local part for a missing name", async () => {
    answers(claims({ iss: "accounts.google.com", name: undefined }));
    expect(await exchangeCode("c")).toEqual({ ok: true, sub: "109876543210987654321", email: "gil@example.com", name: "gil" });
    answers(claims({ name: "   " }));
    expect(await exchangeCode("c")).toMatchObject({ ok: true, name: "gil" });
    answers(claims({ name: 5 }));
    expect(await exchangeCode("c")).toMatchObject({ ok: true, name: "gil" });
    answers(claims({ name: `  Gil\u0000\n Hale  ${"x".repeat(500)}` }));
    const long = await exchangeCode("c");
    expect(long).toMatchObject({ ok: true });
    if (long.ok) {
      expect(long.name.startsWith("Gil Hale x")).toBe(true);
      expect(long.name.length).toBeLessThanOrEqual(200);
    }
  });

  it("takes backslashes and control characters out of the name Google gives", async () => {
    answers(claims({ name: "\\'); CREATE TABLE pwned(x int); --" }));
    expect(await exchangeCode("c")).toMatchObject({ ok: true, name: "'); CREATE TABLE pwned(x int); --" });
    answers(claims({ name: "Gil\\\\ \u0085Hale\u009f\u2028\u202e\ufeff\u200b Jr\\" }));
    expect(await exchangeCode("c")).toMatchObject({ ok: true, name: "Gil Hale Jr" });
    answers(claims({ name: "\\\u0007\\" }));
    expect(await exchangeCode("c")).toMatchObject({ ok: true, name: "gil" });
    answers(claims({ name: "\\".repeat(150) + "y".repeat(500) }));
    const long = await exchangeCode("c");
    expect(long).toMatchObject({ ok: true, name: "y".repeat(200) });
  });

  it("refuses a token for another app, from another issuer, expired, unverified, or without a proper Google id", async () => {
    const bad: Record<string, unknown>[] = [
      { aud: "someone-else.apps.googleusercontent.com" },
      { aud: [CLIENT_ID, "someone-else"] },
      { aud: undefined },
      { iss: "https://accounts.google.com.evil.example" },
      { iss: "accounts.google.com/" },
      { iss: undefined },
      { exp: Math.floor(Date.now() / 1000) - 1 },
      { exp: "never" },
      { exp: undefined },
      { email_verified: false },
      { email_verified: "true" },
      { email_verified: undefined },
      { sub: "abc" },
      { sub: "" },
      { sub: 109876543210987650000 },
      { sub: "1".repeat(65) },
      { sub: "123 OR 1=1" },
      { sub: undefined },
      { email: undefined },
      { email: "not-an-email" },
      { email: `${"a".repeat(320)}@example.com` },
      { email: "a b@example.com" },
    ];
    for (const over of bad) {
      answers(claims(over));
      expect(await exchangeCode("c"), JSON.stringify(over)).toEqual({ ok: false });
    }
  });

  it("refuses a reply that is not what Google sends, without throwing", async () => {
    const replies: (() => Promise<Response>)[] = [
      async () => reply({ error: "invalid_grant" }, 400),
      async () => reply({ error: "invalid_client" }, 401),
      async () => reply("busy", 503),
      async () => reply("not json"),
      async () => reply({ access_token: "ya29.FAKE" }),
      async () => reply({ id_token: 5 }),
      async () => reply({ id_token: "only.two" }),
      async () => reply({ id_token: "a.!!!.c" }),
      async () => reply({ id_token: `a.${Buffer.from("[1]").toString("base64url")}.c` }),
      async () => reply({ id_token: `a.${Buffer.from("null").toString("base64url")}.c` }),
      async () => reply([1, 2]),
      async () => reply("x".repeat(200_000)),
      async () => {
        throw new TypeError("fetch failed");
      },
      async () => {
        throw new DOMException("The operation timed out", "TimeoutError");
      },
    ];
    for (const r of replies) {
      const f = stubFetch(r);
      expect(await exchangeCode("c")).toEqual({ ok: false });
      expect(f).toHaveBeenCalledTimes(1); // no retries
    }
  });

  it("sends nothing for a code that is missing, too long or not a string, or when not configured", async () => {
    const f = answers(claims());
    for (const bad of ["", " ", undefined, null, 5, "x".repeat(3000), "a\nb", ["c"]]) {
      expect(await exchangeCode(bad as unknown as string)).toEqual({ ok: false });
    }
    vi.stubEnv("MONSOON_GOOGLE_CLIENT_SECRET", "");
    expect(await exchangeCode("c")).toEqual({ ok: false });
    expect(f).not.toHaveBeenCalled();
  });

  it("logs nothing, whatever happens", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    answers(claims());
    await exchangeCode("4/FAKE-code");
    answers(claims({ aud: "other" }));
    await exchangeCode("4/FAKE-code");
    stubFetch(async () => reply({ error: "invalid_grant", error_description: "Bad Request" }, 400));
    await exchangeCode("4/FAKE-code");
    stubFetch(async () => {
      throw new Error(`boom ${CLIENT_SECRET}`);
    });
    await exchangeCode("4/FAKE-code");
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it("gives up after eight seconds", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    answers(claims());
    await exchangeCode("c");
    expect(timeout).toHaveBeenCalledWith(8000);
  });
});
