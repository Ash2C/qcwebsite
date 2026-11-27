// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
  sendAskFeedback: vi.fn(),
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
    { key: "traxo", label: "Traxo", defaultRole: "lp_prospect", available: true, todos: true, roles: [{ key: "lp_prospect", label: "LP prospect" }] },
  ],
};
const PROFILE = {
  kind: "person", personId: "p1", orgId: "o-p1", name: "Anna Lee", title: "Partner", company: "Northwind",
  email: null, phone: null, linkedin: null, country: null, website: null, notes: null,
  member: { memberId: "m1", memberKind: "person", role: "lp_prospect", stage: "lead", owner: null, priority: null, nextAction: null, nextActionDate: null, due: "later", notes: null },
  memberOf: "self", timelineOf: null, timeline: [], timelineTotal: 0, people: [],
  stages: [{ key: "lead", label: "Lead", terminal: false }],
};
const NOTE = {
  proposal: { kind: "add_note", estate: "traxo", memberId: "m1", memberKind: "person", memberName: "Anna Lee", company: "Northwind", about: "the call", expires: 1 },
  signature: "sig-note",
  text: "Call went well",
};
const ANNA_REF = { memberId: "m1", name: "Anna Lee", company: "Northwind", kind: "person", personId: "p1" };

/** A spoken answer as the server sends it: captions-only (no audio), short enough to finish quickly. */
const spoken = (text: string, extra: Record<string, unknown> = {}) =>
  ({ status: 200, body: { answer: text, refs: [], proposals: [], audio: null, captions: [{ text, start: 0, end: 0.2 }], ...extra } }) as never;

// ---- A fake speech recognition the tests drive by hand ----
class FakeRecognition {
  static instances: FakeRecognition[] = [];
  continuous = false;
  interimResults = false;
  lang = "";
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null = null;
  onerror: ((e: { error?: string }) => void) | null = null;
  onend: (() => void) | null = null;
  ended = false;
  constructor() {
    FakeRecognition.instances.push(this);
  }
  start() {}
  stop() {
    this.end();
  }
  abort() {
    this.end();
  }
  end() {
    if (this.ended) return;
    this.ended = true;
    this.onend?.();
  }
}
const rec = () => FakeRecognition.instances.at(-1)!;

// ---- A fake Web Audio context: an answer's source plays until stopped ----
class FakeSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  stopped = false;
  connect() {}
  start() {}
  stop() {
    this.stopped = true;
  }
}
class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  currentTime = 0;
  destination = {};
  sources: FakeSource[] = [];
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
  createBuffer() {
    return { silent: true };
  }
  createBufferSource() {
    const src = new FakeSource();
    this.sources.push(src);
    return src;
  }
  decodeAudioData() {
    return Promise.resolve({ duration: 3 });
  }
}
/** The answer's source: the last one that is not the silent unlock sample. */
const answerSource = () =>
  FakeAudioContext.instances.at(-1)!.sources.filter((src) => (src.buffer as { silent?: boolean } | null)?.silent !== true).at(-1);

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  };
}

