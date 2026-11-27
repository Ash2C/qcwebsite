"use client";

import { useEffect, useRef, useState } from "react";
import type { ContactHit } from "@/lib/monsoon/contacts";
import type { ImportInfo, SiftHit, Sort } from "@/lib/monsoon/sift";
import MonsoonLoader from "./MonsoonLoader";
import { loadImportContacts, loadImports, searchContacts, type EstateInfo, type Todo } from "./api";
import type { AskViewing } from "./AskPanel";
import ProfileActions, { type ProfileDraft } from "./ProfileActions";
import ProfileView, { roleLabel } from "./ProfileView";
import { stageLabel } from "./labels";
import { card, fieldInput, fieldLabel, secondaryButton } from "./styles";

export type ContactTarget = { memberId?: string; personId?: string; orgId?: string };
/** `draft` is what was typed in the open profile (an edit form or a note); it belongs to that contact only. */
/** `autoResearch` asks the open profile to start research once it has loaded; the profile reports it consumed. */
/** `high` and `sort` are how the list is sifted; they stay as set while the app is open. */
/** `importLabel` is the bulk import whose contacts are listed instead of everyone; absent or null for none. */
export type ContactsState = {
  query: string;
  open: ContactTarget | null;
  draft?: ProfileDraft | null;
  autoResearch?: boolean;
  high?: boolean;
  sort?: Sort;
  importLabel?: string | null;
};
export const EMPTY_CONTACTS: ContactsState = { query: "", open: null, draft: null };

const targetKey = (t: ContactTarget) => `${t.memberId ?? ""}|${t.personId ?? ""}|${t.orgId ?? ""}`;

/** The state with another contact (or none) open; a draft typed for a different contact is dropped. */
export function withOpen(s: ContactsState, open: ContactTarget | null): ContactsState {
  const keep = open !== null && s.open !== null && targetKey(open) === targetKey(s.open);
  return { ...s, open, draft: keep ? s.draft : null, autoResearch: false };
}

/** The state with that person's profile open and research to start on it. */
export function withOpenResearch(s: ContactsState, personId: string): ContactsState {
  return { ...withOpen(s, { personId }), autoResearch: true };
}

const DEBOUNCE_MS = 250;
const SORT_LABELS: { key: Sort; label: string }[] = [
  { key: "recent", label: "Recent" },
  { key: "next", label: "Next action" },
  { key: "last", label: "Last action" },
  { key: "stage", label: "Stage" },
];
const DUE_WORDS: Partial<Record<string, string>> = { overdue: "overdue", today: "today" };

/** "5 Mar" this year, "5 Mar 2025" otherwise. Takes a YYYY-MM-DD day or an ISO time. */
export function shortDay(value: string, now: Date = new Date()): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
}

// The two work lines every row carries: blank fields show as a dash.
function workLines(hit: SiftHit): { next: string; last: string; overdue: boolean } {
  const w = hit.work ?? null;
  const next = w?.nextAction
    ? [w.nextAction, w.nextActionDate ? shortDay(w.nextActionDate) : null, DUE_WORDS[w.due] ?? null].filter(Boolean).join(" · ")
    : "—";
  const last = w?.lastKind && w.lastAt ? `${w.lastKind.charAt(0).toUpperCase()}${w.lastKind.slice(1)} · ${shortDay(w.lastAt)}` : "—";
  return { next, last, overdue: w?.due === "overdue" };
}
const FAILURE = "Could not load contacts. Check signal.";

type Phase = "loading" | "ready" | "failed";

function lines(hit: ContactHit, estate: EstateInfo): [string | null, string] {
  const second = hit.kind === "company" ? "Company" : [hit.title, hit.company].filter(Boolean).join(" · ") || null;
  const third =
    hit.member && hit.memberOf === "self"
      ? `${roleLabel(estate, hit.member.role)} · ${stageLabel(hit.member.stage)}`
      : hit.memberOf === "company"
        ? `filed under ${hit.company ?? "its company"}`
        : "on file, not on the pipeline";
  return [second, third];
}

