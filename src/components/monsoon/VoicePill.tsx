"use client";

import { useEffect, useLayoutEffect, useRef, type Ref } from "react";
import { RateButtons } from "./AskPanel";
import MonsoonLoader from "./MonsoonLoader";
import type { useVoiceAsk } from "./useVoiceAsk";

const MAX_CHIPS = 3;
const NOT_HEARD = "I did not catch that. Tap and try again.";
const MIC_BLOCKED = "Monsoon is not allowed to use the microphone. Type your question instead.";

// Whole class names, so Tailwind sees each one. The strip sits just above the pill row, or, while the
// window is minimised, just above its bar (which itself sits above the pill row).
const STRIP_BOTTOM = {
  low: "bottom-[calc(5.5rem+env(safe-area-inset-bottom))]",
  raised: "bottom-[calc(9.5rem+env(safe-area-inset-bottom))]",
};

const ROUND =
  "pointer-events-auto flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white text-[#0E7FA6] shadow-lg shadow-black/20 ring-1 ring-black/10 active:bg-neutral-100 disabled:opacity-50 dark:bg-[#0E1822] dark:text-[#6AE6FF] dark:ring-white/15";
const ICON = { "aria-hidden": true, width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round" } as const;

/**
 * Voice Ask on a phone: the pill row at the bottom centre (where the Ask button is on a computer) and
 * the caption strip just above it. It only draws; useVoiceAsk does the listening and speaking.
 */
export default function VoicePill({
  voice,
  disabled,
  buttonRef,
  onKeyboard,
  onRate,
  rating,
  chips,
  raised = false,
  onStripHeight,
}: {
  voice: ReturnType<typeof useVoiceAsk>;
  /** The page or Ask is busy: nothing new starts, but listening and speaking can still be stopped. */
  disabled: boolean;
  buttonRef: Ref<HTMLButtonElement>;
  /** Opens the window with the box focused. */
  onKeyboard(): void;
  onRate(r: "up" | "down"): void;
  rating: "up" | "down" | null;
  /** Contacts the spoken answer named; at most three show. */
  chips: { key: string; name: string; onOpen(): void }[];
  /** The window is minimised: its bar is above the pill row, so the strip goes above the bar. */
  raised?: boolean;
  /** The strip's height in px while it shows, 0 once it goes, so the Undo bar can sit above it. */
  onStripHeight?(px: number): void;
}) {
  const { phase, heard, caption, notice, secondsLeft, canReplay } = voice;
  const shownChips = canReplay ? chips.slice(0, MAX_CHIPS) : [];
  const noticeText = notice === "not_heard" ? NOT_HEARD : notice === "mic_blocked" ? MIC_BLOCKED : null;
  const showStrip = phase === "listening" || phase === "thinking" || caption !== "" || noticeText !== null || shownChips.length > 0;

  const stripRef = useRef<HTMLDivElement>(null);
  const reportRef = useRef(onStripHeight);
  reportRef.current = onStripHeight;
  useLayoutEffect(() => {
    reportRef.current?.(showStrip ? (stripRef.current?.offsetHeight ?? 0) : 0);
  });
  useEffect(() => {
    // A turned phone rewraps the strip.
    const onResize = () => reportRef.current?.(stripRef.current?.offsetHeight ?? 0);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      reportRef.current?.(0);
    };
  }, []);

  const label =
    phase === "listening"
      ? "Stop listening and ask"
      : phase === "thinking"
        ? "Thinking"
        : phase === "speaking"
          ? "Stop the answer"
          : "Ask: tap and speak your question";
  const colours =
    phase === "listening"
      ? "bg-red-600 text-white active:bg-red-700"
      : "bg-[#0E7FA6] text-white active:bg-[#0D6A8F] disabled:bg-neutral-400 disabled:text-white dark:bg-[#6AE6FF] dark:text-[#04121A] dark:active:bg-[#3FB8D4] dark:disabled:bg-neutral-700 dark:disabled:text-neutral-400";

  return (
    <>
      {showStrip ? (
        <div className={`pointer-events-none fixed inset-x-0 ${raised ? STRIP_BOTTOM.raised : STRIP_BOTTOM.low} z-10 flex justify-center px-4`}>
          <div
            ref={stripRef}
            role="status"
            aria-live="polite"
            className="pointer-events-auto flex max-h-[7.5rem] w-full max-w-md flex-col gap-2 overflow-y-auto rounded-2xl bg-black/75 px-4 py-3 text-white shadow-lg backdrop-blur-sm"
          >
            {phase === "listening" ? (
              <p className="text-[17px] leading-snug">
                <span className="block text-[13px] font-semibold text-white/70">{`Listening · ${secondsLeft}s`}</span>
                <span className={heard ? "font-medium" : "text-white/60"}>{heard || "Ask about your CRM…"}</span>
              </p>
            ) : phase === "thinking" ? (
              <p className="text-[17px] leading-snug">
                <span className="block text-[13px] font-semibold text-white/70">You asked</span>
                <span className="font-medium">{heard}</span>
              </p>
            ) : caption ? (
              <p className="text-[17px] font-medium leading-snug">{caption}</p>
            ) : noticeText ? (
              <p className="text-[16px] leading-snug">{noticeText}</p>
            ) : null}
            {shownChips.length > 0 ? (
              <div role="group" aria-label="Contacts mentioned" className="flex flex-wrap gap-2">
                {shownChips.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    disabled={disabled}
                    onClick={c.onOpen}
                    className="min-h-[44px] max-w-full break-words rounded-full bg-white/15 px-4 text-[16px] font-semibold text-white active:bg-white/25 disabled:opacity-50"
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-10 flex items-center justify-center gap-2 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {phase === "idle" ? (
          <button type="button" aria-label="Type a question instead" disabled={disabled} onClick={onKeyboard} className={ROUND}>
            <svg {...ICON}>
              <rect x="2.5" y="6" width="19" height="12" rx="2" />
              <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
            </svg>
          </button>
        ) : null}
        <button
          type="button"
          ref={buttonRef}
          aria-label={label}
          // Thinking: the question is on its way. Busy: nothing new starts, but a listen or an answer can still be stopped.
          disabled={phase === "thinking" || (phase === "idle" && disabled)}
          onClick={voice.onPill}
          style={{ WebkitTouchCallout: "none", touchAction: "manipulation" }}
          className={`pointer-events-auto flex min-h-[60px] w-[62%] min-w-[96px] max-w-[280px] select-none items-center justify-center gap-2.5 rounded-full px-6 text-[19px] font-semibold shadow-lg shadow-black/25 ${colours}`}
        >
          {phase === "listening" ? (
            <>
              <span aria-hidden="true" className="relative flex h-3 w-3">
                <span className="absolute inline-flex h-full w-full rounded-full bg-white/70 motion-safe:animate-ping" />
                <span className="relative inline-flex h-3 w-3 rounded-full bg-white" />
              </span>
              Tap when done
            </>
          ) : phase === "thinking" ? (
            <>
              <MonsoonLoader className="h-7 w-7" />
              Thinking
            </>
          ) : phase === "speaking" ? (
            <>
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16">
                <rect x="2" y="2" width="12" height="12" rx="2" fill="currentColor" />
              </svg>
              Stop
            </>
          ) : (
            <>
              <svg {...ICON} width={24} height={24}>
                <rect x="9" y="3" width="6" height="11" rx="3" />
                <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
              </svg>
              Ask
            </>
          )}
        </button>
        {canReplay ? (
          <>
            <div className="pointer-events-auto rounded-xl bg-white/90 shadow-lg shadow-black/20 dark:bg-[#0E1822]/90">
              <RateButtons rating={rating} onRate={onRate} size="sm" />
            </div>
            <button type="button" aria-label="Replay the answer" disabled={disabled} onClick={voice.replay} className={ROUND}>
              <svg {...ICON}>
                <path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4" />
              </svg>
            </button>
          </>
        ) : null}
      </div>
    </>
  );
}
