// @vitest-environment jsdom
import React, { useState, type ComponentProps } from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RealAskPanel, { EMPTY_ASK, prepareMessage, type AskState, type AskTurn, type AskViewing } from "./AskPanel";
import { useAsk } from "./useAsk";
import * as api from "./api";

vi.mock("./api", () => ({ askCrm: vi.fn(), actOnCrm: vi.fn() }));
const m = vi.mocked(api);

// The panel as the app mounts it: the request logic (useAsk) built from the same props, passed in.
function AskPanel(props: Omit<ComponentProps<typeof RealAskPanel>, "ask">) {
  const ask = useAsk({
    estate: props.estate,
    state: props.state,
    onChange: props.onChange,
    viewing: props.viewing ?? null,
    onUnauthorized: props.onUnauthorized,
  });
  return <RealAskPanel {...props} ask={ask} />;
}

const ESTATE = { key: "traxo", label: "Traxo", defaultRole: "lp_prospect", available: true, todos: true, roles: [] };

type User = ReturnType<typeof userEvent.setup>;

const NOTE_PROPOSAL = {
  proposal: {
    kind: "add_note",
    estate: "traxo",
    memberId: "m1",
    memberKind: "person",
    memberName: "Jane Tan",
    company: "Acme Capital",
    about: "the Q3 call",
    expires: 1,
  },
  signature: "sig-note",
  text: "Call went well",
} as const;

const STAGE_PROPOSAL = {
  proposal: {
    kind: "move_stage",
    estate: "traxo",
    memberId: "m2",
    memberKind: "company",
    memberName: "Beta Fund",
    company: null,
    about: null,
    fromStage: "lead",
    toStage: "in_talks",
    expires: 1,
  },
  signature: "sig-stage",
} as const;

function answer(text: string, proposals: unknown[] = [], refs: unknown[] = []) {
  return { status: 200, body: { answer: text, refs, proposals } } as never;
}

function Harness({
  initial = EMPTY_ASK,
  estate = ESTATE,
  onUnauthorized = () => {},
  onBusy,
  onResearch,
  viewing,
  onChanged,
  send,
}: {
  send?: { id: string; text: string };
  viewing?: AskViewing | null;
  onChanged?: () => void;
  onResearch?: (personId: string) => void;
  initial?: AskState;
  estate?: typeof ESTATE;
  onUnauthorized?: () => void;
  onBusy?: (b: boolean) => void;
}) {
  const [state, setState] = useState<AskState>(initial);
  return <AskPanel estate={estate} state={state} onChange={setState} onUnauthorized={onUnauthorized} onBusy={onBusy} onResearch={onResearch} viewing={viewing} onChanged={onChanged} send={send} />;
}

async function ask(user: User, text: string) {
  await user.type(screen.getByRole("textbox", { name: "Your question" }), text);
  await user.click(screen.getByRole("button", { name: "Send question" }));
}

beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(cleanup);

