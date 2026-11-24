import { beforeEach, describe, expect, it, vi } from "vitest";

const lib = {
  loadGranolaKeyState: vi.fn(),
  loadGranolaKey: vi.fn(),
  saveGranolaKey: vi.fn(),
  recordGranolaStatus: vi.fn(),
  disconnectGranolaKey: vi.fn(),
};
vi.mock("@/lib/monsoon/accounts/granola-key", () => ({
  loadGranolaKeyState: (...a: unknown[]) => lib.loadGranolaKeyState(...a),
  loadGranolaKey: (...a: unknown[]) => lib.loadGranolaKey(...a),
  saveGranolaKey: (...a: unknown[]) => lib.saveGranolaKey(...a),
  recordGranolaStatus: (...a: unknown[]) => lib.recordGranolaStatus(...a),
  disconnectGranolaKey: (...a: unknown[]) => lib.disconnectGranolaKey(...a),
}));
const testGranolaKey = vi.fn();
vi.mock("@/lib/monsoon/granola/client", async (original) => ({
  ...(await original<typeof import("@/lib/monsoon/granola/client")>()),
  testGranolaKey: (...a: unknown[]) => testGranolaKey(...a),
}));
vi.mock("@/lib/monsoon/accounts/account", async () =>
  (await import("@/lib/monsoon/testing/account")).mockRequireAccount(),
);
import { fakeAccount, signInAs, signOut } from "@/lib/monsoon/testing/account";
import { GET, POST, maxDuration } from "./route";

// Obviously fake: the shape of a key, never a real one.
const KEY = "grn_FAKE_test_key_0000000000";
const STATE = { status: "ok", last4: "0000", setAt: "2026-11-24T10:00:00.000Z", checkedAt: "2026-11-24T10:00:00.000Z" };
const MISSING = { status: "missing", last4: null, setAt: null, checkedAt: null };
const WHO = { customerId: "00000000-0000-4000-8000-000000000001", personId: "00000000-0000-4000-8000-000000000002" };

const get = () => new Request("http://localhost/api/monsoon/granola-key");
const post = (body: unknown) =>
  new Request("http://localhost/api/monsoon/granola-key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => {
  vi.restoreAllMocks();
  for (const f of Object.values(lib)) f.mockReset();
  testGranolaKey.mockReset();
  lib.loadGranolaKeyState.mockResolvedValue(STATE);
  signInAs(fakeAccount());
});

describe("GET /api/monsoon/granola-key", () => {
  it("gives the route thirty seconds", () => {
    expect(maxDuration).toBe(30);
  });

  it("answers 401 when signed out", async () => {
    signOut();
    expect((await GET(get())).status).toBe(401);
    expect(lib.loadGranolaKeyState).not.toHaveBeenCalled();
  });

  it("returns the signed-in person's key state, uncached", async () => {
    const res = await GET(get());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ key: STATE });
    expect(lib.loadGranolaKeyState).toHaveBeenCalledWith(WHO);
  });

  it("answers 502 without the message when the lookup fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    lib.loadGranolaKeyState.mockRejectedValue(new Error("postgres://u:pw@h"));
    const res = await GET(get());
    expect(res.status).toBe(502);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("pw@h");
  });
});

