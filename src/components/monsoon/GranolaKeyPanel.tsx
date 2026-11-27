"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GranolaKeyState } from "@/lib/monsoon/accounts/granola-key";
import { disconnectGranolaKey, loadGranolaKey, saveGranolaKey, testGranolaKey } from "./api";
import { Mark } from "./ClaudeChip";
import { formatWhen } from "./ClaudeKeyPanel";
import MonsoonLoader from "./MonsoonLoader";
import { card, fieldInput, fieldLabel, primaryButton, secondaryButton } from "./styles";
import { useAskPage, useReportBusy } from "./askPage";

type Status = GranolaKeyState["status"];

const LOAD_FAILURE = "Could not load. Check signal.";
const UNREACHABLE = "Could not reach Granola. Try again.";
const DISCONNECT_FAILURE = "Could not disconnect. Check signal and try again.";
const DISCONNECT = "Disconnect Granola? Ask will stop using your meetings.";

/** The state in two or three words, as the row on "Your page" and this screen both say it. */
export const GRANOLA_STATE: Record<Status, string> = {
  missing: "Not connected",
  ok: "Connected",
  key_rejected: "Key refused",
  no_access: "No access",
};

const LOOK: Record<Status, { detail: string; tone: string; mark: "dot" | "cross" | "bang" }> = {
  // Granola is optional, so having no key is plain, not an error.
  missing: {
    detail: "Connect Granola so Ask can use your meeting notes.",
    tone: "border-neutral-300 bg-white text-neutral-900 dark:border-white/15 dark:bg-[#0E1822] dark:text-white",
    mark: "dot",
  },
  ok: {
    detail: "Ask can search your Granola meetings.",
    tone: "border-green-600/40 bg-green-50 text-green-900 dark:border-[#1F6B43] dark:bg-[#0F2A1C] dark:text-[#C4E9D2]",
    mark: "dot",
  },
  key_rejected: {
    detail: "Granola refused this key. It may have been revoked. Paste a new one.",
    tone: "border-red-600/40 bg-red-50 text-red-900 dark:border-[#8A2F2F] dark:bg-[#2B1414] dark:text-[#F3CFCF]",
    mark: "cross",
  },
  no_access: {
    detail: "Granola accepted the key but will not give access. Check your Granola plan and the key's permissions.",
    tone: "border-amber-600/40 bg-amber-50 text-amber-950 dark:border-[#8A6A1F] dark:bg-[#2B2210] dark:text-[#F3E2B8]",
    mark: "bang",
  },
};

// Fixed lines only: nothing the person typed, and nothing the server sent, is ever shown.
const SAVE_ERRORS: Record<string, string> = {
  granola_key_rejected: "Granola refused that key. Check you copied all of it.",
  granola_no_access: "Granola accepted the key but will not give access. Check your plan and the key's permissions.",
};

const STEPS = [
  "Open the Granola desktop app.",
  "Go to Settings, then Connectors, then API keys.",
  "Create a new key with access to your personal notes and to transcripts.",
  "Copy it and paste it here.",
];

const quiet = "px-1 text-[13px] leading-snug text-neutral-600 dark:text-neutral-400";
const bad = "px-1 text-[15px] font-medium text-red-600 dark:text-red-400";

type Reply = Awaited<ReturnType<typeof loadGranolaKey>>;
const keyOf = (res: Reply): GranolaKeyState | null => (res.status === 200 && res.body && "key" in res.body ? res.body.key : null);

