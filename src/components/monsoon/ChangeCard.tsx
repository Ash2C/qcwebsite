"use client";

import type { DetailField } from "@/lib/monsoon/ask/proposal";
import { card as cardClass, secondaryButton } from "./styles";
import type { AskCard } from "./useCardConfirm";

export const MAX_NOTE = 2000;

// The browser's copy of DETAIL_LABELS in lib/monsoon/details.ts (a server module, so not imported here).
export const DETAIL_LABELS: Record<DetailField, string> = {
  name: "Name",
  title: "Title",
  email: "Email",
  phone: "Phone",
  linkedin: "LinkedIn",
  country: "Country",
  company: "Company",
  website: "Website",
};

function stageLabel(key: string): string {
  return key.replace(/_/g, " ");
}

// One line for the model's history, e.g. after Cancel.
export function describeChange(c: AskCard): string {
  const p = c.signed.proposal;
  if (p.kind === "update_details") return `change the details of ${p.targetName}`;
  if (p.kind === "apply_research") return `save research about ${p.person.name}`;
  if (p.kind === "add_todo") return `add the to-do "${p.title}"`;
  if (p.kind === "complete_todo") return `tick off the to-do "${p.title}"`;
  if (p.kind === "move_todo") return `move the to-do "${p.title}"`;
  if (p.kind === "drop_todo") return `drop the to-do "${p.title}"`;
  if (p.kind === "set_next_action") return p.toAction ? `set the next action for ${p.memberName}` : `clear the next action for ${p.memberName}`;
  if (p.kind === "set_role") return `change the type of ${p.memberName} from ${stageLabel(p.fromRole)} to ${stageLabel(p.toRole)}`;
  if (p.kind === "set_priority") return `change the priority of ${p.memberName} from ${p.fromPriority ?? "none"} to ${p.toPriority ?? "none"}`;
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
  blocked = false,
}: {
  card: AskCard;
  onText: (text: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  /** Another write is in flight elsewhere: Confirm waits for it (one write at a time). */
  blocked?: boolean;
}) {
  const p = card.signed.proposal;
  const open = card.state === "open" || card.state === "working";
  const working = card.state === "working";
  const isNote = p.kind === "add_note";
  const blank = card.text.trim() === "";
  const tooLong = card.text.length > MAX_NOTE;
  const tone =
    card.state === "failed"
      ? "text-red-600 dark:text-red-400"
      : card.state === "done"
        ? "text-green-700 dark:text-green-400"
        : "text-neutral-600 dark:text-neutral-300";

  const status = (
    <>
      {card.state === "cancelled" && <p className={`break-words text-[15px] font-medium ${tone}`}>Cancelled.</p>}
      {card.message && card.state !== "cancelled" && (
        <p role={card.state === "failed" ? "alert" : "status"} className={`break-words text-[15px] font-medium ${tone}`}>
          {card.message}
        </p>
      )}
    </>
  );
  const buttons = (disabledConfirm: boolean) =>
    open && (
      <div className="grid grid-cols-2 gap-2">
        <button type="button" className={secondaryButton} disabled={working} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className={secondaryButton} disabled={working || blocked || disabledConfirm} onClick={onConfirm}>
          Confirm
        </button>
      </div>
    );

  if (p.kind === "apply_research") return null; // rendered by the research card, not here

  if (p.kind === "update_details") {
    const display = (v: string | null) => (v ? v : "(empty)");
    return (
      <div className={`${cardClass} flex min-w-0 flex-col gap-3 p-4`}>
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Edit details</p>
        <div className="flex min-w-0 flex-col">
          <p className="break-words text-[17px] font-semibold leading-snug">{p.targetName}</p>
          {p.target.type === "person" && p.company && (
            <p className="break-words text-[15px] text-neutral-500 dark:text-neutral-400">{p.company}</p>
          )}
          {p.target.type === "company" && (
            <p className="break-words text-[15px] text-neutral-500 dark:text-neutral-400">Company</p>
          )}
        </div>
        <ul className="flex flex-col gap-1">
          {p.changes.map((c) => (
            <li key={c.field} className="break-words text-[17px]">
              {`${DETAIL_LABELS[c.field]}: ${display(c.from)} → ${display(c.to)}`}
            </li>
          ))}
        </ul>
        {p.addsToPipeline && (
          <p className="break-words text-[15px] text-neutral-600 dark:text-neutral-300">
            {`This also adds ${p.targetName} to the pipeline as ${p.addsToPipeline.replace(/_/g, " ")}.`}
          </p>
        )}
        {status}
        {buttons(false)}
      </div>
    );
  }

  if (p.kind === "add_todo" || p.kind === "complete_todo" || p.kind === "move_todo" || p.kind === "drop_todo") {
    const heading = { add_todo: "Add to-do", complete_todo: "Tick off to-do", move_todo: "Move to-do", drop_todo: "Drop to-do" }[p.kind];
    const date = (v: string | null) => v ?? "No date";
    const contact = p.kind === "add_todo" && p.about ? `${p.about} (${p.memberName})` : p.memberName;
    const muted = "break-words text-[15px] text-neutral-500 dark:text-neutral-400";
    return (
      <div className={`${cardClass} flex min-w-0 flex-col gap-3 p-4`}>
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">{heading}</p>
        <div className="flex min-w-0 flex-col">
          <p className="break-words text-[17px] font-semibold leading-snug">{p.title}</p>
          {contact && <p className={muted}>{contact}</p>}
        </div>
        {p.kind === "add_todo" && <p className="break-words text-[17px]">{date(p.dueDate)}</p>}
        {p.kind === "move_todo" && <p className="break-words text-[17px]">{`${date(p.fromDate)} → ${date(p.toDate)}`}</p>}
        {p.kind === "complete_todo" && p.outcome && <p className="whitespace-pre-wrap break-words text-[17px]">{p.outcome}</p>}
        {status}
        {buttons(false)}
      </div>
    );
  }

  const second = p.memberKind === "company" ? "company" : p.company;

  return (
    <div className={`${cardClass} flex min-w-0 flex-col gap-3 p-4`}>
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        {isNote ? "Add note" : p.kind === "set_priority" ? "Priority" : p.kind === "set_role" ? "Contact type" : p.kind === "set_next_action" ? "Next action" : "Move stage"}
      </p>
      <div className="flex min-w-0 flex-col">
        <p className="break-words text-[17px] font-semibold leading-snug">{p.memberName}</p>
        {second && <p className="break-words text-[15px] text-neutral-500 dark:text-neutral-400">{second}</p>}
        {p.about && <p className="break-words text-[15px] text-neutral-500 dark:text-neutral-400">About {p.about}</p>}
      </div>
      {p.kind === "set_next_action" && (
        <p className="break-words text-[17px]">
          {p.toAction ? `${p.toAction}${p.toDate ? ` · due ${p.toDate}` : ""}` : "Cleared"}
        </p>
      )}
      {p.kind === "set_role" && (
        <p className="break-words text-[17px]">
          {stageLabel(p.fromRole)} → {stageLabel(p.toRole)}
        </p>
      )}
      {p.kind === "set_priority" && (
        <p className="break-words text-[17px]">
          {`${p.fromPriority ?? "none"} → ${p.toPriority ?? "none"}`}
        </p>
      )}
      {p.kind === "move_stage" && (
        <p className="break-words text-[17px]">
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
              className="block w-full break-words rounded-xl bg-neutral-100 px-4 py-2.5 text-[17px] text-neutral-900 focus:outline-none dark:bg-white/10 dark:text-white"
            />
            {tooLong && (
              <p role="alert" className="text-[15px] font-medium text-red-600 dark:text-red-400">
                Notes can be up to {MAX_NOTE} characters.
              </p>
            )}
          </>
        ) : (
          <p className="whitespace-pre-wrap break-words text-[17px]">{card.text}</p>
        ))}
      {status}
      {buttons(isNote && (blank || tooLong))}
    </div>
  );
}
