"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { Profile } from "@/lib/monsoon/contacts";
import { proposeChange, researchContact, type EstateInfo, type ProposeBody } from "./api";
import ChangeCard, { DETAIL_LABELS, MAX_NOTE } from "./ChangeCard";
import ResearchCard from "./ResearchCard";
import { card as cardClass, fieldInput, fieldLabel, primaryButton, secondaryButton } from "./styles";
import { useCardConfirm, type AskCard } from "./useCardConfirm";

const FAILURE = "Could not reach the server. Check signal and try again.";
const MAX_VALUE = 300;
const RESEARCH_FAILURE = "Could not run research. Check signal and try again.";
const LOOKALIKE = "say it is a different company";

type Panel = "note" | "stage" | "edit" | null;
/**
 * What the user has typed in this profile, held by the parent (MonsoonApp) so it survives the
 * passcode screen. `for` names the contact it belongs to; a draft for another contact is ignored.
 */
export type ProfileDraft = { for: string; panel: "note" | "edit"; note: string; values: Record<string, string> };
type Target = ProposeBody["target"];
type PersonField = "name" | "title" | "company" | "email" | "phone" | "linkedin" | "country";
type CompanyField = "website" | "country";

const PERSON_FIELDS: PersonField[] = ["name", "title", "company", "email", "phone", "linkedin", "country"];
const COMPANY_FIELDS: CompanyField[] = ["website", "country"];

// The profile's stored value for an editable field, "" when empty.
function stored(p: Profile, field: string): string {
  const value = (
    {
      name: p.name,
      title: p.title,
      company: p.company,
      email: p.email,
      phone: p.phone,
      linkedin: p.linkedin,
      country: p.country,
      website: p.kind === "company" ? p.website : null,
    } as Record<string, string | null>
  )[field];
  return value ?? "";
}

const panelBox = `${cardClass} flex min-w-0 flex-col gap-3 p-4`;
const alertClass = "break-words text-[15px] font-medium text-red-600 dark:text-red-400";

function researchRoleLabel(estate: EstateInfo, key: string | null): string | undefined {
  return key ? estate.roles.find((r) => r.key === key)?.label : undefined;
}

