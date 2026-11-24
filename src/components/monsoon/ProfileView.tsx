"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Profile } from "@/lib/monsoon/contacts";
import MonsoonLoader from "./MonsoonLoader";
import { loadProfile, type EstateInfo } from "./api";
import { localDate } from "./AskPanel";
import type { ContactTarget } from "./ContactsPanel";
import { stageLabel } from "./labels";
import { card, secondaryButton } from "./styles";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "13 Nov 2026". A bare date is read as written; a timestamp is shown in the phone's local day.
export function formatDate(value: string): string {
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (plain) return `${Number(plain[3])} ${MONTHS[Number(plain[2]) - 1]} ${plain[1]}`;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function roleLabel(estate: EstateInfo, key: string): string {
  return estate.roles.find((r) => r.key === key)?.label ?? key.replace(/_/g, " ");
}

// An http(s) URL for a stored value, adding https:// when it has no scheme; null for anything else.
function webHref(value: string): string | null {
  const text = value.trim();
  if (!text || /\s/.test(text)) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^/:]+:\d+(\/|$)/.test(text);
  try {
    const url = new URL(hasScheme ? text : `https://${text}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

const linkClass = "text-[#0E7FA6] underline-offset-2 hover:underline dark:text-[#6AE6FF]";
const sectionHeading = "px-1 text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400";
const chip =
  "break-words rounded-full bg-[#0E7FA6]/10 px-3 py-1 text-sm font-semibold text-[#0E7FA6] dark:bg-[#6AE6FF]/15 dark:text-[#6AE6FF]";

const ADDRESS_BAD = /[\s@?&#<>"',;\u0000-\u001f\u007f]/;

// A mailto: href only for a plain address; null for anything that could carry extra recipients or a body.
function mailHref(value: string): string | null {
  const parts = value.split("@");
  if (parts.length !== 2 || !parts[0] || !parts[1] || ADDRESS_BAD.test(parts[0]) || ADDRESS_BAD.test(parts[1])) return null;
  return `mailto:${encodeURIComponent(parts[0])}@${encodeURIComponent(parts[1])}`;
}

export type PhoneSegment = { text: string; href: string | null };

// A phone number run: optional +, digits with spaces, dots, hyphens and brackets between them. It never
// crosses a comma, semicolon, slash, letter or line break, so lists and labels split it naturally.
const PHONE_RUN = /\+?\(?\d(?:[\d \t().-]*\d)?\)?/g;
// An extension right after a number is not dialled: it stays text beside the link.
const PHONE_EXT = /^[ \t]*(?:(?:x|ext\.?)[ \t]*|#)\d+/i;
// The trunk prefix "(0)" written right after a country code is not dialled internationally.
const TRUNK_ZERO = /^(\+\d{1,3}\)?[ \t.-]*)\(0\)/;
const isDigit = (c: string) => c >= "0" && c <= "9";
const isGap = (c: string) => c === " " || c === "\t";

// Cuts one run into the pieces that are each a number, with the text between them. A " - " and one to
// five digits closing the run, after a number of at least 10 digits, are an extension: plain text. Two numbers separated
// only by spaces, each side with at least 7 digits, are two pieces; where several gaps qualify the one
// that splits the digits most evenly wins (the later on a tie), and each half is cut again the same way.
// Every step is a single scan of its part and halves are about even, so the work stays near linear.
type Piece = { text: string; number: boolean };
function splitRun(run: string): Piece[] {
  const n = run.length;
  const pre = new Array<number>(n + 1).fill(0); // digits before each index
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + (isDigit(run[i]) ? 1 : 0);

  // The extension at the end, if any: gap, "-", gap, one to five digits and an optional ")".
  let end = n;
  let ext = "";
  let k = n;
  if (k > 0 && run[k - 1] === ")") k--;
  let m = k;
  while (m > 0 && isDigit(run[m - 1])) m--;
  if (k - m >= 1 && k - m <= 5 && m > 0 && isGap(run[m - 1])) {
    let g = m;
    while (g > 0 && isGap(run[g - 1])) g--;
    if (g > 0 && run[g - 1] === "-" && g - 1 > 0 && isGap(run[g - 2])) {
      let e = g - 1;
      while (e > 0 && isGap(run[e - 1])) e--;
      if (e > 0 && pre[e] >= 10) {
        end = e;
        ext = run.slice(e);
      }
    }
  }

  const cut = (a: number, b: number, out: Piece[]): void => {
    let best = -1;
    let bestEnd = 0;
    let bestDiff = Infinity;
    for (let i = a; i < b; i++) {
      if (!isGap(run[i])) continue;
      let j = i;
      while (j < b && isGap(run[j])) j++;
      const left = pre[i] - pre[a];
      const right = pre[b] - pre[j];
      const joined = (isDigit(run[i - 1]) || run[i - 1] === ")") && j < b && (isDigit(run[j]) || run[j] === "(");
      if (joined && left >= 7 && right >= 7 && Math.abs(left - right) <= bestDiff) {
        best = i;
        bestEnd = j;
        bestDiff = Math.abs(left - right);
      }
      i = j - 1;
    }
    if (best < 0) {
      out.push({ text: run.slice(a, b), number: true });
      return;
    }
    cut(a, best, out);
    out.push({ text: run.slice(best, bestEnd), number: false });
    cut(bestEnd, b, out);
  };

  const out: Piece[] = [];
  cut(0, end, out);
  if (ext) out.push({ text: ext, number: false });
  return out;
}

// The stored value as text and tappable numbers, in its original order and wording. A tel: href only
// ever holds an optional leading + and 7 to 15 digits; the visible text is always the stored text.
export function phoneSegments(value: string): PhoneSegment[] {
  const out: PhoneSegment[] = [];
  let at = 0;
  const push = (text: string, href: string | null) => {
    if (text) out.push({ text, href });
  };
  PHONE_RUN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PHONE_RUN.exec(value)) !== null) {
    push(value.slice(at, m.index), null);
    at = m.index + m[0].length;
    let lastLinked = false;
    for (const piece of splitRun(m[0])) {
      const dial = piece.text.replace(TRUNK_ZERO, "$1");
      const digits = dial.replace(/\D/g, "");
      const linkable = piece.number && digits.length >= 7 && digits.length <= 15;
      push(piece.text, linkable ? `tel:${piece.text.startsWith("+") ? "+" : ""}${digits}` : null);
      lastLinked = linkable;
    }
    if (lastLinked) {
      const ext = PHONE_EXT.exec(value.slice(at));
      if (ext) {
        push(ext[0], null);
        at += ext[0].length;
      }
    }
    PHONE_RUN.lastIndex = at;
  }
  push(value.slice(at), null);
  return out;
}

type Phase = "loading" | "ready" | "missing" | "failed";

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-[44px] flex-col justify-center px-4 py-2">
      <dt className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">{label}</dt>
      <dd className="break-words text-[17px] text-neutral-900 dark:text-white">{children}</dd>
    </div>
  );
}

function ExternalLink({ value }: { value: string }) {
  const href = webHref(value);
  return href ? (
    <a href={href} target="_blank" rel="noreferrer noopener" className={linkClass}>
      {value}
    </a>
  ) : (
    <>{value}</>
  );
}

/** Which chooser is open (the type bubble's or the stage bubble's) and where it is drawn: right under the bubbles. */
export type StagePick = { open: Picking; slot: HTMLElement | null; close: () => void };
type Picking = "role" | "stage" | "priority" | "next" | null;

/** "High priority", "Medium priority", "Low priority" or "No priority". */
export function priorityLabel(priority: string | null | undefined): string {
  return priority ? `${priority.charAt(0).toUpperCase()}${priority.slice(1)} priority` : "No priority";
}

export default function ProfileView({
  estate,
  target,
  onBack,
  onOpen,
  onUnauthorized,
  onLoadFailed,
  actions,
  onLoaded,
  reloadSignal,
}: {
  estate: EstateInfo;
  target: ContactTarget;
  onBack: () => void;
  onOpen: (target: ContactTarget) => void;
  onUnauthorized: () => void;
  /** Called when the profile load ends in sign-in (401), not found or a failure. */
  onLoadFailed?: () => void;
  /** Renders the profile's actions; `setBusy(true)` locks this view's own navigation until it is released. */
  actions?: (profile: Profile, reload: () => void, setBusy: (busy: boolean) => void, stagePick: StagePick) => ReactNode;
  /** The profile now on screen, or null while there is none (loading, missing, failed, closed). */
  onLoaded?: (profile: Profile | null) => void;
  /** A change to this number re-reads the profile. */
  reloadSignal?: number;
}) {
  // The stage bubble under the name opens the stage chooser right there. The chooser itself is drawn
  // by the actions (they own the change), into `stageSlot`.
  const [picking, setPicking] = useState<Picking>(null);
  const stageOpen = picking === "stage";
  const [stageSlot, setStageSlot] = useState<HTMLDivElement | null>(null);
  const closeStage = useCallback(() => setPicking(null), []);
  const [actionBusy, setActionBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>("loading");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;
  const loadFailedRef = useRef(onLoadFailed);
  loadFailedRef.current = onLoadFailed;
  const { memberId, personId, orgId } = target;

  useEffect(() => {
    let live = true; // a response that arrives after the target changed or the view closed is dropped
    loadProfile(estate.key, { memberId, personId, orgId }, localDate()).then(
      (res) => {
        if (!live) return;
        if (res.status === 401) {
          loadFailedRef.current?.();
          return unauthorizedRef.current();
        }
        if (res.status === 404) {
          loadFailedRef.current?.();
          setProfile(null);
          return setPhase("missing");
        }
        if (res.status === 200 && "profile" in res.body) {
          setProfile(res.body.profile);
          return setPhase("ready");
        }
        loadFailedRef.current?.();
        setPhase("failed");
      },
      () => {
        if (!live) return;
        loadFailedRef.current?.();
        setPhase("failed");
      },
    );
    return () => {
      live = false;
    };
  }, [estate.key, memberId, personId, orgId, tick, reloadSignal]);

  const loadedRef = useRef(onLoaded);
  loadedRef.current = onLoaded;
  // Whatever profile is on screen, including one kept after a failed refresh.
  const shownProfile = phase === "missing" ? null : profile;
  useEffect(() => {
    loadedRef.current?.(shownProfile);
  }, [shownProfile]);
  useEffect(() => () => loadedRef.current?.(null), []);

  const back = (
    <button
      type="button"
      onClick={onBack}
      disabled={actionBusy}
      className="-ml-2 min-h-[44px] self-start px-2 text-[17px] font-medium text-[#0E7FA6] disabled:opacity-50 dark:text-[#6AE6FF]"
    >
      ‹ Contacts
    </button>
  );

  if (phase === "loading" && !profile) {
    return (
      <div className="flex flex-col gap-3">
        {back}
        <p className="flex items-center gap-2 px-1 text-neutral-500 dark:text-neutral-400">
          <MonsoonLoader className="h-7 w-7" />
          Loading…
        </p>
      </div>
    );
  }
  if (phase === "missing") {
    return (
      <div className="flex flex-col gap-3">
        {back}
        <p className="px-1 text-neutral-700 dark:text-neutral-300">That contact is no longer on file.</p>
      </div>
    );
  }
  if (phase === "failed" && !profile) {
    return (
      <div className="flex flex-col gap-3">
        {back}
        <p role="alert" className="px-1 text-red-700 dark:text-red-300">
          Could not load this contact. Check signal.
        </p>
        <button type="button" onClick={reload} className={secondaryButton}>
          Retry
        </button>
      </div>
    );
  }
  if (!profile) return null;

  const p = profile;
  const refreshFailed = phase === "failed";
  const member = p.member;
  const companyName = p.company ?? p.timelineOf;
  const subtitle = p.kind === "company" ? null : p.title || p.company;
  const notes = [member?.notes, p.notes].filter((n): n is string => !!n && n.trim() !== "");

  return (
    <div className="flex flex-col gap-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      {back}

      {refreshFailed ? (
        <div className="flex items-center justify-between gap-3 px-1">
          <p role="alert" className="text-red-700 dark:text-red-300">
            Could not refresh. Check signal.
          </p>
          <button type="button" onClick={reload} className="min-h-[44px] px-3 font-medium text-[#0E7FA6] dark:text-[#6AE6FF]">
            Retry
          </button>
        </div>
      ) : null}

      <header className="flex flex-col gap-2 px-1">
        <h2 className="break-words text-[28px] font-bold leading-tight text-neutral-900 dark:text-white">{p.name}</h2>
        {p.kind === "company" ? (
          <p className="text-[17px] text-neutral-600 dark:text-neutral-300">Company</p>
        ) : subtitle ? (
          <p className="break-words text-[17px] text-neutral-600 dark:text-neutral-300">
            {p.title ? `${p.title}${p.company ? " · " : ""}` : null}
            {p.company && p.orgId ? (
              <button
                type="button"
                onClick={() => onOpen({ orgId: p.orgId! })}
                disabled={actionBusy}
                className={`${linkClass} min-h-[44px] align-baseline font-medium`}
              >
                {p.company}
              </button>
            ) : (
              p.company
            )}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {member && p.memberOf === "self" ? (
            <>
              {actions && estate.roles.length > 1 ? (
                <button
                  type="button"
                  aria-expanded={picking === "role"}
                  aria-label={`Type: ${roleLabel(estate, member.role)}. Change type`}
                  disabled={actionBusy}
                  onClick={() => setPicking((o) => (o === "role" ? null : "role"))}
                  className={`${chip} flex min-h-[36px] items-center gap-1 ring-1 ring-[#0E7FA6]/50 disabled:opacity-50 dark:ring-[#6AE6FF]/50`}
                >
                  {roleLabel(estate, member.role)}
                  <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d={picking === "role" ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} />
                  </svg>
                </button>
              ) : (
                <span className={chip}>{roleLabel(estate, member.role)}</span>
              )}
              {actions ? (
                <button
                  type="button"
                  aria-expanded={stageOpen}
                  aria-label={`Stage: ${p.stages?.find((s) => s.key === member.stage)?.label ?? stageLabel(member.stage)}. Change stage`}
                  disabled={actionBusy}
                  onClick={() => setPicking((o) => (o === "stage" ? null : "stage"))}
                  className={`${chip} flex min-h-[36px] items-center gap-1 ring-1 ring-[#0E7FA6]/50 disabled:opacity-50 dark:ring-[#6AE6FF]/50`}
                >
                  {p.stages?.find((s) => s.key === member.stage)?.label ?? stageLabel(member.stage)}
                  <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d={stageOpen ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} />
                  </svg>
                </button>
              ) : (
                <span className={chip}>{p.stages?.find((s) => s.key === member.stage)?.label ?? stageLabel(member.stage)}</span>
              )}
              {actions ? (
                <button
                  type="button"
                  aria-expanded={picking === "priority"}
                  aria-label={`${priorityLabel(member.priority)}. Change priority`}
                  disabled={actionBusy}
                  onClick={() => setPicking((o) => (o === "priority" ? null : "priority"))}
                  className={`${chip} flex min-h-[36px] items-center gap-1 ring-1 ring-[#0E7FA6]/50 disabled:opacity-50 dark:ring-[#6AE6FF]/50 ${
                    member.priority === "high" ? "!bg-[#0E7FA6] !text-white dark:!bg-[#6AE6FF] dark:!text-[#04121A]" : ""
                  }`}
                >
                  {priorityLabel(member.priority)}
                  <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d={picking === "priority" ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} />
                  </svg>
                </button>
              ) : member.priority ? (
                <span className={chip}>{priorityLabel(member.priority)}</span>
              ) : null}
            </>
          ) : p.memberOf === "company" ? (
            <>
              <span className="break-words text-[15px] text-neutral-600 dark:text-neutral-300">
                filed under {companyName ?? "its company"}
              </span>
              {actions && member ? (
                <button
                  type="button"
                  aria-expanded={stageOpen}
                  aria-label={`${companyName ?? "Company"} stage: ${p.stages?.find((s) => s.key === member.stage)?.label ?? stageLabel(member.stage)}. Change stage`}
                  disabled={actionBusy}
                  onClick={() => setPicking((o) => (o === "stage" ? null : "stage"))}
                  className={`${chip} flex min-h-[36px] items-center gap-1 ring-1 ring-[#0E7FA6]/50 disabled:opacity-50 dark:ring-[#6AE6FF]/50`}
                >
                  {p.stages?.find((s) => s.key === member.stage)?.label ?? stageLabel(member.stage)}
                  <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d={stageOpen ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} />
                  </svg>
                </button>
              ) : null}
            </>
          ) : (
            <span className="text-[15px] text-neutral-600 dark:text-neutral-300">Not on the pipeline</span>
          )}
        </div>
        {/* The next action: always shown for a contact on the pipeline, and tapped to set or change it. */}
        {actions && member ? (
          <button
            type="button"
            aria-expanded={picking === "next"}
            aria-label={
              member.nextAction
                ? `Next action: ${member.nextAction}${member.nextActionDate ? `, due ${formatDate(member.nextActionDate)}` : ""}. Change next action`
                : "Next action: none set. Set next action"
            }
            disabled={actionBusy}
            onClick={() => setPicking((o) => (o === "next" ? null : "next"))}
            className={`${card} flex min-h-[52px] w-full items-center justify-between gap-3 px-4 py-2 text-left ring-1 ring-[#0E7FA6]/50 disabled:opacity-50 dark:ring-[#6AE6FF]/50`}
          >
            <span className="flex min-w-0 flex-col">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Next action</span>
              <span className={`break-words text-[17px] ${member.nextAction ? "text-neutral-900 dark:text-white" : "text-neutral-500 dark:text-neutral-400"}`}>
                {member.nextAction
                  ? `${member.nextAction}${member.nextActionDate ? ` · due ${formatDate(member.nextActionDate)}` : ""}`
                  : "None set. Tap to add one."}
              </span>
            </span>
            <svg aria-hidden="true" className="shrink-0 text-[#0E7FA6] dark:text-[#6AE6FF]" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d={picking === "next" ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} />
            </svg>
          </button>
        ) : null}
        <div ref={setStageSlot} />
      </header>

      <dl className={`${card} divide-y divide-black/5 dark:divide-white/10`}>
        <Detail label="Email">
          {p.email ? (
            mailHref(p.email) ? (
              <a href={mailHref(p.email)!} className={linkClass}>
                {p.email}
              </a>
            ) : (
              p.email
            )
          ) : (
            "(none)"
          )}
        </Detail>
        <Detail label="Phone">
          {p.phone ? (
            <span className="whitespace-pre-line">
              {phoneSegments(p.phone).map((seg, i) =>
                seg.href ? (
                  <a key={i} href={seg.href} className={linkClass}>
                    {seg.text}
                  </a>
                ) : (
                  <span key={i}>{seg.text}</span>
                ),
              )}
            </span>
          ) : (
            "(none)"
          )}
        </Detail>
        <Detail label="LinkedIn">{p.linkedin ? <ExternalLink value={p.linkedin} /> : "(none)"}</Detail>
        <Detail label="Country">{p.country || "(none)"}</Detail>
        <Detail label="Website">{p.website ? <ExternalLink value={p.website} /> : "(none)"}</Detail>
        {member?.nextAction && !actions ? (
          <Detail label="Next">
            {`${member.nextAction}${member.nextActionDate ? ` · due ${formatDate(member.nextActionDate)}` : ""}`}
          </Detail>
        ) : null}
      </dl>

      {actions ? actions(p, reload, setActionBusy, { open: picking, slot: stageSlot, close: closeStage }) : null}

      {notes.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className={sectionHeading}>Notes</h3>
          <div className={`${card} flex flex-col gap-3 p-4`}>
            {notes.map((n, i) => (
              <p key={i} className="whitespace-pre-wrap break-words text-[16px] text-neutral-900 dark:text-white">
                {n}
              </p>
            ))}
          </div>
        </section>
      ) : null}

      {p.kind === "company" && p.people.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className={sectionHeading}>People</h3>
          <ul className={`${card} divide-y divide-black/5 overflow-hidden dark:divide-white/10`}>
            {p.people.map((person) => (
              <li key={person.personId}>
                <button
                  type="button"
                  onClick={() => onOpen({ personId: person.personId })}
                  disabled={actionBusy}
                  className="flex min-h-[56px] w-full flex-col justify-center px-4 py-2 text-left active:bg-neutral-100 disabled:opacity-50 dark:active:bg-white/10"
                >
                  <span className="break-words text-[17px] font-semibold text-neutral-900 dark:text-white">{person.name}</span>
                  {person.title ? (
                    <span className="break-words text-[15px] text-neutral-600 dark:text-neutral-300">{person.title}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <h3 className={sectionHeading}>{p.timelineOf ? `Timeline of ${p.timelineOf}` : "Timeline"}</h3>
        {p.timeline.length === 0 ? (
          <p className="px-1 text-neutral-500 dark:text-neutral-400">No timeline yet.</p>
        ) : (
          <ul className={`${card} divide-y divide-black/5 dark:divide-white/10`}>
            {p.timeline.map((t, i) => (
              <li key={i} className="px-4 py-3">
                <p className="whitespace-pre-wrap break-words text-[16px] text-neutral-900 dark:text-white">
                  {`${formatDate(t.at)} · ${t.kind} · ${t.summary}`}
                </p>
                {t.by ? <p className="text-[14px] text-neutral-500 dark:text-neutral-400">{`by ${t.by}`}</p> : null}
              </li>
            ))}
          </ul>
        )}
        {p.timelineTotal > p.timeline.length ? (
          <p className="px-1 text-[14px] text-neutral-500 dark:text-neutral-400">{`Showing ${p.timeline.length} of ${p.timelineTotal}`}</p>
        ) : null}
      </section>
    </div>
  );
}
