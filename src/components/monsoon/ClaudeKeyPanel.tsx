"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ClaudeKeyState } from "@/lib/monsoon/accounts/claude-key";
import { loadClaudeKey, saveClaudeKey, testClaudeKey } from "./api";
import { Mark } from "./ClaudeChip";
import type { ClaudeChipStatus } from "./claudeStatus";
import MonsoonLoader from "./MonsoonLoader";
import { card, fieldInput, fieldLabel, primaryButton, secondaryButton } from "./styles";

const LOAD_FAILURE = "Could not load. Check signal.";
const BUSY = "Claude could not be reached to test the key. Try again in a minute.";

const CONSOLE_KEYS_URL = "https://console.anthropic.com/settings/keys";
const HOW_TO = "Tap Get a key, sign in to the Claude Console, create a key and copy it. Come back and tap Paste.";
const PASTE_FAILED = "Could not paste. Press and hold in the box, then choose Paste.";
// A key is far shorter; a clipboard holding something else is not kept whole.
const MAX_PASTE = 400;

const GREEN = "border-green-600/40 bg-green-50 text-green-900 dark:border-[#1F6B43] dark:bg-[#0F2A1C] dark:text-[#C4E9D2]";
const AMBER = "border-amber-600/40 bg-amber-50 text-amber-950 dark:border-[#8A6A1F] dark:bg-[#2B2210] dark:text-[#F3E2B8]";

type Look = { title: string; detail: string; tone: string; mark: "dot" | "cross" | "bang" };

const LOOK: Record<Exclude<ClaudeChipStatus, "trial">, Look> = {
  ok: {
    title: "Connected",
    detail: "Claude accepted this key the last time Monsoon used it.",
    tone: GREEN,
    mark: "dot",
  },
  missing: {
    title: "Not connected",
    detail: "This account has no Claude API key yet.",
    tone: "border-red-600/40 bg-red-50 text-red-900 dark:border-[#8A2F2F] dark:bg-[#2B1414] dark:text-[#F3CFCF]",
    mark: "cross",
  },
  key_rejected: {
    title: "Not connected",
    detail: "Claude did not accept the key on file. It may have expired or been revoked.",
    tone: "border-red-600/40 bg-red-50 text-red-900 dark:border-[#8A2F2F] dark:bg-[#2B1414] dark:text-[#F3CFCF]",
    mark: "cross",
  },
  no_credit: {
    title: "Out of credit",
    detail: "The key works, but its Claude account has no credit left. Add credit in the Claude Console.",
    tone: AMBER,
    mark: "bang",
  },
};

const TRIAL_PAUSED = "The free trial is paused. Add your own Claude key, or try again later.";
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** How the key's state is shown. The free trial and its end have their own words. */
function lookOf(key: ClaudeKeyState): Look {
  if (key.status === "trial") {
    if (key.paused) return { title: "Free trial", detail: TRIAL_PAUSED, tone: AMBER, mark: "bang" };
    const left = `${count(key.daysLeft ?? 0, "day", "days")} and ${count(key.usesLeft ?? 0, "AI use", "AI uses")} left.`;
    return { title: "Free trial", detail: `${left} Add your own Claude key any time to keep going after the trial.`, tone: GREEN, mark: "dot" };
  }
  if (key.status === "missing" && key.trialEnded) {
    return {
      title: "Trial ended",
      detail: "Add your own Claude key to keep the AI features. Typing and saving contacts still works.",
      tone: AMBER,
      mark: "bang",
    };
  }
  return LOOK[key.status];
}

const OFF = "Photo reading, Ask, notes tidy-up and research are off until a key works. You can still type contacts in and save them.";

