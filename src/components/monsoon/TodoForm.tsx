"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { SiftHit } from "@/lib/monsoon/sift";
import { searchContacts, todoAction, type EstateInfo, type Todo, type TodoActionBody, type TodoTarget } from "./api";
import { addDays, localToday } from "./todoDates";
import { card, fieldInput, fieldLabel, primaryButton, secondaryButton } from "./styles";
import { useDictation } from "./useDictation";

export const GONE = "That to-do is no longer there.";
const SAVE_FAILED = "Could not save. Check signal.";
const SEARCH_FAILED = "Could not search. Check signal.";
const MIC_DENIED = "The microphone is blocked. Allow it in Settings, or use the microphone on the keyboard.";
const MIC_FAILED = "Could not listen. Try again, or use the microphone on the keyboard.";
const KEYBOARD_HINT = "This browser cannot listen. Use the microphone on the keyboard.";
const DEBOUNCE_MS = 250;
const MAX_TITLE = 300;

type Choice = "today" | "tomorrow" | "week" | "pick" | "none";
const CHOICES: { key: Choice; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "tomorrow", label: "Tomorrow" },
  { key: "week", label: "Next week" },
  { key: "pick", label: "Pick a date" },
  { key: "none", label: "No date" },
];

type Chip = { name: string; target?: TodoTarget };

/** What a Contacts search result can be tied to: a person by id, a company by its pipeline entry. */
function targetOfHit(hit: SiftHit): TodoTarget | null {
  if (hit.kind === "person") return hit.personId ? { personId: hit.personId } : null;
  return hit.member ? { memberId: hit.member.memberId } : null;
}

/** The words for a write that did not succeed; "" when the reply was not a failure (so the caller carries on). */
export function writeFailure(status: number, body: unknown): string {
  if (status === 404) return GONE;
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  if (typeof error === "string" && error.trim() !== "") return error;
  return SAVE_FAILED;
}

function startChoice(initial: Todo | undefined, today: string): { choice: Choice; picked: string } {
  if (!initial) return { choice: "today", picked: "" };
  const due = initial.dueDate;
  if (!due) return { choice: "none", picked: "" };
  if (due === today) return { choice: "today", picked: "" };
  if (due === addDays(today, 1)) return { choice: "tomorrow", picked: "" };
  if (due === addDays(today, 7)) return { choice: "week", picked: "" };
  return { choice: "pick", picked: due };
}