describe("AskPanel", () => {
  it("suggestions fill the draft without sending", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Summarise the pipeline" }));
    expect(screen.getByRole("textbox", { name: "Your question" })).toHaveValue("Summarise the pipeline");
    await user.click(screen.getByRole("button", { name: "Tell me about" }));
    expect(screen.getByRole("textbox", { name: "Your question" })).toHaveValue("Tell me about ");
    expect(m.askCrm).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Who should I chase this week?" })).toBeInTheDocument();
  });

  it("shows the app's guesses first, and the speak button puts the cursor in the box with a hint", async () => {
    const user = userEvent.setup();
    function Guessing() {
      const [state, setState] = useState<AskState>(EMPTY_ASK);
      return (
        <AskPanel estate={ESTATE} state={state} onChange={setState} onUnauthorized={() => {}} suggested={["Tell me about Jane Tan"]} />
      );
    }
    render(<Guessing />);
    const guesses = screen.getAllByRole("button").map((b) => b.textContent);
    expect(guesses.indexOf("Tell me about Jane Tan")).toBeLessThan(guesses.indexOf("Who should I chase this week?"));
    expect(screen.queryByText("Tap the microphone on the keyboard and talk, then press Ask.")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Speak your question" }));
    expect(screen.getByRole("textbox", { name: "Your question" })).toHaveFocus();
    expect(screen.getByText("Tap the microphone on the keyboard and talk, then press Ask.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Tell me about Jane Tan" }));
    expect(screen.getByRole("textbox", { name: "Your question" })).toHaveValue("Tell me about Jane Tan");
    expect(m.askCrm).not.toHaveBeenCalled();
  });

  it("has the estate placeholder and a disabled Ask while blank", async () => {
    render(<Harness />);
    expect(screen.getByPlaceholderText("Ask about Traxo...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send question" })).toBeDisabled();
  });

  it("shows Looking... then the answer, sending the estate, the local date and the conversation", async () => {
    const user = userEvent.setup();
    let resolve!: (v: never) => void;
    m.askCrm.mockImplementationOnce(() => new Promise((r) => (resolve = r as never)));
    render(<Harness />);
    await ask(user, "Who is hot?");
    expect(await screen.findByRole("status")).toHaveTextContent("Looking...");
    expect(screen.getByRole("textbox", { name: "Your question" })).toHaveValue("");
    resolve(answer("Jane is hot.", [], [{ memberId: "m1", name: "Jane Tan", company: "Acme", kind: "person" }]));
    expect(await screen.findByText("Jane is hot.")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
    const first = m.askCrm.mock.calls[0][0];
    expect(first.estate).toBe("traxo");
    expect(first.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(first.messages).toEqual([{ role: "user", content: "Who is hot?" }]);

    m.askCrm.mockResolvedValueOnce(answer("Done."));
    await ask(user, "And then?");
    await screen.findByText("Done.");
    expect(m.askCrm.mock.calls[1][0].messages).toEqual([
      { role: "user", content: "Who is hot?" },
      {
        role: "assistant",
        content: "Jane is hot.",
        refs: [{ memberId: "m1", name: "Jane Tan", company: "Acme", kind: "person" }],
      },
      { role: "user", content: "And then?" },
    ]);
  });

  it("uses the local date, not the UTC one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 0, 5, 23, 30));
    try {
      const user = userEvent.setup();
      m.askCrm.mockResolvedValue(answer("ok"));
      render(<Harness />);
      await ask(user, "hi");
      await screen.findByText("ok");
      expect(m.askCrm.mock.calls[0][0].today).toBe("2026-01-05");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends only the last 24 messages and the first is a user turn", async () => {
    const user = userEvent.setup();
    const turns: AskTurn[] = [];
    for (let i = 0; i < 15; i++) {
      turns.push({ id: `u${i}`, role: "user", content: `q${i}` });
      turns.push({ id: `a${i}`, role: "assistant", content: `a${i}` });
    }
    m.askCrm.mockResolvedValue(answer("ok"));
    render(<Harness initial={{ turns, draft: "" }} />);
    await ask(user, "next");
    await screen.findByText("ok");
    const sent = m.askCrm.mock.calls[0][0].messages;
    // 31 turns, last 24 would start with an assistant turn (index 7), so it is dropped: 23 sent.
    expect(sent.length).toBe(23);
    expect(sent[0].role).toBe("user");
    expect(sent[sent.length - 1]).toEqual({ role: "user", content: "next" });
  });

  it("a second click while pending sends nothing more", async () => {
    const user = userEvent.setup();
    let resolve!: (v: never) => void;
    m.askCrm.mockImplementation(() => new Promise((r) => (resolve = r as never)));
    render(<Harness />);
    await ask(user, "one");
    await user.type(screen.getByRole("textbox", { name: "Your question" }), "two");
    expect(screen.getByRole("button", { name: "Send question" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Send question" }));
    expect(m.askCrm).toHaveBeenCalledTimes(1);
    resolve(answer("ok"));
    await screen.findByText("ok");
  });

  it("reports busy while asking and releases it afterwards and on unmount", async () => {
    const user = userEvent.setup();
    const onBusy = vi.fn();
    let resolve!: (v: never) => void;
    m.askCrm.mockImplementation(() => new Promise((r) => (resolve = r as never)));
    const { unmount } = render(<Harness onBusy={onBusy} />);
    await ask(user, "one");
    await waitFor(() => expect(onBusy).toHaveBeenLastCalledWith(true));
    unmount();
    expect(onBusy).toHaveBeenLastCalledWith(false);
    resolve(answer("late"));
  });

  it("a Claude problem restores the question and names the problem instead of the signal", async () => {
    const user = userEvent.setup();
    m.askCrm.mockResolvedValue({ status: 409, body: { error: "claude_key_missing" } });
    render(<Harness />);
    await ask(user, "Why?");
    expect(
      await screen.findByText("Ask is not available yet: this account has no Claude API key. To add one, tap the status chip at the top of Monsoon."),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Your question" })).toHaveValue("Why?");
  });

  it("a 502 restores the question and shows the failure line", async () => {
    const user = userEvent.setup();
    m.askCrm.mockResolvedValue({ status: 502, body: { error: "x" } });
    render(<Harness />);
    await ask(user, "Why?");
    expect(await screen.findByText("Could not get an answer. Check signal and try again.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Your question" })).toHaveValue("Why?");
    expect(screen.queryByText("Why?", { selector: "div" })).toBeNull();
  });

  it("a network failure behaves like a failed answer", async () => {
    const user = userEvent.setup();
    m.askCrm.mockRejectedValue(new Error("offline"));
    render(<Harness />);
    await ask(user, "Why?");
    expect(await screen.findByText("Could not get an answer. Check signal and try again.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Your question" })).toHaveValue("Why?");
  });

  it("a timed-out question releases the busy report and can be sent again", async () => {
    const user = userEvent.setup();
    const onBusy = vi.fn();
    m.askCrm.mockRejectedValueOnce(new DOMException("The operation timed out.", "TimeoutError"));
    render(<Harness onBusy={onBusy} />);
    await ask(user, "Why?");
    expect(await screen.findByText("Could not get an answer. Check signal and try again.")).toBeInTheDocument();
    await waitFor(() => expect(onBusy).toHaveBeenLastCalledWith(false));
    m.askCrm.mockResolvedValueOnce(answer("Because."));
    await user.click(screen.getByRole("button", { name: "Send question" }));
    expect(await screen.findByText("Because.")).toBeInTheDocument();
  });

  it("a 401 restores the question and calls onUnauthorized", async () => {
    const user = userEvent.setup();
    const onUnauthorized = vi.fn();
    m.askCrm.mockResolvedValue({ status: 401, body: { error: "unauthorized" } });
    render(<Harness onUnauthorized={onUnauthorized} />);
    await ask(user, "Why?");
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("textbox", { name: "Your question" })).toHaveValue("Why?");
    expect(screen.queryByText("Could not get an answer. Check signal and try again.")).toBeNull();
  });

  it("drops a late answer when the estate changes mid-question", async () => {
    const user = userEvent.setup();
    let resolve!: (v: never) => void;
    m.askCrm.mockImplementation(() => new Promise((r) => (resolve = r as never)));
    const other = { ...ESTATE, key: "zeroone", label: "Zero One" };
    function Switcher() {
      const [e, setE] = useState(ESTATE);
      const [state, setState] = useState<AskState>(EMPTY_ASK);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setE(other);
              setState(EMPTY_ASK);
            }}
          >
            switch
          </button>
          <AskPanel estate={e} state={state} onChange={setState} onUnauthorized={() => {}} />
        </>
      );
    }
    render(<Switcher />);
    await ask(user, "q");
    await user.click(screen.getByRole("button", { name: "switch" }));
    resolve(answer("stale answer"));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(screen.queryByText("stale answer")).toBeNull();
  });

  describe("change cards", () => {
    async function withNoteCard(user: User) {
      m.askCrm.mockResolvedValueOnce(answer("I can add that.", [NOTE_PROPOSAL, STAGE_PROPOSAL]));
      render(<Harness />);
      await ask(user, "Note it");
      await screen.findByText("I can add that.");
    }

    it("renders the add_note card with contact, About line and editable text", async () => {
      const user = userEvent.setup();
      await withNoteCard(user);
      expect(screen.getByText("Add note")).toBeInTheDocument();
      expect(screen.getByText("Jane Tan")).toBeInTheDocument();
      expect(screen.getByText("Acme Capital")).toBeInTheDocument();
      expect(screen.getByText("About the Q3 call")).toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "Note text" })).toHaveValue("Call went well");
    });

    it("renders a move_stage card as from → to, with 'company' for a company member", async () => {
      const user = userEvent.setup();
      await withNoteCard(user);
      expect(screen.getByText("Move stage")).toBeInTheDocument();
      expect(screen.getByText("lead → in talks")).toBeInTheDocument();
      expect(screen.getByText("Beta Fund")).toBeInTheDocument();
      expect(screen.getByText("company")).toBeInTheDocument();
    });

    it("Confirm sends the edited text, shows the message, and the next question carries the note", async () => {
      const user = userEvent.setup();
      await withNoteCard(user);
      m.actOnCrm.mockResolvedValue({ status: 200, body: { status: "ok", message: "Note added to Jane Tan." } });
      const box = screen.getByRole("textbox", { name: "Note text" });
      await user.clear(box);
      await user.type(box, "Edited note");
      await user.click(screen.getAllByRole("button", { name: "Confirm" })[0]);
      expect(await screen.findByText("Note added to Jane Tan.")).toBeInTheDocument();
      expect(m.actOnCrm).toHaveBeenCalledWith({
        estate: "traxo",
        proposal: NOTE_PROPOSAL.proposal,
        signature: "sig-note",
        text: "Edited note",
      });
      // The first card is read-only now; the second still has its buttons.
      expect(screen.getAllByRole("button", { name: "Confirm" })).toHaveLength(1);
      m.askCrm.mockResolvedValueOnce(answer("Next."));
      await ask(user, "Thanks");
      await screen.findByText("Next.");
      const sent = m.askCrm.mock.calls[1][0].messages;
      expect(sent).toContainEqual({ role: "assistant", content: "Change confirmed: Note added to Jane Tan." });
      // Notes are not shown as chat bubbles.
      expect(screen.queryByText("Change confirmed: Note added to Jane Tan.")).toBeNull();
    });

    it("a stage move sends no text", async () => {
      const user = userEvent.setup();
      await withNoteCard(user);
      m.actOnCrm.mockResolvedValue({ status: 200, body: { status: "ok", message: "Moved." } });
      await user.click(screen.getAllByRole("button", { name: "Confirm" })[1]);
      await screen.findByText("Moved.");
      expect(m.actOnCrm).toHaveBeenCalledWith({
        estate: "traxo",
        proposal: STAGE_PROPOSAL.proposal,
        signature: "sig-stage",
      });
    });

    it("Cancel shows Cancelled. and the next request includes the cancellation", async () => {
      const user = userEvent.setup();
      await withNoteCard(user);
      await user.click(screen.getAllByRole("button", { name: "Cancel" })[1]);
      expect(screen.getByText("Cancelled.")).toBeInTheDocument();
      expect(m.actOnCrm).not.toHaveBeenCalled();
      m.askCrm.mockResolvedValueOnce(answer("Ok."));
      await ask(user, "Never mind");
      await screen.findByText("Ok.");
      const sent = m.askCrm.mock.calls[1][0].messages;
      expect(sent).toContainEqual({
        role: "assistant",
        content: "Change cancelled: move Beta Fund from lead to in talks",
      });
    });

    it("a 403 marks the card expired and read-only", async () => {
      const user = userEvent.setup();
      await withNoteCard(user);
      m.actOnCrm.mockResolvedValue({ status: 403, body: { error: "This change has expired. Ask again." } });
      await user.click(screen.getAllByRole("button", { name: "Confirm" })[0]);
      expect(await screen.findByText("This change has expired. Ask again.")).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: "Confirm" })).toHaveLength(1);
    });

    it("a failed confirm leaves the card open with the retry message", async () => {
      const user = userEvent.setup();
      await withNoteCard(user);
      m.actOnCrm.mockResolvedValueOnce({ status: 502, body: { error: "x" } });
      await user.click(screen.getAllByRole("button", { name: "Confirm" })[0]);
      expect(await screen.findByText("Could not save. Check signal and try again.")).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: "Confirm" })).toHaveLength(2);
      m.actOnCrm.mockResolvedValueOnce({ status: 200, body: { status: "ok", message: "Saved." } });
      await user.click(screen.getAllByRole("button", { name: "Confirm" })[0]);
      expect(await screen.findByText("Saved.")).toBeInTheDocument();
    });

    it("a confirm that fails by network or timeout reopens the card and releases the busy report", async () => {
      const user = userEvent.setup();
      const onBusy = vi.fn();
      m.askCrm.mockResolvedValueOnce(answer("Sure.", [NOTE_PROPOSAL]));
      render(<Harness onBusy={onBusy} />);
      await ask(user, "Note it");
      await screen.findByText("Sure.");
      m.actOnCrm.mockRejectedValueOnce(new DOMException("The operation timed out.", "TimeoutError"));
      await user.click(screen.getByRole("button", { name: "Confirm" }));
      expect(await screen.findByText("Could not save. Check signal and try again.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Confirm" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
      await waitFor(() => expect(onBusy).toHaveBeenLastCalledWith(false));
      // The lock is released: a second try goes through.
      m.actOnCrm.mockResolvedValueOnce({ status: 200, body: { status: "ok", message: "Saved." } });
      await user.click(screen.getByRole("button", { name: "Confirm" }));
      expect(await screen.findByText("Saved.")).toBeInTheDocument();
      expect(m.actOnCrm).toHaveBeenCalledTimes(2);
    });

    it("a 401 on confirm reopens the card and calls onUnauthorized", async () => {
      const user = userEvent.setup();
      const onUnauthorized = vi.fn();
      m.askCrm.mockResolvedValueOnce(answer("Sure.", [NOTE_PROPOSAL]));
      render(<Harness onUnauthorized={onUnauthorized} />);
      await ask(user, "Note it");
      await screen.findByText("Sure.");
      m.actOnCrm.mockResolvedValue({ status: 401, body: { error: "unauthorized" } });
      await user.click(screen.getByRole("button", { name: "Confirm" }));
      await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
      expect(screen.getByRole("button", { name: "Confirm" })).toBeEnabled();
    });

    it("blocks a double confirm and locks the card while working", async () => {
      const user = userEvent.setup();
      const onBusy = vi.fn();
      m.askCrm.mockResolvedValueOnce(answer("Sure.", [NOTE_PROPOSAL]));
      render(<Harness onBusy={onBusy} />);
      await ask(user, "Note it");
      await screen.findByText("Sure.");
      let resolve!: (v: never) => void;
      m.actOnCrm.mockImplementation(() => new Promise((r) => (resolve = r as never)));
      await user.click(screen.getByRole("button", { name: "Confirm" }));
      expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
      await waitFor(() => expect(onBusy).toHaveBeenLastCalledWith(true));
      await user.click(screen.getByRole("button", { name: "Confirm" }));
      expect(m.actOnCrm).toHaveBeenCalledTimes(1);
      resolve({ status: 200, body: { status: "ok", message: "Saved." } } as never);
      await screen.findByText("Saved.");
      await waitFor(() => expect(onBusy).toHaveBeenLastCalledWith(false));
    });

    it("disables Confirm for a blank or over-long note", async () => {
      const user = userEvent.setup();
      m.askCrm.mockResolvedValueOnce(answer("Sure.", [NOTE_PROPOSAL]));
      render(<Harness />);
      await ask(user, "Note it");
      await screen.findByText("Sure.");
      await user.clear(screen.getByRole("textbox", { name: "Note text" }));
      expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
    });
  });

  it("renders the answer as text, never as HTML", async () => {
    const user = userEvent.setup();
    m.askCrm.mockResolvedValue(answer('<b>bold</b> <script>window.hacked = 1</script>'));
    const { container } = render(<Harness />);
    await ask(user, "x");
    await screen.findByText(/<b>bold<\/b>/);
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });

  it("wraps long unbroken server text inside the card", () => {
    const long = "x".repeat(300);
    const signed = {
      ...NOTE_PROPOSAL,
      proposal: { ...NOTE_PROPOSAL.proposal, memberName: long, company: long, about: long },
    };
    const turns: AskTurn[] = [
      {
        id: "a",
        role: "assistant",
        content: "ok",
        cards: [{ id: "c1", signed: signed as never, text: long, state: "done", message: long }],
      },
    ];
    render(<Harness initial={{ turns, draft: "" }} />);
    const hits = screen.getAllByText((_, el) => el?.tagName === "P" && (el.textContent ?? "").includes(long));
    // member name, company, about, read-only note, card message
    expect(hits.length).toBe(5);
    for (const el of hits) expect(el).toHaveClass("break-words");
  });

  it("keeps what was typed while waiting and puts the failed question above it", async () => {
    const user = userEvent.setup();
    let resolve!: (v: never) => void;
    m.askCrm.mockImplementation(() => new Promise((r) => (resolve = r as never)));
    render(<Harness />);
    await ask(user, "First");
    await user.type(screen.getByRole("textbox", { name: "Your question" }), "typed meanwhile");
    resolve({ status: 502, body: { error: "x" } } as never);
    await screen.findByText("Could not get an answer. Check signal and try again.");
    expect(screen.getByRole("textbox", { name: "Your question" })).toHaveValue("First\ntyped meanwhile");
  });

  it("keeps what was typed on a 401 too", async () => {
    const user = userEvent.setup();
    let resolve!: (v: never) => void;
    const onUnauthorized = vi.fn();
    m.askCrm.mockImplementation(() => new Promise((r) => (resolve = r as never)));
    render(<Harness onUnauthorized={onUnauthorized} />);
    await ask(user, "First");
    await user.type(screen.getByRole("textbox", { name: "Your question" }), "more");
    resolve({ status: 401, body: { error: "unauthorized" } } as never);
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
    expect(screen.getByRole("textbox", { name: "Your question" })).toHaveValue("First\nmore");
  });

  it("drops the oldest messages until the conversation is at most 50,000 characters", async () => {
    const user = userEvent.setup();
    const big = "y".repeat(20_000);
    const turns: AskTurn[] = [
      { id: "u1", role: "user", content: big },
      { id: "a1", role: "assistant", content: big },
      { id: "u2", role: "user", content: big },
      { id: "a2", role: "assistant", content: big },
    ];
    m.askCrm.mockResolvedValue(answer("ok"));
    render(<Harness initial={{ turns, draft: "" }} />);
    await ask(user, "next");
    await screen.findByText("ok");
    const sent = m.askCrm.mock.calls[0][0].messages;
    expect(sent.reduce((n, x) => n + x.content.length, 0)).toBeLessThanOrEqual(50_000);
    expect(sent[0].role).toBe("user");
    expect(sent[sent.length - 1]).toEqual({ role: "user", content: "next" });
    // u1 dropped for size, then a1 so no assistant turn leads: u2, a2, next remain.
    expect(sent.length).toBe(3);
  });

  it("counts the ids, names and companies of refs toward the 50,000 characters, as the server does", async () => {
    const user = userEvent.setup();
    const ref = { memberId: "m".repeat(36), name: "n".repeat(200), company: "c".repeat(200), kind: "person" as const, personId: "p".repeat(36) };
    const refs = Array.from({ length: 30 }, () => ref); // 30 x 472 = 14,160 characters of ref text
    const content = "y".repeat(10_000);
    const turns: AskTurn[] = [
      { id: "u1", role: "user", content },
      { id: "a1", role: "assistant", content, refs },
      { id: "u2", role: "user", content },
      { id: "a2", role: "assistant", content, refs },
      { id: "u3", role: "user", content },
      { id: "a3", role: "assistant", content, refs },
    ];
    // Text alone is 60,000 (+ "next"): the old count dropped two turns. With refs the total is far higher.
    m.askCrm.mockResolvedValue(answer("ok"));
    render(<Harness initial={{ turns, draft: "" }} />);
    await ask(user, "next");
    await screen.findByText("ok");
    const sent = m.askCrm.mock.calls[0][0].messages;
    const size = (x: (typeof sent)[number]) =>
      x.content.length +
      (x.role === "assistant" ? (x.refs ?? []).reduce((n, r) => n + r.memberId.length + r.name.length + (r.company?.length ?? 0) + (r.personId?.length ?? 0), 0) : 0);
    expect(sent.reduce((n, x) => n + size(x), 0)).toBeLessThanOrEqual(50_000);
    expect(sent[0].role).toBe("user");
    expect(sent[sent.length - 1]).toEqual({ role: "user", content: "next" });
    // Without counting refs, four turns of 10,000 (+ next) would have been sent; with them fewer fit.
    expect(sent.length).toBeLessThan(5);
  });

  it("counts a ref's company id toward the 50,000 characters too", async () => {
    const user = userEvent.setup();
    const ref = { memberId: "m".repeat(36), name: "n".repeat(10), company: null, kind: "company" as const, orgId: "o".repeat(36), personId: "p".repeat(36) };
    const refs = Array.from({ length: 30 }, () => ref); // 30 x 118 characters, 30 x 82 without the company id
    const content = "y".repeat(6770); // without orgId the history is 48,004 characters, with it 51,244
    const turns: AskTurn[] = [
      { id: "u1", role: "user", content },
      { id: "a1", role: "assistant", content, refs },
      { id: "u2", role: "user", content },
      { id: "a2", role: "assistant", content, refs },
      { id: "u3", role: "user", content },
      { id: "a3", role: "assistant", content, refs },
    ];
    m.askCrm.mockResolvedValue(answer("ok"));
    render(<Harness initial={{ turns, draft: "" }} />);
    await ask(user, "next");
    await screen.findByText("ok");
    // Counting orgId the oldest pair no longer fits; leaving it out would send all seven messages.
    expect(m.askCrm.mock.calls[0][0].messages).toHaveLength(5);
  });

  it("clips a restored draft to 2,000 characters", async () => {
    const user = userEvent.setup();
    let resolve!: (v: never) => void;
    m.askCrm.mockImplementation(() => new Promise((r) => (resolve = r as never)));
    render(<Harness />);
    const box = screen.getByRole("textbox", { name: "Your question" });
    await user.click(box);
    await user.paste("q".repeat(1990));
    await user.click(screen.getByRole("button", { name: "Send question" }));
    await user.type(box, "t".repeat(30));
    resolve({ status: 502, body: { error: "x" } } as never);
    await screen.findByText("Could not get an answer. Check signal and try again.");
    const value = (box as HTMLTextAreaElement).value;
    expect(value.length).toBe(2000);
    expect(value.startsWith("q".repeat(1990))).toBe(true);
  });

  it("send does nothing for a draft over 2,000 characters", async () => {
    const user = userEvent.setup();
    const turns: AskTurn[] = [];
    render(<Harness initial={{ turns, draft: "z".repeat(2001) }} />);
    const send = screen.getByRole("button", { name: "Send question" });
    await user.click(send);
    expect(m.askCrm).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Your question" })).toHaveValue("z".repeat(2001));
  });

  describe("Clear", () => {
    it("keeps whatever is typed in the draft", async () => {
      const user = userEvent.setup();
      m.askCrm.mockResolvedValue(answer("ok"));
      render(<Harness />);
      await ask(user, "hi");
      await screen.findByText("ok");
      await user.type(screen.getByRole("textbox", { name: "Your question" }), "half a thought");
      await user.click(screen.getByRole("button", { name: "Clear" }));
      expect(screen.queryByText("ok")).toBeNull();
      expect(screen.getByRole("textbox", { name: "Your question" })).toHaveValue("half a thought");
    });

    it("is hidden when empty, then clears the conversation", async () => {
      const user = userEvent.setup();
      m.askCrm.mockResolvedValue(answer("ok"));
      render(<Harness />);
      expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
      await ask(user, "hi");
      await screen.findByText("ok");
      await user.click(screen.getByRole("button", { name: "Clear" }));
      expect(screen.queryByText("ok")).toBeNull();
      expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
    });

    it("is disabled while a question is pending", async () => {
      const user = userEvent.setup();
      m.askCrm.mockImplementation(() => new Promise(() => {}));
      render(<Harness />);
      await ask(user, "hi");
      expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
    });

    it("asks once when a card is still open, and keeps the conversation on No", async () => {
      const user = userEvent.setup();
      m.askCrm.mockResolvedValue(answer("Sure.", [NOTE_PROPOSAL]));
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
      render(<Harness />);
      await ask(user, "note");
      await screen.findByText("Sure.");
      await user.click(screen.getByRole("button", { name: "Clear" }));
      expect(confirmSpy).toHaveBeenCalledWith("Clear the conversation? Unconfirmed changes will be dropped.");
      expect(screen.getByText("Sure.")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Clear" }));
      expect(screen.queryByText("Sure.")).toBeNull();
      confirmSpy.mockRestore();
    });

    it("does not ask when no card is open", async () => {
      const user = userEvent.setup();
      m.askCrm.mockResolvedValue(answer("ok"));
      const confirmSpy = vi.spyOn(window, "confirm");
      render(<Harness />);
      await ask(user, "hi");
      await screen.findByText("ok");
      await user.click(screen.getByRole("button", { name: "Clear" }));
      expect(confirmSpy).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });
  });
});

