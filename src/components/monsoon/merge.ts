import type { ContactFields, RefineOutput } from "@/lib/monsoon/refine";

export type Snapshot = { fields: ContactFields; notes: string };

const KEYS: (keyof ContactFields)[] = ["name", "title", "org", "email", "phone", "linkedin"];

// Applies a tidy result onto what the form holds NOW. A value the model returned exactly as it
// was sent is not a change, so it never overwrites something edited while the request ran.
export function mergeRefine(current: Snapshot, sent: Snapshot, next: RefineOutput): RefineOutput {
  const fields = { ...current.fields };
  for (const k of KEYS) {
    if (next.fields[k] !== sent.fields[k]) fields[k] = next.fields[k];
  }
  return { fields, notes: next.notes !== sent.notes ? next.notes : current.notes };
}
