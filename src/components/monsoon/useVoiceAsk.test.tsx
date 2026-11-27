// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AskTurn } from "./AskPanel";
import type { AskOutcome } from "./useAsk";
import type { Caption } from "@/lib/monsoon/ask/speech";
import {
  CAPTION_LINGER_MS,
  MAX_LISTEN_SECONDS,
  NO_SPEECH_MS,
  PAUSE_MS,
  REPLAY_WINDOW_MS,
  STOP_FALLBACK_MS,
  useVoiceAsk,
} from "./useVoiceAsk";
import { isAppleTouch, useAskSound, useIsPhone } from "./askDevice";

// ---- A fake speech recognition the tests drive by hand ----
class FakeRecognition {
  static instances: FakeRecognition[] = [];
  /** Chrome on Android sometimes never delivers onend after stop(); false mimics that. */
  static endOnStop = true;
  static startThrows = false;
  continuous = false;
  interimResults = false;
  lang = "";
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null = null;
  onerror: ((e: { error?: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = 0;
  stopped = 0;
  aborted = 0;
  ended = false;
  constructor() {
    FakeRecognition.instances.push(this);
  }
  start() {
    if (FakeRecognition.startThrows) throw new Error("already started");
    this.started += 1;
  }
  stop() {
    this.stopped += 1;
    if (FakeRecognition.endOnStop) this.end();
  }
  abort() {
    this.aborted += 1;
    this.end();
  }
  end() {
    if (this.ended) return;
    this.ended = true;
    this.onend?.();
  }
  say(text: string) {
    this.onresult?.({ results: [[{ transcript: text }]] });
  }
  fail(code: string) {
    this.onerror?.({ error: code });
  }
}

// ---- A fake Web Audio context whose clock the tests move ----
class FakeSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  connect() {}
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
}
class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static decodeFails = false;
  currentTime = 0;
  destination = {};
  sources: FakeSource[] = [];
  decoded = 0;
  closed = false;
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
  createBuffer() {
    return { silent: true };
  }
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  decodeAudioData() {
    this.decoded += 1;
    return FakeAudioContext.decodeFails ? Promise.reject(new Error("bad audio")) : Promise.resolve({ duration: 3 });
  }
  /** The answer's source: the last one that is not the silent unlock sample. */
  answerSource() {
    return this.sources.filter((s) => (s.buffer as { silent?: boolean } | null)?.silent !== true).at(-1);
  }
}

const TURN: AskTurn = { id: "a1", role: "assistant", content: "Anna Lee is at Northwind. She leads sales.", spoken: true };
const CAPTIONS: Caption[] = [
  { text: "Anna Lee is at Northwind.", start: 0, end: 1.5 },
  { text: "She leads sales.", start: 1.5, end: 3 },
];
function okOutcome(captions: Caption[] = CAPTIONS, audio: string | null = btoa("mp3")): AskOutcome {
  return { ok: true, turn: TURN, audio, captions };
}

function setup(opts: { sound?: boolean; disabled?: boolean; outcome?: AskOutcome | Promise<AskOutcome> } = {}) {
  const send = vi.fn(async (_text: string, _o: { spoken: true; sound: boolean }) => opts.outcome ?? okOutcome());
  const onEvent = vi.fn();
  const onAnswer = vi.fn();
  const onNeedsWindow = vi.fn();
  const hook = renderHook(
    (p: { sound: boolean; disabled: boolean }) =>
      useVoiceAsk({ send, sound: p.sound, disabled: p.disabled, onEvent, onAnswer, onNeedsWindow }),
    { initialProps: { sound: opts.sound ?? true, disabled: opts.disabled ?? false } },
  );
  return { ...hook, send, onEvent, onAnswer, onNeedsWindow };
}

const rec = () => FakeRecognition.instances.at(-1)!;
const ctx = () => FakeAudioContext.instances.at(-1)!;
async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}
function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** Tap, say something, pause: the question goes out and the answer comes back. */
async function askAndAnswer(h: ReturnType<typeof setup>, text = "where does Anna work") {
  act(() => h.result.current.onPill());
  act(() => rec().say(text));
  advance(PAUSE_MS);
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeRecognition.instances = [];
  FakeRecognition.endOnStop = true;
  FakeRecognition.startThrows = false;
  FakeAudioContext.instances = [];
  FakeAudioContext.decodeFails = false;
  vi.stubGlobal("SpeechRecognition", FakeRecognition);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 16) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("constants", () => {
  it("carries the exact values", () => {
    expect(MAX_LISTEN_SECONDS).toBe(20);
    expect(PAUSE_MS).toBe(1500);
    expect(NO_SPEECH_MS).toBe(7000);
    expect(REPLAY_WINDOW_MS).toBe(12_000);
    expect(CAPTION_LINGER_MS).toBe(1500);
    expect(STOP_FALLBACK_MS).toBe(2000);
  });
});

