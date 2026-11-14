import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signSession } from "@/lib/monsoon/auth";

const withEstateDb = vi.fn();
const getProfile = vi.fn();
vi.mock("@/lib/monsoon/db", () => ({ withEstateDb: (...a: unknown[]) => withEstateDb(...a) }));
vi.mock("@/lib/monsoon/contacts", () => ({ getProfile: (...a: unknown[]) => getProfile(...a) }));

import { GET } from "./route";

const fakeDb = { fake: true };
const ID = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const PROFILE = { kind: "person", name: "Mia Chen" };

function get(query: string, authenticated = true): Request {
  return new Request(`http://localhost/api/monsoon/contact${query}`, {
    headers: authenticated ? { Cookie: `monsoon_session=${signSession()}` } : {},
  });
}

beforeEach(() => {
  withEstateDb.mockReset().mockImplementation(async (_e, fn) => fn(fakeDb));
  getProfile.mockReset().mockResolvedValue(PROFILE);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-13T10:00:00Z"));
  vi.stubEnv("MONSOON_PASSCODE", "correct-horse-battery-staple");
  vi.stubEnv("MONSOON_SESSION_SECRET", "x".repeat(32));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/monsoon/contact", () => {
  it("answers 401 without a session and calls nothing", async () => {
    const res = await GET(get(`?estate=traxo&memberId=${ID}`, false));
    expect(res.status).toBe(401);
    expect(withEstateDb).not.toHaveBeenCalled();
    expect(getProfile).not.toHaveBeenCalled();
  });

  it("answers 400 for an unknown estate", async () => {
    const res = await GET(get(`?estate=qforce&memberId=${ID}`));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unknown estate" });
    expect(withEstateDb).not.toHaveBeenCalled();
  });

  it("answers 400 when no id or more than one id is given", async () => {
    const queries = [
      "?estate=traxo",
      "?estate=traxo&memberId=",
      `?estate=traxo&memberId=${ID}&personId=${ID2}`,
      `?estate=traxo&personId=${ID}&orgId=${ID2}`,
    ];
    for (const q of queries) {
      const res = await GET(get(q));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBeTruthy();
    }
    expect(withEstateDb).not.toHaveBeenCalled();
  });

  it("returns the profile for each kind of id", async () => {
    for (const key of ["memberId", "personId", "orgId"] as const) {
      getProfile.mockClear();
      const res = await GET(get(`?estate=zeroone&today=2026-11-13&${key}=${ID}`));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ profile: PROFILE });
      expect(getProfile).toHaveBeenCalledTimes(1);
      expect(getProfile.mock.calls[0][0]).toBe(fakeDb);
      expect(getProfile.mock.calls[0][1]).toEqual({ [key]: ID });
      expect(getProfile.mock.calls[0][2]).toBe("2026-11-13");
    }
  });

  it("validates today like Ask: within a day of the server UTC date, else the server date", async () => {
    const cases: [string | undefined, string][] = [
      ["2026-11-14", "2026-11-14"],
      ["2026-11-12", "2026-11-12"],
      ["2026-11-20", "2026-11-13"],
      ["2026-02-31", "2026-11-13"],
      ["nonsense", "2026-11-13"],
      [undefined, "2026-11-13"],
    ];
    for (const [today, expected] of cases) {
      getProfile.mockClear();
      await GET(get(`?estate=traxo&memberId=${ID}${today === undefined ? "" : `&today=${today}`}`));
      expect(getProfile.mock.calls[0][2]).toBe(expected);
    }
  });

  it("answers 404 when the profile is not found", async () => {
    getProfile.mockResolvedValue(null);
    const res = await GET(get(`?estate=traxo&memberId=${ID}`));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("answers 404 for a malformed id (the lookup returns null)", async () => {
    getProfile.mockResolvedValue(null);
    const res = await GET(get("?estate=traxo&personId=not-a-uuid"));
    expect(res.status).toBe(404);
  });

  it("answers 502 without leaking details when the lookup throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    getProfile.mockRejectedValue(Object.assign(new Error("boom postgresql://user:hunter2@db/x Mia Chen"), { code: "08006" }));
    const res = await GET(get(`?estate=zeroone&memberId=${ID}`));
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "Could not reach the Zero One CRM" });
    expect(text).not.toContain("hunter2");
    expect(log).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(log.mock.calls);
    for (const leak of ["hunter2", "boom", "Mia Chen", ID]) expect(logged).not.toContain(leak);
    expect(logged).toContain("08006");
  });
});
