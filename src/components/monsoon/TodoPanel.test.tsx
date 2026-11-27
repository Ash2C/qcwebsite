// @vitest-environment jsdom
import React, { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TodoPanel, { EMPTY_TODOS, type TodosState } from "./TodoPanel";
import * as api from "./api";
import type { Todo } from "./api";
import { addDays, localToday } from "./todoDates";

vi.mock("./api", () => ({ loadTodos: vi.fn(), todoAction: vi.fn(), searchContacts: vi.fn() }));
const m = vi.mocked(api);

const ESTATE = { key: "traxo", label: "Traxo", defaultRole: "lp_prospect", available: true, todos: true, roles: [{ key: "lp_prospect", label: "LP prospect" }] };
const TODAY = localToday();
const TOMORROW = addDays(TODAY, 1);

let n = 0;
function todo(over: Partial<Todo> = {}): Todo {
  n += 1;
  return {
    id: `t${n}`, title: `Task ${n}`, dueDate: null, firstDueDate: null, movedCount: 0, status: "open", outcome: null,
    closedAt: null, owner: null, mine: true, due: "undated", contact: null, ...over,
  };
}
const CONTACT = {
  memberId: "m1", memberKind: "person" as const, name: "Alex Chen", company: "Acme", personId: "p1", orgId: "o1",
  aboutPersonId: null, aboutName: null, stage: "meeting_held", stageLabel: "Meeting held", priority: null,
  lastAction: { kind: "call", at: new Date(new Date().getFullYear(), 10, 19, 12, 0).toISOString() },
};

const list = (open: Todo[]) => ({ status: 200, body: { ready: true, open, done: [] } }) as never;
const written = (t: Todo, status: "ok" | "already" = "ok") => ({ status: 200, body: { status, todo: t } }) as never;

function Harness({ estate = ESTATE, onUnauthorized = () => {}, onOpenContact = () => {}, onPrepare = () => {} }: {
  estate?: typeof ESTATE; onUnauthorized?: () => void; onOpenContact?: (t: unknown) => void; onPrepare?: (t: Todo) => void;
}) {
  const [state, setState] = useState<TodosState>(EMPTY_TODOS);
  return <TodoPanel estate={estate} state={state} onState={setState} onUnauthorized={onUnauthorized} onOpenContact={onOpenContact} onPrepare={onPrepare} />;
}

beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(cleanup);

const headings = () => screen.queryAllByRole("heading", { level: 3 }).map((h) => h.textContent);

describe("TodoPanel list", () => {
  it("shows a heading only for a group that has rows, in order", async () => {
    m.loadTodos.mockResolvedValue(
      list([
        todo({ title: "Later one", dueDate: addDays(TODAY, 30) }),
        todo({ title: "Late one", dueDate: addDays(TODAY, -2) }),
        todo({ title: "Whenever" }),
        todo({ title: "Now one", dueDate: TODAY }),
      ]),
    );
    render(<Harness />);
    await screen.findByText("Now one");
    expect(headings()).toEqual(["Overdue", "Today", "Later", "No date"]);
    expect(m.loadTodos).toHaveBeenCalledWith("traxo");
  });

  it("shows the empty line when there is nothing", async () => {
    m.loadTodos.mockResolvedValue(list([]));
    render(<Harness />);
    expect(await screen.findByText("Nothing to do yet. Add your first to-do.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
  });

  it("shows only the not-ready line when the reply says ready: false", async () => {
    m.loadTodos.mockResolvedValue({ status: 200, body: { ready: false } } as never);
    render(<Harness />);
    expect(await screen.findByText("To do is being set up for this CRM.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add" })).not.toBeInTheDocument();
  });

  it("shows the not-ready line without asking when the estate has no to-dos", async () => {
    render(<Harness estate={{ ...ESTATE, todos: false }} />);
    expect(await screen.findByText("To do is being set up for this CRM.")).toBeInTheDocument();
    expect(m.loadTodos).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Add" })).not.toBeInTheDocument();
  });

  it("goes back to sign-in on a 401", async () => {
    m.loadTodos.mockResolvedValue({ status: 401, body: { error: "unauthorized" } } as never);
    const onUnauthorized = vi.fn();
    render(<Harness onUnauthorized={onUnauthorized} />);
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
  });

  it("says so when the list cannot be loaded, and Retry asks again", async () => {
    const user = userEvent.setup();
    m.loadTodos.mockResolvedValueOnce({ status: 0, body: null } as never);
    render(<Harness />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load to-dos. Check signal.");
    m.loadTodos.mockResolvedValue(list([todo({ title: "Back again" })]));
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Back again")).toBeInTheDocument();
  });

  it("a row shows the contact line, a date, the moved hint from 2, and opens the contact from the name", async () => {
    const user = userEvent.setup();
    const onOpenContact = vi.fn();
    m.loadTodos.mockResolvedValue(
      list([
        todo({ title: "Send deck", dueDate: addDays(TODAY, -3), movedCount: 3, contact: CONTACT }),
        todo({ title: "Once moved", dueDate: TODAY, movedCount: 1 }),
      ]),
    );
    render(<Harness onOpenContact={onOpenContact} />);
    await screen.findByText("Send deck");
    expect(screen.getByText("Acme · Meeting held · last: call 19 Nov")).toBeInTheDocument();
    expect(screen.getByText("moved 3 times")).toBeInTheDocument();
    expect(screen.queryByText(/moved 1/)).not.toBeInTheDocument();
    expect(screen.getAllByText("(no contact)")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Alex Chen" }));
    expect(onOpenContact).toHaveBeenCalledWith({ personId: "p1" });
  });
});

describe("TodoPanel add", () => {
  it("adds with a date and files the row under the right heading", async () => {
    const user = userEvent.setup();
    m.loadTodos.mockResolvedValue(list([]));
    m.todoAction.mockResolvedValue(written(todo({ title: "Call Sarah", dueDate: TOMORROW })));
    render(<Harness />);
    await user.click(await screen.findByRole("button", { name: "Add" }));
    await user.type(screen.getByLabelText("What"), "Call Sarah");
    await user.click(screen.getByRole("button", { name: "Tomorrow" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(m.todoAction).toHaveBeenCalledWith("traxo", { action: "add", title: "Call Sarah", dueDate: TOMORROW });
    expect(await screen.findByText("Call Sarah")).toBeInTheDocument();
    expect(headings()).toEqual(["This week"]);
    expect(m.loadTodos).toHaveBeenCalledTimes(1);
  });

  it("offers the five date choices and sends null for No date", async () => {
    const user = userEvent.setup();
    m.loadTodos.mockResolvedValue(list([]));
    m.todoAction.mockResolvedValue(written(todo({ title: "Sort files" })));
    render(<Harness />);
    await user.click(await screen.findByRole("button", { name: "Add" }));
    const when = screen.getByRole("group", { name: "When" });
    expect(within(when).getAllByRole("button").map((b) => b.textContent)).toEqual(["Today", "Tomorrow", "Next week", "Pick a date", "No date"]);
    await user.type(screen.getByLabelText("What"), "Sort files");
    await user.click(screen.getByRole("button", { name: "No date" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(m.todoAction).toHaveBeenCalledWith("traxo", { action: "add", title: "Sort files", dueDate: null });
    expect(await screen.findByText("Sort files")).toBeInTheDocument();
    expect(headings()).toEqual(["No date"]);
  });

  it("Next week is today plus seven and Pick a date takes a typed day", async () => {
    const user = userEvent.setup();
    m.loadTodos.mockResolvedValue(list([]));
    m.todoAction.mockResolvedValue(written(todo({ title: "x", dueDate: addDays(TODAY, 7) })));
    render(<Harness />);
    await user.click(await screen.findByRole("button", { name: "Add" }));
    await user.type(screen.getByLabelText("What"), "x");
    await user.click(screen.getByRole("button", { name: "Next week" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(m.todoAction).toHaveBeenLastCalledWith("traxo", { action: "add", title: "x", dueDate: addDays(TODAY, 7) });
    await user.click(await screen.findByRole("button", { name: "Add" }));
    await user.type(screen.getByLabelText("What"), "y");
    await user.click(screen.getByRole("button", { name: "Pick a date" }));
    await user.type(screen.getByLabelText("Date"), "2027-02-03");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(m.todoAction).toHaveBeenLastCalledWith("traxo", { action: "add", title: "y", dueDate: "2027-02-03" });
  });

  it("will not save an empty title", async () => {
    const user = userEvent.setup();
    m.loadTodos.mockResolvedValue(list([]));
    render(<Harness />);
    await user.click(await screen.findByRole("button", { name: "Add" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.type(screen.getByLabelText("What"), "   ");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("picks a person as a personId target and a company as a memberId target, and the chip can be removed", async () => {
    const user = userEvent.setup();
    m.loadTodos.mockResolvedValue(list([]));
    m.searchContacts.mockResolvedValue({
      status: 200,
      body: {
        contacts: [
          { kind: "person", personId: "p9", orgId: "o9", name: "Sarah Lin", title: null, company: "Beta", email: null, member: null, memberOf: null, work: null },
          { kind: "company", personId: null, orgId: "o8", name: "Gamma Capital", title: null, company: null, email: null, member: { memberId: "m8", memberKind: "company", role: "lp_prospect", stage: "lead" }, memberOf: "self", work: null },
        ],
      },
    } as never);
    m.todoAction.mockResolvedValue(written(todo({ title: "Call" })));
    render(<Harness />);
    await user.click(await screen.findByRole("button", { name: "Add" }));
    await user.type(screen.getByLabelText("What"), "Call");
    await user.type(screen.getByLabelText("Who (optional)"), "sa");
    await user.click(await screen.findByRole("button", { name: /Sarah Lin/ }));
    expect(m.searchContacts).toHaveBeenCalledWith("traxo", "sa");
    expect(screen.getByRole("button", { name: "Remove Sarah Lin" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(m.todoAction).toHaveBeenLastCalledWith("traxo", expect.objectContaining({ action: "add", target: { personId: "p9" } }));

    await user.click(await screen.findByRole("button", { name: "Add" }));
    await user.type(screen.getByLabelText("What"), "Pitch");
    await user.type(screen.getByLabelText("Who (optional)"), "ga");
    await user.click(await screen.findByRole("button", { name: /Gamma Capital/ }));
    await user.click(screen.getByRole("button", { name: "Remove Gamma Capital" }));
    expect(screen.queryByRole("button", { name: "Remove Gamma Capital" })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Who (optional)"), "ga");
    await user.click(await screen.findByRole("button", { name: /Gamma Capital/ }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(m.todoAction).toHaveBeenLastCalledWith("traxo", expect.objectContaining({ target: { memberId: "m8" } }));
  });

  it("a failed add shows the reply's words inline and keeps the form", async () => {
    const user = userEvent.setup();
    m.loadTodos.mockResolvedValue(list([]));
    m.todoAction.mockResolvedValue({ status: 400, body: { error: "Title is too long" } } as never);
    render(<Harness />);
    await user.click(await screen.findByRole("button", { name: "Add" }));
    await user.type(screen.getByLabelText("What"), "Call Sarah");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Title is too long");
    expect(screen.getByLabelText("What")).toHaveValue("Call Sarah");
  });

  it("says Check signal when the write gets no reply, and 502 shows the server line", async () => {
    const user = userEvent.setup();
    m.loadTodos.mockResolvedValue(list([]));
    m.todoAction.mockResolvedValueOnce({ status: 0, body: null } as never);
    render(<Harness />);
    await user.click(await screen.findByRole("button", { name: "Add" }));
    await user.type(screen.getByLabelText("What"), "A");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save. Check signal.");
    m.todoAction.mockResolvedValueOnce({ status: 502, body: { error: "Could not reach the Traxo CRM" } } as never);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not reach the Traxo CRM"));
  });

  it("goes back to sign-in on a 401 from a write", async () => {
    const user = userEvent.setup();
    const onUnauthorized = vi.fn();
    m.loadTodos.mockResolvedValue(list([]));
    m.todoAction.mockResolvedValue({ status: 401, body: { error: "unauthorized" } } as never);
    render(<Harness onUnauthorized={onUnauthorized} />);
    await user.click(await screen.findByRole("button", { name: "Add" }));
    await user.type(screen.getByLabelText("What"), "A");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
  });

  it("Cancel closes the form without writing", async () => {
    const user = userEvent.setup();
    m.loadTodos.mockResolvedValue(list([]));
    render(<Harness />);
    await user.click(await screen.findByRole("button", { name: "Add" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(m.todoAction).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Add" })).toBeInTheDocument();
  });
});

describe("TodoPanel edit", () => {
  it("changing the date posts only the date and moves the row to its new group", async () => {
    const user = userEvent.setup();
    const t = todo({ id: "e1", title: "Send deck", dueDate: addDays(TODAY, -2) });
    m.loadTodos.mockResolvedValue(list([t]));
    m.todoAction.mockResolvedValue(written({ ...t, dueDate: TOMORROW, movedCount: 1 }));
    render(<Harness />);
    await user.click(await screen.findByRole("button", { name: /^Send deck/ }));
    expect(screen.getByLabelText("What")).toHaveValue("Send deck");
    await user.click(screen.getByRole("button", { name: "Tomorrow" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(m.todoAction).toHaveBeenCalledWith("traxo", { action: "edit", id: "e1", dueDate: TOMORROW });
    await screen.findByRole("heading", { level: 3, name: "This week" });
    expect(headings()).toEqual(["This week"]);
  });

  it("Save with nothing changed closes without writing", async () => {
    const user = userEvent.setup();
    m.loadTodos.mockResolvedValue(list([todo({ title: "Same", dueDate: TODAY })]));
    render(<Harness />);
    await user.click(await screen.findByRole("button", { name: /^Same/ }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(m.todoAction).not.toHaveBeenCalled();
    expect(await screen.findByText("Same")).toBeInTheDocument();
  });

  it("Drop posts drop and removes the row", async () => {
    const user = userEvent.setup();
    const t = todo({ id: "d1", title: "Old idea", dueDate: TODAY });
    m.loadTodos.mockResolvedValue(list([t, todo({ title: "Keep me", dueDate: TODAY })]));
    m.todoAction.mockResolvedValue(written({ ...t, status: "dropped" }));
    render(<Harness />);
    await user.click(await screen.findByRole("button", { name: /^Old idea/ }));
    await user.click(screen.getByRole("button", { name: "Drop" }));
    expect(m.todoAction).toHaveBeenCalledWith("traxo", { action: "drop", id: "d1" });
    await waitFor(() => expect(screen.queryByText("Old idea")).not.toBeInTheDocument());
    expect(screen.getByText("Keep me")).toBeInTheDocument();
  });

  it("a failed edit shows the error and leaves the row as it was", async () => {
    const user = userEvent.setup();
    const t = todo({ id: "f1", title: "Stays", dueDate: TODAY });
    m.loadTodos.mockResolvedValue(list([t]));
    m.todoAction.mockResolvedValue({ status: 400, body: { error: "That date is not valid" } } as never);
    render(<Harness />);
    await user.click(await screen.findByRole("button", { name: /^Stays/ }));
    await user.click(screen.getByRole("button", { name: "Tomorrow" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That date is not valid");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(headings()).toEqual(["Today"]);
  });

  it("a 404 says the to-do is gone and reloads the list", async () => {
    const user = userEvent.setup();
    const t = todo({ id: "g1", title: "Vanished", dueDate: TODAY });
    m.loadTodos.mockResolvedValueOnce(list([t]));
    m.todoAction.mockResolvedValue({ status: 404, body: { error: "gone" } } as never);
    render(<Harness />);
    await user.click(await screen.findByRole("button", { name: /^Vanished/ }));
    m.loadTodos.mockResolvedValue(list([todo({ title: "Fresh row" })]));
    await user.click(screen.getByRole("button", { name: "Drop" }));
    expect(await screen.findByText("That to-do is no longer there.")).toBeInTheDocument();
    expect(await screen.findByText("Fresh row")).toBeInTheDocument();
    expect(screen.queryByText("Vanished")).not.toBeInTheDocument();
  });

  it("Prepare me is absent without a contact and calls onPrepare with one", async () => {
    const user = userEvent.setup();
    const onPrepare = vi.fn();
    const withContact = todo({ title: "Send deck", dueDate: TODAY, contact: CONTACT });
    m.loadTodos.mockResolvedValue(list([withContact, todo({ title: "Solo job", dueDate: TODAY })]));
    render(<Harness onPrepare={onPrepare} />);
    await user.click(await screen.findByRole("button", { name: /^Solo job/ }));
    expect(screen.queryByRole("button", { name: "Prepare me" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(await screen.findByRole("button", { name: /^Send deck/ }));
    await user.click(screen.getByRole("button", { name: "Prepare me" }));
    expect(onPrepare).toHaveBeenCalledWith(withContact);
  });

  it("removing the contact sends target null", async () => {
    const user = userEvent.setup();
    const t = todo({ id: "c1", title: "With contact", dueDate: TODAY, contact: CONTACT });
    m.loadTodos.mockResolvedValue(list([t]));
    m.todoAction.mockResolvedValue(written({ ...t, contact: null }));
    render(<Harness />);
    await user.click(await screen.findByRole("button", { name: /^With contact/ }));
    await user.click(screen.getByRole("button", { name: "Remove Alex Chen" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(m.todoAction).toHaveBeenCalledWith("traxo", { action: "edit", id: "c1", target: null });
  });
});

describe("TodoPanel estate", () => {
  it("reloads when the estate changes and does not show the old estate's rows", async () => {
    m.loadTodos.mockResolvedValueOnce(list([todo({ title: "Traxo task" })]));
    const { rerender } = render(<Harness />);
    await screen.findByText("Traxo task");
    m.loadTodos.mockResolvedValue(list([todo({ title: "Zero One task" })]));
    rerender(<Harness estate={{ ...ESTATE, key: "zeroone", label: "Zero One" }} />);
    expect(await screen.findByText("Zero One task")).toBeInTheDocument();
    expect(screen.queryByText("Traxo task")).not.toBeInTheDocument();
    expect(m.loadTodos).toHaveBeenLastCalledWith("zeroone");
  });
});
