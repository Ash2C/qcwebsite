import type { SavePrompt } from "./outcomes";
import { secondaryButton } from "./styles";

// The answer buttons under a lookalike / same-name message, shared by the single form
// and each batch row so the labels stay identical.
export default function PromptButtons({
  prompt,
  disabled,
  onUseOrg,
  onDifferentCompany,
  onSamePerson,
}: {
  prompt: SavePrompt;
  disabled: boolean;
  onUseOrg: (org: string) => void;
  onDifferentCompany: () => void;
  onSamePerson: (personId: string | false) => void;
}) {
  if (prompt.kind === "org_lookalike") {
    return (
      <div className="flex flex-col gap-2">
        {prompt.similar.map((s) => (
          <button
            key={s}
            type="button"
            disabled={disabled}
            className={secondaryButton}
            onClick={() => onUseOrg(s)}
          >
            Use {s}
          </button>
        ))}
        <button type="button" disabled={disabled} className={secondaryButton} onClick={onDifferentCompany}>
          It&apos;s a different company
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {prompt.matches.map((m) => (
        <button
          key={m.personId}
          type="button"
          disabled={disabled}
          className={secondaryButton}
          onClick={() => onSamePerson(m.personId)}
        >
          Same person ({m.org ?? "no company"})
        </button>
      ))}
      <button type="button" disabled={disabled} className={secondaryButton} onClick={() => onSamePerson(false)}>
        Different person
      </button>
    </div>
  );
}
