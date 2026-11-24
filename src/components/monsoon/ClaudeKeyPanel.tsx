"use client";

import { useCallback, useEffect, useState } from "react";
import type { ClaudeKeyState } from "@/lib/monsoon/accounts/claude-key";
import { loadClaudeKey, saveClaudeKey, testClaudeKey } from "./api";
import { Mark } from "./ClaudeChip";
import type { ClaudeChipStatus } from "./claudeStatus";
import MonsoonLoader from "./MonsoonLoader";
import { card, fieldInput, fieldLabel, primaryButton, secondaryButton } from "./styles";

const LOAD_FAILURE = "Could not load. Check signal.";
const BUSY = "Claude could not be reached to test the key. Try again in a minute.";

const LOOK: Record<ClaudeChipStatus, { title: string; detail: string; tone: string; mark: "dot" | "cross" | "bang" }> = {
  ok: {
    title: "Connected",
    detail: "Claude accepted this key the last time Monsoon used it.",
    tone: "border-green-600/40 bg-green-50 text-green-900 dark:border-[#1F6B43] dark:bg-[#0F2A1C] dark:text-[#C4E9D2]",
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
    tone: "border-amber-600/40 bg-amber-50 text-amber-950 dark:border-[#8A6A1F] dark:bg-[#2B2210] dark:text-[#F3E2B8]",
    mark: "bang",
  },
};

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
  const look = key ? LOOK[key.status] : null;

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
            {key.status !== "ok" && <p className="border-t border-black/10 dark:border-white/15 pt-3 text-[14px] leading-snug">{OFF}</p>}
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
                <input
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
                  className={`${fieldInput} font-mono`}
                />
              </div>
              {saveNote && (
                <p role={saveNote.tone === "ok" ? "status" : "alert"} className={`px-1 text-[15px] font-medium ${noteColour(saveNote)}`}>
                  {saveNote.text}
                </p>
              )}
              <p id="claude-key-help" className="px-1 text-[13px] leading-snug text-neutral-600 dark:text-neutral-400">
                Create a key in the Claude Console under API keys, then paste it here. Monsoon tests it with Claude before
                saving{key.last4 === null ? "." : ", and the current key keeps working until the new one passes."}
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
