import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saveImportRows = vi.fn();
const noteCompanyImports = vi.fn();
vi.mock("@/lib/monsoon/import/save", async (orig) => ({
  ...(await orig<typeof import("@/lib/monsoon/import/save")>()),
  saveImportRows: (...args: unknown[]) => saveImportRows(...args),
  noteCompanyImports: (...args: unknown[]) => noteCompanyImports(...args),
}));
const withImportLock = vi.fn();
vi.mock("@/lib/monsoon/import/guard", () => ({
  withImportLock: (...args: unknown[]) => withImportLock(...args),
}));
const ensureOwner = vi.fn();
vi.mock("@/lib/monsoon/owners", () => ({
  ensureOwner: (...args: unknown[]) => ensureOwner(...args),
}));
vi.mock("@/lib/monsoon/accounts/account", async () =>
  (await import("@/lib/monsoon/testing/account")).mockRequireAccount(),
);
import type { Account } from "@/lib/monsoon/accounts/account";
import { ImportInputError } from "@/lib/monsoon/import/save";
import { fakeAccount, signInAs, signOut } from "@/lib/monsoon/testing/account";
import { POST, maxDuration } from "./route";

const IMPORT_ID = "11111111-1111-4111-8111-111111111111";
const fakeDb = { fake: true };
const PIPELINES = [
  { key: "traxo", label: "Traxo", defaultRole: "lp_prospect", connected: true },
  { key: "zeroone", label: "Zero One", defaultRole: "investor", connected: true },
];
let account: ReturnType<typeof fakeAccount>;
let withDb: MockInstance<Account["withDb"]>;

