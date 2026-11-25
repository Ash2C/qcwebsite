import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const classifyRows = vi.fn();
vi.mock("@/lib/monsoon/import/classify", () => ({
  classifyRows: (...args: unknown[]) => classifyRows(...args),
}));
vi.mock("@/lib/monsoon/accounts/account", async () =>
  (await import("@/lib/monsoon/testing/account")).mockRequireAccount(),
);
import type { Account } from "@/lib/monsoon/accounts/account";
import { fakeAccount, signInAs, signOut } from "@/lib/monsoon/testing/account";
import { POST } from "./route";

const fakeDb = { fake: true };
const PIPELINES = [
  { key: "traxo", label: "Traxo", defaultRole: "lp_prospect", connected: true },
  { key: "zeroone", label: "Zero One", defaultRole: "investor", connected: true },
];
let account: ReturnType<typeof fakeAccount>;
let withDb: MockInstance<Account["withDb"]>;

function post(body: unknown): Request {
  return new Request("http://localhost/api/monsoon/import/check", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  classifyRows.mockReset();
  account = fakeAccount({ pipelines: PIPELINES, db: fakeDb });
  withDb = vi.spyOn(account, "withDb");
  signInAs(account);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/monsoon/import/check", () => {
  it("answers 401 when requireAccount refuses and touches nothing", async () => {
    signOut();
    const res = await POST(post({ pipeline: "zeroone", rows: [{ name: "Jane" }] }));
    expect(res.status).toBe(401);
    expect(withDb).not.toHaveBeenCalled();
  });

  it("classifies the cleaned rows on the chosen pipeline and answers classes only", async () => {
    classifyRows.mockResolvedValue([
      { class: "existing", personId: "p-secret" },
      { class: "possible", personId: "p-other" },
      { class: "unreadable" },
      { class: "new" },
      { class: "repeat" },
    ]);
    const rows = [
      { name: "  Jane   Tan ", org: " Acme ", email: "nope", sneaky: "dropped" },
      { name: "Omar Haddad", connectedOn: "2021-03-12" },
      null,
      { name: "New One" },
      { name: "New One" },
    ];
    const res = await POST(post({ pipeline: "zeroone", rows }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ classes: ["existing", "possible", "unreadable", "new", "repeat"] });
    expect(text).not.toContain("p-secret");
    expect(classifyRows).toHaveBeenCalledTimes(1);
    expect(classifyRows).toHaveBeenCalledWith(fakeDb, [
      { name: "Jane Tan", org: "Acme" },
      { name: "Omar Haddad", connectedOn: "2021-03-12" },
      null,
      { name: "New One" },
      { name: "New One" },
    ]);
    expect(withDb.mock.calls[0][0]).toBe("zeroone");
    expect(account.record).not.toHaveBeenCalled();
  });

  it("a row with no name goes to the check as unreadable (null)", async () => {
    classifyRows.mockResolvedValue([{ class: "unreadable" }]);
    await POST(post({ pipeline: "zeroone", rows: [{ org: "Acme" }] }));
    expect(classifyRows).toHaveBeenCalledWith(fakeDb, [null]);
  });

  it("400 for a pipeline that is not one of the account's", async () => {
    for (const pipeline of ["qforce", undefined, 5]) {
      const res = await POST(post({ pipeline, rows: [] }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ outcome: "invalid", error: "Unknown pipeline" });
    }
    expect(withDb).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", "{"],
    ["a body that is not an object", "[]"],
    ["missing rows", { pipeline: "zeroone" }],
    ["rows that are not a list", { pipeline: "zeroone", rows: "x" }],
    ["201 rows", { pipeline: "zeroone", rows: Array.from({ length: 201 }, () => ({ name: "A" })) }],
    ["a row that is text", { pipeline: "zeroone", rows: ["Jane"] }],
    ["a row that is a list", { pipeline: "zeroone", rows: [["Jane"]] }],
  ])("400 on %s", async (_label, body) => {
    const res = await POST(post(body));
    expect(res.status).toBe(400);
    expect((await res.json()).outcome).toBe("invalid");
    expect(withDb).not.toHaveBeenCalled();
  });

  it("accepts 200 rows, and no rows at all without asking the database", async () => {
    classifyRows.mockResolvedValue(Array.from({ length: 200 }, () => ({ class: "new" })));
    const res = await POST(post({ pipeline: "zeroone", rows: Array.from({ length: 200 }, (_, i) => ({ name: `P ${i}` })) }));
    expect(res.status).toBe(200);
    expect((await res.json()).classes).toHaveLength(200);
    withDb.mockClear();
    const none = await POST(post({ pipeline: "zeroone", rows: [] }));
    expect(await none.json()).toEqual({ classes: [] });
    expect(withDb).not.toHaveBeenCalled();
  });

  it("502 without leaking details when the database call throws, also for a pipeline not connected", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    classifyRows.mockRejectedValue(new Error("boom postgresql://user:hunter2@db.internal:5432/x Jane Tan"));
    const res = await POST(post({ pipeline: "zeroone", rows: [{ name: "Jane Tan" }] }));
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "Could not reach the Zero One CRM" });
    expect(text).not.toContain("hunter2");
    expect(JSON.stringify(log.mock.calls)).not.toContain("hunter2");
    signInAs(fakeAccount({ pipelines: [{ ...PIPELINES[1], connected: false }], db: fakeDb }));
    expect((await POST(post({ pipeline: "zeroone", rows: [{ name: "Jane Tan" }] }))).status).toBe(502);
  });

  it("413 for a body over the limit", async () => {
    const res = await POST(post(JSON.stringify({ pipeline: "zeroone", rows: [], pad: "x".repeat(530_000) })));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ outcome: "invalid", error: "Request too large" });
  });
});
