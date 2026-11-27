"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AskMessage } from "@/lib/monsoon/ask/loop";
import type { Caption } from "@/lib/monsoon/ask/speech";
import { claudeFailureText } from "./claudeFailure";
import { askCrm, type EstateInfo } from "./api";
import type { AskCard } from "./useCardConfirm";
import type { AskState, AskTurn, AskViewing } from "./AskPanel";

const MAX_SENT = 24;
const MAX_SENT_CHARS = 50_000;
export const MAX_DRAFT = 2000;
const ASK_FAILURE = "Could not get an answer. Check signal and try again.";

export type AskOutcome =
  | { ok: true; turn: AskTurn; audio: string | null; captions: Caption[] }
  | { ok: false; reason: "busy" | "empty" | "unauthorized" | "failed" | "stale" };

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

/**
 * The Ask conversation's request logic, apart from any screen: the panel, and later the voice pill,
 * send through it. The conversation itself still lives in the caller's state.
 */
export function useAsk(args: {
  estate: EstateInfo | null;
  state: AskState;
  onChange(next: AskState | ((prev: AskState) => AskState)): void;
  viewing: AskViewing | null;
  onUnauthorized(): void;
}) {
  const { estate, state, onChange, viewing, onUnauthorized } = args;
  const [asking, setAsking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const askRef = useRef(false);
  // Bumped when the estate changes or the conversation is cleared; a late result stamped with an older value is dropped.
  // Only a real change counts, never the first render: a screen below this hook can send from its own
  // mount effect, which runs before these.
  const genRef = useRef(0);
  const keyRef = useRef(estate?.key);
  const lengthRef = useRef(state.turns.length);

  useEffect(() => {
    if (keyRef.current === estate?.key) return;
    keyRef.current = estate?.key;
    genRef.current += 1;
  }, [estate?.key]);
  useEffect(() => {
    if (state.turns.length === 0 && lengthRef.current !== 0) genRef.current += 1;
    lengthRef.current = state.turns.length;
  }, [state.turns.length]);

  const working = state.turns.some((t) => t.cards?.some((c: AskCard) => c.state === "working"));

  /** text undefined sends the draft and empties it; a given text leaves the draft alone. */
  async function send(text?: string, opts?: { spoken?: boolean; sound?: boolean }): Promise<AskOutcome> {
    const question = text ?? state.draft;
    if (askRef.current || working) return { ok: false, reason: "busy" };
    if (question.trim() === "") return { ok: false, reason: "empty" };
    // Longer than the box allows (the box itself stops this) or no estate to ask: nothing is sent.
    if (question.length > MAX_DRAFT || !estate) return { ok: false, reason: "failed" };
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
      const res = await askCrm({
        estate: estate.key,
        today: localDate(),
        messages,
        ...(viewing ? { viewing: viewing.target } : {}),
        ...(opts?.spoken ? { spoken: true } : {}),
        ...(opts?.sound ? { sound: true } : {}),
      });
      if (gen !== genRef.current) return { ok: false, reason: "stale" };
      if (res.status === 401) {
        restore();
        onUnauthorized();
        return { ok: false, reason: "unauthorized" };
      }
      if (res.status === 200 && res.body && "answer" in res.body) {
        const { answer, refs, proposals, research, audio, captions } = res.body;
        const cards: AskCard[] = (proposals ?? []).map((signed) => ({
          id: crypto.randomUUID(),
          signed,
          text: signed.text ?? "",
          state: "open",
        }));
        const reply: AskTurn = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: answer,
          refs,
          ...(cards.length ? { cards } : {}),
          ...(research ? { research } : {}),
          ...(opts?.spoken ? { spoken: true } : {}),
        };
        onChange((prev) => ({ ...prev, turns: [...prev.turns, reply] }));
        return { ok: true, turn: reply, audio: audio ?? null, captions: captions ?? [] };
      }
      restore();
      setFailure(claudeFailureText(res.body, "Ask is not available") ?? ASK_FAILURE);
      return { ok: false, reason: "failed" };
    } catch {
      if (gen !== genRef.current) return { ok: false, reason: "stale" };
      restore();
      setFailure(ASK_FAILURE);
      return { ok: false, reason: "failed" };
    } finally {
      askRef.current = false;
      setAsking(false);
    }
  }

  // Stable, so a screen can clear the failure line when it closes.
  const clearFailure = useCallback(() => setFailure(null), []);

  return {
    asking,
    failure,
    clearFailure,
    generation: () => genRef.current,
    send,
  };
}
