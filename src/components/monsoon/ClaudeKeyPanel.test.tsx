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

describe("ClaudeKeyPanel on the free trial", () => {
  const NONE = { status: "missing" as const, last4: null, checkedAt: null, setAt: null, setBy: null, keyPerson: "Gil Hale", canChange: true };
  const TRIAL = { ...NONE, status: "trial" as const, daysLeft: 9, usesLeft: 112 };
  const PAUSED = "The free trial is paused. Add your own Claude key, or try again later.";

  it("says how much of the trial is left, shows no key rows and no Test again, and tells the chip", async () => {
    m.loadClaudeKey.mockResolvedValue(reply(TRIAL));
    view();
    expect(await screen.findByText("Free trial")).toHaveAttribute("role", "status");
    expect(screen.getByText("9 days and 112 AI uses left. Add your own Claude key any time to keep going after the trial.")).toBeInTheDocument();
    expect(onStatus).toHaveBeenCalledWith("trial");
    expect(screen.queryByText(/sk-ant-…/)).toBeNull();
    expect(screen.queryByText("Key")).toBeNull();
    expect(screen.queryByText("Last checked")).toBeNull();
    expect(screen.queryByRole("button", { name: "Test again" })).toBeNull();
    // Everything works on the trial: nothing is said to be off.
    expect(screen.queryByText(/are off until a key works/)).toBeNull();
    expect(screen.getByLabelText("Claude API key")).toBeInTheDocument();
  });

  it("uses the singular for one day and one use", async () => {
    m.loadClaudeKey.mockResolvedValue(reply({ ...TRIAL, daysLeft: 1, usesLeft: 1 }));
    view();
    expect(await screen.findByText(/^1 day and 1 AI use left\. /)).toBeInTheDocument();
    cleanup();
    m.loadClaudeKey.mockResolvedValue(reply({ ...TRIAL, daysLeft: 2, usesLeft: 1 }));
    view();
    expect(await screen.findByText(/^2 days and 1 AI use left\. /)).toBeInTheDocument();
  });

  it("says the trial is paused while the trial key is failing", async () => {
    m.loadClaudeKey.mockResolvedValue(reply({ ...TRIAL, paused: true }));
    view();
    expect(await screen.findByText(PAUSED)).toBeInTheDocument();
    expect(screen.getByText("Free trial")).toHaveAttribute("role", "status");
    expect(screen.queryByText(/AI uses left/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Test again" })).toBeNull();
  });

  it("says the trial ended, and that typing and saving still work", async () => {
    m.loadClaudeKey.mockResolvedValue(reply({ ...NONE, trialEnded: true }));
    view();
    expect(await screen.findByText("Trial ended")).toHaveAttribute("role", "status");
    expect(screen.getByText("Add your own Claude key to keep the AI features. Typing and saving contacts still works.")).toBeInTheDocument();
    expect(screen.queryByText("This account has no Claude API key yet.")).toBeNull();
    expect(onStatus).toHaveBeenCalledWith("missing");
    expect(screen.getByLabelText("Claude API key")).toBeInTheDocument();
  });

  it("saving an own key during the trial ends it on screen", async () => {
    const user = userEvent.setup();
    m.loadClaudeKey.mockResolvedValue(reply(TRIAL));
    m.saveClaudeKey.mockResolvedValue(reply(OK));
    view();
    await user.type(await screen.findByLabelText("Claude API key"), "sk-ant-my-own-key");
    await user.click(screen.getByRole("button", { name: "Test and save" }));
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.queryByText("Free trial")).toBeNull();
    expect(onStatus).toHaveBeenLastCalledWith("ok");
  });
});

describe("ClaudeKeyPanel: getting and pasting a key on a phone", () => {
  const HELP = "Tap Get a key, sign in to the Claude Console, create a key and copy it. Come back and tap Paste.";
  const COULD_NOT = "Could not paste. Press and hold in the box, then choose Paste.";
  const PASTED = "sk-ant-api03-PASTEDKEY-0123456789-pppp";
  const NONE = { status: "missing" as const, last4: null, checkedAt: null, setAt: null, setBy: null, keyPerson: "Gil Hale", canChange: true };

  /** Stands in for the browser's clipboard. Set after userEvent.setup(), which installs its own. */
  function clipboard(value: unknown): void {
    Object.defineProperty(navigator, "clipboard", { value, configurable: true });
  }
  afterEach(() => clipboard(undefined));

  it("Get a key opens the Claude Console keys page in a new tab", async () => {
    m.loadClaudeKey.mockResolvedValue(reply(NONE));
    view();
    const link = await screen.findByRole("link", { name: "Get a key" });
    expect(link).toHaveAttribute("href", "https://console.anthropic.com/settings/keys");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText((text) => text.startsWith(HELP))).toBeInTheDocument();
    expect(screen.queryByText(/under API keys, then paste it here/)).toBeNull();
  });

  it("Paste fills the box from the clipboard, without showing the key anywhere", async () => {
    const user = userEvent.setup();
    const readText = vi.fn(async () => `  ${PASTED}\n`);
    clipboard({ readText });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    m.loadClaudeKey.mockResolvedValue(reply(NONE));
    m.saveClaudeKey.mockResolvedValue(reply(OK));
    view();
    const box = await screen.findByLabelText("Claude API key");
    await user.click(screen.getByRole("button", { name: "Paste" }));
    await waitFor(() => expect(box).toHaveValue(PASTED));
    expect(box).toHaveAttribute("type", "password");
    expect(document.body.textContent).not.toContain(PASTED);
    expect(JSON.stringify([...log.mock.calls, ...error.mock.calls])).not.toContain(PASTED);
    expect(screen.queryByText(COULD_NOT)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Test and save" }));
    await waitFor(() => expect(m.saveClaudeKey).toHaveBeenCalledWith(PASTED));
  });

  it("says how to paste by hand, and puts the cursor in the box, when the browser refuses or the clipboard is empty", async () => {
    const user = userEvent.setup();
    m.loadClaudeKey.mockResolvedValue(reply(NONE));
    for (const readText of [vi.fn(async () => Promise.reject(new Error("NotAllowedError"))), vi.fn(async () => "   ")]) {
      clipboard({ readText });
      view();
      const box = await screen.findByLabelText("Claude API key");
      await user.click(screen.getByRole("button", { name: "Paste" }));
      expect(await screen.findByText(COULD_NOT)).toHaveAttribute("role", "alert");
      expect(box).toHaveValue("");
      expect(box).toHaveFocus();
      cleanup();
    }
  });

  it("shows no Paste button where the browser cannot read the clipboard", async () => {
    m.loadClaudeKey.mockResolvedValue(reply(NONE));
    for (const value of [undefined, {}]) {
      clipboard(value);
      view();
      expect(await screen.findByRole("link", { name: "Get a key" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Paste" })).toBeNull();
      cleanup();
    }
  });

  it("someone who cannot change the key gets neither button", async () => {
    clipboard({ readText: vi.fn() });
    m.loadClaudeKey.mockResolvedValue(reply({ ...NONE, canChange: false }));
    view();
    expect(await screen.findByText("Only Gil Hale can change the key.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Get a key" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Paste" })).toBeNull();
  });
});
