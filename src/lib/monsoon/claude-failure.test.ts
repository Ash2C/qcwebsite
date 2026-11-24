import { describe, expect, it } from "vitest";
import { NotConnected } from "./accounts/not-connected";
import { claudeFailure, claudeFailureResponse } from "./claude-failure";

const api = (status: number, message = "secret detail") => Object.assign(new Error(message), { status });

describe("claudeFailure", () => {
  it("names a missing Claude key, but not an unconnected pipeline", () => {
    expect(claudeFailure(new NotConnected("Claude key"))).toBe("claude_key_missing");
    expect(claudeFailure(new NotConnected("Pipeline"))).toBeNull();
  });

  it("names a key Claude refuses (401, 403)", () => {
    expect(claudeFailure(api(401))).toBe("claude_key_rejected");
    expect(claudeFailure(api(403))).toBe("claude_key_rejected");
  });

  it("names an account that is out of credit (402, or the credit-balance refusal)", () => {
    expect(claudeFailure(api(402))).toBe("claude_no_credit");
    expect(claudeFailure(api(400, "Your credit balance is too low to access the Anthropic API."))).toBe("claude_no_credit");
    expect(claudeFailure(api(403, "Your credit balance is too low"))).toBe("claude_no_credit");
  });

  it("names Claude being busy, rate-limited or down (429, 5xx)", () => {
    for (const s of [429, 500, 503, 529]) expect(claudeFailure(api(s))).toBe("claude_busy");
  });

  it("leaves everything else alone", () => {
    expect(claudeFailure(api(400))).toBeNull();
    expect(claudeFailure(new Error("postgres://u:pw@h"))).toBeNull();
    expect(claudeFailure(Object.assign(new Error("x"), { status: "401" }))).toBeNull();
    expect(claudeFailure(null)).toBeNull();
    expect(claudeFailure("boom")).toBeNull();
  });
});

describe("claudeFailureResponse", () => {
  it("answers 409 with the reason for an account problem, never 401, never the message", async () => {
    for (const [err, reason] of [
      [new NotConnected("Claude key"), "claude_key_missing"],
      [api(401), "claude_key_rejected"],
      [api(402), "claude_no_credit"],
    ] as const) {
      const res = claudeFailureResponse(err);
      expect(res?.status).toBe(409);
      expect(await res?.json()).toEqual({ error: reason });
    }
  });

  it("answers 503 for a busy Claude", async () => {
    const res = claudeFailureResponse(api(529));
    expect(res?.status).toBe(503);
    expect(await res?.json()).toEqual({ error: "claude_busy" });
  });

  it("answers null when Claude is not the named problem", () => {
    expect(claudeFailureResponse(new Error("x"))).toBeNull();
  });
});
