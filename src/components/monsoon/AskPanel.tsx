"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Ref, ResearchOffer } from "@/lib/monsoon/ask/tools";
import MonsoonLoader from "./MonsoonLoader";
import { sendAskFeedback, type EstateInfo } from "./api";
import ChangeCard, { describeChange } from "./ChangeCard";
import type { ContactTarget } from "./ContactsPanel";
import { card as cardClass, primaryButton, secondaryButton } from "./styles";
import { MAX_DRAFT, type useAsk } from "./useAsk";
import { useCardConfirm, type AskCard } from "./useCardConfirm";
import { useDictation } from "./useDictation";

export { localDate } from "./useAsk";
export type { AskCard };
export type AskTurn = {
  id: string;
  role: "user" | "assistant" | "note";
  content: string;
  refs?: Ref[];
  cards?: AskCard[];
  research?: ResearchOffer;
  /** The offer's button has been tapped; it stays disabled after that. */
  researchUsed?: boolean;
  rating?: "up" | "down";
  /** The question was spoken and this answer came back for speaking. */
  spoken?: boolean;
};
/** The profile open underneath Ask: only the target is sent; the name and company are for the screen. */
export type AskViewing = { target: ContactTarget; name: string; company: string | null };
export type AskState = { turns: AskTurn[]; draft: string };
export const EMPTY_ASK: AskState = { turns: [], draft: "" };

/** The "Looking at <name> · <company>" line for the contact Ask is about; null when there is none. */
export function lookingLine(viewing: AskViewing | null | undefined): string | null {
  if (!viewing) return null;
  return viewing.company ? `Looking at ${viewing.name} · ${viewing.company}` : `Looking at ${viewing.name}`;
}

const MAX_CHIPS = 5;
const SUGGESTIONS = ["Who should I chase this week?", "Who did I add most recently?", "Summarise the pipeline", "Tell me about "];
const SPEAK_HINT = "Tap the microphone on the keyboard and talk, then press Ask.";
const MIC_DENIED =
  "Monsoon is not allowed to use the microphone. Allow it in the browser settings, or use the microphone on the keyboard.";
const MIC_FAILED = "Could not listen. Try again, or use the microphone on the keyboard.";

/**
 * The fixed Prepare me request. A title too long for the question box is cut with an ellipsis, so the
 * request is always sent; the rest of the message is exact. `due` is already written as "27 Nov" or null.
 */
export function prepareMessage(name: string, title: string, due: string | null): string {
  const head = `Prepare me for this to-do with ${name}: "`;
  const tail = `"${due ? `, due ${due}` : ""}.`;
  const room = MAX_DRAFT - head.length - tail.length;
  const quoted = title.length <= room ? title : `${title.slice(0, Math.max(0, room - 1)).trimEnd()}…`;
  return `${head}${quoted}${tail}`;
}

// What opening a ref asks the server for: the person; else the company, only for a company ref; else the member.
export function refTarget(r: Ref): ContactTarget {
  if (r.personId) return { personId: r.personId };
  if (r.kind === "company" && r.orgId) return { orgId: r.orgId };
  return { memberId: r.memberId };
}

