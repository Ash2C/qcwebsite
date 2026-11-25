import { afterEach, describe, expect, it, vi } from "vitest";

const google = { googleConfigured: vi.fn(), signupsConfigured: vi.fn() };
vi.mock("@/lib/monsoon/google", () => ({
  googleConfigured: () => google.googleConfigured(),
  signupsConfigured: () => google.signupsConfigured(),
}));
import { GET } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("GET /api/monsoon/version", () => {
  it("says the build and that Sign in with Google is off, uncached, and nothing else", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc123");
    google.googleConfigured.mockReturnValue(false);
    google.signupsConfigured.mockReturnValue(false);
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ build: "abc123", google: false, signups: false });
  });

  it("says when Sign in with Google is on, and separately when new sign-ups can be taken", async () => {
    google.googleConfigured.mockReturnValue(true);
    google.signupsConfigured.mockReturnValue(false);
    expect(await GET().json()).toMatchObject({ google: true, signups: false });
    google.signupsConfigured.mockReturnValue(true);
    expect(await GET().json()).toMatchObject({ google: true, signups: true });
  });

  it("answers only true or false, whatever the settings hold", async () => {
    vi.stubEnv("MONSOON_GOOGLE_CLIENT_SECRET", "s3cret-value");
    google.googleConfigured.mockReturnValue(true);
    google.signupsConfigured.mockReturnValue(true);
    const text = await GET().text();
    expect(text).not.toContain("s3cret-value");
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(["build", "google", "signups"]);
  });
});
