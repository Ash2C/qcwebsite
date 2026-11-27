"use client";

import { useEffect, useRef, useState } from "react";
import type { ContactTarget } from "./ContactsPanel";
import MonsoonLoader from "./MonsoonLoader";
import TodoForm, { GONE } from "./TodoForm";
import TodoRowView from "./TodoRowView";
import { loadTodos, type EstateInfo, type Nudges, type Todo } from "./api";
import { card, secondaryButton } from "./styles";
import { bucketOf, localToday, type TodoBucket } from "./todoDates";

/** Which form is open: held here so it survives a tab switch. */
type FormState = { kind: "add" } | { kind: "edit"; id: string };

/**
 * What the To do tab shows. It lives in MonsoonApp so it survives tab switches. `estate` is the CRM it
 * was read from; `ready` is null until the first reply and false for a CRM not yet set up for to-dos.
 */
export type TodosState = {
  estate: string | null;
  ready: boolean | null;
  open: Todo[];
  done: Todo[];
  nudges?: Nudges;
  form: FormState | null;
};
export const EMPTY_TODOS: TodosState = { estate: null, ready: null, open: [], done: [], form: null };

const NOT_READY = "To do is being set up for this CRM.";
const EMPTY = "Nothing to do yet. Add your first to-do.";
const LOAD_FAILED = "Could not load to-dos. Check signal.";

const GROUPS: { bucket: TodoBucket; heading: string }[] = [
  { bucket: "overdue", heading: "Overdue" },
  { bucket: "today", heading: "Today" },
  { bucket: "week", heading: "This week" },
  { bucket: "later", heading: "Later" },
  { bucket: "undated", heading: "No date" },
];

const byDue = (a: Todo, b: Todo) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "");

/** A contact's profile target for a row: the person, else the company, else its pipeline entry. */
function targetOf(todo: Todo): ContactTarget | null {
  const c = todo.contact;
  if (!c) return null;
  if (c.personId) return { personId: c.personId };
  if (c.orgId) return { orgId: c.orgId };
  return { memberId: c.memberId };
}

