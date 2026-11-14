"use client";

import type { ReactNode } from "react";
import { changedClass, notesRows, Was } from "./Highlight";
import { card, fieldInput, fieldLabel, FIELD_ROWS } from "./styles";

export type FormValues = {
  name: string;
  title: string;
  org: string;
  email: string;
  phone: string;
  linkedin: string;
  notes: string;
};
export type FormKey = keyof FormValues;

// The single form's field card: six fields, role, notes. Presentational only; the parent owns state.
// `was` holds the pre-spoken-notes values and `changed` the keys to highlight.
export default function ContactFormFields({
  form,
  roles,
  role,
  was,
  changed,
  onEdit,
  onRole,
  locked,
  speak,
  hints,
}: {
  form: FormValues;
  roles: { key: string; label: string }[];
  role: string;
  was: FormValues | null;
  changed: readonly FormKey[];
  onEdit: (key: FormKey, value: string) => void;
  onRole: (role: string) => void;
  locked: boolean; // a tidy request is running: the fields are read-only until it returns
  speak: ReactNode;
  hints?: Partial<Record<FormKey, string>>; // a quiet line under a field
}) {
  const mark = (key: FormKey) => was !== null && changed.includes(key);
  return (
    <div className={`${card} divide-y divide-neutral-200 overflow-hidden dark:divide-white/10`}>
      {FIELD_ROWS.map((r) => (
        <div key={r.key} data-changed={mark(r.key) || undefined} className={mark(r.key) ? changedClass : undefined}>
          <label htmlFor={`f-${r.key}`} className={fieldLabel}>
            {r.label}
          </label>
          <input
            id={`f-${r.key}`}
            type={r.type ?? "text"}
            inputMode={r.mode}
            autoComplete={r.auto}
            autoCapitalize={r.key === "name" || r.key === "title" || r.key === "org" ? "words" : "off"}
            autoCorrect="off"
            value={form[r.key]}
            readOnly={locked}
            onChange={(e) => onEdit(r.key, e.target.value)}
            className={fieldInput}
          />
          {hints?.[r.key] && <p className="px-4 pb-2 text-[14px] text-neutral-500 dark:text-neutral-400">{hints[r.key]}</p>}
          {mark(r.key) && was && <Was value={was[r.key]} />}
        </div>
      ))}
      <div>
        <label htmlFor="f-role" className={fieldLabel}>
          Role
        </label>
        <select
          id="f-role"
          value={role}
          disabled={locked}
          onChange={(e) => onRole(e.target.value)}
          className={`${fieldInput} appearance-none`}
        >
          {roles.map((r) => (
            <option key={r.key} value={r.key}>
              {r.label}
            </option>
          ))}
        </select>
      </div>
      <div data-changed={mark("notes") || undefined} className={mark("notes") ? changedClass : undefined}>
        <label htmlFor="f-notes" className={fieldLabel}>
          Notes
        </label>
        <textarea
          id="f-notes"
          rows={notesRows(form.notes)}
          value={form.notes}
          readOnly={locked}
          onChange={(e) => onEdit("notes", e.target.value)}
          className={`${fieldInput} resize-none overflow-y-auto`}
        />
        {mark("notes") && was && <Was value={was.notes} />}
      </div>
      <div className="p-3">{speak}</div>
    </div>
  );
}
