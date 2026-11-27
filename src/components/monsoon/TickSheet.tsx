"use client";

import { useEffect, useId, useRef, useState } from "react";
import { todoAction, type EstateInfo, type Todo, type TodoActionBody } from "./api";
import { CHOICES, contactTarget, writeFailure } from "./TodoForm";
import { dueFromChoice, localToday, type DateChoice } from "./todoDates";
import { card, fieldInput, fieldLabel, primaryButton, secondaryButton } from "./styles";
import { useDictation } from "./useDictation";

const MAX_OUTCOME = 2000;
const MAX_TITLE = 300;
const SAVE_FAILED = "Could not save. Check signal.";
const MIC_DENIED = "The microphone is blocked. Allow it in Settings, or use the microphone on the keyboard.";
const MIC_FAILED = "Could not listen. Try again, or use the microphone on the keyboard.";
const KEYBOARD_HINT = "This browser cannot listen. Use the microphone on the keyboard.";

export type TickResult = { outcome: boolean; next: Todo | null };

/** A text box with a microphone: what is spoken is added after what is already typed. */
function DictatedBox({
  label,
  value,
  max,
  readOnly,
  onChange,
}: {
  label: string;
  value: string;
  max: number;
  readOnly?: boolean;
  onChange(next: string): void;
}) {
  const id = useId();
  const [hint, setHint] = useState(false);
  const baseRef = useRef("");
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const dictation = useDictation((spoken) => {
    const base = baseRef.current.trim() === "" ? "" : `${baseRef.current.trimEnd()} `;
    onChange(`${base}${spoken.trimStart()}`.slice(0, max));
  });
  const heard = dictation.listening;
  return (
    <div>
      <div className={card}>
        <label htmlFor={id} className={fieldLabel}>
          {label}
        </label>
        <div className="flex items-start gap-1 pr-2">
          <textarea
            id={id}
            ref={boxRef}
            rows={2}
            maxLength={max}
            value={value}
            readOnly={readOnly}
            onChange={(e) => {
              dictation.cancel();
              onChange(e.target.value);
            }}
            className={`${fieldInput} resize-none`}
          />
          <button
            type="button"
            aria-label={heard ? `Stop listening: ${label}` : `Speak: ${label}`}
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
        <p role="status" className="px-1 pt-1 text-[15px] font-medium text-red-600 dark:text-red-400">
          Listening... Tap the microphone to stop.
        </p>
      ) : dictation.error ? (
        <p role="alert" className="px-1 pt-1 text-[15px] font-medium text-red-600 dark:text-red-400">
          {dictation.error === "denied" ? MIC_DENIED : MIC_FAILED}
        </p>
      ) : hint ? (
        <p className="px-1 pt-1 text-[15px] text-neutral-600 dark:text-neutral-300">{KEYBOARD_HINT}</p>
      ) : null}
    </div>
  );
}