export default function GranolaKeyPanel({
  onBack,
  onUnauthorized,
  onStatus,
}: {
  onBack: () => void;
  onUnauthorized: () => void;
  /** Told the key's status whenever this screen learns it, so the row on "Your page" agrees. */
  onStatus?: (status: Status) => void;
}) {
  const [key, setKey] = useState<GranolaKeyState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // The one request in flight, if any: every button is off while there is one.
  const [busy, setBusy] = useState<"save" | "test" | "disconnect" | null>(null);
  // One write at a time with Ask: the requests wait while Ask is busy, and one in flight holds Ask.
  const { askBusy } = useAskPage();
  useReportBusy(busy !== null);
  const [draft, setDraft] = useState("");
  // One line under the status card (test again, disconnect) and one under the paste box (save).
  const [keyError, setKeyError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // The latest props, for the moment a request returns.
  const calls = useRef({ onUnauthorized, onStatus });
  calls.current = { onUnauthorized, onStatus };
  // False once this screen is gone: a late reply then changes nothing and calls nobody.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // The state does not ride on a render, so a second tap in the same tick is refused too.
  const inFlight = useRef(false);

  const show = useCallback((next: GranolaKeyState) => {
    setKey(next);
    calls.current.onStatus?.(next.status);
  }, []);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const res = await loadGranolaKey();
      if (!alive.current) return;
      if (res.status === 401) return calls.current.onUnauthorized();
      const next = keyOf(res);
      if (next) return show(next);
    } catch {
      if (!alive.current) return;
      // network error: the retry line below
    }
    setLoadFailed(true);
  }, [show]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Runs one request with every button off. `failed` is told the reply when it is not a new state. */
  async function run(what: "save" | "test" | "disconnect", call: () => Promise<Reply>, done: () => void, failed: (res: Reply | null) => void) {
    if (inFlight.current || askBusy) return;
    inFlight.current = true;
    setBusy(what);
    setKeyError(null);
    setSaveError(null);
    try {
      const res = await call();
      if (!alive.current) return;
      const next = keyOf(res);
      if (res.status === 401) calls.current.onUnauthorized();
      else if (next) {
        show(next);
        done();
      } else failed(res);
    } catch {
      if (alive.current) failed(null);
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  }

  function save(event: React.FormEvent) {
    event.preventDefault();
    const typed = draft.trim();
    if (typed === "") return;
    void run(
      "save",
      () => saveGranolaKey(typed),
      () => setDraft(""),
      (res) => {
        const code = res && res.body && "error" in res.body ? res.body.error : "";
        setSaveError(SAVE_ERRORS[code] ?? UNREACHABLE);
      },
    );
  }

  function test() {
    void run(
      "test",
      testGranolaKey,
      () => {},
      (res) => {
        // The key went away elsewhere (another device disconnected it): show what is on file now.
        if (res && res.status === 422) void load();
        else setKeyError(UNREACHABLE);
      },
    );
  }

  function disconnect() {
    if (inFlight.current || !window.confirm(DISCONNECT)) return;
    void run(
      "disconnect",
      disconnectGranolaKey,
      () => {},
      () => setKeyError(DISCONNECT_FAILURE),
    );
  }

  const look = key ? LOOK[key.status] : null;
  const outline = "min-h-[46px] flex-1 rounded-xl border border-current bg-transparent px-4 text-[16px] font-semibold disabled:opacity-50";

  return (
    <section aria-labelledby="granola-key-title" className="flex flex-col gap-4">
      <button
        type="button"
        onClick={onBack}
        disabled={busy !== null}
        className="flex min-h-[44px] items-center gap-1.5 self-start px-1 text-[16px] font-medium text-[#0E7FA6] disabled:opacity-50 dark:text-[#6AE6FF]"
      >
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 5l-7 7 7 7" />
        </svg>
        Back
      </button>
      <h2 id="granola-key-title" className="px-1 text-[26px] font-semibold tracking-tight">
        Granola
      </h2>

      {!key && !loadFailed && (
        <div role="status" className="flex justify-center py-8">
          <MonsoonLoader variant="blink" className="h-10 w-10" />
          <span className="sr-only">Loading…</span>
        </div>
      )}
      {!key && loadFailed && (
        <div className="flex flex-col gap-3">
          <p role="alert" className={bad}>
            {LOAD_FAILURE}
          </p>
          <button type="button" className={secondaryButton} onClick={() => void load()}>
            Try again
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
                  {GRANOLA_STATE[key.status]}
                </span>
                <span className="text-[14px]">{look.detail}</span>
              </div>
            </div>
            {key.last4 !== null && (
              <dl className="flex flex-col gap-1.5 border-t border-black/10 pt-3 text-[14px] dark:border-white/15">
                <div className="flex justify-between gap-3">
                  <dt>Key</dt>
                  <dd className="font-mono">grn_…{key.last4}</dd>
                </div>
                {key.setAt && (
                  <div className="flex justify-between gap-3">
                    <dt>Added</dt>
                    <dd className="text-right">{formatWhen(key.setAt)}</dd>
                  </div>
                )}
                <div className="flex justify-between gap-3">
                  <dt>Last checked</dt>
                  <dd className="text-right">{key.checkedAt ? formatWhen(key.checkedAt) : "When the key was saved"}</dd>
                </div>
              </dl>
            )}
            {key.last4 !== null && (
              <div className="flex gap-3">
                <button type="button" onClick={test} disabled={busy !== null || askBusy} className={outline}>
                  {busy === "test" ? "Testing…" : "Test again"}
                </button>
                <button type="button" onClick={disconnect} disabled={busy !== null || askBusy} className={outline}>
                  {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
                </button>
              </div>
            )}
          </div>
          {keyError && (
            <p role="alert" className={bad}>
              {keyError}
            </p>
          )}

          <form onSubmit={save} className="flex flex-col gap-3">
            <div className={card}>
              <label htmlFor="granola-key-new" className={fieldLabel}>
                Granola API key
              </label>
              <input
                id="granola-key-new"
                type="password"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="grn_…"
                value={draft}
                readOnly={busy !== null}
                onChange={(e) => setDraft(e.target.value)}
                className={`${fieldInput} font-mono`}
              />
            </div>
            {saveError && (
              <p role="alert" className={bad}>
                {saveError}
              </p>
            )}
            <button type="submit" disabled={busy !== null || askBusy || draft.trim() === ""} className={primaryButton}>
              {busy === "save" ? "Testing…" : "Test and save"}
            </button>
          </form>

          <section aria-labelledby="granola-key-how" className="flex flex-col gap-2">
            <h3 id="granola-key-how" className="px-1 text-[13px] font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-300">
              How to get a key
            </h3>
            <ol className={`${card} list-decimal space-y-1.5 py-3 pl-9 pr-4 text-[15px] leading-snug`}>
              {STEPS.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <p className={quiet}>Granola API keys need a Business or Enterprise plan.</p>
          </section>

          <p className={quiet}>
            Monsoon only reads from Granola. Meeting text is sent to Claude when Ask uses it and is not stored in Monsoon. The key is stored encrypted and never shown again.
          </p>
        </>
      )}
    </section>
  );
}
