"use client";

import type { Todo } from "./api";
import { bucketOf, formatDay, localToday, shortDate } from "./todoDates";

/** `<company> · <stage label> · last: <kind> <d MMM>`, leaving out what is not known. */
function contactLine(todo: Todo): string {
  const c = todo.contact;
  if (!c) return "(no contact)";
  const last = c.lastAction ? `last: ${c.lastAction.kind} ${shortDate(c.lastAction.at)}`.trimEnd() : null;
  return [c.company, c.stageLabel, last].filter(Boolean).join(" · ");
}

// One to-do. The circle ticks it off (wired by the panel), the title opens it for editing, and the
// contact's name opens that contact. All three are real buttons of at least 44px.
export default function TodoRowView({
  todo,
  onTick,
  onOpen,
  onOpenContact,
}: {
  todo: Todo;
  onTick(): void;
  onOpen(): void;
  onOpenContact?(): void;
}) {
  const overdue = bucketOf(todo.dueDate, localToday()) === "overdue";
  const line = contactLine(todo);
  return (
    <div className="flex items-stretch">
      <button
        type="button"
        aria-label={`Mark done: ${todo.title}`}
        onClick={onTick}
        className="flex min-h-[64px] w-14 shrink-0 items-center justify-center active:bg-neutral-100 dark:active:bg-white/10"
      >
        <span aria-hidden="true" className="block h-7 w-7 rounded-full border-2 border-neutral-400 dark:border-neutral-500" />
      </button>
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 py-2 pr-4">
        <button
          type="button"
          onClick={onOpen}
          className="flex min-h-[44px] w-full items-center justify-between gap-3 rounded-lg text-left active:bg-neutral-100 dark:active:bg-white/10"
        >
          <span className="break-words text-[17px] font-semibold text-neutral-900 dark:text-white">{todo.title}</span>
          {todo.dueDate ? (
            <span
              className={`shrink-0 text-[14px] ${overdue ? "font-semibold text-red-700 dark:text-red-300" : "text-neutral-500 dark:text-neutral-400"}`}
            >
              {formatDay(todo.dueDate)}
            </span>
          ) : null}
        </button>
        <div className="flex flex-wrap items-center gap-x-2 text-[14px] text-neutral-500 dark:text-neutral-400">
          {todo.contact && onOpenContact ? (
            <button
              type="button"
              onClick={onOpenContact}
              className="min-h-[44px] break-words text-left font-medium text-[#0E7FA6] underline-offset-2 dark:text-[#6AE6FF]"
            >
              {todo.contact.name}
            </button>
          ) : todo.contact ? (
            <span className="break-words font-medium">{todo.contact.name}</span>
          ) : null}
          {line ? <span className="break-words">{line}</span> : null}
          {todo.movedCount >= 2 ? <span>{`moved ${todo.movedCount} times`}</span> : null}
        </div>
      </div>
    </div>
  );
}
