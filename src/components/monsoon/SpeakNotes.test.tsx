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
const RESULT = { fields: { ...FIELDS, title: "CIO" }, notes: "Now CIO." };

let onApply: ReturnType<typeof vi.fn>;
let onUnauthorized: ReturnType<typeof vi.fn>;
let lastDraft = "";

// The parent owns the draft, so the harness does too.
function Harness({ initial = "" }: { initial?: string }) {
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
    />
  );
}

async function openIt(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Speak notes" }));
}

beforeEach(() => {
  vi.resetAllMocks();
  onApply = vi.fn();
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
    await waitFor(() => expect(onApply).toHaveBeenCalledWith(RESULT));
    expect(m.refineCard).toHaveBeenCalledWith({ fields: FIELDS, notes: "met at demo", spoken: "she is CIO" });
    expect(lastDraft).toBe("");
    expect(screen.getByRole("button", { name: "Speak notes" })).toBeInTheDocument();
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
    expect(onApply).toHaveBeenCalledWith({ fields: FIELDS, notes: "met at demo\ncall her" });
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
});
