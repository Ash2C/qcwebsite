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

/** The bar itself, fixed above the floating Ask button so both stay tappable. */
export default function UndoBar({ text, onUndo }: { text: string; onUndo(): void }) {
  return (
    <div
      role="status"
      className="fixed inset-x-4 bottom-[calc(6rem+env(safe-area-inset-bottom))] z-10 mx-auto flex max-w-md items-center justify-between gap-3 rounded-2xl bg-neutral-900 py-1 pl-4 pr-2 text-white shadow-lg dark:bg-neutral-100 dark:text-neutral-900"
    >
      <span className="break-words text-[15px]">{text}</span>
      <button
        type="button"
        onClick={onUndo}
        className="min-h-[44px] shrink-0 rounded-xl px-3 text-[16px] font-semibold text-[#6AE6FF] dark:text-[#0E7FA6]"
      >
        Undo
      </button>
    </div>
  );
}
