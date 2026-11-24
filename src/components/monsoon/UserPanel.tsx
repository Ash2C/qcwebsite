"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GranolaKeyState } from "@/lib/monsoon/accounts/granola-key";
import type { PageInput, UserPage } from "@/lib/monsoon/accounts/profile";
import { addUserNote, loadGranolaKey, loadUserPage, saveUserPage, type EstateInfo } from "./api";
import { shortDay } from "./ContactsPanel";
import GranolaKeyPanel, { GRANOLA_STATE } from "./GranolaKeyPanel";
import MonsoonLoader from "./MonsoonLoader";
import { card, fieldInput, fieldLabel, primaryButton, secondaryButton } from "./styles";

/**
 * What the person has typed and not yet saved. It lives in MonsoonApp, not here, so it survives the
 * passcode screen. `fields` is null until a field is touched; `note` is the add-note box.
 */
export type UserDraft = { fields: PageInput | null; note: string };
export const EMPTY_USER_DRAFT: UserDraft = { fields: null, note: "" };

const LOAD_FAILURE = "Could not load. Check signal.";
const SAVE_FAILURE = "Could not save. Check signal and try again.";
const NOTE_FAILURE = "Could not add the note. Check signal and try again.";
const DISCARD = "Discard your unsaved changes?";

type Key = keyof PageInput;
type Row = { key: Key; label: string; type: string; mode?: "tel" | "email" | "url"; auto: string; words?: boolean };

const PERSON_ROWS: Row[] = [
  { key: "name", label: "Name", type: "text", auto: "name", words: true },
  { key: "phone", label: "Phone", type: "tel", mode: "tel", auto: "tel" },
  { key: "email", label: "Email", type: "email", mode: "email", auto: "email" },
];
const WORK_ROWS: Row[] = [
  { key: "company", label: "Company", type: "text", auto: "organization", words: true },
  { key: "website", label: "Website", type: "url", mode: "url", auto: "url" },
];
const KEYS: Key[] = ["name", "phone", "email", "company", "website", "roleObjectives"];

const fromPage = (p: UserPage): PageInput => ({
  name: p.person.name,
  phone: p.person.phone,
  email: p.person.email,
  company: p.work.company,
  website: p.work.website,
  roleObjectives: p.work.roleObjectives,
});
const text = (value: string | null): string => value ?? "";
// An empty field is sent as null; the server stores it as nothing.
const orNull = (value: string | null): string | null => (text(value).trim() === "" ? null : text(value).trim());
const differs = (a: PageInput, b: PageInput): boolean => KEYS.some((k) => text(a[k]).trim() !== text(b[k]).trim());

const sectionTitle = "px-1 text-[13px] font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-300";
const quiet = "px-1 text-[14px] leading-snug text-neutral-600 dark:text-neutral-400";
const bad = "px-1 text-[15px] font-medium text-red-600 dark:text-red-400";

function notesLine(shown: number, total: number): string {
  if (total <= 0) return "No notes yet.";
  if (total > shown) return `The ${shown} newest of ${total} notes`;
  return total === 1 ? "1 note" : `${total} notes`;
}

