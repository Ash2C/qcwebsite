"use client";

import type { CardMatch, MatchCandidate } from "@/lib/monsoon/match";
import { stageLabel } from "./labels";

// null = not chosen yet. A person id = "this is that person"; false = "a different person".
export type MatchChoice = { samePerson: string | false } | null;

const panel =
  "rounded-2xl border border-[#0E7FA6]/40 bg-[#0E7FA6]/5 p-3 dark:border-[#6AE6FF]/40 dark:bg-[#6AE6FF]/10";
const quiet = "text-[14px] leading-snug text-neutral-500 dark:text-neutral-400";
const choiceBase =
  "min-h-[44px] flex-1 rounded-xl px-3 text-[16px] font-medium disabled:opacity-50";
const choiceOff =
  "bg-white text-[#0E7FA6] ring-1 ring-[#0E7FA6]/30 active:bg-neutral-100 dark:bg-white/10 dark:text-[#6AE6FF] dark:ring-[#6AE6FF]/30 dark:active:bg-white/20";
const choiceOn = "bg-[#0E7FA6] font-semibold text-white dark:bg-[#6AE6FF] dark:text-[#04121A]";

function who(c: MatchCandidate): string {
  return `${c.name}, ${c.company ?? "no company"}`;
}

// Where the person stands: their own pipeline row, or the company they are filed under.
function standing(c: MatchCandidate, roleLabel: (key: string) => string): string | null {
  if (c.memberOf === "self" && c.member) return `${roleLabel(c.member.role)} · ${stageLabel(c.member.stage)}`;
  if (c.memberOf === "company" && c.company) return `filed under ${c.company}`;
  return null;
}

// Whether the person read from a photo is already in the CRM, and what to do about it. Presentational:
// the parent owns the match and the choice.
export default function MatchLine({
  match,
  choice,
  onChoose,
  onOpen,
  disabled,
  canOpen = true,
  roleLabel = (key) => key.replace(/_/g, " "),
}: {
  match: CardMatch;
  choice: MatchChoice;
  onChoose: (choice: MatchChoice) => void;
  onOpen: (personId: string) => void;
  disabled?: boolean;
  canOpen?: boolean; // false hides the buttons that leave for a profile
  roleLabel?: (key: string) => string;
}) {
  const first = match.candidates[0];
  if (match.match === "none" || !first) {
    return <p className={`${quiet} px-1`}>New contact</p>;
  }

  if (match.match === "several") {
    return (
      <div className={`${panel} flex flex-col gap-3`}>
        <p className="text-[16px] font-semibold text-neutral-900 dark:text-white">Possible matches</p>
        {match.candidates.map((c) => {
          const line = standing(c, roleLabel);
          return (
            <div key={c.personId} role="group" aria-label={who(c)} className="flex flex-col gap-2">
              <div>
                <p className="break-words text-[16px] text-neutral-900 dark:text-white">{who(c)}</p>
                {line && <p className={`${quiet} break-words`}>{line}</p>}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  aria-pressed={choice?.samePerson === c.personId}
                  disabled={disabled}
                  className={`${choiceBase} ${choice?.samePerson === c.personId ? choiceOn : choiceOff}`}
                  onClick={() => onChoose({ samePerson: c.personId })}
                >
                  This one
                </button>
                {canOpen && (
                  <button
                    type="button"
                    disabled={disabled}
                    className={`${choiceBase} ${choiceOff}`}
                    onClick={() => onOpen(c.personId)}
                  >
                    Open
                  </button>
                )}
              </div>
            </div>
          );
        })}
        <button
          type="button"
          aria-pressed={choice?.samePerson === false}
          disabled={disabled}
          className={`${choiceBase} ${choice?.samePerson === false ? choiceOn : choiceOff}`}
          onClick={() => onChoose({ samePerson: false })}
        >
          None of these
        </button>
      </div>
    );
  }

  const line = standing(first, roleLabel);
  const same = choice?.samePerson === first.personId;
  const different = choice?.samePerson === false;
  return (
    <div className={`${panel} flex flex-col gap-3`}>
      <div>
        <p className="break-words text-[16px] font-semibold text-neutral-900 dark:text-white">
          Already on file: {who(first)}
        </p>
        {line && <p className={`${quiet} break-words`}>{line}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        {canOpen && (
          <button
            type="button"
            disabled={disabled}
            className={`${choiceBase} ${choiceOff}`}
            onClick={() => onOpen(first.personId)}
          >
            Open profile
          </button>
        )}
        <button
          type="button"
          aria-pressed={same}
          disabled={disabled}
          className={`${choiceBase} ${same ? choiceOn : choiceOff}`}
          onClick={() => onChoose({ samePerson: first.personId })}
        >
          Add what&apos;s new
        </button>
        <button
          type="button"
          aria-pressed={different}
          disabled={disabled}
          className={`${choiceBase} ${different ? choiceOn : choiceOff}`}
          onClick={() => onChoose({ samePerson: false })}
        >
          Different person
        </button>
      </div>
    </div>
  );
}