describe("robustness", () => {
  it("stop with no onend: after 2 s the question is sent once and the recognition aborted", async () => {
    FakeRecognition.endOnStop = false;
    const h = setup();
    act(() => h.result.current.onPill());
    act(() => rec().say("who is Anna"));
    advance(PAUSE_MS);
    expect(rec().stopped).toBe(1);
    expect(h.send).not.toHaveBeenCalled();
    advance(STOP_FALLBACK_MS - 1);
    expect(h.send).not.toHaveBeenCalled();
    advance(1);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith("who is Anna", { spoken: true, sound: true });
    expect(rec().aborted).toBe(1);
    await flush();
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("stop with no onend and nothing heard: the not-heard path runs once", () => {
    FakeRecognition.endOnStop = false;
    const h = setup();
    act(() => h.result.current.onPill());
    advance(NO_SPEECH_MS + STOP_FALLBACK_MS);
    expect(h.result.current.phase).toBe("idle");
    expect(h.result.current.notice).toBe("not_heard");
    expect(h.onEvent.mock.calls.filter((c) => c[0] === "no_speech")).toHaveLength(1);
  });

  it("onend arriving 1 s after stop: sent once, nothing more at 2 s", async () => {
    FakeRecognition.endOnStop = false;
    const h = setup();
    act(() => h.result.current.onPill());
    act(() => rec().say("who is Anna"));
    advance(PAUSE_MS);
    advance(1000);
    act(() => rec().end());
    expect(h.send).toHaveBeenCalledTimes(1);
    await flush();
    advance(STOP_FALLBACK_MS);
    await flush();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(rec().aborted).toBe(0);
  });

  it("sound is read once at the tap: a toggle mid-question does not change send's sound", async () => {
    const h = setup({ sound: false });
    act(() => h.result.current.onPill());
    act(() => rec().say("who is Anna"));
    h.rerender({ sound: true, disabled: false });
    advance(PAUSE_MS);
    expect(h.send).toHaveBeenCalledWith("who is Anna", { spoken: true, sound: false });
    expect(FakeAudioContext.instances).toHaveLength(0);
    await flush();
  });

  it("a start() that throws: event no_speech with start-failed, notice not_heard, idle", () => {
    FakeRecognition.startThrows = true;
    const h = setup();
    act(() => h.result.current.onPill());
    expect(h.result.current.phase).toBe("idle");
    expect(h.result.current.notice).toBe("not_heard");
    expect(h.onEvent).toHaveBeenCalledWith("no_speech", expect.stringMatching(/^start-failed; /));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("hidden during thinking: the answer is delivered without audio, idle with replay offered, replay then plays", async () => {
    let resolve!: (o: AskOutcome) => void;
    const h = setup({ outcome: new Promise<AskOutcome>((r) => (resolve = r)) });
    act(() => h.result.current.onPill());
    act(() => rec().say("who is Anna"));
    advance(PAUSE_MS);
    expect(h.result.current.phase).toBe("thinking");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(h.result.current.phase).toBe("thinking");
    resolve(okOutcome());
    await flush();
    expect(h.onAnswer).toHaveBeenCalledWith(TURN);
    expect(ctx().sources.filter((s) => s.started && (s.buffer as { silent?: boolean }).silent !== true)).toHaveLength(0);
    expect(h.result.current.phase).toBe("idle");
    expect(h.result.current.canReplay).toBe(true);
    expect(h.result.current.lastTurn).toEqual(TURN);

    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    act(() => h.result.current.replay());
    expect(h.result.current.phase).toBe("speaking");
    expect(ctx().answerSource()!.started).toBe(true);
  });

  it("a send that rejects after a long delay (the request layer's 70 s timeout) returns idle and opens the window", async () => {
    const outcome = new Promise<AskOutcome>((_, reject) => setTimeout(() => reject(new Error("timeout")), 70_000));
    outcome.catch(() => {});
    const h = setup({ outcome });
    act(() => h.result.current.onPill());
    act(() => rec().say("who is Anna"));
    advance(PAUSE_MS);
    expect(h.result.current.phase).toBe("thinking");
    // The send's clock started before the 1.5 s pause; it rejects at 70 s.
    advance(70_000 - PAUSE_MS - 1);
    await flush();
    expect(h.result.current.phase).toBe("thinking");
    expect(h.onNeedsWindow).not.toHaveBeenCalled();
    advance(1);
    await flush();
    expect(h.result.current.phase).toBe("idle");
    expect(h.onNeedsWindow).toHaveBeenCalledWith("failed");
  });
});

describe("listening", () => {
  it("a tap listens; a result then 1.5 s of silence sends the transcript once", async () => {
    const h = setup();
    act(() => h.result.current.onPill());
    expect(h.result.current.phase).toBe("listening");
    expect(h.result.current.secondsLeft).toBe(20);
    expect(rec().interimResults).toBe(true);
    expect(rec().continuous).toBe(true);
    expect(rec().lang).toBe(navigator.language || "en-US");
    act(() => rec().say("where does Anna work"));
    expect(h.result.current.heard).toBe("where does Anna work");
    advance(PAUSE_MS - 1);
    expect(h.send).not.toHaveBeenCalled();
    advance(1);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith("where does Anna work", { spoken: true, sound: true });
    expect(h.result.current.phase).toBe("thinking");
    expect(h.result.current.heard).toBe("where does Anna work");
    await flush();
  });

  it("counts the seconds down while listening", () => {
    const h = setup();
    act(() => h.result.current.onPill());
    act(() => rec().say("hello"));
    act(() => rec().say("hello there"));
    advance(1000);
    expect(h.result.current.secondsLeft).toBe(19);
  });

  it("7 s with nothing heard ends idle with notice not_heard and event no_speech", () => {
    const h = setup();
    act(() => h.result.current.onPill());
    advance(NO_SPEECH_MS);
    expect(h.result.current.phase).toBe("idle");
    expect(h.result.current.notice).toBe("not_heard");
    expect(h.onEvent).toHaveBeenCalledWith("no_speech", expect.stringContaining(navigator.userAgent.slice(0, 20)));
    expect(h.send).not.toHaveBeenCalled();
  });

  it("the 20 s cap stops listening and asks what was heard", async () => {
    const h = setup();
    act(() => h.result.current.onPill());
    // Keep talking so the pause timer never fires.
    for (let i = 0; i < 19; i += 1) {
      act(() => rec().say(`word ${i}`));
      advance(1000);
    }
    expect(h.result.current.phase).toBe("listening");
    act(() => rec().say("last words"));
    advance(1000);
    expect(rec().stopped).toBe(1);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith("last words", { spoken: true, sound: true });
    await flush();
  });

  it("a second tap while listening stops and asks", async () => {
    const h = setup();
    act(() => h.result.current.onPill());
    act(() => rec().say("who is Anna"));
    advance(500);
    act(() => h.result.current.onPill());
    expect(h.send).toHaveBeenCalledWith("who is Anna", { spoken: true, sound: true });
    await flush();
  });

  it("not-allowed opens the window with mic_blocked", () => {
    const h = setup();
    act(() => h.result.current.onPill());
    act(() => rec().fail("not-allowed"));
    act(() => rec().end());
    expect(h.onNeedsWindow).toHaveBeenCalledWith("mic_blocked");
    expect(h.onEvent).toHaveBeenCalledWith("mic_blocked", expect.stringMatching(/^not-allowed; /));
    expect(h.onEvent).not.toHaveBeenCalledWith("no_speech", expect.anything());
    expect(h.result.current.notice).toBe("mic_blocked");
    expect(h.result.current.phase).toBe("idle");
  });

  it("no recognition class: opens the window, event unsupported, never listens", () => {
    vi.stubGlobal("SpeechRecognition", undefined);
    const h = setup();
    act(() => h.result.current.onPill());
    expect(h.onNeedsWindow).toHaveBeenCalledWith("unsupported");
    expect(h.onEvent).toHaveBeenCalledWith("unsupported", expect.any(String));
    expect(h.result.current.phase).toBe("idle");
    expect(FakeRecognition.instances).toHaveLength(0);
  });

  it("event detail is the error code and user agent, at most 200 characters", () => {
    const ua = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("X".repeat(400));
    const h = setup();
    act(() => h.result.current.onPill());
    act(() => rec().fail("not-allowed"));
    const detail = h.onEvent.mock.calls.find((c) => c[0] === "mic_blocked")![1] as string;
    expect(detail.startsWith("not-allowed; XXX")).toBe(true);
    expect(detail).toHaveLength(200);
    ua.mockRestore();
  });

  it("on Apple touch, recognition is not continuous", () => {
    const ua = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)");
    const h = setup();
    act(() => h.result.current.onPill());
    expect(rec().continuous).toBe(false);
    ua.mockRestore();
  });

  it("does nothing when disabled and idle", () => {
    const h = setup({ disabled: true });
    act(() => h.result.current.onPill());
    expect(h.result.current.phase).toBe("idle");
    expect(FakeRecognition.instances).toHaveLength(0);
  });

  it("disabled while listening still lets the pill stop", async () => {
    const h = setup();
    act(() => h.result.current.onPill());
    act(() => rec().say("who is Anna"));
    advance(500);
    h.rerender({ sound: true, disabled: true });
    act(() => h.result.current.onPill());
    expect(rec().stopped).toBe(1);
    await flush();
  });

  it("Review Focus 1: two taps in the same tick start one recognition", () => {
    const h = setup();
    act(() => {
      h.result.current.onPill();
      h.result.current.onPill();
    });
    expect(FakeRecognition.instances).toHaveLength(1);
    expect(rec().started).toBe(1);
    expect(h.result.current.phase).toBe("listening");
  });

  it("Review Focus 1: the pill during thinking does nothing", async () => {
    let resolve!: (o: AskOutcome) => void;
    const h = setup({ outcome: new Promise<AskOutcome>((r) => (resolve = r)) });
    act(() => h.result.current.onPill());
    act(() => rec().say("who is Anna"));
    advance(PAUSE_MS);
    expect(h.result.current.phase).toBe("thinking");
    act(() => h.result.current.onPill());
    act(() => h.result.current.onPill());
    expect(h.result.current.phase).toBe("thinking");
    expect(FakeRecognition.instances).toHaveLength(1);
    expect(h.send).toHaveBeenCalledTimes(1);
    resolve(okOutcome());
    await flush();
  });

  it("Review Focus 4: hidden while listening aborts without sending and ends idle", () => {
    const h = setup();
    act(() => h.result.current.onPill());
    act(() => rec().say("who is Anna"));
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(rec().aborted).toBe(1);
    expect(h.result.current.phase).toBe("idle");
    advance(PAUSE_MS * 2);
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe("speaking", () => {
  it("a successful outcome: onAnswer, speaking with the first caption, then idle and the replay window", async () => {
    const h = setup();
    await askAndAnswer(h);
    expect(h.onAnswer).toHaveBeenCalledWith(TURN);
    expect(h.result.current.phase).toBe("speaking");
    expect(h.result.current.caption).toBe("Anna Lee is at Northwind.");
    expect(h.result.current.lastTurn).toEqual(TURN);
    expect(ctx().decoded).toBe(1);
    const src = ctx().answerSource()!;
    expect(src.started).toBe(true);

    // The clock moves into the second sentence.
    ctx().currentTime = 2;
    advance(50);
    expect(h.result.current.caption).toBe("She leads sales.");

    act(() => src.onended?.());
    expect(h.result.current.phase).toBe("idle");
    expect(h.result.current.canReplay).toBe(true);
    expect(h.result.current.caption).toBe("She leads sales.");
    advance(CAPTION_LINGER_MS);
    expect(h.result.current.caption).toBe("");
    advance(REPLAY_WINDOW_MS - CAPTION_LINGER_MS - 1);
    expect(h.result.current.canReplay).toBe(true);
    advance(1);
    expect(h.result.current.canReplay).toBe(false);
  });

  it("onAnswer is called before audio starts", async () => {
    const h = setup();
    let startedAtAnswer: boolean | undefined;
    h.onAnswer.mockImplementation(() => {
      startedAtAnswer = ctx().answerSource()?.started ?? false;
    });
    await askAndAnswer(h);
    expect(startedAtAnswer).toBe(false);
  });

  it("replay plays the kept audio again and sends event replay", async () => {
    const h = setup();
    await askAndAnswer(h);
    act(() => ctx().answerSource()!.onended?.());
    const before = ctx().answerSource();
    act(() => h.result.current.replay());
    expect(h.onEvent).toHaveBeenCalledWith("replay");
    expect(h.result.current.phase).toBe("speaking");
    expect(h.result.current.canReplay).toBe(false);
    expect(ctx().answerSource()).not.toBe(before);
    expect(ctx().answerSource()!.started).toBe(true);
    expect(ctx().decoded).toBe(1);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("the pill during speaking stops: idle and event stopped", async () => {
    const h = setup();
    await askAndAnswer(h);
    const src = ctx().answerSource()!;
    act(() => h.result.current.onPill());
    expect(src.stopped).toBe(true);
    expect(h.result.current.phase).toBe("idle");
    expect(h.onEvent).toHaveBeenCalledWith("stopped");
  });

  it("outcome failed opens the window and goes idle", async () => {
    const h = setup({ outcome: { ok: false, reason: "failed" } });
    await askAndAnswer(h);
    expect(h.onNeedsWindow).toHaveBeenCalledWith("failed");
    expect(h.result.current.phase).toBe("idle");
    expect(h.onAnswer).not.toHaveBeenCalled();
  });

  it("outcome unauthorized opens the window with unauthorized", async () => {
    const h = setup({ outcome: { ok: false, reason: "unauthorized" } });
    await askAndAnswer(h);
    expect(h.onNeedsWindow).toHaveBeenCalledWith("unauthorized");
    expect(h.result.current.phase).toBe("idle");
  });

  it.each(["busy", "empty", "stale"] as const)("outcome %s returns to idle silently", async (reason) => {
    const h = setup({ outcome: { ok: false, reason } });
    await askAndAnswer(h);
    expect(h.result.current.phase).toBe("idle");
    expect(h.result.current.notice).toBeNull();
    expect(h.onNeedsWindow).not.toHaveBeenCalled();
  });

  it("send throwing is treated as failed", async () => {
    const h = setup({ outcome: Promise.reject(new Error("network")) });
    await askAndAnswer(h);
    expect(h.onNeedsWindow).toHaveBeenCalledWith("failed");
    expect(h.result.current.phase).toBe("idle");
  });

  it("sound off: sends sound false, no decode, captions on the timer", async () => {
    const h = setup({ sound: false });
    await askAndAnswer(h);
    expect(h.send).toHaveBeenCalledWith("where does Anna work", { spoken: true, sound: false });
    expect(FakeAudioContext.instances.every((c) => c.decoded === 0)).toBe(true);
    expect(h.result.current.phase).toBe("speaking");
    expect(h.result.current.caption).toBe("Anna Lee is at Northwind.");
    advance(1650);
    expect(h.result.current.caption).toBe("She leads sales.");
    advance(1500);
    expect(h.result.current.phase).toBe("idle");
    expect(h.result.current.canReplay).toBe(true);
  });

  it("no audio in the outcome: captions on the timer", async () => {
    const h = setup({ outcome: okOutcome(CAPTIONS, null) });
    await askAndAnswer(h);
    expect(ctx().decoded).toBe(0);
    expect(h.result.current.phase).toBe("speaking");
    advance(3200);
    expect(h.result.current.phase).toBe("idle");
  });

  it("Review Focus 3: decode failure runs captions on the timer and reaches idle", async () => {
    FakeAudioContext.decodeFails = true;
    const h = setup();
    await askAndAnswer(h);
    expect(h.result.current.phase).toBe("speaking");
    expect(h.result.current.caption).toBe("Anna Lee is at Northwind.");
    advance(3200);
    expect(h.result.current.phase).toBe("idle");
  });

  it("Review Focus 4: hidden while speaking stops the audio and ends idle", async () => {
    const h = setup();
    await askAndAnswer(h);
    const src = ctx().answerSource()!;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(src.stopped).toBe(true);
    expect(h.result.current.phase).toBe("idle");
  });

  it("Review Focus 5: no captions goes straight to idle without replay", async () => {
    const h = setup({ outcome: okOutcome([]) });
    await askAndAnswer(h);
    expect(h.onAnswer).toHaveBeenCalled();
    expect(h.result.current.phase).toBe("idle");
    expect(h.result.current.canReplay).toBe(false);
    expect(h.result.current.caption).toBe("");
  });

  it("Review Focus 5: a 600-character caption is shown whole", async () => {
    const long = "A".repeat(599) + ".";
    const h = setup({ outcome: okOutcome([{ text: long, start: 0, end: 30 }]) });
    await askAndAnswer(h);
    expect(h.result.current.caption).toBe(long);
    expect(h.result.current.caption).toHaveLength(600);
  });

  it("tears everything down on unmount", async () => {
    const h = setup();
    await askAndAnswer(h);
    const c = ctx();
    const src = c.answerSource()!;
    h.unmount();
    expect(src.stopped).toBe(true);
    expect(c.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    // The page listener went with it: a later visibility change changes nothing.
    const events = h.onEvent.mock.calls.length;
    const sources = c.sources.length;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    expect(() => document.dispatchEvent(new Event("visibilitychange"))).not.toThrow();
    expect(h.onEvent.mock.calls.length).toBe(events);
    expect(c.sources.length).toBe(sources);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("unmount while listening aborts recognition", () => {
    const h = setup();
    act(() => h.result.current.onPill());
    const r = rec();
    h.unmount();
    expect(r.aborted).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("askDevice", () => {
  it("isAppleTouch spots iPhone and iPad-as-Mac", () => {
    const ua = vi.spyOn(navigator, "userAgent", "get");
    ua.mockReturnValue("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)");
    expect(isAppleTouch()).toBe(true);
    ua.mockReturnValue("Mozilla/5.0 (Linux; Android 15)");
    expect(isAppleTouch()).toBe(false);
    ua.mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    let touchPoints = 5;
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, get: () => touchPoints });
    expect(isAppleTouch()).toBe(true);
    touchPoints = 0;
    expect(isAppleTouch()).toBe(false);
    delete (navigator as unknown as Record<string, unknown>).maxTouchPoints;
    ua.mockRestore();
  });

  it("useIsPhone: false with a fine hovering pointer, true otherwise", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(hover: hover) and (pointer: fine)", addEventListener() {}, removeEventListener() {} }));
    expect(renderHook(() => useIsPhone()).result.current).toBe(false);
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    expect(renderHook(() => useIsPhone()).result.current).toBe(true);
  });

  it("useAskSound: absent is on, off is stored, storage errors mean on", () => {
    // Node's own experimental localStorage can shadow jsdom's; use a fixed fake.
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
    });
    const a = renderHook(() => useAskSound());
    expect(a.result.current[0]).toBe(true);
    act(() => a.result.current[1](false));
    expect(a.result.current[0]).toBe(false);
    expect(localStorage.getItem("monsoon.ask.sound")).toBe("off");
    expect(renderHook(() => useAskSound()).result.current[0]).toBe(false);
    act(() => a.result.current[1](true));
    expect(localStorage.getItem("monsoon.ask.sound")).toBe("on");

    const blocked = () => {
      throw new Error("blocked");
    };
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked, removeItem: blocked });
    const b = renderHook(() => useAskSound());
    expect(b.result.current[0]).toBe(true);
    act(() => b.result.current[1](false));
    expect(b.result.current[0]).toBe(false);
  });
});
