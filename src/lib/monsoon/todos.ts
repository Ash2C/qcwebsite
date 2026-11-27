// To-dos: the list and each write. The database keeps first_due_date, moved_count, closed_at and
// the members.next_action mirror; this file validates, resolves the contact, and leaves the
// timeline entry for each change in the same transaction. Nothing here deletes.
import type { ClientBase } from "pg";
import { resolve, transaction, type Target } from "./ask/actions";
import { actionTouches, readOnly, type ActionTouch, type MemberKind, type QueryOptions } from "./ask/queries";
import { ensureOwner } from "./owners";
import { dueBucket, lastAction, type DueBucket } from "./rules";

export const MAX_TODO_TITLE = 300;
export const MAX_OUTCOME = 2000;
export type TodoStatus = "open" | "done" | "dropped";
export type TodoSource = "app" | "ask" | "notes" | "next";
export type Viewer = { ownerKey: string; solo: boolean; appOwnerKeys: string[] };
export type TodoContact = {
  memberId: string;
  memberKind: MemberKind;
  name: string;
  company: string | null;
  personId: string | null;
  orgId: string | null; // what a tap opens
  aboutPersonId: string | null;
  aboutName: string | null;
  stage: string;
  stageLabel: string;
  priority: "high" | "medium" | "low" | null;
  lastAction: { kind: string; at: string } | null;
};
export type Todo = {
  id: string;
  title: string;
  dueDate: string | null;
  firstDueDate: string | null;
  movedCount: number;
  status: TodoStatus;
  outcome: string | null;
  closedAt: string | null;
  owner: string | null;
  mine: boolean;
  due: DueBucket;
  contact: TodoContact | null;
};
export type TodoInput = { title: string; dueDate: string | null; target?: Target; source: TodoSource };
export type WriteResult =
  | { status: "ok"; todo: Todo }
  | { status: "already"; todo: Todo } // the to-do was already in the asked-for state
  | { status: "invalid"; reason: string } // title/date/outcome failed a limit
  | { status: "missing" }; // no such to-do, or the target contact is not in the pipeline

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCES: readonly string[] = ["app", "ask", "notes", "next"];
const DEFAULT_DONE_DAYS = 30;
const DONE_LIMIT = 50;

/** True for a YYYY-MM-DD string that names a real calendar day. */
export function validDay(value: string): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === value;
}

/** True when the CRM is at schema version 2 or later, so the to-do table exists. */
export async function todosReady(db: ClientBase): Promise<boolean> {
  try {
    const r = await db.query("SELECT coalesce(max(version), 0)::int AS v FROM schema_migrations");
    return r.rows[0].v >= 2;
  } catch {
    return false;
  }
}

// --- reading -----------------------------------------------------------------------------------

const TODO_SELECT = `
  SELECT t.id, t.title, t.due_date::text AS due_date, t.first_due_date::text AS first_due_date,
         t.moved_count, t.status, t.outcome, t.closed_at, t.owner, t.about_person_id, ap.name AS about_name,
         m.id AS member_id, m.person_id, m.org_id, m.stage, s.label AS stage_label, m.priority,
         CASE WHEN m.id IS NULL THEN NULL WHEN m.person_id IS NOT NULL THEN 'person' ELSE 'company' END AS kind,
         COALESCE(p.name, o.name) AS name,
         CASE WHEN m.person_id IS NOT NULL THEN po.name END AS company
    FROM todos t
    LEFT JOIN members m ON m.id = t.member_id
    LEFT JOIN stages s ON s.key = m.stage
    LEFT JOIN people p ON p.id = m.person_id
    LEFT JOIN orgs po ON po.id = p.org_id
    LEFT JOIN orgs o ON o.id = m.org_id
    LEFT JOIN people ap ON ap.id = t.about_person_id`;