export default function TodoPanel({
  estate,
  state,
  onState,
  onUnauthorized,
  onOpenContact,
  onPrepare,
}: {
  estate: EstateInfo;
  state: TodosState;
  onState(next: TodosState): void;
  /** A 401 from the server: back to sign-in. */
  onUnauthorized(): void;
  onOpenContact(target: ContactTarget): void;
  onPrepare(todo: Todo): void;
}) {
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [notice, setNotice] = useState<string | null>(null);
  // The latest props, so a reply that arrives later builds on what is on screen now.
  const stateRef = useRef(state);
  stateRef.current = state;
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  // A reply for an older request (or another estate) is dropped.
  const genRef = useRef(0);

  // Rows and forms of another estate are never shown, even for the moment before its list arrives.
  const view = state.estate === estate.key ? state : EMPTY_TODOS;
  const supported = estate.todos && view.ready !== false;

  /** Applies a change to the state of this estate (or a fresh one when the stored state is another's). */
  function change(key: string, fn: (s: TodosState) => Partial<TodosState>) {
    const base = stateRef.current.estate === key ? stateRef.current : EMPTY_TODOS;
    const next = { ...base, ...fn(base), estate: key };
    stateRef.current = next;
    onStateRef.current(next);
  }

  async function load(key: string) {
    const gen = ++genRef.current;
    setPhase("loading");
    try {
      const res = await loadTodos(key);
      if (gen !== genRef.current) return;
      if (res.status === 401) return unauthorizedRef.current();
      const body = res.status === 200 ? res.body : null;
      if (body && "ready" in body) {
        if (!body.ready) {
          change(key, () => ({ ready: false, open: [], done: [], nudges: undefined, form: null }));
        } else {
          change(key, (s) => ({
            ready: true,
            open: body.open,
            done: body.done,
            nudges: body.nudges,
            // An open edit view of a to-do that is gone from the list closes.
            form: s.form?.kind === "edit" && !body.open.some((t) => t.id === (s.form as { id: string }).id) ? null : s.form,
          }));
        }
        return setPhase("ready");
      }
      setPhase("failed");
    } catch {
      if (gen === genRef.current) setPhase("failed");
    }
  }

  // Read when the tab opens and when the estate changes.
  useEffect(() => {
    if (!estate.todos) return;
    void load(estate.key);
    return () => {
      genRef.current += 1;
    };
    // load only reads refs and its argument
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estate.key, estate.todos]);

  if (!supported) {
    return <p className="px-1 text-neutral-600 dark:text-neutral-300">{NOT_READY}</p>;
  }

  const setForm = (form: FormState | null) => change(estate.key, () => ({ form }));
  const editing = view.form?.kind === "edit" ? view.open.find((t) => t.id === (view.form as { id: string }).id) : undefined;

  if (view.form?.kind === "add" || editing) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="px-1 text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          {editing ? "Edit to-do" : "New to-do"}
        </h2>
        <TodoForm
          key={editing?.id ?? "add"}
          estate={estate}
          initial={editing}
          onUnauthorized={onUnauthorized}
          onPrepare={onPrepare}
          onGone={() => {
            setNotice(GONE);
            void load(estate.key);
          }}
          onDropped={(dropped) => {
            setNotice(null);
            change(estate.key, (s) => ({ open: s.open.filter((t) => t.id !== dropped.id), form: null }));
          }}
          onDone={(saved) => {
            setNotice(null);
            if (!saved) return setForm(null);
            // The changed to-do replaces its old row (or joins the list); the groups put it where its date says.
            change(estate.key, (s) => {
              const rest = s.open.filter((t) => t.id !== saved.id);
              return { open: saved.status === "open" ? [...rest, saved] : rest, form: null };
            });
          }}
        />
      </div>
    );
  }

  const today = localToday();
  const rows = view.open;
  return (
    <div className="flex flex-col gap-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => {
            setNotice(null);
            setForm({ kind: "add" });
          }}
          className="min-h-[44px] rounded-xl bg-[#0E7FA6] px-5 text-[16px] font-semibold text-white active:bg-[#0D6A8F] dark:bg-[#6AE6FF] dark:text-[#04121A] dark:active:bg-[#3FB8D4]"
        >
          Add
        </button>
      </div>

      {notice ? (
        <p role="status" className="px-1 text-[15px] font-medium text-neutral-800 dark:text-neutral-100">
          {notice}
        </p>
      ) : null}

      {phase === "failed" ? (
        <div className="flex flex-col gap-3">
          <p role="alert" className="px-1 text-red-700 dark:text-red-300">
            {LOAD_FAILED}
          </p>
          <button type="button" onClick={() => void load(estate.key)} className={secondaryButton}>
            Retry
          </button>
        </div>
      ) : null}

      {phase === "loading" && rows.length === 0 ? (
        <p className="flex items-center gap-2 px-1 text-neutral-500 dark:text-neutral-400">
          <MonsoonLoader className="h-7 w-7" />
          Loading…
        </p>
      ) : phase === "ready" && rows.length === 0 ? (
        <p className="px-1 text-neutral-500 dark:text-neutral-400">{EMPTY}</p>
      ) : (
        GROUPS.map(({ bucket, heading }) => {
          const group = rows.filter((t) => bucketOf(t.dueDate, today) === bucket).sort(byDue);
          if (group.length === 0) return null;
          return (
            <section key={bucket} className={`flex flex-col gap-2 ${phase === "loading" ? "opacity-60" : ""}`}>
              <h3 className="px-1 text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">{heading}</h3>
              <ul className={`${card} divide-y divide-black/5 overflow-hidden dark:divide-white/10`}>
                {group.map((t) => {
                  const target = targetOf(t);
                  return (
                    <li key={t.id}>
                      <TodoRowView
                        todo={t}
                        // Ticking off is the next step; the circle is in place for it.
                        onTick={() => {}}
                        onOpen={() => {
                          setNotice(null);
                          setForm({ kind: "edit", id: t.id });
                        }}
                        onOpenContact={target ? () => onOpenContact(target) : undefined}
                      />
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}
