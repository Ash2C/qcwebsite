import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capture = vi.fn();
vi.mock("@/lib/monsoon/capture", () => ({
  capture: (...args: unknown[]) => capture(...args),
}));

const ensureOwner = vi.fn();
vi.mock("@/lib/monsoon/owners", () => ({
  ensureOwner: (...args: unknown[]) => ensureOwner(...args),
}));
vi.mock("@/lib/monsoon/accounts/account", async () =>
  (await import("@/lib/monsoon/testing/account")).mockRequireAccount(),
);
import type { Account } from "@/lib/monsoon/accounts/account";
import { fakeAccount, signInAs, signOut } from "@/lib/monsoon/testing/account";
import { POST } from "./route";

const CAPTURE_ID = "11111111-1111-4111-8111-111111111111";

function post(body: unknown): Request {
  return new Request("http://localhost/api/monsoon/save", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    estate: "zeroone",
    captureId: CAPTURE_ID,
    role: "investor",
    fields: {
      name: "Ada Lovelace",
      title: "CIO",
      org: "Analytical Engines",
      email: "ada@example.com",
      phone: "+44 1",
      linkedin: "https://linkedin.com/in/ada",
      notes: "met at conf",
      sneaky: "dropped",
    },
    extracted: { raw_text: "ADA LOVELACE\nCIO", name: "Ada Lovelace" },
    newOrg: true,
    samePerson: false,
    ...overrides,
  };
}

const fakeClient = { fake: true };
const PIPELINES = [
  { key: "traxo", label: "Traxo", defaultRole: "lp_prospect", connected: true },
  { key: "zeroone", label: "Zero One", defaultRole: "investor", connected: true },
];
let account: ReturnType<typeof fakeAccount>;
let withDb: MockInstance<Account["withDb"]>;