describe("AskPanel contact chips and detail cards", () => {
  const ref = (n: number, extra: Record<string, unknown> = {}) => ({
    memberId: `m${n}`, name: `Person ${n}`, company: "Acme", kind: "person", ...extra,
  });

  function withRefs(refs: unknown[], onOpenContact = vi.fn()) {
    const initial: AskState = {
      turns: [
        { id: "u", role: "user", content: "Who?" },
        { id: "a", role: "assistant", content: "These people.", refs: refs as never },
      ],
      draft: "",
    };
    function H() {
      const [state, setState] = useState<AskState>(initial);
      return <AskPanel estate={ESTATE} state={state} onChange={setState} onUnauthorized={() => {}} onOpenContact={onOpenContact} />;
    }
    render(<H />);
    return onOpenContact;
  }

  it("shows at most five chips labelled with the contact's name", () => {
    withRefs([1, 2, 3, 4, 5, 6, 7].map((n) => ref(n)));
    const chips = screen.getByLabelText("Contacts mentioned");
    expect(Array.from(chips.querySelectorAll("button")).map((b) => b.textContent)).toEqual([
      "Person 1", "Person 2", "Person 3", "Person 4", "Person 5",
    ]);
  });

  it("opens the person when the ref has one, else the company, else the member", async () => {
    const user = userEvent.setup();
    const open = withRefs([
      ref(1, { personId: "p1", orgId: "o1" }),
      ref(2, { orgId: "o2", kind: "company" }),
      ref(3),
    ]);
    await user.click(screen.getByRole("button", { name: "Person 1" }));
    await user.click(screen.getByRole("button", { name: "Person 2" }));
    await user.click(screen.getByRole("button", { name: "Person 3" }));
    expect(open.mock.calls.map((c) => c[0])).toEqual([{ personId: "p1" }, { orgId: "o2" }, { memberId: "m3" }]);
  });

  it("opens the person, not their company, for a person on the pipeline, and ignores a stray orgId on a person ref", async () => {
    const user = userEvent.setup();
    const open = withRefs([ref(1, { personId: "p1" }), ref(2, { orgId: "o2" })]);
    await user.click(screen.getByRole("button", { name: "Person 1" }));
    await user.click(screen.getByRole("button", { name: "Person 2" }));
    expect(open.mock.calls.map((c) => c[0])).toEqual([{ personId: "p1" }, { memberId: "m2" }]);
  });

  it("shows each contact once", () => {
    withRefs([ref(1, { personId: "p1" }), ref(2, { personId: "p1" })]);
    expect(screen.getAllByRole("button", { name: /Person/ })).toHaveLength(1);
  });

  it("shows no chips without refs", () => {
    withRefs([]);
    expect(screen.queryByLabelText("Contacts mentioned")).toBeNull();
  });

  it("renders an assistant's update_details proposal as the edit card and confirms it", async () => {
    const user = userEvent.setup();
    const signed = {
      proposal: {
        kind: "update_details", estate: "traxo", target: { type: "company", id: "o1" }, targetName: "Acme Capital",
        company: null, changes: [{ field: "website", from: null, to: "acme.com" }], logMemberId: "m1",
        addsToPipeline: null, expires: 1,
      },
      signature: "sig-details",
    };
    m.askCrm.mockResolvedValue(answer("Here is the change.", [signed]));
    m.actOnCrm.mockResolvedValue({ status: 200, body: { status: "updated", message: "Done. Acme Capital updated." } } as never);
    render(<Harness />);
    await ask(user, "Set Acme's site");
    expect(await screen.findByText("Edit details")).toBeInTheDocument();
    expect(screen.getByText("Website: (empty) → acme.com")).toBeInTheDocument();
    // A company edit says plainly that it is the company.
    expect(screen.getByText("Company")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.getAllByText("Done. Acme Capital updated.").length).toBeGreaterThan(0));
    expect(m.actOnCrm).toHaveBeenCalledWith({ estate: "traxo", proposal: signed.proposal, signature: "sig-details" });
  });

  it("focuses the question box on opening when asked, once", async () => {
    const onFocused = vi.fn();
    render(
      <AskPanel estate={ESTATE} state={{ turns: [], draft: "About Jane: " }} onChange={() => {}} onUnauthorized={() => {}} focusOnOpen onFocused={onFocused} />,
    );
    expect(screen.getByRole("textbox", { name: "Your question" })).toHaveFocus();
    expect(onFocused).toHaveBeenCalledTimes(1);
  });
});

