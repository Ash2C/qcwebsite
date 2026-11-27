"use client";

import { useEffect, useId, useRef, useState } from "react";
import { todoAction, type EstateInfo, type Todo, type TodoActionBody } from "./api";
import DictatedField from "./DictatedField";
import DueDatePicker from "./DueDatePicker";
import { dueFromChoice, localToday, type DateChoice } from "./todoDates";
import { SAVE_FAILED, contactTarget, writeFailure } from "./todoWrites";
import { primaryButton, secondaryButton } from "./styles";

const MAX_OUTCOME = 2000;
const MAX_TITLE = 300;

export type TickResult = { outcome: boolean; next: Todo | null };

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
        <DictatedField label="What happened?" value={outcome} max={MAX_OUTCOME} readOnly={outcomeSent} onChange={setOutcome} />
        <DictatedField label="What's next?" value={next} max={MAX_TITLE} onChange={setNext} />

        <DueDatePicker choice={choice} picked={picked} onChoice={setChoice} onPicked={setPicked} />

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
