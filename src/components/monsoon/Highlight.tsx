// Shared by the single form and the batch row editor: how a field changed by spoken notes is marked.
export const changedClass = "bg-yellow-100 dark:bg-yellow-400/20";

// The old value under a changed field. Long or multi-line values are clamped to two lines.
export function Was({ value }: { value: string }) {
  return (
    <p className="line-clamp-2 whitespace-pre-line px-4 pb-2 text-[13px] text-neutral-600 dark:text-neutral-300">
      {value.trim() === "" ? "was empty" : `was: ${value}`}
    </p>
  );
}

// Rows for a notes textarea: three to eight lines, then it scrolls.
export function notesRows(value: string, min = 3): number {
  return Math.min(8, Math.max(min, value.split("\n").length));
}
