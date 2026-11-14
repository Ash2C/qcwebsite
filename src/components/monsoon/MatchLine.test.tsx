// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CardMatch, MatchCandidate } from "@/lib/monsoon/match";
import MatchLine from "./MatchLine";

afterEach(cleanup);

const JANE: MatchCandidate = {
  personId: "p1",
  name: "Jane Tan",
  title: "Partner",
  company: "Acme Capital",
  email: null,
  member: { memberId: "m1", memberKind: "person", role: "lp_prospect", stage: "warm_intro" },
  memberOf: "self",
  by: "name_company",
};
const JANE_2: MatchCandidate = { ...JANE, personId: "p2", company: null, member: null, memberOf: null, by: "name" };

function setup(match: CardMatch, choice: Parameters<typeof MatchLine>[0]["choice"] = null, disabled = false) {
  const onChoose = vi.fn();
  const onOpen = vi.fn();
  render(<MatchLine match={match} choice={choice} onChoose={onChoose} onOpen={onOpen} disabled={disabled} />);
  return { onChoose, onOpen, user: userEvent.setup() };
}

describe("MatchLine", () => {
  it("none: one quiet line and no buttons", () => {
    setup({ match: "none", candidates: [] });
    expect(screen.getByText("New contact")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("exact: names the person, shows where they stand, offers three buttons", () => {
    setup({ match: "exact", candidates: [JANE] });
    expect(screen.getByText("Already on file: Jane Tan, Acme Capital")).toBeInTheDocument();
    expect(screen.getByText("lp prospect · Warm intro")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open profile" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add what's new" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Different person" })).toBeInTheDocument();
  });

  it("same_name without a company says no company and has no second line", () => {
    setup({ match: "same_name", candidates: [JANE_2] });
    expect(screen.getByText("Already on file: Jane Tan, no company")).toBeInTheDocument();
    expect(screen.queryByText(/·/)).toBeNull();
  });

  it("a person filed under a company gets a filed-under line", () => {
    setup({ match: "same_name", candidates: [{ ...JANE, member: null, memberOf: "company" }] });
    expect(screen.getByText("filed under Acme Capital")).toBeInTheDocument();
  });

  it("shows the chosen button as selected", () => {
    setup({ match: "exact", candidates: [JANE] }, { samePerson: "p1" });
    expect(screen.getByRole("button", { name: "Add what's new" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Different person" })).toHaveAttribute("aria-pressed", "false");
  });

  it("shows Different person as selected for false", () => {
    setup({ match: "exact", candidates: [JANE] }, { samePerson: false });
    expect(screen.getByRole("button", { name: "Different person" })).toHaveAttribute("aria-pressed", "true");
  });

  it("calls back with the choice and the person to open", async () => {
    const { user, onChoose, onOpen } = setup({ match: "exact", candidates: [JANE] });
    await user.click(screen.getByRole("button", { name: "Add what's new" }));
    expect(onChoose).toHaveBeenLastCalledWith({ samePerson: "p1" });
    await user.click(screen.getByRole("button", { name: "Different person" }));
    expect(onChoose).toHaveBeenLastCalledWith({ samePerson: false });
    await user.click(screen.getByRole("button", { name: "Open profile" }));
    expect(onOpen).toHaveBeenCalledWith("p1");
  });

  it("several: one row per candidate with This one and Open, and None of these", async () => {
    const { user, onChoose, onOpen } = setup({ match: "several", candidates: [JANE, JANE_2] }, { samePerson: "p2" });
    expect(screen.getByText("Possible matches")).toBeInTheDocument();
    const first = screen.getByRole("group", { name: "Jane Tan, Acme Capital" });
    const second = screen.getByRole("group", { name: "Jane Tan, no company" });
    expect(within(second).getByRole("button", { name: "This one" })).toHaveAttribute("aria-pressed", "true");
    expect(within(first).getByRole("button", { name: "This one" })).toHaveAttribute("aria-pressed", "false");
    await user.click(within(first).getByRole("button", { name: "This one" }));
    expect(onChoose).toHaveBeenLastCalledWith({ samePerson: "p1" });
    await user.click(within(second).getByRole("button", { name: "Open" }));
    expect(onOpen).toHaveBeenCalledWith("p2");
    await user.click(screen.getByRole("button", { name: "None of these" }));
    expect(onChoose).toHaveBeenLastCalledWith({ samePerson: false });
  });

  it("disables every button of a list of matches when disabled", () => {
    setup({ match: "several", candidates: [JANE, JANE_2] }, null, true);
    for (const b of screen.getAllByRole("button")) expect(b).toBeDisabled();
  });

  it("disables the three buttons of a single match when disabled", () => {
    setup({ match: "exact", candidates: [JANE] }, null, true);
    for (const b of screen.getAllByRole("button")) expect(b).toBeDisabled();
  });
});
