// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import ClaudeKeyPanel, { formatWhen } from "./ClaudeKeyPanel";

vi.mock("./api", () => ({ loadClaudeKey: vi.fn(), saveClaudeKey: vi.fn(), testClaudeKey: vi.fn() }));
const m = vi.mocked(api);

const OK = {
  status: "ok" as const,
  last4: "4f2A",
  checkedAt: "2026-11-20T09:00:00Z",
  setAt: "2026-11-19T09:00:00Z",
  setBy: "Brett Miller",
  keyPerson: "Brett Miller",
  canChange: true,
};
const reply = (key: object) => ({ status: 200, body: { key } }) as never;

let onBack: ReturnType<typeof vi.fn>;
let onUnauthorized: ReturnType<typeof vi.fn>;
let onStatus: ReturnType<typeof vi.fn>;
function view() {
  render(<ClaudeKeyPanel onBack={onBack} onUnauthorized={onUnauthorized} onStatus={onStatus} />);
}

beforeEach(() => {
  vi.resetAllMocks();
  onBack = vi.fn();
  onUnauthorized = vi.fn();
  onStatus = vi.fn();
});
afterEach(cleanup);

describe("formatWhen", () => {
  it("gives the time for today and the date otherwise", () => {
    const now = new Date(2026, 10, 23, 23, 0);
    expect(formatWhen(new Date(2026, 10, 23, 22, 41).toISOString(), now)).toBe("Today, 22:41");
    expect(formatWhen(new Date(2026, 10, 19, 9, 0).toISOString(), now)).toBe("19 Nov 2026");
    expect(formatWhen("nonsense", now)).toBe("");
  });
});

describe("ClaudeKeyPanel", () => {
  it("shows a connected key by its last four characters and tells the chip", async () => {
    m.loadClaudeKey.mockResolvedValue(reply(OK));
    view();
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("sk-ant-…4f2A")).toBeInTheDocument();
    expect(screen.getByText("19 Nov 2026 by Brett Miller")).toBeInTheDocument();
    expect(onStatus).toHaveBeenCalledWith("ok");
    expect(screen.getByLabelText("New Claude API key")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Test and save" })).toBeDisabled();
  });

  it("says what is off when the key is refused, and when there is none", async () => {
    m.loadClaudeKey.mockResolvedValue(reply({ ...OK, status: "key_rejected" }));
    view();
    expect(await screen.findByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText(/Claude did not accept the key on file/)).toBeInTheDocument();
    expect(screen.getByText(/are off until a key works/)).toBeInTheDocument();
    cleanup();

    m.loadClaudeKey.mockResolvedValue(reply({ ...OK, status: "missing", last4: null, setAt: null, checkedAt: null }));
    view();
    expect(await screen.findByText("This account has no Claude API key yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Test again" })).toBeNull();
    expect(screen.getByLabelText("Claude API key")).toBeInTheDocument();
  });

  it("someone who is not the key person sees who is, and no key field", async () => {
    m.loadClaudeKey.mockResolvedValue(reply({ ...OK, canChange: false }));
    view();
    expect(await screen.findByText("Only Brett Miller can change the key.")).toBeInTheDocument();
    expect(screen.queryByLabelText("New Claude API key")).toBeNull();
    expect(screen.getByRole("button", { name: "Test again" })).toBeEnabled();
  });

  it("saves a new key, clears the field and shows the new state", async () => {
    const user = userEvent.setup();
    m.loadClaudeKey.mockResolvedValue(reply({ ...OK, status: "key_rejected" }));
    m.saveClaudeKey.mockResolvedValue(reply({ ...OK, last4: "9zzQ" }));
    view();
    await user.type(await screen.findByLabelText("New Claude API key"), " sk-ant-new-key ");
    await user.click(screen.getByRole("button", { name: "Test and save" }));
    expect(await screen.findByText("Saved. Claude accepted the new key.")).toBeInTheDocument();
    expect(m.saveClaudeKey).toHaveBeenCalledWith("sk-ant-new-key");
    expect(screen.getByText("sk-ant-…9zzQ")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByLabelText("New Claude API key")).toHaveValue("");
    expect(onStatus).toHaveBeenLastCalledWith("ok");
  });

  it("keeps the typed key and says why when Claude refuses it, it has no credit, or Claude is busy", async () => {
    const user = userEvent.setup();
    m.loadClaudeKey.mockResolvedValue(reply(OK));
    view();
    await user.type(await screen.findByLabelText("New Claude API key"), "sk-ant-bad");
    const save = screen.getByRole("button", { name: "Test and save" });

    m.saveClaudeKey.mockResolvedValue({ status: 422, body: { error: "claude_key_rejected" } });
    await user.click(save);
    expect(await screen.findByText("Claude did not accept this key. Check you copied all of it, then try again.")).toBeInTheDocument();
    expect(screen.getByLabelText("New Claude API key")).toHaveValue("sk-ant-bad");
    expect(screen.getByText("Connected")).toBeInTheDocument();

    m.saveClaudeKey.mockResolvedValue({ status: 422, body: { error: "claude_no_credit" } });
    await user.click(save);
    expect(await screen.findByText(/out of credit, so it was not saved/)).toBeInTheDocument();

    m.saveClaudeKey.mockResolvedValue({ status: 503, body: { error: "claude_busy" } });
    await user.click(save);
    expect(await screen.findByText("Claude could not be reached to test the key. Try again in a minute.")).toBeInTheDocument();

    m.saveClaudeKey.mockRejectedValue(new Error("net"));
    await user.click(save);
    expect(await screen.findByText("Could not save. Check signal and try again.")).toBeInTheDocument();
  });

  it("Test again shows the fresh result, or says Claude is busy", async () => {
    const user = userEvent.setup();
    m.loadClaudeKey.mockResolvedValue(reply(OK));
    view();
    const again = await screen.findByRole("button", { name: "Test again" });
    m.testClaudeKey.mockResolvedValue({ status: 503, body: { error: "claude_busy" } });
    await user.click(again);
    expect(await screen.findByText("Claude could not be reached to test the key. Try again in a minute.")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();

    m.testClaudeKey.mockResolvedValue(reply({ ...OK, status: "no_credit" }));
    await user.click(again);
    expect(await screen.findByText("Out of credit")).toBeInTheDocument();
    expect(onStatus).toHaveBeenLastCalledWith("no_credit");
  });

  it("goes to sign-in on a 401, offers Retry when loading fails, and Back goes back", async () => {
    const user = userEvent.setup();
    m.loadClaudeKey.mockResolvedValueOnce({ status: 401, body: { error: "unauthorized" } });
    view();
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    cleanup();

    m.loadClaudeKey.mockRejectedValueOnce(new Error("net"));
    view();
    expect(await screen.findByText("Could not load. Check signal.")).toBeInTheDocument();
    m.loadClaudeKey.mockResolvedValue(reply(OK));
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
