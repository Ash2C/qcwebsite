"use client";

import { useId, useRef, useState, type MutableRefObject } from "react";
import { card, fieldInput, fieldLabel } from "./styles";
import { useDictation } from "./useDictation";

const MIC_DENIED = "The microphone is blocked. Allow it in Settings, or use the microphone on the keyboard.";
const MIC_FAILED = "Could not listen. Try again, or use the microphone on the keyboard.";
const KEYBOARD_HINT = "This browser cannot listen. Use the microphone on the keyboard.";

/** What a parent can ask of the field: stop any listening (before it saves, say). */
export type DictatedHandle = { cancel(): void };

// A labelled text box with a microphone button. What is spoken is added after what is already
// typed, up to `max` characters; typing takes over from speaking.
export default function DictatedField({
  label,
  value,
  max,
  onChange,
  readOnly,
  rows = 2,
  autoFocus,
  speakLabel = `Speak: ${label}`,
  stopLabel = `Stop listening: ${label}`,
  handleRef,
}: {
  label: string;
  value: string;
  max: number;
  onChange(next: string): void;
  readOnly?: boolean;
  rows?: number;
  autoFocus?: boolean;
  /** Accessible names of the microphone button, when it is idle and when it is listening. */
  speakLabel?: string;
  stopLabel?: string;
  handleRef?: MutableRefObject<DictatedHandle | null>;
}) {
  const id = useId();
  const [hint, setHint] = useState(false);
  const baseRef = useRef("");
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const dictation = useDictation((spoken) => {
    const base = baseRef.current.trim() === "" ? "" : `${baseRef.current.trimEnd()} `;
    onChange(`${base}${spoken.trimStart()}`.slice(0, max));
  });
  if (handleRef) handleRef.current = { cancel: dictation.cancel };
  const heard = dictation.listening;
  return (
    <div className="flex flex-col gap-1">
      <div className={card}>
        <label htmlFor={id} className={fieldLabel}>
          {label}
        </label>
        <div className="flex items-start gap-1 pr-2">
          <textarea
            id={id}
            ref={boxRef}
            rows={rows}
            maxLength={max}
            value={value}
            readOnly={readOnly}
            autoFocus={autoFocus}
            onChange={(e) => {
              dictation.cancel();
              onChange(e.target.value);
            }}
            className={`${fieldInput} resize-none`}
          />
          <button
            type="button"
            aria-label={heard ? stopLabel : speakLabel}
            aria-pressed={heard}
            disabled={readOnly}
            onClick={() => {
              if (heard) return dictation.stop();
              baseRef.current = value;
              if (dictation.start()) return setHint(false);
              setHint(true);
              boxRef.current?.focus();
            }}
            className={`mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full disabled:opacity-40 ${
              heard ? "bg-red-600 text-white active:bg-red-700" : "text-[#0E7FA6] active:bg-neutral-100 dark:text-[#6AE6FF] dark:active:bg-white/10"
            }`}
          >
            <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
            </svg>
          </button>
        </div>
      </div>
      {heard ? (
        <p role="status" className="px-1 text-[15px] font-medium text-red-600 dark:text-red-400">
          Listening... Tap the microphone to stop.
        </p>
      ) : dictation.error ? (
        <p role="alert" className="px-1 text-[15px] font-medium text-red-600 dark:text-red-400">
          {dictation.error === "denied" ? MIC_DENIED : MIC_FAILED}
        </p>
      ) : hint ? (
        <p className="px-1 text-[15px] text-neutral-600 dark:text-neutral-300">{KEYBOARD_HINT}</p>
      ) : null}
    </div>
  );
}