beforeEach(() => {
  capture.mockReset();
  account = fakeAccount({ pipelines: PIPELINES, db: fakeClient, person: { ownerKey: "AB" } });
  withDb = vi.spyOn(account, "withDb");
  signInAs(account);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/monsoon/save", () => {
  it("returns 401 when requireAccount refuses and does not capture", async () => {
    signOut();
    const res = await POST(post(validBody()));
    expect(res.status).toBe(401);
    expect(capture).not.toHaveBeenCalled();
    expect(withDb).not.toHaveBeenCalled();
  });

  it("returns 400 for an estate that is not one of the account's pipelines", async () => {
    signInAs(fakeAccount({ pipelines: [PIPELINES[0]], db: fakeClient }));
    const res = await POST(post(validBody({ estate: "zeroone" })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ outcome: "invalid", error: "Unknown estate" });
    expect(capture).not.toHaveBeenCalled();
  });

  it("returns 502 for a pipeline that is not connected", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    signInAs(fakeAccount({ pipelines: [{ ...PIPELINES[1], connected: false }], db: fakeClient }));
    const res = await POST(post(validBody()));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Could not reach the Zero One CRM" });
  });

  it("records a capture activity after a saved outcome", async () => {
    capture.mockResolvedValue({ outcome: "added", person: "p1", org: "o", role: "investor", filled: [] });
    await POST(post(validBody()));
    expect(account.record).toHaveBeenCalledTimes(1);
    expect(account.record).toHaveBeenCalledWith("capture", "zeroone");
  });

  it("records batch_save when the body says batch: true", async () => {
    capture.mockResolvedValue({ outcome: "filed", person: "p1", org: "o", role: "investor", filled: [], created: false });
    await POST(post(validBody({ batch: true })));
    expect(account.record).toHaveBeenCalledWith("batch_save", "zeroone");
  });

  it("records no activity when nothing was saved or the save failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const result of [
      { outcome: "invalid", error: "x" },
      { outcome: "duplicate", person: "p", org: null },
      { outcome: "needs_company", orgs: [] },
      { outcome: "org_lookalike", similar: [] },
    ]) {
      capture.mockResolvedValueOnce(result);
      await POST(post(validBody()));
    }
    capture.mockRejectedValueOnce(new Error("boom"));
    await POST(post(validBody()));
    expect(account.record).not.toHaveBeenCalled();
  });

  it("returns 400 for an unknown estate", async () => {
    const res = await POST(post(validBody({ estate: "qforce" })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ outcome: "invalid", error: "Unknown estate" });
    expect(withDb).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON", async () => {
    const res = await POST(post("{"));
    expect(res.status).toBe(400);
    expect((await res.json()).outcome).toBe("invalid");
  });

  it.each([
    ["fields not an object", { fields: "x" }],
    ["fields null", { fields: null }],
    ["role not a string", { role: 5 }],
    ["captureId not a string", { captureId: 5 }],
  ])("returns 400 before connecting when %s", async (_label, override) => {
    const res = await POST(post(validBody(override)));
    expect(res.status).toBe(400);
    expect((await res.json()).outcome).toBe("invalid");
    expect(withDb).not.toHaveBeenCalled();
  });

  it.each([
    ["name missing", { name: undefined }],
    ["name blank", { name: "   " }],
  ])("returns 400 Name is required before connecting when %s", async (_l, fields) => {
    const res = await POST(post(validBody({ fields: { ...validBody().fields, ...fields } })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ outcome: "invalid", error: "Name is required" });
    expect(withDb).not.toHaveBeenCalled();
  });

  it.each(["name", "title", "org", "email", "phone", "linkedin"])(
    "returns 400 Field too long when %s exceeds 300 characters",
    async (key) => {
      const res = await POST(post(validBody({ fields: { ...validBody().fields, [key]: "x".repeat(301) } })));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ outcome: "invalid", error: "Field too long" });
      expect(withDb).not.toHaveBeenCalled();
    },
  );

  it("limits notes to 2000 characters but allows exactly 2000 and 300", async () => {
    capture.mockResolvedValue({ outcome: "added", person: "p", org: null, role: "investor", filled: [] });
    const long = await POST(post(validBody({ fields: { name: "Ada", notes: "x".repeat(2001) } })));
    expect(long.status).toBe(400);
    expect(await long.json()).toEqual({ outcome: "invalid", error: "Field too long" });
    const ok = await POST(post(validBody({ fields: { name: "x".repeat(300), notes: "y".repeat(2000) } })));
    expect(ok.status).toBe(200);
  });

  it("maps the body onto capture and returns its result", async () => {
    const result = { outcome: "added", person: "p1", org: "o", role: "investor", filled: [] };
    capture.mockResolvedValue(result);
    const res = await POST(post(validBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(fakeClient, {
      captureId: CAPTURE_ID,
      name: "Ada Lovelace",
      role: "investor",
      org: "Analytical Engines",
      title: "CIO",
      email: "ada@example.com",
      phone: "+44 1",
      linkedin: "https://linkedin.com/in/ada",
      notes: "met at conf",
      rawText: "ADA LOVELACE\nCIO",
      extracted: { raw_text: "ADA LOVELACE\nCIO", name: "Ada Lovelace" },
      newOrg: true,
      samePerson: false,
    }, "AB");
    expect(withDb.mock.calls[0][0]).toBe("zeroone");
  });

  it("passes samePerson only as a string or false, newOrg only as true", async () => {
    capture.mockResolvedValue({ outcome: "duplicate", person: "p", org: null });
    await POST(post(validBody({ samePerson: "pid-1", newOrg: false })));
    expect(capture.mock.calls[0][1].samePerson).toBe("pid-1");
    expect(capture.mock.calls[0][1].newOrg).toBeUndefined();
    await POST(post(validBody({ samePerson: true, newOrg: "yes" })));
    expect(capture.mock.calls[1][1].samePerson).toBeUndefined();
    expect(capture.mock.calls[1][1].newOrg).toBeUndefined();
  });

  it("omits rawText when extracted has no string raw_text", async () => {
    capture.mockResolvedValue({ outcome: "duplicate", person: "p", org: null });
    await POST(post(validBody({ extracted: { raw_text: 5 } })));
    expect(capture.mock.calls[0][1].rawText).toBeUndefined();
  });

  it("returns 400 when capture says invalid", async () => {
    capture.mockResolvedValue({ outcome: "invalid", error: "x" });
    const res = await POST(post(validBody()));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ outcome: "invalid", error: "x" });
  });

  it("returns 200 for org_lookalike", async () => {
    const result = { outcome: "org_lookalike", similar: ["Analytical Engine Co"] };
    capture.mockResolvedValue(result);
    const res = await POST(post(validBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
  });

  it("passes kind when it is one of the four values and drops it otherwise", async () => {
    capture.mockResolvedValue({ outcome: "duplicate", person: "p", org: null });
    for (const kind of ["card", "badge", "screen", "other"]) await POST(post(validBody({ kind })));
    expect(capture.mock.calls.map((c) => c[1].kind)).toEqual(["card", "badge", "screen", "other"]);
    await POST(post(validBody({ kind: "poster" })));
    await POST(post(validBody({ kind: 5 })));
    await POST(post(validBody()));
    expect(capture.mock.calls.slice(4).map((c) => c[1].kind)).toEqual([undefined, undefined, undefined]);
  });

  it("returns 200 for filed and needs_company", async () => {
    for (const result of [
      { outcome: "filed", person: "p", org: "Northwind", role: "investor", filled: [], created: true },
      { outcome: "needs_company", orgs: ["A", null] },
    ]) {
      capture.mockResolvedValue(result);
      const res = await POST(post(validBody()));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(result);
    }
  });

  it("returns 502 without leaking details when the database call throws", async () => {
    const secretUrl = "postgresql://user:hunter2@db.internal.example:5432/x";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    withDb.mockRejectedValue(new Error(`boom ${secretUrl}`));
    const res = await POST(post(validBody()));
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "Could not reach the Zero One CRM" });
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("boom");
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain("hunter2");
  });

  it("returns 413 to an over-cap body after a valid session, 401 first without one", async () => {
    const big = JSON.stringify(validBody({ pad: "x".repeat(65_536) }));
    const res = await POST(post(big));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ outcome: "invalid", error: "Request too large" });
    signOut();
    expect((await POST(post(big))).status).toBe(401);
    expect(capture).not.toHaveBeenCalled();
    expect(withDb).not.toHaveBeenCalled();
  });
});
