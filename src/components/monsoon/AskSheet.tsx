"use client";

import { useEffect, useRef, type ReactNode } from "react";

// Ask, expanded: a sheet over whatever is on screen. The page underneath stays mounted, so closing
// returns to exactly what was there. Nothing closes it while an answer or a change is in flight.
export default function AskSheet({ busy, onClose, children }: { busy: boolean; onClose: () => void; children: ReactNode }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busyRef.current) closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    // The page behind must not scroll under the sheet.
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = before;
    };
  }, []);

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center">
      <div
        data-testid="ask-backdrop"
        aria-hidden="true"
        className="absolute inset-0 bg-black/40"
        onClick={() => {
          if (!busy) onClose();
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Ask"
        className="relative flex h-[85dvh] w-full max-w-md flex-col rounded-t-3xl bg-[#f2f2f7] text-neutral-900 shadow-2xl motion-safe:animate-[ask-sheet-up_180ms_ease-out] dark:bg-[#07090C] dark:text-white"
      >
        <div className="flex items-center justify-between gap-3 px-4 pt-3">
          <h2 className="px-1 text-[19px] font-semibold">Ask</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="min-h-[44px] rounded-xl px-3 text-[17px] font-medium text-[#0E7FA6] disabled:opacity-50 dark:text-[#6AE6FF]"
          >
            Close
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-4 pt-2">{children}</div>
      </div>
    </div>
  );
}
