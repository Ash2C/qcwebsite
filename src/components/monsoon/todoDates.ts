// Calendar-day helpers for the To do tab. The server works in YYYY-MM-DD strings; here "today" is the
// phone's local day (never the UTC one), the same day api.ts sends with every request.

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type TodoBucket = "overdue" | "today" | "week" | "later" | "undated";

const pad = (n: number) => String(n).padStart(2, "0");

/** The local calendar day of a Date, as YYYY-MM-DD. */
export function dayOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function localToday(now: Date = new Date()): string {
  return dayOf(now);
}

function parseDay(day: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A YYYY-MM-DD day moved by whole calendar days. */
export function addDays(day: string, n: number): string {
  const d = parseDay(day);
  if (!d) return day;
  d.setDate(d.getDate() + n);
  return dayOf(d);
}

/** The group a due date falls in, with the same boundaries as the server: the week ends at today + 7. */
export function bucketOf(due: string | null, today: string): TodoBucket {
  if (!due) return "undated";
  if (due < today) return "overdue";
  if (due === today) return "today";
  return due <= addDays(today, 7) ? "week" : "later";
}

function yearPart(d: Date, now: Date): string {
  return d.getFullYear() === now.getFullYear() ? "" : ` ${d.getFullYear()}`;
}

/** "Mon 23 Nov", with the year added only when it is not the current one. */
export function formatDay(day: string, now: Date = new Date()): string {
  const d = parseDay(day);
  if (!d) return "";
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${yearPart(d, now)}`;
}

/** "19 Nov" (or "19 Nov 2025") from a YYYY-MM-DD day or an ISO time, read in the local calendar. */
export function shortDate(value: string, now: Date = new Date()): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? parseDay(value) : new Date(value);
  if (!d || Number.isNaN(d.getTime())) return "";
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${yearPart(d, now)}`;
}

export type DateChoice = "today" | "tomorrow" | "week" | "pick" | "none";

/** The due date a date choice stands for; `picked` is the day chosen with "Pick a date". */
export function dueFromChoice(choice: DateChoice, picked: string, today: string): string | null {
  if (choice === "today") return today;
  if (choice === "tomorrow") return addDays(today, 1);
  if (choice === "week") return addDays(today, 7);
  if (choice === "pick") return picked || null;
  return null;
}
