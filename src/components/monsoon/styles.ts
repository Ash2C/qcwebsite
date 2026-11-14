// Shared class names and the six-field list, used by the single form and the batch review.
export const card =
  "rounded-2xl bg-white dark:bg-[#0E1822] shadow-sm ring-1 ring-black/5 dark:ring-white/10";
export const fieldInput =
  "block w-full min-h-[44px] bg-transparent px-4 py-2.5 text-[17px] text-neutral-900 dark:text-white placeholder:text-neutral-400 dark:placeholder:text-neutral-500 focus:outline-none focus-visible:outline-none";
export const fieldLabel =
  "block px-4 pt-2 text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400";
export const primaryButton =
  "min-h-[52px] w-full rounded-2xl bg-[#0E7FA6] px-6 text-[17px] font-semibold text-white active:bg-[#0D6A8F] disabled:bg-neutral-300 disabled:text-neutral-500 dark:bg-[#6AE6FF] dark:text-[#04121A] dark:active:bg-[#3FB8D4] dark:disabled:bg-neutral-700 dark:disabled:text-neutral-500";
export const secondaryButton =
  "min-h-[44px] w-full rounded-xl bg-neutral-100 px-4 text-[16px] font-medium text-[#0E7FA6] active:bg-neutral-200 disabled:opacity-50 dark:bg-white/10 dark:text-[#6AE6FF] dark:active:bg-white/20";

export type FieldKey = "name" | "title" | "org" | "email" | "phone" | "linkedin";

export const FIELD_ROWS: { key: FieldKey; label: string; type?: string; mode?: "email" | "tel" | "url"; auto?: string }[] = [
  { key: "name", label: "Name", auto: "off" },
  { key: "title", label: "Title", auto: "off" },
  { key: "org", label: "Company", auto: "off" },
  { key: "email", label: "Email", type: "email", mode: "email", auto: "off" },
  { key: "phone", label: "Phone", type: "tel", mode: "tel", auto: "off" },
  { key: "linkedin", label: "LinkedIn", type: "url", mode: "url", auto: "off" },
];
