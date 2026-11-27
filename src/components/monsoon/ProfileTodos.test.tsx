// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProfileTodos from "./ProfileTodos";
import * as api from "./api";
import type { Todo } from "./api";

vi.mock("./api", () => ({ loadTodos: vi.fn(), todoAction: vi.fn(), searchContacts: vi.fn() }));
const m = vi.mocked(api);

const ESTATE = { key: "traxo", label: "Traxo", defaultRole: "lp_prospect", available: true, todos: true, roles: [{ key: "lp_prospect", label: "LP prospect" }] };
const CONTACT = {
  memberId: "m1", memberKind: "person" as const, name: "Jane Tan", company: "Acme", personId: "p1", orgId: "o1",
  aboutPersonId: null as string | null, aboutName: null as string | null, stage: "in_talks", stageLabel: "In talks",
  priority: null as "high" | "medium" | "low" | null, lastAction: null,
};
let n = 0;
function todo(over: Partial<Todo> = {}): Todo {
  n += 1;
  return { id: `t${n}`, title: `Task ${n}`, dueDate: null, firstDueDate: null, movedCount: 0, status: "open", outcome: null, closedAt: null, owner: null, mine: true, due: "undated", contact: CONTACT, ...over };
}
const reply = (open: Todo[], done: Todo[] = []) => ({ status: 200, body: { ready: true, open, done } }) as never;
const written = (t: Todo) => ({ status: 200, body: { status: "ok", todo: t } }) as never;

function show(props: Partial<React.ComponentProps<typeof ProfileTodos>> = {}) {
  const onPrepare = vi.fn();
  const onUnauthorized = vi.fn();
  render(
    <ProfileTodos estate={ESTATE} memberId="m1" target={{ personId: "p1" }} name="Jane Tan" onPrepare={onPrepare} onUnauthorized={onUnauthorized} {...props} />,
  );
  return { onPrepare, onUnauthorized };
}

beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe("ProfileTodos", () => {
  it("lists the member's open to-dos, read for that member", async () => {
    m.loadTodos.mockResolvedValue(reply([todo({ title: "Send deck" }), todo({ title: "Call back" })]));
    show();
    expect(await screen.findByText("Send deck")).toBeInTheDocument();
    expect(screen.getByText("Call back")).toBeInTheDocument();
    expect(m.loadTodos).toHaveBeenCalledWith("traxo", { member: "m1" });
    expect(screen.getByRole("heading", { name: "To do" })).toBeInTheDocument();
  });

  it("says so when there is nothing open", async () => {
    m.loadTodos.mockResolvedValue(reply([]));
    show();
    expect(await screen.findByText("Nothing to do for Jane Tan yet.")).toBeInTheDocument();
  });

  it("adds a to-do with the profile's target and the contact filled in", async () => {
    const user = userEvent.setup();
    m.loadTodos.mockResolvedValue(reply([]));
    const added = todo({ title: "Send deck" });
    m.todoAction.mockResolvedValue(written(added));
    show();
    await user.click(await screen.findByRole("button", { name: "Add" }));
    expect(screen.getByText("Jane Tan")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "What" }), "Send deck");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(m.todoAction).toHaveBeenCalledWith("traxo", expect.objectContaining({ action: "add", title: "Send deck", target: { personId: "p1" } })),
    );
    expect(await screen.findByRole("button", { name: "Mark done: Send deck" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "What" })).not.toBeInTheDocument();
  });

  it("a company profile adds to its pipeline entry", async () => {
    const user = userEvent.setup();
    m.loadTodos.mockResolvedValue(reply([]));
    m.todoAction.mockResolvedValue(written(todo({ title: "Visit" })));
    show({ target: { memberId: "m1" }, name: "Acme" });
    await user.click(await screen.findByRole("button", { name: "Add" }));
    await user.type(screen.getByRole("textbox", { name: "What" }), "Visit");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(m.todoAction).toHaveBeenCalledWith("traxo", expect.objectContaining({ action: "add", target: { memberId: "m1" } })));
  });

  it("ticking opens the what-happened sheet, and the to-do moves to Done", async () => {
    const user = userEvent.setup();
    const t = todo({ title: "Send deck" });
    m.loadTodos.mockResolvedValue(reply([t]));
    m.todoAction.mockResolvedValue(written({ ...t, status: "done" }));
    show();
    await user.click(await screen.findByRole("button", { name: "Mark done: Send deck" }));
    expect(m.todoAction).toHaveBeenCalledWith("traxo", { action: "complete", id: t.id });
    expect(await screen.findByRole("dialog", { name: "Done: Send deck" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Skip" }));
    expect(screen.queryByRole("button", { name: "Mark done: Send deck" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Done/ })).toBeInTheDocument();
  });

  it("a failed tick puts the row back and shows the reason", async () => {
    const user = userEvent.setup();
    const t = todo({ title: "Send deck" });
    m.loadTodos.mockResolvedValue(reply([t]));
    m.todoAction.mockResolvedValue({ status: 409, body: { error: "It changed." } } as never);
    show();
    await user.click(await screen.findByRole("button", { name: "Mark done: Send deck" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("It changed.");
    expect(screen.getByRole("button", { name: "Mark done: Send deck" })).toBeInTheDocument();
  });

  it("the Done fold reopens a done to-do", async () => {
    const user = userEvent.setup();
    const d = todo({ title: "Old thing", status: "done", closedAt: "2026-11-20T10:00:00Z" });
    m.loadTodos.mockResolvedValue(reply([], [d]));
    m.todoAction.mockResolvedValue(written({ ...d, status: "open", closedAt: null }));
    show();
    await user.click(await screen.findByRole("button", { name: /^Done/ }));
    await user.click(screen.getByRole("button", { name: "Reopen: Old thing" }));
    expect(m.todoAction).toHaveBeenCalledWith("traxo", { action: "reopen", id: d.id });
    expect(await screen.findByRole("button", { name: "Mark done: Old thing" })).toBeInTheDocument();
  });

  it("after a Drop an Undo bar shows above the Ask button, and Undo posts reopen and puts the row back", async () => {
    const user = userEvent.setup();
    const t = todo({ title: "Old idea" });
    m.loadTodos.mockResolvedValue(reply([t]));
    m.todoAction.mockResolvedValueOnce(written({ ...t, status: "dropped" })).mockResolvedValueOnce(written(t));
    show();
    await user.click(await screen.findByRole("button", { name: /^Old idea/ }));
    await user.click(screen.getByRole("button", { name: "Drop" }));
    expect(m.todoAction).toHaveBeenCalledWith("traxo", { action: "drop", id: t.id });
    const bar = await screen.findByText("Dropped: Old idea");
    expect(bar.closest("[role=status]")).toHaveClass("bottom-[calc(6rem+env(safe-area-inset-bottom))]");
    expect(screen.queryByRole("button", { name: "Mark done: Old idea" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(m.todoAction).toHaveBeenLastCalledWith("traxo", { action: "reopen", id: t.id });
    expect(await screen.findByRole("button", { name: "Mark done: Old idea" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });

  it("the Drop Undo goes after 6 seconds, and when another contact is shown", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const a = todo({ title: "First" });
      const b = todo({ title: "Second" });
      m.loadTodos.mockResolvedValue(reply([a, b]));
      m.todoAction.mockResolvedValueOnce(written({ ...a, status: "dropped" }));
      const view = render(<ProfileTodos estate={ESTATE} memberId="m1" target={{ personId: "p1" }} name="Jane Tan" />);
      await user.click(await screen.findByRole("button", { name: /^First/ }));
      await user.click(screen.getByRole("button", { name: "Drop" }));
      await screen.findByText("Dropped: First");
      await act(async () => void vi.advanceTimersByTime(5000));
      expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
      await act(async () => void vi.advanceTimersByTime(1500));
      expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();

      m.todoAction.mockResolvedValueOnce(written({ ...b, status: "dropped" }));
      await user.click(screen.getByRole("button", { name: /^Second/ }));
      await user.click(screen.getByRole("button", { name: "Drop" }));
      await screen.findByText("Dropped: Second");
      m.loadTodos.mockResolvedValue(reply([todo({ title: "Other task", contact: { ...CONTACT, memberId: "m2" } })]));
      view.rerender(<ProfileTodos estate={ESTATE} memberId="m2" target={{ personId: "p2" }} name="Sam Lee" />);
      expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an Undo whose reply lands after the contact changed does not put the row on the new contact's list", async () => {
    const user = userEvent.setup();
    const t = todo({ title: "Old idea" });
    m.loadTodos.mockResolvedValue(reply([t]));
    m.todoAction.mockResolvedValueOnce(written({ ...t, status: "dropped" }));
    const view = render(<ProfileTodos estate={ESTATE} memberId="m1" target={{ personId: "p1" }} name="Jane Tan" />);
    await user.click(await screen.findByRole("button", { name: /^Old idea/ }));
    await user.click(screen.getByRole("button", { name: "Drop" }));
    let release: (v: never) => void = () => {};
    m.todoAction.mockReturnValueOnce(new Promise((r) => (release = r as never)));
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    m.loadTodos.mockResolvedValue(reply([]));
    view.rerender(<ProfileTodos estate={ESTATE} memberId="m2" target={{ personId: "p2" }} name="Sam Lee" />);
    expect(await screen.findByText("Nothing to do for Sam Lee yet.")).toBeInTheDocument();
    await act(async () => release(written(t)));
    expect(screen.queryByText("Old idea")).not.toBeInTheDocument();
  });

  it("a person filed under a company sees their own to-dos and the company-wide ones, with other people named", async () => {
    m.loadTodos.mockResolvedValue(
      reply([
        todo({ title: "About Jane", contact: { ...CONTACT, name: "Acme", aboutPersonId: "p1", aboutName: "Jane Tan" } }),
        todo({ title: "About nobody", contact: { ...CONTACT, name: "Acme", aboutPersonId: null } }),
        todo({ title: "About Bob", contact: { ...CONTACT, name: "Acme", aboutPersonId: "p2", aboutName: "Bob Lee" } }),
      ]),
    );
    show();
    expect(await screen.findByText("About Jane")).toBeInTheDocument();
    expect(screen.getByText("About nobody")).toBeInTheDocument();
    expect(screen.queryByText("About Bob")).not.toBeInTheDocument();
  });

  it("a company profile lists everything and names the person a to-do is about", async () => {
    m.loadTodos.mockResolvedValue(
      reply([
        todo({ title: "About Bob", contact: { ...CONTACT, name: "Acme", aboutPersonId: "p2", aboutName: "Bob Lee" } }),
        todo({ title: "About nobody", contact: { ...CONTACT, name: "Acme", aboutPersonId: null } }),
      ]),
    );
    show({ target: { memberId: "m1" }, name: "Acme" });
    const row = (await screen.findByText("About Bob")).closest("li") as HTMLElement;
    expect(within(row).getByText("Bob Lee")).toBeInTheDocument();
    expect(screen.getByText("About nobody")).toBeInTheDocument();
  });

  it("another person's to-do shows the owner key after the title", async () => {
    m.loadTodos.mockResolvedValue(reply([todo({ title: "Theirs", owner: "VF", mine: false }), todo({ title: "Mine", owner: "AB", mine: true })]));
    show();
    const theirs = (await screen.findByText("Theirs")).closest("li") as HTMLElement;
    expect(within(theirs).getByText("VF")).toBeInTheDocument();
    expect(screen.queryByText("AB")).not.toBeInTheDocument();
  });

  it("the edit view offers Prepare me and passes the to-do on", async () => {
    const user = userEvent.setup();
    const t = todo({ title: "Send deck" });
    m.loadTodos.mockResolvedValue(reply([t]));
    const { onPrepare } = show();
    await user.click(await screen.findByRole("button", { name: "Send deck" }));
    await user.click(screen.getByRole("button", { name: "Prepare me" }));
    expect(onPrepare).toHaveBeenCalledWith(t);
  });

  it("reads again when the profile is reloaded", async () => {
    m.loadTodos.mockResolvedValue(reply([]));
    const props = { estate: ESTATE, memberId: "m1", target: { personId: "p1" }, name: "Jane Tan", onPrepare: vi.fn() };
    const { rerender } = render(<ProfileTodos {...props} reloadSignal={0} />);
    await screen.findByText("Nothing to do for Jane Tan yet.");
    rerender(<ProfileTodos {...props} reloadSignal={1} />);
    await waitFor(() => expect(m.loadTodos).toHaveBeenCalledTimes(2));
  });

  it("a 401 goes to sign-in, and a CRM not set up for to-dos shows nothing", async () => {
    m.loadTodos.mockResolvedValueOnce({ status: 401, body: null } as never);
    const first = show();
    await waitFor(() => expect(first.onUnauthorized).toHaveBeenCalled());
    cleanup();
    m.loadTodos.mockResolvedValue({ status: 200, body: { ready: false } } as never);
    const { container } = render(<ProfileTodos estate={ESTATE} memberId="m1" target={{ personId: "p1" }} name="Jane Tan" onPrepare={vi.fn()} />);
    await waitFor(() => expect(m.loadTodos).toHaveBeenCalledTimes(2));
    expect(container).toBeEmptyDOMElement();
  });

  it("a failed read says so and can retry", async () => {
    const user = userEvent.setup();
    m.loadTodos.mockRejectedValueOnce(new Error("offline"));
    m.loadTodos.mockResolvedValue(reply([todo({ title: "Send deck" })]));
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load to-dos. Check signal.");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Send deck")).toBeInTheDocument();
  });
});
