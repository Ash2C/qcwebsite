import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lib = {
  findPersonByGoogleSub: vi.fn(),
  findSignup: vi.fn(),
  googleIdHeld: vi.fn(),
  requestSignup: vi.fn(),
  linkGoogle: vi.fn(),
  beginGoogleAttempt: vi.fn(),
  settleGoogleAttempt: vi.fn(),
};
vi.mock("@/lib/monsoon/accounts/signups", () => ({
  findPersonByGoogleSub: (...a: unknown[]) => lib.findPersonByGoogleSub(...a),
  findSignup: (...a: unknown[]) => lib.findSignup(...a),
  googleIdHeld: (...a: unknown[]) => lib.googleIdHeld(...a),
  requestSignup: (...a: unknown[]) => lib.requestSignup(...a),
  linkGoogle: (...a: unknown[]) => lib.linkGoogle(...a),
  beginGoogleAttempt: (...a: unknown[]) => lib.beginGoogleAttempt(...a),
  settleGoogleAttempt: (...a: unknown[]) => lib.settleGoogleAttempt(...a),
}));
const store = { recordActivity: vi.fn(), evictAccount: vi.fn() };
vi.mock("@/lib/monsoon/accounts/store", async (original) => ({
  ...(await original<typeof import("@/lib/monsoon/accounts/store")>()),
  recordActivity: (...a: unknown[]) => store.recordActivity(...a),
  evictAccount: (...a: unknown[]) => store.evictAccount(...a),
}));
const startTrialClock = vi.fn();
vi.mock("@/lib/monsoon/accounts/trial", () => ({ startTrialClock: (...a: unknown[]) => startTrialClock(...a) }));
const exchangeCode = vi.fn();
vi.mock("@/lib/monsoon/google", async (original) => ({
  ...(await original<typeof import("@/lib/monsoon/google")>()),
  exchangeCode: (...a: unknown[]) => exchangeCode(...a),
}));

import { signSession, verifySession } from "@/lib/monsoon/auth";
import { hashAddress } from "@/lib/monsoon/accounts/crypto";
import { newNonce, signState } from "@/lib/monsoon/google";
import { GET, maxDuration } from "./route";

const CUSTOMER = "0b9d2a47-6a3e-4c1f-9d55-2f7a3c1e8b10";
const PERSON = "7c3e1f2a-1b2c-4d5e-8f90-a1b2c3d4e5f6";
const SUB = "109876543210987654321";
const CODE = "4/FAKE-google-code";
const GOOGLE = { ok: true, sub: SUB, email: "gil@example.com", name: "Gil Hale" };
const FOUND = {
  customer: { id: CUSTOMER, code: "acme-co", name: "Acme", status: "active" },
  person: { id: PERSON, customerId: CUSTOMER, displayName: "Gil", ownerKey: "GH", passcodeHash: null, sessionNo: 7, status: "active" },
};
const signup = (status: string) => ({ id: "s1", sub: SUB, email: "gil@example.com", name: "Gil Hale", status, customerId: null, createdAt: "2026-11-25T10:00:00.000Z" });

type Opts = { state?: string | null; cookie?: string | null; code?: string | null; extra?: string; address?: string; otherCookies?: string };
/** A callback as Google sends the browser back: a state, a code, and the browser's nonce cookie. */
function callback(o: Opts = {}): Request {
  const nonce = newNonce();
  const state = o.state === undefined ? signState({ nonce }) : o.state;
  const cookie = o.cookie === undefined ? nonce : o.cookie;
  const code = o.code === undefined ? CODE : o.code;
  const q = new URLSearchParams();
  if (state !== null) q.set("state", state);
  if (code !== null) q.set("code", code);
  const cookies = [cookie !== null ? `monsoon_g=${cookie}` : "", o.otherCookies ?? ""].filter(Boolean).join("; ");
  return new Request(`http://internal-host.example/api/monsoon/google/callback?${q}${o.extra ?? ""}`, {
    headers: { ...(cookies ? { cookie: cookies } : {}), "x-real-ip": o.address ?? "203.0.113.7" },
  });
}

