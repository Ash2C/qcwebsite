"use client";

import { useEffect, useRef, useState } from "react";
import type { CardFields, CardKind } from "@/lib/monsoon/extract";
import type { CardMatch } from "@/lib/monsoon/match";
import type { RefineOutput } from "@/lib/monsoon/refine";
import { saveCard, type EstateInfo, type SaveBody } from "./api";
import { changedClass, notesRows, Was } from "./Highlight";
import { describeResult, type SavePrompt } from "./outcomes";
import MatchLine, { type MatchChoice } from "./MatchLine";
import { changeOf, choiceAfter, confidentId, matchTag, NEEDS_CHOICE_HINT, needsChoice } from "./matchState";
import PromptButtons from "./PromptButtons";
import { mergeRefine, type Snapshot } from "./merge";
import SpeakNotes from "./SpeakNotes";
import { card, fieldInput, fieldLabel, FIELD_ROWS, primaryButton, secondaryButton, type FieldKey } from "./styles";

export type BatchRow = {
  id: string; // local key
  captureId: string; // crypto.randomUUID(), fixed for the row's life
  fields: Record<FieldKey, string>;
  extracted: CardFields;
  kind: CardKind;
  match: CardMatch | null; // the "already on file?" result; null = no information
  role?: string; // undefined = use the batch role
  notes?: string; // undefined = use the batch note
  newOrg?: boolean;
  // The user's choice about the match line: a person id, or false = a different person. Kept apart
  // from `samePerson`, so resetting a prompt answer never wipes a still-valid choice.
  choice?: string | false;
  // The answer to a same-name prompt from the server.
  samePerson?: string | false;
  status: "pending" | "saving" | "saved" | "needs" | "failed";
  message?: string;
  prompt?: SavePrompt;
  spoken?: string; // dictation draft for this card
  // Snapshot taken by the first spoken-notes apply, for Undo. `notes` is the override then
  // (undefined = the batch note); `changed` lists the fields still highlighted.
  before?: { fields: Record<FieldKey, string>; notes?: string; changed: (FieldKey | "notes")[] };
};
export type Batch = { rows: BatchRow[]; role: string; note: string };

// `matches` lines up with `cards` by index; null (lookup failed) means no match information.
export function makeBatch(cards: CardFields[], matches: (CardMatch | null)[] | null, role: string, note: string): Batch {
  return {
    role,
    note,
    rows: cards.map((c, i) => {
      const match = matches?.[i] ?? null;
      return {
        id: crypto.randomUUID(),
        captureId: crypto.randomUUID(),
        fields: {
          name: c.name ?? "",
          title: c.title ?? "",
          org: c.org ?? "",
          email: c.email ?? "",
          phone: c.phone ?? "",
          linkedin: c.linkedin ?? "",
        },
        extracted: c,
        kind: c.kind,
        match,
        choice: confidentId(match),
        status: "pending" as const,
      };
    }),
  };
}

const SAVE_FAILED = "Could not save. Retry.";

function isEligible(r: BatchRow): boolean {
  return (
    (r.status === "pending" || r.status === "failed") &&
    r.fields.name.trim() !== "" &&
    !needsChoice(r.match, r.fields.org, r.choice, r.samePerson)
  );
}

// A row whose save would silently reuse a namesake: it waits for a choice.
function waitsForChoice(r: BatchRow): boolean {
  return (
    (r.status === "pending" || r.status === "failed") &&
    r.fields.name.trim() !== "" &&
    needsChoice(r.match, r.fields.org, r.choice, r.samePerson)
  );
}

function identity(f: Record<FieldKey, string>) {
  return { name: f.name, org: f.org, email: f.email };
}

function summary(r: BatchRow): string {
  const name = r.fields.name.trim() || "(no name)";
  const second = r.fields.org.trim() || r.fields.email.trim();
  return second ? `${name} · ${second}` : name;
}

function statusColour(status: BatchRow["status"]): string {
  if (status === "saved") return "text-green-700 dark:text-green-400";
  if (status === "failed") return "text-red-600 dark:text-red-400";
  return "text-neutral-900 dark:text-white";
}