export default function ProfileActions({
  estate,
  profile,
  reload,
  onUnauthorized,
  onBusy,
  setViewBusy,
  onAsk,
  autoResearch,
  onAutoResearchDone,
  draftKey,
  initialDraft,
  onDraft,
}: {
  estate: EstateInfo;
  profile: Profile;
  reload: () => void;
  onUnauthorized: () => void;
  onBusy?: (busy: boolean) => void;
  /** Tells the profile view to lock its own navigation while this is true; released on every exit path. */
  setViewBusy?: (busy: boolean) => void;
  /** Switches to Ask with this text as the draft (the Ask about this contact button). */
  onAsk?: (text: string) => void;
  /** Start research once, as if the Research button had been tapped (the assistant offered it). */
  autoResearch?: boolean;
  /** Called once when autoResearch has been acted on, so the request is not repeated. */
  onAutoResearchDone?: () => void;
  /** Names the contact the drafts belong to. */
  draftKey?: string;
  /** The draft kept from before the passcode screen, restored only when it is for this contact. */
  initialDraft?: ProfileDraft | null;
  /** Called with what is typed whenever it changes (null when nothing is). */
  onDraft?: (draft: ProfileDraft | null) => void;
}) {
  const ids = useId();
  const p = profile;
  const restored = initialDraft && initialDraft.for === draftKey ? initialDraft : null;
  const [panel, setPanel] = useState<Panel>(restored ? restored.panel : null);
  const [note, setNote] = useState(restored?.note ?? "");
  const [values, setValues] = useState<Record<string, string>>(restored?.panel === "edit" ? restored.values : {});
  const [proposing, setProposing] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [cardState, setCardState] = useState<AskCard | null>(null);
  const cardRef = useRef<AskCard | null>(null);
  const proposingRef = useRef(false);
  const [researching, setResearching] = useState(false);
  const [researchNote, setResearchNote] = useState<string | null>(null);
  const researchingRef = useRef(false);
  const tickedRef = useRef<string[]>([]);
  // The estate and person on screen now, so a result for another one is dropped.
  const scopeRef = useRef("");
  // Bumped when this view closes; a result that arrives later is dropped.
  const genRef = useRef(0);
  useEffect(() => {
    const gen = genRef;
    return () => {
      gen.current += 1;
    };
  }, []);

  scopeRef.current = `${estate.key}:${profile.personId ?? ""}`;

  const setCard = useCallback((next: AskCard | null) => {
    cardRef.current = next;
    setCardState(next);
  }, []);
  const patchCard = useCallback(
    (id: string, patch: Partial<AskCard>) => {
      if (cardRef.current?.id === id) setCard({ ...cardRef.current, ...patch });
    },
    [setCard],
  );

  const { confirm } = useCardConfirm({
    estateKey: estate.key,
    stateOf: (id) => (cardRef.current?.id === id ? cardRef.current.state : undefined),
    patch: patchCard,
    generation: () => genRef.current,
    onUnauthorized,
    extras: (c) =>
      c.signed.proposal.kind === "apply_research" ? { ticked: tickedRef.current, text: c.text } : {},
    onDone: (card) => {
      // The note box is emptied only once the note is saved.
      if (card.signed.proposal.kind === "add_note") setNote("");
      reload();
    },
  });

  const working = cardState?.state === "working";
  const busy = proposing || working || researching;
  useEffect(() => {
    onBusy?.(busy);
    setViewBusy?.(busy);
    return () => {
      onBusy?.(false);
      setViewBusy?.(false);
    };
  }, [busy, onBusy, setViewBusy]);

  // Keep the parent's copy of what is typed current. Only the open editor's values and the note count.
  const onDraftRef = useRef(onDraft);
  onDraftRef.current = onDraft;
  useEffect(() => {
    const key = draftKey ?? "";
    onDraftRef.current?.(
      panel === "edit"
        ? { for: key, panel: "edit", note, values }
        : note !== ""
          ? { for: key, panel: "note", note, values: {} }
          : null,
    );
  }, [panel, note, values, draftKey]);

  const isCompany = p.kind === "company";
  // Edits address the person or company itself. Notes and stage moves address the timeline's member;
  // a person filed under a company is resolved by the server to the company's member.
  const editTarget: Target = isCompany ? { orgId: p.orgId ?? undefined } : { personId: p.personId ?? undefined };
  const timelineTarget: Target =
    p.member && (isCompany || p.memberOf === "self")
      ? { memberId: p.member.memberId }
      : isCompany
        ? {}
        : { personId: p.personId ?? undefined };
  const canNote = !isCompany || p.member !== null;
  const canMove = p.memberOf !== null && p.member !== null;
  // A company that is not on the pipeline has no timeline to log to, so it offers no changes at all.
  const offline = isCompany && p.member === null;

  async function propose(body: Omit<ProposeBody, "estate">) {
    if (proposingRef.current || busy) return;
    proposingRef.current = true;
    setProposing(true);
    setRefusal(null);
    const gen = genRef.current;
    try {
      const res = await proposeChange({ estate: estate.key, ...body });
      if (gen !== genRef.current) return;
      if (res.status === 401) {
        onUnauthorized();
      } else if (res.status === 200 && res.body && "ok" in res.body) {
        if (res.body.ok) {
          const signed = res.body.signed;
          setCard({ id: crypto.randomUUID(), signed, text: signed.text ?? body.text ?? "", state: "open" });
          setPanel(null);
        } else {
          setRefusal(res.body.reason);
        }
      } else {
        setRefusal(FAILURE);
      }
    } catch {
      if (gen === genRef.current) setRefusal(FAILURE);
    } finally {
      proposingRef.current = false;
      if (gen === genRef.current) setProposing(false);
    }
  }

  async function research() {
    if (researchingRef.current || busy || !p.personId) return;
    researchingRef.current = true;
    setResearching(true);
    setResearchNote(null);
    const gen = genRef.current;
    const scope = scopeRef.current;
    const stale = () => gen !== genRef.current || scope !== scopeRef.current;
    try {
      const res = await researchContact({ estate: estate.key, personId: p.personId });
      if (stale()) return;
      if (res.status === 401) {
        onUnauthorized();
      } else if (res.status === 200 && res.body && "status" in res.body) {
        if (res.body.status === "findings") {
          const signed = res.body.signed;
          tickedRef.current = [];
          setPanel(null);
          setCard({ id: crypto.randomUUID(), signed, text: res.body.summary, state: "open" });
        } else {
          setResearchNote(res.body.message);
        }
      } else {
        setResearchNote(RESEARCH_FAILURE);
      }
    } catch {
      if (!stale()) setResearchNote(RESEARCH_FAILURE);
    } finally {
      researchingRef.current = false;
      if (gen === genRef.current) setResearching(false);
    }
  }

  // The assistant's offer: research runs once for this request. The timer lets a development
  // double-mount settle first; the ref makes sure only one run ever starts.
  const autoRef = useRef(false);
  const researchRef = useRef(research);
  researchRef.current = research;
  useEffect(() => {
    if (!autoResearch) return;
    const timer = setTimeout(() => {
      if (autoRef.current) return;
      autoRef.current = true;
      onAutoResearchDone?.();
      void researchRef.current();
    }, 0);
    return () => clearTimeout(timer);
    // The request is consumed by onAutoResearchDone; only the flag matters here.
  }, [autoResearch]);

  function toggle(next: Exclude<Panel, null>) {
    if (busy) return;
    setRefusal(null);
    if (panel === next) return setPanel(null);
    if (next === "edit") {
      setValues(Object.fromEntries((isCompany ? COMPANY_FIELDS : PERSON_FIELDS).map((f) => [f, stored(p, f)])));
    }
    setPanel(next);
  }

  function review(newCompany: boolean) {
    // Always the form as it is now, so "It's a different company" never sends an older edit.
    const changes: Record<string, string> = {};
    for (const field of isCompany ? COMPANY_FIELDS : PERSON_FIELDS) {
      const next = (values[field] ?? "").trim();
      if (next !== stored(p, field).trim()) changes[field] = next;
    }
    if (Object.keys(changes).length === 0) return setRefusal("Nothing to change.");
    void propose({ kind: "update_details", target: editTarget, changes, ...(newCompany ? { newCompany: true } : {}) });
  }

  // Editing a field clears a refusal that was about the form as it was.
  function edit(field: string, value: string) {
    setRefusal(null);
    setValues((v) => ({ ...v, [field]: value }));
  }

  const noteBlank = note.trim() === "";
  const noteTooLong = note.length > MAX_NOTE;
  const buttons: { key: Exclude<Panel, null>; label: string }[] = [
    ...(canNote ? [{ key: "note" as const, label: "Add note" }] : []),
    ...(canMove ? [{ key: "stage" as const, label: "Move stage" }] : []),
    ...(offline ? [] : [{ key: "edit" as const, label: "Edit" }]),
  ];
  const refusalBlock = refusal ? (
    <div className="flex flex-col gap-2">
      <p role="alert" className={alertClass}>
        {refusal}
      </p>
      {refusal.includes(LOOKALIKE) && (
        <button type="button" className={secondaryButton} disabled={busy} onClick={() => review(true)}>
          It&apos;s a different company
        </button>
      )}
    </div>
  ) : null;

  return (
    <div className="flex flex-col gap-3">
      {offline ? (
        <p className="px-1 text-[15px] text-neutral-600 dark:text-neutral-300">
          Not on the pipeline. Capture or add a person here to start a timeline.
        </p>
      ) : (
        <div className={`grid gap-2 ${buttons.length + (isCompany ? 0 : 1) === 3 ? "grid-cols-3" : "grid-cols-2"}`}>
          {buttons.map((b) => (
            <button
              key={b.key}
              type="button"
              aria-pressed={panel === b.key}
              disabled={busy}
              onClick={() => toggle(b.key)}
              className={`${secondaryButton} !px-2 ${panel === b.key ? "ring-2 ring-[#0E7FA6] dark:ring-[#6AE6FF]" : ""}`}
            >
              {b.label}
            </button>
          ))}
          {!isCompany && (
            <button type="button" disabled={busy} onClick={() => void research()} className={`${secondaryButton} !px-2`}>
              Research
            </button>
          )}
        </div>
      )}
      {researching && (
        <p role="status" className="break-words px-1 text-[15px] text-neutral-600 dark:text-neutral-300">
          {`Researching ${p.name}${p.company ? ` at ${p.company}` : ""}...`}
        </p>
      )}
      {researchNote && (
        <p role="alert" className={alertClass}>
          {researchNote}
        </p>
      )}

      {panel === "note" && (
        <div className={panelBox}>
          <label htmlFor={`${ids}-note`} className="sr-only">
            Note text
          </label>
          <textarea
            id={`${ids}-note`}
            rows={4}
            value={note}
            disabled={busy}
            placeholder="Type or dictate a note"
            onChange={(e) => setNote(e.target.value)}
            className="block w-full break-words rounded-xl bg-neutral-100 px-4 py-2.5 text-[17px] text-neutral-900 placeholder:text-neutral-400 focus:outline-none dark:bg-white/10 dark:text-white dark:placeholder:text-neutral-500"
          />
          {noteTooLong && <p role="alert" className={alertClass}>{`Notes can be up to ${MAX_NOTE} characters.`}</p>}
          {refusalBlock}
          <button
            type="button"
            className={primaryButton}
            disabled={busy || noteBlank || noteTooLong}
            onClick={() => void propose({ kind: "add_note", target: timelineTarget, text: note.trim() })}
          >
            Continue
          </button>
        </div>
      )}

      {panel === "stage" && (
        <div className={panelBox}>
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Move to</p>
          <div className="flex flex-col gap-2">
            {p.stages.map((s) => {
              const current = s.key === p.member?.stage;
              return (
                <button
                  key={s.key}
                  type="button"
                  disabled={busy || current}
                  onClick={() => void propose({ kind: "move_stage", target: timelineTarget, stage: s.key })}
                  className={`${secondaryButton} flex items-center justify-between gap-2 text-left`}
                >
                  <span className="break-words">{s.label}</span>
                  {current && <span className="shrink-0 text-[14px] text-neutral-500 dark:text-neutral-400">Current</span>}
                </button>
              );
            })}
          </div>
          {refusalBlock}
        </div>
      )}

      {panel === "edit" && (
        <div className={panelBox}>
          <div className="-mx-4 flex flex-col divide-y divide-black/5 dark:divide-white/10">
            {(isCompany ? COMPANY_FIELDS : PERSON_FIELDS).map((field) => {
              const id = `${ids}-${field}`;
              const common = {
                id,
                value: values[field] ?? "",
                maxLength: MAX_VALUE,
                disabled: busy,
                autoComplete: "off",
                className: fieldInput,
              };
              return (
                <div key={field}>
                  <label htmlFor={id} className={fieldLabel}>
                    {DETAIL_LABELS[field]}
                  </label>
                  {field === "phone" ? (
                    <textarea rows={2} {...common} onChange={(e) => edit(field, e.target.value)} />
                  ) : (
                    <input
                      type="text"
                      inputMode={field === "email" ? "email" : field === "linkedin" || field === "website" ? "url" : undefined}
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      {...common}
                      onChange={(e) => edit(field, e.target.value)}
                    />
                  )}
                </div>
              );
            })}
          </div>
          {refusalBlock}
          <div className="grid grid-cols-2 gap-2">
            <button type="button" className={secondaryButton} disabled={busy} onClick={() => toggle("edit")}>
              Cancel
            </button>
            <button type="button" className={secondaryButton} disabled={busy} onClick={() => review(false)}>
              Review changes
            </button>
          </div>
        </div>
      )}

      {cardState && cardState.signed.proposal.kind === "apply_research" && (
        <ResearchCard
          key={cardState.id}
          signed={cardState.signed}
          summary={cardState.text}
          roleLabel={researchRoleLabel(estate, cardState.signed.proposal.addsToPipeline)}
          state={cardState.state}
          message={cardState.message}
          onSave={(ticked, summary) => {
            if (cardRef.current?.state !== "open") return;
            tickedRef.current = ticked;
            const next = { ...cardRef.current, text: summary };
            setCard(next);
            void confirm(next);
          }}
          onDiscard={() => {
            if (cardRef.current?.state === "open") setCard(null);
          }}
        />
      )}
      {cardState && cardState.signed.proposal.kind !== "apply_research" && (
        <ChangeCard
          card={cardState}
          onText={(text) => patchCard(cardState.id, { text })}
          onConfirm={() => void confirm(cardState)}
          onCancel={() => {
            const open = cardRef.current;
            if (open?.state !== "open") return;
            patchCard(cardState.id, { state: "cancelled", message: undefined });
            if (open.signed.proposal.kind === "add_note") {
              // The note goes back into the note box, as it stood on the card.
              setNote(open.text);
              setPanel("note");
            }
          }}
        />
      )}

      {onAsk && (
        <button type="button" className={secondaryButton} disabled={busy} onClick={() => onAsk(`About ${p.name}: `)}>
          Ask about this contact
        </button>
      )}
    </div>
  );
}
