"use client";

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import type { AskFootprint } from "./UndoBar";

/**
 * What the page under the Ask window shares with it, now that the page stays live while Ask is open.
 * One write at a time, both ways: while Ask is busy the page's writes wait (`askBusy`), and while the
 * page has a write or a model call in flight it says so (`reportBusy`), so Ask starts nothing. `above`
 * is what Ask shows at the bottom of the screen (an Undo bar sits above it). Provided by MonsoonApp;
 * outside it, Ask is closed and nobody listens.
 */
export type AskPage = {
  askBusy: boolean;
  above: AskFootprint;
  /** `id` (one per component) has a write in flight, or no longer has one. */
  reportBusy(id: string, busy: boolean): void;
};

export const AskPageContext = createContext<AskPage>({ askBusy: false, above: "pill", reportBusy: () => {} });

export function useAskPage(): AskPage {
  return useContext(AskPageContext);
}

/**
 * Tells Ask this component has a write or a model call in flight while `busy` is true. It is cleared
 * when `busy` turns false and when the component goes, whatever the write did, so Ask is never left
 * blocked by a screen that is no longer there.
 */
export function useReportBusy(busy: boolean): void {
  const { reportBusy } = useAskPage();
  const id = useId();
  useEffect(() => {
    if (!busy) return;
    reportBusy(id, true);
    return () => reportBusy(id, false);
  }, [busy, id, reportBusy]);
}

/**
 * For writes that have no busy state of their own: `track(() => write())` counts the write as in
 * flight until it settles (success, failure or a throw) and reports it with useReportBusy.
 */
export function usePageWrite(): <T>(work: () => Promise<T>) => Promise<T> {
  const [count, setCount] = useState(0);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useReportBusy(count > 0);
  return useCallback(async <T,>(work: () => Promise<T>): Promise<T> => {
    setCount((n) => n + 1);
    try {
      return await work();
    } finally {
      if (live.current) setCount((n) => n - 1);
    }
  }, []);
}
