"use client";

import { useEffect, useRef, type ReactNode } from "react";

const ICON_BTN =
  "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[#0E7FA6] disabled:opacity-50 dark:text-[#6AE6FF]";

// Ask as a floating window over a live page: not modal, no backdrop, no scroll lock, no focus trap.
// Expanded it sits at the very bottom; minimised only its header bar shows, above the pill row.
export default function AskWindow({
  busy,
  collapsed,
  onCollapsed,
  onClose,
  looking,
  hasConversation,
  sound,
  children,
}: {
  busy: boolean;
  collapsed: boolean;
  onCollapsed: (next: boolean) => void;
  onClose: () => void;
  /** "Looking at …" line; null hides it. */
  looking: string | null;
  /** True when the conversation has at least one turn (picks the minimised hint). */
  hasConversation: boolean;
  /** Sound toggle; null hides the button (computers). */
  sound: { on: boolean; onToggle: () => void } | null;
  children: ReactNode;
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape that ends an input-method composition is not a request to close.
      if (e.key === "Escape" && !e.isComposing && !busyRef.current) closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const hint = collapsed ? (hasConversation ? "Tap to return to your conversation" : "Tap to ask a question") : looking;

  return (
    <div
      className={`pointer-events-none fixed inset-x-0 z-20 flex justify-center px-3 ${
        collapsed ? "bottom-[calc(5.5rem+env(safe-area-inset-bottom))]" : "bottom-0"
      }`}
    >
      <div
        role="dialog"
        aria-label="Ask"
        className={`pointer-events-auto flex w-full max-w-md flex-col rounded-2xl bg-[#f2f2f7] text-neutral-900 shadow-2xl ring-1 ring-black/10 motion-safe:animate-[ask-sheet-up_180ms_ease-out] dark:bg-[#07090C] dark:text-white dark:ring-white/15 ${
          collapsed ? "" : "h-[min(62dvh,580px)] pb-[env(safe-area-inset-bottom)]"
        }`}
      >
        <div className="flex items-center gap-1 px-2 pt-1">
          <button
            type="button"
            aria-expanded={!collapsed}
            onClick={() => onCollapsed(!collapsed)}
            className="flex min-h-[44px] min-w-0 flex-1 flex-col justify-center rounded-xl px-2 text-left"
          >
            <span className="text-[19px] font-semibold leading-tight">Ask</span>
            {hint ? <span className="truncate text-[13px] text-neutral-600 dark:text-neutral-400">{hint}</span> : null}
          </button>
          {sound ? (
            <button
              type="button"
              aria-label={sound.on ? "Turn spoken answers off" : "Turn spoken answers on"}
              aria-pressed={sound.on}
              onClick={sound.onToggle}
              className={ICON_BTN}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M11 5 6 9H3v6h3l5 4z" />
                {sound.on ? <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" /> : <path d="m16 9 5 6M21 9l-5 6" />}
              </svg>
            </button>
          ) : null}
          <button
            type="button"
            aria-label={collapsed ? "Expand Ask" : "Minimise Ask and keep reading"}
            onClick={() => onCollapsed(!collapsed)}
            className={ICON_BTN}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={collapsed ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"} />
            </svg>
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="min-h-[44px] shrink-0 rounded-xl px-3 text-[17px] font-medium text-[#0E7FA6] disabled:opacity-50 dark:text-[#6AE6FF]"
          >
            Close
          </button>
        </div>
        {/* Kept mounted when minimised so in-flight confirmations and dictation survive; hidden removes it from view, focus and the accessibility tree. */}
        <div
          hidden={collapsed}
          className={collapsed ? "hidden" : "flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-4 pt-2"}
        >
          {children}
        </div>
        {collapsed ? <div className="h-1" /> : null}
      </div>
    </div>
  );
}
