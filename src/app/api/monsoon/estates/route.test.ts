import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signSession } from "@/lib/monsoon/auth";

const withEstateDb = vi.fn();
vi.mock("@/lib/monsoon/db", () => ({
  withEstateDb: (...args: unknown[]) => withEstateDb(...args),
}));

import { GET } from "./route";

function request(authenticated: boolean): Request {
  return new Request("http://localhost/api/monsoon/estates", {
    headers: authenticated
      ? { Cookie: `monsoon_session=${signSession()}` }
      : {},
  });
}

const ROLES: Record<string, { key: string; label: string }[]> = {
  traxo: [{ key: "lp_prospect", label: "LP prospect" }],
  zeroone: [{ key: "investor", label: "Investor" }],
};

beforeEach(() => {
  withEstateDb.mockReset();
  vi.stubEnv("MONSOON_PASSCODE", "correct-horse-battery-staple");
  vi.stubEnv("MONSOON_SESSION_SECRET", "x".repeat(32));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/monsoon/estates", () => {
  it("returns 401 without a session and touches no database", async () => {
    const res = await GET(request(false));
    expect(res.status).toBe(401);
    expect(withEstateDb).not.toHaveBeenCalled();
  });

  it("lists both estates in order with their roles", async () => {
    withEstateDb.mockImplementation(async (estate, fn) =>
      fn({ query: async () => ({ rows: ROLES[estate.key] }) })
    );
    const res = await GET(request(true));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.estates.map((e: { key: string }) => e.key)).toEqual([
      "traxo",
      "zeroone",
    ]);
    expect(body.estates[0]).toEqual({
      key: "traxo",
      label: "Traxo",
      defaultRole: "lp_prospect",
      available: true,
      roles: ROLES.traxo,
    });
    expect(body.estates[1].defaultRole).toBe("investor");
    expect(body.estates[1].roles).toEqual(ROLES.zeroone);
  });

  it("one estate down does not hide the other", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    withEstateDb.mockImplementation(async (estate, fn) => {
      if (estate.key === "traxo") throw new Error("connect ECONNREFUSED");
      return fn({ query: async () => ({ rows: ROLES.zeroone }) });
    });
    const res = await GET(request(true));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.estates[0].available).toBe(false);
    expect(body.estates[0].roles).toEqual([]);
    expect(body.estates[1].available).toBe(true);
    expect(body.estates[1].roles).toEqual(ROLES.zeroone);
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe("route config", () => {
  it("caps the function at 30 seconds", async () => {
    const mod = await import("./route");
    expect(mod.maxDuration).toBe(30);
  });
});