/** Builds a TodoContact from a row with the member columns (member_id, kind, name, company, ...) and its action touches. */
export function contactFromRow(row: Record<string, any>, touches: ActionTouch[]): TodoContact {
  const last = lastAction(touches);
  return {
    memberId: row.member_id,
    memberKind: row.kind,
    name: row.name,
    company: row.company ?? null,
    personId: row.person_id ?? null,
    orgId: row.org_id ?? null,
    aboutPersonId: row.about_person_id ?? null,
    aboutName: row.about_name ?? null,
    stage: row.stage,
    stageLabel: row.stage_label,
    priority: row.priority ?? null,
    lastAction: last ? { kind: last.kind, at: last.at } : null,
  };
}

/** Runs a to-do SELECT with `where`/`order`/`limit` after it and builds the Todo values. No transaction of its own. */
async function loadTodos(
  db: ClientBase,
  viewer: Viewer,
  today: string,
  tail: string,
  params: unknown[],
): Promise<Todo[]> {
  const r = await db.query(`${TODO_SELECT} ${tail}`, params);
  const ids = [...new Set(r.rows.filter((row) => row.member_id).map((row) => row.member_id as string))];
  const touches = await actionTouches(db, ids);
  return r.rows.map((row) => {
    let contact: TodoContact | null = null;
    if (row.member_id) {
      contact = contactFromRow(row, touches.get(row.member_id) ?? []);
    }
    return {
      id: row.id,
      title: row.title,
      dueDate: row.due_date ?? null,
      firstDueDate: row.first_due_date ?? null,
      movedCount: row.moved_count,
      status: row.status,
      outcome: row.outcome ?? null,
      closedAt: row.closed_at ? (row.closed_at as Date).toISOString() : null,
      owner: row.owner ?? null,
      mine: row.owner === viewer.ownerKey,
      due: dueBucket({ next_action: row.title, next_action_date: row.due_date }, today),
      contact,
    };
  });
}

async function loadOne(db: ClientBase, viewer: Viewer, id: string, today: string): Promise<Todo | null> {
  if (!UUID_RE.test(id)) return null;
  return (await loadTodos(db, viewer, today, "WHERE t.id = $1", [id]))[0] ?? null;
}

/**
 * Open to-dos in due order and recently done ones. A profile (`memberId`) lists that contact's
 * to-dos whoever owns them; otherwise a viewer in a team sees their own, unowned ones, and ones
 * whose owner key matches no app person.
 */
export function listTodos(
  db: ClientBase,
  viewer: Viewer,
  today: string,
  opts?: QueryOptions & { memberId?: string; doneDays?: number },
): Promise<{ open: Todo[]; done: Todo[] }> {
  return readOnly(
    db,
    async () => {
      const where: string[] = [];
      const params: unknown[] = [];
      const add = (value: unknown) => {
        params.push(value);
        return `$${params.length}`;
      };
      if (opts?.memberId !== undefined) {
        if (!UUID_RE.test(opts.memberId)) return { open: [], done: [] };
        where.push(`t.member_id = ${add(opts.memberId)}`);
      } else if (!viewer.solo) {
        const key = add(viewer.ownerKey);
        const keys = add(viewer.appOwnerKeys);
        where.push(`(t.owner = ${key} OR t.owner IS NULL OR t.owner <> ALL(${keys}::text[]))`);
      }
      const scope = where.length ? `${where.join(" AND ")} AND ` : "";
      const open = await loadTodos(
        db,
        viewer,
        today,
        `WHERE ${scope}t.status = 'open' ORDER BY t.due_date NULLS LAST, t.created_at, t.id`,
        params,
      );
      const days = Number.isFinite(opts?.doneDays) ? Math.max(0, Math.trunc(opts?.doneDays as number)) : DEFAULT_DONE_DAYS;
      const doneParams = [...params];
      doneParams.push(days);
      const done = await loadTodos(
        db,
        viewer,
        today,
        `WHERE ${scope}t.status = 'done' AND t.closed_at > clock_timestamp() - ($${doneParams.length}::int * interval '1 day')
         ORDER BY t.closed_at DESC, t.id LIMIT ${DONE_LIMIT}`,
        doneParams,
      );
      return { open, done };
    },
    opts,
  );
}

/** One to-do by id, whoever owns it (anyone signed in may open any to-do). */
export function getTodo(db: ClientBase, viewer: Viewer, id: string, today: string): Promise<Todo | null> {
  return readOnly(db, () => loadOne(db, viewer, id, today));
}

