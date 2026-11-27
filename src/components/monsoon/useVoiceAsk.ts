"use client";

import { useEffect, useRef, useState } from "react";
import type { AskTurn } from "./AskPanel";
import type { AskOutcome } from "./useAsk";
import type { Caption } from "@/lib/monsoon/ask/speech";
import { isAppleTouch } from "./askDevice";

// Voice Ask on phones, with no UI of its own: tap the pill and speak; the browser's own speech
// recognition turns the words into text (the audio goes to Apple or Google, never to Monsoon's
// server); the question goes out through `send`; the answer comes back as audio with timed
// captions, one sentence at a time. The pill and caption strip are drawn by the caller.

export const MAX_LISTEN_SECONDS = 20;
/** Listening ends this long after the last words heard. */
export const PAUSE_MS = 1500;
/** Listening ends this long after starting if nothing was heard at all. */
export const NO_SPEECH_MS = 7000;
/** "Hear it again" stays offered this long after an answer ends. */
export const REPLAY_WINDOW_MS = 12_000;
/** The last sentence stays up this long after an answer ends. */
export const CAPTION_LINGER_MS = 1500;
/** Captions without audio step on this timer, from their own times. */
const CAPTION_TICK_MS = 150;

export type VoicePhase = "idle" | "listening" | "thinking" | "speaking";
export type VoiceNotice = "not_heard" | "mic_blocked" | null;
type VoiceEvent = "no_speech" | "mic_blocked" | "unsupported" | "replay" | "stopped";
type WindowReason = "unsupported" | "mic_blocked" | "failed" | "unauthorized";

export type VoiceAskArgs = {
  /** Sends the question; the hook passes { spoken: true, sound }. */
  send(text: string, opts: { spoken: true; sound: boolean }): Promise<AskOutcome>;
  sound: boolean;
  disabled: boolean;
  onEvent(kind: VoiceEvent, detail?: string): void;
  /** The answer arrived (called before audio starts). */
  onAnswer(turn: AskTurn): void;
  /** No recognition here, mic blocked, or the send failed: the caller opens the window. */
  onNeedsWindow(reason: WindowReason): void;
};

// The browser's speech recognition, which TypeScript's DOM types do not name (as in useDictation).
type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

function recognitionClass(): (new () => Recognition) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  const found = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return typeof found === "function" ? (found as new () => Recognition) : null;
}

function audioContextClass(): (new () => AudioContext) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  const found = w.AudioContext ?? w.webkitAudioContext;
  return typeof found === "function" ? (found as new () => AudioContext) : null;
}

function transcript(results: ArrayLike<ArrayLike<{ transcript: string }>>): string {
  let text = "";
  for (let i = 0; i < results.length; i += 1) text += results[i]?.[0]?.transcript ?? "";
  return text;
}

/** The sentence for time t: the latest one that has started, held through any gap. */
function captionAt(caps: Caption[], t: number): string {
  let text = caps[0]?.text ?? "";
  for (const c of caps) if (t >= c.start) text = c.text;
  return text;
}

/** Why a voice attempt went wrong, for the review: the browser's code and the phone it ran on. */
function eventDetail(code: string): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return `${code}; ${ua}`.slice(0, 200);
}

function decodeBase64(audio: string): ArrayBuffer {
  return Uint8Array.from(atob(audio), (c) => c.charCodeAt(0)).buffer;
}