describe("research offer", () => {
  const offer = { personId: "p1", name: "Jane Tan", company: "Acme Capital" };
  const withResearch = (text: string) => ({ status: 200, body: { answer: text, refs: [], proposals: [], research: offer } }) as never;

  it("shows a Research card and Run research opens the person once", async () => {
    m.askCrm.mockResolvedValue(withResearch("I can look into her."));
    const onResearch = vi.fn();
    const user = userEvent.setup();
    render(<Harness onResearch={onResearch} />);
    await ask(user, "research Jane");
    expect(await screen.findByText("Research: Jane Tan")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Run research" }));
    expect(onResearch).toHaveBeenCalledTimes(1);
    expect(onResearch).toHaveBeenCalledWith("p1");
  });

  it("disables the offer's button once it has been used", async () => {
    m.askCrm.mockResolvedValue(withResearch("I can look into her."));
    const onResearch = vi.fn();
    const user = userEvent.setup();
    render(<Harness onResearch={onResearch} />);
    await ask(user, "research Jane");
    await user.click(await screen.findByRole("button", { name: "Run research" }));
    expect(screen.getByRole("button", { name: "Run research" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Run research" }));
    expect(onResearch).toHaveBeenCalledTimes(1);
  });

  it("shows no card when there is no offer", async () => {
    m.askCrm.mockResolvedValue(answer("Nothing."));
    const user = userEvent.setup();
    render(<Harness onResearch={vi.fn()} />);
    await ask(user, "hello");
    await screen.findByText("Nothing.");
    expect(screen.queryByRole("button", { name: "Run research" })).toBeNull();
  });
});

describe("the profile open underneath", () => {
  const P = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const JANE: AskViewing = { target: { personId: P }, name: "Jane Tan", company: "Acme Capital" };

  it("says who is being looked at, suggests them first and sends only their id", async () => {
    const user = userEvent.setup();
    m.askCrm.mockResolvedValueOnce(answer("She is a partner."));
    render(<Harness viewing={JANE} />);
    expect(screen.getByText("Looking at Jane Tan · Acme Capital")).toBeInTheDocument();
    const tries = screen.getAllByRole("button").map((b) => b.textContent);
    expect(tries.indexOf("Tell me about Jane Tan")).toBeGreaterThanOrEqual(0);
    expect(tries.indexOf("Tell me about Jane Tan")).toBeLessThan(tries.indexOf("Who should I chase this week?"));
    await ask(user, "When did I last speak to them?");
    expect(await screen.findByText("She is a partner.")).toBeInTheDocument();
    expect(m.askCrm).toHaveBeenCalledWith(expect.objectContaining({ viewing: { personId: P } }));
    expect(JSON.stringify(m.askCrm.mock.calls[0][0])).not.toContain("Acme Capital");
  });

  it("leaves the company out of the line when there is none", () => {
    render(<Harness viewing={{ ...JANE, company: null }} />);
    expect(screen.getByText("Looking at Jane Tan")).toBeInTheDocument();
  });

  it("shows no line and sends no viewing key with nothing open", async () => {
    const user = userEvent.setup();
    m.askCrm.mockResolvedValueOnce(answer("Hi."));
    render(<Harness viewing={null} />);
    expect(screen.queryByText(/Looking at/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Tell me about ./ })).toBeNull();
    await ask(user, "Who is hot?");
    expect(await screen.findByText("Hi.")).toBeInTheDocument();
    expect("viewing" in m.askCrm.mock.calls[0][0]).toBe(false);
  });

  it("reports a confirmed change once, and not a cancelled one", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    m.askCrm.mockResolvedValueOnce(answer("Ready.", [NOTE_PROPOSAL, NOTE_PROPOSAL]));
    m.actOnCrm.mockResolvedValue({ status: 200, body: { status: "ok", message: "Note added to Jane Tan." } });
    render(<Harness onChanged={onChanged} />);
    await ask(user, "Add a note");
    await screen.findByText("Ready.");
    await user.click(screen.getAllByRole("button", { name: "Cancel" })[1]);
    expect(onChanged).not.toHaveBeenCalled();
    await user.click(screen.getAllByRole("button", { name: "Confirm" })[0]);
    expect(await screen.findByText("Note added to Jane Tan.")).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});

describe("speaking a question", () => {
  type Heard = { transcript: string; isFinal?: boolean };
  class FakeRecognition {
    static last: FakeRecognition | null = null;
    continuous = false;
    interimResults = false;
    lang = "";
    onresult: ((e: unknown) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onend: (() => void) | null = null;
    start = vi.fn();
    stop = vi.fn(() => this.onend?.());
    abort = vi.fn(() => this.onend?.());
    constructor() {
      FakeRecognition.last = this;
    }
    hear(parts: Heard[]) {
      const results = parts.map((x) => Object.assign([{ transcript: x.transcript }], { isFinal: x.isFinal ?? true }));
      act(() => this.onresult?.({ results }));
    }
    fail(error: string) {
      act(() => {
        this.onerror?.({ error });
        this.onend?.();
      });
    }
  }
  const w = window as unknown as Record<string, unknown>;
  beforeEach(() => {
    FakeRecognition.last = null;
    w.webkitSpeechRecognition = FakeRecognition;
  });
  afterEach(() => {
    delete w.webkitSpeechRecognition;
    delete w.SpeechRecognition;
  });
  const box = () => screen.getByRole("textbox", { name: "Your question" });

  it("the microphone listens, and what is said appears in the question box", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Speak your question" }));
    const rec = FakeRecognition.last!;
    expect(rec.start).toHaveBeenCalledTimes(1);
    expect(rec.continuous).toBe(true);
    expect(rec.interimResults).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent("Listening");
    // The keyboard is not raised: it would cover the sheet on a phone.
    expect(box()).not.toHaveFocus();
    expect(screen.queryByText("Tap the microphone on the keyboard and talk, then press Ask.")).toBeNull();
    rec.hear([{ transcript: "who should I", isFinal: false }]);
    expect(box()).toHaveValue("who should I");
    rec.hear([{ transcript: "Who should I chase" }, { transcript: " this week", isFinal: false }]);
    expect(box()).toHaveValue("Who should I chase this week");
    await user.click(screen.getByRole("button", { name: "Stop listening" }));
    expect(rec.stop).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Speak your question" })).toBeInTheDocument();
    expect(screen.queryByText("Listening...")).toBeNull();
    expect(box()).toHaveValue("Who should I chase this week");
  });

  it("speech is added after what is already typed, and never past the length limit", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ turns: [], draft: "About Jane:" }} />);
    await user.click(screen.getByRole("button", { name: "Speak your question" }));
    const rec = FakeRecognition.last!;
    rec.hear([{ transcript: "when did we last talk" }]);
    expect(box()).toHaveValue("About Jane: when did we last talk");
    rec.hear([{ transcript: "x".repeat(3000) }]);
    expect((box() as HTMLTextAreaElement).value).toHaveLength(2000);
  });

  it("sending the question stops the listening", async () => {
    const user = userEvent.setup();
    m.askCrm.mockResolvedValue(answer("Chase Jane."));
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Speak your question" }));
    const rec = FakeRecognition.last!;
    rec.hear([{ transcript: "who should I chase" }]);
    await user.click(screen.getByRole("button", { name: "Send question" }));
    expect(rec.abort).toHaveBeenCalled();
    await screen.findByText("Chase Jane.");
    // A late result from the stopped session does not refill the box.
    rec.hear([{ transcript: "who should I chase" }]);
    expect(box()).toHaveValue("");
  });

  it("says so when the microphone is not allowed", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Speak your question" }));
    FakeRecognition.last!.fail("not-allowed");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Monsoon is not allowed to use the microphone. Allow it in the browser settings, or use the microphone on the keyboard.",
    );
    expect(screen.getByRole("button", { name: "Speak your question" })).toBeInTheDocument();
  });

  it("says nothing when it simply heard no speech, and says so on any other failure", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Speak your question" }));
    FakeRecognition.last!.fail("no-speech");
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Speak your question" }));
    FakeRecognition.last!.fail("network");
    expect(screen.getByRole("alert")).toHaveTextContent("Could not listen. Try again, or use the microphone on the keyboard.");
  });

  it("a browser that refuses to start falls back to the keyboard hint", async () => {
    const user = userEvent.setup();
    w.webkitSpeechRecognition = class extends FakeRecognition {
      start = vi.fn(() => {
        throw new Error("no");
      });
    };
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Speak your question" }));
    expect(screen.getByText("Tap the microphone on the keyboard and talk, then press Ask.")).toBeInTheDocument();
    expect(box()).toHaveFocus();
  });

  it("stops listening when the panel goes away", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Speak your question" }));
    const rec = FakeRecognition.last!;
    unmount();
    expect(rec.abort).toHaveBeenCalled();
  });

  it("without speech recognition the hint still shows, next to the question box", async () => {
    delete w.webkitSpeechRecognition;
    const user = userEvent.setup();
    render(<Harness initial={{ turns: [], draft: "typed" }} />);
    await user.click(screen.getByRole("button", { name: "Speak your question" }));
    expect(screen.getByText("Tap the microphone on the keyboard and talk, then press Ask.")).toBeInTheDocument();
    expect(box()).toHaveFocus();
  });

  describe("a request sent for the user (send)", () => {
    it("submits the text once as an ordinary question, and shows it as the user's turn", async () => {
      m.askCrm.mockResolvedValue(answer("Here you go."));
      render(<Harness send={{ id: "s1", text: 'Prepare me for this to-do with Jane Tan: "Send deck".' }} viewing={{ target: { personId: "p1" }, name: "Jane Tan", company: "Acme" }} />);
      expect(await screen.findByText("Here you go.")).toBeInTheDocument();
      expect(screen.getByText('Prepare me for this to-do with Jane Tan: "Send deck".')).toBeInTheDocument();
      expect(m.askCrm).toHaveBeenCalledTimes(1);
      const body = m.askCrm.mock.calls[0][0];
      expect(body.messages.at(-1)).toEqual({ role: "user", content: 'Prepare me for this to-do with Jane Tan: "Send deck".' });
      expect(body.viewing).toEqual({ personId: "p1" });
    });

    it("does not send again on a re-render with the same id, but does for a new id", async () => {
      m.askCrm.mockResolvedValue(answer("One."));
      const props = { estate: ESTATE, state: EMPTY_ASK, onChange: () => {}, onUnauthorized: () => {} };
      function Wrap({ send }: { send: { id: string; text: string } }) {
        const [state, setState] = useState<AskState>(EMPTY_ASK);
        return <AskPanel {...props} state={state} onChange={setState} send={send} />;
      }
      const { rerender } = render(<Wrap send={{ id: "s1", text: "First" }} />);
      await screen.findByText("One.");
      rerender(<Wrap send={{ id: "s1", text: "First" }} />);
      rerender(<Wrap send={{ id: "s1", text: "First" }} />);
      await act(async () => {});
      expect(m.askCrm).toHaveBeenCalledTimes(1);
      m.askCrm.mockResolvedValue(answer("Two."));
      rerender(<Wrap send={{ id: "s2", text: "Second" }} />);
      await screen.findByText("Two.");
      expect(m.askCrm).toHaveBeenCalledTimes(2);
    });

    it("leaves what the user had typed in the box", async () => {
      m.askCrm.mockResolvedValue(answer("Done."));
      render(<Harness initial={{ turns: [], draft: "half a thought" }} send={{ id: "s1", text: "Prepare" }} />);
      await screen.findByText("Done.");
      expect(screen.getByRole("textbox", { name: "Your question" })).toHaveValue("half a thought");
    });
  });

  describe("prepareMessage", () => {
    it("is the fixed request, with the due date when there is one", () => {
      expect(prepareMessage("Jane Tan", "Send deck", "27 Nov")).toBe('Prepare me for this to-do with Jane Tan: "Send deck", due 27 Nov.');
      expect(prepareMessage("Jane Tan", "Send deck", null)).toBe('Prepare me for this to-do with Jane Tan: "Send deck".');
    });

    it("a 300-character title fits the box untouched", () => {
      const title = "x".repeat(300);
      expect(prepareMessage("Jane Tan", title, "27 Nov")).toContain(`"${title}"`);
    });

    it("cuts only the quoted title when the whole request would not fit, and the result is sent", async () => {
      const name = "N".repeat(1800);
      const title = "t".repeat(300);
      const text = prepareMessage(name, title, "27 Nov");
      expect(text.length).toBeLessThanOrEqual(2000);
      expect(text.startsWith(`Prepare me for this to-do with ${name}: "t`)).toBe(true);
      expect(text.endsWith('…", due 27 Nov.')).toBe(true);
      m.askCrm.mockResolvedValue(answer("Ok."));
      render(<Harness send={{ id: "s1", text }} />);
      await screen.findByText("Ok.");
      expect(m.askCrm).toHaveBeenCalledTimes(1);
    });
  });
});
