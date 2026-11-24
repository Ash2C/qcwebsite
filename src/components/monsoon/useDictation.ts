"use client";

import { useEffect, useRef, useState } from "react";

// The browser's own speech recognition (Safari on iPhone, Chrome). No audio reaches Monsoon's
// server: the browser turns speech into text and hands over the text only.
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

export type DictationError = "denied" | "failed";

function recognitionClass(): (new () => Recognition) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  const found = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return typeof found === "function" ? (found as new () => Recognition) : null;
}

/** Everything heard in this session so far, final and still-changing parts together. */
function heard(results: ArrayLike<ArrayLike<{ transcript: string }>>): string {
  let text = "";
  for (let i = 0; i < results.length; i += 1) text += results[i]?.[0]?.transcript ?? "";
  return text;
}

export function useDictation(onText: (spoken: string) => void) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<DictationError | null>(null);
  const recRef = useRef<Recognition | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  /** Drop the session at once; anything it reports afterwards is ignored. */
  function cancel() {
    const rec = recRef.current;
    if (!rec) return;
    recRef.current = null;
    setListening(false);
    try {
      rec.abort();
    } catch {
      // Already stopped.
    }
  }

  /** Finish the session; the browser may still deliver its last words. */
  function stop() {
    try {
      recRef.current?.stop();
    } catch {
      cancel();
    }
  }

  /** False when this browser cannot listen: the caller falls back to the keyboard's microphone. */
  function start(): boolean {
    const Rec = recognitionClass();
    if (!Rec) return false;
    cancel();
    setError(null);
    try {
      const rec = new Rec();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = (typeof navigator !== "undefined" && navigator.language) || "en-US";
      rec.onresult = (e) => {
        if (recRef.current === rec) onTextRef.current(heard(e.results));
      };
      rec.onerror = (e) => {
        if (recRef.current !== rec) return;
        const code = e?.error;
        if (code === "not-allowed" || code === "service-not-allowed") setError("denied");
        else if (code !== "no-speech" && code !== "aborted") setError("failed");
      };
      rec.onend = () => {
        if (recRef.current !== rec) return;
        recRef.current = null;
        setListening(false);
      };
      recRef.current = rec;
      rec.start();
      setListening(true);
      return true;
    } catch {
      recRef.current = null;
      setListening(false);
      return false;
    }
  }

  useEffect(
    () => () => {
      const rec = recRef.current;
      recRef.current = null;
      try {
        rec?.abort();
      } catch {
        // Already stopped.
      }
    },
    [],
  );

  return { listening, error, start, stop, cancel };
}
