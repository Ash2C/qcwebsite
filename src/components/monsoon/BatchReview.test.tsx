// @vitest-environment jsdom
import React, { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BatchReview, { makeBatch, type Batch } from "./BatchReview";
import * as api from "./api";
import type { EstateInfo } from "./api";

vi.mock("./api", () => ({ saveCard: vi.fn(), refineCard: vi.fn() }));
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

let setBatchOutside: React.Dispatch<React.SetStateAction<Batch>>;

function Harness({ cards, handlers }: { cards: ReturnType<typeof cardOf>[]; handlers: Handlers }) {
  const [batch, setBatch] = useState<Batch>(() => makeBatch(cards, "lp_prospect", "met at demo day"));
  setBatchOutside = setBatch;
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

  describe("spoken notes", () => {
    const refined = (fields: Record<string, string>, notes: string) =>
      ({ status: 200, body: { fields, notes } }) as never;
    const JANE_FIELDS = { name: "Jane Tan", title: "", org: "Acme Capital", email: "", phone: "", linkedin: "" };

    async function speak(user: ReturnType<typeof userEvent.setup>, text: string) {
      await user.click(screen.getByRole("button", { name: "Speak notes" }));
      await user.type(screen.getByPlaceholderText("Tap the microphone on the keyboard and talk"), text);
      await user.click(screen.getByRole("button", { name: "Apply" }));
    }

    it("spoken notes on one card change only that card", async () => {
      const user = userEvent.setup();
      m.refineCard.mockResolvedValue(refined({ ...JANE_FIELDS, title: "CIO" }, "Now CIO.\nCall next week."));
      m.saveCard.mockResolvedValue(added);
      show([JANE, BOB]);
      await open(user, "Jane Tan");
      await speak(user, "she is CIO");
      expect(m.refineCard).toHaveBeenCalledWith({
        fields: JANE_FIELDS,
        notes: "met at demo day",
        spoken: "she is CIO",
      });
      await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("CIO"));
      expect(screen.getByLabelText("Card notes")).toHaveValue("Now CIO.\nCall next week.");
      expect(screen.getByText("was empty")).toBeInTheDocument();
      expect(screen.getByLabelText("Title").closest("[data-changed]")).not.toBeNull();
      expect(m.saveCard).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "Save all (2)" }));
      await screen.findByText("2 saved to Traxo.");
      const [jane, bob] = m.saveCard.mock.calls.map((c) => c[0]);
      expect(jane.fields.title).toBe("CIO");
      expect(jane.fields.notes).toBe("Now CIO.\nCall next week.");
      expect(bob.fields.title).toBe("");
      expect(bob.fields.notes).toBe("met at demo day");
    });

    it("Undo on a card restores it", async () => {
      const user = userEvent.setup();
      m.refineCard.mockResolvedValue(refined({ ...JANE_FIELDS, title: "CIO" }, "Now CIO."));
      show([JANE]);
      await open(user, "Jane Tan");
      await speak(user, "she is CIO");
      await user.click(await screen.findByRole("button", { name: "Undo" }));
      expect(screen.getByLabelText("Title")).toHaveValue("");
      expect(screen.getByLabelText("Card notes")).toHaveValue("");
      expect(screen.getByLabelText("Card notes")).toHaveAttribute("placeholder", "Same as batch");
      expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
      expect(screen.queryByText("was empty")).toBeNull();
    });

    it("editing a highlighted field by hand clears only its highlight", async () => {
      const user = userEvent.setup();
      m.refineCard.mockResolvedValue(refined({ ...JANE_FIELDS, title: "CIO", org: "Acme Group" }, "Now CIO."));
      show([JANE]);
      await open(user, "Jane Tan");
      await speak(user, "x");
      await screen.findByText("was: Acme Capital");
      await user.type(screen.getByLabelText("Title"), "!");
      expect(screen.getByLabelText("Title").closest("[data-changed]")).toBeNull();
      expect(screen.getByLabelText("Company").closest("[data-changed]")).not.toBeNull();
      expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    });

    it("applying returns a needs row to pending", async () => {
      const user = userEvent.setup();
      m.saveCard.mockResolvedValue({ status: 200, body: { outcome: "ambiguous", count: 2 } } as never);
      m.refineCard.mockResolvedValue(refined({ ...JANE_FIELDS, org: "Acme Group" }, "met at demo day"));
      show([JANE]);
      await user.click(screen.getByRole("button", { name: "Save all (1)" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Save all (0)" })).toBeDisabled());
      await open(user, "Jane Tan");
      await speak(user, "company is Acme Group");
      expect(await screen.findByRole("button", { name: "Save all (1)" })).toBeEnabled();
    });

    it("a saved card offers no Speak notes, and an unsaved one is disabled during a save", async () => {
      const user = userEvent.setup();
      let resolve!: (v: never) => void;
      m.saveCard.mockImplementationOnce(() => new Promise((r) => (resolve = r as never)));
      show([JANE]);
      await open(user, "Jane Tan");
      await user.click(screen.getByRole("button", { name: "Save all (1)" }));
      expect(screen.getByRole("button", { name: "Speak notes" })).toBeDisabled();
      resolve(added);
      await screen.findByText("1 saved to Traxo.");
      expect(screen.queryByRole("button", { name: "Speak notes" })).toBeNull();
    });

    it("a second apply followed by Undo restores the original card", async () => {
      const user = userEvent.setup();
      m.refineCard
        .mockResolvedValueOnce(refined({ ...JANE_FIELDS, title: "CIO" }, "Now CIO."))
        .mockResolvedValueOnce(refined({ ...JANE_FIELDS, title: "CEO" }, "Now CEO."));
      show([JANE]);
      await open(user, "Jane Tan");
      await speak(user, "first");
      await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("CIO"));
      await speak(user, "second");
      await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("CEO"));
      expect(m.refineCard).toHaveBeenLastCalledWith({
        fields: { ...JANE_FIELDS, title: "CIO" },
        notes: "Now CIO.",
        spoken: "second",
      });
      await user.click(screen.getByRole("button", { name: "Undo" }));
      expect(screen.getByLabelText("Title")).toHaveValue("");
      expect(screen.getByLabelText("Card notes")).toHaveValue("");
      expect(screen.getByLabelText("Card notes")).toHaveAttribute("placeholder", "Same as batch");
    });

    it("locks the card, Save all, Remove and Discard while a tidy is pending", async () => {
      const user = userEvent.setup();
      let resolve!: (v: never) => void;
      m.refineCard.mockImplementation(() => new Promise((r) => (resolve = r as never)));
      show([JANE, BOB]);
      await open(user, "Jane Tan");
      await user.click(screen.getByRole("button", { name: "Speak notes" }));
      await user.type(screen.getByPlaceholderText("Tap the microphone on the keyboard and talk"), "x");
      await user.click(screen.getByRole("button", { name: "Apply" }));
      await waitFor(() => expect(m.refineCard).toHaveBeenCalled());
      expect(screen.getByRole("button", { name: "Save all (2)" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Discard batch" })).toBeDisabled();
      expect(screen.getByLabelText("Title")).toHaveAttribute("readonly");
      expect(screen.getByLabelText("Card notes")).toHaveAttribute("readonly");
      resolve(refined(JANE_FIELDS, "tidy") as never);
      await waitFor(() => expect(screen.getByRole("button", { name: "Save all (2)" })).toBeEnabled());
      expect(screen.getByRole("button", { name: "Discard batch" })).toBeEnabled();
      expect(screen.getByLabelText("Title")).not.toHaveAttribute("readonly");
    });

    it("a tidy result for a row that has become saved is ignored", async () => {
      const user = userEvent.setup();
      let resolve!: (v: never) => void;
      m.refineCard.mockImplementation(() => new Promise((r) => (resolve = r as never)));
      show([JANE]);
      await open(user, "Jane Tan");
      await user.click(screen.getByRole("button", { name: "Speak notes" }));
      await user.type(screen.getByPlaceholderText("Tap the microphone on the keyboard and talk"), "x");
      await user.click(screen.getByRole("button", { name: "Apply" }));
      await waitFor(() => expect(m.refineCard).toHaveBeenCalled());
      // The lock stops the UI saving; mark the row saved from outside to prove the guard alone.
      act(() => setBatchOutside((b) => ({ ...b, rows: b.rows.map((r) => ({ ...r, status: "saved" as const })) })));
      resolve(refined({ ...JANE_FIELDS, title: "CIO" }, "Now CIO.") as never);
      await waitFor(() => expect(m.refineCard).toHaveBeenCalledTimes(1));
      await act(async () => {});
      expect(screen.getByLabelText("Title")).toHaveValue("");
      expect(screen.getByLabelText("Card notes")).toHaveValue("");
      expect(screen.queryByText("was empty")).toBeNull();
      expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    });

    it("a saved card no longer shows highlights or was text", async () => {
      const user = userEvent.setup();
      m.refineCard.mockResolvedValue(refined({ ...JANE_FIELDS, title: "CIO" }, "Now CIO."));
      m.saveCard.mockResolvedValue(added);
      show([JANE]);
      await open(user, "Jane Tan");
      await speak(user, "x");
      await screen.findByText("was empty");
      await user.click(screen.getByRole("button", { name: "Save all (1)" }));
      await screen.findByText("1 saved to Traxo.");
      expect(screen.queryByText("was empty")).toBeNull();
      expect(screen.getByLabelText("Title")).toHaveValue("CIO");
      expect(screen.getByLabelText("Title").closest("[data-changed]")).toBeNull();
    });

    it("a hand edit made while the tidy ran is not overwritten by an unchanged field", async () => {
      const user = userEvent.setup();
      let resolve!: (v: never) => void;
      m.refineCard.mockImplementation(() => new Promise((r) => (resolve = r as never)));
      show([JANE]);
      await open(user, "Jane Tan");
      await user.click(screen.getByRole("button", { name: "Speak notes" }));
      await user.type(screen.getByPlaceholderText("Tap the microphone on the keyboard and talk"), "x");
      await user.click(screen.getByRole("button", { name: "Apply" }));
      await waitFor(() => expect(m.refineCard).toHaveBeenCalled());
      fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Chief" } });
      resolve(refined({ ...JANE_FIELDS, org: "Acme Group" }, "Tidy.") as never);
      await waitFor(() => expect(screen.getByLabelText("Company")).toHaveValue("Acme Group"));
      expect(screen.getByLabelText("Title")).toHaveValue("Chief");
    });
  });
});
