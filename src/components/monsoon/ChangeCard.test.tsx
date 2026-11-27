// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Proposal } from "@/lib/monsoon/ask/proposal";
import ChangeCard, { describeChange } from "./ChangeCard";
import type { AskCard } from "./useCardConfirm";

afterEach(cleanup);

const ID = "11111111-1111-4111-8111-111111111111";
const base = { customer: "c0000000-0000-4000-8000-00000000000a", estate: "main", expires: 1 };

function card(proposal: Proposal, state: AskCard["state"] = "open"): AskCard {
  return { id: "k1", signed: { proposal, signature: "s".repeat(64) }, text: "", state };
}
function show(proposal: Proposal) {
  render(<ChangeCard card={card(proposal)} onText={vi.fn()} onConfirm={vi.fn()} onCancel={vi.fn()} />);
}

describe("to-do change cards", () => {
  it("add shows the title, the date or No date, and the contact", () => {
    show({
      kind: "add_todo", ...base, title: "Send deck", dueDate: "2026-12-01", memberId: ID, memberKind: "company",
      memberName: "Raffles", company: null, aboutPersonId: ID, about: "Mia Chen",
    });
    expect(screen.getByText("Add to-do")).toBeInTheDocument();
    expect(screen.getByText("Send deck")).toBeInTheDocument();
    expect(screen.getByText("2026-12-01")).toBeInTheDocument();
    expect(screen.getByText("Mia Chen (Raffles)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeEnabled();
    cleanup();
    show({
      kind: "add_todo", ...base, title: "Renew", dueDate: null, memberId: null, memberKind: null,
      memberName: null, company: null, aboutPersonId: null, about: null,
    });
    expect(screen.getByText("No date")).toBeInTheDocument();
  });

  it("tick off shows the outcome when given", () => {
    show({ kind: "complete_todo", ...base, todoId: ID, title: "Send deck", memberName: "Mia Chen", outcome: "Sent, she liked it" });
    expect(screen.getByText("Tick off to-do")).toBeInTheDocument();
    expect(screen.getByText("Mia Chen")).toBeInTheDocument();
    expect(screen.getByText("Sent, she liked it")).toBeInTheDocument();
  });

  it("move shows the old and new date, and No date for a cleared one", () => {
    show({ kind: "move_todo", ...base, todoId: ID, title: "Send deck", memberName: null, fromDate: "2026-12-01", toDate: null });
    expect(screen.getByText("Move to-do")).toBeInTheDocument();
    expect(screen.getByText("2026-12-01 → No date")).toBeInTheDocument();
  });

  it("drop names the to-do", () => {
    show({ kind: "drop_todo", ...base, todoId: ID, title: "Send deck", memberName: "Mia Chen" });
    expect(screen.getByText("Drop to-do")).toBeInTheDocument();
    expect(screen.getByText("Send deck")).toBeInTheDocument();
  });

  it("describes each change in one line for the model's history", () => {
    const todo = { ...base, todoId: ID, title: "Send deck", memberName: null };
    expect(describeChange(card({ kind: "drop_todo", ...todo }))).toBe('drop the to-do "Send deck"');
    expect(describeChange(card({ kind: "move_todo", ...todo, fromDate: null, toDate: "2026-12-01" }))).toBe('move the to-do "Send deck"');
    expect(describeChange(card({ kind: "complete_todo", ...todo, outcome: null }))).toBe('tick off the to-do "Send deck"');
  });
});
