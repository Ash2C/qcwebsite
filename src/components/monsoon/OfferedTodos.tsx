"use client";

import { useState } from "react";
import type { OfferedTodo } from "@/lib/monsoon/refine";
import { changedClass } from "./Highlight";
import { shortDate } from "./todoDates";

// Same limit as the server (MAX_OFFERED_TODOS in refine.ts); not imported, as that file pulls in server code.
export const MAX_OFFERED = 5;

// Adds the to-dos a later dictation offered: an exact title already listed is skipped, and the
// list stops at the limit.
export function appendOffered(list: OfferedTodo[], more: OfferedTodo[] | undefined): OfferedTodo[] {
  const out = [...list];
  for (const t of more ?? []) {
    if (out.length >= MAX_OFFERED) break;
    if (!out.some((o) => o.title === t.title)) out.push(t);
  }
  return out;
}

// What a tidy offered, shown under Notes in the highlighted style. Each can be removed; the last
// removal can be undone. Saving the contact sends what is left. The parent keeps the list.
export default function OfferedTodos({
  todos,
  onChange,
  disabled,
}: {
  todos: OfferedTodo[];
  onChange: (next: OfferedTodo[]) => void;
  disabled?: boolean;
}) {
  const [removed, setRemoved] = useState<{ todo: OfferedTodo; index: number } | null>(null);
  if (todos.length === 0 && !removed) return null;

  function remove(index: number) {
    setRemoved({ todo: todos[index], index });
    onChange(todos.filter((_, i) => i !== index));
  }

  function undo() {
    if (!removed) return;
    const next = [...todos];
    if (!next.some((t) => t.title === removed.todo.title) && next.length < MAX_OFFERED) {
      next.splice(Math.min(removed.index, next.length), 0, removed.todo);
      onChange(next);
    }
    setRemoved(null);
  }

  return (
    <section aria-labelledby="offered-todos-heading" className="flex flex-col gap-2">
      <h3 id="offered-todos-heading" className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        To do
      </h3>
      {todos.length > 0 && (
        <ul className="flex flex-col gap-1">
          {todos.map((t, i) => (
            <li
              key={`${t.title}-${i}`}
              data-changed
              className={`flex min-h-[44px] items-center justify-between gap-2 rounded-xl pl-4 ${changedClass}`}
            >
              <span className="text-[16px] text-neutral-900 dark:text-white">
                {t.title} · {t.due ? shortDate(t.due) || "no date" : "no date"}
              </span>
              <button
                type="button"
                aria-label={`Remove to-do: ${t.title}`}
                disabled={disabled}
                onClick={() => remove(i)}
                className="flex h-11 w-11 shrink-0 items-center justify-center text-[22px] text-neutral-600 disabled:opacity-50 dark:text-neutral-300"
              >
                <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {removed && (
        <button
          type="button"
          disabled={disabled}
          onClick={undo}
          className="min-h-[44px] w-full rounded-xl bg-neutral-100 px-4 text-[16px] font-medium text-[#0E7FA6] disabled:opacity-50 dark:bg-white/10 dark:text-[#6AE6FF]"
        >
          Undo
        </button>
      )}
    </section>
  );
}