// --- writing -----------------------------------------------------------------------------------

type Prepared = { ok: true; title: string } | { ok: false; reason: string };

function checkTitle(title: unknown): Prepared {
  const text = typeof title === "string" ? title.trim() : "";
  if (text.length < 1) return { ok: false, reason: "The to-do is empty." };
  if (text.length > MAX_TODO_TITLE) return { ok: false, reason: `The to-do is too long (limit ${MAX_TODO_TITLE} characters).` };
  return { ok: true, title: text };
}

const BAD_DAY = "That date is not a real day.";

type Placed = { memberId: string; aboutPersonId: string | null };

/** Resolves a contact target to the member to-dos are filed under; null when it is not in the pipeline. */
async function place(db: ClientBase, target: Target): Promise<Placed | null> {
  const found = await resolve(db, target);
  if (!found.ok) return null;
  return {
    memberId: found.member.memberId,
    aboutPersonId: found.member.about !== null && typeof target.personId === "string" ? target.personId : null,
  };
}

async function timeline(db: ClientBase, todo: Todo, kind: "system" | "note", text: string, by: string): Promise<void> {
  if (!todo.contact) return;
  const prefix = todo.contact.aboutName ? `${todo.contact.aboutName}: ` : "";
  await db.query("INSERT INTO touches (member_id, kind, by_whom, summary) VALUES ($1, $2, $3, $4)", [
    todo.contact.memberId,
    kind,
    by,
    `${prefix}${text}`,
  ]);
}

export async function addTodo(db: ClientBase, input: TodoInput, viewer: Viewer, today: string): Promise<WriteResult> {
  const t = checkTitle(input?.title);
  if (!t.ok) return { status: "invalid", reason: t.reason };
  const dueDate = input.dueDate ?? null;
  if (dueDate !== null && !validDay(dueDate)) return { status: "invalid", reason: BAD_DAY };
  if (!SOURCES.includes(input.source)) return { status: "invalid", reason: "Unknown source." };
  let placed: Placed | null = null;
  if (input.target) {
    placed = await place(db, input.target);
    if (!placed) return { status: "missing" };
  }
  return transaction<WriteResult>(db, async () => {
    await ensureOwner(db, viewer.ownerKey, viewer.ownerKey);
    const ins = await db.query(
      `INSERT INTO todos (title, due_date, member_id, about_person_id, owner, source)
       VALUES ($1, $2::date, $3, $4, $5, $6) RETURNING id`,
      [t.title, dueDate, placed?.memberId ?? null, placed?.aboutPersonId ?? null, viewer.ownerKey, input.source],
    );
    const todo = (await loadOne(db, viewer, ins.rows[0].id, today)) as Todo;
    return { value: { status: "ok" as const, todo }, commit: true };
  });
}

type Locked = { status: TodoStatus; outcome: string | null };

/** Runs `fn` on the locked to-do row in one transaction; `missing` when there is no such to-do. */
function withLockedTodo(
  db: ClientBase,
  id: string,
  fn: (row: Locked) => Promise<{ value: WriteResult; commit: boolean }>,
): Promise<WriteResult> {
  if (typeof id !== "string" || !UUID_RE.test(id)) return Promise.resolve({ status: "missing" });
  return transaction<WriteResult>(db, async () => {
    const found = await db.query("SELECT status, outcome FROM todos WHERE id = $1 FOR UPDATE", [id]);
    if (found.rows.length === 0) return { value: { status: "missing" as const }, commit: false };
    return fn(found.rows[0]);
  });
}

/** Changes the status, then writes the timeline entry; `already` when it is in that state. */
function changeStatus(
  db: ClientBase,
  id: string,
  viewer: Viewer,
  today: string,
  to: TodoStatus,
  label: string,
): Promise<WriteResult> {
  return withLockedTodo(db, id, async (row) => {
    if (row.status === to) {
      const todo = (await loadOne(db, viewer, id, today)) as Todo;
      return { value: { status: "already" as const, todo }, commit: false };
    }
    await db.query("UPDATE todos SET status = $1 WHERE id = $2", [to, id]);
    const todo = (await loadOne(db, viewer, id, today)) as Todo;
    await timeline(db, todo, "system", `${label}: ${todo.title}`, viewer.ownerKey);
    return { value: { status: "ok" as const, todo }, commit: true };
  });
}