function post(body: unknown): Request {
  return new Request("http://localhost/api/monsoon/import/save", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}
function validBody(over: Record<string, unknown> = {}) {
  return {
    pipeline: "zeroone",
    importId: IMPORT_ID,
    label: "  LinkedIn import,\nNovember 2026 ",
    role: "investor",
    includePossible: false,
    rows: [
      { rowNumber: 2, contact: { name: " Jane  Tan ", org: "Acme", sneaky: "x" } },
      { rowNumber: 3, contact: null },
    ],
    ...over,
  };
}
const RESULTS = [
  { rowNumber: 2, outcome: "added", filedUnder: "member-1" },
  { rowNumber: 3, outcome: "unreadable" },
];

beforeEach(() => {
  saveImportRows.mockReset().mockResolvedValue(RESULTS);
  noteCompanyImports.mockReset().mockResolvedValue(undefined);
  ensureOwner.mockReset().mockResolvedValue(undefined);
  withImportLock.mockReset().mockImplementation(async (_db: unknown, _person: unknown, work: () => Promise<unknown>) => ({
    locked: true,
    value: await work(),
  }));
  account = fakeAccount({ pipelines: PIPELINES, db: fakeDb, person: { ownerKey: "AB", name: "Abe" } });
  withDb = vi.spyOn(account, "withDb");
  signInAs(account);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/monsoon/import/save", () => {
  it("allows the request 60 seconds", () => {
    expect(maxDuration).toBe(60);
  });

  it("answers 401 when requireAccount refuses and saves nothing", async () => {
    signOut();
    const res = await POST(post(validBody()));
    expect(res.status).toBe(401);
    expect(withDb).not.toHaveBeenCalled();
    expect(saveImportRows).not.toHaveBeenCalled();
  });

  it("saves the rows as the signed-in person and answers a result per row, without member ids", async () => {
    const before = Date.now();
    const res = await POST(post(validBody()));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      results: [
        { rowNumber: 2, outcome: "added" },
        { rowNumber: 3, outcome: "unreadable" },
      ],
    });
    expect(text).not.toContain("member-1");
    expect(ensureOwner).toHaveBeenCalledWith(fakeDb, "AB", "Abe");
    expect(saveImportRows).toHaveBeenCalledTimes(1);
    const [db, input, opts] = saveImportRows.mock.calls[0];
    expect(db).toBe(fakeDb);
    expect(input).toEqual({
      importId: IMPORT_ID,
      label: "LinkedIn import, November 2026",
      role: "investor",
      owner: "AB",
      includePossible: false,
      rows: [
        { rowNumber: 2, contact: { name: "Jane Tan", org: "Acme" } },
        { rowNumber: 3, contact: null },
      ],
    });
    // Rows are no longer started well before the 60 seconds are up.
    expect(opts.deadline).toBeGreaterThanOrEqual(before + 40_000);
    expect(opts.deadline).toBeLessThanOrEqual(Date.now() + 50_000);
    expect(withDb.mock.calls.map((c) => c[0])).toEqual(["zeroone", "zeroone"]);
  });

  it("a request with rows writes no company summary", async () => {
    await POST(post(validBody()));
    expect(noteCompanyImports).not.toHaveBeenCalled();
  });

  const finishBody = (over: Record<string, unknown> = {}) => ({
    pipeline: "zeroone",
    importId: IMPORT_ID,
    label: "  LinkedIn import,\nNovember 2026 ",
    finish: true,
    ...over,
  });

  it("the closing request writes the company summaries for the whole import, under the guard, and saves no rows", async () => {
    const res = await POST(post(finishBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ finished: true });
    expect(saveImportRows).not.toHaveBeenCalled();
    expect(withImportLock).toHaveBeenCalledTimes(1);
    expect(withImportLock.mock.calls[0][1]).toBe(account.person.id);
    expect(ensureOwner).toHaveBeenCalledWith(fakeDb, "AB", "Abe");
    expect(noteCompanyImports).toHaveBeenCalledTimes(1);
    expect(noteCompanyImports).toHaveBeenCalledWith(fakeDb, { importId: IMPORT_ID, label: "LinkedIn import, November 2026", owner: "AB" });
    expect(account.record).not.toHaveBeenCalled();
  });

  it("the closing request: 409 while an import is running, 400 for a bad one, 502 when it fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await POST(post(finishBody({ importId: "nope" })))).status).toBe(400);
    expect((await POST(post(finishBody({ label: " " })))).status).toBe(400);
    expect((await POST(post(finishBody({ pipeline: "other" })))).status).toBe(400);
    expect((await POST(post(finishBody({ rows: [{ rowNumber: 1, contact: { name: "A" } }] })))).status).toBe(400);
    expect(noteCompanyImports).not.toHaveBeenCalled();
    noteCompanyImports.mockRejectedValueOnce(new Error("boom at db.internal"));
    const failed = await POST(post(finishBody()));
    expect(failed.status).toBe(502);
    expect(JSON.stringify(await failed.json())).not.toContain("internal");
    withImportLock.mockResolvedValue({ locked: false });
    const busy = await POST(post(finishBody()));
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: "import_running" });
  });

  it("holds the one-import-at-a-time guard for this person around the save", async () => {
    await POST(post(validBody()));
    expect(withImportLock).toHaveBeenCalledTimes(1);
    expect(withImportLock.mock.calls[0][0]).toBe(fakeDb);
    expect(withImportLock.mock.calls[0][1]).toBe(account.person.id);
  });

  it("answers 409 when this person already has an import running, and saves nothing", async () => {
    withImportLock.mockResolvedValue({ locked: false });
    const res = await POST(post(validBody({ first: true })));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "import_running" });
    expect(saveImportRows).not.toHaveBeenCalled();
    expect(account.record).not.toHaveBeenCalled();
  });

  it("records one batch_save activity, only for the request that says first: true", async () => {
    await POST(post(validBody()));
    await POST(post(validBody({ first: false })));
    await POST(post(validBody({ first: "yes" })));
    expect(account.record).not.toHaveBeenCalled();
    await POST(post(validBody({ first: true })));
    expect(account.record).toHaveBeenCalledTimes(1);
    expect(account.record).toHaveBeenCalledWith("batch_save", "zeroone");
  });

  it("records nothing when the save failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    saveImportRows.mockRejectedValue(new Error("boom"));
    await POST(post(validBody({ first: true })));
    expect(account.record).not.toHaveBeenCalled();
  });

  it("passes includePossible through", async () => {
    await POST(post(validBody({ includePossible: true })));
    expect(saveImportRows.mock.calls[0][1].includePossible).toBe(true);
  });

  it("400 for a pipeline that is not one of the account's", async () => {
    signInAs(fakeAccount({ pipelines: [PIPELINES[0]], db: fakeDb }));
    const res = await POST(post(validBody()));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ outcome: "invalid", error: "Unknown pipeline" });
  });

  it.each([
    ["malformed JSON", "{"],
    ["a body that is not an object", "[]"],
    ["an import id that is not a UUID", validBody({ importId: "abc" })],
    ["a missing import id", validBody({ importId: undefined })],
    ["a label that is not text", validBody({ label: 5 })],
    ["a blank label", validBody({ label: " \n " })],
    ["a role that is not text", validBody({ role: 5 })],
    ["includePossible that is not true or false", validBody({ includePossible: "yes" })],
    ["rows that are not a list", validBody({ rows: {} })],
    ["no rows", validBody({ rows: [] })],
    ["101 rows", validBody({ rows: Array.from({ length: 101 }, (_, i) => ({ rowNumber: i, contact: { name: "A" } })) })],
    ["a row that is not an object", validBody({ rows: [5] })],
    ["a row with no number", validBody({ rows: [{ contact: { name: "A" } }] })],
    ["a row number that is a fraction", validBody({ rows: [{ rowNumber: 1.5, contact: { name: "A" } }] })],
    ["a negative row number", validBody({ rows: [{ rowNumber: -1, contact: { name: "A" } }] })],
    ["a row number that is text", validBody({ rows: [{ rowNumber: "1", contact: { name: "A" } }] })],
    ["a huge row number", validBody({ rows: [{ rowNumber: 10_000_001, contact: { name: "A" } }] })],
    ["a row number past the 5,000 rows a file may have", validBody({ rows: [{ rowNumber: 5000, contact: { name: "A" } }] })],
    ["a label longer than 80 characters once cleaned", validBody({ label: `  ${"x".repeat(81)} ` })],
    ["a closing request with a label longer than 80", { pipeline: "zeroone", importId: IMPORT_ID, label: "x".repeat(81), finish: true }],
    ["the same row number twice", validBody({ rows: [{ rowNumber: 1, contact: { name: "A" } }, { rowNumber: 1, contact: { name: "B" } }] })],
    ["a contact that is text", validBody({ rows: [{ rowNumber: 1, contact: "Jane" }] })],
    ["a contact that is a list", validBody({ rows: [{ rowNumber: 1, contact: ["Jane"] }] })],
  ])("400 before connecting on %s", async (_label, body) => {
    const res = await POST(post(body));
    expect(res.status).toBe(400);
    expect((await res.json()).outcome).toBe("invalid");
    expect(withDb).not.toHaveBeenCalled();
  });

  it("accepts the last row a file can have and a label of exactly 80 characters, however it is padded", async () => {
    const label = "x".repeat(80);
    const res = await POST(post(validBody({ label: `  ${label}\n `, rows: [{ rowNumber: 4999, contact: { name: "A" } }] })));
    expect(res.status).toBe(200);
    expect(saveImportRows.mock.calls[0][1]).toMatchObject({ label, rows: [{ rowNumber: 4999 }] });
  });

  it("accepts 100 rows", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ rowNumber: i, contact: { name: `P ${i}` } }));
    expect((await POST(post(validBody({ rows })))).status).toBe(200);
  });

  it("400 with the reason when the library refuses the role", async () => {
    saveImportRows.mockRejectedValue(new ImportInputError("unknown role: nope"));
    const res = await POST(post(validBody({ role: "nope", first: true })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ outcome: "invalid", error: "unknown role: nope" });
    expect(account.record).not.toHaveBeenCalled();
  });

  it("502 without leaking details when the database call throws, also for a pipeline not connected", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    saveImportRows.mockRejectedValue(new Error("boom postgresql://user:hunter2@db.internal:5432/x"));
    const res = await POST(post(validBody()));
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "Could not reach the Zero One CRM" });
    expect(text).not.toContain("hunter2");
    expect(JSON.stringify(log.mock.calls)).not.toContain("hunter2");
    signInAs(fakeAccount({ pipelines: [{ ...PIPELINES[1], connected: false }], db: fakeDb }));
    expect((await POST(post(validBody()))).status).toBe(502);
  });

  it("413 for a body over 256 KB after a valid session, 401 first without one", async () => {
    const big = JSON.stringify(validBody({ pad: "x".repeat(262_144) }));
    const res = await POST(post(big));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ outcome: "invalid", error: "Request too large" });
    signOut();
    expect((await POST(post(big))).status).toBe(401);
    expect(withDb).not.toHaveBeenCalled();
  });
});
