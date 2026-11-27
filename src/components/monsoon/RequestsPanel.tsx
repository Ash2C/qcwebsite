"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { actOnRequest, loadRequests, type RequestAction, type SignupRequest, type TrialKeyHealth } from "./api";
import { formatWhen } from "./ClaudeKeyPanel";
import MonsoonLoader from "./MonsoonLoader";
import { card, secondaryButton } from "./styles";
import { useAskPage, useReportBusy } from "./askPage";

const LOAD_FAILURE = "Could not load. Check signal.";
const FAILED = "Could not finish. Try again.";
const BUSY_ELSEWHERE = "Already being set up. Check again in a moment.";
const SETTING_UP = "Setting up their CRM...";
const SIGNUPS_OFF = "New sign-ups are off until the shared database is set.";
const DECLINE = "Decline this request?";
// The free trial's key, when it is not simply working. Fixed lines: nothing the server sent is shown.
const TRIAL_KEY_WARNING: Partial<Record<TrialKeyHealth, string>> = {
  key_rejected: "The free trial key was refused. New clients have no AI until it is replaced.",
  no_credit: "The free trial key is out of credit. Trial clients have no AI until credit is added.",
};
const TRIAL_KEY_UNSET = "No free trial key is set. New clients start without AI.";

const sectionTitle = "px-1 text-[13px] font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-300";
const quiet = "px-1 text-[14px] leading-snug text-neutral-600 dark:text-neutral-400";
const bad = "px-1 text-[15px] font-medium text-red-600 dark:text-red-400";
const rows = `${card} divide-y divide-neutral-200 overflow-hidden dark:divide-white/10`;
const approveButton =
  "min-h-[46px] flex-1 rounded-xl bg-[#0E7FA6] px-4 text-[16px] font-semibold text-white active:bg-[#0D6A8F] disabled:bg-neutral-300 disabled:text-neutral-500 dark:bg-[#6AE6FF] dark:text-[#04121A] dark:active:bg-[#3FB8D4] dark:disabled:bg-neutral-700 dark:disabled:text-neutral-500";
const plainButton =
  "min-h-[46px] flex-1 rounded-xl bg-neutral-100 px-4 text-[16px] font-medium text-[#0E7FA6] active:bg-neutral-200 disabled:opacity-50 dark:bg-white/10 dark:text-[#6AE6FF] dark:active:bg-white/20";

type Loaded = { requests: SignupRequest[]; configured: boolean; trialKey: TrialKeyHealth | null };
const TRIAL_KEY_STATES: readonly unknown[] = ["unset", "ok", "key_rejected", "no_credit"];

/** Who the request is from, and when it was made. Text only: nothing here is a link. */
function Who({ request }: { request: SignupRequest }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="break-words text-[17px] font-medium">{request.name}</span>
      <span className="break-all text-[15px] text-neutral-600 dark:text-neutral-400">{request.email}</span>
      <span className="text-[13px] text-neutral-500 dark:text-neutral-400">{formatWhen(request.createdAt)}</span>
    </div>
  );
}

/**
 * Vincent's Requests screen: who has asked to join, with Approve and Decline, then who was approved
 * and who was declined (those can be re-opened). The list is read again after every action, so what
 * is shown is always what the server holds. The route answers only the approver.
 */
