"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AskMessage } from "@/lib/monsoon/ask/loop";
import type { Ref } from "@/lib/monsoon/ask/tools";
import type { SignedProposal } from "@/lib/monsoon/ask/proposal";
import { actOnCrm, askCrm, type EstateInfo } from "./api";
import ChangeCard, { describeChange } from "./ChangeCard";
import { primaryButton, secondaryButton } from "./styles";

export type AskCard = {
  id: string;
  signed: SignedProposal;
  text: string;
  state: "open" | "working" | "done" | "cancelled" | "failed";
  message?: string;
};
export type AskTurn = {
  id: string;
  role: "user" | "assistant" | "note";
  content: string;
  refs?: Ref[];
  cards?: AskCard[];
};
export type AskState = { turns: AskTurn[]; draft: string };
export const EMPTY_ASK: AskState = { turns: [], draft: "" };

const MAX_SENT = 24;
const MAX_SENT_CHARS = 50_000;
const ASK_FAILURE = "Could not get an answer. Check signal and try again.";
const SAVE_FAILURE = "Could not save. Check signal and try again.";
const SUGGESTIONS = ["Who should I chase this week?", "Summarise the pipeline", "Tell me about "];

// The phone's local date, never the UTC one.
function localDate(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
  let total = last.reduce((n, m) => n + m.content.length, 0);
  // Drop the oldest until the total fits, never leaving an assistant turn first.
  while (last.length > 0 && (last[0].role === "assistant" || total > MAX_SENT_CHARS)) {
    total -= last.shift()!.content.length;
  }
  return last;
}

// The conversation lives in the parent (so it survives the passcode screen); this component only drives it.
export default function AskPanel({
  estate,
  state,
  onChange,
  onUnauthorized,
  onBusy,
}: {
  estate: EstateInfo;
  state: AskState;
  onChange: (next: AskState | ((prev: AskState) => AskState)) => void;
  onUnauthorized: () => void;
  onBusy?: (busy: boolean) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const askRef = useRef(false);
  const cardRefs = useRef(new Set<string>());
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

  function addNote(content: string) {
    onChange((prev) => ({
      ...prev,
      turns: [...prev.turns, { id: crypto.randomUUID(), role: "note", content }],
    }));
  }

  async function send() {
    const question = state.draft;
    if (askRef.current || busy || question.trim() === "") return;
    askRef.current = true;
    setAsking(true);
    setFailure(null);
    const gen = genRef.current;
    const turn: AskTurn = { id: crypto.randomUUID(), role: "user", content: question.trim() };
    const messages = toMessages([...state.turns, turn]);
    onChange((prev) => ({ turns: [...prev.turns, turn], draft: "" }));
    // Text typed while waiting is kept: the failed question goes back above it.
    const restore = () =>
      onChange((prev) => ({
        turns: prev.turns.filter((t) => t.id !== turn.id),
        draft: prev.draft.trim() === "" ? question : `${question}
${prev.draft}`,
      }));
    try {
      const res = await askCrm({ estate: estate.key, today: localDate(), messages });
      if (gen !== genRef.current) return;
      if (res.status === 401) {
        restore();
        onUnauthorized();
      } else if (res.status === 200 && res.body && "answer" in res.body) {
        const { answer, refs, proposals } = res.body;
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
            { id: crypto.randomUUID(), role: "assistant", content: answer, refs, ...(cards.length ? { cards } : {}) },
          ],
        }));
      } else {
        restore();
        setFailure(ASK_FAILURE);
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

  async function confirm(c: AskCard) {
    if (currentState(c.id) !== "open" || cardRefs.current.has(c.id)) return;
    cardRefs.current.add(c.id);
    const gen = genRef.current;
    patchCard(c.id, { state: "working", message: undefined });
    const { proposal, signature } = c.signed;
    try {
      const res = await actOnCrm({
        estate: estate.key,
        proposal,
        signature,
        ...(proposal.kind === "add_note" ? { text: c.text } : {}),
      });
      if (gen !== genRef.current) return;
      if (res.status === 200 && res.body && "message" in res.body) {
        patchCard(c.id, { state: "done", message: res.body.message });
        addNote(`Change confirmed: ${res.body.message}`);
      } else if (res.status === 401) {
        patchCard(c.id, { state: "open" });
        onUnauthorized();
      } else if (res.status === 403) {
        patchCard(c.id, { state: "failed", message: "This change has expired. Ask again." });
      } else {
        patchCard(c.id, { state: "open", message: SAVE_FAILURE });
      }
    } catch {
      if (gen !== genRef.current) return;
      patchCard(c.id, { state: "open", message: SAVE_FAILURE });
    } finally {
      cardRefs.current.delete(c.id);
    }
  }

  function cancel(c: AskCard) {
    if (currentState(c.id) !== "open" || cardRefs.current.has(c.id)) return;
    patchCard(c.id, { state: "cancelled", message: undefined });
    addNote(`Change cancelled: ${describeChange(c)}`);
  }

  function clear() {
    const anyOpen = state.turns.some((t) => t.cards?.some((c) => c.state === "open"));
    if (anyOpen && !window.confirm("Clear the conversation? Unconfirmed changes will be dropped.")) return;
    setFailure(null);
    onChange(EMPTY_ASK);
  }

  const shown = state.turns.filter((t) => t.role !== "note");

  return (
    <div className="flex flex-1 flex-col gap-3">
      {state.turns.length > 0 && (
        <div className="flex justify-end">
          <button
            type="button"
            className="min-h-[44px] rounded-xl bg-neutral-100 px-4 text-[16px] font-medium text-blue-700 active:bg-neutral-200 disabled:opacity-50 dark:bg-white/10 dark:text-blue-300 dark:active:bg-white/20"
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
            {SUGGESTIONS.map((s) => (
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
                  ? "ml-auto bg-blue-600 text-white dark:bg-blue-500"
                  : "mr-auto bg-white shadow-sm ring-1 ring-black/5 dark:bg-[#1c1c1e] dark:ring-white/10"
              }`}
            >
              {t.content}
            </div>
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
          <p role="status" className="px-1 text-[15px] text-neutral-500 dark:text-neutral-400">
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

      <div className="sticky bottom-0 -mx-4 mt-auto flex items-end gap-2 bg-[#f2f2f7]/90 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur dark:bg-black/90">
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
          onChange={(e) => setDraft(e.target.value)}
          className="block min-h-[44px] flex-1 resize-none rounded-2xl bg-white px-4 py-2.5 text-[17px] text-neutral-900 shadow-sm ring-1 ring-black/5 placeholder:text-neutral-400 focus:outline-none dark:bg-[#1c1c1e] dark:text-white dark:ring-white/10 dark:placeholder:text-neutral-500"
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
  );
}
