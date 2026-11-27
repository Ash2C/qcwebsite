"use client";

import { useEffect, useRef, useState } from "react";
import type { ContactTarget } from "./ContactsPanel";
import MonsoonLoader from "./MonsoonLoader";
import NudgeList from "./NudgeList";
import TickSheet from "./TickSheet";
import TodoForm from "./TodoForm";
import TodoRowView from "./TodoRowView";
import { loadTodos, type EstateInfo, type Nudge, type Nudges, type Todo, type TodoContact, type TodoTarget } from "./api";
import { card, secondaryButton } from "./styles";
import { bucketOf, localToday, shortDate, type TodoBucket } from "./todoDates";
import { useTodoActions } from "./useTodoActions";
import { GONE, SAVE_FAILED, contactTarget, succeeded, writeFailure, writeTodo } from "./todoWrites";

/** Which form is open: held here so it survives a tab switch. An add can start with a contact filled in. */
type FormState = { kind: "add"; contact?: { target: TodoTarget; name: string } } | { kind: "edit"; id: string };

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
const UNDO_MS = 6000;

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

/** The nudge lists without a contact's no-next-step row (the contact now has a to-do). */
function withoutNoNextStep(nudges: Nudges | undefined, memberId: string | undefined): Nudges | undefined {
  if (!nudges || !memberId) return nudges;
  const rows = nudges.noNextStep.filter((n) => n.contact.memberId !== memberId);
  const gone = nudges.noNextStep.length - rows.length;
  return gone === 0 ? nudges : { ...nudges, noNextStep: rows, noNextStepTotal: Math.max(0, nudges.noNextStepTotal - gone) };
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
  // The words for the last write that failed (a tick, a reopen, a Not now).
  const [problem, setProblem] = useState<string | null>(null);
  // The to-do whose "what happened" sheet is open.
  const [sheet, setSheet] = useState<Todo | null>(null);
  const [undo, setUndo] = useState<Todo | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  async function load(key: string, allNudges = false) {
    const gen = ++genRef.current;
    setPhase("loading");
    try {
      const res = await (allNudges ? loadTodos(key, { allNudges: true }) : loadTodos(key));
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

  function clearUndo() {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = null;
    setUndo(null);
  }

  /** Only one Undo at a time: a new one replaces the old and restarts the 6 seconds. */
  function showUndo(t: Todo) {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo(t);
    undoTimer.current = setTimeout(() => {
      undoTimer.current = null;
      setUndo(null);
    }, UNDO_MS);
  }

  // Read when the tab opens and when the estate changes.
  useEffect(() => {
    // A sheet, an Undo or an error from another estate's to-dos does not carry over.
    setSheet(null);
    setProblem(null);
    clearUndo();
    if (!estate.todos) return;
    void load(estate.key);
    return () => {
      genRef.current += 1;
      clearUndo();
    };
    // load and clearUndo only read refs and their arguments
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estate.key, estate.todos]);

  /** A new to-do joins the open list, and its contact's "needs a next step" row goes. */
  function addOpen(key: string, added: Todo) {
    change(key, (s) => ({
      open: [...s.open.filter((t) => t.id !== added.id), added],
      nudges: withoutNoNextStep(s.nudges, added.contact?.memberId),
    }));
  }

  // Tick and reopen are shared with a contact's profile.
  const { tick, reopen } = useTodoActions({
    estateKey: estate.key,
    onUnauthorized: () => unauthorizedRef.current(),
    current: (key) => stateRef.current.estate === key,
    problem: setProblem,
    reload: (key) => void load(key),
    ticking: (t, key) => {
      clearUndo();
      setNotice(null);
      change(key, (s) => ({ open: s.open.filter((x) => x.id !== t.id), done: [{ ...t, status: "done" }, ...s.done.filter((x) => x.id !== t.id)] }));
    },
    ticked: (saved, t, key) => {
      change(key, (s) => ({ done: s.done.map((x) => (x.id === t.id ? saved : x)) }));
      if (t.contact) setSheet(saved);
      else showUndo(saved);
    },
    tickFailed: (t, key) =>
      change(key, (s) => ({
        done: s.done.filter((x) => x.id !== t.id),
        open: s.open.some((x) => x.id === t.id) ? s.open : [...s.open, t],
      })),
    reopened: (back, t, key) =>
      change(key, (s) => ({ done: s.done.filter((x) => x.id !== t.id), open: [...s.open.filter((x) => x.id !== t.id), back] })),
  });

  /** Not now: the row goes at once and comes back, with the reason, if the call fails. */
  async function snooze(memberId: string) {
    const key = estate.key;
    const before = stateRef.current.nudges;
    if (!before) return;
    const pull = (list: Nudge[]) => list.filter((n) => n.contact.memberId !== memberId);
    const found = (list: Nudge[]) => list.map((n, i) => ({ n, i })).filter(({ n }) => n.contact.memberId === memberId);
    const removed = { noNextStep: found(before.noNextStep), quiet: found(before.quiet) };
    setProblem(null);
    change(key, (s) =>
      s.nudges
        ? {
            nudges: {
              noNextStep: pull(s.nudges.noNextStep),
              quiet: pull(s.nudges.quiet),
              noNextStepTotal: Math.max(0, s.nudges.noNextStepTotal - removed.noNextStep.length),
              quietTotal: Math.max(0, s.nudges.quietTotal - removed.quiet.length),
            },
          }
        : {},
    );
    const res = await writeTodo(key, { action: "snooze", memberId });
    if (res?.status === 401) return unauthorizedRef.current();
    if (succeeded(res) || stateRef.current.estate !== key) return;
    const put = (list: Nudge[], back: { n: Nudge; i: number }[]) => {
      const next = [...list];
      for (const { n, i } of back) next.splice(Math.min(i, next.length), 0, n);
      return next;
    };
    change(key, (s) =>
      s.nudges
        ? {
            nudges: {
              noNextStep: put(pull(s.nudges.noNextStep), removed.noNextStep),
              quiet: put(pull(s.nudges.quiet), removed.quiet),
              noNextStepTotal: s.nudges.noNextStepTotal + removed.noNextStep.length,
              quietTotal: s.nudges.quietTotal + removed.quiet.length,
            },
          }
        : {},
    );
    setProblem(res ? writeFailure(res.status, res.body) : SAVE_FAILED);
  }

  /** A nudge's contact opens its profile, as a row's contact does. */
  function openNudgeContact(c: TodoContact) {
    onOpenContact(c.personId ? { personId: c.personId } : c.orgId ? { orgId: c.orgId } : { memberId: c.memberId });
  }

  if (!supported) {
    return <p className="px-1 text-neutral-600 dark:text-neutral-300">{NOT_READY}</p>;
  }

  const setForm = (form: FormState | null) => change(estate.key, () => ({ form }));
  const editing = view.form?.kind === "edit" ? view.open.find((t) => t.id === (view.form as { id: string }).id) : undefined;

  if (view.form?.kind === "add" || editing) {
    const prefilled = view.form?.kind === "add" ? view.form.contact : undefined;
    return (
      <div className="flex flex-col gap-4">
        <h2 className="px-1 text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          {editing ? "Edit to-do" : "New to-do"}
        </h2>
        <TodoForm
          key={editing?.id ?? `add:${prefilled?.name ?? ""}`}
          estate={estate}
          initial={editing}
          contact={prefilled}
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
              return {
                open: saved.status === "open" ? [...rest, saved] : rest,
                // A contact that now has a to-do no longer needs a next step.
                nudges: saved.status === "open" ? withoutNoNextStep(s.nudges, saved.contact?.memberId) : s.nudges,
                form: null,
              };
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

      {problem ? (
        <p role="alert" className="px-1 text-[15px] font-medium text-red-700 dark:text-red-300">
          {problem}
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
                        onTick={() => void tick(t)}
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

      {view.nudges ? (
        <NudgeList
          nudges={view.nudges}
          onAdd={(c) => {
            setNotice(null);
            setProblem(null);
            setForm({ kind: "add", contact: { target: contactTarget(c), name: c.name } });
          }}
          onSnooze={(id) => void snooze(id)}
          onShowAll={() => void load(estate.key, true)}
          onOpenContact={openNudgeContact}
        />
      ) : null}

      {view.done.length > 0 ? (
        <section className="flex flex-col gap-2">
          <button
            type="button"
            aria-expanded={doneOpen}
            onClick={() => setDoneOpen(!doneOpen)}
            className="flex min-h-[44px] items-center gap-2 px-1 text-left text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400"
          >
            <span aria-hidden="true">{doneOpen ? "▾" : "▸"}</span>
            Done (last 30 days)
          </button>
          {doneOpen ? (
            <ul className={`${card} divide-y divide-black/5 overflow-hidden dark:divide-white/10`}>
              {view.done.map((t) => (
                <li key={t.id} className="flex items-center gap-2 py-1 pl-4 pr-2">
                  <div className="flex min-w-0 flex-1 flex-col py-1">
                    <span className="break-words text-[16px] text-neutral-700 dark:text-neutral-200">{t.title}</span>
                    <span className="break-words text-[14px] text-neutral-500 dark:text-neutral-400">
                      {[t.contact?.name, t.closedAt ? shortDate(t.closedAt) : null].filter(Boolean).join(" · ")}
                    </span>
                  </div>
                  <button
                    type="button"
                    aria-label={`Reopen: ${t.title}`}
                    onClick={() => void reopen(t)}
                    className="min-h-[44px] shrink-0 rounded-xl px-3 text-[16px] font-medium text-[#0E7FA6] active:bg-neutral-100 dark:text-[#6AE6FF] dark:active:bg-white/10"
                  >
                    Reopen
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {undo ? (
        <div
          role="status"
          className="fixed inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-10 mx-auto flex max-w-md items-center justify-between gap-3 rounded-2xl bg-neutral-900 py-1 pl-4 pr-2 text-white shadow-lg dark:bg-neutral-100 dark:text-neutral-900"
        >
          <span className="break-words text-[15px]">{`Done: ${undo.title}`}</span>
          <button
            type="button"
            onClick={() => {
              const t = undo;
              clearUndo();
              void reopen(t);
            }}
            className="min-h-[44px] shrink-0 rounded-xl px-3 text-[16px] font-semibold text-[#6AE6FF] dark:text-[#0E7FA6]"
          >
            Undo
          </button>
        </div>
      ) : null}

      {sheet ? (
        <TickSheet
          estate={estate}
          todo={sheet}
          onUnauthorized={onUnauthorized}
          onClose={(result) => {
            setSheet(null);
            if (result.next) addOpen(estate.key, result.next);
          }}
        />
      ) : null}
    </div>
  );
}
