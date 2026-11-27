"use client";

import { useRef } from "react";
import type { Todo } from "./api";
import { SAVE_FAILED, succeeded, writeFailure, writeTodo } from "./todoWrites";

/** What a screen does with each step of a tick or a reopen; the hook owns the order, the guards and the words. */
export type TodoActionHandlers = {
  estateKey: string;
  onUnauthorized(): void;
  /** False when the screen now belongs to another estate: a late reply is then dropped. */
  current(): boolean;
  /** The words for the last write that failed, or null to clear them. */
  problem(text: string | null): void;
  /** The to-do list is out of step with the server: read it again. */
  reload(): void;
  /** At once, before the server answers: the row leaves Open and joins Done. */
  ticking(todo: Todo): void;
  /** The server agreed; `saved` is its copy of the to-do. */
  ticked(saved: Todo, before: Todo): void;
  /** The server did not agree: put the row back. */
  tickFailed(todo: Todo): void;
  /** The to-do is open again (only after the server agreed). */
  reopened(back: Todo, before: Todo): void;
};

/**
 * The tick and reopen writes shared by the To do tab and a contact's profile: one write per to-do at
 * a time, the row moved at once on a tick and put back with the reason if the server does not agree.
 */
export function useTodoActions(handlers: TodoActionHandlers): { tick(t: Todo): Promise<void>; reopen(t: Todo): Promise<void> } {
  const ref = useRef(handlers);
  ref.current = handlers;
  // To-dos with a write on the way, so a second tap does not send it twice.
  const busyIds = useRef(new Set<string>());

  async function tick(t: Todo) {
    if (busyIds.current.has(t.id)) return;
    busyIds.current.add(t.id);
    const h = ref.current;
    const key = h.estateKey;
    h.problem(null);
    h.ticking(t);
    const res = await writeTodo(key, { action: "complete", id: t.id });
    busyIds.current.delete(t.id);
    if (res?.status === 401) return ref.current.onUnauthorized();
    if (!ref.current.current()) return;
    if (res && succeeded(res) && res.body && "todo" in res.body) return ref.current.ticked(res.body.todo, t);
    ref.current.tickFailed(t);
    ref.current.problem(res ? writeFailure(res.status, res.body) : SAVE_FAILED);
    if (res?.status === 404) ref.current.reload();
  }

  async function reopen(t: Todo) {
    if (busyIds.current.has(t.id)) return;
    busyIds.current.add(t.id);
    const key = ref.current.estateKey;
    ref.current.problem(null);
    const res = await writeTodo(key, { action: "reopen", id: t.id });
    busyIds.current.delete(t.id);
    if (res?.status === 401) return ref.current.onUnauthorized();
    if (!ref.current.current()) return;
    if (res && succeeded(res) && res.body && "todo" in res.body) return ref.current.reopened(res.body.todo, t);
    ref.current.problem(res ? writeFailure(res.status, res.body) : SAVE_FAILED);
    if (res?.status === 404) ref.current.reload();
  }

  return { tick, reopen };
}
