"use client";

import type { AskCard } from "./AskPanel";
import { card as cardClass, secondaryButton } from "./styles";

export const MAX_NOTE = 2000;

function stageLabel(key: string): string {
  return key.replace(/_/g, " ");
}

// One line for the model's history, e.g. after Cancel.
export function describeChange(c: AskCard): string {
  const p = c.signed.proposal;
  return p.kind === "add_note"
    ? `add a note to ${p.memberName}`
    : `move ${p.memberName} from ${stageLabel(p.fromStage)} to ${stageLabel(p.toStage)}`;
}

// A change the server proposed, shown for an explicit Confirm or Cancel. Everything here is plain text.
export default function ChangeCard({
  card,
  onText,
  onConfirm,
  onCancel,
}: {
  card: AskCard;
  onText: (text: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const p = card.signed.proposal;
  const open = card.state === "open" || card.state === "working";
  const working = card.state === "working";
  const isNote = p.kind === "add_note";
  const blank = card.text.trim() === "";
  const tooLong = card.text.length > MAX_NOTE;
  const second = p.memberKind === "company" ? "company" : p.company;
  const tone =
    card.state === "failed"
      ? "text-red-600 dark:text-red-400"
      : card.state === "done"
        ? "text-green-700 dark:text-green-400"
        : "text-neutral-600 dark:text-neutral-300";

  return (
    <div className={`${cardClass} flex flex-col gap-3 p-4`}>
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        {isNote ? "Add note" : "Move stage"}
      </p>
      <div className="flex flex-col">
        <p className="text-[17px] font-semibold leading-snug">{p.memberName}</p>
        {second && <p className="text-[15px] text-neutral-500 dark:text-neutral-400">{second}</p>}
        {p.about && <p className="text-[15px] text-neutral-500 dark:text-neutral-400">About {p.about}</p>}
      </div>
      {p.kind === "move_stage" && (
        <p className="text-[17px]">
          {stageLabel(p.fromStage)} → {stageLabel(p.toStage)}
        </p>
      )}
      {isNote &&
        (open ? (
          <>
            <label htmlFor={`note-${card.id}`} className="sr-only">
              Note text
            </label>
            <textarea
              id={`note-${card.id}`}
              rows={3}
              value={card.text}
              disabled={working}
              onChange={(e) => onText(e.target.value)}
              className="block w-full rounded-xl bg-neutral-100 px-4 py-2.5 text-[17px] text-neutral-900 focus:outline-none dark:bg-white/10 dark:text-white"
            />
            {tooLong && (
              <p role="alert" className="text-[15px] font-medium text-red-600 dark:text-red-400">
                Notes can be up to {MAX_NOTE} characters.
              </p>
            )}
          </>
        ) : (
          <p className="whitespace-pre-wrap text-[17px]">{card.text}</p>
        ))}
      {card.state === "cancelled" && <p className={`text-[15px] font-medium ${tone}`}>Cancelled.</p>}
      {card.message && card.state !== "cancelled" && (
        <p role={card.state === "failed" ? "alert" : "status"} className={`text-[15px] font-medium ${tone}`}>
          {card.message}
        </p>
      )}
      {open && (
        <div className="grid grid-cols-2 gap-2">
          <button type="button" className={secondaryButton} disabled={working} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={secondaryButton}
            disabled={working || (isNote && (blank || tooLong))}
            onClick={onConfirm}
          >
            Confirm
          </button>
        </div>
      )}
    </div>
  );
}