export default function RequestsPanel({
  onBack,
  onUnauthorized,
  onWaiting,
}: {
  onBack: () => void;
  onUnauthorized: () => void;
  /** Told how many are waiting whenever the list is read, so the entry on "Your page" agrees. */
  onWaiting?: (count: number) => void;
}) {
  const [data, setData] = useState<Loaded | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // The one action in flight, if any: every button is off while there is one.
  const [busy, setBusy] = useState<RequestAction | null>(null);
  // One write at a time with Ask: the actions wait while Ask is busy, and one in flight holds Ask.
  const { askBusy } = useAskPage();
  useReportBusy(busy !== null);
  const [error, setError] = useState<string | null>(null);

  // The latest props, for the moment a request returns.
  const calls = useRef({ onUnauthorized, onWaiting });
  calls.current = { onUnauthorized, onWaiting };
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

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const res = await loadRequests();
      if (!alive.current) return;
      if (res.status === 401) return calls.current.onUnauthorized();
      if (res.status === 200 && res.body && "requests" in res.body && Array.isArray(res.body.requests)) {
        const trialKey = TRIAL_KEY_STATES.includes(res.body.trialKey) ? (res.body.trialKey as TrialKeyHealth) : null;
        setData({ requests: res.body.requests, configured: res.body.configured === true, trialKey });
        calls.current.onWaiting?.(res.body.requests.filter((r) => r.status === "pending").length);
        return;
      }
    } catch {
      if (!alive.current) return;
      // network error: the retry line below
    }
    setLoadFailed(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(id: string, action: RequestAction) {
    if (inFlight.current || askBusy) return;
    inFlight.current = true;
    setBusy(action);
    setError(null);
    try {
      let status: number | null = null;
      try {
        status = (await actOnRequest(id, action)).status;
      } catch {
        // network error or a timeout: the same line as any other failure
      }
      if (!alive.current) return;
      if (status === 401) return calls.current.onUnauthorized();
      if (status !== 200) {
        // Fixed lines only; nothing the server sent is shown. 409 on an approval means another
        // approval of the same request is running (a second phone, a double tap that got through).
        setError(action === "approve" && status === 409 ? BUSY_ELSEWHERE : FAILED);
      }
      // Whatever happened, show what the server holds now.
      await load();
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  }

  function decline(id: string) {
    if (inFlight.current || !window.confirm(DECLINE)) return;
    void run(id, "decline");
  }

  const off = busy !== null;
  // Approve, Decline and Reopen write; Back and Retry do not.
  const writesOff = off || askBusy;
  const waiting = data?.requests.filter((r) => r.status === "pending") ?? [];
  const approved = data?.requests.filter((r) => r.status === "approved") ?? [];
  const declined = data?.requests.filter((r) => r.status === "declined") ?? [];

  return (
    <section aria-labelledby="requests-title" className="flex flex-col gap-4">
      <button
        type="button"
        onClick={onBack}
        disabled={off}
        className="flex min-h-[44px] items-center gap-1.5 self-start px-1 text-[16px] font-medium text-[#0E7FA6] disabled:opacity-50 dark:text-[#6AE6FF]"
      >
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 5l-7 7 7 7" />
        </svg>
        Back
      </button>
      <h2 id="requests-title" className="px-1 text-[26px] font-semibold tracking-tight">
        Requests
      </h2>

      {!data && !loadFailed && (
        <div role="status" className="flex justify-center py-8">
          <MonsoonLoader variant="blink" className="h-10 w-10" />
          <span className="sr-only">Loading…</span>
        </div>
      )}
      {loadFailed && (
        <div className="flex flex-col gap-3">
          <p role="alert" className={bad}>
            {LOAD_FAILURE}
          </p>
          <button type="button" className={secondaryButton} disabled={off} onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}

      {data && (
        <>
          {!data.configured && (
            <p role="status" className="rounded-2xl border border-amber-600/40 bg-amber-50 px-4 py-3 text-[15px] text-amber-950 dark:border-[#8A6A1F] dark:bg-[#2B2210] dark:text-[#F3E2B8]">
              {SIGNUPS_OFF}
            </p>
          )}
          {data.trialKey && TRIAL_KEY_WARNING[data.trialKey] && (
            <p role="alert" className="rounded-2xl border border-amber-600/40 bg-amber-50 px-4 py-3 text-[15px] text-amber-950 dark:border-[#8A6A1F] dark:bg-[#2B2210] dark:text-[#F3E2B8]">
              {TRIAL_KEY_WARNING[data.trialKey]}
            </p>
          )}
          {data.trialKey === "unset" && <p className={quiet}>{TRIAL_KEY_UNSET}</p>}
          {busy === "approve" && (
            <p role="status" className="px-1 text-[15px] font-medium text-neutral-800 dark:text-neutral-200">
              {SETTING_UP}
            </p>
          )}
          {error && (
            <p role="alert" className={bad}>
              {error}
            </p>
          )}

          <section aria-labelledby="requests-waiting" className="flex flex-col gap-2">
            <h3 id="requests-waiting" className={sectionTitle}>
              Waiting
            </h3>
            {waiting.length === 0 ? (
              <p className={quiet}>No requests waiting.</p>
            ) : (
              <ul className={rows}>
                {waiting.map((r) => (
                  <li key={r.id} className="flex flex-col gap-3 px-4 py-3">
                    <Who request={r} />
                    <div className="flex gap-3">
                      <button
                        type="button"
                        aria-label={`Approve ${r.name}`}
                        onClick={() => void run(r.id, "approve")}
                        disabled={writesOff || !data.configured}
                        className={approveButton}
                      >
                        Approve
                      </button>
                      <button type="button" aria-label={`Decline ${r.name}`} onClick={() => decline(r.id)} disabled={writesOff} className={plainButton}>
                        Decline
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {approved.length > 0 && (
            <section aria-labelledby="requests-approved" className="flex flex-col gap-2">
              <h3 id="requests-approved" className={sectionTitle}>
                Approved
              </h3>
              <ul className={rows}>
                {approved.map((r) => (
                  <li key={r.id} className="px-4 py-3">
                    <Who request={r} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {declined.length > 0 && (
            <section aria-labelledby="requests-declined" className="flex flex-col gap-2">
              <h3 id="requests-declined" className={sectionTitle}>
                Declined
              </h3>
              <ul className={rows}>
                {declined.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <Who request={r} />
                    <button
                      type="button"
                      aria-label={`Re-open ${r.name}`}
                      onClick={() => void run(r.id, "reopen")}
                      disabled={writesOff}
                      className="min-h-[44px] shrink-0 rounded-xl bg-neutral-100 px-4 text-[16px] font-medium text-[#0E7FA6] active:bg-neutral-200 disabled:opacity-50 dark:bg-white/10 dark:text-[#6AE6FF] dark:active:bg-white/20"
                    >
                      Re-open
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </section>
  );
}
