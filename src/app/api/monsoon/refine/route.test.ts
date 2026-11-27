import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refineContact = vi.fn();
vi.mock("@/lib/monsoon/refine", async (orig) => ({
  ...(await orig<typeof import("@/lib/monsoon/refine")>()),
  refineContact: (...args: unknown[]) => refineContact(...args),
}));

vi.mock("@/lib/monsoon/accounts/account", async () =>
  (await import("@/lib/monsoon/testing/account")).mockRequireAccount(),
);
import { TrialPaused } from "@/lib/monsoon/accounts/not-connected";
import { fakeAccount, signInAs, signOut } from "@/lib/monsoon/testing/account";
import { POST } from "./route";

const FAKE_CLAUDE = { fake: "claude" };
let account: ReturnType<typeof fakeAccount>;

const FIELDS = {
  name: "Jane Tan",
  title: "Partner",
  org: "Acme",
  email: "",
  phone: "",
  linkedin: "",
};
const OUT = { fields: { ...FIELDS, title: "CIO" }, notes: "Now CIO.", todos: [] };

function req(body: unknown, raw?: string): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  return new Request("http://localhost/api/monsoon/refine", {
    method: "POST",
    headers,
    body: raw ?? JSON.stringify(body),
  });
}
const valid = (over: Record<string, unknown> = {}) => ({
  fields: FIELDS,
  notes: "met at demo",
  spoken: "she is CIO now",
  ...over,
});

beforeEach(() => {
  refineContact.mockReset();
  account = fakeAccount({ claude: FAKE_CLAUDE, model: "claude-test-1" });
  signInAs(account);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/monsoon/refine", () => {
  it("answers 401 when requireAccount refuses and does not call the model", async () => {
    signOut();
    const res = await POST(req(valid()));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(refineContact).not.toHaveBeenCalled();
  });

  it("400 on malformed JSON", async () => {
    const res = await POST(req(null, "{nope"));
    expect(res.status).toBe(400);
    expect(refineContact).not.toHaveBeenCalled();
  });

  it.each([
    ["missing fields", { notes: "", spoken: "x" }],
    ["a missing field key", valid({ fields: { name: "a" } })],
    ["a non-string field", valid({ fields: { ...FIELDS, org: 5 } })],
    ["non-string notes", valid({ notes: 1 })],
    ["non-string spoken", valid({ spoken: 1 })],
  ])("400 on %s", async (_n, body) => {
    expect((await POST(req(body))).status).toBe(400);
    expect(refineContact).not.toHaveBeenCalled();
  });

  it("400 Nothing to tidy for blank spoken", async () => {
    const res = await POST(req(valid({ spoken: "  \n " })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Nothing to tidy" });
  });

  it("400 for spoken over 4000 characters, accepts exactly 4000", async () => {
    expect((await POST(req(valid({ spoken: "a".repeat(4001) })))).status).toBe(400);
    refineContact.mockResolvedValue(OUT);
    expect((await POST(req(valid({ spoken: "a".repeat(4000) })))).status).toBe(200);
  });

  it("400 Field too long for a 301-character org or 2001-character notes", async () => {
    const res = await POST(req(valid({ fields: { ...FIELDS, org: "o".repeat(301) } })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Field too long" });
    expect((await POST(req(valid({ notes: "n".repeat(2001) })))).status).toBe(400);
    expect(refineContact).not.toHaveBeenCalled();
  });

  it("200 with the refined record, calling refineContact with exactly fields, notes, spoken", async () => {
    refineContact.mockResolvedValue(OUT);
    const res = await POST(req(valid({ extra: "ignored" })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OUT);
    expect(refineContact).toHaveBeenCalledWith(FAKE_CLAUDE, "claude-test-1", {
      fields: FIELDS,
      notes: "met at demo",
      spoken: "she is CIO now",
      today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expect(account.record).toHaveBeenCalledWith("tidy");
  });

  it("passes the browser's day through resolveToday", async () => {
    refineContact.mockResolvedValue(OUT);
    const server = new Date().toISOString().slice(0, 10);
    await POST(req(valid({ today: server })));
    expect(refineContact.mock.calls[0][2].today).toBe(server);
    refineContact.mockClear();
    await POST(req(valid({ today: "1999-01-01" })));
    expect(refineContact.mock.calls[0][2].today).toBe(server);
  });

  it("records no activity when tidying fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    refineContact.mockRejectedValue(new Error("x"));
    await POST(req(valid()));
    expect(account.record).not.toHaveBeenCalled();
  });

  it("409 claude_no_credit when the account is out of credit", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    refineContact.mockRejectedValue(Object.assign(new Error("Your credit balance is too low"), { status: 400 }));
    const res = await POST(req(valid()));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "claude_no_credit" });
  });

  it("409 claude_key_missing when the customer has no Claude key", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    signInAs(fakeAccount());
    const res = await POST(req(valid()));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "claude_key_missing" });
    expect(refineContact).not.toHaveBeenCalled();
  });

  it("502 with a generic body, and the thrown message never reaches the log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    refineContact.mockRejectedValue(new Error("secret dictated text Jane"));
    const res = await POST(req(valid()));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Could not tidy the notes" });
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain("secret dictated text");
    expect(logged).not.toContain("Jane");
    expect(logged).not.toContain("she is CIO now");
  });

  it("413 to an over-cap body after a valid session, 401 first without one", async () => {
    const big = JSON.stringify(valid({ pad: "x".repeat(32_768) }));
    const res = await POST(req(null, big));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "Request too large" });
    signOut();
    expect((await POST(req(null, big))).status).toBe(401);
    expect(refineContact).not.toHaveBeenCalled();
  });
});

describe("POST /api/monsoon/refine and the free trial", () => {
  it("passes the AI gate once, as a tidy-up, before Claude is asked", async () => {
    refineContact.mockImplementation(async () => {
      expect(account.beginAi).toHaveBeenCalledTimes(1);
      return OUT;
    });
    expect((await POST(req(valid()))).status).toBe(200);
    expect(vi.mocked(account.beginAi).mock.calls).toEqual([["tidy"]]);
  });

  it("does not pass the gate for a request it refuses", async () => {
    await POST(req(valid({ spoken: " " })));
    signOut();
    await POST(req(valid()));
    expect(account.beginAi).not.toHaveBeenCalled();
  });

  it("a trial that is over answers as a missing key does today", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const over = signInAs(fakeAccount());
    const res = await POST(req(valid()));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "claude_key_missing" });
    expect(over.beginAi).toHaveBeenCalledTimes(1);
    expect(refineContact).not.toHaveBeenCalled();
  });

  it("a paused trial answers 409 claude_trial_paused and Claude is never asked", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(account.beginAi).mockRejectedValue(new TrialPaused());
    const anthropic = vi.spyOn(account, "anthropic");
    const res = await POST(req(valid()));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "claude_trial_paused" });
    expect(anthropic).not.toHaveBeenCalled();
    expect(refineContact).not.toHaveBeenCalled();
  });

  it("answers with what the account says a failed call means (a refused trial key is the pause)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const refusedKey = Object.assign(new Error("invalid x-api-key"), { status: 401 });
    refineContact.mockRejectedValue(refusedKey);
    vi.mocked(account.aiError).mockReturnValue(new TrialPaused());
    const res = await POST(req(valid()));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "claude_trial_paused" });
    expect(account.aiError).toHaveBeenCalledWith(refusedKey);
    expect(account.noteClaude).toHaveBeenCalledWith(refusedKey);
  });
});
