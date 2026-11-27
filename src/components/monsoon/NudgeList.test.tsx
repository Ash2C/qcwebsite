// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import NudgeList from "./NudgeList";
import type { Nudge, Nudges } from "./api";

const contact = (over: Record<string, unknown> = {}) => ({
  memberId: "m1", memberKind: "person" as const, name: "Dana Cho", company: "Acme", personId: "p1", orgId: null,
  aboutPersonId: null, aboutName: null, stage: "proposal_sent", stageLabel: "Proposal sent", priority: null, lastAction: null, ...over,
});
const none = (c = contact()): Nudge => ({ kind: "no_next_step", contact: c, quietDays: null });
const quiet = (days: number | null, c = contact({ memberId: "m2", name: "Ravi Patel", priority: "high" })): Nudge => ({ kind: "quiet", contact: c, quietDays: days });
const nudges = (over: Partial<Nudges> = {}): Nudges => ({ noNextStep: [], quiet: [], noNextStepTotal: 0, quietTotal: 0, ...over });
const props = () => ({ onAdd: vi.fn(), onSnooze: vi.fn(), onShowAll: vi.fn(), onOpenContact: vi.fn() });

afterEach(cleanup);

describe("NudgeList", () => {
  it("renders nothing when both lists are empty", () => {
    const { container } = render(<NudgeList nudges={nudges()} {...props()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows only the list that has rows, with the exact row wording", () => {
    render(<NudgeList nudges={nudges({ noNextStep: [none()], noNextStepTotal: 1 })} {...props()} />);
    expect(screen.getByRole("heading", { name: "Needs a next step" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Gone quiet" })).not.toBeInTheDocument();
    expect(screen.getByRole("listitem")).toHaveTextContent("Dana Cho · Proposal sent · no to-do");
  });

  it("quiet rows say how long, or that there is no contact yet", () => {
    render(
      <NudgeList
        nudges={nudges({
          quiet: [quiet(41, contact({ memberId: "m2", name: "Ravi Patel", priority: "high", lastAction: { kind: "call", at: "2026-10-01T00:00:00Z" } })), quiet(null, contact({ memberId: "m3", name: "Lee Wu", priority: "medium" }))],
          quietTotal: 2,
        })}
        {...props()}
      />,
    );
    expect(screen.getByRole("heading", { name: "Gone quiet" })).toBeInTheDocument();
    const [ravi, lee] = screen.getAllByRole("listitem");
    expect(ravi).toHaveTextContent("Ravi Patel · High · last contact 41 days ago");
    expect(lee).toHaveTextContent("Lee Wu · Medium · no contact yet");
  });

  it("Add, Not now and the name call back with the contact or member id", async () => {
    const user = userEvent.setup();
    const p = props();
    const n = none();
    render(<NudgeList nudges={nudges({ noNextStep: [n], noNextStepTotal: 1 })} {...p} />);
    await user.click(screen.getByRole("button", { name: /^Add/ }));
    expect(p.onAdd).toHaveBeenCalledWith(n.contact);
    await user.click(screen.getByRole("button", { name: /^Not now/ }));
    expect(p.onSnooze).toHaveBeenCalledWith("m1");
    await user.click(screen.getByRole("button", { name: "Dana Cho" }));
    expect(p.onOpenContact).toHaveBeenCalledWith(n.contact);
  });

  it("offers Show more (N) only when the total exceeds the rows shown", async () => {
    const user = userEvent.setup();
    const p = props();
    const { rerender } = render(<NudgeList nudges={nudges({ noNextStep: [none()], noNextStepTotal: 14 })} {...p} />);
    await user.click(screen.getByRole("button", { name: "Show more (13)" }));
    expect(p.onShowAll).toHaveBeenCalledTimes(1);
    rerender(<NudgeList nudges={nudges({ noNextStep: [none()], noNextStepTotal: 1 })} {...p} />);
    expect(screen.queryByRole("button", { name: /Show more/ })).not.toBeInTheDocument();
  });
});
