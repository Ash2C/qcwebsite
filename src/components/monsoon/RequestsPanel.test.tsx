// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { formatWhen } from "./ClaudeKeyPanel";
import RequestsPanel from "./RequestsPanel";

vi.mock("./api", () => ({
  loadRequests: vi.fn(),
  actOnRequest: vi.fn(),
}));
const m = vi.mocked(api);

const GIL = { id: "5f0c2a47-6a3e-4c1f-9d55-2f7a3c1e8b10", email: "gil@example.com", name: "Gil Hale", status: "pending" as const, customerId: null, createdAt: "2025-03-02T09:00:00Z" };
const MIA = { id: "6f0c2a47-6a3e-4c1f-9d55-2f7a3c1e8b11", email: "mia@example.com", name: "Mia Ito", status: "pending" as const, customerId: null, createdAt: "2025-03-01T09:00:00Z" };
const ANN = { id: "7f0c2a47-6a3e-4c1f-9d55-2f7a3c1e8b12", email: "ann@example.com", name: "Ann Roe", status: "approved" as const, customerId: "0b9d2a47-6a3e-4c1f-9d55-2f7a3c1e8b10", createdAt: "2025-02-01T09:00:00Z" };
const DAN = { id: "8f0c2a47-6a3e-4c1f-9d55-2f7a3c1e8b13", email: "dan@example.com", name: "Dan Poe", status: "declined" as const, customerId: null, createdAt: "2025-01-01T09:00:00Z" };
const ALL = [GIL, MIA, ANN, DAN];
const list = (requests: object[] = ALL, configured = true) => ({ status: 200, body: { requests, configured } }) as never;
const OK = { status: 200, body: { ok: true } } as never;

let onBack: ReturnType<typeof vi.fn>;
let onUnauthorized: ReturnType<typeof vi.fn>;
let onWaiting: ReturnType<typeof vi.fn>;
function view() {
  return render(<RequestsPanel onBack={onBack} onUnauthorized={onUnauthorized} onWaiting={onWaiting} />);
}
const section = (name: string) => screen.getByRole("region", { name });
const rowOf = (name: string) => screen.getByText(name).closest("li") as HTMLElement;
/** A promise the test settles itself, to look at the screen while a request is away. */
function pending<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((r) => (settle = r));
  return { promise, settle };
}

