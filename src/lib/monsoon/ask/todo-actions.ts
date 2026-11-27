// The four to-do changes Ask can propose. Each reads and signs; nothing here writes. `act` carries
// them out after the user confirms, with the to-do library.
import type { ClientBase } from "pg";
import {
  addTodo,
  completeTodo,
  dropTodo,
  editTodo,
  getTodo,
  MAX_OUTCOME,
  MAX_TODO_TITLE,
  validDay,
  type Todo,
  type Viewer,
  type WriteResult,
} from "../todos";
import { resolve, type ProposeResult, type Target } from "./actions";
import { PROPOSAL_TTL_MS, signProposal, type Binding, type Proposal } from "./proposal";

const GONE = "That to-do is no longer there.";
const BAD_DAY = "That date is not a real day.";

/** The name the user knows the to-do's contact by: the person when filed under a company. */
function contactName(todo: Todo): string | null {
  return todo.contact ? (todo.contact.aboutName ?? todo.contact.name) : null;
}

const expires = (nowMs: number) => nowMs + PROPOSAL_TTL_MS;
const signed = (proposal: Proposal): ProposeResult => ({ ok: true, signed: { proposal, signature: signProposal(proposal) } });

/** Why an open-only change cannot be proposed, or null when the to-do is open. */
function notOpen(todo: Todo): string | null {
  if (todo.status === "done") return "That to-do is already done.";
  if (todo.status === "dropped") return "That to-do was dropped.";
  return null;
}

async function open(db: ClientBase, viewer: Viewer, id: string, nowMs: number): Promise<{ todo: Todo } | { reason: string }> {
  const todo = await getTodo(db, viewer, id, new Date(nowMs).toISOString().slice(0, 10));
  if (!todo) return { reason: GONE };
  const why = notOpen(todo);
  return why ? { reason: why } : { todo };
}

export async function proposeAddTodo(
  db: ClientBase,
  bind: Binding,
  target: Target | undefined,
  title: string,
  dueDate: string | null,
  nowMs: number,
): Promise<ProposeResult> {
  const text = typeof title === "string" ? title.trim() : "";
  if (text.length < 1) return { ok: false, reason: "The to-do is empty." };
  if (text.length > MAX_TODO_TITLE) return { ok: false, reason: `The to-do is too long (limit ${MAX_TODO_TITLE} characters).` };
  if (dueDate !== null && !validDay(dueDate)) return { ok: false, reason: BAD_DAY };
  const base = { kind: "add_todo" as const, customer: bind.customer, estate: bind.estate, title: text, dueDate, expires: expires(nowMs) };
  if (!target) {
    return signed({ ...base, memberId: null, memberKind: null, memberName: null, company: null, aboutPersonId: null, about: null });
  }
  const found = await resolve(db, target);
  if (!found.ok) return found;
  const m = found.member;
  return signed({
    ...base,
    memberId: m.memberId,
    memberKind: m.memberKind,
    memberName: m.memberName,
    company: m.company,
    aboutPersonId: m.about !== null && typeof target.personId === "string" ? target.personId : null,
    about: m.about,
  });
}

export async function proposeCompleteTodo(
  db: ClientBase,
  bind: Binding,
  viewer: Viewer,
  todoId: string,
  outcome: string | null | undefined,
  nowMs: number,
): Promise<ProposeResult> {
  const text = typeof outcome === "string" ? outcome.trim() : "";
  if (text.length > MAX_OUTCOME) return { ok: false, reason: `The outcome is too long (limit ${MAX_OUTCOME} characters).` };
  const r = await open(db, viewer, todoId, nowMs);
  if ("reason" in r) return { ok: false, reason: r.reason };
  return signed({
    kind: "complete_todo",
    customer: bind.customer,
    estate: bind.estate,
    todoId: r.todo.id,
    title: r.todo.title,
    memberName: contactName(r.todo),
    outcome: text === "" ? null : text,
    expires: expires(nowMs),
  });
}

