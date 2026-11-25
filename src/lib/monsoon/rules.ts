// Port of quantcloud/crm/rules.py (matching rules only). Parity is pinned by rules.fixtures.json,
// generated from the Python source by scripts/monsoon/gen_rule_fixtures.py.

const PROTECTED = new Set(["id", "name", "name_key", "org_id", "source", "external_ref", "created_at"]);

const ORG_STOPWORDS = new Set(
  `capital group management mgmt family office offices holdings holding investments investment
partners partner pte ltd limited llc llp inc corp corporation co the and of intl international
fund funds advisors advisory asset assets sa ag gmbh plc trust ventures venture global`.split(/\s+/),
);

export function nameKey(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

export function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

/** Keys to write onto an existing row: incoming non-empty AND stored empty, never protected. */
export function mergeFillEmpty(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (!PROTECTED.has(k) && !isEmpty(v) && isEmpty(existing[k])) out[k] = v;
  }
  return out;
}

/** Comparable cores of an org name: outside parentheses, plus each parenthetical as an alias. */
export function orgNameCores(name: string): string[] {
  const parts = [name.replace(/\([^)]*\)/g, " "), ...[...name.matchAll(/\(([^)]*)\)/g)].map((m) => m[1])];
  const cores: string[] = [];
  for (const part of parts) {
    const tokens = part.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter(Boolean);
    const kept = tokens.filter((t) => !ORG_STOPWORDS.has(t)).join(" ");
    const core = kept || tokens.join(" ");
    if (core && !cores.includes(core)) cores.push(core);
  }
  return cores;
}

// Longest common contiguous block within a[alo:ahi] and b[blo:bhi]; ties go to the earliest
// start in a, then the earliest in b (as difflib does).
function longestMatch(a: string, b: string, alo: number, ahi: number, blo: number, bhi: number) {
  let bestI = alo;
  let bestJ = blo;
  let bestSize = 0;
  for (let i = alo; i < ahi; i++) {
    for (let j = blo; j < bhi; j++) {
      let k = 0;
      while (i + k < ahi && j + k < bhi && a[i + k] === b[j + k]) k++;
      if (k > bestSize) {
        bestI = i;
        bestJ = j;
        bestSize = k;
      }
    }
  }
  return { i: bestI, j: bestJ, size: bestSize };
}

function matchedChars(a: string, b: string, alo: number, ahi: number, blo: number, bhi: number): number {
  const { i, j, size } = longestMatch(a, b, alo, ahi, blo, bhi);
  if (size === 0) return 0;
  return size + matchedChars(a, b, alo, i, blo, j) + matchedChars(a, b, i + size, ahi, j + size, bhi);
}

/** difflib.SequenceMatcher(None, a, b).ratio() without autojunk (only matters at 200+ characters). */
export function sequenceRatio(a: string, b: string): number {
  const total = a.length + b.length;
  if (total === 0) return 1;
  return (2 * matchedChars(a, b, 0, a.length, 0, b.length)) / total;
}

/** Existing names that probably mean the same org. An exact name is not similar. */
export function similarOrgNames(name: string, existing: string[]): string[] {
  const mine = orgNameCores(name);
  const key = nameKey(name);
  const out: string[] = [];
  for (const other of existing) {
    if (nameKey(other) === key || out.includes(other)) continue;
    const theirs = orgNameCores(other);
    for (const a of mine) {
      for (const b of theirs) {
        const [short, long] = a.length <= b.length ? [a, b] : [b, a];
        if (
          a === b ||
          (short.length >= 4 && long.startsWith(short + " ")) ||
          (short.length >= 6 && sequenceRatio(a, b) >= 0.85)
        ) {
          out.push(other);
          break;
        }
      }
      if (out.includes(other)) break;
    }
  }
  return out;
}

export type DueBucket = "overdue" | "today" | "week" | "later" | "undated" | "none";

function isoDay(value: string | Date): string {
  if (value instanceof Date) {
    // node-pg parses a DATE column to local midnight, so read the local calendar day.
    const mm = String(value.getMonth() + 1).padStart(2, "0");
    const dd = String(value.getDate()).padStart(2, "0");
    return `${value.getFullYear()}-${mm}-${dd}`;
  }
  return String(value).slice(0, 10);
}

function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** When a member's next action is due, relative to `today` (YYYY-MM-DD). Week = within 7 days. */
export function dueBucket(
  member: { next_action?: string | null; next_action_date?: string | Date | null },
  today: string,
): DueBucket {
  if (!(member.next_action ?? "").trim()) return "none";
  const raw = member.next_action_date;
  if (!raw) return "undated";
  const due = isoDay(raw);
  if (due < today) return "overdue";
  if (due === today) return "today";
  return due <= addDays(today, 7) ? "week" : "later";
}

export const ACTION_KINDS = ["note", "email", "call", "meeting"] as const;

// The timeline entry written when a contact is added is stored as a "meeting" (as the core does),
// but adding someone is not meeting them. These are the texts that entry starts with, today's and
// the ones written before the wording changed, after an optional "<Name>: " for a person filed
// under a company.
const PHOTO_TEXTS = [
  "Added from a photo of a business card",
  "Added from a photo of a badge",
  "Added from a screenshot",
  "Added from a photo",
  "Badge captured in person",
  "Captured from a screenshot",
  "Captured from a photo",
];
// "Card captured in person" was also written for hand-typed contacts, so it says only "added".
const ADDED_TEXTS = ["Added by hand", "Card captured in person"];
const NAME_PREFIX = /^[^:\n]{1,200}: /;

function startsWithAny(text: string, starts: string[]): boolean {
  return starts.some((s) => text === s || text.startsWith(`${s}:`) || text.startsWith(`${s} (`));
}

/** "photo" for an entry made when a contact came in from an image, "added" for one typed in, else null. */
export function captureOrigin(summary: string | null | undefined): "photo" | "added" | null {
  const text = (summary ?? "").trim();
  for (const candidate of [text, text.replace(NAME_PREFIX, "")]) {
    if (startsWithAny(candidate, PHOTO_TEXTS)) return "photo";
    if (startsWithAny(candidate, ADDED_TEXTS)) return "added";
  }
  return null;
}

/** What to call a last action: a meeting entry that only records the contact being added is not a meeting. */
export function actionLabel(kind: string, summary: string | null | undefined): string {
  if (kind !== "meeting") return kind;
  const origin = captureOrigin(summary);
  return origin === "photo" ? "photo capture" : origin === "added" ? "added" : kind;
}

/** The newest call, meeting, email or note, compared on String(at) as the Python does. First wins a tie. */
export function lastAction<T extends { kind: string; at: string | Date }>(touches: T[]): T | null {
  let best: T | null = null;
  let bestAt = "";
  for (const t of touches) {
    if (!(ACTION_KINDS as readonly string[]).includes(t.kind)) continue;
    const at = t.at instanceof Date ? t.at.toISOString() : String(t.at ?? "");
    if (best === null || at > bestAt) {
      best = t;
      bestAt = at;
    }
  }
  return best;
}
