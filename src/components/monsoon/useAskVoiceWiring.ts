"use client";

import { useEffect } from "react";
import { sendAskFeedback, type EstateInfo } from "./api";
import { useAskSound, useIsPhone } from "./askDevice";
import { refTarget, type AskState } from "./AskPanel";
import type { ContactTarget } from "./ContactsPanel";
import { MAX_DRAFT, type useAsk } from "./useAsk";
import { useVoiceAsk } from "./useVoiceAsk";

const MAX_CHIPS = 3;

/**
 * Voice Ask wired into the app: the spoken question goes through the same request logic and the same
 * conversation as a typed one. Voice never confirms anything: an answer with a change card or a
 * research offer opens the window, where the card waits to be confirmed by hand.
 */
export function useAskVoiceWiring(args: {
  estate: EstateInfo | null;
  ask: ReturnType<typeof useAsk>;
  state: AskState;
  onChange(next: (prev: AskState) => AskState): void;
  /** The page or Ask is busy: no new question starts. */
  disabled: boolean;
  openAsk(opts?: { focus?: boolean }): void;
  onOpenContact(target: ContactTarget): void;
  /** No speech recognition here: the window shows the keyboard-microphone hint. */
  onSpeakHint(): void;
  /** The window is open (expanded or minimised). */
  windowOpen: boolean;
}) {
  const { estate, ask, state, onChange, disabled, openAsk, onOpenContact, onSpeakHint, windowOpen } = args;
  const phone = useIsPhone();
  const [sound, setSound] = useAskSound();

  const voice = useVoiceAsk({
    send: (text, opts) => ask.send(text, opts),
    sound,
    disabled,
    onEvent: (kind, detail) => {
      if (estate) sendAskFeedback({ estate: estate.key, kind, mode: "voice", ...(detail ? { detail } : {}) });
    },
    onAnswer: (turn) => {
      // A card or an offer must be seen to be acted on: the window opens, scrolled to the end.
      if (turn.cards?.length || turn.research) openAsk();
    },
    onNeedsWindow: (reason) => {
      // failed and unauthorized: the question is already back in the box with its failure line (a 401
      // has also gone to the passcode screen). The other two are requests to type.
      if (reason === "unsupported") onSpeakHint();
      openAsk(reason === "unsupported" || reason === "mic_blocked" ? { focus: true } : undefined);
    },
    onHeld: (question) => {
      // Into the box under anything already typed, never over it, as Ask about this contact does.
      onChange((prev) => ({
        ...prev,
        draft: (prev.draft.trim() === "" ? question : `${prev.draft}\n${question}`).slice(0, MAX_DRAFT),
      }));
      openAsk();
    },
  });

  // A notice is about the last tap; once the window has opened it is stale, so it is gone when the
  // strip shows again.
  const { clearNotice } = voice;
  useEffect(() => {
    if (windowOpen) clearNotice();
    // clearNotice only sets state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowOpen]);

  const lastId = voice.lastTurn?.id;
  const rating = (lastId && state.turns.find((t) => t.id === lastId)?.rating) || null;

  function onRate(r: "up" | "down") {
    if (!lastId || !estate) return;
    onChange((prev) => ({ ...prev, turns: prev.turns.map((t) => (t.id === lastId ? { ...t, rating: r } : t)) }));
    sendAskFeedback({ estate: estate.key, kind: r, mode: "voice" });
  }

  const seen = new Set<string>();
  const chips: { key: string; name: string; onOpen(): void }[] = [];
  for (const r of voice.lastTurn?.refs ?? []) {
    const target = refTarget(r);
    const key = target.personId ?? target.orgId ?? target.memberId ?? r.memberId;
    if (seen.has(key)) continue;
    seen.add(key);
    chips.push({ key, name: r.name, onOpen: () => onOpenContact(target) });
    if (chips.length === MAX_CHIPS) break;
  }

  function onKeyboard() {
    if (estate) sendAskFeedback({ estate: estate.key, kind: "typed_instead", mode: "voice" });
    openAsk({ focus: true });
  }

  return {
    phone,
    voice,
    rating,
    onRate,
    chips,
    onKeyboard,
    /** For the window's header on a phone. */
    sound: {
      on: sound,
      onToggle: () => {
        // Sound off mid-answer stops it at once, as the pill's Stop would (the pill is hidden behind the window).
        if (sound) voice.stop();
        setSound(!sound);
      },
    },
  };
}
