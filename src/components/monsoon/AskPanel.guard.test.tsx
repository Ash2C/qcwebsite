// @vitest-environment jsdom
import React, { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AskPanel, { type AskState } from "./AskPanel";
import * as api from "./api";

vi.mock("./api", () => ({ askCrm: vi.fn(), actOnCrm: vi.fn() }));
// A stand-in card whose buttons are always live, to prove the panel itself refuses a finished card.
vi.mock("./ChangeCard", () => ({
  describeChange: () => "a change",
  default: ({
    card,
    onConfirm,
    onCancel,
  }: {
    card: { id: string };
    onConfirm: () => void;
    onCancel: () => void;
  }) => (
    <div>
      <button type="button" onClick={onConfirm}>{`confirm ${card.id}`}</button>
      <button type="button" onClick={onCancel}>{`cancel ${card.id}`}</button>
    </div>
  ),
}));
const m = vi.mocked(api);
const ESTATE = { key: "traxo", label: "Traxo", defaultRole: "x", available: true, todos: true, roles: [] };
const signed = {
  proposal: {
    kind: "add_note",
    estate: "traxo",
    memberId: "m",
    memberKind: "person",
    memberName: "J",
    company: null,
    about: null,
    expires: 1,
  },
  signature: "s",
} as never;

function Harness({ initial }: { initial: AskState }) {
  const [state, setState] = useState(initial);
  return (
    <>
      <AskPanel estate={ESTATE} state={state} onChange={setState} onUnauthorized={() => {}} />
      <output data-testid="n">{state.turns.length}</output>
    </>
  );
}

function withCard(state: "open" | "working" | "done" | "cancelled" | "failed"): AskState {
  return {
    turns: [{ id: "a", role: "assistant", content: "x", cards: [{ id: "c", signed, text: "t", state }] }],
    draft: "",
  };
}

beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe("AskPanel finished-card guard", () => {
  it.each(["done", "cancelled", "failed", "working"] as const)(
    "ignores confirm and cancel on a %s card",
    async (st) => {
      const user = userEvent.setup();
      render(<Harness initial={withCard(st)} />);
      await user.click(screen.getByRole("button", { name: "confirm c" }));
      await user.click(screen.getByRole("button", { name: "cancel c" }));
      expect(m.actOnCrm).not.toHaveBeenCalled();
      expect(screen.getByTestId("n")).toHaveTextContent("1");
    },
  );

  it("still acts on an open card", async () => {
    const user = userEvent.setup();
    m.actOnCrm.mockResolvedValue({ status: 200, body: { status: "ok", message: "m" } });
    render(<Harness initial={withCard("open")} />);
    await user.click(screen.getByRole("button", { name: "confirm c" }));
    await waitFor(() => expect(m.actOnCrm).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("n")).toHaveTextContent("2"));
  });
});
