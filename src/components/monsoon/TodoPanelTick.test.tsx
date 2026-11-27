// @vitest-environment jsdom
import React, { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TodoPanel, { EMPTY_TODOS, type TodosState } from "./TodoPanel";
import * as api from "./api";
import type { Nudges, Todo } from "./api";

vi.mock("./api", () => ({ loadTodos: vi.fn(), todoAction: vi.fn(), searchContacts: vi.fn() }));
const m = vi.mocked(api);

const ESTATE = { key: "traxo", label: "Traxo", defaultRole: "lp_prospect", available: true, todos: true, roles: [{ key: "lp_prospect", label: "LP prospect" }] };
const CONTACT = {
  memberId: "m1", memberKind: "person" as const, name: "Alex Chen", company: "Acme", personId: "p1", orgId: "o1",
  aboutPersonId: null, aboutName: null, stage: "meeting_held", stageLabel: "Meeting held", priority: null as "high" | "medium" | "low" | null, lastAction: null,
};
let n = 0;
function todo(over: Partial<Todo> = {}): Todo {
  n += 1;
  return { id: `t${n}`, title: `Task ${n}`, dueDate: null, firstDueDate: null, movedCount: 0, status: "open", outcome: null, closedAt: null, owner: null, mine: true, due: "undated", contact: null, ...over };
}
const reply = (open: Todo[], done: Todo[] = [], nudges?: Nudges) => ({ status: 200, body: { ready: true, open, done, nudges } }) as never;
const written = (t: Todo, status: "ok" | "already" = "ok") => ({ status: 200, body: { status, todo: t } }) as never;
const err = (status: number, error = "Nope.") => ({ status, body: { error } }) as never;

function Harness() {
  const [state, setState] = useState<TodosState>(EMPTY_TODOS);
  return <TodoPanel estate={ESTATE} state={state} onState={setState} onUnauthorized={() => {}} onOpenContact={() => {}} onPrepare={() => {}} />;
}

beforeEach(() => vi.resetAllMocks());
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("ticking off", () => {
  it("posts complete before the sheet shows, and the row moves to Done at once", async () => {
    const user = userEvent.setup();
    const t = todo({ title: "Send deck", contact: CONTACT });
    m.loadTodos.mockResolvedValue(reply([t]));
    let release: (v: never) => void = () => {};
    m.todoAction.mockReturnValue(new Promise((r) => (release = r as never)));
    render(<Harness />);
    await user.click(await screen.findByRole("button", { name: "Mark done: Send deck" }));
    expect(m.todoAction).toHaveBeenCalledWith("traxo", { action: "complete", id: t.id });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark done: Send deck" })).not.toBeInTheDocument();
    await act(async () => release(written({ ...t, status: "done" })));
    expect(await screen.findByRole("dialog", { name: "Done: Send deck" })).toBeInTheDocument();
  });

  it("an already reply counts as success", async () => {
    const user = userEvent.setup();
    const t = todo({ title: "Send deck", contact: CONTACT });
    m.loadTodos.mockResolvedValue(reply([t]));
    m.todoAction.mockResolvedValue(written({ ...t, status: "done" }, "already"));
    render(<Harness />);
    await user.click(await screen.findByRole("button", { name: "Mark done: Send deck" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it.each([409, 502, 0, 404])("a %s on tick puts the row back and shows the error", async (status) => {
    const user = userEvent.setup();
    const t = todo({ title: "Send deck", dueDate: "2020-01-01", contact: CONTACT });
    m.loadTodos.mockResolvedValue(reply([t]));
    m.todoAction.mockResolvedValue(err(status, "It changed."));
    render(<Harness />);
    await user.click(await screen.findByRole("button", { name: "Mark done: Send deck" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark done: Send deck" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Done (last 30 days)" })).not.toBeInTheDocument();
    if (status === 409 || status === 502) expect(screen.getByRole("alert")).toHaveTextContent("It changed.");
  });

  it("Skip leaves the to-do done and sends nothing more", async () => {
    const user = userEvent.setup();
    const t = todo({ title: "Send deck", contact: CONTACT });
    m.loadTodos.mockResolvedValue(reply([t]));
    m.todoAction.mockResolvedValue(written({ ...t, status: "done" }));
    render(<Harness />);
    await user.click(await screen.findByRole("button", { name: "Mark done: Send deck" }));
    await user.click(await screen.findByRole("button", { name: "Skip" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(m.todoAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Mark done: Send deck" })).not.toBeInTheDocument();
  });

  it("Save with a next step adds the new to-do to the list", async () => {
    const user = userEvent.setup();
    const t = todo({ title: "Send deck", contact: CONTACT });
    const next = todo({ title: "Call Alex", dueDate: "2999-01-01", contact: CONTACT });
    m.loadTodos.mockResolvedValue(reply([t]));
    m.todoAction.mockResolvedValueOnce(written({ ...t, status: "done" })).mockResolvedValueOnce(written(next));
    render(<Harness />);
    await user.click(await screen.findByRole("button", { name: "Mark done: Send deck" }));
    await user.type(await screen.findByLabelText("What's next?"), "Call Alex");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Call Alex")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("a to-do with no contact shows Undo, with no sheet, and Undo posts reopen", async () => {
    const user = userEvent.setup();
    const t = todo({ title: "Plan deck" });
    m.loadTodos.mockResolvedValue(reply([t]));
    m.todoAction.mockResolvedValueOnce(written({ ...t, status: "done" })).mockResolvedValueOnce(written(t));
    render(<Harness />);
    await user.click(await screen.findByRole("button", { name: "Mark done: Plan deck" }));
    const undo = await screen.findByRole("button", { name: "Undo" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(undo);
    expect(m.todoAction).toHaveBeenLastCalledWith("traxo", { action: "reopen", id: t.id });
    expect(await screen.findByRole("button", { name: "Mark done: Plan deck" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });

  it("Undo goes away after 6 seconds, and only one Undo shows at a time", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const a = todo({ title: "First" });
    const b = todo({ title: "Second" });
    m.loadTodos.mockResolvedValue(reply([a, b]));
    m.todoAction.mockImplementation((async (_e: string, body: { id: string }) => written({ ...(body.id === a.id ? a : b), status: "done" })) as never);
    render(<Harness />);
    await user.click(await screen.findByRole("button", { name: "Mark done: First" }));
    await screen.findByRole("button", { name: "Undo" });
    await act(async () => void vi.advanceTimersByTime(5000));
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Mark done: Second" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(1));
    // the first timer was cleared: 5 more seconds does not remove the Undo of the second
    await act(async () => void vi.advanceTimersByTime(5000));
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    await act(async () => void vi.advanceTimersByTime(1500));
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });
});

describe("Done list", () => {
  it("is collapsed by default, opens, and Reopen posts reopen and moves the row back", async () => {
    const user = userEvent.setup();
    const d = todo({ title: "Old job", status: "done", closedAt: "2026-11-20T10:00:00Z" });
    m.loadTodos.mockResolvedValue(reply([], [d]));
    m.todoAction.mockResolvedValue(written({ ...d, status: "open", closedAt: null }));
    render(<Harness />);
    const fold = await screen.findByRole("button", { name: "Done (last 30 days)" });
    expect(fold).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Old job")).not.toBeInTheDocument();
    await user.click(fold);
    expect(screen.getByText("Old job")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Reopen/ }));
    expect(m.todoAction).toHaveBeenCalledWith("traxo", { action: "reopen", id: d.id });
    expect(await screen.findByRole("button", { name: "Mark done: Old job" })).toBeInTheDocument();
  });

  it("a failed Reopen shows the error and keeps the row in Done", async () => {
    const user = userEvent.setup();
    const d = todo({ title: "Old job", status: "done" });
    m.loadTodos.mockResolvedValue(reply([], [d]));
    m.todoAction.mockResolvedValue(err(502, "The CRM did not answer."));
    render(<Harness />);
    await user.click(await screen.findByRole("button", { name: "Done (last 30 days)" }));
    await user.click(screen.getByRole("button", { name: /^Reopen/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The CRM did not answer.");
    expect(screen.getByText("Old job")).toBeInTheDocument();
  });
});

describe("nudges on the tab", () => {
  const dana = { ...CONTACT, memberId: "m9", personId: "p9", name: "Dana Cho", stageLabel: "Proposal sent" };
  const nudges = (): Nudges => ({
    noNextStep: [{ kind: "no_next_step", contact: dana, quietDays: null }],
    quiet: [{ kind: "quiet", contact: { ...CONTACT, memberId: "m8", name: "Ravi Patel", priority: "high" }, quietDays: 41 }],
    noNextStepTotal: 1,
    quietTotal: 1,
  });

  it("sit below the groups and above the Done fold", async () => {
    m.loadTodos.mockResolvedValue(reply([todo({ title: "A job" })], [todo({ status: "done" })], nudges()));
    render(<Harness />);
    const job = await screen.findByText("A job");
    const needs = screen.getByRole("heading", { name: "Needs a next step" });
    const fold = screen.getByRole("button", { name: "Done (last 30 days)" });
    expect(job.compareDocumentPosition(needs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(needs.compareDocumentPosition(fold) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("show nothing when the reply has no nudges", async () => {
    m.loadTodos.mockResolvedValue(reply([todo({ title: "A job" })]));
    render(<Harness />);
    await screen.findByText("A job");
    expect(screen.queryByRole("heading", { name: "Needs a next step" })).not.toBeInTheDocument();
  });

  it("Not now posts snooze and removes the row at once", async () => {
    const user = userEvent.setup();
    m.loadTodos.mockResolvedValue(reply([], [], nudges()));
    m.todoAction.mockResolvedValue(written(todo()));
    render(<Harness />);
    await user.click(await screen.findByRole("button", { name: /^Not now.*Dana Cho/ }));
    expect(m.todoAction).toHaveBeenCalledWith("traxo", { action: "snooze", memberId: "m9" });
    expect(screen.queryByText(/Dana Cho/)).not.toBeInTheDocument();
    expect(screen.getByText(/Ravi Patel/)).toBeInTheDocument();
  });

  it("Not now puts the row back with the error when the call fails", async () => {
    const user = userEvent.setup();
    m.loadTodos.mockResolvedValue(reply([], [], nudges()));
    m.todoAction.mockResolvedValue(err(502, "The CRM did not answer."));
    render(<Harness />);
    await user.click(await screen.findByRole("button", { name: /^Not now.*Dana Cho/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The CRM did not answer.");
    expect(screen.getByText(/Dana Cho/)).toBeInTheDocument();
  });

  it("Add opens the form with that contact filled in; after saving the nudge is gone", async () => {
    const user = userEvent.setup();
    m.loadTodos.mockResolvedValue(reply([], [], nudges()));
    render(<Harness />);
    await user.click(await screen.findByRole("button", { name: /^Add.*Dana Cho/ }));
    expect(screen.getByRole("button", { name: "Remove Dana Cho" })).toBeInTheDocument();
    m.todoAction.mockResolvedValue(written(todo({ title: "Send terms", contact: dana })));
    await user.type(screen.getByLabelText("What"), "Send terms");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(m.todoAction).toHaveBeenCalledWith("traxo", expect.objectContaining({ action: "add", title: "Send terms", target: { personId: "p9" } }));
    expect(await screen.findByText("Send terms")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Needs a next step" })).not.toBeInTheDocument();
    expect(screen.getByText(/Ravi Patel/)).toBeInTheDocument();
  });

  it("Show more reloads with allNudges", async () => {
    const user = userEvent.setup();
    const many = nudges();
    many.noNextStepTotal = 12;
    m.loadTodos.mockResolvedValue(reply([], [], many));
    render(<Harness />);
    await user.click(await screen.findByRole("button", { name: "Show more (11)" }));
    expect(m.loadTodos).toHaveBeenLastCalledWith("traxo", { allNudges: true });
  });
});