describe("POST /api/monsoon/granola-key: a new key", () => {
  it("answers 401 when signed out, before reading anything", async () => {
    signOut();
    expect((await POST(post({ granolaKey: KEY }))).status).toBe(401);
    expect(testGranolaKey).not.toHaveBeenCalled();
  });

  it("answers 400 to a body that is not JSON, not an object, names no action or names two", async () => {
    for (const body of ["{not json", "[]", '"text"', "{}", { other: 1 }, { test: false }, { granolaKey: KEY, disconnect: true }, { test: true, disconnect: true }]) {
      const res = await POST(post(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(testGranolaKey).not.toHaveBeenCalled();
    expect(lib.saveGranolaKey).not.toHaveBeenCalled();
    expect(lib.disconnectGranolaKey).not.toHaveBeenCalled();
  });

  it("refuses text that is not shaped like a key, without calling Granola", async () => {
    for (const granolaKey of ["", "hello", "grn_short", 42, null, "sk-ant-api03-EXAMPLE-0123456789", "grn_" + "a".repeat(400), "grn_has space_0000000000"]) {
      const res = await POST(post({ granolaKey }));
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: "granola_key_rejected" });
    }
    expect(testGranolaKey).not.toHaveBeenCalled();
    expect(lib.saveGranolaKey).not.toHaveBeenCalled();
  });

  it("tests the key, stores it for the session's person and returns the new state", async () => {
    testGranolaKey.mockResolvedValue({ ok: true });
    lib.saveGranolaKey.mockResolvedValue(true);
    // A person id in the body is ignored: the person always comes from the session.
    const res = await POST(post({ granolaKey: `  ${KEY}\n`, personId: "someone-else", customerId: "another" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ key: STATE });
    expect(testGranolaKey).toHaveBeenCalledWith(KEY);
    expect(lib.saveGranolaKey).toHaveBeenCalledWith(WHO, KEY);
    expect(lib.loadGranolaKeyState).toHaveBeenCalledWith(WHO);
  });

  it("keeps what is on file when Granola refuses the new key", async () => {
    for (const [failure, error] of [
      ["key_rejected", "granola_key_rejected"],
      ["no_access", "granola_no_access"],
    ]) {
      testGranolaKey.mockResolvedValue({ ok: false, failure });
      const res = await POST(post({ granolaKey: KEY }));
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error });
    }
    expect(lib.saveGranolaKey).not.toHaveBeenCalled();
    expect(lib.recordGranolaStatus).not.toHaveBeenCalled();
  });

  it("answers 503 and stores nothing when Granola cannot say", async () => {
    for (const failure of ["busy", "not_found"]) {
      testGranolaKey.mockResolvedValue({ ok: false, failure });
      const res = await POST(post({ granolaKey: KEY }));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "granola_busy" });
    }
    expect(lib.saveGranolaKey).not.toHaveBeenCalled();
  });

  it("answers 401 when the person is no longer there to store it on", async () => {
    testGranolaKey.mockResolvedValue({ ok: true });
    lib.saveGranolaKey.mockResolvedValue(false);
    expect((await POST(post({ granolaKey: KEY }))).status).toBe(401);
  });

  it("never logs or returns the key when storing fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    testGranolaKey.mockResolvedValue({ ok: true });
    lib.saveGranolaKey.mockRejectedValue(new Error(`boom ${KEY}`));
    const res = await POST(post({ granolaKey: KEY }));
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain(KEY);
    expect(JSON.stringify(spy.mock.calls)).not.toContain(KEY);
  });
});

describe("POST /api/monsoon/granola-key: test the key on file", () => {
  it("records what Granola says and returns the state", async () => {
    lib.loadGranolaKey.mockResolvedValue(KEY);
    for (const [result, recorded] of [
      [{ ok: true }, "ok"],
      [{ ok: false, failure: "key_rejected" }, "key_rejected"],
      [{ ok: false, failure: "no_access" }, "no_access"],
    ] as const) {
      testGranolaKey.mockResolvedValue(result);
      const res = await POST(post({ test: true }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ key: STATE });
      expect(lib.recordGranolaStatus).toHaveBeenLastCalledWith(WHO, recorded);
    }
    expect(lib.loadGranolaKey).toHaveBeenCalledWith(WHO);
    expect(testGranolaKey).toHaveBeenCalledWith(KEY);
  });

  it("changes nothing when Granola is busy or there is no key", async () => {
    lib.loadGranolaKey.mockResolvedValue(KEY);
    testGranolaKey.mockResolvedValue({ ok: false, failure: "busy" });
    const busy = await POST(post({ test: true }));
    expect(busy.status).toBe(503);
    expect(await busy.json()).toEqual({ error: "granola_busy" });

    lib.loadGranolaKey.mockResolvedValue(null);
    testGranolaKey.mockClear();
    const res = await POST(post({ test: true }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "granola_key_missing" });
    expect(testGranolaKey).not.toHaveBeenCalled();
    expect(lib.recordGranolaStatus).not.toHaveBeenCalled();
  });

  it("answers 502 when the key cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    lib.loadGranolaKey.mockRejectedValue(new Error("Could not decrypt"));
    expect((await POST(post({ test: true }))).status).toBe(502);
  });
});

describe("POST /api/monsoon/granola-key: disconnect", () => {
  it("empties the key of the session's person and returns the state", async () => {
    lib.disconnectGranolaKey.mockResolvedValue(true);
    lib.loadGranolaKeyState.mockResolvedValue(MISSING);
    const res = await POST(post({ disconnect: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: MISSING });
    expect(lib.disconnectGranolaKey).toHaveBeenCalledWith(WHO);
    expect(testGranolaKey).not.toHaveBeenCalled();
  });

  it("answers 502 when the accounts database fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    lib.disconnectGranolaKey.mockRejectedValue(new Error("postgres://u:pw@h"));
    expect((await POST(post({ disconnect: true }))).status).toBe(502);
  });
});
