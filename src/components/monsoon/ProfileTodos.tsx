"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import MonsoonLoader from "./MonsoonLoader";
import TickSheet from "./TickSheet";
import TodoForm from "./TodoForm";
import TodoRowView from "./TodoRowView";
import { loadTodos, type EstateInfo, type Todo, type TodoTarget } from "./api";
import { card, secondaryButton } from "./styles";
import { shortDate } from "./todoDates";
import { GONE } from "./todoWrites";
import { useTodoActions } from "./useTodoActions";

const LOAD_FAILED = "Could not load to-dos. Check signal.";
const heading = "px-1 text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400";

type Form = { kind: "add" } | { kind: "edit"; id: string };
type Phase = "loading" | "ready" | "failed" | "unsupported";

// Dated to-dos by date, then the undated ones.
const byDue = (a: Todo, b: Todo) => (a.dueDate && b.dueDate ? a.dueDate.localeCompare(b.dueDate) : Number(!a.dueDate) - Number(!b.dueDate));

// A contact's To do section on its profile: its open to-dos with a circle to tick, Add, and the done
// ones behind a Done fold. Ticking, adding and editing work as they do on the To do tab (the same
// row, form and what-happened sheet), and write on the first tap.
//
// A profile always lists the to-dos of the member it shows, whoever owns them. A person filed under
// a company has the company's member, so that member's to-dos include ones about other people there:
// those are left out here, and the to-dos about this person or about nobody in particular stay.
// On a company profile every to-do is listed, with the person it is about named on the row.
export default function ProfileTodos({
  estate,
  memberId,
  target,
  name,
  onPrepare,
  onUnauthorized,
  reloadSignal,
}: {
  estate: EstateInfo;
  memberId: string;
  /** What a new to-do is aimed at: this profile's person, or its company's pipeline entry. */
  target: TodoTarget;
  name: string;
  onPrepare?(todo: Todo): void;
  onUnauthorized?(): void;
  /** A change to this number reads the to-dos again. */
  reloadSignal?: number;
}) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [open, setOpen] = useState<Todo[]>([]);
  const [done, setDone] = useState<Todo[]>([]);
  const [form, setForm] = useState<Form | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Todo | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;
  // The estate and contact on screen, so a write that ends after they changed is dropped.
  const scope = `${estate.key}|${memberId}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  useEffect(() => {
    let live = true;
    setPhase((p) => (p === "ready" ? p : "loading"));
    loadTodos(estate.key, { member: memberId }).then(
      (res) => {
        if (!live) return;
        if (res.status === 401) return unauthorizedRef.current?.();
        const body = res.status === 200 ? res.body : null;
        if (body && "ready" in body) {
          if (!body.ready) return setPhase("unsupported");
          setOpen(body.open);
          setDone(body.done);
          // An edit view of a to-do that is gone from the list closes.
          setForm((f) => (f?.kind === "edit" && !body.open.some((t) => t.id === f.id) ? null : f));
          return setPhase("ready");
        }
        setPhase("failed");
      },
      () => {
        if (live) setPhase("failed");
      },
    );
    return () => {
      live = false;
    };
  }, [estate.key, memberId, tick, reloadSignal]);

  const { tick: tickOff, reopen } = useTodoActions({
    estateKey: estate.key,
    scope,
    onUnauthorized: () => unauthorizedRef.current?.(),
    current: (started) => scopeRef.current === started,
    problem: setProblem,
    reload,
    ticking: (t) => {
      setNotice(null);
      setOpen((l) => l.filter((x) => x.id !== t.id));
      setDone((l) => [{ ...t, status: "done" }, ...l.filter((x) => x.id !== t.id)]);
    },
    ticked: (saved, t) => {
      setDone((l) => l.map((x) => (x.id === t.id ? saved : x)));
      setSheet(saved);
    },
    tickFailed: (t) => {
      setDone((l) => l.filter((x) => x.id !== t.id));
      setOpen((l) => (l.some((x) => x.id === t.id) ? l : [...l, t]));
    },
    reopened: (back, t) => {
      setDone((l) => l.filter((x) => x.id !== t.id));
      setOpen((l) => [...l.filter((x) => x.id !== t.id), back]);
    },
  });

  if (phase === "unsupported") return null;

  const personId = target.personId;
  // Someone else's to-do under a shared company member is not this person's.
  const mine = (t: Todo) => !personId || !t.contact?.aboutPersonId || t.contact.aboutPersonId === personId;
  const aboutOther = (t: Todo) => (t.contact?.aboutPersonId && t.contact.aboutPersonId !== personId ? t.contact.aboutName : null);
  const rows = open.filter(mine).sort(byDue);
  const doneRows = done.filter(mine);
  const editing = form?.kind === "edit" ? open.find((t) => t.id === form.id) : undefined;

  if (form?.kind === "add" || editing) {
    return (
      <section className="flex flex-col gap-3">
        <h3 className={heading}>{editing ? "Edit to-do" : "New to-do"}</h3>
        <TodoForm
          key={editing?.id ?? "add"}
          estate={estate}
          initial={editing}
          contact={form?.kind === "add" ? { target, name } : undefined}
          onUnauthorized={onUnauthorized}
          onPrepare={onPrepare}
          onGone={() => {
            setNotice(GONE);
            reload();
          }}
          onDropped={(dropped) => {
            setNotice(null);
            setOpen((l) => l.filter((t) => t.id !== dropped.id));
            setForm(null);
          }}
          onDone={(saved) => {
            setNotice(null);
            setForm(null);
            if (saved) setOpen((l) => (saved.status === "open" ? [...l.filter((t) => t.id !== saved.id), saved] : l.filter((t) => t.id !== saved.id)));
          }}
        />
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <h3 className={heading}>To do</h3>
        <button
          type="button"
          onClick={() => {
            setNotice(null);
            setProblem(null);
            setForm({ kind: "add" });
          }}
          className="min-h-[44px] rounded-xl px-3 text-[16px] font-semibold text-[#0E7FA6] active:bg-neutral-100 dark:text-[#6AE6FF] dark:active:bg-white/10"
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
          <button type="button" onClick={reload} className={secondaryButton}>
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
        <p className="px-1 text-neutral-500 dark:text-neutral-400">{`Nothing to do for ${name} yet.`}</p>
      ) : rows.length > 0 ? (
        <ul className={`${card} divide-y divide-black/5 overflow-hidden dark:divide-white/10`}>
          {rows.map((t) => (
            <li key={t.id}>
              <TodoRowView
                todo={t}
                inProfile
                aboutName={aboutOther(t)}
                onTick={() => void tickOff(t)}
                onOpen={() => {
                  setNotice(null);
                  setForm({ kind: "edit", id: t.id });
                }}
              />
            </li>
          ))}
        </ul>
      ) : null}

      {doneRows.length > 0 ? (
        <>
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
              {doneRows.map((t) => (
                <li key={t.id} className="flex items-center gap-2 py-1 pl-4 pr-2">
                  <div className="flex min-w-0 flex-1 flex-col py-1">
                    <span className="break-words text-[16px] text-neutral-700 dark:text-neutral-200">{t.title}</span>
                    {t.closedAt ? <span className="text-[14px] text-neutral-500 dark:text-neutral-400">{shortDate(t.closedAt)}</span> : null}
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
        </>
      ) : null}

      {sheet ? (
        <TickSheet
          estate={estate}
          todo={sheet}
          onUnauthorized={onUnauthorized}
          onClose={(result) => {
            setSheet(null);
            if (result.next) {
              const next = result.next;
              setOpen((l) => [...l.filter((t) => t.id !== next.id), next]);
            }
          }}
        />
      ) : null}
    </section>
  );
}