// The add form and the edit view: what (typed or spoken), when, who. It writes by itself on the first
// tap and tells its parent how it ended through onDone (the saved to-do, or null for Cancel or no change).
export default function TodoForm({
  estate,
  initial,
  contact,
  onDone,
  onUnauthorized,
  onPrepare,
  onDropped,
  onGone,
}: {
  estate: EstateInfo;
  initial?: Todo;
  contact?: { target: TodoTarget; name: string };
  onDone(todo: Todo | null): void;
  onUnauthorized?(): void;
  onPrepare?(todo: Todo): void;
  onDropped?(todo: Todo): void;
  /** The to-do was not found when writing: the list should be read again. */
  onGone?(): void;
}) {
  const ids = useId();
  const [today] = useState(() => localToday());
  const start = useState(() => startChoice(initial, today))[0];
  const [title, setTitle] = useState(initial?.title ?? "");
  const [choice, setChoice] = useState<Choice>(start.choice);
  const [picked, setPicked] = useState(start.picked);
  const [chip, setChip] = useState<Chip | null>(
    contact ? { name: contact.name, target: contact.target } : initial?.contact ? { name: initial.contact.name } : null,
  );
  // True once the contact was changed or removed here; an untouched contact is not sent at all.
  const [touched, setTouched] = useState(contact !== undefined);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ hit: SiftHit; target: TodoTarget }[]>([]);
  const [searchFailed, setSearchFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [speakHint, setSpeakHint] = useState(false);
  const spokenBaseRef = useRef("");
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;

  const dictation = useDictation((spoken) => {
    const base = spokenBaseRef.current.trim() === "" ? "" : `${spokenBaseRef.current.trimEnd()} `;
    setTitle(`${base}${spoken.trimStart()}`.slice(0, MAX_TITLE));
  });

  // The contact search, as Contacts does it: after a short pause, and only for two letters or more.
  const q = query.trim();
  useEffect(() => {
    if (chip || q.length < 2) {
      setResults([]);
      setSearchFailed(false);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      searchContacts(estate.key, q).then(
        (res) => {
          if (!live) return;
          if (res.status === 401) return unauthorizedRef.current?.();
          if (res.status === 200 && res.body && "contacts" in res.body) {
            setSearchFailed(false);
            setResults(
              res.body.contacts.flatMap((hit) => {
                const target = targetOfHit(hit);
                return target ? [{ hit, target }] : [];
              }),
            );
            return;
          }
          setResults([]);
          setSearchFailed(true);
        },
        () => {
          if (!live) return;
          setResults([]);
          setSearchFailed(true);
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [estate.key, q, chip]);

  const dueDate: string | null =
    choice === "today" ? today : choice === "tomorrow" ? addDays(today, 1) : choice === "week" ? addDays(today, 7) : choice === "pick" ? picked || null : null;
  const cleanTitle = title.trim();
  const canSave = cleanTitle !== "" && !busy && (choice !== "pick" || picked !== "");

  /** Sends one write; returns the to-do on success, null after showing why not. */
  async function send(body: TodoActionBody): Promise<Todo | null> {
    if (busyRef.current) return null;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await todoAction(estate.key, body);
      if (res.status === 401) {
        unauthorizedRef.current?.();
        return null;
      }
      if (res.status === 200 && res.body && "todo" in res.body) return res.body.todo;
      setError(writeFailure(res.status, res.body));
      if (res.status === 404) onGone?.();
      return null;
    } catch {
      setError(SAVE_FAILED);
      return null;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function save() {
    if (!canSave) return;
    dictation.cancel();
    if (!initial) {
      const saved = await send({
        action: "add",
        title: cleanTitle,
        dueDate,
        ...(chip?.target ? { target: chip.target } : {}),
      });
      if (saved) onDone(saved);
      return;
    }
    const patch: { title?: string; dueDate?: string | null; target?: TodoTarget | null } = {};
    if (cleanTitle !== initial.title) patch.title = cleanTitle;
    if (dueDate !== initial.dueDate) patch.dueDate = dueDate;
    if (touched) patch.target = chip?.target ?? null;
    if (Object.keys(patch).length === 0) return onDone(null);
    const saved = await send({ action: "edit", id: initial.id, ...patch });
    if (saved) onDone(saved);
  }

  async function drop() {
    if (!initial) return;
    const dropped = await send({ action: "drop", id: initial.id });
    if (dropped) (onDropped ?? onDone)(dropped);
  }

  const heard = dictation.listening;
  return (
    <div className="flex flex-col gap-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <div className={card}>
        <label htmlFor={`${ids}-what`} className={fieldLabel}>
          What
        </label>
        <div className="flex items-start gap-1 pr-2">
          <textarea
            id={`${ids}-what`}
            ref={titleRef}
            rows={2}
            maxLength={MAX_TITLE}
            value={title}
            autoFocus={!initial}
            onChange={(e) => {
              // Typing takes over from speaking, so the next words heard cannot overwrite the edit.
              dictation.cancel();
              setTitle(e.target.value);
            }}
            className={`${fieldInput} resize-none`}
          />
          <button
            type="button"
            aria-label={heard ? "Stop listening" : "Speak the to-do"}
            aria-pressed={heard}
            onClick={() => {
              if (heard) return dictation.stop();
              spokenBaseRef.current = title;
              if (dictation.start()) return setSpeakHint(false);
              setSpeakHint(true);
              titleRef.current?.focus();
            }}
            className={`mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${
              heard ? "bg-red-600 text-white active:bg-red-700" : "text-[#0E7FA6] active:bg-neutral-100 dark:text-[#6AE6FF] dark:active:bg-white/10"
            }`}
          >
            <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
            </svg>
          </button>
        </div>
      </div>
      {heard ? (
        <p role="status" className="px-1 text-[15px] font-medium text-red-600 dark:text-red-400">
          Listening... Tap the microphone to stop.
        </p>
      ) : dictation.error ? (
        <p role="alert" className="px-1 text-[15px] font-medium text-red-600 dark:text-red-400">
          {dictation.error === "denied" ? MIC_DENIED : MIC_FAILED}
        </p>
      ) : speakHint ? (
        <p className="px-1 text-[15px] text-neutral-600 dark:text-neutral-300">{KEYBOARD_HINT}</p>
      ) : null}

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
              onClick={() => setChoice(c.key)}
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
            <input id={`${ids}-date`} type="date" value={picked} onChange={(e) => setPicked(e.target.value)} className={fieldInput} />
          </div>
        ) : null}
      </div>

      <div className={card}>
        {chip ? (
          <>
            <span className={fieldLabel}>Who (optional)</span>
            <div className="flex items-center justify-between gap-2 px-4 py-1">
              <span className="min-w-0 break-words text-[17px] text-neutral-900 dark:text-white">{chip.name}</span>
              <button
                type="button"
                aria-label={`Remove ${chip.name}`}
                onClick={() => {
                  setChip(null);
                  setTouched(true);
                }}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-xl text-neutral-500 active:bg-neutral-100 dark:text-neutral-400 dark:active:bg-white/10"
              >
                ×
              </button>
            </div>
          </>
        ) : (
          <>
            <label htmlFor={`${ids}-who`} className={fieldLabel}>
              Who (optional)
            </label>
            <input
              id={`${ids}-who`}
              type="text"
              inputMode="search"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className={fieldInput}
            />
          </>
        )}
      </div>
      {!chip && searchFailed ? <p className="px-1 text-[15px] text-red-700 dark:text-red-300">{SEARCH_FAILED}</p> : null}
      {!chip && results.length > 0 ? (
        <ul className={`${card} divide-y divide-black/5 overflow-hidden dark:divide-white/10`}>
          {results.map(({ hit, target }) => (
            <li key={`${hit.kind}:${hit.personId ?? hit.orgId ?? hit.member?.memberId ?? hit.name}`}>
              <button
                type="button"
                onClick={() => {
                  setChip({ name: hit.name, target });
                  setTouched(true);
                  setQuery("");
                  setResults([]);
                }}
                className="flex min-h-[48px] w-full flex-col justify-center px-4 py-2 text-left active:bg-neutral-100 dark:active:bg-white/10"
              >
                <span className="break-words text-[17px] font-semibold text-neutral-900 dark:text-white">{hit.name}</span>
                {hit.kind === "company" ? (
                  <span className="text-[14px] text-neutral-500 dark:text-neutral-400">Company</span>
                ) : hit.company ? (
                  <span className="break-words text-[14px] text-neutral-500 dark:text-neutral-400">{hit.company}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {error ? (
        <p role="alert" className="px-1 text-[15px] font-medium text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        <button type="button" className={primaryButton} disabled={!canSave} onClick={() => void save()}>
          Save
        </button>
        {initial?.contact && onPrepare ? (
          <button type="button" className={secondaryButton} disabled={busy} onClick={() => onPrepare(initial)}>
            Prepare me
          </button>
        ) : null}
        <button type="button" className={secondaryButton} disabled={busy} onClick={() => onDone(null)}>
          Cancel
        </button>
        {initial ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void drop()}
            className="min-h-[44px] w-full rounded-xl px-4 text-[16px] font-medium text-red-700 active:bg-red-50 disabled:opacity-50 dark:text-red-300 dark:active:bg-white/10"
          >
            Drop
          </button>
        ) : null}
      </div>
    </div>
  );
}
