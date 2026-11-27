"use client";

import { useCallback, useEffect, useState } from "react";

// What kind of device Ask is running on, and whether spoken answers are wanted.

const FINE_POINTER = "(hover: hover) and (pointer: fine)";
const SOUND_KEY = "monsoon.ask.sound";

/** null until mounted; true unless matchMedia("(hover: hover) and (pointer: fine)") matches. */
export function useIsPhone(): boolean | null {
  const [phone, setPhone] = useState<boolean | null>(null);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      setPhone(true);
      return;
    }
    const mq = window.matchMedia(FINE_POINTER);
    const update = () => setPhone(!mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);
  return phone;
}

/** iPhone or iPad (iPadOS reports itself as a Mac with touch). */
export function isAppleTouch(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function readSound(): boolean {
  try {
    return window.localStorage.getItem(SOUND_KEY) !== "off";
  } catch {
    return true;
  }
}

/** Stored at localStorage "monsoon.ask.sound": absent or "on" is on, "off" is off. Storage errors mean on. */
export function useAskSound(): [boolean, (on: boolean) => void] {
  const [sound, setSoundState] = useState(true);
  useEffect(() => {
    setSoundState(readSound());
  }, []);
  const setSound = useCallback((on: boolean) => {
    setSoundState(on);
    try {
      window.localStorage.setItem(SOUND_KEY, on ? "on" : "off");
    } catch {
      // Not remembered on this phone; the choice still holds for this visit.
    }
  }, []);
  return [sound, setSound];
}
