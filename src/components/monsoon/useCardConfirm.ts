"use client";

import { useRef } from "react";
import type { SignedProposal } from "@/lib/monsoon/ask/proposal";
import { actOnCrm } from "./api";

export type AskCard = {
  id: string;
  signed: SignedProposal;
  text: string;
  state: "open" | "working" | "done" | "cancelled" | "failed";
  message?: string;
};

export const SAVE_FAILURE = "Could not save. Check signal and try again.";
export const EXPIRED = "This change has expired. Ask again.";

type Options = {
  estateKey: string;
  /** The card's state right now, or undefined when it is gone. */
  stateOf: (id: string) => AskCard["state"] | undefined;
  patch: (id: string, patch: Partial<AskCard>) => void;
  /** A result for an older generation (estate changed, conversation cleared, view closed) is dropped. */
  generation: () => number;
  onUnauthorized: () => void;
  /** Extra fields merged into the act body (research sends the ticked ids and the edited summary). */
  extras?: (card: AskCard) => Record<string, unknown>;
  onDone?: (card: AskCard, message: string) => void;
};

// What one change card does when its owner taps Confirm: send the signed proposal once (a ref guard
// stops a double tap, the card state stops a second confirm), then move the card to done, back to open
// (401 or a failure, so it can be retried) or to failed (403, expired).
export function useCardConfirm(options: Options) {
  const inFlight = useRef(new Set<string>());
  const latest = useRef(options);
  latest.current = options;

  async function confirm(c: AskCard) {
    if (latest.current.stateOf(c.id) !== "open" || inFlight.current.has(c.id)) return;
    inFlight.current.add(c.id);
    const gen = latest.current.generation();
    latest.current.patch(c.id, { state: "working", message: undefined });
    const { proposal, signature } = c.signed;
    try {
      const res = await actOnCrm({
        estate: latest.current.estateKey,
        proposal,
        signature,
        ...(proposal.kind === "add_note" ? { text: c.text } : {}),
        ...(latest.current.extras?.(c) ?? {}),
      });
      const o = latest.current;
      if (gen !== o.generation()) return;
      if (res.status === 200 && res.body && "message" in res.body) {
        o.patch(c.id, { state: "done", message: res.body.message });
        o.onDone?.(c, res.body.message);
      } else if (res.status === 401) {
        o.patch(c.id, { state: "open" });
        o.onUnauthorized();
      } else if (res.status === 403) {
        o.patch(c.id, { state: "failed", message: EXPIRED });
      } else {
        o.patch(c.id, { state: "open", message: SAVE_FAILURE });
      }
    } catch {
      const o = latest.current;
      if (gen !== o.generation()) return;
      o.patch(c.id, { state: "open", message: SAVE_FAILURE });
    } finally {
      inFlight.current.delete(c.id);
    }
  }

  return { confirm, isConfirming: (id: string) => inFlight.current.has(id) };
}