/** A phone (no fine pointer, a coarse one), a fine pointer that cannot hover (a stylus), or a computer with a mouse. */
function device(kind: "phone" | "stylus" | "computer") {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches:
      kind === "phone" ? query === "(pointer: coarse)" : kind === "stylus" ? query === "(pointer: fine)" : query === "(hover: hover) and (pointer: fine)",
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
  FakeRecognition.instances = [];
  vi.stubGlobal("SpeechRecognition", FakeRecognition);
  device("phone");
  m.loadEstates.mockResolvedValue({ status: 200, body: ESTATES } as never);
  m.loadTodos.mockResolvedValue({ status: 200, body: { ready: true, open: [], done: [] } } as never);
  m.loadImports.mockResolvedValue({ status: 200, body: { imports: [] } } as never);
  m.loadProfile.mockResolvedValue({ status: 200, body: { profile: PROFILE } } as never);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function start() {
  render(<MonsoonApp />);
  await screen.findByRole("button", { name: "Save" });
}

const pill = () => screen.queryByRole("button", { name: "Ask: tap and speak your question" });
const askWindow = () => screen.queryByRole("dialog", { name: "Ask" });
const questionBox = () => screen.queryByRole("textbox", { name: "Your question" });

/** Tap the pill, say the words, tap again to send. */
async function speak(user: User, words: string) {
  await user.click(await screen.findByRole("button", { name: "Ask: tap and speak your question" }));
  act(() => rec().onresult?.({ results: [[{ transcript: words }]] }));
  await user.click(screen.getByRole("button", { name: "Stop listening and ask" }));
}

/** The answer has been spoken and the pill is idle again, offering replay. */
async function answered() {
  await screen.findByRole("button", { name: "Replay the answer" }, { timeout: 3000 });
}

describe("voice Ask on a phone", () => {
  it("a spoken question and its answer land in the window's conversation as ordinary turns", async () => {
    const user = userEvent.setup();
    m.askCrm.mockResolvedValue(spoken("Anna is warm."));
    await start();
    expect(screen.queryByRole("button", { name: "Ask Monsoon" })).toBeNull();
    await speak(user, "Who is warm?");
    await waitFor(() => expect(m.askCrm).toHaveBeenCalledTimes(1));
    expect(m.askCrm.mock.calls[0][0]).toMatchObject({ spoken: true, sound: true, messages: [{ role: "user", content: "Who is warm?" }] });
    await answered();
    expect(askWindow()).toBeNull();
    await user.click(screen.getByRole("button", { name: "Type a question instead" }));
    const conversation = within(askWindow()!).getByLabelText("Conversation");
    expect(within(conversation).getByText("Who is warm?")).toBeInTheDocument();
    expect(within(conversation).getByText("Anna is warm.")).toBeInTheDocument();
  });

  it("a reply with a change card expands the window with the card visible and unconfirmed", async () => {
    const user = userEvent.setup();
    m.askCrm.mockResolvedValue(spoken("A note is waiting for you to confirm.", { proposals: [NOTE] }));
    await start();
    await speak(user, "Add a note to Anna");
    const win = await screen.findByRole("dialog", { name: "Ask" });
    expect(await within(win).findByRole("button", { name: "Confirm" })).toBeEnabled();
    expect(within(win).getByText("Call went well")).toBeInTheDocument();
    expect(m.actOnCrm).not.toHaveBeenCalled();
    // Expanded: the window takes the pill row's place; on a phone the box is not focused.
    expect(pill()).toBeNull();
    expect(questionBox()).not.toHaveFocus();
  });

  it("a reply with a research offer expands the window too", async () => {
    const user = userEvent.setup();
    m.askCrm.mockResolvedValue(spoken("I can look into her.", { research: { personId: "p1", name: "Anna Lee", company: "Northwind" } }));
    await start();
    await speak(user, "Research Anna");
    const win = await screen.findByRole("dialog", { name: "Ask" });
    expect(await within(win).findByRole("button", { name: "Run research" })).toBeEnabled();
    expect(m.researchContact).not.toHaveBeenCalled();
  });

  it("a reply with only contacts does not open the window and shows chips that open the profile", async () => {
    const user = userEvent.setup();
    m.askCrm.mockResolvedValue(spoken("Anna Lee is warm.", { refs: [ANNA_REF, ANNA_REF] }));
    await start();
    await speak(user, "Who is warm?");
    await answered();
    expect(askWindow()).toBeNull();
    const chips = screen.getByRole("group", { name: "Contacts mentioned" });
    expect(within(chips).getAllByRole("button")).toHaveLength(1);
    await user.click(within(chips).getByRole("button", { name: "Anna Lee" }));
    expect(await screen.findByRole("heading", { name: "Anna Lee" })).toBeInTheDocument();
  });

  it("a failed reply opens the window with the question in the box and the failure line", async () => {
    const user = userEvent.setup();
    m.askCrm.mockResolvedValue({ status: 502, body: { error: "upstream" } } as never);
    await start();
    await speak(user, "Who is warm?");
    const win = await screen.findByRole("dialog", { name: "Ask" });
    expect(questionBox()).toHaveValue("Who is warm?");
    expect(within(win).getByRole("alert")).toHaveTextContent("Could not get an answer. Check signal and try again.");
    expect(within(win).queryByText("Who is warm?", { selector: "div" })).toBeNull();
  });

  it("the keyboard button opens the window with the box focused and records typed_instead", async () => {
    const user = userEvent.setup();
    await start();
    await user.click(screen.getByRole("button", { name: "Type a question instead" }));
    expect(await screen.findByRole("textbox", { name: "Your question" })).toHaveFocus();
    expect(m.sendAskFeedback).toHaveBeenCalledWith({ estate: "traxo", kind: "typed_instead", mode: "voice" });
  });

  it("the pill shows while the window is minimised and not while it is expanded; closing hands focus to it", async () => {
    const user = userEvent.setup();
    await start();
    await user.click(screen.getByRole("button", { name: "Type a question instead" }));
    expect(pill()).toBeNull();
    await user.click(screen.getByRole("button", { name: "Minimise Ask and keep reading" }));
    expect(pill()).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Expand Ask" }));
    expect(pill()).toBeNull();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(pill()).toHaveFocus();
  });

  it("sound off in the window header sends sound: false and is remembered", async () => {
    const user = userEvent.setup();
    m.askCrm.mockResolvedValue(spoken("Anna is warm."));
    await start();
    await user.click(screen.getByRole("button", { name: "Type a question instead" }));
    await user.click(screen.getByRole("button", { name: "Turn spoken answers off" }));
    expect(localStorage.getItem("monsoon.ask.sound")).toBe("off");
    await user.click(screen.getByRole("button", { name: "Minimise Ask and keep reading" }));
    await speak(user, "Who is warm?");
    await waitFor(() => expect(m.askCrm).toHaveBeenCalledTimes(1));
    expect(m.askCrm.mock.calls[0][0]).toMatchObject({ spoken: true, sound: false });
  });

  it("thumbs beside the pill rate the answer in the conversation and record it as voice", async () => {
    const user = userEvent.setup();
    m.askCrm.mockResolvedValue(spoken("Anna is warm."));
    await start();
    await speak(user, "Who is warm?");
    await answered();
    await user.click(screen.getByRole("button", { name: "Good answer" }));
    expect(m.sendAskFeedback).toHaveBeenCalledWith({ estate: "traxo", kind: "up", mode: "voice" });
    expect(screen.getByRole("button", { name: "Good answer" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Type a question instead" }));
    expect(within(askWindow()!).getByRole("button", { name: "Good answer" })).toHaveAttribute("aria-pressed", "true");
  });

  it("no speech recognition: the pill opens the window focused with the keyboard-microphone hint", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("SpeechRecognition", undefined);
    await start();
    await user.click(screen.getByRole("button", { name: "Ask: tap and speak your question" }));
    expect(await screen.findByRole("textbox", { name: "Your question" })).toHaveFocus();
    expect(screen.getByText("Tap the microphone on the keyboard and talk, then press Ask.")).toBeInTheDocument();
    expect(m.sendAskFeedback).toHaveBeenCalledWith(expect.objectContaining({ estate: "traxo", kind: "unsupported", mode: "voice" }));
  });

  it("microphone blocked opens the window focused for typing", async () => {
    const user = userEvent.setup();
    await start();
    await user.click(screen.getByRole("button", { name: "Ask: tap and speak your question" }));
    act(() => rec().onerror?.({ error: "not-allowed" }));
    expect(await screen.findByRole("textbox", { name: "Your question" })).toHaveFocus();
    expect(m.sendAskFeedback).toHaveBeenCalledWith(expect.objectContaining({ kind: "mic_blocked", mode: "voice" }));
  });
});

describe("voice Ask review fixes", () => {
  it("switching sound off in the expanded window stops the answer being spoken", async () => {
    const user = userEvent.setup();
    FakeAudioContext.instances = [];
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 16) as unknown as number);
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    m.askCrm.mockResolvedValue(spoken("A note is waiting for you to confirm.", { proposals: [NOTE], audio: btoa("mp3") }));
    await start();
    await speak(user, "Add a note to Anna");
    await screen.findByRole("dialog", { name: "Ask" });
    await waitFor(() => expect(answerSource()).toBeDefined());
    expect(answerSource()!.stopped).toBe(false);
    await user.click(screen.getByRole("button", { name: "Turn spoken answers off" }));
    expect(answerSource()!.stopped).toBe(true);
    await user.click(screen.getByRole("button", { name: "Minimise Ask and keep reading" }));
    expect(pill()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replay the answer" })).toBeInTheDocument();
  });

  it("closing the window while an answer is spoken leaves it playing, with Stop on the pill", async () => {
    const user = userEvent.setup();
    FakeAudioContext.instances = [];
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 16) as unknown as number);
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    m.askCrm.mockResolvedValue(spoken("A note is waiting for you to confirm.", { proposals: [NOTE], audio: btoa("mp3") }));
    await start();
    await speak(user, "Add a note to Anna");
    await screen.findByRole("dialog", { name: "Ask" });
    await waitFor(() => expect(answerSource()).toBeDefined());
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(answerSource()!.stopped).toBe(false);
    expect(screen.getByRole("button", { name: "Stop the answer" })).toBeInTheDocument();
  });

  it("a page write that starts while listening holds the question: it goes into the box and nothing is sent", async () => {
    const user = userEvent.setup();
    m.saveCard.mockImplementation(() => new Promise(() => {}));
    await start();
    await user.type(screen.getByLabelText("Name"), "Anna Lee");
    await user.click(await screen.findByRole("button", { name: "Ask: tap and speak your question" }));
    act(() => rec().onresult?.({ results: [[{ transcript: "Who is warm?" }]] }));
    // The save starts while the phone is still listening.
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(screen.getByRole("button", { name: "Stop listening and ask" }));
    expect(await screen.findByRole("textbox", { name: "Your question" })).toHaveValue("Who is warm?");
    expect(m.askCrm).not.toHaveBeenCalled();
  });

  it("a held question is added under text already in the box, never over it", async () => {
    const user = userEvent.setup();
    m.saveCard.mockImplementation(() => new Promise(() => {}));
    await start();
    await user.click(screen.getByRole("button", { name: "Type a question instead" }));
    await user.type(screen.getByRole("textbox", { name: "Your question" }), "Typed first");
    await user.click(screen.getByRole("button", { name: "Minimise Ask and keep reading" }));
    await user.type(screen.getByLabelText("Name"), "Anna Lee");
    await user.click(screen.getByRole("button", { name: "Ask: tap and speak your question" }));
    act(() => rec().onresult?.({ results: [[{ transcript: "Who is warm?" }]] }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(screen.getByRole("button", { name: "Stop listening and ask" }));
    await waitFor(() => expect(questionBox()).toHaveValue("Typed first\nWho is warm?"));
    expect(m.askCrm).not.toHaveBeenCalled();
  });

  it("after a blocked microphone opens the window, closing it leaves no stale notice in the strip", async () => {
    const user = userEvent.setup();
    await start();
    await user.click(screen.getByRole("button", { name: "Ask: tap and speak your question" }));
    act(() => rec().onerror?.({ error: "not-allowed" }));
    await screen.findByRole("textbox", { name: "Your question" });
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(pill()).toBeInTheDocument();
    expect(screen.queryByText(/not allowed to use the microphone/)).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("a not-heard notice is gone once the window has been opened and closed", async () => {
    const user = userEvent.setup();
    await start();
    await user.click(screen.getByRole("button", { name: "Ask: tap and speak your question" }));
    act(() => rec().end());
    expect(await screen.findByText("I did not catch that. Tap and try again.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Type a question instead" }));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("I did not catch that. Tap and try again.")).toBeNull();
  });
});

describe("voice Ask final review fixes", () => {
  it("dictation into the box stops when the window is minimised", async () => {
    const user = userEvent.setup();
    await start();
    await user.click(screen.getByRole("button", { name: "Type a question instead" }));
    await user.click(screen.getByRole("button", { name: "Speak your question" }));
    const dictation = rec();
    expect(dictation.ended).toBe(false);
    await user.click(screen.getByRole("button", { name: "Minimise Ask and keep reading" }));
    expect(dictation.ended).toBe(true);
    // Late words from the dropped session go nowhere.
    act(() => dictation.onresult?.({ results: [[{ transcript: "late words" }]] }));
    await user.click(screen.getByRole("button", { name: "Expand Ask" }));
    expect(questionBox()).toHaveValue("");
    expect(screen.getByRole("button", { name: "Speak your question" })).toBeInTheDocument();
  });

  it("dictation into the box stops when the window is closed", async () => {
    const user = userEvent.setup();
    await start();
    await user.click(screen.getByRole("button", { name: "Type a question instead" }));
    await user.click(screen.getByRole("button", { name: "Speak your question" }));
    const dictation = rec();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(dictation.ended).toBe(true);
  });

  it("a fine pointer that cannot hover gets the voice pill, and a spoken answer that opens the window leaves the box unfocused", async () => {
    device("stylus");
    const user = userEvent.setup();
    m.askCrm.mockResolvedValue(spoken("A note is waiting for you to confirm.", { proposals: [NOTE] }));
    await start();
    expect(screen.queryByRole("button", { name: "Ask Monsoon" })).toBeNull();
    await speak(user, "Add a note to Anna");
    const win = await screen.findByRole("dialog", { name: "Ask" });
    expect(await within(win).findByRole("button", { name: "Confirm" })).toBeEnabled();
    expect(questionBox()).not.toHaveFocus();
  });

  it("a fine pointer that cannot hover: the keyboard button still opens the window focused", async () => {
    device("stylus");
    const user = userEvent.setup();
    await start();
    await user.click(screen.getByRole("button", { name: "Type a question instead" }));
    expect(await screen.findByRole("textbox", { name: "Your question" })).toHaveFocus();
  });
});

describe("Ask on a computer", () => {
  it("renders no voice pill; the Ask button opens the window with the box focused", async () => {
    device("computer");
    const user = userEvent.setup();
    await start();
    expect(pill()).toBeNull();
    expect(screen.queryByRole("button", { name: "Type a question instead" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Ask Monsoon" }));
    expect(await screen.findByRole("textbox", { name: "Your question" })).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Turn spoken answers off" })).toBeNull();
  });
});
