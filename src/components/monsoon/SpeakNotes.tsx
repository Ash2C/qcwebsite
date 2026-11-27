"use client";

import { useRef, useState } from "react";
import type { ContactFields, RefineOutput } from "@/lib/monsoon/refine";
import { claudeFailureText } from "./claudeFailure";
import { refineCard } from "./api";
import type { Snapshot } from "./merge";
import { secondaryButton } from "./styles";

const GENERIC_FAILURE = "Could not tidy the notes.";

// Dictation happens with the iPhone keyboard microphone into a plain textarea; no audio is handled here.
// The draft lives in the parent so it survives a 401 re-login. Applying only reports the result: the
// parent decides how to show it, and nothing is saved from here.
export default function SpeakNotes({
  fields,
  notes,
  draft,
  onDraft,
  onApply,
  onUnauthorized,
  onBusy,
  disabled,
}: {
  fields: ContactFields;
  notes: string;
  draft: string;
  onDraft: (text: string) => void;
  // `sent` is what the request carried, so the parent can tell what the model actually changed.
  onApply: (next: RefineOutput, sent: Snapshot) => void;
  onUnauthorized: () => void;
  // True while a tidy request is in flight, so the parent can lock the contact it belongs to.
  onBusy?: (busy: boolean) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  // null = no failure; otherwise the message to show.
  const [failure, setFailure] = useState<string | null>(null);
  const runRef = useRef(false);

  function finish(next: RefineOutput, sent: Snapshot) {
    onApply(next, sent);
    onDraft("");
    setFailure(null);
    setOpen(false);
  }

  async function apply() {
    if (runRef.current || draft.trim() === "") return;
    runRef.current = true;
    setRunning(true);
    setFailure(null);
    onBusy?.(true);
    const sent = { fields, notes };
    try {
      const res = await refineCard({ ...sent, spoken: draft });
      if (res.status === 401) {
        onUnauthorized();
      } else if (res.status === 200 && "fields" in res.body) {
        finish(res.body, sent);
      } else if (res.status === 400 && typeof (res.body as { error?: unknown }).error === "string") {
        setFailure((res.body as { error: string }).error);
      } else {
        setFailure(claudeFailureText(res.body, "Notes cannot be tidied") ?? GENERIC_FAILURE);
      }
    } catch {
      setFailure(GENERIC_FAILURE);
    } finally {
      runRef.current = false;
      setRunning(false);
      onBusy?.(false);
    }
  }

  // Applies the typed text without a request; bracketed as busy so the parent stamps it as current.
  function applyAsTyped() {
    if (disabled) return;
    onBusy?.(true);
    finish({ fields, notes: [notes, draft].filter(Boolean).join("\n"), todos: [] }, { fields, notes });
    onBusy?.(false);
  }

  if (!open) {
    return (
      <button type="button" disabled={disabled} className={`${secondaryButton} flex items-center justify-center gap-2`} onClick={() => setOpen(true)}>
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="h-5 w-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
        </svg>
        Speak notes
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="speak-notes-draft" className="sr-only">
        Spoken notes
      </label>
      <textarea
        id="speak-notes-draft"
        autoFocus
        rows={4}
        value={draft}
        disabled={running}
        maxLength={4000}
        placeholder="Tap the microphone on the keyboard and talk"
        onChange={(e) => onDraft(e.target.value)}
        className="block w-full rounded-xl bg-neutral-100 px-4 py-2.5 text-[17px] text-neutral-900 placeholder:text-neutral-400 focus:outline-none dark:bg-white/10 dark:text-white dark:placeholder:text-neutral-500"
      />
      {failure !== null && (
        <div role="alert" className="flex flex-col gap-2">
          <p className="text-[15px] font-medium text-red-600 dark:text-red-400">{failure}</p>
          <button
            type="button"
            className={secondaryButton}
            disabled={disabled}
            onClick={applyAsTyped}
          >
            Use as typed
          </button>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <button type="button" className={secondaryButton} onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button
          type="button"
          className={secondaryButton}
          disabled={disabled || running || draft.trim() === ""}
          onClick={() => void apply()}
        >
          {running ? "Tidying…" : "Apply"}
        </button>
      </div>
    </div>
  );
}
