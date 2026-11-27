// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MonsoonApp from "./MonsoonApp";
import * as api from "./api";

vi.mock("./api", () => ({
  signIn: vi.fn(),
  loadEstates: vi.fn(),
  readCards: vi.fn(),
  saveCard: vi.fn(),
  refineCard: vi.fn(),
  askCrm: vi.fn(),
  actOnCrm: vi.fn(),
  searchContacts: vi.fn(),
  loadProfile: vi.fn(),
  proposeChange: vi.fn(),
  researchContact: vi.fn(),
  loadClaudeKey: vi.fn(),
  saveClaudeKey: vi.fn(),
  testClaudeKey: vi.fn(),
  loadUserPage: vi.fn(),
  saveUserPage: vi.fn(),
  addUserNote: vi.fn(),
  loadGranolaKey: vi.fn(),
  saveGranolaKey: vi.fn(),
  testGranolaKey: vi.fn(),
  disconnectGranolaKey: vi.fn(),
  loadSignInOptions: vi.fn(),
  loadRequests: vi.fn(),
  actOnRequest: vi.fn(),
  mapImportColumns: vi.fn(),
  checkImportRows: vi.fn(),
  saveImportRows: vi.fn(),
  finishImport: vi.fn(),
  loadImports: vi.fn(),
  loadImportContacts: vi.fn(),
  loadTodos: vi.fn(),
  todoAction: vi.fn(),
}));
vi.mock("./image", () => ({ downsizeImage: vi.fn() }));

const m = vi.mocked(api);
type User = ReturnType<typeof userEvent.setup>;

const ESTATES = {
  estates: [
    {
      key: "traxo",
      label: "Traxo",
      defaultRole: "lp_prospect",
      available: true,
      todos: true,
      roles: [
        { key: "lp_prospect", label: "LP prospect" },
        { key: "introducer", label: "Introducer" },
      ],
    },
    {
      key: "zeroone",
      label: "Zero One",
      defaultRole: "investor",
      available: true,
      todos: true,
      roles: [{ key: "investor", label: "investor" }],
    },
  ],
};

const MEMBER = {
  memberId: "m1", memberKind: "person", role: "lp_prospect", stage: "lead", owner: null, priority: null,
  nextAction: null, nextActionDate: null, due: "later", notes: null,
};
const profileOf = (personId: string, name: string, company: string, memberId: string) => ({
  kind: "person", personId, orgId: `o-${personId}`, name, title: "Partner", company,
  email: null, phone: null, linkedin: null, country: null, website: null, notes: null,
  member: { ...MEMBER, memberId },
  memberOf: "self", timelineOf: null, timeline: [], timelineTotal: 0, people: [],
  stages: [{ key: "lead", label: "Lead", terminal: false }, { key: "won", label: "Won", terminal: true }],
});
const JANE_PROFILE = profileOf("p1", "Anna Lee", "Northwind", "m1");
const BOB_PROFILE = profileOf("p2", "Bo Chen", "Fabrikam", "m2");
const HIT = { kind: "person", personId: "p1", orgId: "o-p1", name: "Anna Lee", title: "Partner", company: "Northwind", email: null, member: null, memberOf: null };

const TODAY = (() => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
})();
const contactOf = (memberId: string, personId: string, name: string, company: string) => ({
  memberId, memberKind: "person", name, company, personId, orgId: `o-${personId}`,
  aboutPersonId: null, aboutName: null, stage: "lead", stageLabel: "Lead", priority: null, lastAction: null,
});
const ROW = {
  id: "t1", title: "Send deck", dueDate: TODAY, firstDueDate: TODAY, movedCount: 0, status: "open", outcome: null,
  closedAt: null, owner: null, mine: true, due: "today",
  contact: contactOf("m1", "p1", "Anna Lee", "Northwind"),
};
const BOB_ROW = { ...ROW, id: "t2", title: "Book lunch", contact: contactOf("m2", "p2", "Bo Chen", "Fabrikam") };
const PLAIN_ROW = { ...ROW, id: "t3", title: "Renew domain", contact: null };
const listed = (...open: unknown[]) => ({ status: 200, body: { ready: true, open, done: [] } }) as never;