export default function BatchReview({
  estate,
  batch,
  onChange,
  onUnauthorized,
  onClose,
  onRunning,
  onOpenProfile,
}: {
  estate: EstateInfo;
  batch: Batch;
  onChange: (next: Batch | ((prev: Batch) => Batch)) => void;
  onUnauthorized: () => void;
  onClose: (summary: string | null) => void;
  // Reports whether a save run is in flight, so the parent can lock the estate buttons. Released on unmount.
  onRunning?: (running: boolean) => void;
  // Switches to the Contacts tab on that person; the batch stays open underneath.
  onOpenProfile?: (personId: string) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  // Requests in flight per row id: those rows are read-only and nothing can be saved or dropped.
  // A count, so a row is only released when no request for it remains.
  const [tidyCounts, setTidyCounts] = useState<Record<string, number>>({});
  const tidying = Object.keys(tidyCounts).length > 0;
  const runRef = useRef(false);

  // A save run and a spoken-notes tidy both lock the estate buttons and the mode switch.
  const inFlight = running || tidying;
  useEffect(() => {
    onRunning?.(inFlight);
    return () => onRunning?.(false);
  }, [inFlight, onRunning]);

  function setRowBusy(id: string, busy: boolean) {
    setTidyCounts((counts) => {
      const n = (counts[id] ?? 0) + (busy ? 1 : -1);
      const { [id]: _gone, ...rest } = counts;
      return n > 0 ? { ...rest, [id]: n } : rest;
    });
  }

  const eligible = batch.rows.filter(isEligible).length;
  const savedCount = batch.rows.filter((r) => r.status === "saved").length;
  const allSaved = savedCount > 0 && batch.rows.every((r) => r.status === "saved");
  const savedText = `${savedCount} saved to ${estate.label}.`;

  function patchRow(id: string, patch: Partial<BatchRow>) {
    onChange((prev) => ({ ...prev, rows: prev.rows.map((r) => (r.id === id ? { ...r, ...patch } : r)) }));
  }

  function editField(row: BatchRow, key: FieldKey, value: string) {
    const fields = { ...row.fields, [key]: value };
    const before = dropChanged(row, key);
    // A different name, company or email may be a different person: the match no longer applies, nor a
    // positive choice. "Different person" survives a company edit.
    const change = changeOf(identity(row.fields), identity(fields));
    const stale = change === "same" ? {} : { match: null, choice: choiceAfter(row.choice, change) };
    // A changed field is a fresh attempt: the old answer and message no longer apply.
    if (row.status === "needs" || row.status === "failed") {
      patchRow(row.id, {
        fields,
        before,
        status: "pending",
        message: undefined,
        prompt: undefined,
        newOrg: undefined,
        samePerson: choiceAfter(row.samePerson, change === "same" ? "person" : change),
        ...stale,
      });
    } else {
      patchRow(row.id, { fields, before, ...stale });
    }
  }

  function dropChanged(row: BatchRow, key: FieldKey | "notes"): BatchRow["before"] {
    return row.before && { ...row.before, changed: row.before.changed.filter((k) => k !== key) };
  }

  // Nothing is saved here. The first snapshot is kept across repeated applies; a card that
  // needed attention or failed is a fresh attempt, like after a hand edit.
  // A result for a row that is gone, being saved or already saved is dropped.
  function applyRefine(id: string, result: RefineOutput, sent: Snapshot) {
    onChange((prev) => ({
      ...prev,
      rows: prev.rows.map((r) => {
        if (r.id !== id || r.status === "saving" || r.status === "saved") return r;
        const nowNotes = r.notes ?? prev.note;
        const next = mergeRefine({ fields: r.fields, notes: nowNotes }, sent, result);
        const base = r.before ?? { fields: r.fields, notes: r.notes, changed: [] };
        const wasNotes = base.notes ?? prev.note;
        const changed: (FieldKey | "notes")[] = FIELD_ROWS.map((f) => f.key).filter(
          (k) => next.fields[k] !== base.fields[k],
        );
        if (next.notes !== wasNotes) changed.push("notes");
        const change = changeOf(identity(r.fields), identity(next.fields));
        const stale = change === "same" ? {} : { match: null, choice: choiceAfter(r.choice, change) };
        const reset =
          r.status === "needs" || r.status === "failed"
            ? {
                status: "pending" as const,
                message: undefined,
                prompt: undefined,
                newOrg: undefined,
                samePerson: choiceAfter(r.samePerson, change === "same" ? "person" : change),
              }
            : {};
        return {
          ...r,
          ...reset,
          ...stale,
          fields: { ...next.fields },
          // Notes equal to what the card already shows stay on "Same as batch".
          notes: next.notes === nowNotes ? r.notes : next.notes,
          before: { fields: base.fields, notes: base.notes, changed },
        };
      }),
    }));
  }

  function undoRefine(row: BatchRow) {
    if (!row.before) return;
    // Same reset as a hand edit: the answers and buttons belonged to the tidied values.
    const change = changeOf(identity(row.fields), identity(row.before.fields));
    const stale = change === "same" ? {} : { match: null, choice: choiceAfter(row.choice, change) };
    const reset =
      row.status === "needs" || row.status === "failed"
        ? {
            status: "pending" as const,
            message: undefined,
            prompt: undefined,
            newOrg: undefined,
            samePerson: choiceAfter(row.samePerson, change === "same" ? "person" : change),
          }
        : {};
    patchRow(row.id, { ...reset, ...stale, fields: row.before.fields, notes: row.before.notes, before: undefined });
  }

  // Saves one row. Resolves false when the loop must stop (401).
  async function saveRow(row: BatchRow, b: { role: string; note: string }): Promise<boolean> {
    patchRow(row.id, {
      fields: row.fields,
      newOrg: row.newOrg,
      samePerson: row.samePerson,
      status: "saving",
      message: undefined,
      prompt: undefined,
    });
    const role = row.role ?? b.role;
    const body: SaveBody = {
      estate: estate.key,
      captureId: row.captureId,
      role,
      fields: { ...row.fields, notes: (row.notes ?? b.note) || undefined },
      extracted: row.extracted,
      kind: row.kind,
      newOrg: row.newOrg || undefined,
      // A prompt answer wins over the match choice; nothing chosen sends nothing.
      samePerson: row.samePerson ?? row.choice,
    };
    const failed = (message: string) => patchRow(row.id, { status: "failed", message });
    try {
      const res = await saveCard(body);
      if (res.status === 401) {
        // The answer given in this attempt is not kept: a row that had a prompt shows it again,
        // any other row is a plain pending one.
        patchRow(
          row.id,
          row.prompt
            ? { status: "needs", prompt: row.prompt, message: row.message, newOrg: undefined, samePerson: undefined }
            : { status: "pending", newOrg: undefined, samePerson: undefined },
        );
        onUnauthorized();
        return false;
      }
      if (res.status === 200 && "outcome" in res.body) {
        const result = res.body;
        if (result.outcome === "invalid") {
          failed(result.error || SAVE_FAILED);
          return true;
        }
        const out = describeResult(result, {
          name: row.fields.name,
          org: row.fields.org,
          estateLabel: estate.label,
          roleLabel: (key) => estate.roles.find((r) => r.key === key)?.label ?? key,
        });
        if (out.kind === "done") patchRow(row.id, { status: "saved", message: out.text, before: undefined, spoken: undefined });
        else if (out.kind === "prompt") patchRow(row.id, { status: "needs", message: out.text, prompt: out.prompt });
        else patchRow(row.id, { status: "needs", message: out.text });
      } else if (res.status === 400) {
        failed((res.body as { error?: string }).error || SAVE_FAILED);
      } else {
        failed(SAVE_FAILED);
      }
    } catch {
      failed(SAVE_FAILED);
    }
    return true;
  }

  // One run at a time, whether it is Save all or a single prompt answer.
  async function run(rows: BatchRow[]) {
    if (runRef.current || rows.length === 0) return;
    runRef.current = true;
    setRunning(true);
    try {
      for (const row of rows) {
        if (!(await saveRow(row, batch))) break;
      }
    } finally {
      runRef.current = false;
      setRunning(false);
    }
  }

  function discard() {
    if (batch.rows.some((r) => r.status !== "saved") && !window.confirm("Discard the unsaved cards?")) return;
    onClose(null);
  }

  function remove(row: BatchRow) {
    if (row.status === "saved" || running || tidying) return;
    onChange((prev) => ({ ...prev, rows: prev.rows.filter((r) => r.id !== row.id) }));
    if (openId === row.id) setOpenId(null);
  }

  return (
    <div className="flex flex-col gap-4">
      <h2 className="px-1 text-2xl font-bold tracking-tight">
        {batch.rows.length === 1 ? "1 card found" : `${batch.rows.length} cards found`}
      </h2>

      <div className={`${card} divide-y divide-neutral-200 overflow-hidden dark:divide-white/10`}>
        <div>
          <label htmlFor="batch-role" className={fieldLabel}>
            Role
          </label>
          <select
            id="batch-role"
            value={batch.role}
            disabled={running || tidying}
            onChange={(e) => onChange((prev) => ({ ...prev, role: e.target.value }))}
            className={`${fieldInput} appearance-none`}
          >
            {estate.roles.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="batch-note" className={fieldLabel}>
            Note
          </label>
          <input
            id="batch-note"
            type="text"
            value={batch.note}
            disabled={running || tidying}
            onChange={(e) => onChange((prev) => ({ ...prev, note: e.target.value }))}
            className={fieldInput}
          />
        </div>
      </div>

      <ul className="flex flex-col gap-3">
        {batch.rows.map((row) => {
          const tag = matchTag(row.match);
          return (
            <li key={row.id} className={`${card} overflow-hidden`}>
              <button
                type="button"
                aria-expanded={openId === row.id}
                onClick={() => setOpenId(openId === row.id ? null : row.id)}
                className="flex min-h-[56px] w-full flex-col items-start justify-center gap-0.5 px-4 py-2 text-left"
              >
                <span className="flex items-center gap-2">
                  <span className="text-[17px] font-semibold">{summary(row)}</span>
                  {tag && (
                    <span className="rounded-full bg-neutral-200 px-2 py-0.5 text-[12px] font-semibold text-neutral-700 dark:bg-white/15 dark:text-neutral-200">
                      {tag}
                    </span>
                  )}
                </span>
                {row.fields.name.trim() === "" && (
                  <span className="text-[14px] font-medium text-red-600 dark:text-red-400">Add a name</span>
                )}
                {waitsForChoice(row) && (
                  <span className="text-[14px] font-medium text-red-600 dark:text-red-400">{NEEDS_CHOICE_HINT}</span>
                )}
                {row.status === "saving" && (
                  <span className="text-[14px] text-neutral-500 dark:text-neutral-400">Saving…</span>
                )}
              </button>
              {row.message && (
                <p className={`px-4 pb-3 text-[16px] font-medium leading-snug ${statusColour(row.status)}`}>
                  {row.message}
                </p>
              )}
              {row.prompt && (
                <div className="px-4 pb-3">
                  <PromptButtons
                    prompt={row.prompt}
                    disabled={running || tidying}
                    onUseOrg={(org) =>
                      void run([{ ...row, fields: { ...row.fields, org }, newOrg: undefined }])
                    }
                    onDifferentCompany={() => void run([{ ...row, newOrg: true }])}
                    onSamePerson={(personId) => void run([{ ...row, samePerson: personId }])}
                  />
                </div>
              )}
              {openId === row.id && (
                <RowEditor
                  row={row}
                  estate={estate}
                  running={running}
                  tidying={(tidyCounts[row.id] ?? 0) > 0}
                  anyTidying={tidying}
                  canOpen={!running && !!onOpenProfile}
                  onOpenProfile={(id) => onOpenProfile?.(id)}
                  batchNote={batch.note}
                  onField={(key, value) => editField(row, key, value)}
                  onRole={(role) => patchRow(row.id, { role })}
                  onChoose={(choice) => patchRow(row.id, { choice })}
                  onNotes={(notes) => patchRow(row.id, { notes, before: dropChanged(row, "notes") })}
                  onDraft={(spoken) => patchRow(row.id, { spoken })}
                  onApply={(next, sent) => applyRefine(row.id, next, sent)}
                  onBusy={(b) => setRowBusy(row.id, b)}
                  onUndo={() => undoRefine(row)}
                  onUnauthorized={onUnauthorized}
                  onRemove={() => remove(row)}
                />
              )}
            </li>
          );
        })}
      </ul>

      {allSaved && (
        <p role="status" className="px-1 text-[17px] font-medium text-green-700 dark:text-green-400">
          {savedText}
        </p>
      )}

      <div className="sticky bottom-0 -mx-4 mt-auto flex flex-col gap-2 bg-[#f2f2f7]/90 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur dark:bg-[#07090C]/90">
        {allSaved ? (
          <button type="button" className={primaryButton} onClick={() => onClose(savedText)}>
            Done
          </button>
        ) : (
          <button
            type="button"
            className={primaryButton}
            disabled={eligible === 0 || running || tidying}
            onClick={() => void run(batch.rows.filter(isEligible))}
          >
            {running ? "Saving…" : `Save all (${eligible})`}
          </button>
        )}
        <button type="button" disabled={running || tidying} className={secondaryButton} onClick={discard}>
          Discard batch
        </button>
      </div>
    </div>
  );
}

// The editor under a tapped row. Kept self-contained so later controls can be added beside the Notes input.
function RowEditor({
  row,
  estate,
  running,
  tidying,
  anyTidying,
  canOpen,
  onOpenProfile,
  batchNote,
  onField,
  onRole,
  onChoose,
  onNotes,
  onDraft,
  onApply,
  onBusy,
  onUndo,
  onUnauthorized,
  onRemove,
}: {
  row: BatchRow;
  estate: EstateInfo;
  running: boolean;
  tidying: boolean; // this card has a tidy request in flight
  anyTidying: boolean; // some card does
  canOpen: boolean; // no batch save is running
  onOpenProfile: (personId: string) => void;
  batchNote: string;
  onField: (key: FieldKey, value: string) => void;
  onRole: (role: string | undefined) => void;
  onChoose: (samePerson: string | false | undefined) => void;
  onNotes: (notes: string | undefined) => void;
  onDraft: (text: string) => void;
  onApply: (next: RefineOutput, sent: Snapshot) => void;
  onBusy: (busy: boolean) => void;
  onUndo: () => void;
  onUnauthorized: () => void;
  onRemove: () => void;
}) {
  const locked = row.status === "saved" || row.status === "saving" || running || tidying;
  const choice: MatchChoice = row.choice === undefined ? null : { samePerson: row.choice };
  const marked = (key: FieldKey | "notes") => row.before?.changed.includes(key) ?? false;
  return (
    <div className="divide-y divide-neutral-200 border-t border-neutral-200 dark:divide-white/10 dark:border-white/10">
      {/* The server's same-name question is the same question as the match line: ask it once. */}
      {row.match && row.status !== "saved" && row.prompt?.kind !== "same_name" && (
        <div className="p-3">
          <MatchLine
            match={row.match}
            choice={choice}
            onChoose={(c) => onChoose(c ? c.samePerson : undefined)}
            onOpen={onOpenProfile}
            canOpen={canOpen}
            disabled={locked}
            roleLabel={(key) => estate.roles.find((r) => r.key === key)?.label ?? key}
          />
        </div>
      )}
      {FIELD_ROWS.map((f) => (
        <div key={f.key} data-changed={marked(f.key) || undefined} className={marked(f.key) ? changedClass : undefined}>
          <label htmlFor={`${row.id}-${f.key}`} className={fieldLabel}>
            {f.label}
          </label>
          <input
            id={`${row.id}-${f.key}`}
            type={f.type ?? "text"}
            inputMode={f.mode}
            autoComplete={f.auto}
            autoCapitalize={f.key === "name" || f.key === "title" || f.key === "org" ? "words" : "off"}
            autoCorrect="off"
            value={row.fields[f.key]}
            readOnly={locked}
            onChange={(e) => onField(f.key, e.target.value)}
            className={fieldInput}
          />
          {row.before && marked(f.key) && <Was value={row.before.fields[f.key]} />}
        </div>
      ))}
      <div>
        <label htmlFor={`${row.id}-role`} className={fieldLabel}>
          Card role
        </label>
        <select
          id={`${row.id}-role`}
          value={row.role ?? ""}
          disabled={locked}
          onChange={(e) => onRole(e.target.value || undefined)}
          className={`${fieldInput} appearance-none`}
        >
          <option value="">Same as batch</option>
          {estate.roles.map((r) => (
            <option key={r.key} value={r.key}>
              {r.label}
            </option>
          ))}
        </select>
      </div>
      <div data-changed={marked("notes") || undefined} className={marked("notes") ? changedClass : undefined}>
        <label htmlFor={`${row.id}-notes`} className={fieldLabel}>
          Card notes
        </label>
        <textarea
          id={`${row.id}-notes`}
          rows={notesRows(row.notes ?? "", 1)}
          placeholder="Same as batch"
          value={row.notes ?? ""}
          readOnly={locked}
          onChange={(e) => onNotes(e.target.value === "" ? undefined : e.target.value)}
          className={`${fieldInput} resize-none overflow-y-auto`}
        />
        {row.before && marked("notes") && <Was value={row.before.notes ?? batchNote} />}
      </div>
      {row.status !== "saved" && (
        <div className="flex flex-col gap-2 p-3">
          <SpeakNotes
            fields={row.fields}
            notes={row.notes ?? batchNote}
            draft={row.spoken ?? ""}
            onDraft={onDraft}
            onApply={onApply}
            onUnauthorized={onUnauthorized}
            onBusy={onBusy}
            disabled={running || row.status === "saving" || tidying}
          />
          {row.before && (
            <button type="button" disabled={running || tidying} className={secondaryButton} onClick={onUndo}>
              Undo
            </button>
          )}
        </div>
      )}
      {row.status !== "saved" && (
        <div className="p-3">
          <button type="button" disabled={running || anyTidying} className={secondaryButton} onClick={onRemove}>
            Remove
          </button>
        </div>
      )}
    </div>
  );
}