/** `toDate` null clears the date. */
export async function proposeMoveTodo(
  db: ClientBase,
  bind: Binding,
  viewer: Viewer,
  todoId: string,
  toDate: string | null,
  nowMs: number,
): Promise<ProposeResult> {
  if (toDate !== null && !validDay(toDate)) return { ok: false, reason: BAD_DAY };
  const r = await open(db, viewer, todoId, nowMs);
  if ("reason" in r) return { ok: false, reason: r.reason };
  if (r.todo.dueDate === toDate) return { ok: false, reason: "Nothing to change." };
  return signed({
    kind: "move_todo",
    customer: bind.customer,
    estate: bind.estate,
    todoId: r.todo.id,
    title: r.todo.title,
    memberName: contactName(r.todo),
    fromDate: r.todo.dueDate,
    toDate,
    expires: expires(nowMs),
  });
}

export async function proposeDropTodo(
  db: ClientBase,
  bind: Binding,
  viewer: Viewer,
  todoId: string,
  nowMs: number,
): Promise<ProposeResult> {
  const r = await open(db, viewer, todoId, nowMs);
  if ("reason" in r) return { ok: false, reason: r.reason };
  return signed({
    kind: "drop_todo",
    customer: bind.customer,
    estate: bind.estate,
    todoId: r.todo.id,
    title: r.todo.title,
    memberName: contactName(r.todo),
    expires: expires(nowMs),
  });
}

// --- carrying out -----------------------------------------------------------------------------------

type TodoProposal = Extract<Proposal, { kind: "add_todo" | "complete_todo" | "move_todo" | "drop_todo" }>;
export type TodoDone = { status: "added" | "set" | "already" | "changed" | "missing" | "invalid"; message: string };

const NOTHING = "nothing changed.";

/**
 * Carries out a verified to-do proposal for `act`. The to-do is read again first: ticked, dropped,
 * edited or gone since the card was shown, it is reported that way and left alone. The library's own
 * `already` and `missing` answers cover a change that lands between the read and the write.
 */
export async function carryOutTodo(db: ClientBase, p: TodoProposal, viewer: Viewer, today: string): Promise<TodoDone> {
  if (p.kind === "add_todo") {
    const target: Target | undefined = p.aboutPersonId ? { personId: p.aboutPersonId } : p.memberId ? { memberId: p.memberId } : undefined;
    const r = await addTodo(db, { title: p.title, dueDate: p.dueDate, target, source: "ask" }, viewer, today);
    if (r.status === "missing") return { status: "missing", message: `${p.memberName ?? "That contact"} is no longer on the pipeline; ${NOTHING}` };
    if (r.status === "invalid") return { status: "invalid", message: r.reason };
    return { status: "added", message: `Done. To-do added: ${p.title}.` };
  }

  const gone: TodoDone = { status: "missing", message: `That to-do is no longer there; ${NOTHING}` };
  const changed: TodoDone = { status: "changed", message: `${p.title} was changed in the meantime; ${NOTHING}` };
  const current = await getTodo(db, viewer, p.todoId, today);
  if (!current) return gone;
  const already = (what: string): TodoDone => ({ status: "already", message: `${p.title} is ${what}; ${NOTHING}` });
  const finish = (r: WriteResult, done: string, was: string): TodoDone => {
    if (r.status === "missing") return gone;
    if (r.status === "already") return already(was);
    if (r.status === "invalid") return { status: "invalid", message: r.reason };
    return { status: "set", message: done };
  };

  if (p.kind === "complete_todo") {
    if (current.status === "done") return already("already done");
    if (current.status === "dropped" || current.title !== p.title) return changed;
    return finish(await completeTodo(db, p.todoId, viewer, today, p.outcome ?? undefined), `Done. ${p.title} is ticked off.`, "already done");
  }
  if (p.kind === "drop_todo") {
    if (current.status === "dropped") return already("already dropped");
    if (current.status === "done" || current.title !== p.title) return changed;
    return finish(await dropTodo(db, p.todoId, viewer, today), `Done. ${p.title} dropped.`, "already dropped");
  }
  // move_todo
  if (current.status !== "open" || current.title !== p.title) return changed;
  if (current.dueDate === p.toDate) return already(p.toDate ? `already due ${p.toDate}` : "already without a date");
  if (current.dueDate !== p.fromDate) return changed;
  return finish(
    await editTodo(db, p.todoId, { dueDate: p.toDate }, viewer, today),
    p.toDate ? `Done. ${p.title} moved to ${p.toDate}.` : `Done. ${p.title} now has no date.`,
    "already moved",
  );
}