const NOTE = {
  proposal: {
    kind: "add_note", estate: "traxo", memberId: "m1", memberKind: "person", memberName: "Anna Lee",
    company: "Northwind", about: "the call", expires: 1,
  },
  signature: "sig-note",
  text: "Call went well",
};
const answer = (text: string, extra: Record<string, unknown> = {}) =>
  ({ status: 200, body: { answer: text, refs: [], proposals: [], ...extra } }) as never;

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  };
}

function pointer(coarse: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: coarse && query === "(pointer: coarse)",
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  }));
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  localStorage.setItem("monsoon.code", "acme");
  vi.resetAllMocks();
  m.loadEstates.mockResolvedValue({ status: 200, body: ESTATES } as never);
  m.loadTodos.mockResolvedValue({ status: 200, body: { ready: true, open: [], done: [] } } as never);
  m.searchContacts.mockResolvedValue({ status: 200, body: { contacts: [HIT] } } as never);
  m.loadImports.mockResolvedValue({ status: 200, body: { imports: [] } } as never);
  m.loadProfile.mockImplementation(async (_estate, target) =>
    ({ status: 200, body: { profile: target.personId === "p2" ? BOB_PROFILE : JANE_PROFILE } }) as never,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function start() {
  render(<MonsoonApp />);
  await screen.findByRole("button", { name: "Save" });
}

const askWindow = () => screen.getByRole("dialog", { name: "Ask" });
const questionBox = () => screen.queryByRole("textbox", { name: "Your question" });

async function openAsk(user: User) {
  await user.click(screen.getByRole("button", { name: "Ask Monsoon" }));
  await screen.findByRole("textbox", { name: "Your question" });
}

async function ask(user: User, text: string) {
  await user.type(screen.getByRole("textbox", { name: "Your question" }), text);
  await user.click(screen.getByRole("button", { name: "Send question" }));
}

async function openAnna(user: User) {
  await user.click(screen.getByRole("button", { name: "Contacts" }));
  await user.click(await screen.findByRole("button", { name: /Anna Lee/ }));
  await screen.findByRole("button", { name: "Ask about this contact" });
}

/** Minimised: the conversation is kept but hidden, the bar shows, and the pill row is back. */
function expectMinimised() {
  expect(screen.getByRole("button", { name: "Expand Ask" })).toBeInTheDocument();
  expect(questionBox()).toBeNull();
  expect(screen.getByRole("button", { name: "Ask Monsoon" })).toBeInTheDocument();
}

describe("Ask as a floating window over a live page", () => {
  it("leaves the page behind reachable: nothing is inert, the page scrolls, and a page button works", async () => {
    const user = userEvent.setup();
    await start();
    await openAsk(user);
    expect(askWindow()).not.toHaveAttribute("aria-modal");
    expect(document.querySelector("[inert]")).toBeNull();
    expect(document.body.style.overflow).not.toBe("hidden");
    expect(screen.queryByTestId("ask-backdrop")).toBeNull();
    // While expanded the window takes the pill row's place.
    expect(screen.queryByRole("button", { name: "Ask Monsoon" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "To do" }));
    expect(screen.getByRole("button", { name: "To do" })).toHaveAttribute("aria-pressed", "true");
    expect(questionBox()).toBeInTheDocument();
  });

  it("a contact chip opens the profile behind and minimises the window, keeping the conversation", async () => {
    const user = userEvent.setup();
    m.askCrm.mockResolvedValue(
      answer("Anna is warm.", { refs: [{ memberId: "m1", name: "Anna Lee", company: "Northwind", kind: "person", personId: "p1" }] }),
    );
    await start();
    await openAsk(user);
    await ask(user, "Who is warm?");
    await user.click(await within(askWindow()).findByRole("button", { name: "Anna Lee" }));
    expect(await screen.findByRole("heading", { name: "Anna Lee" })).toBeInTheDocument();
    expectMinimised();
    expect(within(askWindow()).getByText("Tap to return to your conversation")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Expand Ask" }));
    expect(screen.getByText("Anna is warm.")).toBeInTheDocument();
    expect(screen.getByText("Who is warm?")).toBeInTheDocument();
  });

  it("a To do row's contact opened while Ask is expanded minimises it", async () => {
    const user = userEvent.setup();
    m.loadTodos.mockResolvedValue(listed(ROW));
    await start();
    await user.click(screen.getByRole("button", { name: "To do" }));
    await screen.findByText("Send deck");
    await openAsk(user);
    await user.click(screen.getByRole("button", { name: "Anna Lee" }));
    expect(await screen.findByRole("heading", { name: "Anna Lee" })).toBeInTheDocument();
    expectMinimised();
  });

  it("Run research minimises the window and research still starts", async () => {
    const user = userEvent.setup();
    m.researchContact.mockResolvedValue({ status: 200, body: { status: "none", message: "Nothing to add." } } as never);
    m.askCrm.mockResolvedValue(answer("I can look into her.", { research: { personId: "p1", name: "Anna Lee", company: "Northwind" } }));
    await start();
    await openAsk(user);
    await ask(user, "Research Anna");
    await user.click(await screen.findByRole("button", { name: "Run research" }));
    expect(await screen.findByRole("heading", { name: "Anna Lee" })).toBeInTheDocument();
    expectMinimised();
    await waitFor(() => expect(m.researchContact).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Nothing to add.")).toBeInTheDocument();
  });

  it("after Prepare me, opening another profile makes Looking at name that profile", async () => {
    const user = userEvent.setup();
    m.loadTodos.mockImplementation(async (_e, opts) => (opts?.member ? listed() : listed(ROW, BOB_ROW)));
    m.askCrm.mockResolvedValue(answer("Where things stand."));
    await start();
    await user.click(screen.getByRole("button", { name: "To do" }));
    await user.click(await screen.findByRole("button", { name: /^Send deck/ }));
    await user.click(screen.getByRole("button", { name: "Prepare me" }));
    expect(await within(askWindow()).findByText("Where things stand.")).toBeInTheDocument();
    expect(within(askWindow()).getByText("Looking at Anna Lee · Northwind")).toBeInTheDocument();
    // Back to the list (the form's Cancel), then the other contact's name.
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(await screen.findByRole("button", { name: "Bo Chen" }));
    expect(await screen.findByRole("heading", { name: "Bo Chen" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Expand Ask" }));
    expect(within(askWindow()).getByText("Looking at Bo Chen · Fabrikam")).toBeInTheDocument();
    await ask(user, "And this one?");
    await waitFor(() => expect(m.askCrm).toHaveBeenCalledTimes(2));
    expect(m.askCrm.mock.calls[1][0].viewing).toEqual({ personId: "p2" });
  });

  it("the Looking at line shows once, in the window's header", async () => {
    const user = userEvent.setup();
    await start();
    await openAnna(user);
    await openAsk(user);
    expect(within(askWindow()).getAllByText("Looking at Anna Lee · Northwind")).toHaveLength(1);
  });

  it("confirming a card reloads the profile and the To do list underneath at once, without closing", async () => {
    const user = userEvent.setup();
    m.askCrm.mockResolvedValue(answer("Ready.", { proposals: [NOTE] }));
    m.actOnCrm.mockResolvedValue({ status: 200, body: { status: "ok", message: "Note added to Anna Lee." } } as never);
    await start();
    await openAnna(user);
    expect(m.loadProfile).toHaveBeenCalledTimes(1);
    await openAsk(user);
    await ask(user, "Add a note");
    await screen.findByText("Ready.");
    const todoReads = m.loadTodos.mock.calls.length;
    await user.click(within(askWindow()).getByRole("button", { name: "Confirm" }));
    await screen.findByText("Note added to Anna Lee.");
    await waitFor(() => expect(m.loadProfile).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(m.loadTodos.mock.calls.length).toBeGreaterThan(todoReads));
    expect(askWindow()).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Anna Lee" })).toBeInTheDocument();
  });

  it("a confirmation that finishes while minimised still lands in the conversation and frees Ask", async () => {
    const user = userEvent.setup();
    let finish!: (v: never) => void;
    m.askCrm.mockResolvedValue(answer("Ready.", { proposals: [NOTE] }));
    m.actOnCrm.mockImplementation(() => new Promise((r) => (finish = r as never)));
    await start();
    await openAnna(user);
    await openAsk(user);
    await ask(user, "Add a note");
    await screen.findByText("Ready.");
    await user.click(within(askWindow()).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Zero One" })).toBeDisabled());
    await user.click(screen.getByRole("button", { name: "Minimise Ask and keep reading" }));
    expect(questionBox()).toBeNull();
    finish({ status: 200, body: { status: "ok", message: "Note added to Anna Lee." } } as never);
    await waitFor(() => expect(screen.getByRole("button", { name: "Zero One" })).toBeEnabled());
    await waitFor(() => expect(m.loadProfile).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "Expand Ask" }));
    expect(screen.getByText("Note added to Anna Lee.")).toBeInTheDocument();
    expect(within(askWindow()).getByRole("button", { name: "Close" })).toBeEnabled();
  });

  it("while the page is busy the card's Confirm, the send button and the pill are disabled", async () => {
    const user = userEvent.setup();
    let settle!: (v: never) => void;
    m.askCrm.mockResolvedValue(answer("Ready.", { proposals: [NOTE] }));
    m.proposeChange.mockImplementation(() => new Promise((r) => (settle = r as never)));
    await start();
    await openAnna(user);
    await openAsk(user);
    await ask(user, "Add a note");
    await screen.findByText("Ready.");
    await user.type(screen.getByRole("textbox", { name: "Your question" }), "Next?");
    const confirm = within(askWindow()).getByRole("button", { name: "Confirm" });
    expect(confirm).toBeEnabled();
    // A profile action behind the window: the page is now writing.
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.type(screen.getByLabelText("Title"), "x");
    await user.click(screen.getByRole("button", { name: "Review changes" }));
    await waitFor(() => expect(confirm).toBeDisabled());
    expect(screen.getByRole("button", { name: "Send question" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Minimise Ask and keep reading" }));
    expect(screen.getByRole("button", { name: "Ask Monsoon" })).toBeDisabled();
    settle({ status: 200, body: { ok: false, reason: "Nope." } } as never);
    await screen.findByText("Nope.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Ask Monsoon" })).toBeEnabled());
  });

  it("while Ask is asking, the to-do tick control is disabled", async () => {
    const user = userEvent.setup();
    let reply!: (v: never) => void;
    m.loadTodos.mockResolvedValue(listed(ROW));
    m.askCrm.mockImplementation(() => new Promise((r) => (reply = r as never)));
    await start();
    await user.click(screen.getByRole("button", { name: "To do" }));
    const tick = await screen.findByRole("button", { name: "Mark done: Send deck" });
    expect(tick).toBeEnabled();
    await openAsk(user);
    await ask(user, "Who?");
    await waitFor(() => expect(tick).toBeDisabled());
    reply(answer("Nobody."));
    await screen.findByText("Nobody.");
    await waitFor(() => expect(tick).toBeEnabled());
  });

  it("while Ask is asking, a profile's write controls are disabled", async () => {
    const user = userEvent.setup();
    let reply!: (v: never) => void;
    m.askCrm.mockImplementation(() => new Promise((r) => (reply = r as never)));
    await start();
    await openAnna(user);
    await user.click(screen.getByRole("button", { name: "Add note" }));
    await user.type(screen.getByPlaceholderText("Type or dictate a note"), "Called her");
    await openAsk(user);
    await ask(user, "Who?");
    await waitFor(() => expect(screen.getByRole("button", { name: "Save note" })).toBeDisabled());
    reply(answer("Nobody."));
    await screen.findByText("Nobody.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Save note" })).toBeEnabled());
  });

  it("while Ask is asking, the capture Save and the photo input are disabled", async () => {
    const user = userEvent.setup();
    let reply!: (v: never) => void;
    m.askCrm.mockImplementation(() => new Promise((r) => (reply = r as never)));
    await start();
    await user.type(screen.getByLabelText("Name"), "Anna Lee");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    await openAsk(user);
    await ask(user, "Who?");
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());
    expect(document.querySelector('input[type="file"]')).toBeDisabled();
    reply(answer("Nobody."));
    await screen.findByText("Nobody.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
  });

  it("the Undo bar sits above the pill row, the minimised bar or the expanded window", async () => {
    const user = userEvent.setup();
    m.loadTodos.mockResolvedValue(listed(PLAIN_ROW));
    m.todoAction.mockResolvedValue({ status: 200, body: { status: "ok", todo: { ...PLAIN_ROW, status: "done" } } } as never);
    await start();
    await user.click(screen.getByRole("button", { name: "To do" }));
    await user.click(await screen.findByRole("button", { name: "Mark done: Renew domain" }));
    const bar = () => screen.getByText("Done: Renew domain").closest('[role="status"]') as HTMLElement;
    await screen.findByText("Done: Renew domain");
    expect(bar().className).toContain("bottom-[calc(6rem+env(safe-area-inset-bottom))]");
    await openAsk(user);
    expect(bar().className).toContain("bottom-[calc(min(62dvh,580px)+1.5rem+env(safe-area-inset-bottom))]");
    await user.click(screen.getByRole("button", { name: "Minimise Ask and keep reading" }));
    expect(bar().className).toContain("bottom-[calc(10rem+env(safe-area-inset-bottom))]");
  });

  it("Prepare me from the To do tab while the window is minimised expands it and sends once", async () => {
    const user = userEvent.setup();
    m.loadTodos.mockResolvedValue(listed(ROW));
    m.askCrm.mockResolvedValue(answer("Where things stand."));
    await start();
    await user.click(screen.getByRole("button", { name: "To do" }));
    await openAsk(user);
    await user.click(screen.getByRole("button", { name: "Minimise Ask and keep reading" }));
    await user.click(await screen.findByRole("button", { name: /^Send deck/ }));
    await user.click(screen.getByRole("button", { name: "Prepare me" }));
    expect(await screen.findByText("Where things stand.")).toBeInTheDocument();
    expect(questionBox()).toBeInTheDocument();
    expect(m.askCrm).toHaveBeenCalledTimes(1);
  });

  it("one Escape closes the what-happened sheet and leaves Ask open", async () => {
    const user = userEvent.setup();
    m.loadTodos.mockResolvedValue(listed(ROW));
    m.todoAction.mockResolvedValue({ status: 200, body: { status: "ok", todo: { ...ROW, status: "done" } } } as never);
    await start();
    await user.click(screen.getByRole("button", { name: "To do" }));
    const tick = await screen.findByRole("button", { name: "Mark done: Send deck" });
    await openAsk(user);
    await user.click(tick);
    await screen.findByRole("dialog", { name: "Done: Send deck" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Done: Send deck" })).toBeNull());
    expect(screen.getByRole("dialog", { name: "Ask" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Ask" })).toBeNull();
  });

  describe("focus on opening", () => {
    it("on a computer, opening focuses the question box; closing returns focus to the pill", async () => {
      pointer(false);
      const user = userEvent.setup();
      await start();
      await openAsk(user);
      expect(questionBox()).toHaveFocus();
      await user.click(screen.getByRole("button", { name: "Close" }));
      expect(screen.getByRole("button", { name: "Ask Monsoon" })).toHaveFocus();
    });

    it("on a touch screen, opening does not focus the question box, but Ask about this contact does", async () => {
      pointer(true);
      const user = userEvent.setup();
      await start();
      await openAnna(user);
      await openAsk(user);
      expect(questionBox()).not.toHaveFocus();
      await user.click(screen.getByRole("button", { name: "Minimise Ask and keep reading" }));
      await user.click(screen.getByRole("button", { name: "Ask about this contact" }));
      expect(await screen.findByRole("textbox", { name: "Your question" })).toHaveFocus();
      expect(questionBox()).toHaveValue("About Anna Lee: ");
    });
  });
});

describe("one write at a time: a page write in flight blocks Ask", () => {
  /** Ask expanded with a change card on screen; returns its Confirm button. */
  async function cardOnScreen(user: User) {
    m.askCrm.mockResolvedValue(answer("Ready.", { proposals: [NOTE] }));
    await openAsk(user);
    await ask(user, "Add a note");
    await screen.findByText("Ready.");
    const confirm = within(askWindow()).getByRole("button", { name: "Confirm" });
    expect(confirm).toBeEnabled();
    return confirm;
  }

  it("a to-do tick in flight disables Confirm, send and the suggestions until it settles", async () => {
    const user = userEvent.setup();
    let settle!: (v: never) => void;
    m.loadTodos.mockResolvedValue(listed(PLAIN_ROW));
    m.todoAction.mockImplementation(() => new Promise((r) => (settle = r as never)));
    await start();
    await user.click(screen.getByRole("button", { name: "To do" }));
    const tick = await screen.findByRole("button", { name: "Mark done: Renew domain" });
    const confirm = await cardOnScreen(user);
    await user.click(tick);
    await waitFor(() => expect(confirm).toBeDisabled());
    await user.type(screen.getByRole("textbox", { name: "Your question" }), "Next?");
    expect(screen.getByRole("button", { name: "Send question" })).toBeDisabled();
    settle({ status: 200, body: { status: "ok", todo: { ...PLAIN_ROW, status: "done" } } } as never);
    await screen.findByText("Done: Renew domain");
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(screen.getByRole("button", { name: "Send question" })).toBeEnabled();
  });

  it("a to-do tick that fails also frees Ask", async () => {
    const user = userEvent.setup();
    let settle!: (v: never) => void;
    m.loadTodos.mockResolvedValue(listed(PLAIN_ROW));
    m.todoAction.mockImplementation(() => new Promise((r) => (settle = r as never)));
    await start();
    await user.click(screen.getByRole("button", { name: "To do" }));
    const tick = await screen.findByRole("button", { name: "Mark done: Renew domain" });
    const confirm = await cardOnScreen(user);
    await user.click(tick);
    await waitFor(() => expect(confirm).toBeDisabled());
    settle({ status: 500, body: { error: "Could not save. Check signal." } } as never);
    await waitFor(() => expect(confirm).toBeEnabled());
  });

  it("a write whose screen goes away mid-write does not leave Ask blocked", async () => {
    const user = userEvent.setup();
    m.loadTodos.mockResolvedValue(listed(PLAIN_ROW));
    m.todoAction.mockImplementation(() => new Promise(() => {}));
    await start();
    await user.click(screen.getByRole("button", { name: "To do" }));
    const tick = await screen.findByRole("button", { name: "Mark done: Renew domain" });
    const confirm = await cardOnScreen(user);
    await user.click(tick);
    await waitFor(() => expect(confirm).toBeDisabled());
    // The To do tab goes (its write never answers): Ask is free again.
    await user.click(screen.getByRole("button", { name: "Capture" }));
    await waitFor(() => expect(confirm).toBeEnabled());
  });

  it("a To do form save in flight disables Confirm until it settles", async () => {
    const user = userEvent.setup();
    let settle!: (v: never) => void;
    m.loadTodos.mockResolvedValue(listed());
    m.todoAction.mockImplementation(() => new Promise((r) => (settle = r as never)));
    await start();
    await user.click(screen.getByRole("button", { name: "To do" }));
    await user.click(await screen.findByRole("button", { name: "Add" }));
    await user.type(await screen.findByLabelText("What"), "Call back");
    const confirm = await cardOnScreen(user);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(confirm).toBeDisabled());
    settle({ status: 200, body: { status: "ok", todo: { ...PLAIN_ROW, id: "t9", title: "Call back" } } } as never);
    await screen.findByText("Call back");
    await waitFor(() => expect(confirm).toBeEnabled());
  });

  describe("the user's own page", () => {
    const PAGE = {
      person: { name: "Dana Ray", phone: null, email: null },
      work: { company: null, website: null, roleObjectives: null },
      notes: [],
      notesTotal: 0,
    };
    beforeEach(() => {
      m.loadEstates.mockResolvedValue({ status: 200, body: { ...ESTATES, person: { id: "p-me", name: "Dana Ray" } } } as never);
      m.loadUserPage.mockResolvedValue({ status: 200, body: { page: PAGE } } as never);
    });
    async function openPage(user: User) {
      await user.click(screen.getByRole("button", { name: "Dana Ray, your page" }));
      await screen.findByLabelText("Phone");
    }

    it("a save in flight disables Confirm until it settles", async () => {
      const user = userEvent.setup();
      let settle!: (v: never) => void;
      m.saveUserPage.mockImplementation(() => new Promise((r) => (settle = r as never)));
      await start();
      await openPage(user);
      await user.type(screen.getByLabelText("Phone"), "123");
      const confirm = await cardOnScreen(user);
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(confirm).toBeDisabled());
      settle({ status: 200, body: { page: { ...PAGE, person: { ...PAGE.person, phone: "123" } } } } as never);
      await screen.findByText("Saved.");
      await waitFor(() => expect(confirm).toBeEnabled());
    });

    it("while a question is out, Save waits but Back stays usable", async () => {
      const user = userEvent.setup();
      let reply!: (v: never) => void;
      m.askCrm.mockImplementation(() => new Promise((r) => (reply = r as never)));
      await start();
      await openPage(user);
      await user.type(screen.getByLabelText("Phone"), "123");
      await openAsk(user);
      await ask(user, "Who?");
      await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());
      expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();
      // Typing on the page still works.
      expect(screen.getByLabelText("Phone")).toBeEnabled();
      reply(answer("Nobody."));
      await screen.findByText("Nobody.");
      await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
    });
  });
});

describe("Prepare me stands in only until the profile on screen changes", () => {
  const COMPANY = {
    kind: "company", personId: null, orgId: "oA", name: "Northwind", title: null, company: null,
    email: null, phone: null, linkedin: null, country: null, website: null, notes: null,
    member: { ...MEMBER, memberId: "mA", memberKind: "company" },
    memberOf: "self", timelineOf: null, timeline: [], timelineTotal: 0,
    people: [{ personId: "p2", name: "Bo Chen", title: null }],
    stages: JANE_PROFILE.stages,
  };
  const BO = { ...BOB_PROFILE, orgId: "oA", company: "Northwind" };
  const CO_HIT = {
    kind: "company", personId: null, orgId: "oA", name: "Northwind", title: null, company: null, email: null,
    member: { memberId: "mA", role: "lp_prospect", stage: "lead" }, memberOf: "self",
  };
  const ABOUT_BO = {
    ...ROW,
    id: "t5",
    title: "Call Bo",
    contact: { ...contactOf("mA", "", "Northwind", "Northwind"), memberKind: "company", personId: null, orgId: "oA", aboutPersonId: "p2", aboutName: "Bo Chen" },
  };

  beforeEach(() => {
    m.searchContacts.mockResolvedValue({ status: 200, body: { contacts: [CO_HIT] } } as never);
    m.loadProfile.mockImplementation(async (_e, target) => ({ status: 200, body: { profile: target.orgId === "oA" ? COMPANY : BO } }) as never);
    m.loadTodos.mockImplementation(async (_e, opts) => (opts?.member === "mA" ? listed(ABOUT_BO) : listed()));
    m.askCrm.mockResolvedValue(answer("Briefing."));
  });

  async function prepareOnCompany(user: User) {
    await start();
    await user.click(screen.getByRole("button", { name: "Contacts" }));
    await user.click(await screen.findByRole("button", { name: /Northwind/ }));
    await screen.findByRole("heading", { name: "Northwind" });
    await user.click(await screen.findByRole("button", { name: /^Call Bo/ }));
    await user.click(screen.getByRole("button", { name: "Prepare me" }));
    await screen.findByText("Briefing.");
    expect(within(askWindow()).getByText("Looking at Bo Chen · Northwind")).toBeInTheDocument();
  }

  it("A, then B, then back to A: Looking at names A, and A is what is sent", async () => {
    const user = userEvent.setup();
    await prepareOnCompany(user);
    await user.click(screen.getByRole("button", { name: "Bo Chen" }));
    await screen.findByRole("heading", { name: "Bo Chen" });
    await user.click(screen.getByRole("button", { name: "Northwind" }));
    await screen.findByRole("heading", { name: "Northwind" });
    await waitFor(() => expect(within(askWindow()).getByText("Looking at Northwind")).toBeInTheDocument());
    await ask(user, "And now?");
    await waitFor(() => expect(m.askCrm).toHaveBeenCalledTimes(2));
    expect(m.askCrm.mock.calls[1][0].viewing).toEqual({ orgId: "oA" });
  });

  it("A, then the To do tab, then back to A: Looking at names A", async () => {
    const user = userEvent.setup();
    await prepareOnCompany(user);
    await user.click(screen.getByRole("button", { name: "To do" }));
    await user.click(screen.getByRole("button", { name: "Contacts" }));
    await screen.findByRole("heading", { name: "Northwind" });
    await waitFor(() => expect(within(askWindow()).getByText("Looking at Northwind")).toBeInTheDocument());
  });
});

describe("Escape and focus on a live page", () => {
  it("Escape in a page field leaves Ask open and the focus where it was; in the window it closes Ask", async () => {
    const user = userEvent.setup();
    await start();
    await user.click(screen.getByRole("button", { name: "Contacts" }));
    const search = await screen.findByRole("textbox", { name: "Search contacts" });
    await openAsk(user);
    await user.click(search);
    await user.keyboard("{Escape}");
    expect(askWindow()).toBeInTheDocument();
    expect(search).toHaveFocus();
    await user.click(screen.getByRole("textbox", { name: "Your question" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Ask" })).toBeNull();
  });

  it("a chip that opens a profile minimises the window and hands focus to its bar, not to the page body", async () => {
    const user = userEvent.setup();
    m.askCrm.mockResolvedValue(
      answer("Anna is warm.", { refs: [{ memberId: "m1", name: "Anna Lee", company: "Northwind", kind: "person", personId: "p1" }] }),
    );
    await start();
    await openAsk(user);
    await ask(user, "Who is warm?");
    await user.click(await within(askWindow()).findByRole("button", { name: "Anna Lee" }));
    await screen.findByRole("heading", { name: "Anna Lee" });
    await waitFor(() => expect(within(askWindow()).getByRole("button", { name: /Tap to return to your conversation/ })).toHaveFocus());
  });

  it("the save line opens the profile and minimises an expanded window", async () => {
    const user = userEvent.setup();
    m.saveCard.mockResolvedValue({
      status: 200,
      body: { outcome: "added", person: "p1", org: null, role: "lp_prospect", filled: [] },
    } as never);
    await start();
    await user.type(screen.getByLabelText("Name"), "Anna Lee");
    await user.click(screen.getByRole("button", { name: "Save" }));
    const line = await screen.findByRole("button", { name: /Open contact/ });
    await openAsk(user);
    await user.click(line);
    expect(await screen.findByRole("heading", { name: "Anna Lee" })).toBeInTheDocument();
    expectMinimised();
  });
});
