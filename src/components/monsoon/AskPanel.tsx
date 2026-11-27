"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AskMessage } from "@/lib/monsoon/ask/loop";
import type { Ref, ResearchOffer } from "@/lib/monsoon/ask/tools";
import { claudeFailureText } from "./claudeFailure";
import MonsoonLoader from "./MonsoonLoader";
import { askCrm, type EstateInfo } from "./api";
import ChangeCard, { describeChange } from "./ChangeCard";
import type { ContactTarget } from "./ContactsPanel";
import { card as cardClass, primaryButton, secondaryButton } from "./styles";
import { useCardConfirm, type AskCard } from "./useCardConfirm";
import { useDictation } from "./useDictation";

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
};
/** The profile open underneath Ask: only the target is sent; the name and company are for the screen. */
export type AskViewing = { target: ContactTarget; name: string; company: string | null };
export type AskState = { turns: AskTurn[]; draft: string };
export const EMPTY_ASK: AskState = { turns: [], draft: "" };

const MAX_SENT = 24;
const MAX_SENT_CHARS = 50_000;
const MAX_DRAFT = 2000;
const ASK_FAILURE = "Could not get an answer. Check signal and try again.";
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

// The phone's local date, never the UTC one.
export function localDate(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// What the server counts for a message: its text, plus the ids, names and companies of its refs.
function size(m: AskMessage): number {
  let n = m.content.length;
  if (m.role === "assistant") {
    for (const r of m.refs ?? []) n += r.memberId.length + r.name.length + (r.company?.length ?? 0) + (r.personId?.length ?? 0) + (r.orgId?.length ?? 0);
  }
  return n;
}

// Notes go to the model as assistant turns. Only the last 24 are sent, and never starting with an assistant turn.
function toMessages(turns: AskTurn[]): AskMessage[] {
  const all: AskMessage[] = turns.map((t) =>
    t.role === "user"
      ? { role: "user", content: t.content }
      : t.role === "assistant" && t.refs
        ? { role: "assistant", content: t.content, refs: t.refs }
        : { role: "assistant", content: t.content },
  );
  const last = all.slice(-MAX_SENT);
  let total = last.reduce((n, m) => n + size(m), 0);
  // Drop the oldest until the total fits, never leaving an assistant turn first.
  while (last.length > 0 && (last[0].role === "assistant" || total > MAX_SENT_CHARS)) {
    total -= size(last.shift()!);
  }
  return last;
}

// What opening a ref asks the server for: the person; else the company, only for a company ref; else the member.
function refTarget(r: Ref): ContactTarget {
  if (r.personId) return { personId: r.personId };
  if (r.kind === "company" && r.orgId) return { orgId: r.orgId };
  return { memberId: r.memberId };
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

// The conversation lives in the parent (so it survives the passcode screen); this component only drives it.
export default function AskPanel({
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
}: {
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
   * ordinary turn; what is typed in the box stays. The parent drops it when the sheet closes.
   */
  send?: { id: string; text: string };
}) {
  // The microphone uses the browser's speech recognition, which hands over text only. Where the
  // browser has none, the hint points at the keyboard's own dictation.
  const [speakHint, setSpeakHint] = useState(false);
  // What was in the box when listening began; speech is added after it.
  const spokenBaseRef = useRef("");
  const dictation = useDictation((spoken) => {
    const base = spokenBaseRef.current.trim() === "" ? "" : `${spokenBaseRef.current.trimEnd()} `;
    onChange((prev) => ({ ...prev, draft: `${base}${spoken.trimStart()}`.slice(0, MAX_DRAFT) }));
  });
  const [asking, setAsking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const askRef = useRef(false);
  // Bumped when the estate changes or the conversation is cleared; a late result stamped with an older value is dropped.
  const genRef = useRef(0);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const working = state.turns.some((t) => t.cards?.some((c) => c.state === "working"));
  const busy = asking || working;

  useEffect(() => {
    genRef.current += 1;
  }, [estate.key]);
  useEffect(() => {
    if (state.turns.length === 0) genRef.current += 1;
  }, [state.turns.length]);

  useEffect(() => {
    onBusy?.(busy);
    return () => onBusy?.(false);
  }, [busy, onBusy]);

  useEffect(() => {
    if (!focusOnOpen) return;
    const el = inputRef.current;
    el?.focus();
    el?.setSelectionRange?.(el.value.length, el.value.length);
    onFocused?.();
    // Only on opening: the request is consumed by onFocused.
  }, []);

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
    if (!sendRequest || busy || sentRef.current === sendRequest.id) return;
    sentRef.current = sendRequest.id;
    void send(sendRequest.text);
    // send reads the latest render; only a new request or Ask becoming free should run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendRequest?.id, busy]);

  // Sends `text` as the question, or the draft in the box when none is given.
  async function send(text?: string) {
    const question = text ?? state.draft;
    if (askRef.current || busy || question.trim() === "" || question.length > MAX_DRAFT) return;
    dictation.cancel();
    askRef.current = true;
    setAsking(true);
    setFailure(null);
    const gen = genRef.current;
    const turn: AskTurn = { id: crypto.randomUUID(), role: "user", content: question.trim() };
    const messages = toMessages([...state.turns, turn]);
    onChange((prev) => ({ turns: [...prev.turns, turn], draft: text === undefined ? "" : prev.draft }));
    // Text typed while waiting is kept: the failed question goes back above it, clipped to the draft limit.
    const restore = () =>
      onChange((prev) => ({
        turns: prev.turns.filter((t) => t.id !== turn.id),
        draft: (prev.draft.trim() === "" ? question : `${question}
${prev.draft}`).slice(0, MAX_DRAFT),
      }));
    try {
      const res = await askCrm({ estate: estate.key, today: localDate(), messages, ...(viewing ? { viewing: viewing.target } : {}) });
      if (gen !== genRef.current) return;
      if (res.status === 401) {
        restore();
        onUnauthorized();
      } else if (res.status === 200 && res.body && "answer" in res.body) {
        const { answer, refs, proposals, research } = res.body;
        const cards: AskCard[] = (proposals ?? []).map((signed) => ({
          id: crypto.randomUUID(),
          signed,
          text: signed.text ?? "",
          state: "open",
        }));
        onChange((prev) => ({
          ...prev,
          turns: [
            ...prev.turns,
            { id: crypto.randomUUID(), role: "assistant", content: answer, refs, ...(cards.length ? { cards } : {}), ...(research ? { research } : {}) },
          ],
        }));
      } else {
        restore();
        setFailure(claudeFailureText(res.body, "Ask is not available") ?? ASK_FAILURE);
      }
    } catch {
      if (gen !== genRef.current) return;
      restore();
      setFailure(ASK_FAILURE);
    } finally {
      askRef.current = false;
      setAsking(false);
    }
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
    generation: () => genRef.current,
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
    setFailure(null);
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
                onClick={() => {
                  setDraft(s);
                  inputRef.current?.focus();
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
              <RefChips refs={t.refs} disabled={busy} onOpen={onOpenContact} />
            ) : null}
            {t.research && onResearch ? (
              <div className={`${cardClass} flex min-w-0 flex-col gap-3 p-4`}>
                <p className="break-words text-[17px] font-semibold">{`Research: ${t.research.name}`}</p>
                {t.research.company ? (
                  <p className="break-words text-[15px] text-neutral-600 dark:text-neutral-300">{t.research.company}</p>
                ) : null}
                <button
                  type="button"
                  disabled={busy || t.researchUsed === true}
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
                onConfirm={() => void confirm(c)}
                onCancel={() => cancel(c)}
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
        {viewing ? (
          <p className="break-words px-1 text-[13px] text-neutral-500 dark:text-neutral-400">
            {viewing.company ? `Looking at ${viewing.name} · ${viewing.company}` : `Looking at ${viewing.name}`}
          </p>
        ) : null}
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
          disabled={busy || state.draft.trim() === ""}
          onClick={() => void send()}
        >
          Ask
        </button>
        </div>
      </div>
    </div>
  );
}
