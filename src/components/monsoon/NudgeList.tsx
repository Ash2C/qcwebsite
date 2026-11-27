"use client";

import type { Nudge, Nudges, TodoContact } from "./api";
import { card } from "./styles";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** `<Priority> · last contact N days ago`, or `<Priority> · no contact yet`. */
function quietLine(n: Nudge): string {
  const days = n.quietDays;
  const when = days == null || n.contact.lastAction == null ? "no contact yet" : `last contact ${days} ${days === 1 ? "day" : "days"} ago`;
  return [n.contact.priority ? cap(n.contact.priority) : null, when].filter(Boolean).join(" · ");
}

function Section({
  heading,
  rows,
  total,
  line,
  onAdd,
  onSnooze,
  onShowAll,
  onOpenContact,
  snoozeDisabled,
}: {
  heading: string;
  rows: Nudge[];
  total: number;
  line(n: Nudge): string;
  onAdd(contact: TodoContact): void;
  onSnooze(memberId: string): void;
  onShowAll(): void;
  onOpenContact(contact: TodoContact): void;
  snoozeDisabled: boolean;
}) {
  if (rows.length === 0) return null;
  const more = total - rows.length;
  const action = "min-h-[44px] rounded-xl px-4 text-[16px] font-semibold";
  return (
    <section className="flex flex-col gap-2">
      <h3 className="px-1 text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">{heading}</h3>
      <ul className={`${card} divide-y divide-black/5 overflow-hidden dark:divide-white/10`}>
        {rows.map((n) => (
          <li key={n.contact.memberId} className="flex flex-col gap-1 px-4 py-2">
            <div className="flex flex-wrap items-baseline gap-x-1 text-[16px] text-neutral-900 dark:text-white">
              <button
                type="button"
                onClick={() => onOpenContact(n.contact)}
                className="min-h-[44px] break-words text-left font-semibold text-[#0E7FA6] underline-offset-2 dark:text-[#6AE6FF]"
              >
                {n.contact.name}
              </button>
              <span className="break-words text-[15px] text-neutral-600 dark:text-neutral-300">{` · ${line(n)}`}</span>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                aria-label={`Add a to-do for ${n.contact.name}`}
                onClick={() => onAdd(n.contact)}
                className={`${action} bg-[#0E7FA6] text-white active:bg-[#0D6A8F] dark:bg-[#6AE6FF] dark:text-[#04121A] dark:active:bg-[#3FB8D4]`}
              >
                Add
              </button>
              <button
                type="button"
                aria-label={`Not now for ${n.contact.name}`}
                onClick={() => onSnooze(n.contact.memberId)}
                disabled={snoozeDisabled}
                className={`${action} disabled:opacity-50 bg-neutral-100 text-[#0E7FA6] active:bg-neutral-200 dark:bg-white/10 dark:text-[#6AE6FF] dark:active:bg-white/20`}
              >
                Not now
              </button>
            </div>
          </li>
        ))}
      </ul>
      {more > 0 ? (
        <button
          type="button"
          onClick={onShowAll}
          className="min-h-[44px] self-start rounded-xl px-3 text-[16px] font-medium text-[#0E7FA6] dark:text-[#6AE6FF]"
        >
          {`Show more (${more})`}
        </button>
      ) : null}
    </section>
  );
}

// The two nudge lists under the open to-dos: contacts with no next step, and contacts gone quiet.
// A list with no rows is not shown at all.
export default function NudgeList({
  nudges,
  onAdd,
  onSnooze,
  onShowAll,
  onOpenContact,
  snoozeDisabled = false,
}: {
  nudges: Nudges;
  onAdd(contact: TodoContact): void;
  onSnooze(memberId: string): void;
  onShowAll(): void;
  onOpenContact(contact: TodoContact): void;
  /** Not now writes: it waits while Ask is busy. */
  snoozeDisabled?: boolean;
}) {
  if (nudges.noNextStep.length === 0 && nudges.quiet.length === 0) return null;
  const shared = { onAdd, onSnooze, onShowAll, onOpenContact, snoozeDisabled };
  return (
    <div className="flex flex-col gap-4">
      <Section
        heading="Needs a next step"
        rows={nudges.noNextStep}
        total={nudges.noNextStepTotal}
        line={(n) => `${n.contact.stageLabel} · no to-do`}
        {...shared}
      />
      <Section heading="Gone quiet" rows={nudges.quiet} total={nudges.quietTotal} line={quietLine} {...shared} />
    </div>
  );
}
