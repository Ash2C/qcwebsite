// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ClaudeChip from "./ClaudeChip";
import { claudeStatusOf, nextChipStatus } from "./claudeStatus";

afterEach(cleanup);

describe("ClaudeChip", () => {
  it("says Free trial on the trial, looking as a connected key does", () => {
    render(<ClaudeChip status="trial" onClick={vi.fn()} />);
    const trial = screen.getByRole("button", { name: "Free trial" });
    const look = trial.className;
    cleanup();
    render(<ClaudeChip status="ok" onClick={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Connected" }).className).toBe(look);
  });

  it("keeps its other labels", () => {
    for (const [status, label] of [["missing", "Key needed"], ["key_rejected", "Key refused"], ["no_credit", "Out of credit"], [null, "API key"]] as const) {
      render(<ClaudeChip status={status} onClick={vi.fn()} />);
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
      cleanup();
    }
  });
});

describe("the chip while on the free trial", () => {
  it("stays Free trial when a call works, and changes when a call names a problem", () => {
    expect(nextChipStatus("trial", "ok")).toBe("trial");
    // The trial ran out during this visit: the next call finds no key.
    expect(nextChipStatus("trial", "missing")).toBe("missing");
    expect(nextChipStatus("ok", "no_credit")).toBe("no_credit");
    expect(nextChipStatus("missing", "ok")).toBe("ok");
    expect(nextChipStatus(null, "ok")).toBe("ok");
  });

  it("a paused trial says nothing about the person's own key", () => {
    expect(claudeStatusOf({ status: 409, body: { error: "claude_trial_paused" } })).toBeNull();
  });
});
