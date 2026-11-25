import type { ClaudeChipStatus } from "./claudeStatus";

// Always in the header: green when the last real Claude call worked or the free trial is running,
// red or amber when the key is the problem. Tapping it opens the Claude key screen. The mark differs by state as well as the colour.
const LOOK: Record<ClaudeChipStatus | "unknown", { label: string; tone: string; mark: "dot" | "cross" | "bang" }> = {
  ok: {
    label: "Connected",
    tone: "border-green-600/40 bg-green-50 text-green-800 dark:border-[#1F6B43] dark:bg-[#0F2A1C] dark:text-[#6EE7A0]",
    mark: "dot",
  },
  trial: {
    label: "Free trial",
    tone: "border-green-600/40 bg-green-50 text-green-800 dark:border-[#1F6B43] dark:bg-[#0F2A1C] dark:text-[#6EE7A0]",
    mark: "dot",
  },
  missing: {
    label: "Key needed",
    tone: "border-red-600/40 bg-red-50 text-red-800 dark:border-[#8A2F2F] dark:bg-[#2B1414] dark:text-[#FFA3A3]",
    mark: "cross",
  },
  key_rejected: {
    label: "Key refused",
    tone: "border-red-600/40 bg-red-50 text-red-800 dark:border-[#8A2F2F] dark:bg-[#2B1414] dark:text-[#FFA3A3]",
    mark: "cross",
  },
  no_credit: {
    label: "Out of credit",
    tone: "border-amber-600/40 bg-amber-50 text-amber-900 dark:border-[#8A6A1F] dark:bg-[#2B2210] dark:text-[#FFD27A]",
    mark: "bang",
  },
  unknown: {
    label: "API key",
    tone: "border-neutral-400/50 bg-white text-neutral-700 dark:border-white/20 dark:bg-white/5 dark:text-neutral-200",
    mark: "dot",
  },
};

export function Mark({ kind }: { kind: "dot" | "cross" | "bang" }) {
  if (kind === "dot") return <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-current" />;
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      {kind === "cross" ? <path d="M2 2l8 8M10 2l-8 8" /> : <path d="M6 1.5v6M6 10.4v.1" />}
    </svg>
  );
}

export default function ClaudeChip({
  status,
  disabled,
  onClick,
}: {
  status: ClaudeChipStatus | null;
  disabled?: boolean;
  onClick: () => void;
}) {
  const look = LOOK[status ?? "unknown"];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex min-h-[44px] shrink-0 items-center gap-2 rounded-full border px-3.5 text-[14px] font-semibold disabled:opacity-50 ${look.tone}`}
    >
      <Mark kind={look.mark} />
      {look.label}
    </button>
  );
}