// What opening a row asks the server for; null when the row has no usable id (then it is not tappable).
function targetOf(hit: ContactHit): ContactTarget | null {
  if (hit.kind === "person") return hit.personId ? { personId: hit.personId } : null;
  if (hit.orgId) return { orgId: hit.orgId };
  return hit.member ? { memberId: hit.member.memberId } : null;
}

export default function ContactsPanel({
  estate,
  state,
  onChange,
  onUnauthorized,
  onBusy,
  onAsk,
  onViewing,
  reloadSignal,
  onPrepare,
}: {
  estate: EstateInfo;
  state: ContactsState;
  onChange: (next: ContactsState | ((prev: ContactsState) => ContactsState)) => void;
  onUnauthorized: () => void;
  /** True while a profile action is proposing or confirming a change. */
  onBusy?: (busy: boolean) => void;
  /** Switches to Ask with the given draft. */
  onAsk?: (text: string) => void;
  /** The loaded open profile, for Ask; null when none is on screen. */
  onViewing?: (viewing: AskViewing | null) => void;
  /** A change to this number re-reads what is on screen: the open profile, or the list. */
  reloadSignal?: number;
  /** Prepare me on a to-do shown on a profile. */
  onPrepare?: (todo: Todo) => void;
}) {
  const [hits, setHits] = useState<SiftHit[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const high = state.high === true;
  const sort: Sort = state.sort ?? "recent";
  const sifted = high || sort !== "recent";
  const [phase, setPhase] = useState<Phase>("loading");
  const [tick, setTick] = useState(0);
  // The pipeline's bulk imports, for the Imports control; empty until known, and then there is no control.
  const [imports, setImports] = useState<ImportInfo[]>([]);
  const importLabel = state.importLabel ?? null;
  // A fresh callback each render must not restart the search.
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;
  // The estate this panel last showed; on a change the old rows and any open profile (whose ids
  // belong to the old estate) are dropped before anything is rendered or requested for the new one.
  const shownEstate = useRef(estate.key);
  const estateChanged = shownEstate.current !== estate.key;
  useEffect(() => {
    if (shownEstate.current === estate.key) return;
    shownEstate.current = estate.key;
    setHits([]);
    setPhase("loading");
    onChange((s) => ({ ...withOpen(s, null), importLabel: null }));
  });

  // The imports are asked for when the tab opens (and for another estate). A failure of any kind
  // leaves the tab without the control; the list itself says when the CRM cannot be reached.
  useEffect(() => {
    let live = true;
    setImports([]);
    void (async () => {
      try {
        const res = await loadImports(estate.key);
        if (live && res?.status === 200 && res.body && "imports" in res.body && Array.isArray(res.body.imports)) setImports(res.body.imports);
      } catch {
        // no control
      }
    })();
    return () => {
      live = false;
    };
  }, [estate.key]);
  const q = state.query.trim();
  const searching = q.length >= 2;
  const listing = state.open === null && !estateChanged;
  // One import's contacts stand in for the list of everyone; the search does not apply to them.
  const importing = importLabel !== null && !estateChanged;
  const term = searching && !importing ? q : "";

  useEffect(() => {
    if (!listing) return;
    let live = true; // a response for an older query (or after leaving the list) is dropped
    setPhase("loading");
    const run = () =>
      (importLabel !== null
        ? loadImportContacts(estate.key, importLabel, { high, sort })
        : sifted
          ? searchContacts(estate.key, term, { high, sort })
          : searchContacts(estate.key, term)
      ).then(
        (res) => {
          if (!live) return;
          if (res.status === 401) return unauthorizedRef.current();
          if (res.status === 200 && "contacts" in res.body) {
            setHits(res.body.contacts);
            setTotal(typeof res.body.total === "number" ? res.body.total : null);
            return setPhase("ready");
          }
          setPhase("failed");
        },
        () => {
          if (live) setPhase("failed");
        },
      );
    const timer = setTimeout(run, term ? DEBOUNCE_MS : 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // reloadSignal: a change confirmed in Ask makes the rows (stage, next and last action) stale.
  }, [estate.key, term, tick, listing, high, sort, sifted, reloadSignal, importLabel]);

  const rows = estateChanged ? [] : hits;
  if (state.open && !estateChanged) {
    const open = state.open;
    return (
      <ProfileView
        key={targetKey(open)}
        estate={estate}
        target={open}
        onBack={() => onChange((s) => withOpen(s, null))}
        onOpen={(target) => onChange((s) => withOpen(s, target))}
        onUnauthorized={onUnauthorized}
        onLoadFailed={() => onChange((s) => (s.autoResearch ? { ...s, autoResearch: false } : s))}
        reloadSignal={reloadSignal}
        onPrepare={onPrepare}
        onLoaded={(p) => onViewing?.(p ? { target: open, name: p.name, company: p.kind === "person" ? p.company : null } : null)}
        actions={(profile, reload, setViewBusy, stagePick) => (
          <ProfileActions
            stagePick={stagePick}
            estate={estate}
            profile={profile}
            reload={reload}
            onUnauthorized={onUnauthorized}
            onBusy={onBusy}
            setViewBusy={setViewBusy}
            onAsk={onAsk}
            autoResearch={state.autoResearch === true}
            onAutoResearchDone={() => onChange((s) => (s.autoResearch ? { ...s, autoResearch: false } : s))}
            draftKey={targetKey(open)}
            initialDraft={state.draft}
            onDraft={(draft) => onChange((s) => (s.draft === draft || (!s.draft && !draft) ? s : { ...s, draft }))}
          />
        )}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      {importing ? (
        <div className="flex flex-col gap-2">
          <p role="status" className="break-words px-1 text-[16px] font-medium text-neutral-900 dark:text-white">{`Showing: ${importLabel}`}</p>
          <button type="button" className={secondaryButton} onClick={() => onChange((s) => ({ ...s, importLabel: null }))}>
            Show all
          </button>
        </div>
      ) : (
      <div className={`${card} flex items-center`}>
        <input
          type="text"
          inputMode="search"
          enterKeyHint="search"
          aria-label="Search contacts"
          placeholder={`Search ${estate.label}`}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          value={state.query}
          onChange={(e) => onChange((s) => ({ ...s, query: e.target.value }))}
          className="block min-h-[48px] w-full bg-transparent px-4 py-2.5 text-[17px] text-neutral-900 placeholder:text-neutral-400 focus:outline-none dark:text-white dark:placeholder:text-neutral-500"
        />
        {state.query ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => onChange((s) => ({ ...s, query: "" }))}
            className="mr-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-xl text-neutral-500 active:bg-neutral-100 dark:text-neutral-400 dark:active:bg-white/10"
          >
            ×
          </button>
        ) : null}
      </div>
      )}

      <div className="flex flex-col gap-2">
        <button
          type="button"
          aria-pressed={high}
          onClick={() => onChange((s) => ({ ...s, high: !high }))}
          className={`flex min-h-[48px] w-full items-center justify-between gap-3 rounded-xl px-4 text-[16px] font-semibold ${
            high
              ? "bg-[#0E7FA6] text-white dark:bg-[#6AE6FF] dark:text-[#04121A]"
              : "bg-neutral-200/80 text-neutral-700 dark:bg-white/10 dark:text-neutral-200"
          }`}
        >
          <span>High priority</span>
          <span aria-hidden="true" className="text-[14px] font-bold uppercase tracking-wide">
            {high ? "On" : "Off"}
          </span>
        </button>
        <div role="group" aria-label="Sort by" className="grid grid-cols-4 gap-1 rounded-xl bg-neutral-200/80 p-1 dark:bg-white/10">
          {SORT_LABELS.map((o) => (
            <button
              key={o.key}
              type="button"
              aria-pressed={sort === o.key}
              onClick={() => onChange((s) => ({ ...s, sort: o.key }))}
              className={`min-h-[44px] rounded-lg px-1 text-[14px] font-semibold leading-tight ${
                sort === o.key
                  ? "bg-white text-neutral-900 shadow-sm dark:bg-[#1F3A4A] dark:text-white"
                  : "text-neutral-600 dark:text-neutral-300"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
        {imports.length > 0 || importing ? (
          <div className={card}>
            <label htmlFor="contacts-import" className={fieldLabel}>
              Imports
            </label>
            <select
              id="contacts-import"
              value={importing ? importLabel : ""}
              onChange={(e) => onChange((s) => ({ ...s, importLabel: e.target.value === "" ? null : e.target.value, query: "" }))}
              className={`${fieldInput} appearance-none`}
            >
              <option value="">All contacts</option>
              {/* The import being shown is always a choice, even before the list of imports has loaded. */}
              {importing && !imports.some((i) => i.label === importLabel) ? <option value={importLabel}>{importLabel}</option> : null}
              {imports.map((i) => (
                <option key={i.label} value={i.label}>{`${i.label} (${i.count})`}</option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      {!searching && !sifted && !importing ? (
        <h2 className="px-1 text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Recent
        </h2>
      ) : null}

      {phase === "failed" ? (
        <div className="flex flex-col gap-3">
          <p role="alert" className="px-1 text-red-700 dark:text-red-300">
            {FAILURE}
          </p>
          <button type="button" onClick={() => setTick((n) => n + 1)} className={secondaryButton}>
            Retry
          </button>
        </div>
      ) : phase === "loading" && rows.length === 0 ? (
        <p className="flex items-center gap-2 px-1 text-neutral-500 dark:text-neutral-400">
          <MonsoonLoader className="h-7 w-7" />
          Loading…
        </p>
      ) : phase === "ready" && rows.length === 0 ? (
        <p className="px-1 text-neutral-500 dark:text-neutral-400">
          {importing
            ? high
              ? "No high-priority contacts in this import."
              : "No contacts in this import."
            : high
            ? searching
              ? `No high-priority contacts match "${q}".`
              : "No high-priority contacts."
            : searching
              ? `No contacts match "${q}".`
              : "No contacts yet."}
        </p>
      ) : (
        <ul className={`${card} divide-y divide-black/5 overflow-hidden dark:divide-white/10 ${phase === "loading" ? "opacity-60" : ""}`}>
          {rows.map((hit) => {
            const [second, third] = lines(hit, estate);
            const target = targetOf(hit);
            const work = workLines(hit);
            const rowClass = "flex min-h-[64px] w-full flex-col justify-center gap-0.5 px-4 py-2.5 text-left";
            const body = (
              <>
                  <span className="flex items-center gap-2">
                    <span className="break-words text-[17px] font-semibold text-neutral-900 dark:text-white">{hit.name}</span>
                    {hit.work?.priority === "high" ? (
                      <span className="shrink-0 rounded-full bg-[#0E7FA6] px-2 py-0.5 text-[12px] font-bold uppercase tracking-wide text-white dark:bg-[#6AE6FF] dark:text-[#04121A]">
                        High
                      </span>
                    ) : null}
                  </span>
                  {second ? <span className="break-words text-[15px] text-neutral-600 dark:text-neutral-300">{second}</span> : null}
                  <span className="break-words text-[14px] text-neutral-500 dark:text-neutral-400">{third}</span>
                  <span
                    className={`break-words text-[15px] ${
                      work.overdue ? "font-semibold text-red-700 dark:text-red-300" : "text-neutral-800 dark:text-neutral-100"
                    }`}
                  >
                    {`Next: ${work.next}`}
                  </span>
                  <span className="break-words text-[15px] text-neutral-800 dark:text-neutral-100">{`Last: ${work.last}`}</span>
              </>
            );
            return (
              <li key={`${hit.kind}:${hit.personId ?? hit.orgId ?? hit.member?.memberId ?? hit.name}`}>
                {target ? (
                  <button
                    type="button"
                    onClick={() => onChange((s) => withOpen(s, target))}
                    className={`${rowClass} active:bg-neutral-100 dark:active:bg-white/10`}
                  >
                    {body}
                  </button>
                ) : (
                  <div className={rowClass}>{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {phase === "ready" && total !== null && total > rows.length && rows.length > 0 ? (
        <p className="px-1 text-[14px] text-neutral-600 dark:text-neutral-400">
          {importing ? `Showing the first ${rows.length} of ${total}.` : `Showing ${rows.length} of ${total}. Search to find the rest.`}
        </p>
      ) : null}
    </div>
  );
}