/** Thumbs up and down under an answer; the pressed one is marked, and tapping it again does nothing. */
export function RateButtons({
  rating,
  onRate,
  size = "md",
}: {
  rating: "up" | "down" | null;
  onRate: (r: "up" | "down") => void;
  size?: "sm" | "md";
}) {
  // Both sizes keep the 44px tap target; the small one drops the extra gap for the voice pill.
  const box = size === "sm" ? "min-h-[44px] min-w-[44px] px-1" : "min-h-[44px] min-w-[44px] px-2";
  const pick = (r: "up" | "down") => {
    if (rating !== r) onRate(r);
  };
  const cls = (on: boolean) =>
    `${box} flex items-center justify-center rounded-xl active:bg-neutral-200 dark:active:bg-white/20 ${
      on ? "bg-[#0E7FA6]/15 text-[#0E7FA6] dark:bg-[#6AE6FF]/20 dark:text-[#6AE6FF]" : "bg-neutral-100 text-neutral-600 dark:bg-white/10 dark:text-neutral-300"
    }`;
  const icon = { "aria-hidden": true, width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  return (
    <div className="flex gap-2">
      <button type="button" aria-label="Good answer" aria-pressed={rating === "up"} className={cls(rating === "up")} onClick={() => pick("up")}>
        <svg {...icon}>
          <path d="M7 11v9H4v-9zM7 11l4-8c1.5 0 2.5 1 2.5 2.5V9H19a2 2 0 0 1 2 2.3l-1.3 7A2 2 0 0 1 17.7 20H7" />
        </svg>
      </button>
      <button type="button" aria-label="Poor answer" aria-pressed={rating === "down"} className={cls(rating === "down")} onClick={() => pick("down")}>
        <svg {...icon}>
          <path d="M7 13V4H4v9zM7 13l4 8c1.5 0 2.5-1 2.5-2.5V15H19a2 2 0 0 0 2-2.3l-1.3-7A2 2 0 0 0 17.7 4H7" />
        </svg>
      </button>
    </div>
  );
}

// The contacts an answer named, as tappable chips (at most five, each contact once).
function RefChips({ refs, disabled, onOpen }: { refs: Ref[]; disabled: boolean; onOpen: (t: ContactTarget) => void }) {
  const seen = new Set<string>();
  const chips: { key: string; ref: Ref }[] = [];
  for (const r of refs) {
    const t = refTarget(r);
    const key = t.personId ?? t.orgId ?? t.memberId ?? r.memberId;
    if (seen.has(key)) continue;
    seen.add(key);
    chips.push({ key, ref: r });
    if (chips.length === MAX_CHIPS) break;
  }
  return (
    <div className="flex flex-wrap gap-2" aria-label="Contacts mentioned">
      {chips.map(({ key, ref }) => (
        <button
          key={key}
          type="button"
          disabled={disabled}
          onClick={() => onOpen(refTarget(ref))}
          className="min-h-[44px] max-w-full break-words rounded-full bg-[#0E7FA6]/10 px-4 text-[16px] font-semibold text-[#0E7FA6] active:bg-[#0E7FA6]/20 disabled:opacity-50 dark:bg-[#6AE6FF]/15 dark:text-[#6AE6FF]"
        >
          {ref.name}
        </button>
      ))}
    </div>
  );
}

// The conversation lives in the parent (so it survives the passcode screen), and so does the request
// logic (`ask`, from useAsk), so something other than this panel can send; this component only drives it.
export default function AskPanel({
  ask,
  estate,
  state,
  onChange,
  onUnauthorized,
  onBusy,
  onOpenContact,
  onResearch,
  focusOnOpen,
  onFocused,
  suggested,
  viewing,
  onChanged,
  send: sendRequest,
  blocked = false,
  speakHint: showSpeakHint = false,
}: {
  /** The request logic, owned by the parent; built from the same estate, state and viewing. */
  ask: ReturnType<typeof useAsk>;
  estate: EstateInfo;
  state: AskState;
  onChange: (next: AskState | ((prev: AskState) => AskState)) => void;
  onUnauthorized: () => void;
  onBusy?: (busy: boolean) => void;
  onOpenContact?: (target: ContactTarget) => void;
  /** Run research: opens that person's profile and starts research there. */
  onResearch?: (personId: string) => void;
  /** Focus the question box when this panel opens, then report it through onFocused. */
  focusOnOpen?: boolean;
  onFocused?: () => void;
  /** Questions the app guesses from what was just done; shown before the standing ones. */
  suggested?: string[];
  /** The contact open underneath; "this person" in a question means them. */
  viewing?: AskViewing | null;
  /** A change card was confirmed: what is underneath may be out of date. */
  onChanged?: () => void;
  /**
   * A question to submit for the user (Prepare me), once per `id`, as soon as Ask is free. It is an
   * ordinary turn; what is typed in the box stays. The parent drops it when the window closes.
   */
  send?: { id: string; text: string };
  /**
   * The page behind is writing or reading (one write at a time): nothing here may start a question or
   * a change until it is done. Typing and dictation still work.
   */
  blocked?: boolean;
  /** The voice pill found no speech recognition here: show the keyboard-microphone hint. */
  speakHint?: boolean;
}) {
  // The microphone uses the browser's speech recognition, which hands over text only. Where the
  // browser has none, the hint points at the keyboard's own dictation.
  const [speakHint, setSpeakHint] = useState(showSpeakHint);
  useEffect(() => {
    if (showSpeakHint) setSpeakHint(true);
  }, [showSpeakHint]);
  // What was in the box when listening began; speech is added after it.
  const spokenBaseRef = useRef("");
  const dictation = useDictation((spoken) => {
    const base = spokenBaseRef.current.trim() === "" ? "" : `${spokenBaseRef.current.trimEnd()} `;
    onChange((prev) => ({ ...prev, draft: `${base}${spoken.trimStart()}`.slice(0, MAX_DRAFT) }));
  });
  const { asking, failure, clearFailure } = ask;
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const working = state.turns.some((t) => t.cards?.some((c) => c.state === "working"));
  const busy = asking || working;

  useEffect(() => {
    onBusy?.(busy);
    return () => onBusy?.(false);
  }, [busy, onBusy]);

  // The failure line belongs to this screen: closing it drops the line, as it did when the panel owned it.
  useEffect(() => clearFailure, [clearFailure]);

  // On opening, and again whenever the parent asks (the panel stays mounted while the window is
  // minimised, so expanding it to type is not a new mount). The request is consumed by onFocused.
  useEffect(() => {
    if (!focusOnOpen) return;
    const el = inputRef.current;
    el?.focus();
    el?.setSelectionRange?.(el.value.length, el.value.length);
    onFocused?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusOnOpen]);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [state.turns, asking, failure]);

  // Grow the textarea up to four rows.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 116)}px`;
  }, [state.draft]);

  function setDraft(draft: string) {
    onChange((prev) => ({ ...prev, draft }));
  }

  function patchCard(id: string, patch: Partial<AskCard>) {
    onChange((prev) => ({
      ...prev,
      turns: prev.turns.map((t) =>
        t.cards ? { ...t, cards: t.cards.map((c) => (c.id === id ? { ...c, ...patch } : c)) } : t,
      ),
    }));
  }

  function rate(turn: AskTurn, r: "up" | "down") {
    onChange((prev) => ({ ...prev, turns: prev.turns.map((t) => (t.id === turn.id ? { ...t, rating: r } : t)) }));
    sendAskFeedback({ estate: estate.key, kind: r, mode: turn.spoken ? "voice" : "typed" });
  }

  function tapOffer(turnId: string, personId: string) {
    onChange((prev) => ({ ...prev, turns: prev.turns.map((t) => (t.id === turnId ? { ...t, researchUsed: true } : t)) }));
    onResearch?.(personId);
  }

  function addNote(content: string) {
    onChange((prev) => ({
      ...prev,
      turns: [...prev.turns, { id: crypto.randomUUID(), role: "note", content }],
    }));
  }

  // The id of the request already sent, so a re-render (or a second effect run) never sends it twice.
  const sentRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sendRequest || busy || blocked || sentRef.current === sendRequest.id) return;
    sentRef.current = sendRequest.id;
    void send(sendRequest.text);
    // send reads the latest render; only a new request or Ask becoming free should run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendRequest?.id, busy, blocked]);

  // Sends `text` as the question, or the draft in the box when none is given. Listening stops first,
  // so words still arriving cannot write into the emptied box.
  function send(text?: string) {
    const question = text ?? state.draft;
    if (busy || blocked || question.trim() === "" || question.length > MAX_DRAFT) return;
    dictation.cancel();
    void ask.send(text);
  }

  function currentState(id: string): AskCard["state"] | undefined {
    for (const t of state.turns) {
      const found = t.cards?.find((x) => x.id === id);
      if (found) return found.state;
    }
    return undefined;
  }

  const { confirm, isConfirming } = useCardConfirm({
    estateKey: estate.key,
    stateOf: currentState,
    patch: patchCard,
    generation: ask.generation,
    onUnauthorized,
    onDone: (_card, message) => {
      addNote(`Change confirmed: ${message}`);
      onChanged?.();
    },
  });

  function cancel(c: AskCard) {
    if (currentState(c.id) !== "open" || isConfirming(c.id)) return;
    patchCard(c.id, { state: "cancelled", message: undefined });
    addNote(`Change cancelled: ${describeChange(c)}`);
  }

  function clear() {
    const anyOpen = state.turns.some((t) => t.cards?.some((c) => c.state === "open"));
    if (anyOpen && !window.confirm("Clear the conversation? Unconfirmed changes will be dropped.")) return;
    clearFailure();
    // Whatever is typed in the draft stays.
    onChange((prev) => ({ turns: [], draft: prev.draft }));
  }

  const shown = state.turns.filter((t) => t.role !== "note");

  return (
    <div className="flex flex-1 flex-col gap-3">
      {state.turns.length > 0 && (
        <div className="flex justify-end">
          <button
            type="button"
            className="min-h-[44px] rounded-xl bg-neutral-100 px-4 text-[16px] font-medium text-[#0E7FA6] active:bg-neutral-200 disabled:opacity-50 dark:bg-white/10 dark:text-[#6AE6FF] dark:active:bg-white/20"
            disabled={busy}
            onClick={clear}
          >
            Clear
          </button>
        </div>
      )}
      <div className="flex flex-1 flex-col gap-3" aria-label="Conversation">
        {shown.length === 0 && (
          <div className="flex flex-col gap-2 pt-2">
            <p className="px-1 text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Try asking</p>
            {[...new Set([...(viewing ? [`Tell me about ${viewing.name}`] : []), ...(suggested ?? [])])]
              .filter((s) => !SUGGESTIONS.includes(s))
              .concat(SUGGESTIONS)
              .map((s) => (
              <button
                key={s}
                type="button"
                className={secondaryButton}
                disabled={blocked || busy}
                onClick={() => {
                  // An open-ended starter ("Tell me about ") waits for a name; the rest are questions.
                  if (s.endsWith(" ")) {
                    setDraft(s);
                    inputRef.current?.focus();
                    return;
                  }
                  send(s);
                }}
              >
                {s}
              </button>
            ))}
          </div>
        )}
        {shown.map((t) => (
          <div key={t.id} className="flex flex-col gap-2">
            <div
              className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-[17px] leading-snug ${
                t.role === "user"
                  ? "ml-auto bg-[#0E7FA6] text-white dark:bg-[#6AE6FF] dark:text-[#04121A]"
                  : "mr-auto bg-white shadow-sm ring-1 ring-black/5 dark:bg-[#0E1822] dark:ring-white/10"
              }`}
            >
              {t.content}
            </div>
            {t.role === "assistant" && t.refs && t.refs.length > 0 && onOpenContact ? (
              <RefChips refs={t.refs} disabled={busy || blocked} onOpen={onOpenContact} />
            ) : null}
            {t.role === "assistant" ? <RateButtons rating={t.rating ?? null} onRate={(r) => rate(t, r)} /> : null}
            {t.research && onResearch ? (
              <div className={`${cardClass} flex min-w-0 flex-col gap-3 p-4`}>
                <p className="break-words text-[17px] font-semibold">{`Research: ${t.research.name}`}</p>
                {t.research.company ? (
                  <p className="break-words text-[15px] text-neutral-600 dark:text-neutral-300">{t.research.company}</p>
                ) : null}
                <button
                  type="button"
                  disabled={busy || blocked || t.researchUsed === true}
                  className={primaryButton}
                  onClick={() => tapOffer(t.id, t.research!.personId)}
                >
                  Run research
                </button>
              </div>
            ) : null}
            {t.cards?.map((c) => (
              <ChangeCard
                key={c.id}
                card={c}
                onText={(text) => patchCard(c.id, { text })}
                onConfirm={() => {
                  if (!blocked) void confirm(c);
                }}
                onCancel={() => cancel(c)}
                blocked={blocked}
              />
            ))}
          </div>
        ))}
        {asking && (
          <p role="status" className="flex items-center gap-2 px-1 text-[15px] text-neutral-500 dark:text-neutral-400">
            <MonsoonLoader className="h-7 w-7" />
            Looking...
          </p>
        )}
        {failure && (
          <p role="alert" className="px-1 text-[15px] font-medium text-red-600 dark:text-red-400">
            {failure}
          </p>
        )}
        <div ref={endRef} />
      </div>

      <div className="sticky bottom-0 -mx-4 mt-auto flex flex-col gap-2 bg-[#f2f2f7]/90 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur dark:bg-[#07090C]/90">
        {/* The "Looking at" line is the window's (its header), built with lookingLine. */}
        {dictation.listening ? (
          <p role="status" className="px-1 text-[15px] font-medium text-red-600 dark:text-red-400">
            Listening... Tap the microphone to stop.
          </p>
        ) : dictation.error ? (
          <p role="alert" className="px-1 text-[15px] font-medium text-red-600 dark:text-red-400">
            {dictation.error === "denied" ? MIC_DENIED : MIC_FAILED}
          </p>
        ) : speakHint ? (
          <p className="px-1 text-[15px] text-neutral-600 dark:text-neutral-300">{SPEAK_HINT}</p>
        ) : null}
        <div className="flex items-end gap-2">
        <button
          type="button"
          aria-label={dictation.listening ? "Stop listening" : "Speak your question"}
          aria-pressed={dictation.listening}
          disabled={busy}
          onClick={() => {
            if (dictation.listening) {
              dictation.stop();
              return;
            }
            spokenBaseRef.current = state.draft;
            if (dictation.start()) {
              setSpeakHint(false);
              return;
            }
            // This browser cannot listen: the keyboard's microphone can.
            setSpeakHint(true);
            inputRef.current?.focus();
          }}
          className={`flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-2xl shadow-sm ring-1 disabled:opacity-50 ${
            dictation.listening
              ? "bg-red-600 text-white ring-red-600 active:bg-red-700"
              : "bg-white text-[#0E7FA6] ring-black/5 active:bg-neutral-100 dark:bg-[#0E1822] dark:text-[#6AE6FF] dark:ring-white/10"
          }`}
        >
          <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
          </svg>
        </button>
        <label htmlFor="ask-input" className="sr-only">
          Your question
        </label>
        <textarea
          id="ask-input"
          ref={inputRef}
          rows={1}
          maxLength={2000}
          value={state.draft}
          placeholder={`Ask about ${estate.label}...`}
          onChange={(e) => {
            // Typing takes over from speaking, so the next words heard cannot overwrite the edit.
            dictation.cancel();
            setDraft(e.target.value);
          }}
          className="block min-h-[44px] flex-1 resize-none rounded-2xl bg-white px-4 py-2.5 text-[17px] text-neutral-900 shadow-sm ring-1 ring-black/5 placeholder:text-neutral-400 focus:outline-none dark:bg-[#0E1822] dark:text-white dark:ring-white/10 dark:placeholder:text-neutral-500"
        />
        <button
          type="button"
          className={`${primaryButton} !min-h-[44px] !w-auto shrink-0 !px-5`}
          aria-label="Send question"
          disabled={busy || blocked || state.draft.trim() === ""}
          onClick={() => void send()}
        >
          Ask
        </button>
        </div>
      </div>
    </div>
  );
}