async function expectPage(res: Response, target: string): Promise<string> {
  expect(res.status).toBe(200);
  expect(res.headers.get("location")).toBeNull();
  expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  const html = await res.text();
  const escaped = target.replace(/&/g, "&amp;");
  expect(html).toContain(`<meta http-equiv="refresh" content="0;url=${escaped}">`);
  expect(html).toContain(`<a href="${escaped}">`);
  expect([...html.matchAll(/url=([^"]*)"/g)].map((m) => m[1])).toEqual([escaped]);
  expect([...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])).toEqual([escaped]);
  expect(html).not.toContain("<script");
  // The nonce is used up, whatever the answer.
  const cookies = res.headers.getSetCookie();
  const nonce = cookies.find((c) => c.startsWith("monsoon_g="));
  expect(nonce).toMatch(/^monsoon_g=;/);
  expect(nonce).toContain("Max-Age=0");
  expect(nonce).toContain("Path=/api/monsoon/google");
  return html;
}
const sessionCookie = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith("monsoon_session="));
const ERROR = "/monsoon/request?status=error";

beforeEach(() => {
  vi.stubEnv("MONSOON_SESSION_SECRET", "x".repeat(32));
  vi.stubEnv("MONSOON_MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("MONSOON_ACCOUNTS_DATABASE_URL", "postgresql://u:p@127.0.0.1:1/x");
  vi.stubEnv("MONSOON_GOOGLE_CLIENT_ID", "1234-fake.apps.googleusercontent.com");
  vi.stubEnv("MONSOON_GOOGLE_CLIENT_SECRET", "FAKE-client-secret-000000");
  vi.stubEnv("MONSOON_GOOGLE_REDIRECT_URI", "https://quantcloud.com/api/monsoon/google/callback");
  vi.stubEnv("MONSOON_SHARED_DB_ADMIN_URL", "postgresql://postgres.abcdefghijklmnopqrst:pw@aws-0-eu.pooler.supabase.com:5432/postgres");
  for (const f of [...Object.values(lib), ...Object.values(store), exchangeCode, startTrialClock]) f.mockReset();
  startTrialClock.mockResolvedValue(undefined);
  lib.beginGoogleAttempt.mockResolvedValue("41");
  lib.settleGoogleAttempt.mockResolvedValue(undefined);
  lib.findPersonByGoogleSub.mockResolvedValue(null);
  lib.findSignup.mockResolvedValue(null);
  lib.googleIdHeld.mockResolvedValue(false);
  lib.requestSignup.mockResolvedValue("created");
  lib.linkGoogle.mockResolvedValue("linked");
  store.recordActivity.mockResolvedValue(undefined);
  exchangeCode.mockResolvedValue(GOOGLE);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/monsoon/google/callback", () => {
  it("gives the route thirty seconds", () => {
    expect(maxDuration).toBe(30);
  });

  it("answers 503 when Google sign-in is not configured, before looking at anything", async () => {
    vi.stubEnv("MONSOON_GOOGLE_CLIENT_SECRET", "");
    const res = await GET(callback());
    expect(res.status).toBe(503);
    expect(sessionCookie(res)).toBeUndefined();
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(lib.beginGoogleAttempt).not.toHaveBeenCalled();
  });

  describe("the state and the browser's nonce", () => {
    const refused = async (o: Opts) => {
      const res = await GET(callback(o));
      await expectPage(res, ERROR);
      expect(sessionCookie(res)).toBeUndefined();
      expect(exchangeCode).not.toHaveBeenCalled();
      expect(lib.beginGoogleAttempt).not.toHaveBeenCalled();
      for (const f of [lib.findPersonByGoogleSub, lib.findSignup, lib.requestSignup, lib.linkGoogle]) expect(f).not.toHaveBeenCalled();
    };

    it("refuses a callback opened in another browser: a good state with no nonce cookie", async () => {
      await refused({ cookie: null });
    });

    it("refuses a callback whose nonce cookie belongs to another start", async () => {
      await refused({ cookie: newNonce() });
      const nonce = newNonce();
      await refused({ state: signState({ nonce }), cookie: nonce.slice(0, -1) });
      await refused({ cookie: "" });
    });

    it("refuses a missing, tampered or made-up state", async () => {
      const nonce = newNonce();
      const good = signState({ nonce });
      await refused({ state: null, cookie: nonce });
      await refused({ state: "", cookie: nonce });
      await refused({ state: good.slice(0, -1) + (good.endsWith("0") ? "1" : "0"), cookie: nonce });
      await refused({ state: `g1.${nonce}.9999999999.-.${"0".repeat(64)}`, cookie: nonce });
    });

    it("refuses a state older than ten minutes", async () => {
      const nonce = newNonce();
      await refused({ state: signState({ nonce }, Date.now() - 601_000), cookie: nonce });
    });

    it("refuses a session token offered as the state", async () => {
      const session = signSession({ customerId: CUSTOMER, personId: PERSON, sessionNo: 7 });
      await refused({ state: session, cookie: session });
      await refused({ state: session, cookie: newNonce() });
    });

    it("refuses a callback with no code (the person said no at Google), without calling Google", async () => {
      await refused({ code: null, extra: "&error=access_denied" });
      await refused({ code: "" });
    });
  });

  describe("after Google confirms who it is", () => {
    it("a known person gets the normal session, a sign_in record, and moves on to /monsoon", async () => {
      lib.findPersonByGoogleSub.mockResolvedValue(FOUND);
      const res = await GET(callback());
      await expectPage(res, "/monsoon");
      expect(exchangeCode).toHaveBeenCalledWith(CODE);
      expect(lib.findPersonByGoogleSub).toHaveBeenCalledWith(SUB);
      const cookie = sessionCookie(res) ?? "";
      for (const part of ["HttpOnly", "Secure", "SameSite=strict", "Max-Age=15552000", "Path=/"]) {
        expect(cookie.toLowerCase()).toContain(part.toLowerCase());
      }
      const token = /monsoon_session=([^;]+)/.exec(cookie)?.[1];
      expect(verifySession(token)).toEqual({ customerId: CUSTOMER, personId: PERSON, sessionNo: 7 });
      expect(store.recordActivity).toHaveBeenCalledWith({ customerId: CUSTOMER, personId: PERSON, pipelineKey: null, action: "sign_in" });
      expect(store.evictAccount).toHaveBeenCalledWith(CUSTOMER, PERSON);
      // The free trial's clock starts at this sign-in (the library starts it once only).
      expect(startTrialClock.mock.calls).toEqual([[CUSTOMER]]);
      expect(lib.settleGoogleAttempt).toHaveBeenCalledWith("41");
      expect(lib.findSignup).not.toHaveBeenCalled();
      expect(lib.requestSignup).not.toHaveBeenCalled();
      expect(lib.linkGoogle).not.toHaveBeenCalled();
    });

    it("a suspended person, or a person of a suspended customer, is told it was not approved: no session, no request", async () => {
      // Not found as an active person, yet the Google id is on a person.
      lib.googleIdHeld.mockResolvedValue(true);
      for (const found of [null, { ...signup("approved"), customerId: CUSTOMER }]) {
        lib.findSignup.mockResolvedValue(found);
        const res = await GET(callback());
        await expectPage(res, "/monsoon/request?status=declined");
        expect(sessionCookie(res)).toBeUndefined();
      }
      expect(lib.googleIdHeld).toHaveBeenCalledWith(SUB);
      expect(lib.requestSignup).not.toHaveBeenCalled();
      expect(store.recordActivity).not.toHaveBeenCalled();
    });

    it("without the shared database setting a known person still signs in and links still work", async () => {
      vi.stubEnv("MONSOON_SHARED_DB_ADMIN_URL", "");
      lib.findPersonByGoogleSub.mockResolvedValue(FOUND);
      const res = await GET(callback());
      await expectPage(res, "/monsoon");
      expect(sessionCookie(res)).toBeDefined();
      const nonce = newNonce();
      const linked = await GET(callback({ state: signState({ nonce, link: { customerId: CUSTOMER, personId: PERSON, sessionNo: 7 } }), cookie: nonce }));
      await expectPage(linked, "/monsoon");
      expect(lib.linkGoogle).toHaveBeenCalledTimes(1);
    });

    it("without the shared database setting someone new sees that sign-ups are paused, and nothing is created", async () => {
      vi.stubEnv("MONSOON_SHARED_DB_ADMIN_URL", "");
      const res = await GET(callback());
      await expectPage(res, "/monsoon/request?status=paused");
      expect(sessionCookie(res)).toBeUndefined();
      expect(lib.requestSignup).not.toHaveBeenCalled();
      // Someone already waiting or declined is still told so.
      lib.findSignup.mockResolvedValue(signup("pending"));
      await expectPage(await GET(callback()), "/monsoon/request?status=waiting");
      expect(startTrialClock).not.toHaveBeenCalled();
    });

    it("a pending request waits: no session", async () => {
      lib.findSignup.mockResolvedValue(signup("pending"));
      const res = await GET(callback());
      await expectPage(res, "/monsoon/request?status=waiting");
      expect(sessionCookie(res)).toBeUndefined();
      expect(lib.requestSignup).not.toHaveBeenCalled();
      expect(store.recordActivity).not.toHaveBeenCalled();
    });

    it("a declined request stays declined: no session, and it cannot ask again", async () => {
      lib.findSignup.mockResolvedValue(signup("declined"));
      const res = await GET(callback());
      await expectPage(res, "/monsoon/request?status=declined");
      expect(sessionCookie(res)).toBeUndefined();
      expect(lib.requestSignup).not.toHaveBeenCalled();
    });

    it("an approved request whose person is missing is an error: no session", async () => {
      lib.findSignup.mockResolvedValue({ ...signup("approved"), customerId: CUSTOMER });
      const res = await GET(callback());
      await expectPage(res, ERROR);
      expect(sessionCookie(res)).toBeUndefined();
      expect(lib.requestSignup).not.toHaveBeenCalled();
    });

    it("someone new becomes a pending request, with the hashed network address: no session", async () => {
      const res = await GET(callback({ address: "198.51.100.23" }));
      await expectPage(res, "/monsoon/request?status=received");
      expect(sessionCookie(res)).toBeUndefined();
      expect(lib.requestSignup).toHaveBeenCalledWith({
        sub: SUB,
        email: "gil@example.com",
        name: "Gil Hale",
        addressHash: hashAddress("198.51.100.23"),
      });
      expect(store.recordActivity).not.toHaveBeenCalled();
    });

    it("says paused at the cap, and error for too many from one address: no session either way", async () => {
      lib.requestSignup.mockResolvedValue("paused");
      let res = await GET(callback());
      await expectPage(res, "/monsoon/request?status=paused");
      expect(sessionCookie(res)).toBeUndefined();
      lib.requestSignup.mockResolvedValue("too_many");
      res = await GET(callback());
      await expectPage(res, ERROR);
      expect(sessionCookie(res)).toBeUndefined();
    });

    it("an email that matches somebody is never used: only the Google id is looked up", async () => {
      await GET(callback());
      expect(lib.findPersonByGoogleSub.mock.calls).toEqual([[SUB]]);
      expect(lib.findSignup.mock.calls).toEqual([[SUB]]);
    });

    it("a refused exchange is an error: no lookup, no session, the attempt stays a failure", async () => {
      exchangeCode.mockResolvedValue({ ok: false });
      const res = await GET(callback());
      await expectPage(res, ERROR);
      expect(sessionCookie(res)).toBeUndefined();
      expect(lib.findPersonByGoogleSub).not.toHaveBeenCalled();
      expect(lib.requestSignup).not.toHaveBeenCalled();
      expect(lib.settleGoogleAttempt).not.toHaveBeenCalled();
    });

    it("too many failed tries from one address: Google is not called", async () => {
      lib.beginGoogleAttempt.mockResolvedValue(null);
      const res = await GET(callback({ address: "198.51.100.23" }));
      await expectPage(res, ERROR);
      expect(lib.beginGoogleAttempt).toHaveBeenCalledWith(hashAddress("198.51.100.23"));
      expect(exchangeCode).not.toHaveBeenCalled();
      expect(sessionCookie(res)).toBeUndefined();
    });

    it("targets are fixed: nothing in the request can change where the page goes", async () => {
      lib.findPersonByGoogleSub.mockResolvedValue(FOUND);
      const res = await GET(callback({ extra: "&next=https://evil.example&redirect=//evil.example&status=received&url=javascript:alert(1)" }));
      const html = await expectPage(res, "/monsoon");
      expect(html).not.toContain("evil");
      expect(html).not.toContain("javascript");
      expect(html).not.toContain("internal-host");
    });

    it("a database failure is an error page with no session, and logs neither the code nor who it was", async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      lib.findPersonByGoogleSub.mockRejectedValue(new Error(`connect failed postgresql://u:secret@host/db ${CODE}`));
      const res = await GET(callback());
      await expectPage(res, ERROR);
      expect(sessionCookie(res)).toBeUndefined();
      const logged = log.mock.calls.flat().join(" ");
      expect(logged).toContain("monsoon");
      for (const secret of [CODE, SUB, "gil@example.com", "Gil Hale", "secret@host"]) expect(logged).not.toContain(secret);
    });

    it("a failure of the attempt counter is an error page: Google is not called", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      lib.beginGoogleAttempt.mockRejectedValue(new Error("down"));
      const res = await GET(callback());
      await expectPage(res, ERROR);
      expect(exchangeCode).not.toHaveBeenCalled();
    });

    it("logs nothing on the ordinary paths", async () => {
      const spies = (["log", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
      await GET(callback());
      lib.findPersonByGoogleSub.mockResolvedValue(FOUND);
      await GET(callback());
      exchangeCode.mockResolvedValue({ ok: false });
      await GET(callback());
      await GET(callback({ cookie: null }));
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    });
  });

  describe("linking (started from Your page)", () => {
    const linkState = () => {
      const nonce = newNonce();
      return { nonce, state: signState({ nonce, link: { customerId: CUSTOMER, personId: PERSON, sessionNo: 7 } }) };
    };

    it("links the Google id to the person in the state, then /monsoon: no new session, no sign-in lookup", async () => {
      const { nonce, state } = linkState();
      const res = await GET(callback({ state, cookie: nonce }));
      await expectPage(res, "/monsoon");
      expect(lib.linkGoogle).toHaveBeenCalledWith({ customerId: CUSTOMER, personId: PERSON, sessionNo: 7 }, SUB);
      expect(sessionCookie(res)).toBeUndefined();
      expect(lib.findPersonByGoogleSub).not.toHaveBeenCalled();
      expect(lib.findSignup).not.toHaveBeenCalled();
      expect(lib.requestSignup).not.toHaveBeenCalled();
    });

    it("is checked before the other cases: a Google id that could sign in is still only linked", async () => {
      lib.findPersonByGoogleSub.mockResolvedValue(FOUND);
      lib.linkGoogle.mockResolvedValue("taken");
      const { nonce, state } = linkState();
      const res = await GET(callback({ state, cookie: nonce }));
      await expectPage(res, "/monsoon/request?status=taken");
      expect(sessionCookie(res)).toBeUndefined();
      expect(lib.findPersonByGoogleSub).not.toHaveBeenCalled();
    });

    it("a link started before the seat was reset is treated like an expired one: the error page, not taken", async () => {
      lib.linkGoogle.mockResolvedValue("expired");
      const { nonce, state } = linkState();
      const res = await GET(callback({ state, cookie: nonce }));
      await expectPage(res, ERROR);
      expect(sessionCookie(res)).toBeUndefined();
    });

    it("a link state replayed in another browser does nothing", async () => {
      const { state } = linkState();
      for (const cookie of [null, newNonce()]) {
        const res = await GET(callback({ state, cookie }));
        await expectPage(res, ERROR);
      }
      expect(lib.linkGoogle).not.toHaveBeenCalled();
      expect(exchangeCode).not.toHaveBeenCalled();
    });

    it("a refused exchange links nothing", async () => {
      exchangeCode.mockResolvedValue({ ok: false });
      const { nonce, state } = linkState();
      await expectPage(await GET(callback({ state, cookie: nonce })), ERROR);
      expect(lib.linkGoogle).not.toHaveBeenCalled();
    });
  });
});
