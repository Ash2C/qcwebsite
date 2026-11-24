import { beforeEach, describe, expect, it, vi } from "vitest";

const lib = {
  loadClaudeKeyState: vi.fn(),
  replaceClaudeKey: vi.fn(),
  testClaudeKey: vi.fn(),
  testStoredKey: vi.fn(),
};
vi.mock("@/lib/monsoon/accounts/claude-key", () => ({
  loadClaudeKeyState: (...a: unknown[]) => lib.loadClaudeKeyState(...a),
  replaceClaudeKey: (...a: unknown[]) => lib.replaceClaudeKey(...a),
  testClaudeKey: (...a: unknown[]) => lib.testClaudeKey(...a),
  testStoredKey: (...a: unknown[]) => lib.testStoredKey(...a),
}));
const recordClaudeStatus = vi.fn();
vi.mock("@/lib/monsoon/accounts/store", () => ({
  recordClaudeStatus: (...a: unknown[]) => recordClaudeStatus(...a),
}));
vi.mock("@/lib/monsoon/accounts/account", async () =>
  (await import("@/lib/monsoon/testing/account")).mockRequireAccount(),
);
import { fakeAccount, signInAs, signOut } from "@/lib/monsoon/testing/account";
import { GET, POST } from "./route";

const KEY = "sk-ant-api03-EXAMPLEKEYVALUE-0123456789";
const STATE = { status: "ok", last4: "6789", checkedAt: null, setAt: null, setBy: null, keyPerson: "Ann", canChange: true };
const CUSTOMER = "00000000-0000-4000-8000-000000000001";
const PERSON = "00000000-0000-4000-8000-000000000002";

const get = () => new Request("http://localhost/api/monsoon/claude-key");
const post = (body: unknown) =>
  new Request("http://localhost/api/monsoon/claude-key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.restoreAllMocks();
  for (const f of Object.values(lib)) f.mockReset();
  recordClaudeStatus.mockReset();
  lib.loadClaudeKeyState.mockResolvedValue(STATE);
  signInAs(fakeAccount({ canChangeKey: true }));
});

describe("GET /api/monsoon/claude-key", () => {
  it("answers 401 when signed out", async () => {
    signOut();
    expect((await GET(get())).status).toBe(401);
  });

  it("returns the key's state, uncached", async () => {
    const res = await GET(get());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ key: STATE });
  });

  it("answers 502 without the message when the lookup fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    lib.loadClaudeKeyState.mockRejectedValue(new Error("postgres://u:pw@h"));
    const res = await GET(get());
    expect(res.status).toBe(502);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("pw@h");
  });
});

describe("POST /api/monsoon/claude-key: a new key", () => {
  it("answers 401 when signed out", async () => {
    signOut();
    expect((await POST(post({ claudeKey: KEY }))).status).toBe(401);
  });

  it("refuses anyone but the key person, without testing the key", async () => {
    signInAs(fakeAccount({ canChangeKey: false }));
    const res = await POST(post({ claudeKey: KEY }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_key_person" });
    expect(lib.testClaudeKey).not.toHaveBeenCalled();
    expect(lib.replaceClaudeKey).not.toHaveBeenCalled();
  });

  it("refuses text that is not shaped like a key, without calling Claude", async () => {
    for (const claudeKey of ["", "hello", "sk-ant-short", 42, "sk-ant-" + "a".repeat(400)]) {
      const res = await POST(post({ claudeKey }));
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: "claude_key_rejected" });
    }
    expect(lib.testClaudeKey).not.toHaveBeenCalled();
  });

  it("tests the key, stores it for this person and returns the new state", async () => {
    lib.testClaudeKey.mockResolvedValue("ok");
    lib.replaceClaudeKey.mockResolvedValue(true);
    const res = await POST(post({ claudeKey: `  ${KEY}  ` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: STATE });
    expect(lib.testClaudeKey).toHaveBeenCalledWith(KEY);
    expect(lib.replaceClaudeKey).toHaveBeenCalledWith(CUSTOMER, PERSON, KEY);
  });

  it("keeps the key on file when Claude refuses the new one or it has no credit", async () => {
    for (const reason of ["claude_key_rejected", "claude_no_credit"]) {
      lib.testClaudeKey.mockResolvedValue(reason);
      const res = await POST(post({ claudeKey: KEY }));
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: reason });
    }
    expect(lib.replaceClaudeKey).not.toHaveBeenCalled();
  });

  it("answers 503 and stores nothing when Claude cannot say", async () => {
    for (const reason of ["claude_busy", "unreachable"]) {
      lib.testClaudeKey.mockResolvedValue(reason);
      const res = await POST(post({ claudeKey: KEY }));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "claude_busy" });
    }
    expect(lib.replaceClaudeKey).not.toHaveBeenCalled();
  });

  it("answers 403 when the database says this person is no longer the key person", async () => {
    lib.testClaudeKey.mockResolvedValue("ok");
    lib.replaceClaudeKey.mockResolvedValue(false);
    expect((await POST(post({ claudeKey: KEY }))).status).toBe(403);
  });

  it("never logs or returns the key when storing fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    lib.testClaudeKey.mockResolvedValue("ok");
    lib.replaceClaudeKey.mockRejectedValue(new Error(`boom ${KEY}`));
    const res = await POST(post({ claudeKey: KEY }));
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain(KEY);
    expect(JSON.stringify(spy.mock.calls)).not.toContain(KEY);
  });
});

describe("POST /api/monsoon/claude-key: test the key on file", () => {
  it("anyone signed in may test; the result is recorded and the state returned", async () => {
    signInAs(fakeAccount({ canChangeKey: false }));
    for (const [test, recorded] of [
      ["ok", "ok"],
      ["claude_key_rejected", "key_rejected"],
      ["claude_no_credit", "no_credit"],
    ]) {
      lib.testStoredKey.mockResolvedValue(test);
      const res = await POST(post({ test: true }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ key: STATE });
      expect(recordClaudeStatus).toHaveBeenLastCalledWith(CUSTOMER, recorded);
    }
  });

  it("records nothing when Claude is busy or there is no key", async () => {
    lib.testStoredKey.mockResolvedValue("claude_busy");
    expect((await POST(post({ test: true }))).status).toBe(503);
    lib.testStoredKey.mockResolvedValue("missing");
    const res = await POST(post({ test: true }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "claude_key_missing" });
    expect(recordClaudeStatus).not.toHaveBeenCalled();
  });
});
