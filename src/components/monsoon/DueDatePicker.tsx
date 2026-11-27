"use client";

import { useId } from "react";
import { card, fieldInput, fieldLabel } from "./styles";
import { CHOICES, type DateChoice } from "./todoDates";

// "When": Today, Tomorrow, Next week, Pick a date (with a date box), No date. The parent holds the
// choice and the picked day and turns them into a due date with `dueFromChoice`.
export default function DueDatePicker({
  choice,
  picked,
  onChoice,
  onPicked,
}: {
  choice: DateChoice;
  picked: string;
  onChoice(next: DateChoice): void;
  onPicked(day: string): void;
}) {
  const ids = useId();
  return (
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
            onClick={() => onChoice(c.key)}
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
          <input id={`${ids}-date`} type="date" value={picked} onChange={(e) => onPicked(e.target.value)} className={fieldInput} />
        </div>
      ) : null}
    </div>
  );
}
