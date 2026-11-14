"use client";

import { useEffect, useRef, useState } from "react";
import type { ContactHit } from "@/lib/monsoon/contacts";
import { searchContacts, type EstateInfo } from "./api";
import ProfileActions from "./ProfileActions";
import ProfileView, { roleLabel, stageLabel } from "./ProfileView";
import { card, secondaryButton } from "./styles";

export type ContactTarget = { memberId?: string; personId?: string; orgId?: string };
export type ContactsState = { query: string; open: ContactTarget | null };
export const EMPTY_CONTACTS: ContactsState = { query: "", open: null };

const DEBOUNCE_MS = 250;
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
}: {
  estate: EstateInfo;
  state: ContactsState;
  onChange: (next: ContactsState | ((prev: ContactsState) => ContactsState)) => void;
  onUnauthorized: () => void;
  /** True while a profile action is proposing or confirming a change. */
  onBusy?: (busy: boolean) => void;
  /** Switches to Ask with the given draft. */
  onAsk?: (text: string) => void;
}) {
  const [hits, setHits] = useState<ContactHit[]>([]);
  const [phase, setPhase] = useState<Phase>("loading");
  const [tick, setTick] = useState(0);
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
    onChange((s) => ({ ...s, open: null }));
  });
  const q = state.query.trim();
  const searching = q.length >= 2;
  const listing = state.open === null && !estateChanged;
  const term = searching ? q : "";

  useEffect(() => {
    if (!listing) return;
    let live = true; // a response for an older query (or after leaving the list) is dropped
    setPhase("loading");
    const run = () =>
      searchContacts(estate.key, term).then(
        (res) => {
          if (!live) return;
          if (res.status === 401) return unauthorizedRef.current();
          if (res.status === 200 && "contacts" in res.body) {
            setHits(res.body.contacts);
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
  }, [estate.key, term, tick, listing]);

  const rows = estateChanged ? [] : hits;
  if (state.open && !estateChanged) {
    const open = state.open;
    return (
      <ProfileView
        key={`${open.memberId ?? ""}|${open.personId ?? ""}|${open.orgId ?? ""}`}
        estate={estate}
        target={open}
        onBack={() => onChange((s) => ({ ...s, open: null }))}
        onOpen={(target) => onChange((s) => ({ ...s, open: target }))}
        onUnauthorized={onUnauthorized}
        actions={(profile, reload) => (
          <ProfileActions
            estate={estate}
            profile={profile}
            reload={reload}
            onUnauthorized={onUnauthorized}
            onBusy={onBusy}
            onAsk={onAsk}
          />
        )}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
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

      {!searching ? (
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
        <p className="px-1 text-neutral-500 dark:text-neutral-400">Loading…</p>
      ) : phase === "ready" && rows.length === 0 ? (
        <p className="px-1 text-neutral-500 dark:text-neutral-400">
          {searching ? `No contacts match "${q}".` : "No contacts yet."}
        </p>
      ) : (
        <ul className={`${card} divide-y divide-black/5 overflow-hidden dark:divide-white/10 ${phase === "loading" ? "opacity-60" : ""}`}>
          {rows.map((hit) => {
            const [second, third] = lines(hit, estate);
            const target = targetOf(hit);
            const rowClass = "flex min-h-[64px] w-full flex-col justify-center gap-0.5 px-4 py-2.5 text-left";
            const body = (
              <>
                  <span className="break-words text-[17px] font-semibold text-neutral-900 dark:text-white">{hit.name}</span>
                  {second ? <span className="break-words text-[15px] text-neutral-600 dark:text-neutral-300">{second}</span> : null}
                  <span className="break-words text-[14px] text-neutral-500 dark:text-neutral-400">{third}</span>
              </>
            );
            return (
              <li key={`${hit.kind}:${hit.personId ?? hit.orgId ?? hit.member?.memberId ?? hit.name}`}>
                {target ? (
                  <button
                    type="button"
                    onClick={() => onChange((s) => ({ ...s, open: target }))}
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
    </div>
  );
}
