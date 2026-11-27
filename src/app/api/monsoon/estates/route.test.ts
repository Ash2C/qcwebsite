import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/monsoon/accounts/account", async () =>
  (await import("@/lib/monsoon/testing/account")).mockRequireAccount(),
);
const loadClaudeKeyState = vi.fn();
vi.mock("@/lib/monsoon/accounts/claude-key", () => ({
  loadClaudeKeyState: (...args: unknown[]) => loadClaudeKeyState(...args),
}));
import { fakeAccount, signInAs, signOut } from "@/lib/monsoon/testing/account";
import { GET } from "./route";

const request = () => new Request("http://localhost/api/monsoon/estates");

const ROLES = [{ key: "investor", label: "Investor" }];
const PIPELINES = [
  { key: "a", label: "Alpha", defaultRole: "lp_prospect", connected: true },
  { key: "b", label: "Beta", defaultRole: "investor", connected: true },
];

// A db whose queries answer roles and the schema version.
function dbWith(version: number | null, roles = ROLES) {
  return {
    query: vi.fn(async (sql: string) =>
      /schema_migrations/.test(sql) ? { rows: [{ max: version }] } : { rows: roles },
    ),
  };
}

beforeEach(() => {
  signOut();
  loadClaudeKeyState.mockReset();
  loadClaudeKeyState.mockRejectedValue(new Error("no accounts database"));
});
afterEach(() => vi.restoreAllMocks());

describe("GET /api/monsoon/estates", () => {
  it("returns 401 when requireAccount refuses", async () => {
    expect((await GET(request())).status).toBe(401);
  });

  it("carries the Claude key status for the header chip, and leaves it out when the lookup fails", async () => {
    signInAs(fakeAccount({ pipelines: PIPELINES, db: dbWith(1) }));
    loadClaudeKeyState.mockResolvedValue({ status: "key_rejected", last4: "abcd" });
    expect((await (await GET(request())).json()).claude).toEqual({ status: "key_rejected" });
    loadClaudeKeyState.mockRejectedValue(new Error("down"));
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect("claude" in (await res.json())).toBe(false);
  });

  it("lists the account's pipelines with roles, plus the person (id and name) and the customer name", async () => {
    signInAs(fakeAccount({ pipelines: PIPELINES, db: dbWith(1) }));
    const res = await GET(request());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.person).toEqual({ id: "00000000-0000-4000-8000-000000000002", name: "Vincent" });
    expect(body.customer).toEqual({ name: "Test Co" });
    expect(body.estates[0]).toEqual({
      key: "a",
      label: "Alpha",
      defaultRole: "lp_prospect",
      available: true,
      roles: ROLES,
      todos: false,
    });
    expect(body.estates.map((e: { key: string }) => e.key)).toEqual(["a", "b"]);
  });

  it("says a pipeline has to-dos only when its CRM is at schema version 2 or more", async () => {
    for (const [version, todos] of [[1, false], [2, true], [3, true]] as const) {
      signInAs(fakeAccount({ pipelines: PIPELINES, db: dbWith(version) }));
      const body = await (await GET(request())).json();
      expect(body.estates[0], `version ${version}`).toMatchObject({ available: true, todos });
    }
    signInAs(fakeAccount({ pipelines: [{ ...PIPELINES[0], connected: false }, PIPELINES[1]], db: dbWith(2) }));
    expect((await (await GET(request())).json()).estates[0]).toMatchObject({ available: false, todos: false });
  });

  it("reports not_connected for a pipeline with no database, without connecting", async () => {
    const account = fakeAccount({
      pipelines: [{ ...PIPELINES[0], connected: false }, PIPELINES[1]],
      db: dbWith(1),
    });
    const withDb = vi.spyOn(account, "withDb");
    signInAs(account);
    const body = await (await GET(request())).json();
    expect(body.estates[0]).toMatchObject({ available: false, reason: "not_connected", roles: [] });
    expect(body.estates[1].available).toBe(true);
    expect(withDb).toHaveBeenCalledTimes(1);
    expect(withDb.mock.calls[0][0]).toBe("b");
  });

  it("reports unreachable when withDb rejects, and one down does not hide the other", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const account = fakeAccount({ pipelines: PIPELINES, db: dbWith(1) });
    const real = account.withDb.bind(account);
    account.withDb = (key, fn) =>
      key === "a" ? Promise.reject(new Error("connect ECONNREFUSED hunter2")) : real(key, fn);
    signInAs(account);
    const body = await (await GET(request())).json();
    expect(body.estates[0]).toMatchObject({ available: false, reason: "unreachable", roles: [] });
    expect(body.estates[1].available).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain("hunter2");
  });

  it("reports needs_update when the schema version is behind", async () => {
    signInAs(fakeAccount({ pipelines: PIPELINES, db: dbWith(0) }));
    const body = await (await GET(request())).json();
    expect(body.estates[0]).toMatchObject({ available: false, reason: "needs_update", roles: [] });
  });

  it("reports needs_update when schema_migrations has no version at all", async () => {
    signInAs(fakeAccount({ pipelines: PIPELINES, db: dbWith(null) }));
    const body = await (await GET(request())).json();
    expect(body.estates[0].reason).toBe("needs_update");
  });

  it("reports unreachable when the schema table is missing (query fails)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = { query: vi.fn(async () => { throw Object.assign(new Error("no table"), { code: "42P01" }); }) };
    signInAs(fakeAccount({ pipelines: PIPELINES, db }));
    const body = await (await GET(request())).json();
    expect(body.estates[0]).toMatchObject({ available: false, reason: "unreachable" });
  });
});

describe("route config", () => {
  it("caps the function at 30 seconds", async () => {
    const mod = await import("./route");
    expect(mod.maxDuration).toBe(30);
  });
});
