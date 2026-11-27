"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { SiftHit } from "@/lib/monsoon/sift";
import { searchContacts, todoAction, type EstateInfo, type Todo, type TodoActionBody, type TodoTarget } from "./api";
import DictatedField, { type DictatedHandle } from "./DictatedField";
import DueDatePicker from "./DueDatePicker";
import { addDays, dueFromChoice, localToday, type DateChoice } from "./todoDates";
import { GONE, SAVE_FAILED, writeFailure } from "./todoWrites";
import { card, fieldInput, fieldLabel, primaryButton, secondaryButton } from "./styles";
import { useAskPage } from "./askPage";

const SEARCH_FAILED = "Could not search. Check signal.";
const DEBOUNCE_MS = 250;
const MAX_TITLE = 300;

type Choice = DateChoice;

type Chip = { name: string; target?: TodoTarget };

/**
 * What a Contacts search result can be tied to: a person by id, a company by its pipeline entry.
 * A hit with no pipeline entry (its own or its company's) is left out: a to-do is filed under one.
 */
function targetOfHit(hit: SiftHit): TodoTarget | null {
  if (!hit.member) return null;
  if (hit.kind === "person") return hit.personId ? { personId: hit.personId } : null;
  return { memberId: hit.member.memberId };
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
  // Save and Drop write: they wait while Ask is busy (the page stays live under Ask).
  const { askBusy } = useAskPage();
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
  const whatRef = useRef<DictatedHandle | null>(null);
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;

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

  const dueDate = dueFromChoice(choice, picked, today);
  const cleanTitle = title.trim();
  const canSave = cleanTitle !== "" && !busy && !askBusy && (choice !== "pick" || picked !== "");

  /** Sends one write; returns the to-do on success, null after showing why not. */
  async function send(body: TodoActionBody): Promise<Todo | null> {
    if (busyRef.current || askBusy) return null;
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
    whatRef.current?.cancel();
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

  return (
    <div className="flex flex-col gap-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <DictatedField
        label="What"
        value={title}
        max={MAX_TITLE}
        onChange={setTitle}
        autoFocus={!initial}
        speakLabel="Speak the to-do"
        stopLabel="Stop listening"
        handleRef={whatRef}
      />

      <DueDatePicker choice={choice} picked={picked} onChoice={setChoice} onPicked={setPicked} />

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
          <button type="button" className={secondaryButton} disabled={busy || askBusy} onClick={() => onPrepare(initial)}>
            Prepare me
          </button>
        ) : null}
        <button type="button" className={secondaryButton} disabled={busy} onClick={() => onDone(null)}>
          Cancel
        </button>
        {initial ? (
          <button
            type="button"
            disabled={busy || askBusy}
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
