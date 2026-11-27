// @vitest-environment jsdom
import React, { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SpeakNotes from "./SpeakNotes";
import * as api from "./api";

vi.mock("./api", () => ({ refineCard: vi.fn() }));
const m = vi.mocked(api);

const FIELDS = { name: "Jane Tan", title: "", org: "Acme", email: "", phone: "", linkedin: "" };
const RESULT = { fields: { ...FIELDS, title: "CIO" }, notes: "Now CIO.", todos: [] };

let onApply: ReturnType<typeof vi.fn>;
let onBusy: ReturnType<typeof vi.fn>;
let onUnauthorized: ReturnType<typeof vi.fn>;
let lastDraft = "";

// The parent owns the draft, so the harness does too.
function Harness({ initial = "", disabled }: { initial?: string; disabled?: boolean }) {
  const [draft, setDraft] = useState(initial);
  lastDraft = draft;
  return (
    <SpeakNotes
      fields={FIELDS}
      notes="met at demo"
      draft={draft}
      onDraft={setDraft}
      onApply={onApply as never}
      onUnauthorized={onUnauthorized as never}
      onBusy={onBusy as never}
      disabled={disabled}
    />
  );
}

async function openIt(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Speak notes" }));
}

beforeEach(() => {
  vi.resetAllMocks();
  onApply = vi.fn();
  onBusy = vi.fn();
  onUnauthorized = vi.fn();
  lastDraft = "";
});
afterEach(cleanup);

describe("SpeakNotes", () => {
  it("opens on click with the textarea focused", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await openIt(user);
    const box = screen.getByPlaceholderText("Tap the microphone on the keyboard and talk");
    expect(box).toHaveFocus();
  });

  it("Apply is disabled while the draft is blank", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await openIt(user);
    const apply = screen.getByRole("button", { name: "Apply" });
    expect(apply).toBeDisabled();
    await user.type(screen.getByRole("textbox"), "   ");
    expect(apply).toBeDisabled();
    await user.type(screen.getByRole("textbox"), "hello");
    expect(apply).toBeEnabled();
  });

  it("success calls onApply with the result, clears the draft and closes", async () => {
    const user = userEvent.setup();
    m.refineCard.mockResolvedValue({ status: 200, body: RESULT });
    render(<Harness />);
    await openIt(user);
    await user.type(screen.getByRole("textbox"), "she is CIO");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledWith(RESULT, { fields: FIELDS, notes: "met at demo" }));
    expect(m.refineCard).toHaveBeenCalledWith({ fields: FIELDS, notes: "met at demo", spoken: "she is CIO" });
    expect(lastDraft).toBe("");
    expect(screen.getByRole("button", { name: "Speak notes" })).toBeInTheDocument();
  });

  it("hands the offered to-dos on with the result, and Use as typed offers none", async () => {
    const user = userEvent.setup();
    const todos = [{ title: "Send the deck", due: "2026-11-27" }];
    m.refineCard.mockResolvedValueOnce({ status: 200, body: { ...RESULT, todos } });
    render(<Harness />);
    await openIt(user);
    await user.type(screen.getByRole("textbox"), "send the deck on Friday");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(onApply.mock.calls[0][0].todos).toEqual(todos);
    m.refineCard.mockRejectedValueOnce(new Error("down"));
    await openIt(user);
    await user.type(screen.getByRole("textbox"), "again");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await user.click(await screen.findByRole("button", { name: "Use as typed" }));
    expect(onApply.mock.calls[1][0].todos).toEqual([]);
  });

  it("Cancel closes and keeps the draft", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await openIt(user);
    await user.type(screen.getByRole("textbox"), "keep me");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(lastDraft).toBe("keep me");
    await openIt(user);
    expect(screen.getByRole("textbox")).toHaveValue("keep me");
  });

  it("a 401 calls onUnauthorized and keeps the draft", async () => {
    const user = userEvent.setup();
    m.refineCard.mockResolvedValue({ status: 401, body: { error: "unauthorized" } });
    render(<Harness />);
    await openIt(user);
    await user.type(screen.getByRole("textbox"), "keep me");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
    expect(onApply).not.toHaveBeenCalled();
    expect(lastDraft).toBe("keep me");
  });

  it("a Claude problem names the problem", async () => {
    const user = userEvent.setup();
    m.refineCard.mockResolvedValue({ status: 409, body: { error: "claude_no_credit" } });
    render(<Harness />);
    await openIt(user);
    await user.type(screen.getByRole("textbox"), "call her");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(
      await screen.findByText(
        "Notes cannot be tidied: this account's Claude API key is out of credit. Add credit in the Claude Console.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use as typed" })).toBeInTheDocument();
  });

  it("a 502 shows the error and Use as typed applies notes plus the draft", async () => {
    const user = userEvent.setup();
    m.refineCard.mockResolvedValue({ status: 502, body: { error: "Could not tidy the notes" } });
    render(<Harness />);
    await openIt(user);
    await user.type(screen.getByRole("textbox"), "call her");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText("Could not tidy the notes.")).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Use as typed" }));
    expect(onApply).toHaveBeenCalledWith(
      { fields: FIELDS, notes: "met at demo\ncall her", todos: [] },
      { fields: FIELDS, notes: "met at demo" },
    );
    expect(lastDraft).toBe("");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("a network error is treated like a failure", async () => {
    const user = userEvent.setup();
    m.refineCard.mockRejectedValue(new Error("offline"));
    render(<Harness />);
    await openIt(user);
    await user.type(screen.getByRole("textbox"), "x");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText("Could not tidy the notes.")).toBeInTheDocument();
  });

  it("a timed-out or failed request releases the busy report and Apply works again", async () => {
    const user = userEvent.setup();
    m.refineCard.mockRejectedValueOnce(new DOMException("The operation timed out.", "TimeoutError"));
    render(<Harness />);
    await openIt(user);
    await user.type(screen.getByRole("textbox"), "x");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText("Could not tidy the notes.")).toBeInTheDocument();
    expect(onBusy.mock.calls.map((c) => c[0])).toEqual([true, false]);
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
    m.refineCard.mockResolvedValueOnce({ status: 200, body: RESULT } as never);
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
  });

  it("Apply cannot be double-submitted", async () => {
    const user = userEvent.setup();
    let resolve!: (v: never) => void;
    m.refineCard.mockImplementation(() => new Promise((r) => (resolve = r as never)));
    render(<Harness />);
    await openIt(user);
    await user.type(screen.getByRole("textbox"), "x");
    const apply = screen.getByRole("button", { name: "Apply" });
    await user.click(apply);
    await user.click(screen.getByRole("button", { name: "Tidying…" }));
    expect(m.refineCard).toHaveBeenCalledTimes(1);
    resolve({ status: 200, body: RESULT } as never);
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
  });

  it("reports busy while the request runs, and again false when it ends", async () => {
    const user = userEvent.setup();
    let resolve!: (v: never) => void;
    m.refineCard.mockImplementation(() => new Promise((r) => (resolve = r as never)));
    render(<Harness />);
    await openIt(user);
    await user.type(screen.getByRole("textbox"), "x");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onBusy.mock.calls).toEqual([[true]]);
    resolve({ status: 200, body: RESULT } as never);
    await waitFor(() => expect(onBusy.mock.calls).toEqual([[true], [false]]));
    // onApply ran before the lock was released.
    expect(onApply.mock.invocationCallOrder[0]).toBeLessThan(onBusy.mock.invocationCallOrder[1]);
  });

  it("reports busy false after a 401", async () => {
    const user = userEvent.setup();
    m.refineCard.mockResolvedValue({ status: 401, body: { error: "unauthorized" } });
    render(<Harness />);
    await openIt(user);
    await user.type(screen.getByRole("textbox"), "x");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(onBusy.mock.calls).toEqual([[true], [false]]));
  });

  it("is disabled when told so", () => {
    render(
      <SpeakNotes
        fields={FIELDS}
        notes=""
        draft=""
        onDraft={() => {}}
        onApply={() => {}}
        onUnauthorized={() => {}}
        disabled
      />,
    );
    expect(screen.getByRole("button", { name: "Speak notes" })).toBeDisabled();
  });

  it("Use as typed honours the disabled prop", async () => {
    const user = userEvent.setup();
    m.refineCard.mockResolvedValue({ status: 502, body: { error: "Could not tidy the notes" } });
    const view = render(<Harness />);
    await openIt(user);
    await user.type(screen.getByRole("textbox"), "call her");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByRole("button", { name: "Use as typed" });
    view.rerender(<Harness disabled />);
    const typed = screen.getByRole("button", { name: "Use as typed" });
    expect(typed).toBeDisabled();
    await user.click(typed);
    expect(onApply).not.toHaveBeenCalled();
    expect(onBusy.mock.calls).toEqual([[true], [false]]);
  });

  it("limits the textarea to 4000 characters", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await openIt(user);
    expect(screen.getByRole("textbox")).toHaveAttribute("maxlength", "4000");
  });

  it("a 400 shows the server's error instead of the generic text, and Use as typed is still offered", async () => {
    const user = userEvent.setup();
    m.refineCard.mockResolvedValue({ status: 400, body: { error: "Spoken notes are too long" } });
    render(<Harness />);
    await openIt(user);
    await user.type(screen.getByRole("textbox"), "x");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText("Spoken notes are too long")).toBeInTheDocument();
    expect(screen.queryByText("Could not tidy the notes.")).toBeNull();
    expect(screen.getByRole("button", { name: "Use as typed" })).toBeEnabled();
  });
});
