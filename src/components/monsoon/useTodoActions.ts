"use client";

import { useRef } from "react";
import type { Todo } from "./api";
import { usePageWrite } from "./askPage";
import { SAVE_FAILED, succeeded, writeFailure, writeTodo } from "./todoWrites";

/**
 * What a screen does with each step of a tick or a reopen; the hook owns the order, the guards and the
 * words. `key` (the estate) and `scope` are captured when the action starts and handed back, so a
 * reply that arrives after the screen moved on is dropped and never touches what is shown now.
 */
export type TodoActionHandlers = {
  estateKey: string;
  /** What the screen shows (the estate, or the estate and contact); defaults to the estate key. */
  scope?: string;
  onUnauthorized(): void;
  /** True while the screen still shows the scope the action started in. */
  current(scope: string): boolean;
  /** The words for the last write that failed, or null to clear them. */
  problem(text: string | null): void;
  /** The to-do list is out of step with the server: read it again. */
  reload(key: string): void;
  /** At once, before the server answers: the row leaves Open and joins Done. */
  ticking(todo: Todo, key: string): void;
  /** The server agreed; `saved` is its copy of the to-do. */
  ticked(saved: Todo, before: Todo, key: string): void;
  /** The server did not agree: put the row back. */
  tickFailed(todo: Todo, key: string): void;
  /** The to-do is open again (only after the server agreed). */
  reopened(back: Todo, before: Todo, key: string): void;
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
  // Each write counts as in flight for Ask (one write at a time) until it settles.
  const track = usePageWrite();

  async function tick(t: Todo) {
    if (busyIds.current.has(t.id)) return;
    busyIds.current.add(t.id);
    const h = ref.current;
    const key = h.estateKey;
    const scope = h.scope ?? key;
    h.problem(null);
    h.ticking(t, key);
    const res = await track(() => writeTodo(key, { action: "complete", id: t.id }));
    busyIds.current.delete(t.id);
    if (res?.status === 401) return ref.current.onUnauthorized();
    if (!ref.current.current(scope)) return;
    if (res && succeeded(res) && res.body && "todo" in res.body) return ref.current.ticked(res.body.todo, t, key);
    ref.current.tickFailed(t, key);
    ref.current.problem(res ? writeFailure(res.status, res.body) : SAVE_FAILED);
    if (res?.status === 404) ref.current.reload(key);
  }

  async function reopen(t: Todo) {
    if (busyIds.current.has(t.id)) return;
    busyIds.current.add(t.id);
    const h = ref.current;
    const key = h.estateKey;
    const scope = h.scope ?? key;
    h.problem(null);
    const res = await track(() => writeTodo(key, { action: "reopen", id: t.id }));
    busyIds.current.delete(t.id);
    if (res?.status === 401) return ref.current.onUnauthorized();
    if (!ref.current.current(scope)) return;
    if (res && succeeded(res) && res.body && "todo" in res.body) return ref.current.reopened(res.body.todo, t, key);
    ref.current.problem(res ? writeFailure(res.status, res.body) : SAVE_FAILED);
    if (res?.status === 404) ref.current.reload(key);
  }

  return { tick, reopen };
}