beforeEach(() => {
  vi.resetAllMocks();
  onBack = vi.fn();
  onUnauthorized = vi.fn();
  onWaiting = vi.fn();
  m.loadRequests.mockResolvedValue(list());
  m.actOnRequest.mockResolvedValue(OK);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RequestsPanel", () => {
  it("lists who is waiting first, with name, email and when, each with Approve and Decline", async () => {
    view();
    expect(screen.getByRole("heading", { name: "Requests", level: 2 })).toBeInTheDocument();
    const waiting = within(await screen.findByRole("region", { name: "Waiting" })).getAllByRole("listitem");
    expect(waiting).toHaveLength(2);
    expect(waiting[0]).toHaveTextContent("Gil Hale");
    expect(waiting[0]).toHaveTextContent("gil@example.com");
    expect(waiting[0]).toHaveTextContent(formatWhen(GIL.createdAt));
    expect(waiting[1]).toHaveTextContent("Mia Ito");
    for (const row of waiting) {
      expect(within(row).getByRole("button", { name: /^Approve/ })).toBeEnabled();
      expect(within(row).getByRole("button", { name: /^Decline/ })).toBeEnabled();
    }
    expect(within(waiting[0]).getByRole("button", { name: "Approve Gil Hale" })).toHaveTextContent(/^Approve$/);
    expect(onWaiting).toHaveBeenLastCalledWith(2);
    // Waiting comes before the other two lists.
    const titles = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(titles).toEqual(["Waiting", "Approved", "Declined"]);
    expect(screen.queryByText("New sign-ups are off until the shared database is set.")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("lists approved and declined below; only declined rows have Re-open", async () => {
    view();
    const approved = within(await screen.findByRole("region", { name: "Approved" }));
    expect(approved.getByText("Ann Roe")).toBeInTheDocument();
    expect(approved.getByText("ann@example.com")).toBeInTheDocument();
    expect(approved.queryByRole("button")).not.toBeInTheDocument();
    const declined = within(section("Declined"));
    expect(declined.getByText("Dan Poe")).toBeInTheDocument();
    expect(declined.getByRole("button", { name: "Re-open Dan Poe" })).toHaveTextContent(/^Re-open$/);
    expect(declined.queryByRole("button", { name: /Approve|Decline/ })).not.toBeInTheDocument();
  });

  it("says so when nobody is waiting, and leaves out empty lists", async () => {
    m.loadRequests.mockResolvedValue(list([ANN]));
    view();
    expect(await screen.findByText("No requests waiting.")).toBeInTheDocument();
    expect(onWaiting).toHaveBeenLastCalledWith(0);
    expect(screen.getByRole("region", { name: "Approved" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Declined" })).not.toBeInTheDocument();
  });

  describe("the free trial key", () => {
    const withTrialKey = (trialKey: string) => ({ status: 200, body: { requests: ALL, configured: true, trialKey } }) as never;
    const REFUSED = "The free trial key was refused. New clients have no AI until it is replaced.";
    const NO_CREDIT = "The free trial key is out of credit. Trial clients have no AI until credit is added.";
    const UNSET = "No free trial key is set. New clients start without AI.";

    it.each([
      ["key_rejected", REFUSED],
      ["no_credit", NO_CREDIT],
    ])("warns above the list when it is %s", async (trialKey, line) => {
      m.loadRequests.mockResolvedValue(withTrialKey(trialKey));
      view();
      const warning = await screen.findByText(line);
      expect(warning).toHaveAttribute("role", "alert");
      expect(warning.compareDocumentPosition(section("Waiting")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(within(rowOf("Gil Hale")).getByRole("button", { name: /^Approve/ })).toBeEnabled();
    });

    it("notes plainly, above the list, when none is set", async () => {
      m.loadRequests.mockResolvedValue(withTrialKey("unset"));
      view();
      const note = await screen.findByText(UNSET);
      expect(note).not.toHaveAttribute("role", "alert");
      expect(note.compareDocumentPosition(section("Waiting")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("says nothing when it is working, or when the reply says something else", async () => {
      for (const trialKey of ["ok", "sk-ant-not-a-status", ""]) {
        m.loadRequests.mockResolvedValue(withTrialKey(trialKey));
        view();
        await screen.findByRole("region", { name: "Waiting" });
        for (const line of [REFUSED, NO_CREDIT, UNSET]) expect(screen.queryByText(line)).not.toBeInTheDocument();
        expect(screen.queryByText(/sk-ant/)).not.toBeInTheDocument();
        cleanup();
      }
    });
  });

  it("says new sign-ups are off when the shared database is not set, above the list, and Approve is off", async () => {
    m.loadRequests.mockResolvedValue(list(ALL, false));
    view();
    const note = await screen.findByText("New sign-ups are off until the shared database is set.");
    expect(note).toHaveAttribute("role", "status");
    expect(note.compareDocumentPosition(section("Waiting")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(rowOf("Gil Hale")).getByRole("button", { name: /^Approve/ })).toBeDisabled();
    expect(within(rowOf("Gil Hale")).getByRole("button", { name: /^Decline/ })).toBeEnabled();
  });

  it("Approve says it is setting up their CRM with every button off, then reloads the list", async () => {
    const user = userEvent.setup();
    const away = pending<never>();
    m.actOnRequest.mockReturnValue(away.promise);
    view();
    await screen.findByRole("region", { name: "Waiting" });
    await user.click(within(rowOf("Gil Hale")).getByRole("button", { name: /^Approve/ }));
    expect(m.actOnRequest).toHaveBeenCalledTimes(1);
    expect(m.actOnRequest).toHaveBeenCalledWith(GIL.id, "approve");
    expect(screen.getByRole("status")).toHaveTextContent("Setting up their CRM...");
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
    expect(screen.getAllByRole("button").length).toBeGreaterThanOrEqual(6);

    m.loadRequests.mockResolvedValue(list([MIA, { ...GIL, status: "approved" }, ANN, DAN]));
    away.settle(OK);
    await waitFor(() => expect(within(section("Approved")).getByText("Gil Hale")).toBeInTheDocument());
    expect(m.loadRequests).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Setting up their CRM...")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onWaiting).toHaveBeenLastCalledWith(1);
    for (const button of screen.getAllByRole("button")) expect(button).toBeEnabled();
  });

  it("a second tap while an approval runs sends nothing more", async () => {
    const user = userEvent.setup();
    const away = pending<never>();
    m.actOnRequest.mockReturnValue(away.promise);
    view();
    await screen.findByRole("region", { name: "Waiting" });
    const approve = within(rowOf("Gil Hale")).getByRole("button", { name: /^Approve/ });
    await user.dblClick(approve);
    await user.click(within(rowOf("Mia Ito")).getByRole("button", { name: /^Approve/ }));
    expect(m.actOnRequest).toHaveBeenCalledTimes(1);
    away.settle(OK);
    await waitFor(() => expect(m.loadRequests).toHaveBeenCalledTimes(2));
  });

  it("on 409 says it is already being set up, and reloads", async () => {
    const user = userEvent.setup();
    m.actOnRequest.mockResolvedValue({ status: 409, body: { error: "This request is being approved right now." } } as never);
    view();
    await screen.findByRole("region", { name: "Waiting" });
    await user.click(within(rowOf("Gil Hale")).getByRole("button", { name: /^Approve/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/^Already being set up\. Check again in a moment\.$/);
    await waitFor(() => expect(m.loadRequests).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("This request is being approved right now.")).not.toBeInTheDocument();
    await waitFor(() => expect(within(rowOf("Gil Hale")).getByRole("button", { name: /^Approve/ })).toBeEnabled());
  });

  it("on any other failure says it could not finish, never the server's words, and reloads", async () => {
    const user = userEvent.setup();
    view();
    await screen.findByRole("region", { name: "Waiting" });
    const replies = [
      { status: 502, body: { error: "postgres://u:pw@h" } },
      { status: 503, body: { error: "Sign-ups are not set up" } },
      { status: 404, body: { error: "No such request" } },
      { status: 400, body: null },
    ];
    let loads = 1;
    for (const res of replies) {
      m.actOnRequest.mockResolvedValue(res as never);
      await user.click(within(rowOf("Gil Hale")).getByRole("button", { name: /^Approve/ }));
      expect(await screen.findByRole("alert")).toHaveTextContent(/^Could not finish\. Try again\.$/);
      loads += 1;
      await waitFor(() => expect(m.loadRequests).toHaveBeenCalledTimes(loads));
      await waitFor(() => expect(within(rowOf("Gil Hale")).getByRole("button", { name: /^Approve/ })).toBeEnabled());
    }
    expect(screen.queryByText(/postgres|not set up|No such/)).not.toBeInTheDocument();

    m.actOnRequest.mockRejectedValue(new Error("net"));
    await user.click(within(rowOf("Gil Hale")).getByRole("button", { name: /^Approve/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not finish. Try again.");
    await waitFor(() => expect(m.loadRequests).toHaveBeenCalledTimes(loads + 1));
  });

  it("a new action clears the last failure line", async () => {
    const user = userEvent.setup();
    m.actOnRequest.mockResolvedValueOnce({ status: 502, body: null } as never);
    view();
    await screen.findByRole("region", { name: "Waiting" });
    await user.click(within(rowOf("Gil Hale")).getByRole("button", { name: /^Approve/ }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await waitFor(() => expect(within(rowOf("Gil Hale")).getByRole("button", { name: /^Approve/ })).toBeEnabled());
    await user.click(within(rowOf("Gil Hale")).getByRole("button", { name: /^Approve/ }));
    await waitFor(() => expect(m.loadRequests).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("Decline asks first; saying no sends nothing", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    view();
    await screen.findByRole("region", { name: "Waiting" });
    await user.click(within(rowOf("Mia Ito")).getByRole("button", { name: /^Decline/ }));
    expect(confirm).toHaveBeenCalledWith("Decline this request?");
    expect(m.actOnRequest).not.toHaveBeenCalled();
    expect(m.loadRequests).toHaveBeenCalledTimes(1);
  });

  it("Decline, once confirmed, declines that request and reloads; it never says a CRM is being set up", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const away = pending<never>();
    m.actOnRequest.mockReturnValue(away.promise);
    view();
    await screen.findByRole("region", { name: "Waiting" });
    await user.click(within(rowOf("Mia Ito")).getByRole("button", { name: /^Decline/ }));
    expect(m.actOnRequest).toHaveBeenCalledWith(MIA.id, "decline");
    expect(screen.queryByText("Setting up their CRM...")).not.toBeInTheDocument();
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
    m.loadRequests.mockResolvedValue(list([GIL, ANN, { ...MIA, status: "declined" }, DAN]));
    away.settle(OK);
    await waitFor(() => expect(within(section("Declined")).getByText("Mia Ito")).toBeInTheDocument());
    expect(onWaiting).toHaveBeenLastCalledWith(1);
  });

  it("Re-open puts a declined request back without asking, and reloads", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm");
    view();
    await screen.findByRole("region", { name: "Declined" });
    m.loadRequests.mockResolvedValue(list([GIL, MIA, { ...DAN, status: "pending" }, ANN]));
    await user.click(screen.getByRole("button", { name: "Re-open Dan Poe" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(m.actOnRequest).toHaveBeenCalledWith(DAN.id, "reopen");
    await waitFor(() => expect(within(section("Waiting")).getByText("Dan Poe")).toBeInTheDocument());
    expect(screen.queryByRole("region", { name: "Declined" })).not.toBeInTheDocument();
    expect(onWaiting).toHaveBeenLastCalledWith(3);
  });

  it("a decline or re-open the server refuses says it could not finish, and reloads", async () => {
    const user = userEvent.setup();
    m.actOnRequest.mockResolvedValue({ status: 409, body: { error: "That request has already changed. Refresh and try again." } } as never);
    view();
    await screen.findByRole("region", { name: "Declined" });
    await user.click(screen.getByRole("button", { name: "Re-open Dan Poe" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/^Could not finish\. Try again\.$/);
    await waitFor(() => expect(m.loadRequests).toHaveBeenCalledTimes(2));
  });

  it("a 401 hands over to the passcode screen: on load and on an action", async () => {
    const user = userEvent.setup();
    m.loadRequests.mockResolvedValueOnce({ status: 401, body: { error: "unauthorized" } });
    view();
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    cleanup();

    view();
    await screen.findByRole("region", { name: "Waiting" });
    m.actOnRequest.mockResolvedValue({ status: 401, body: { error: "unauthorized" } });
    await user.click(within(rowOf("Gil Hale")).getByRole("button", { name: /^Approve/ }));
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(m.loadRequests).toHaveBeenCalledTimes(2);
  });

  it("a list that will not load says so and offers Try again", async () => {
    const user = userEvent.setup();
    m.loadRequests.mockResolvedValueOnce({ status: 502, body: { error: "Could not reach the accounts database" } });
    view();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load. Check signal.");
    expect(onWaiting).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("region", { name: "Waiting" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    cleanup();
    m.loadRequests.mockRejectedValueOnce(new Error("net"));
    view();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load. Check signal.");
    // A 404 (not the approver) is the same plain line: nothing is shown.
    cleanup();
    m.loadRequests.mockResolvedValueOnce({ status: 404, body: { error: "Not found" } });
    view();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load. Check signal.");
  });

  it("when the reload after an action fails, the list stays and a line says it may be out of date", async () => {
    const user = userEvent.setup();
    view();
    await screen.findByRole("region", { name: "Waiting" });
    m.loadRequests.mockRejectedValue(new Error("net"));
    await user.click(screen.getByRole("button", { name: "Re-open Dan Poe" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load. Check signal.");
    expect(screen.getByText("Gil Hale")).toBeInTheDocument();
    m.loadRequests.mockResolvedValue(list([GIL]));
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByText("Dan Poe")).not.toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("Back goes back, and the buttons are at least 44px tall", async () => {
    const user = userEvent.setup();
    view();
    await screen.findByRole("region", { name: "Waiting" });
    for (const button of screen.getAllByRole("button")) expect(button.className).toMatch(/min-h-\[(44|46|52)px\]/);
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("a reply that lands after the screen is gone calls nobody", async () => {
    const away = pending<never>();
    m.loadRequests.mockReturnValue(away.promise);
    const { unmount } = view();
    unmount();
    away.settle({ status: 401, body: { error: "unauthorized" } } as never);
    await Promise.resolve();
    await Promise.resolve();
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(onWaiting).not.toHaveBeenCalled();
  });
});
