import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signSession } from "@/lib/monsoon/auth";

const withEstateDb = vi.fn();
const searchContacts = vi.fn();
const recentContacts = vi.fn();
vi.mock("@/lib/monsoon/db", () => ({ withEstateDb: (...a: unknown[]) => withEstateDb(...a) }));
vi.mock("@/lib/monsoon/contacts", () => ({
  searchContacts: (...a: unknown[]) => searchContacts(...a),
  recentContacts: (...a: unknown[]) => recentContacts(...a),
}));

import { GET } from "./route";

const fakeDb = { fake: true };
const HITS = [{ kind: "person", name: "Mia Chen" }];

function get(query: string, authenticated = true): Request {
  return new Request(`http://localhost/api/monsoon/contacts${query}`, {
    headers: authenticated ? { Cookie: `monsoon_session=${signSession()}` } : {},
  });
}

beforeEach(() => {
  withEstateDb.mockReset().mockImplementation(async (_e, fn) => fn(fakeDb));
  searchContacts.mockReset().mockResolvedValue(HITS);
  recentContacts.mockReset().mockResolvedValue(HITS);
  vi.stubEnv("MONSOON_PASSCODE", "correct-horse-battery-staple");
  vi.stubEnv("MONSOON_SESSION_SECRET", "x".repeat(32));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/monsoon/contacts", () => {
  it("answers 401 without a session and calls nothing", async () => {
    const res = await GET(get("?estate=traxo&q=mia", false));
    expect(res.status).toBe(401);
    expect(withEstateDb).not.toHaveBeenCalled();
    expect(searchContacts).not.toHaveBeenCalled();
    expect(recentContacts).not.toHaveBeenCalled();
  });

  it("answers 400 for an unknown or missing estate", async () => {
    for (const q of ["?estate=qforce&q=mia", "?q=mia"]) {
      const res = await GET(get(q));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Unknown estate" });
    }
    expect(withEstateDb).not.toHaveBeenCalled();
  });

  it("searches when q has two or more characters after trimming", async () => {
    const res = await GET(get("?estate=traxo&q=%20%20mia%20"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ contacts: HITS });
    expect(searchContacts).toHaveBeenCalledTimes(1);
    expect(searchContacts.mock.calls[0][0]).toBe(fakeDb);
    expect(searchContacts.mock.calls[0][1]).toBe("mia");
    expect(recentContacts).not.toHaveBeenCalled();
    expect(withEstateDb.mock.calls[0][0]).toMatchObject({ key: "traxo" });
  });

  it("lists recent contacts when q is absent, empty or a single character", async () => {
    for (const q of ["?estate=zeroone", "?estate=zeroone&q=", "?estate=zeroone&q=%20m%20"]) {
      const res = await GET(get(q));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ contacts: HITS });
    }
    expect(recentContacts).toHaveBeenCalledTimes(3);
    expect(searchContacts).not.toHaveBeenCalled();
  });

  it("answers 502 without leaking details when the lookup throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    searchContacts.mockRejectedValue(
      Object.assign(new Error("boom postgresql://user:hunter2@db.internal.example/x Mia Chen"), { code: "57014" }),
    );
    const res = await GET(get("?estate=traxo&q=mia"));
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "Could not reach the Traxo CRM" });
    expect(text).not.toContain("hunter2");
    expect(log).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(log.mock.calls);
    for (const leak of ["hunter2", "boom", "Mia Chen", "mia"]) expect(logged).not.toContain(leak);
    expect(logged).toContain("57014");
  });
});