export default function UserPanel({
  estate,
  draft,
  onDraft,
  onBack,
  onUnauthorized,
  onName,
}: {
  /** The CRM the work fields and the notes belong to. */
  estate: EstateInfo;
  draft: UserDraft;
  onDraft: (draft: UserDraft) => void;
  onBack: () => void;
  onUnauthorized: () => void;
  /** Told the name on file after a save, so the header agrees at once. */
  onName: (name: string) => void;
}) {
  const [page, setPage] = useState<UserPage | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [saveNote, setSaveNote] = useState<{ text: string; tone: "ok" | "error" } | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  // Granola: null until its state is known. While `granolaOpen`, its screen stands in for this page;
  // this component stays mounted, so the page it loaded and the draft in MonsoonApp are untouched.
  const [granola, setGranola] = useState<GranolaKeyState["status"] | null>(null);
  const [granolaOpen, setGranolaOpen] = useState(false);
  const unauthorized = useCallback(() => calls.current.onUnauthorized(), []);

  // The latest props, for the moment a request returns: the parent re-renders while it is away.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const calls = useRef({ onDraft, onUnauthorized, onName });
  calls.current = { onDraft, onUnauthorized, onName };
  // False once this screen is gone (the passcode screen replaced it): a late reply then changes
  // nothing, so one person's save can never rename the next person to sign in.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const loadNo = useRef(0);

  const estateKey = estate.key;
  const load = useCallback(async () => {
    const no = ++loadNo.current;
    setLoadFailed(false);
    try {
      const res = await loadUserPage(estateKey);
      if (!alive.current || no !== loadNo.current) return;
      if (res.status === 401) return calls.current.onUnauthorized();
      if (res.status === 200 && "page" in res.body) return setPage(res.body.page);
    } catch {
      if (!alive.current || no !== loadNo.current) return;
      // network error: the retry line below
    }
    setLoadFailed(true);
  }, [estateKey]);

  useEffect(() => {
    void load();
  }, [load]);

  // The Granola row's state. A failure of any kind leaves it unknown and the page as it is.
  useEffect(() => {
    void (async () => {
      try {
        const res = await loadGranolaKey();
        if (alive.current && res.status === 200 && res.body && "key" in res.body) setGranola(res.body.key.status);
      } catch {
        // unknown: the row says "Granola" alone
      }
    })();
  }, []);

  const onFile = page ? fromPage(page) : null;
  const values = onFile ? (draft.fields ?? onFile) : null;
  const changed = onFile !== null && draft.fields !== null && differs(draft.fields, onFile);
  const unsaved = changed || draft.note.trim() !== "";

  function edit(key: Key, value: string) {
    if (!onFile || saving) return;
    setSaveNote(null);
    onDraft({ ...draft, fields: { ...(draft.fields ?? onFile), [key]: value } });
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving || !values || !changed) return;
    setSaving(true);
    setSaveNote(null);
    const input: PageInput = {
      name: text(values.name).trim(),
      phone: orNull(values.phone),
      email: orNull(values.email),
      company: orNull(values.company),
      website: orNull(values.website),
      roleObjectives: orNull(values.roleObjectives),
    };
    try {
      const res = await saveUserPage(estateKey, input);
      if (!alive.current) return;
      if (res.status === 401) calls.current.onUnauthorized();
      else if (res.status === 200 && "page" in res.body) {
        setPage(res.body.page);
        calls.current.onDraft({ fields: null, note: draftRef.current.note });
        calls.current.onName(res.body.page.person.name);
        setSaveNote({ text: "Saved.", tone: "ok" });
      } else if (res.status === 400 && res.body && "error" in res.body && res.body.error) {
        // The server's own words: they say which field and why, and hold nothing private.
        setSaveNote({ text: res.body.error, tone: "error" });
      } else setSaveNote({ text: SAVE_FAILURE, tone: "error" });
    } catch {
      if (alive.current) setSaveNote({ text: SAVE_FAILURE, tone: "error" });
    } finally {
      if (alive.current) setSaving(false);
    }
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const body = draft.note.trim();
    if (adding || !page || body === "") return;
    setAdding(true);
    setNoteError(null);
    try {
      const res = await addUserNote(estateKey, body);
      if (!alive.current) return;
      if (res.status === 401) calls.current.onUnauthorized();
      else if (res.status === 200 && "page" in res.body) {
        // The whole page comes back; unsaved field edits stay on top of it.
        setPage(res.body.page);
        calls.current.onDraft({ fields: draftRef.current.fields, note: "" });
      } else if (res.status === 400 && res.body && "error" in res.body && res.body.error) setNoteError(res.body.error);
      else setNoteError(NOTE_FAILURE);
    } catch {
      if (alive.current) setNoteError(NOTE_FAILURE);
    } finally {
      if (alive.current) setAdding(false);
    }
  }

  function back() {
    if (unsaved && !window.confirm(DISCARD)) return;
    if (draft.fields !== null || draft.note !== "") onDraft(EMPTY_USER_DRAFT);
    onBack();
  }

  const row = (r: Row) => (
    <div key={r.key}>
      <label htmlFor={`u-${r.key}`} className={fieldLabel}>
        {r.label}
      </label>
      <input
        id={`u-${r.key}`}
        type={r.type}
        inputMode={r.mode}
        autoComplete={r.auto}
        autoCapitalize={r.words ? "words" : "off"}
        autoCorrect="off"
        spellCheck={false}
        value={text(values?.[r.key] ?? null)}
        readOnly={saving}
        onChange={(e) => edit(r.key, e.target.value)}
        className={fieldInput}
      />
    </div>
  );

  if (granolaOpen) {
    return <GranolaKeyPanel onBack={() => setGranolaOpen(false)} onUnauthorized={unauthorized} onStatus={setGranola} />;
  }

  return (
    <section aria-labelledby="user-page-title" className="flex flex-col gap-4">
      <button
        type="button"
        onClick={back}
        disabled={saving || adding}
        className="flex min-h-[44px] items-center gap-1.5 self-start px-1 text-[16px] font-medium text-[#0E7FA6] disabled:opacity-50 dark:text-[#6AE6FF]"
      >
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 5l-7 7 7 7" />
        </svg>
        Back
      </button>
      <div className="flex flex-col gap-1.5">
        <h2 id="user-page-title" className="px-1 text-[26px] font-semibold tracking-tight">
          Your page
        </h2>
        <p className={quiet}>Monsoon&apos;s assistant reads this page to make its answers fit you.</p>
      </div>

      {!page && !loadFailed && (
        <div role="status" className="flex justify-center py-8">
          <MonsoonLoader variant="blink" className="h-10 w-10" />
          <span className="sr-only">Loading…</span>
        </div>
      )}
      {!page && loadFailed && (
        <div className="flex flex-col gap-3">
          <p role="alert" className={bad}>
            {LOAD_FAILURE}
          </p>
          <button type="button" className={secondaryButton} onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {page && values && (
        <>
          {/* The browser's own field checks are off: the server says what is wrong, in one voice. */}
          <form noValidate onSubmit={save} className="flex flex-col gap-4">
            <section aria-labelledby="user-you" className="flex flex-col gap-2">
              <h3 id="user-you" className={sectionTitle}>
                You
              </h3>
              <div className={`${card} divide-y divide-neutral-200 overflow-hidden dark:divide-white/10`}>{PERSON_ROWS.map(row)}</div>
            </section>

            <section aria-labelledby="user-work" className="flex flex-col gap-2">
              <h3 id="user-work" className={sectionTitle}>
                Your work in {estate.label}
              </h3>
              <div className={`${card} divide-y divide-neutral-200 overflow-hidden dark:divide-white/10`}>
                {WORK_ROWS.map(row)}
                <div>
                  <label htmlFor="u-roleObjectives" className={fieldLabel}>
                    Role and objectives
                  </label>
                  <textarea
                    id="u-roleObjectives"
                    rows={6}
                    value={text(values.roleObjectives)}
                    readOnly={saving}
                    onChange={(e) => edit("roleObjectives", e.target.value)}
                    className={`${fieldInput} resize-none overflow-y-auto`}
                  />
                </div>
              </div>
            </section>

            {saveNote && (
              <p
                role={saveNote.tone === "ok" ? "status" : "alert"}
                className={saveNote.tone === "ok" ? "px-1 text-[15px] font-medium text-green-700 dark:text-green-400" : bad}
              >
                {saveNote.text}
              </p>
            )}
            <button type="submit" disabled={saving || !changed} className={primaryButton}>
              {saving ? "Saving…" : "Save"}
            </button>
          </form>

          <section aria-labelledby="user-notes" className="flex flex-col gap-2">
            <h3 id="user-notes" className={sectionTitle}>
              Notes about you
            </h3>
            <form onSubmit={add} className={`${card} overflow-hidden`}>
              <label htmlFor="u-note" className={fieldLabel}>
                New note
              </label>
              <textarea
                id="u-note"
                rows={3}
                value={draft.note}
                readOnly={adding}
                onChange={(e) => {
                  setNoteError(null);
                  onDraft({ ...draft, note: e.target.value });
                }}
                className={`${fieldInput} resize-none overflow-y-auto`}
              />
              <div className="p-3">
                <button type="submit" disabled={adding || draft.note.trim() === ""} className={secondaryButton}>
                  {adding ? "Adding…" : "Add"}
                </button>
              </div>
            </form>
            {noteError && (
              <p role="alert" className={bad}>
                {noteError}
              </p>
            )}
            <p className={quiet}>{notesLine(page.notes.length, page.notesTotal)}</p>
            {page.notes.length > 0 && (
              <ul aria-label="Your notes" className={`${card} divide-y divide-neutral-200 overflow-hidden dark:divide-white/10`}>
                {page.notes.map((n) => (
                  <li key={n.id} className="flex flex-col gap-1 px-4 py-3">
                    <span className="text-[13px] text-neutral-500 dark:text-neutral-400">{shortDay(n.at)}</span>
                    <span className="whitespace-pre-wrap break-words text-[16px] leading-snug">{n.body}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="user-connections" className="flex flex-col gap-2">
            <h3 id="user-connections" className={sectionTitle}>
              Connections
            </h3>
            <div className={`${card} overflow-hidden`}>
              <button
                type="button"
                aria-label={granola ? `Granola, ${GRANOLA_STATE[granola]}` : "Granola"}
                onClick={() => setGranolaOpen(true)}
                disabled={saving || adding}
                className="flex min-h-[52px] w-full items-center justify-between gap-3 px-4 py-3 text-left text-[17px] active:bg-neutral-100 disabled:opacity-50 dark:active:bg-white/10"
              >
                <span className="font-medium">Granola</span>
                <span className="flex items-center gap-2 text-[15px] text-neutral-600 dark:text-neutral-400">
                  {granola ? GRANOLA_STATE[granola] : ""}
                  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 5l7 7-7 7" />
                  </svg>
                </span>
              </button>
            </div>
          </section>
        </>
      )}
    </section>
  );
}
