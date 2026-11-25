import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/monsoon/accounts/account", async () =>
  (await import("@/lib/monsoon/testing/account")).mockRequireAccount(),
);
import { requireAccount } from "@/lib/monsoon/accounts/account";
import { fakeAccount, signInAs, signOut } from "@/lib/monsoon/testing/account";
import { verifySession } from "@/lib/monsoon/auth";
import { verifyState } from "@/lib/monsoon/google";
import { GET } from "./route";

const CLIENT_ID = "1234-fake.apps.googleusercontent.com";
const CLIENT_SECRET = "FAKE-client-secret-000000";
const REDIRECT = "https://quantcloud.com/api/monsoon/google/callback";
const WHO = { customerId: "00000000-0000-4000-8000-000000000001", personId: "00000000-0000-4000-8000-000000000002" };

const get = (query = "") => new Request(`http://internal-host.example/api/monsoon/google/start${query}`);

function parts(res: Response) {
  const cookie = res.headers.get("set-cookie") ?? "";
  const location = res.headers.get("location") ?? "";
  const nonce = /monsoon_g=([^;]+)/.exec(cookie)?.[1];
  const state = location ? (new URL(location).searchParams.get("state") ?? undefined) : undefined;
  return { cookie, location, nonce, state };
}

beforeEach(() => {
  vi.stubEnv("MONSOON_SESSION_SECRET", "x".repeat(32));
  vi.stubEnv("MONSOON_MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("MONSOON_ACCOUNTS_DATABASE_URL", "postgresql://u:p@127.0.0.1:1/x");
  vi.stubEnv("MONSOON_GOOGLE_CLIENT_ID", CLIENT_ID);
  vi.stubEnv("MONSOON_GOOGLE_CLIENT_SECRET", CLIENT_SECRET);
  vi.stubEnv("MONSOON_GOOGLE_REDIRECT_URI", REDIRECT);
  vi.stubEnv("MONSOON_SHARED_DB_ADMIN_URL", "postgresql://postgres.abcdefghijklmnopqrst:pw@aws-0-eu.pooler.supabase.com:5432/postgres");
  vi.mocked(requireAccount).mockClear();
  signOut();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/monsoon/google/start", () => {
  it("answers 503 and sets nothing when Google sign-in is not configured", async () => {
    for (const name of ["MONSOON_GOOGLE_CLIENT_ID", "MONSOON_GOOGLE_CLIENT_SECRET", "MONSOON_GOOGLE_REDIRECT_URI"]) {
      const before = process.env[name] as string;
      vi.stubEnv(name, "");
      for (const q of ["", "?link=1"]) {
        const res = await GET(get(q));
        expect(res.status, name).toBe(503);
        expect(res.headers.get("set-cookie")).toBeNull();
        expect(res.headers.get("location")).toBeNull();
      }
      vi.stubEnv(name, before);
    }
    expect(requireAccount).not.toHaveBeenCalled();
  });

  it("works without the shared database setting: signing in and linking do not need it", async () => {
    vi.stubEnv("MONSOON_SHARED_DB_ADMIN_URL", "");
    expect((await GET(get())).status).toBe(302);
    signInAs(fakeAccount());
    expect((await GET(get("?link=1"))).status).toBe(302);
  });

  it("sets a ten-minute nonce cookie and redirects to Google with a state carrying that nonce", async () => {
    const res = await GET(get());
    expect(res.status).toBe(302);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { cookie, location, nonce, state } = parts(res);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const part of ["HttpOnly", "Secure", "SameSite=lax", "Max-Age=600", "Path=/api/monsoon/google"]) {
      expect(cookie.toLowerCase()).toContain(part.toLowerCase());
    }
    expect(cookie).not.toContain("monsoon_session");
    const url = new URL(location);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    // The fixed address from configuration, never the host the request arrived on.
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(location).not.toContain("internal-host");
    expect(location).not.toContain(CLIENT_SECRET);
    expect(verifyState(state)).toEqual({ nonce });
    // The state is not a session.
    expect(verifySession(state)).toBeNull();
    expect(requireAccount).not.toHaveBeenCalled();
  });

  it("makes a fresh nonce each time", async () => {
    const a = parts(await GET(get()));
    const b = parts(await GET(get()));
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.state).not.toBe(b.state);
  });

  it("takes nothing from the request into the address: a redirect or state in the query is ignored", async () => {
    const res = await GET(get("?redirect_uri=https://evil.example/cb&state=mine&next=https://evil.example&client_id=evil"));
    const { location, nonce, state } = parts(res);
    expect(location).not.toContain("evil");
    expect(verifyState(state)).toEqual({ nonce });
  });

  it("link=1 without a session is refused: no cookie, no redirect", async () => {
    const res = await GET(get("?link=1"));
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("location")).toBeNull();
  });

  it("link=1 with a session puts that person, and nobody the request names, in the state", async () => {
    signInAs(fakeAccount());
    const res = await GET(get("?link=1&personId=11111111-1111-4111-8111-111111111111&customerId=22222222-2222-4222-8222-222222222222"));
    expect(res.status).toBe(302);
    const { nonce, state } = parts(res);
    expect(verifyState(state)).toEqual({ nonce, link: WHO });
  });

  it("only link=1 exactly asks for a link", async () => {
    signInAs(fakeAccount());
    for (const q of ["?link=0", "?link=true", "?link=", "?LINK=1"]) {
      const { nonce, state } = parts(await GET(get(q)));
      expect(verifyState(state), q).toEqual({ nonce });
    }
  });
});
