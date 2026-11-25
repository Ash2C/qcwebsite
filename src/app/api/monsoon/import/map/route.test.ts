import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const claudeMapping = vi.fn();
vi.mock("@/lib/monsoon/import/map-ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/monsoon/import/map-ai")>()),
  claudeMapping: (...args: unknown[]) => claudeMapping(...args),
}));
vi.mock("@/lib/monsoon/accounts/account", async () =>
  (await import("@/lib/monsoon/testing/account")).mockRequireAccount(),
);
import { TrialPaused } from "@/lib/monsoon/accounts/not-connected";
import { fakeAccount, signInAs, signOut } from "@/lib/monsoon/testing/account";
import { POST } from "./route";

const FAKE_CLAUDE = { fake: "claude" };
let account: ReturnType<typeof fakeAccount>;

function post(body: unknown): Request {
  return new Request("http://localhost/api/monsoon/import/map", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}
const LINKEDIN = ["First Name", "Last Name", "URL", "Email Address", "Company", "Position", "Connected On"];
const ODD = ["Contact", "Employer", "Mail"];
const SAMPLES = [["Jane Tan", "Acme", "jane@acme.com"]];

beforeEach(() => {
  claudeMapping.mockReset();
  account = fakeAccount({ claude: FAKE_CLAUDE });
  signInAs(account);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/monsoon/import/map", () => {
  it("answers 401 when requireAccount refuses", async () => {
    signOut();
    const res = await POST(post({ headers: ODD, samples: SAMPLES }));
    expect(res.status).toBe(401);
    expect(claudeMapping).not.toHaveBeenCalled();
  });

  it("maps a known export in code: no AI use, no Claude call", async () => {
    const res = await POST(post({ headers: LINKEDIN, samples: [] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      mapping: { firstName: 0, lastName: 1, linkedin: 2, email: 3, company: 4, title: 5, connectedOn: 6 },
      source: "known",
    });
    expect(account.beginAi).not.toHaveBeenCalled();
    expect(claudeMapping).not.toHaveBeenCalled();
  });

  it("asks Claude once for an unfamiliar file, as one AI use of kind import", async () => {
    claudeMapping.mockResolvedValue({ fullName: 0, company: 1, email: 2 });
    const res = await POST(post({ headers: ODD, samples: SAMPLES }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mapping: { fullName: 0, company: 1, email: 2 }, source: "claude" });
    expect(account.beginAi).toHaveBeenCalledTimes(1);
    expect(account.beginAi).toHaveBeenCalledWith("import");
    expect(claudeMapping).toHaveBeenCalledTimes(1);
    expect(claudeMapping).toHaveBeenCalledWith(FAKE_CLAUDE, ODD, SAMPLES);
    expect(account.noteClaude).toHaveBeenCalledWith();
    expect(account.record).not.toHaveBeenCalled();
  });

  it("answers none when Claude's reply is not a usable mapping", async () => {
    claudeMapping.mockResolvedValue(null);
    const res = await POST(post({ headers: ODD, samples: SAMPLES }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mapping: null, source: "none" });
  });

  it("checks Claude's mapping again before answering", async () => {
    claudeMapping.mockResolvedValue({ fullName: 7, salary: 1 });
    expect(await (await POST(post({ headers: ODD, samples: SAMPLES }))).json()).toEqual({ mapping: null, source: "none" });
  });

  it("answers none with 200 when the customer has no Claude key", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    signInAs(fakeAccount());
    const res = await POST(post({ headers: ODD, samples: SAMPLES }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mapping: null, source: "none" });
    expect(claudeMapping).not.toHaveBeenCalled();
  });

  it.each([
    ["a rejected key", Object.assign(new Error("invalid x-api-key sk-secret"), { status: 401 })],
    ["no credit", Object.assign(new Error("Your credit balance is too low"), { status: 400 })],
    ["Claude busy", Object.assign(new Error("overloaded"), { status: 529 })],
    ["a timeout", new Error("timed out")],
  ])("answers none with 200 on %s, notes it, and logs no message", async (_label, err) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    claudeMapping.mockRejectedValue(err);
    const res = await POST(post({ headers: ODD, samples: SAMPLES }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mapping: null, source: "none" });
    expect(account.noteClaude).toHaveBeenCalledWith(err);
    expect(JSON.stringify(log.mock.calls)).not.toContain(err.message);
  });

  it("answers none with 200 while the free trial is paused", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    (account.beginAi as ReturnType<typeof vi.fn>).mockRejectedValue(new TrialPaused());
    const res = await POST(post({ headers: ODD, samples: SAMPLES }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mapping: null, source: "none" });
    expect(claudeMapping).not.toHaveBeenCalled();
  });

  it("400 on malformed JSON", async () => {
    const res = await POST(post("{nope"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ outcome: "invalid", error: "Invalid JSON" });
  });

  it.each([
    ["a body that is not an object", [1]],
    ["missing headers", { samples: [] }],
    ["no headers", { headers: [], samples: [] }],
    ["201 headers", { headers: Array.from({ length: 201 }, (_, i) => `h${i}`), samples: [] }],
    ["a heading that is not text", { headers: ["Name", 5], samples: [] }],
    ["missing samples", { headers: ODD }],
    ["six sample rows", { headers: ODD, samples: Array.from({ length: 6 }, () => ["a"]) }],
    ["a sample row that is not a list", { headers: ODD, samples: ["a,b"] }],
    ["a sample cell that is not text", { headers: ODD, samples: [["a", 5]] }],
    ["a sample row wider than 200", { headers: ODD, samples: [Array.from({ length: 201 }, () => "x")] }],
  ])("400 on %s", async (_label, body) => {
    const res = await POST(post(body));
    expect(res.status).toBe(400);
    expect((await res.json()).outcome).toBe("invalid");
    expect(account.beginAi).not.toHaveBeenCalled();
  });

  it("accepts 200 headers and 5 sample rows", async () => {
    claudeMapping.mockResolvedValue(null);
    const headers = Array.from({ length: 200 }, (_, i) => `h${i}`);
    const res = await POST(post({ headers, samples: Array.from({ length: 5 }, () => ["x"]) }));
    expect(res.status).toBe(200);
  });

  it("413 for a body over the limit, 401 first without a session", async () => {
    const big = JSON.stringify({ headers: ODD, samples: [["x".repeat(140_000)]] });
    const res = await POST(post(big));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ outcome: "invalid", error: "Request too large" });
    signOut();
    expect((await POST(post(big))).status).toBe(401);
  });
});