// The small sheet after a to-do with a contact is ticked off. The tick is already saved: what is
// typed here is added to it (what happened, and a next to-do for the same contact). Leaving any
// other way than Save sends nothing more.
export default function TickSheet({
  estate,
  todo,
  onClose,
  onUnauthorized,
}: {
  estate: EstateInfo;
  todo: Todo;
  onClose(result: TickResult): void;
  onUnauthorized?(): void;
}) {
  const ids = useId();
  const [today] = useState(() => localToday());
  const [outcome, setOutcome] = useState("");
  const [next, setNext] = useState("");
  const [choice, setChoice] = useState<DateChoice>("tomorrow");
  const [picked, setPicked] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // True once the outcome is saved, so a retry after a failed add does not send it twice.
  const [outcomeSent, setOutcomeSent] = useState(false);
  const outcomeSentRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;

  // Focus moves into the dialog and goes back to where it was when the sheet closes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus({ preventScroll: true });
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  const leave = () => {
    if (!busyRef.current) closeRef.current({ outcome: outcomeSentRef.current, next: null });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing) leave();
    };
    document.addEventListener("keydown", onKey);
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = before;
    };
  }, []);

  /** One write; the saved to-do, or null after showing why not. */
  async function send(body: TodoActionBody): Promise<Todo | null> {
    try {
      const res = await todoAction(estate.key, body);
      if (res.status === 401) {
        unauthorizedRef.current?.();
        setError(null);
        return null;
      }
      if (res.status === 200 && res.body && "todo" in res.body) return res.body.todo;
      setError(writeFailure(res.status, res.body));
      return null;
    } catch {
      setError(SAVE_FAILED);
      return null;
    }
  }

  const nextTitle = next.trim();
  const dueDate = dueFromChoice(choice, picked, today);
  const canSave = !busy && (nextTitle === "" || choice !== "pick" || picked !== "");

  async function save() {
    if (busyRef.current || !canSave) return;
    const outcomeText = outcome.trim();
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      if (outcomeText !== "" && !outcomeSentRef.current) {
        if (!(await send({ action: "outcome", id: todo.id, outcome: outcomeText }))) return;
        outcomeSentRef.current = true;
        setOutcomeSent(true);
      }
      let created: Todo | null = null;
      if (nextTitle !== "" && todo.contact) {
        created = await send({ action: "add", title: nextTitle, dueDate, target: contactTarget(todo.contact), source: "next" });
        if (!created) return;
      }
      busyRef.current = false;
      closeRef.current({ outcome: outcomeSentRef.current, next: created });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const heading = `Done: ${todo.title}`;
  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center">
      <div data-testid="tick-backdrop" aria-hidden="true" className="absolute inset-0 bg-black/40" onClick={leave} />
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${ids}-title`}
        className="relative flex max-h-[90dvh] w-full max-w-md flex-col gap-4 overflow-y-auto overscroll-contain rounded-t-3xl bg-[#f2f2f7] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 text-neutral-900 shadow-2xl outline-none dark:bg-[#07090C] dark:text-white"
      >
        <h2 id={`${ids}-title`} className="break-words px-1 text-[19px] font-semibold">
          {heading}
        </h2>
        <DictatedBox label="What happened?" value={outcome} max={MAX_OUTCOME} readOnly={outcomeSent} onChange={setOutcome} />
        <DictatedBox label="What's next?" value={next} max={MAX_TITLE} onChange={setNext} />

        <div className="flex flex-col gap-2">
          <span id={`${ids}-when`} className="px-1 text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
            When
          </span>
          <div role="group" aria-labelledby={`${ids}-when`} className="grid grid-cols-2 gap-2">
            {CHOICES.map((c) => (
              <button
                key={c.key}
                type="button"
                aria-pressed={choice === c.key}
                onClick={() => setChoice(c.key)}
                className={`min-h-[44px] rounded-xl px-3 text-[16px] font-semibold ${
                  choice === c.key
                    ? "bg-[#0E7FA6] text-white dark:bg-[#6AE6FF] dark:text-[#04121A]"
                    : "bg-neutral-200/80 text-neutral-700 dark:bg-white/10 dark:text-neutral-200"
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
          {choice === "pick" ? (
            <div className={card}>
              <label htmlFor={`${ids}-date`} className={fieldLabel}>
                Date
              </label>
              <input id={`${ids}-date`} type="date" value={picked} onChange={(e) => setPicked(e.target.value)} className={fieldInput} />
            </div>
          ) : null}
        </div>

        {error ? (
          <p role="alert" className="px-1 text-[15px] font-medium text-red-700 dark:text-red-300">
            {error}
          </p>
        ) : null}

        <div className="flex flex-col gap-2">
          <button type="button" className={primaryButton} disabled={!canSave} onClick={() => void save()}>
            Save
          </button>
          <button type="button" className={secondaryButton} disabled={busy} onClick={leave}>
            Skip
          </button>
        </div>
      </div>
    </div>
  );
}
