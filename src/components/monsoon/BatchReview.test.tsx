// @vitest-environment jsdom
import React, { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BatchReview, { makeBatch, type Batch } from "./BatchReview";
import * as api from "./api";
import type { EstateInfo } from "./api";

vi.mock("./api", () => ({ saveCard: vi.fn() }));
const m = vi.mocked(api);

const ESTATE: EstateInfo = {
  key: "traxo",
  label: "Traxo",
  defaultRole: "lp_prospect",
  available: true,
  roles: [
    { key: "lp_prospect", label: "LP prospect" },
    { key: "introducer", label: "Introducer" },
  ],
};

function cardOf(name: string, org = "", email = "") {
  return { name, title: "", org, email, phone: "", linkedin: "", raw_text: name };
}
const JANE = cardOf("Jane Tan", "Acme Capital");
const BOB = cardOf("Bob Lee", "", "bob@x.com");
const CY = cardOf("Cy Wu", "Wu Co");

type Handlers = { onUnauthorized: () => void; onClose: (s: string | null) => void };

function Harness({ cards, handlers }: { cards: ReturnType<typeof cardOf>[]; handlers: Handlers }) {
  const [batch, setBatch] = useState<Batch>(() => makeBatch(cards, "lp_prospect", "met at demo day"));
  return (
    <BatchReview
      estate={ESTATE}
      batch={batch}
      onChange={(next) => setBatch((prev) => (typeof next === "function" ? next(prev) : next))}
      onUnauthorized={handlers.onUnauthorized}
      onClose={handlers.onClose}
    />
  );
}

let handlers: Handlers;
function show(cards = [JANE, BOB, CY]) {
  render(<Harness cards={cards} handlers={handlers} />);
}

const added = { status: 200, body: { outcome: "added", person: "p", org: null } } as never;

beforeEach(() => {
  vi.resetAllMocks();
  handlers = { onUnauthorized: vi.fn(), onClose: vi.fn() };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function row(text: string) {
  return screen.getByRole("button", { name: new RegExp(text) });
}

async function open(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.click(row(text));
}

describe("BatchReview", () => {
  it("lists one row per card with the batch role and note", () => {
    show();
    expect(screen.getByText("3 cards found")).toBeInTheDocument();
    expect(screen.getByText("Jane Tan · Acme Capital")).toBeInTheDocument();
    expect(screen.getByText("Bob Lee · bob@x.com")).toBeInTheDocument();
    expect(screen.getByLabelText("Role")).toHaveValue("lp_prospect");
    expect(screen.getByLabelText("Note")).toHaveValue("met at demo day");
  });

  it("a nameless card is flagged and not counted", () => {
    show([JANE, cardOf("", "", "x@y.com"), CY]);
    expect(screen.getByText("(no name) · x@y.com")).toBeInTheDocument();
    expect(screen.getByText("Add a name")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save all (2)" })).toBeEnabled();
  });

  it("Save all saves each eligible card once, in order, with its own captureId", async () => {
    const user = userEvent.setup();
    const resolvers: ((v: never) => void)[] = [];
    m.saveCard.mockImplementation(() => new Promise((res) => resolvers.push(res as never)));
    show();
    await user.click(screen.getByRole("button", { name: "Save all (3)" }));
    expect(m.saveCard).toHaveBeenCalledTimes(1);
    resolvers[0](added);
    await waitFor(() => expect(m.saveCard).toHaveBeenCalledTimes(2));
    resolvers[1](added);
    await waitFor(() => expect(m.saveCard).toHaveBeenCalledTimes(3));
    resolvers[2](added);
    await screen.findByText("3 saved to Traxo.");
    const bodies = m.saveCard.mock.calls.map((c) => c[0]);
    expect(bodies.map((b) => b.fields.name)).toEqual(["Jane Tan", "Bob Lee", "Cy Wu"]);
    expect(new Set(bodies.map((b) => b.captureId)).size).toBe(3);
    for (const b of bodies) {
      expect(b.estate).toBe("traxo");
      expect(b.role).toBe("lp_prospect");
      expect(b.fields.notes).toBe("met at demo day");
    }
    expect(bodies[0].extracted).toEqual(JANE);
  });

  it("per-card role and note override the batch values", async () => {
    const user = userEvent.setup();
    m.saveCard.mockResolvedValue(added);
    show([JANE, BOB]);
    await open(user, "Jane Tan");
    await user.selectOptions(screen.getByLabelText("Card role"), "introducer");
    await user.type(screen.getByPlaceholderText("Same as batch"), "her own note");
    await user.click(screen.getByRole("button", { name: "Save all (2)" }));
    await screen.findByText("2 saved to Traxo.");
    expect(m.saveCard.mock.calls[0][0]).toMatchObject({ role: "introducer", fields: { notes: "her own note" } });
    expect(m.saveCard.mock.calls[1][0]).toMatchObject({ role: "lp_prospect", fields: { notes: "met at demo day" } });
  });

  it("a lookalike on one card does not block the rest", async () => {
    const user = userEvent.setup();
    m.saveCard
      .mockResolvedValueOnce(added)
      .mockResolvedValueOnce({ status: 200, body: { outcome: "org_lookalike", similar: ["Wu Company"] } } as never)
      .mockResolvedValueOnce(added);
    show([JANE, CY, BOB]);
    await user.click(screen.getByRole("button", { name: "Save all (3)" }));
    await screen.findByText("Wu Co looks like Wu Company, already on file.");
    expect(m.saveCard).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Jane Tan added to Traxo.")).toBeInTheDocument();
    expect(screen.getByText("Bob Lee added to Traxo.")).toBeInTheDocument();
    const firstCaptureId = m.saveCard.mock.calls[1][0].captureId;

    m.saveCard.mockResolvedValueOnce(added);
    await user.click(screen.getByRole("button", { name: "Use Wu Company" }));
    await screen.findByText("Cy Wu added to Traxo.");
    expect(m.saveCard).toHaveBeenCalledTimes(4);
    const body = m.saveCard.mock.calls[3][0];
    expect(body.fields.org).toBe("Wu Company");
    expect(body.captureId).toBe(firstCaptureId);
    expect(body.newOrg).toBeUndefined();
  });

  it("a lookalike answered with a different company sends newOrg", async () => {
    const user = userEvent.setup();
    m.saveCard
      .mockResolvedValueOnce({ status: 200, body: { outcome: "org_lookalike", similar: ["Wu Company"] } } as never)
      .mockResolvedValueOnce(added);
    show([CY]);
    await user.click(screen.getByRole("button", { name: "Save all (1)" }));
    await user.click(await screen.findByRole("button", { name: "It's a different company" }));
    await screen.findByText("1 saved to Traxo.");
    expect(m.saveCard.mock.calls[1][0].newOrg).toBe(true);
    expect(m.saveCard.mock.calls[1][0].captureId).toBe(m.saveCard.mock.calls[0][0].captureId);
  });

  it("same name on one card: Same person re-saves with the id, Different person with false", async () => {
    const user = userEvent.setup();
    const same = {
      status: 200,
      body: { outcome: "same_name", matches: [{ personId: "pid-1", org: "Old Co" }] },
    } as never;
    m.saveCard.mockResolvedValueOnce(same).mockResolvedValueOnce(added);
    show([JANE]);
    await user.click(screen.getByRole("button", { name: "Save all (1)" }));
    await screen.findByText("Jane Tan is already on file at Old Co. Same person?");
    await user.click(screen.getByRole("button", { name: "Same person (Old Co)" }));
    await screen.findByText("1 saved to Traxo.");
    expect(m.saveCard.mock.calls[1][0].samePerson).toBe("pid-1");
    cleanup();

    m.saveCard.mockReset();
    m.saveCard.mockResolvedValueOnce(same).mockResolvedValueOnce(added);
    show([JANE]);
    await user.click(screen.getByRole("button", { name: "Save all (1)" }));
    await user.click(await screen.findByRole("button", { name: "Different person" }));
    await screen.findByText("1 saved to Traxo.");
    expect(m.saveCard.mock.calls[1][0].samePerson).toBe(false);
  });

  it("an ambiguous card needs the company: message, no buttons", async () => {
    const user = userEvent.setup();
    m.saveCard.mockResolvedValue({ status: 200, body: { outcome: "ambiguous", count: 2 } } as never);
    show([BOB]);
    await user.click(screen.getByRole("button", { name: "Save all (1)" }));
    await screen.findByText("Several people are named Bob Lee. Add the company to say which one.");
    expect(screen.queryByRole("button", { name: /Same person|Different/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Save all (0)" })).toBeDisabled();
    await open(user, "Bob Lee");
    await user.type(screen.getByLabelText("Company"), "X");
    expect(screen.getByRole("button", { name: "Save all (1)" })).toBeEnabled();
  });

  it('a failed card shows "Could not save. Retry." and the next Save all retries only it', async () => {
    const user = userEvent.setup();
    m.saveCard
      .mockResolvedValueOnce(added)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ status: 500, body: { error: "x" } } as never)
      .mockResolvedValueOnce(added);
    show([JANE, BOB, CY]);
    await user.click(screen.getByRole("button", { name: "Save all (3)" }));
    await waitFor(() => expect(screen.getAllByText("Could not save. Retry.")).toHaveLength(2));
    expect(m.saveCard).toHaveBeenCalledTimes(3);
    m.saveCard.mockReset();
    m.saveCard.mockResolvedValueOnce(added).mockResolvedValueOnce(added);
    await user.click(screen.getByRole("button", { name: "Save all (2)" }));
    await screen.findByText("3 saved to Traxo.");
    expect(m.saveCard).toHaveBeenCalledTimes(2);
    expect(m.saveCard.mock.calls.map((c) => c[0].fields.name)).toEqual(["Bob Lee", "Cy Wu"]);
  });

  it("a 400 shows the server's error on that row", async () => {
    const user = userEvent.setup();
    m.saveCard.mockResolvedValue({ status: 400, body: { error: "Email looks wrong" } } as never);
    show([JANE]);
    await user.click(screen.getByRole("button", { name: "Save all (1)" }));
    expect(await screen.findByText("Email looks wrong")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save all (1)" })).toBeEnabled();
  });

  it("Save all is ignored while a batch save is running", async () => {
    const user = userEvent.setup();
    let release: (v: never) => void = () => {};
    m.saveCard.mockImplementation(() => new Promise((res) => (release = res as never)));
    show([JANE, BOB]);
    const button = screen.getByRole("button", { name: "Save all (2)" });
    await user.click(button);
    await user.click(screen.getByRole("button", { name: "Saving…" }));
    expect(m.saveCard).toHaveBeenCalledTimes(1);
    m.saveCard.mockResolvedValue(added);
    release(added);
    await screen.findByText("2 saved to Traxo.");
    expect(m.saveCard).toHaveBeenCalledTimes(2);
  });

  it("a 401 stops the batch and calls onUnauthorized", async () => {
    const user = userEvent.setup();
    m.saveCard
      .mockResolvedValueOnce(added)
      .mockResolvedValueOnce({ status: 401, body: { error: "unauthorized" } } as never);
    show();
    await user.click(screen.getByRole("button", { name: "Save all (3)" }));
    await waitFor(() => expect(handlers.onUnauthorized).toHaveBeenCalledTimes(1));
    expect(m.saveCard).toHaveBeenCalledTimes(2);
    // Jane saved; Bob (401) and Cy untouched, so both are still eligible.
    expect(screen.getByRole("button", { name: "Save all (2)" })).toBeEnabled();
  });

  it("editing a needs row makes it pending again and clears its buttons", async () => {
    const user = userEvent.setup();
    m.saveCard.mockResolvedValue({ status: 200, body: { outcome: "org_lookalike", similar: ["Wu Company"] } } as never);
    show([CY]);
    await user.click(screen.getByRole("button", { name: "Save all (1)" }));
    await screen.findByRole("button", { name: "Use Wu Company" });
    expect(screen.getByRole("button", { name: "Save all (0)" })).toBeDisabled();
    await open(user, "Cy Wu");
    await user.type(screen.getByLabelText("Company"), "x");
    expect(screen.queryByRole("button", { name: "Use Wu Company" })).toBeNull();
    expect(screen.queryByText(/looks like/)).toBeNull();
    expect(screen.getByRole("button", { name: "Save all (1)" })).toBeEnabled();
  });

  it("removing a card drops it; a saved card cannot be removed", async () => {
    const user = userEvent.setup();
    m.saveCard.mockResolvedValueOnce(added).mockResolvedValueOnce({ status: 400, body: { error: "bad" } } as never);
    show([JANE, BOB]);
    await open(user, "Bob Lee");
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByText("1 cards found")).toBeInTheDocument();
    expect(screen.queryByText("Bob Lee · bob@x.com")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save all (1)" }));
    await screen.findByText("1 saved to Traxo.");
    await open(user, "Jane Tan");
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.getByLabelText("Name")).toHaveAttribute("readonly");
  });

  it('shows "<k> saved to Traxo." and Done when every remaining card is saved', async () => {
    const user = userEvent.setup();
    m.saveCard.mockResolvedValue(added);
    show([JANE, BOB]);
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save all (2)" }));
    expect(await screen.findByText("2 saved to Traxo.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(handlers.onClose).toHaveBeenCalledWith("2 saved to Traxo.");
  });

  it("Discard batch asks before dropping unsaved cards", async () => {
    const user = userEvent.setup();
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal("confirm", confirm);
    show([JANE]);
    await user.click(screen.getByRole("button", { name: "Discard batch" }));
    expect(confirm).toHaveBeenCalledWith("Discard the unsaved cards?");
    expect(handlers.onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Discard batch" }));
    expect(handlers.onClose).toHaveBeenCalledWith(null);
  });

  it("Discard batch does not ask when everything is saved", async () => {
    const user = userEvent.setup();
    const confirm = vi.fn();
    vi.stubGlobal("confirm", confirm);
    m.saveCard.mockResolvedValue(added);
    show([JANE]);
    await user.click(screen.getByRole("button", { name: "Save all (1)" }));
    await screen.findByText("1 saved to Traxo.");
    await user.click(screen.getByRole("button", { name: "Discard batch" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(handlers.onClose).toHaveBeenCalledWith(null);
  });
});

