"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Todo } from "./api";

const UNDO_MS = 6000;

export type UndoEntry = { todo: Todo; text: string };

/**
 * The 6-second Undo after a tick or a drop, shared by the To do tab and a contact's profile. Only one
 * Undo at a time: a new one replaces the old and restarts the 6 seconds. The timer is cleared on unmount.
 */
export function useUndo(): { undo: UndoEntry | null; showUndo(todo: Todo, text: string): void; clearUndo(): void } {
  const [undo, setUndo] = useState<UndoEntry | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearUndo = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setUndo(null);
  }, []);

  const showUndo = useCallback((todo: Todo, text: string) => {
    if (timer.current) clearTimeout(timer.current);
    setUndo({ todo, text });
    timer.current = setTimeout(() => {
      timer.current = null;
      setUndo(null);
    }, UNDO_MS);
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return { undo, showUndo, clearUndo };
}

/** What Ask shows at the bottom of the screen: the pill row (closed), the minimised bar, or the expanded window. */
export type AskFootprint = "pill" | "bar" | "window";

// Whole class names, so Tailwind sees each one.
const ABOVE: Record<AskFootprint, string> = {
  pill: "bottom-[calc(6rem+env(safe-area-inset-bottom))]",
  bar: "bottom-[calc(10rem+env(safe-area-inset-bottom))]",
  window: "bottom-[calc(min(62dvh,580px)+1.5rem+env(safe-area-inset-bottom))]",
};

/**
 * The bar itself, fixed above whatever Ask shows at the bottom, so both stay tappable. A voice caption
 * strip showing above the pill row (or the minimised bar) lifts it by the strip's height, which
 * MonsoonApp sets as --ask-strip (0 when no strip shows).
 */
export default function UndoBar({
  text,
  onUndo,
  above,
  disabled = false,
}: {
  text: string;
  onUndo(): void;
  above: AskFootprint;
  /** Undo writes: it waits while Ask is busy. */
  disabled?: boolean;
}) {
  return (
    <div
      role="status"
      className={`fixed inset-x-4 ${ABOVE[above]} -translate-y-[var(--ask-strip,0px)] z-10 mx-auto flex max-w-md items-center justify-between gap-3 rounded-2xl bg-neutral-900 py-1 pl-4 pr-2 text-white shadow-lg dark:bg-neutral-100 dark:text-neutral-900`}
    >
      <span className="break-words text-[15px]">{text}</span>
      <button
        type="button"
        onClick={onUndo}
        disabled={disabled}
        className="min-h-[44px] shrink-0 rounded-xl px-3 text-[16px] font-semibold text-[#6AE6FF] disabled:opacity-50 dark:text-[#0E7FA6]"
      >
        Undo
      </button>
    </div>
  );
}
