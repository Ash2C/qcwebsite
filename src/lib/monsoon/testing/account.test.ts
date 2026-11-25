// Shows how a route test uses the helper: mock the account module once, then choose per test
// who is signed in and which fake database / Claude client their account hands out.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/monsoon/accounts/account", async () =>
  (await import("@/lib/monsoon/testing/account")).mockRequireAccount(),
);

import { NotConnected, requireAccount } from "@/lib/monsoon/accounts/account";
import { fakeAccount, signInAs, signOut } from "./account";

// A stand-in for a route handler.
async function route(request: Request): Promise<Response> {
  const auth = await requireAccount(request);
  if (!auth.ok) return auth.response;
  const rows = await auth.account.withDb("main", async (db) => (await db.query("SELECT 1")).rows);
  return Response.json({ rows, by: auth.account.person.ownerKey });
}

const request = new Request("http://localhost/api/monsoon/x");

describe("testing/account", () => {
  beforeEach(() => signOut());

  it("refuses with 401 until someone is signed in", async () => {
    const res = await route(request);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("hands the route the fake account, its fake db and fake Claude client", async () => {
    const db = { query: vi.fn(async () => ({ rows: [{ n: 1 }] })) };
    const claude = { messages: { create: vi.fn() } };
    const account = signInAs(fakeAccount({ db, claude }));
    const res = await route(request);
    expect(await res.json()).toEqual({ rows: [{ n: 1 }], by: "VF" });
    expect(db.query).toHaveBeenCalledWith("SELECT 1");
    // Like the real account, it hands out no Claude client until the AI gate has been awaited.
    expect(() => account.anthropic({ timeout: 1 })).toThrow("beginAi");
    await account.beginAi("ask");
    expect(account.anthropic({ timeout: 1 })).toBe(claude);
    const failure = new Error("x");
    expect(account.aiError(failure)).toBe(failure);
    await account.record("ask", "main");
    expect(account.record).toHaveBeenCalledWith("ask", "main");
  });

  it("throws NotConnected for unknown or unconnected pipelines and a missing Claude client", async () => {
    const account = fakeAccount({
      pipelines: [{ key: "main", label: "Main", defaultRole: "investor", connected: false }],
    });
    await expect(account.withDb("main", async () => 1)).rejects.toBeInstanceOf(NotConnected);
    await expect(account.withDb("nope", async () => 1)).rejects.toBeInstanceOf(NotConnected);
    await account.beginAi("ask");
    expect(() => account.anthropic({ timeout: 1 })).toThrow(NotConnected);
    expect(account.pipeline("main")?.label).toBe("Main");
  });
});