/** "Today, 22:41" for a time today, otherwise "23 Nov 2026". */
export function formatWhen(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (d.toDateString() === now.toDateString()) {
    return `Today, ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
  }
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

type Note = { text: string; tone: "ok" | "error" };

export default function ClaudeKeyPanel({
  onBack,
  onUnauthorized,
  onStatus,
}: {
  onBack: () => void;
  onUnauthorized: () => void;
  /** Told the key's status whenever this screen learns it, so the chip agrees. */
  onStatus: (status: ClaudeChipStatus) => void;
}) {
  const [key, setKey] = useState<ClaudeKeyState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState("");
  const [testNote, setTestNote] = useState<Note | null>(null);
  const [saveNote, setSaveNote] = useState<Note | null>(null);
  // Whether this browser lets a page read the clipboard at all. Known only once on the device.
  const [canPaste, setCanPaste] = useState(false);
  const box = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setCanPaste(typeof navigator !== "undefined" && typeof navigator.clipboard?.readText === "function");
  }, []);

  /** Fills the box from the clipboard. The value goes nowhere else: not to a log, not onto the screen. */
  async function paste() {
    if (saving || testing) return;
    setSaveNote(null);
    let text = "";
    try {
      text = (await navigator.clipboard.readText()).trim().slice(0, MAX_PASTE);
    } catch {
      // refused by the person or the browser: the line below says how to paste by hand
    }
    if (text === "") {
      setSaveNote({ text: PASTE_FAILED, tone: "error" });
      box.current?.focus();
      return;
    }
    setDraft(text);
  }

  const show = useCallback(
    (next: ClaudeKeyState) => {
      setKey(next);
      onStatus(next.status);
    },
    [onStatus],
  );

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const res = await loadClaudeKey();
      if (res.status === 401) return onUnauthorized();
      if (res.status === 200 && "key" in res.body) return show(res.body.key);
    } catch {
      // network error: the retry line below
    }
    setLoadFailed(true);
  }, [onUnauthorized, show]);

  useEffect(() => {
    void load();
  }, [load]);

  async function test() {
    if (testing || saving) return;
    setTesting(true);
    setTestNote(null);
    try {
      const res = await testClaudeKey();
      if (res.status === 401) onUnauthorized();
      else if (res.status === 200 && "key" in res.body) show(res.body.key);
      else if (res.status === 503) setTestNote({ text: BUSY, tone: "error" });
      else setTestNote({ text: "Could not test the key. Check signal and try again.", tone: "error" });
    } catch {
      setTestNote({ text: "Could not test the key. Check signal and try again.", tone: "error" });
    } finally {
      setTesting(false);
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving || testing || draft.trim() === "") return;
    setSaving(true);
    setSaveNote(null);
    try {
      const res = await saveClaudeKey(draft.trim());
      const error = "error" in res.body ? res.body.error : "";
      if (res.status === 401) onUnauthorized();
      else if (res.status === 200 && "key" in res.body) {
        show(res.body.key);
        setDraft("");
        setTestNote(null);
        setSaveNote({ text: "Saved. Claude accepted the new key.", tone: "ok" });
      } else if (error === "claude_key_rejected") {
        setSaveNote({ text: "Claude did not accept this key. Check you copied all of it, then try again.", tone: "error" });
      } else if (error === "claude_no_credit") {
        setSaveNote({
          text: "This key's Claude account is out of credit, so it was not saved. Add credit in the Claude Console, then try again.",
          tone: "error",
        });
      } else if (res.status === 503) setSaveNote({ text: BUSY, tone: "error" });
      else if (res.status === 403) setSaveNote({ text: "Only the person named for this company can change the key.", tone: "error" });
      else setSaveNote({ text: "Could not save. Check signal and try again.", tone: "error" });
    } catch {
      setSaveNote({ text: "Could not save. Check signal and try again.", tone: "error" });
    } finally {
      setSaving(false);
    }
  }

  const noteColour = (n: Note) => (n.tone === "ok" ? "text-green-700 dark:text-green-400" : "text-red-600 dark:text-red-400");
  const look = key ? lookOf(key) : null;
  // The trial's own words already say what works; the "off" line is for a key that is missing or failing.
  const showOff = key !== null && key.status !== "ok" && key.status !== "trial" && !key.trialEnded;

  return (
    <section aria-labelledby="claude-key-title" className="flex flex-col gap-4">
      <button
        type="button"
        onClick={onBack}
        disabled={saving || testing}
        className="flex min-h-[44px] items-center gap-1.5 self-start px-1 text-[16px] font-medium text-[#0E7FA6] disabled:opacity-50 dark:text-[#6AE6FF]"
      >
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 5l-7 7 7 7" />
        </svg>
        Back
      </button>
      <h2 id="claude-key-title" className="px-1 text-[26px] font-semibold tracking-tight">
        Claude key
      </h2>

      {!key && !loadFailed && (
        <div role="status" className="flex justify-center py-8">
          <MonsoonLoader variant="blink" className="h-10 w-10" />
          <span className="sr-only">Loading…</span>
        </div>
      )}
      {loadFailed && (
        <div className="flex flex-col gap-3">
          <p role="alert" className="px-1 text-[15px] font-medium text-red-600 dark:text-red-400">
            {LOAD_FAILURE}
          </p>
          <button type="button" className={secondaryButton} onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {key && look && (
        <>
          <div className={`flex flex-col gap-3 rounded-2xl border p-4 ${look.tone}`}>
            <div className="flex items-center gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-current">
                <Mark kind={look.mark} />
              </span>
              <div className="flex flex-col">
                <span role="status" className="text-[20px] font-semibold">
                  {look.title}
                </span>
                <span className="text-[14px]">{look.detail}</span>
              </div>
            </div>
            {showOff && <p className="border-t border-black/10 dark:border-white/15 pt-3 text-[14px] leading-snug">{OFF}</p>}
            {key.last4 !== null && (
              <dl className="flex flex-col gap-1.5 border-t border-black/10 dark:border-white/15 pt-3 text-[14px]">
                <div className="flex justify-between gap-3">
                  <dt>Key</dt>
                  <dd className="font-mono">sk-ant-…{key.last4}</dd>
                </div>
                {key.setAt && (
                  <div className="flex justify-between gap-3">
                    <dt>Added</dt>
                    <dd className="text-right">
                      {formatWhen(key.setAt)}
                      {key.setBy ? ` by ${key.setBy}` : ""}
                    </dd>
                  </div>
                )}
                <div className="flex justify-between gap-3">
                  <dt>Last checked</dt>
                  <dd className="text-right">{key.checkedAt ? formatWhen(key.checkedAt) : "When the key was saved"}</dd>
                </div>
              </dl>
            )}
            {key.last4 !== null && (
              <button
                type="button"
                onClick={() => void test()}
                disabled={testing || saving}
                className="min-h-[46px] rounded-xl border border-current bg-transparent px-4 text-[16px] font-semibold disabled:opacity-50"
              >
                {testing ? "Testing…" : "Test again"}
              </button>
            )}
          </div>
          {testNote && (
            <p role="alert" className={`px-1 text-[15px] font-medium ${noteColour(testNote)}`}>
              {testNote.text}
            </p>
          )}

          {key.canChange ? (
            <form onSubmit={save} className="flex flex-col gap-3">
              <div className={card}>
                <label htmlFor="claude-key-new" className={fieldLabel}>
                  {key.last4 === null ? "Claude API key" : "New Claude API key"}
                </label>
                <div className="flex items-center gap-2 pr-2">
                  <input
                    ref={box}
                    id="claude-key-new"
                    type="password"
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="sk-ant-…"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    aria-describedby="claude-key-help"
                    className={`${fieldInput} min-w-0 flex-1 font-mono`}
                  />
                  {canPaste && (
                    <button
                      type="button"
                      onClick={() => void paste()}
                      disabled={saving || testing}
                      className="min-h-[44px] shrink-0 rounded-xl bg-neutral-100 px-4 text-[16px] font-medium text-[#0E7FA6] active:bg-neutral-200 disabled:opacity-50 dark:bg-white/10 dark:text-[#6AE6FF] dark:active:bg-white/20"
                    >
                      Paste
                    </button>
                  )}
                </div>
              </div>
              <a
                href={CONSOLE_KEYS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={`${secondaryButton} flex items-center justify-center`}
              >
                Get a key
              </a>
              {saveNote && (
                <p role={saveNote.tone === "ok" ? "status" : "alert"} className={`px-1 text-[15px] font-medium ${noteColour(saveNote)}`}>
                  {saveNote.text}
                </p>
              )}
              <p id="claude-key-help" className="px-1 text-[13px] leading-snug text-neutral-600 dark:text-neutral-400">
                {HOW_TO} Monsoon tests the key with Claude before saving
                {key.last4 === null ? "." : ", and the current key keeps working until the new one passes."}
              </p>
              <button type="submit" disabled={saving || testing || draft.trim() === ""} className={primaryButton}>
                {saving ? "Testing…" : "Test and save"}
              </button>
            </form>
          ) : (
            <p className="px-1 text-[15px] leading-snug text-neutral-700 dark:text-neutral-300">
              {key.keyPerson
                ? `Only ${key.keyPerson} can change the key.`
                : "Nobody is named to change the key yet. Ask whoever set up Monsoon for you."}
            </p>
          )}

          <p className="px-1 text-[13px] leading-snug text-neutral-600 dark:text-neutral-400">
            Monsoon stores the key encrypted and never shows it again, only its last four characters.
          </p>
        </>
      )}
    </section>
  );
}
