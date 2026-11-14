"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Profile } from "@/lib/monsoon/contacts";
import { loadProfile, type EstateInfo } from "./api";
import { localDate } from "./AskPanel";
import type { ContactTarget } from "./ContactsPanel";
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

export function stageLabel(key: string): string {
  const text = key.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
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
  "rounded-full bg-[#0E7FA6]/10 px-3 py-1 text-sm font-semibold text-[#0E7FA6] dark:bg-[#6AE6FF]/15 dark:text-[#6AE6FF]";

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

export default function ProfileView({
  estate,
  target,
  onBack,
  onOpen,
  onUnauthorized,
  actions,
}: {
  estate: EstateInfo;
  target: ContactTarget;
  onBack: () => void;
  onOpen: (target: ContactTarget) => void;
  onUnauthorized: () => void;
  actions?: (profile: Profile, reload: () => void) => ReactNode;
}) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;
  const { memberId, personId, orgId } = target;

  useEffect(() => {
    let live = true; // a response that arrives after the target changed or the view closed is dropped
    loadProfile(estate.key, { memberId, personId, orgId }, localDate()).then(
      (res) => {
        if (!live) return;
        if (res.status === 401) return unauthorizedRef.current();
        if (res.status === 404) {
          setProfile(null);
          return setPhase("missing");
        }
        if (res.status === 200 && "profile" in res.body) {
          setProfile(res.body.profile);
          return setPhase("ready");
        }
        setPhase("failed");
      },
      () => {
        if (live) setPhase("failed");
      },
    );
    return () => {
      live = false;
    };
  }, [estate.key, memberId, personId, orgId, tick]);

  const back = (
    <button
      type="button"
      onClick={onBack}
      className="-ml-2 min-h-[44px] self-start px-2 text-[17px] font-medium text-[#0E7FA6] dark:text-[#6AE6FF]"
    >
      ‹ Contacts
    </button>
  );

  if (phase === "loading" && !profile) {
    return (
      <div className="flex flex-col gap-3">
        {back}
        <p className="px-1 text-neutral-500 dark:text-neutral-400">Loading…</p>
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
  const member = p.member;
  const companyName = p.company ?? p.timelineOf;
  const subtitle = p.kind === "company" ? null : p.title || p.company;
  const notes = [member?.notes, p.notes].filter((n): n is string => !!n && n.trim() !== "");

  return (
    <div className="flex flex-col gap-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      {back}

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
              <span className={chip}>{roleLabel(estate, member.role)}</span>
              <span className={chip}>{stageLabel(member.stage)}</span>
            </>
          ) : p.memberOf === "company" ? (
            <span className="text-[15px] text-neutral-600 dark:text-neutral-300">
              filed under {companyName ?? "its company"}
            </span>
          ) : (
            <span className="text-[15px] text-neutral-600 dark:text-neutral-300">Not on the pipeline</span>
          )}
        </div>
        {member?.nextAction ? (
          <p className="break-words text-[16px] text-neutral-800 dark:text-neutral-200">
            {`${member.nextAction}${member.nextActionDate ? ` · due ${formatDate(member.nextActionDate)}` : ""}`}
          </p>
        ) : null}
      </header>

      <dl className={`${card} divide-y divide-black/5 dark:divide-white/10`}>
        <Detail label="Email">
          {p.email ? (
            <a href={`mailto:${p.email}`} className={linkClass}>
              {p.email}
            </a>
          ) : (
            "(none)"
          )}
        </Detail>
        <Detail label="Phone">
          {p.phone ? (
            <a href={`tel:${p.phone.replace(/\s+/g, "")}`} className={linkClass}>
              {p.phone}
            </a>
          ) : (
            "(none)"
          )}
        </Detail>
        <Detail label="LinkedIn">{p.linkedin ? <ExternalLink value={p.linkedin} /> : "(none)"}</Detail>
        <Detail label="Country">{p.country || "(none)"}</Detail>
        <Detail label="Website">{p.website ? <ExternalLink value={p.website} /> : "(none)"}</Detail>
      </dl>

      {actions ? actions(p, reload) : null}

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
                  className="flex min-h-[56px] w-full flex-col justify-center px-4 py-2 text-left active:bg-neutral-100 dark:active:bg-white/10"
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