export function useVoiceAsk(args: VoiceAskArgs) {
  const argsRef = useRef(args);
  argsRef.current = args;

  const [phase, setPhaseState] = useState<VoicePhase>("idle");
  const [heard, setHeard] = useState("");
  const [caption, setCaption] = useState("");
  const [notice, setNotice] = useState<VoiceNotice>(null);
  const [secondsLeft, setSecondsLeft] = useState(MAX_LISTEN_SECONDS);
  const [canReplay, setCanReplayState] = useState(false);
  const [lastTurn, setLastTurn] = useState<AskTurn | null>(null);

  // Mirrors of state read inside callbacks, so two taps in one tick see the first tap's result.
  const phaseRef = useRef<VoicePhase>("idle");
  const canReplayRef = useRef(false);
  /** Bumped whenever a question is abandoned (hidden page, unmount); late answers are dropped. */
  const runRef = useRef(0);
  /** A listen started in this tick; a second tap in the same tick is its echo, not a stop. */
  const justStartedRef = useRef(false);
  const justStartedTimer = useRef<number | null>(null);

  const recRef = useRef<Recognition | null>(null);
  const heardRef = useRef("");
  const lastErrorRef = useRef("");
  const tickTimer = useRef<number | null>(null);
  const capTimer = useRef<number | null>(null);
  const pauseTimer = useRef<number | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const captionTimer = useRef<number | null>(null);
  const captionsRef = useRef<Caption[]>([]);
  const lingerTimer = useRef<number | null>(null);
  const replayTimer = useRef<number | null>(null);

  function setPhase(p: VoicePhase) {
    phaseRef.current = p;
    setPhaseState(p);
  }
  function setCanReplay(on: boolean) {
    canReplayRef.current = on;
    setCanReplayState(on);
  }

  function clearTimer(ref: { current: number | null }) {
    if (ref.current !== null) {
      window.clearTimeout(ref.current);
      window.clearInterval(ref.current);
      ref.current = null;
    }
  }

  function clearListenTimers() {
    clearTimer(tickTimer);
    clearTimer(capTimer);
    clearTimer(pauseTimer);
  }

  function clearAfterTimers() {
    clearTimer(lingerTimer);
    clearTimer(replayTimer);
  }

  /** Stop the answer's audio and caption clock, without changing the phase. */
  function stopPlayback() {
    const src = sourceRef.current;
    sourceRef.current = null;
    try {
      src?.stop();
    } catch {
      // Not started or already stopped.
    }
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    clearTimer(captionTimer);
  }

  // Created and resumed inside the pill tap: that is what lets iOS play the answer seconds later.
  function unlockAudio() {
    const AC = audioContextClass();
    if (!AC) return;
    try {
      if (!ctxRef.current) ctxRef.current = new AC();
      const ctx = ctxRef.current;
      void ctx.resume().catch(() => {});
      // One silent sample, started inside the tap, fully unlocks iOS output.
      const s = ctx.createBufferSource();
      s.buffer = ctx.createBuffer(1, 1, 22050);
      s.connect(ctx.destination);
      s.start(0);
    } catch {
      // No audio on this phone; captions still run on their own timing.
    }
  }

  function stopRecognition(rec: Recognition) {
    try {
      rec.stop();
    } catch {
      try {
        rec.abort();
      } catch {
        // Already ended.
      }
    }
  }

  function armPause(rec: Recognition, ms: number) {
    clearTimer(pauseTimer);
    pauseTimer.current = window.setTimeout(() => {
      pauseTimer.current = null;
      if (recRef.current === rec) stopRecognition(rec);
    }, ms);
  }

  function startListening() {
    const a = argsRef.current;
    const SR = recognitionClass();
    if (!SR) {
      a.onEvent("unsupported", eventDetail("unsupported"));
      a.onNeedsWindow("unsupported");
      return;
    }
    setNotice(null);
    setCanReplay(false);
    clearAfterTimers();
    setCaption("");
    if (a.sound) unlockAudio();

    const run = ++runRef.current;
    let rec: Recognition;
    try {
      rec = new SR();
    } catch {
      a.onEvent("unsupported", eventDetail("unsupported"));
      a.onNeedsWindow("unsupported");
      return;
    }
    rec.lang = (typeof navigator !== "undefined" && navigator.language) || "en-US";
    rec.interimResults = true;
    // Chrome: continuous, so a breath mid-question does not end it and the pause timer decides.
    // iPhone and iPad stop hearing anything in continuous mode, so there it ends on its own pause.
    rec.continuous = !isAppleTouch();
    heardRef.current = "";
    lastErrorRef.current = "";
    setHeard("");

    rec.onresult = (e) => {
      if (recRef.current !== rec) return;
      const text = transcript(e.results);
      heardRef.current = text;
      setHeard(text);
      if (text.trim()) armPause(rec, PAUSE_MS);
    };
    rec.onerror = (e) => {
      if (recRef.current !== rec) return;
      const code = String(e?.error ?? "unknown");
      lastErrorRef.current = code;
      if (code === "not-allowed" || code === "service-not-allowed") {
        recRef.current = null;
        clearListenTimers();
        try {
          rec.abort();
        } catch {
          // Already ended.
        }
        setHeard("");
        setNotice("mic_blocked");
        setPhase("idle");
        argsRef.current.onEvent("mic_blocked", eventDetail(code));
        argsRef.current.onNeedsWindow("mic_blocked");
      }
    };
    rec.onend = () => {
      if (recRef.current !== rec) return;
      recRef.current = null;
      clearListenTimers();
      const question = heardRef.current.trim();
      if (question) {
        void ask(question, run);
        return;
      }
      setHeard("");
      setNotice("not_heard");
      setPhase("idle");
      argsRef.current.onEvent("no_speech", eventDetail(lastErrorRef.current || "ended"));
    };

    recRef.current = rec;
    setSecondsLeft(MAX_LISTEN_SECONDS);
    setPhase("listening");
    justStartedRef.current = true;
    clearTimer(justStartedTimer);
    justStartedTimer.current = window.setTimeout(() => {
      justStartedTimer.current = null;
      justStartedRef.current = false;
    }, 0);
    tickTimer.current = window.setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    capTimer.current = window.setTimeout(() => {
      capTimer.current = null;
      if (recRef.current === rec) stopRecognition(rec);
    }, MAX_LISTEN_SECONDS * 1000);
    try {
      rec.start();
      armPause(rec, NO_SPEECH_MS);
    } catch {
      recRef.current = null;
      clearListenTimers();
      setPhase("idle");
    }
  }

  async function ask(question: string, run: number) {
    setPhase("thinking");
    setHeard(question);
    setCaption("");
    const sound = argsRef.current.sound;
    let outcome: AskOutcome;
    try {
      outcome = await argsRef.current.send(question, { spoken: true, sound });
    } catch {
      outcome = { ok: false, reason: "failed" };
    }
    if (run !== runRef.current) return;
    if (!outcome.ok) {
      setHeard("");
      setPhase("idle");
      if (outcome.reason === "unauthorized" || outcome.reason === "failed") argsRef.current.onNeedsWindow(outcome.reason);
      return;
    }
    argsRef.current.onAnswer(outcome.turn);
    captionsRef.current = outcome.captions;
    bufferRef.current = null;
    if (outcome.captions.length === 0) {
      // Nothing to say or show: no replay either.
      setHeard("");
      setPhase("idle");
      return;
    }
    setLastTurn(outcome.turn);
    const ctx = ctxRef.current;
    if (sound && outcome.audio && ctx) {
      try {
        bufferRef.current = await ctx.decodeAudioData(decodeBase64(outcome.audio));
      } catch {
        bufferRef.current = null;
      }
      if (run !== runRef.current) return;
    }
    play();
  }

  function finish() {
    stopPlayback();
    setPhase("idle");
    setHeard("");
    clearAfterTimers();
    lingerTimer.current = window.setTimeout(() => {
      lingerTimer.current = null;
      setCaption("");
    }, CAPTION_LINGER_MS);
    setCanReplay(true);
    replayTimer.current = window.setTimeout(() => {
      replayTimer.current = null;
      setCanReplay(false);
    }, REPLAY_WINDOW_MS);
  }

  function play() {
    const caps = captionsRef.current;
    stopPlayback();
    clearAfterTimers();
    setPhase("speaking");
    setHeard("");
    setCaption(caps[0]?.text ?? "");
    const ctx = ctxRef.current;
    const buffer = bufferRef.current;

    if (!ctx || !buffer || !argsRef.current.sound) {
      // No audio (none sent, sound off, or it would not decode): captions on their own timing.
      const started = Date.now();
      const total = caps.length ? caps[caps.length - 1].end : 0;
      captionTimer.current = window.setInterval(() => {
        const t = (Date.now() - started) / 1000;
        setCaption(captionAt(caps, t));
        if (t >= total) finish();
      }, CAPTION_TICK_MS);
      return;
    }

    void ctx.resume().catch(() => {});
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    const startAt = ctx.currentTime + 0.05;
    src.onended = () => {
      if (sourceRef.current !== src) return;
      sourceRef.current = null;
      finish();
    };
    sourceRef.current = src;
    src.start(startAt);
    // Captions follow the audio clock, not wall time, so they stay in step if playback stalls.
    const tick = () => {
      setCaption(captionAt(caps, ctx.currentTime - startAt));
      rafRef.current = window.requestAnimationFrame(tick);
    };
    rafRef.current = window.requestAnimationFrame(tick);
  }

  function stopSpeaking(report: boolean) {
    if (report) argsRef.current.onEvent("stopped");
    finish();
  }

  /** Drop the listen at once without asking anything. */
  function abandonListening() {
    const rec = recRef.current;
    recRef.current = null;
    runRef.current += 1;
    clearListenTimers();
    try {
      rec?.abort();
    } catch {
      // Already ended.
    }
    setHeard("");
    setPhase("idle");
  }

  function onPill() {
    const p = phaseRef.current;
    if (p === "idle") {
      if (argsRef.current.disabled) return;
      startListening();
    } else if (p === "listening") {
      if (justStartedRef.current) return;
      const rec = recRef.current;
      if (rec) stopRecognition(rec);
    } else if (p === "speaking") {
      stopSpeaking(true);
    }
    // Thinking: the question is on its way; the pill does nothing.
  }

  function replay() {
    if (argsRef.current.disabled || phaseRef.current !== "idle" || !canReplayRef.current) return;
    if (captionsRef.current.length === 0) return;
    argsRef.current.onEvent("replay");
    setNotice(null);
    setCanReplay(false);
    if (argsRef.current.sound) unlockAudio();
    play();
  }

  // A phone locked or switched away: stop listening (never send half a question) or speaking.
  useEffect(() => {
    function onVisibility() {
      if (document.visibilityState !== "hidden") return;
      if (phaseRef.current === "listening") abandonListening();
      else if (phaseRef.current === "speaking") stopSpeaking(false);
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
    // The handlers read refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      runRef.current += 1;
      const rec = recRef.current;
      recRef.current = null;
      try {
        rec?.abort();
      } catch {
        // Already ended.
      }
      clearListenTimers();
      clearTimer(justStartedTimer);
      stopPlayback();
      clearAfterTimers();
      const ctx = ctxRef.current;
      ctxRef.current = null;
      void ctx?.close().catch(() => {});
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return { phase, heard, caption, notice, secondsLeft, canReplay, lastTurn, onPill, replay };
}
