"use client";

import { useRef, useState } from "react";
import type { ContactFields, RefineOutput } from "@/lib/monsoon/refine";
import { refineCard } from "./api";
import { secondaryButton } from "./styles";

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
  disabled,
}: {
  fields: ContactFields;
  notes: string;
  draft: string;
  onDraft: (text: string) => void;
  onApply: (next: RefineOutput) => void;
  onUnauthorized: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState(false);
  const runRef = useRef(false);

  function finish(next: RefineOutput) {
    onApply(next);
    onDraft("");
    setFailed(false);
    setOpen(false);
  }

  async function apply() {
    if (runRef.current || draft.trim() === "") return;
    runRef.current = true;
    setRunning(true);
    setFailed(false);
    try {
      const res = await refineCard({ fields, notes, spoken: draft });
      if (res.status === 401) {
        onUnauthorized();
      } else if (res.status === 200 && "fields" in res.body) {
        finish(res.body);
      } else {
        setFailed(true);
      }
    } catch {
      setFailed(true);
    } finally {
      runRef.current = false;
      setRunning(false);
    }
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
        placeholder="Tap the microphone on the keyboard and talk"
        onChange={(e) => onDraft(e.target.value)}
        className="block w-full rounded-xl bg-neutral-100 px-4 py-2.5 text-[17px] text-neutral-900 placeholder:text-neutral-400 focus:outline-none dark:bg-white/10 dark:text-white dark:placeholder:text-neutral-500"
      />
      {failed && (
        <div role="alert" className="flex flex-col gap-2">
          <p className="text-[15px] font-medium text-red-600 dark:text-red-400">Could not tidy the notes.</p>
          <button
            type="button"
            className={secondaryButton}
            onClick={() => finish({ fields, notes: [notes, draft].filter(Boolean).join("\n") })}
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
