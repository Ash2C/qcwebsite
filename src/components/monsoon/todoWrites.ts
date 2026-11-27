// Helpers shared by the to-do components that write: the words for a failed write, and the target a
// new to-do for a contact is sent with.
import { todoAction, type TodoActionBody, type TodoContact, type TodoTarget } from "./api";

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

export type TodoReply = Awaited<ReturnType<typeof todoAction>> | null;

/** One to-do write; null when the call itself failed (no signal, a timeout). */
export async function writeTodo(estate: string, body: TodoActionBody): Promise<TodoReply> {
  try {
    return await todoAction(estate, body);
  } catch {
    return null;
  }
}

/** True for a write reply that succeeded (a 200 that is not an error body). */
export function succeeded(res: TodoReply): boolean {
  return !!res && res.status === 200 && !!res.body && !("error" in res.body);
}
