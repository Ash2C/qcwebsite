import { describe, expect, it } from "vitest";
import { claudeFailureText } from "./claudeFailure";

describe("claudeFailureText", () => {
  it("says which Claude problem stopped the feature", () => {
    expect(claudeFailureText({ error: "claude_key_missing" }, "Photos cannot be read")).toBe(
      "Photos cannot be read yet: this account has no Claude API key. Add it with your Monsoon setup link.",
    );
    expect(claudeFailureText({ error: "claude_key_rejected" }, "Ask is not available")).toBe(
      "Ask is not available: Claude did not accept this account's API key. It may have expired, been revoked or lack permission.",
    );
    expect(claudeFailureText({ error: "claude_no_credit" }, "Research cannot run")).toBe(
      "Research cannot run: this account's Claude API key is out of credit. Add credit in the Claude Console.",
    );
    expect(claudeFailureText({ error: "claude_busy" }, "Notes cannot be tidied")).toBe(
      "Notes cannot be tidied right now: Claude is busy or this account's rate limit was reached. Try again in a minute.",
    );
  });

  it("says the free trial is paused in those words, whatever was being done", () => {
    for (const lead of ["Photos cannot be read", "Ask is not available"]) {
      expect(claudeFailureText({ error: "claude_trial_paused" }, lead)).toBe("The free trial is paused. Add your own Claude key, or try again later.");
    }
  });

  it("answers null for any other body", () => {
    expect(claudeFailureText({ error: "Could not read the photo" }, "X")).toBeNull();
    expect(claudeFailureText(null, "X")).toBeNull();
    expect(claudeFailureText({ cards: [] }, "X")).toBeNull();
    expect(claudeFailureText({ error: 5 }, "X")).toBeNull();
  });
});