export function completeTodo(db: ClientBase, id: string, viewer: Viewer, today: string): Promise<WriteResult> {
  return changeStatus(db, id, viewer, today, "done", "To-do done");
}

export function dropTodo(db: ClientBase, id: string, viewer: Viewer, today: string): Promise<WriteResult> {
  return changeStatus(db, id, viewer, today, "dropped", "To-do dropped");
}

export function reopenTodo(db: ClientBase, id: string, viewer: Viewer, today: string): Promise<WriteResult> {
  return changeStatus(db, id, viewer, today, "open", "To-do reopened");
}

export async function setOutcome(
  db: ClientBase,
  id: string,
  outcome: string,
  viewer: Viewer,
  today: string,
): Promise<WriteResult> {
  const text = typeof outcome === "string" ? outcome.trim() : "";
  if (text.length < 1) return { status: "invalid", reason: "The outcome is empty." };
  if (text.length > MAX_OUTCOME) return { status: "invalid", reason: `The outcome is too long (limit ${MAX_OUTCOME} characters).` };
  return withLockedTodo(db, id, async (row) => {
    if (row.status !== "done") {
      return { value: { status: "invalid" as const, reason: "Only a to-do that is done can have an outcome." }, commit: false };
    }
    if (row.outcome === text) {
      const todo = (await loadOne(db, viewer, id, today)) as Todo;
      return { value: { status: "already" as const, todo }, commit: false };
    }
    await db.query("UPDATE todos SET outcome = $1 WHERE id = $2", [text, id]);
    const todo = (await loadOne(db, viewer, id, today)) as Todo;
    await timeline(db, todo, "note", `${todo.title}: ${text}`, viewer.ownerKey);
    return { value: { status: "ok" as const, todo }, commit: true };
  });
}

/**
 * Changes the title, the date or the contact. A field left out is unchanged; a null date clears
 * it and a null target takes the contact off. Leaves no timeline entry.
 */
export async function editTodo(
  db: ClientBase,
  id: string,
  patch: { title?: string; dueDate?: string | null; target?: Target | null },
  viewer: Viewer,
  today: string,
): Promise<WriteResult> {
  let title: string | undefined;
  if (patch.title !== undefined) {
    const t = checkTitle(patch.title);
    if (!t.ok) return { status: "invalid", reason: t.reason };
    title = t.title;
  }
  if (patch.dueDate !== undefined && patch.dueDate !== null && !validDay(patch.dueDate)) {
    return { status: "invalid", reason: BAD_DAY };
  }
  let placed: Placed | null | undefined;
  if (patch.target === null) placed = null;
  else if (patch.target !== undefined) {
    placed = await place(db, patch.target);
    if (!placed) return { status: "missing" };
  }
  return withLockedTodo(db, id, async () => {
    const before = (await loadOne(db, viewer, id, today)) as Todo;
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (column: string, value: unknown, cast = "") => {
      params.push(value);
      sets.push(`${column} = $${params.length}${cast}`);
    };
    if (title !== undefined && title !== before.title) set("title", title);
    if (patch.dueDate !== undefined && patch.dueDate !== before.dueDate) set("due_date", patch.dueDate, "::date");
    if (placed !== undefined) {
      const memberId = placed?.memberId ?? null;
      const about = placed?.aboutPersonId ?? null;
      if (memberId !== (before.contact?.memberId ?? null) || about !== (before.contact?.aboutPersonId ?? null)) {
        set("member_id", memberId);
        set("about_person_id", about);
      }
    }
    if (sets.length === 0) return { value: { status: "already" as const, todo: before }, commit: false };
    params.push(id);
    await db.query(`UPDATE todos SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
    const todo = (await loadOne(db, viewer, id, today)) as Todo;
    return { value: { status: "ok" as const, todo }, commit: true };
  });
}
