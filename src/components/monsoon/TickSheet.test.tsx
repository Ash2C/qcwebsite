// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TickSheet from "./TickSheet";
import * as api from "./api";
import type { Todo } from "./api";
import { addDays, localToday } from "./todoDates";

vi.mock("./api", () => ({ todoAction: vi.fn() }));
const m = vi.mocked(api);

const ESTATE = { key: "traxo", label: "Traxo", defaultRole: "lp_prospect", available: true, todos: true, roles: [{ key: "lp_prospect", label: "LP prospect" }] };
const CONTACT = {
  memberId: "m1", memberKind: "person" as const, name: "Alex Chen", company: "Acme", personId: "p1", orgId: "o1",
  aboutPersonId: null, aboutName: null, stage: "meeting_held", stageLabel: "Meeting held", priority: null, lastAction: null,
};
const TODO: Todo = {
  id: "t1", title: "Send deck", dueDate: null, firstDueDate: null, movedCount: 0, status: "done", outcome: null,
  closedAt: null, owner: null, mine: true, due: "undated", contact: CONTACT,
};
const written = (t: Partial<Todo> = {}) => ({ status: 200, body: { status: "ok", todo: { ...TODO, ...t } } }) as never;

beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe("TickSheet", () => {
  it("is a dialog headed Done: <title> with both boxes, Save and Skip", () => {
    render(<TickSheet estate={ESTATE} todo={TODO} onClose={() => {}} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAccessibleName("Done: Send deck");
    expect(screen.getByRole("heading", { name: "Done: Send deck" })).toBeInTheDocument();
    expect(screen.getByLabelText("What happened?")).toBeInTheDocument();
    expect(screen.getByLabelText("What's next?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip" })).toBeInTheDocument();
    expect(dialog).toHaveFocus();
  });

  it("Save with both boxes posts outcome, then add with source next and the contact's target", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const next = { ...TODO, id: "t2", title: "Call Alex", status: "open" as const };
    m.todoAction.mockResolvedValueOnce(written({ outcome: "He liked it" })).mockResolvedValueOnce(written(next));
    render(<TickSheet estate={ESTATE} todo={TODO} onClose={onClose} />);
    await user.type(screen.getByLabelText("What happened?"), "He liked it");
    await user.type(screen.getByLabelText("What's next?"), "Call Alex");
    await user.click(screen.getByRole("button", { name: "Next week" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(m.todoAction.mock.calls).toEqual([
      ["traxo", { action: "outcome", id: "t1", outcome: "He liked it" }],
      ["traxo", { action: "add", title: "Call Alex", dueDate: addDays(localToday(), 7), target: { personId: "p1" }, source: "next" }],
    ]);
    expect(onClose).toHaveBeenCalledWith({ outcome: true, next: expect.objectContaining({ id: "t2" }) });
  });

  it("uses the about-person, else the member, as the target", async () => {
    const user = userEvent.setup();
    m.todoAction.mockResolvedValue(written());
    const about = { ...TODO, contact: { ...CONTACT, personId: null, aboutPersonId: "ap1" } };
    const { unmount } = render(<TickSheet estate={ESTATE} todo={about} onClose={() => {}} />);
    await user.type(screen.getByLabelText("What's next?"), "x");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(m.todoAction.mock.calls[0][1]).toMatchObject({ target: { personId: "ap1" } });
    unmount();
    m.todoAction.mockClear();
    const company = { ...TODO, contact: { ...CONTACT, personId: null, memberKind: "company" as const } };
    render(<TickSheet estate={ESTATE} todo={company} onClose={() => {}} />);
    await user.type(screen.getByLabelText("What's next?"), "y");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(m.todoAction.mock.calls[0][1]).toMatchObject({ target: { memberId: "m1" } });
  });

  it("sends only the outcome when the second box is empty", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    m.todoAction.mockResolvedValue(written());
    render(<TickSheet estate={ESTATE} todo={TODO} onClose={onClose} />);
    await user.type(screen.getByLabelText("What happened?"), "Sent it");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(m.todoAction).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith({ outcome: true, next: null });
  });

  it("Save with nothing typed posts nothing and closes", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<TickSheet estate={ESTATE} todo={TODO} onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(m.todoAction).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith({ outcome: false, next: null });
  });

  it("Skip, Escape and the backdrop post nothing", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<TickSheet estate={ESTATE} todo={TODO} onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "Skip" }));
    await user.keyboard("{Escape}");
    await user.click(screen.getByTestId("tick-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(m.todoAction).not.toHaveBeenCalled();
  });

  it("when outcome fails: shows the error, keeps the text, does not send add", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    m.todoAction.mockResolvedValue({ status: 502, body: { error: "The CRM did not answer." } } as never);
    render(<TickSheet estate={ESTATE} todo={TODO} onClose={onClose} />);
    await user.type(screen.getByLabelText("What happened?"), "He liked it");
    await user.type(screen.getByLabelText("What's next?"), "Call Alex");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The CRM did not answer.");
    expect(m.todoAction).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("What happened?")).toHaveValue("He liked it");
    expect(screen.getByLabelText("What's next?")).toHaveValue("Call Alex");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("when add fails: keeps the next text and a retry does not resend the outcome", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    m.todoAction
      .mockResolvedValueOnce(written())
      .mockResolvedValueOnce({ status: 0, body: null } as never)
      .mockResolvedValueOnce(written({ id: "t2", status: "open" }));
    render(<TickSheet estate={ESTATE} todo={TODO} onClose={onClose} />);
    await user.type(screen.getByLabelText("What happened?"), "He liked it");
    await user.type(screen.getByLabelText("What's next?"), "Call Alex");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save. Check signal.");
    expect(screen.getByLabelText("What's next?")).toHaveValue("Call Alex");
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(m.todoAction.mock.calls.map((c) => (c[1] as { action: string }).action)).toEqual(["outcome", "add", "add"]);
    expect(onClose).toHaveBeenCalledWith({ outcome: true, next: expect.objectContaining({ id: "t2" }) });
  });

  it("returns focus to the element that had it", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(<TickSheet estate={ESTATE} todo={TODO} onClose={() => {}} />);
    expect(opener).not.toHaveFocus();
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });
});
