// Helpers shared by the to-do components that write: the words for a failed write, and the target a
// new to-do for a contact is sent with.
import type { TodoContact, TodoTarget } from "./api";

export const GONE = "That to-do is no longer there.";
export const SAVE_FAILED = "Could not save. Check signal.";

/** The words for a write that did not succeed; "" when the reply was not a failure (so the caller carries on). */
export function writeFailure(status: number, body: unknown): string {
  if (status === 404) return GONE;
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  if (typeof error === "string" && error.trim() !== "") return error;
  return SAVE_FAILED;
}

/** The target a new to-do for this contact is sent with: the person it is about, else the contact's person, else the pipeline entry. */
export function contactTarget(c: TodoContact): TodoTarget {
  const personId = c.aboutPersonId ?? c.personId;
  return personId ? { personId } : { memberId: c.memberId };
}
