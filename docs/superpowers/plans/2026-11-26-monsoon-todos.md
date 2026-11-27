# Monsoon To do Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a to-do list to Monsoon: a To do tab, to-dos on profiles, in Ask and from spoken notes, tick-off that records what happened and what is next, and nudges for contacts with no next step.

**Architecture:** A new `todos` table (CRM schema version 2) owned by the Quantcloud core is the single source of truth. Database triggers keep the old `members.next_action` in step with the earliest open to-do and convert old-style direct writes into to-dos. The web app gets a `todos` library, one API route, four signed proposal kinds for Ask, and a third tab.

**Tech Stack:** PostgreSQL 16 (plpgsql triggers), Python 3.13 + psycopg + pytest (core), Next.js + TypeScript + node-pg + vitest (QCwebsite), Anthropic SDK (existing calls only).

**Spec:** `docs/superpowers/specs/2026-11-26-monsoon-todos-design.md` (in the QCwebsite main checkout, untracked; copy it into the worktree and commit it with Task 3).

## Global Constraints

- Two repos. Core: `C:\Dev\Quantcloud\core` (branch `master`). App: `C:\Dev\Quantcloud\QCwebsite` (`origin/main`, ecf1c87 or later). Work in fresh git worktrees on branch `monsoon-todos` in each; never in the main checkouts (QCwebsite's is 55 commits behind and holds untracked folders that break `tsc`, `vitest` and `next build`).
- QCwebsite is a PUBLIC repo and a push to `main` deploys. No secrets in commits. Do not push `main`; Task 14 is the rollout and needs Vincent.
- The app never deletes: no `DELETE`, no `TRUNCATE` on any CRM table in app code (`no-delete.test.ts` must stay green). A to-do is `open`, `done` or `dropped`.
- The schema SQL names no schema (`public.` never appears): client CRMs are built with `search_path` set to `c_<customer id>`.
- Limits: to-do title 1 to 300 characters after trim; outcome up to 2000; offered to-dos from spoken notes at most 5; nudge lists 10 per page; `Not now` = 14 days; Gone quiet = 30 days (high), 60 days (medium).
- Dates are `YYYY-MM-DD` strings; "today" comes from `resolveToday` (`src/lib/monsoon/today.ts`); buckets from `dueBucket` (`src/lib/monsoon/rules.ts`).
- First tap, no confirm, for the user's own add, tick, edit, move, drop, reopen. Everything the assistant proposes in Ask goes through a signed proposal and a confirm.
- Model ids: nothing new. Refine keeps `account.model()`; Ask keeps its model.
- App database tests: `docker start monsoon-test` (port 55433). If another session is using it, start a private one: `docker run -d --name monsoon-test-todos -e POSTGRES_PASSWORD=test -p 55434:5432 postgres:16-alpine` and prefix runs with `MONSOON_TEST_DB=postgresql://postgres:test@127.0.0.1:55434/postgres` (the first run may time out creating databases; run again). Core database tests start their own container on 55432 (`tests/crm/conftest.py`).
- Commit messages follow the repo's style: `feat(monsoon): <plain sentence>`. End each with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.

## Review Focus

1. A CRM still at version 1 (not yet upgraded): every existing screen must work, the To do tab says "To do is being set up for this CRM.", no route throws. Test in Task 7.
2. Old code writing `members.next_action` directly while to-dos exist (the live app before the push, core `set_next`): it must become a to-do change, never be silently overwritten. Tests in Task 1.
3. A to-do whose owner is null or an owner key no app person has (migrated Traxo and Zero One rows): it must still appear in the tab. Test in Task 5.
4. Ticking the same to-do twice (double tap, two devices): one `To-do done` timeline entry, second call answers `already`. Test in Task 5.
5. A spoken date the model returns malformed or in the past ("2026-13-45", "Friday"): the to-do is still offered, with no date. Test in Task 9.

---

## File Structure

Core:
- Create `quantcloud/crm/schema/0002_todos.sql`, `quantcloud/crm/schema/expected_v2.json`, `tests/crm/test_todos.py`
- Modify `quantcloud/crm/migrate.py`, `quantcloud/crm/db.py`, `tests/crm/test_db_merge.py`

QCwebsite:
- Create `src/lib/monsoon/testing/0002_todos.sql` (copied), `src/lib/monsoon/todos.ts`, `src/lib/monsoon/nudges.ts`, `src/lib/monsoon/ask/todo-actions.ts`, `src/app/api/monsoon/todos/route.ts`, `src/components/monsoon/TodoPanel.tsx`, `TodoRowView.tsx`, `TodoForm.tsx`, `TickSheet.tsx`, `NudgeList.tsx`, `ProfileTodos.tsx`, `OfferedTodos.tsx`, each with its test file
- Modify `scripts/monsoon/gen_rule_fixtures.py`, `scripts/monsoon/gen_setup_schema.mjs`, `scripts/monsoon/admin-commands.ts`, `src/lib/monsoon/accounts/setup-script.ts`, `setup-check.ts`, `src/lib/monsoon/testing/db.ts`, `src/lib/monsoon/ask/{proposal,actions,tools,queries}.ts`, `src/lib/monsoon/{refine,capture}.ts`, `src/app/api/monsoon/{propose,act,refine,save,estates}/route.ts`, `src/components/monsoon/{api.ts,MonsoonApp.tsx,ProfileView.tsx,ProfileActions.tsx,ChangeCard.tsx,AskPanel.tsx,BatchReview.tsx,SpeakNotes.tsx}` and the capture form in `MonsoonApp.tsx`

---

### Task 1: Core schema version 2 (table, triggers, migration of next actions)

**Files:**
- Create: `core/quantcloud/crm/schema/0002_todos.sql`, `core/quantcloud/crm/schema/expected_v2.json`, `core/tests/crm/test_todos.py`
- Modify: `core/quantcloud/crm/migrate.py`, `core/tests/crm/test_migrate.py`

**Interfaces:**
- Produces: table `todos` and column `members.nudge_after` exactly as spec section 5.1; trigger functions `todos_dates()`, `todos_sync_member()`, `members_next_action_guard()`; `migrate.latest_version() == 2`.

- [ ] **Step 1: Write failing tests in `tests/crm/test_todos.py`** (use the `crm` fixture; `m` = a member made with `crm.add_member`). Helper `nxt(m)` returns `(next_action, next_action_date)` re-read from `members`; helper `add(title, due=None, member=m, status="open")` inserts into `todos` with `source='app'` and returns the id.

```python
def test_mirror_is_earliest_open_dated_first(crm, m):
    add("undated"); add("later", "2026-12-10"); add("sooner", "2026-12-01")
    assert nxt(m) == ("sooner", date(2026, 12, 1))

def test_mirror_follows_done_reopen_and_none(crm, m):
    a = add("only", "2026-12-01")
    set_status(a, "done");  assert nxt(m) == (None, None)
    set_status(a, "open");  assert nxt(m) == ("only", date(2026, 12, 1))

def test_mirror_updates_both_members_when_todo_moves(crm, m, m2): ...
    # after UPDATE todos SET member_id = m2: nxt(m) == (None, None); nxt(m2) == ("only", ...)

def test_direct_write_with_no_open_todo_adds_one(crm, m):
    crm.set_next(m, "Call back", "2026-12-03")
    rows = open_todos(m)
    assert [(r["title"], r["due_date"], r["source"]) for r in rows] == [("Call back", date(2026, 12, 3), "core")]

def test_direct_write_replaces_earliest_open_todo(crm, m):
    a = add("old", "2026-12-01"); b = add("other", "2026-12-20")
    crm.set_next(m, "new", "2026-12-05")
    assert title_of(a) == "new" and due_of(a) == date(2026, 12, 5) and title_of(b) == "other"

def test_direct_clear_drops_earliest_and_mirror_shows_the_next(crm, m):
    a = add("first", "2026-12-01"); add("second", "2026-12-20")
    crm.set_next(m, None, None)
    assert status_of(a) == "dropped" and nxt(m) == ("second", date(2026, 12, 20))

def test_insert_member_with_next_action_makes_a_todo(crm): ...   # add_member(..., next_action="x")
def test_first_due_date_and_moved_count(crm, m):
    a = add("x")                       # no date: first_due_date None, moved_count 0
    set_due(a, "2026-12-01")           # first_due_date 2026-12-01, moved_count 0
    set_due(a, "2026-12-08")           # later: moved_count 1
    set_due(a, "2026-12-03")           # earlier: moved_count stays 1, first_due_date unchanged
def test_closed_at_set_on_done_or_dropped_and_cleared_on_reopen(crm, m): ...
def test_status_check_rejects_other_values(crm, m): ...
```

In `test_migrate.py` add `test_v2_turns_existing_next_actions_into_todos`: migrate to version 1 only (apply `0001` by hand and insert version 1), give one member `next_action='Send deck'`, date `2026-12-01`, owner `spec`'s first owner, one member a blank `'  '`, then `migrate(conn, spec)`; assert `applied == [2]`, exactly one todo `(title 'Send deck', due 2026-12-01, source 'migrated', owner as the member's, status 'open')`, and that executing the file's text a second time adds no second todo. Add `test_verify_schema_clean_after_v2` (`verify_schema(conn) == []`).

- [ ] **Step 2: Run** `py -3.13 -m pytest tests/crm/test_todos.py tests/crm/test_migrate.py -q` — expected: fail, relation "todos" does not exist.

- [ ] **Step 3: Write `0002_todos.sql`.** Everything idempotent (`IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP TRIGGER IF EXISTS`), no schema names. Contents, in order:
  1. `ALTER TABLE members ADD COLUMN IF NOT EXISTS nudge_after DATE;`
  2. `CREATE TABLE IF NOT EXISTS todos` with the spec 5.1 columns; `title` CHECK `length(btrim(title)) BETWEEN 1 AND 300`; `source` CHECK in the six values; the three indexes; RLS enabled; `set_updated_at` trigger like the other tables.
  3. `todos_dates()` BEFORE INSERT OR UPDATE: on insert `first_due_date := due_date`; on update, when `first_due_date IS NULL AND NEW.due_date IS NOT NULL` set it; when both old and new dates are non-null and new > old, `moved_count := moved_count + 1`; when status changes to `done`/`dropped` set `closed_at := now()`; when it changes to `open` set `closed_at := NULL`.
  4. `todos_sync_member()` AFTER INSERT OR UPDATE: for `NEW.member_id` and, when different, `OLD.member_id` (each when non-null), set that member's `next_action, next_action_date` to the row from `SELECT title, due_date FROM todos WHERE member_id = $1 AND status = 'open' ORDER BY due_date NULLS LAST, created_at, id LIMIT 1` (both NULL when none). Use `IS DISTINCT FROM` so an unchanged member is not rewritten.
  5. `members_next_action_guard()` AFTER INSERT OR UPDATE OF `next_action, next_action_date` ON members: `IF pg_trigger_depth() > 1 THEN RETURN NEW;` then, on update, return unless either column `IS DISTINCT FROM` its old value. Blank-or-null text = cleared. Set: update the earliest open todo's `title, due_date` if one exists, else insert `(title, due_date, member_id, owner = NEW.owner, source = 'core')`. Cleared: set the earliest open todo to `dropped` if one exists. (The to-do trigger then rewrites the mirror at depth 2, which this guard ignores.)
  6. Migration of existing data: `INSERT INTO todos (title, due_date, member_id, owner, source) SELECT btrim(next_action), next_action_date, id, owner, 'migrated' FROM members m WHERE btrim(coalesce(next_action, '')) <> '' AND NOT EXISTS (SELECT 1 FROM todos t WHERE t.member_id = m.id AND t.status = 'open');` Titles over 300 characters are cut with `left(..., 300)`.

- [ ] **Step 4: Modify `migrate.py`:** add `"todos"` to `CORE_TABLES`; `LOOKUP_USES["owners"]` gains `("todos", "owner")`; `expected_shape()` and `write_expected()` use `SCHEMA_DIR / f"expected_v{latest_version()}.json"`. Generate `expected_v2.json` by calling `write_expected(conn)` on a freshly migrated test database (a one-off `py -3.13 -c` against the test container), and commit the file. Keep `expected_v1.json`.

- [ ] **Step 5: Run** `py -3.13 -m pytest tests/crm -q` — expected: all pass (existing tests that count tables or name `expected_v1.json` are updated to the new values in this step).

- [ ] **Step 6: Commit** `feat(crm): schema version 2 - to-dos, with the next action kept in step`.

### Task 2: Core merge carries to-dos

**Files:** Modify `core/quantcloud/crm/db.py` (`plan_merge_members`, `merge_members`), `core/tests/crm/test_db_merge.py`

**Interfaces:** Produces: `plan_merge_members(...)` result gains `"todos": <count moved>`; `merge_members` moves every todo (any status) of the dropped member to the kept member before removing it.

- [ ] **Step 1: Failing test** `test_merge_members_moves_todos`: dropped member has one open (`due 2026-12-01`) and one done todo; after `merge_members(keep, drop)`: both rows have `member_id == keep`, none has NULL, `crm.get_member(keep)["next_action"]` is the open one's title, and `plan_merge_members(keep, drop)["todos"] == 2` when asked beforehand.
- [ ] **Step 2: Run** `py -3.13 -m pytest tests/crm/test_db_merge.py -q` — fail.
- [ ] **Step 3: Implement** with one `UPDATE todos SET member_id = %s WHERE member_id = %s` inside the existing merge transaction, before the delete. `set_next` stays as it is: the guard trigger converts it.
- [ ] **Step 4: Run** `py -3.13 -m pytest tests/crm -q` — pass.
- [ ] **Step 5: Commit** `feat(crm): merging two members moves their to-dos to the kept one`.

### Task 3: App carries schema version 2 (copy, generated schema, grants, test database)

**Files:**
- Modify: `scripts/monsoon/gen_rule_fixtures.py`, `scripts/monsoon/gen_setup_schema.mjs`, `src/lib/monsoon/accounts/setup-script.ts`, `src/lib/monsoon/accounts/setup-check.ts`, `src/lib/monsoon/testing/db.ts`, `src/app/api/monsoon/estates/route.ts`, `src/components/monsoon/api.ts`
- Create: `src/lib/monsoon/testing/0002_todos.sql` (written by the generator), regenerated `src/lib/monsoon/accounts/crm-schema.generated.ts`
- Test: `src/lib/monsoon/accounts/setup-script.db.test.ts`, `setup-check.db.test.ts`, `isolation.db.test.ts`

**Interfaces:**
- Produces: `CRM_SCHEMA_SQL` (all schema files joined in order) and `CRM_LATEST_VERSION = 2` exported from `crm-schema.generated.ts`; `TODO_TABLE = "todos"` and `MONSOON_TABLES_V2: readonly string[]` (the eleven plus `todos`) from `setup-script.ts` (`MONSOON_TABLES` stays the eleven); `todoGrantStatements(roleName: string, schema: string): string` (select, insert, update grants and policies on `todos` for an existing login, safe to repeat); `EstateInfo.todos: boolean` (true when the CRM's version is 2 or more) returned by `/api/monsoon/estates`.

- [ ] **Step 1: Failing tests.** In `setup-script.db.test.ts`: a CRM built with `setupStatements` has `max(version) = 2`, a `todos` table, and the restricted login can `INSERT` and `UPDATE` a todo, cannot `DELETE` one (`42501`). In `setup-check.db.test.ts`: `runSetupChecks` passes on a version 2 CRM, still passes on a CRM built from `0001_init.sql` alone at version 1, and fails with `"tables"` on a CRM that says version 2 but has no `todos`. In `isolation.db.test.ts`: a client login cannot read another client's `todos`.
- [ ] **Step 2: Run** `npx vitest run src/lib/monsoon/accounts` — fail.
- [ ] **Step 3: Generators.** `gen_rule_fixtures.py`: where it copies `0001_init.sql`, copy every `NNNN_*.sql` from the core's schema folder (same header comment). `gen_setup_schema.mjs`: read every `testing/NNNN_*.sql` in order, join with a blank line, export `CRM_SCHEMA_SQL` and `CRM_LATEST_VERSION` (the highest number). Run both: `py -3.13 scripts/monsoon/gen_rule_fixtures.py` (with the core worktree from Task 1 on `PYTHONPATH`) then `node scripts/monsoon/gen_setup_schema.mjs`.
- [ ] **Step 4: `setup-script.ts`.** `schemaStatements()` and `setupStatements()` insert every version from 1 to `CRM_LATEST_VERSION`. Policies and grants are emitted for `MONSOON_TABLES_V2`; `todos` joins `INSERT_TABLES` and `UPDATE_TABLES`. Add `todoGrantStatements`. `setup-check.ts`: read the version first; require `MONSOON_TABLES` at version 1 and `MONSOON_TABLES_V2` at 2 or more; the delete/truncate backstop covers whichever list applies. `CRM_SCHEMA_VERSION` in `account.ts` stays `1`.
- [ ] **Step 5: `testing/db.ts`** builds test CRMs from `CRM_SCHEMA_SQL` semantics: apply every `testing/NNNN_*.sql` in order. Export `makeV1TestDb(name)` that applies only `0001_init.sql` (used by Tasks 4 and 7).
- [ ] **Step 6: `estates/route.ts`** adds `todos: version >= 2` to each connected pipeline; add the field to `EstateInfo` in `components/monsoon/api.ts`.
- [ ] **Step 7: Run** `npx vitest run` and `npx tsc --noEmit` — pass (fix any test that asserted eleven tables or version 1 for a new CRM).
- [ ] **Step 8: Commit** (with the spec file) `feat(monsoon): new CRMs are built at schema version 2 with the to-do table`.

### Task 4: Admin `upgrade` command

**Files:** Modify `scripts/monsoon/admin-commands.ts`; Test `scripts/monsoon/admin.db.test.ts`

**Interfaces:**
- Consumes: `CRM_LATEST_VERSION`, `todoGrantStatements`, `makeV1TestDb` (Task 3).
- Produces: `upgrade <code> <pipeline> [--owner-password-from-env NAME]` and `upgrade --all-shared`. For a pipeline in the shared project it connects with `MONSOON_SHARED_DB_ADMIN_URL`, runs inside one transaction with `SET LOCAL search_path TO <schema>`, applies each `testing/NNNN_*.sql` whose number is above the CRM's `max(version)`, inserts the version rows, runs `todoGrantStatements(role, schema)`. For a pipeline with its own project it builds the owner connection the way `host` does (project ref and pooler on file, password from the named env variable in `monsoon-accounts.env`). Prints one line per CRM: `<code>/<pipeline>: 1 -> 2` or `already at 2`. Exit code 1 if any CRM failed; the others are still attempted.

- [ ] **Step 1: Failing tests:** `upgrade` on a version 1 CRM with one member holding `next_action='Send deck'` leaves `max(version) = 2`, one migrated todo, and the restricted login able to insert a todo and unable to delete one; running it again prints `already at 2` and adds nothing; a pipeline with its own project and no `--owner-password-from-env` exits 1 with `This pipeline has its own database: pass --owner-password-from-env.`; refuses Traxo/Zero One style pipelines with no project on file (`project_ref` NULL and not shared) with `This CRM is upgraded by the Quantcloud core, not here.`
- [ ] **Step 2: Run** `npx vitest run scripts/monsoon/admin.db.test.ts` — fail.
- [ ] **Step 3: Implement** the `case "upgrade"` branch and add it to `usage`.
- [ ] **Step 4: Run** the file again — pass.
- [ ] **Step 5: Commit** `feat(monsoon): admin upgrade brings an existing client CRM to the newest schema`.

### Task 5: `todos.ts` - reads and writes

**Files:** Create `src/lib/monsoon/todos.ts`, `src/lib/monsoon/todos.db.test.ts`

**Interfaces:**
- Consumes: `Target` from `ask/actions.ts`; `MemberKind`, `QueryOptions`, `readOnly` from `ask/queries.ts`; `dueBucket`, `lastAction`, `DueBucket` from `rules.ts`.
- Produces:

```ts
export const MAX_TODO_TITLE = 300;
export const MAX_OUTCOME = 2000;
export type TodoStatus = "open" | "done" | "dropped";
export type TodoSource = "app" | "ask" | "notes" | "next";
export type Viewer = { ownerKey: string; solo: boolean; appOwnerKeys: string[] };
export type TodoContact = {
  memberId: string; memberKind: MemberKind; name: string; company: string | null;
  personId: string | null; orgId: string | null;          // what a tap opens
  aboutPersonId: string | null; aboutName: string | null;
  stage: string; stageLabel: string; priority: "high" | "medium" | "low" | null;
  lastAction: { kind: string; at: string } | null;
};
export type Todo = {
  id: string; title: string; dueDate: string | null; firstDueDate: string | null; movedCount: number;
  status: TodoStatus; outcome: string | null; closedAt: string | null; owner: string | null;
  mine: boolean; due: DueBucket; contact: TodoContact | null;
};
export type TodoInput = { title: string; dueDate: string | null; target?: Target; source: TodoSource };
export type WriteResult =
  | { status: "ok"; todo: Todo }
  | { status: "already"; todo: Todo }          // the to-do was already in the asked-for state
  | { status: "invalid"; reason: string }       // title/date/outcome failed a limit
  | { status: "missing" };                      // no such to-do, or the target contact is not in the pipeline

export function todosReady(db: ClientBase): Promise<boolean>;                 // max(version) >= 2
export function listTodos(db: ClientBase, viewer: Viewer, today: string,
  opts?: QueryOptions & { memberId?: string; doneDays?: number }): Promise<{ open: Todo[]; done: Todo[] }>;
export function getTodo(db: ClientBase, viewer: Viewer, id: string, today: string): Promise<Todo | null>;
export function addTodo(db: ClientBase, input: TodoInput, viewer: Viewer, today: string): Promise<WriteResult>;
export function completeTodo(db: ClientBase, id: string, viewer: Viewer, today: string): Promise<WriteResult>;
export function setOutcome(db: ClientBase, id: string, outcome: string, viewer: Viewer, today: string): Promise<WriteResult>;
export function editTodo(db: ClientBase, id: string,
  patch: { title?: string; dueDate?: string | null; target?: Target | null }, viewer: Viewer, today: string): Promise<WriteResult>;
export function dropTodo(db: ClientBase, id: string, viewer: Viewer, today: string): Promise<WriteResult>;
export function reopenTodo(db: ClientBase, id: string, viewer: Viewer, today: string): Promise<WriteResult>;
export function validDay(value: string): boolean;   // a real calendar day written YYYY-MM-DD
```

Rules the tests pin:
- Visibility: `viewer.solo` sees every to-do; otherwise `owner = viewer.ownerKey OR owner IS NULL OR owner <> ALL(appOwnerKeys)`. With `opts.memberId` (a profile) no owner filter at all. `mine` is `owner === viewer.ownerKey`.
- Order of `open`: overdue, today, week, later, undated; inside a bucket by date then creation. `done`: `status = 'done'` closed within `doneDays` (default 30), newest first, at most 50. Dropped to-dos are not listed.
- Target resolution reuses how `ask/actions.ts` resolves a `Target`: a person filed under a member company gives `member_id` = the company's member and `about_person_id` = the person. A target that resolves to nothing gives `missing`.
- Timeline entries (spec 5.3), each in the same transaction as the write, `by_whom = viewer.ownerKey`, only when the to-do has a member; text is prefixed with the about-person's name and `: ` when there is one:
  - complete: kind `system`, `To-do done: <title>`
  - setOutcome: kind `note`, `<title>: <outcome>`; stores `todos.outcome`; allowed only on a done to-do; a second identical outcome answers `already` and writes nothing
  - drop: `system`, `To-do dropped: <title>`; reopen: `system`, `To-do reopened: <title>`
  - add, edit: no entry
- Writes take the row `FOR UPDATE` first; completing a done to-do, dropping a dropped one or reopening an open one answers `already` with no entry.
- New to-dos get `owner = viewer.ownerKey` (the owner row exists for a signed-in person; use `ensureOwner` from `owners.ts` as the save route does).

- [ ] **Step 1: Write failing tests** in `todos.db.test.ts` (pattern of `contacts.db.test.ts`), one `it` per rule above, including:

```ts
it("lists a to-do with no owner and one with an unknown owner key to a non-solo viewer", ...)
it("ticking twice writes one 'To-do done' entry and answers already the second time", ...)
it("a to-do for a person under a member company goes on the company's member, with the person's name first on the timeline", ...)
it("a to-do with no contact writes no timeline entry and keeps its outcome on the row", ...)
it("an outcome entry is kind note, so lastAction counts it; the done entry is system and does not", ...)
it("moving the date later twice shows movedCount 2 and the first date kept", ...)
it("rejects an empty title, a 301-character title, and 2026-02-30 as a date with status invalid", ...)
it("after adding, ticking and reopening, members.next_action matches the earliest open to-do", ...)
```

- [ ] **Step 2: Run** `npx vitest run src/lib/monsoon/todos.db.test.ts` — fail (module missing).
- [ ] **Step 3: Implement** `todos.ts`. One SELECT builds `Todo` rows (join members, people, orgs, stages; last action from `touches` for the listed members, as `actionTouches` does in `queries.ts`).
- [ ] **Step 4: Run** the file and `npx vitest run src/lib/monsoon/no-delete.test.ts` — pass.
- [ ] **Step 5: Commit** `feat(monsoon): to-do reads and writes, each change leaving its timeline entry`.

### Task 6: `nudges.ts`

**Files:** Create `src/lib/monsoon/nudges.ts`, `src/lib/monsoon/nudges.db.test.ts`

**Interfaces:**
- Consumes: `Viewer`, `TodoContact` (Task 5).
- Produces:

```ts
export const NUDGE_PAGE = 10;
export const SNOOZE_DAYS = 14;
export const QUIET_DAYS = { high: 30, medium: 60 } as const;
export type Nudge = { kind: "no_next_step" | "quiet"; contact: TodoContact; quietDays: number | null };
export type Nudges = { noNextStep: Nudge[]; quiet: Nudge[]; noNextStepTotal: number; quietTotal: number };
export function listNudges(db: ClientBase, viewer: Viewer, today: string,
  opts?: QueryOptions & { limit?: number }): Promise<Nudges>;
export function snoozeNudge(db: ClientBase, memberId: string, today: string): Promise<{ status: "ok" | "missing" }>;
```

Rules: members considered are those with `owner = viewer.ownerKey`, or every member when `viewer.solo`; stage not terminal; `nudge_after IS NULL OR nudge_after <= today`. `no_next_step`: no open to-do AND (stage `ord` above the lowest `ord` in `stages` OR priority high). `quiet`: priority high and days since last real contact (kinds note, email, call, meeting; else since `members.created_at`) >= 30, or medium and >= 60; a member already in `noNextStep` is left out of `quiet`. Sort: priority high, medium, low, none; then stage `ord` descending; then name. `limit` defaults to `NUDGE_PAGE`; totals count everything. `snoozeNudge` sets `nudge_after = today + 14 days`.

- [ ] **Step 1: Failing tests,** one per rule, including: a first-stage, no-priority member with no to-do is not nudged; a first-stage high-priority one is; a high-priority member last contacted 29 days ago is not quiet and at 30 is; an imported member (only `system` entries) created 31 days ago with priority high is quiet; a member in both lists appears only in `noNextStep`; 12 qualifying members give 10 rows and total 12; a snoozed member is hidden until day 14 and back on day 14; a non-solo viewer does not get another owner's members.
- [ ] **Step 2: Run** `npx vitest run src/lib/monsoon/nudges.db.test.ts` — fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — pass.
- [ ] **Step 5: Commit** `feat(monsoon): nudges for contacts with no next step and important contacts gone quiet`.

### Task 7: `/api/monsoon/todos` route and client helpers

**Files:** Create `src/app/api/monsoon/todos/route.ts`, `src/app/api/monsoon/todos/route.db.test.ts`; Modify `src/components/monsoon/api.ts`, `src/lib/monsoon/accounts/account.ts` (and its store query) to expose the viewer

**Interfaces:**
- Consumes: Tasks 5 and 6; `requireAccount`, `readJson`, `resolveToday`.
- Produces on `Account`: `viewer(): Promise<Viewer>` (`ownerKey` = `person.ownerKey`; `appOwnerKeys` = owner keys of the customer's active people from the accounts store; `solo` = exactly one). Cached per request.
- Produces HTTP:
  - `GET /api/monsoon/todos?estate=<key>&today=<YYYY-MM-DD>[&member=<memberId>][&nudges=all]` → `{ ready: true, open: Todo[], done: Todo[], nudges: Nudges }` (nudges omitted when `member` is given; `nudges=all` lifts the limit to 200) or `{ ready: false }` with status 200 when the CRM is below version 2.
  - `POST /api/monsoon/todos` body `{ estate, today, action, ... }`, `action` one of:
    `add { title, dueDate, target? , source?: "app" | "next" }`, `complete { id }`, `outcome { id, outcome }`, `edit { id, title?, dueDate?, target? }` (`target: null` removes the contact), `drop { id }`, `reopen { id }`, `snooze { memberId }`.
    Replies: `200 { status: "ok" | "already", todo }`, `400 { error }` for `invalid` or a malformed body, `404 { error: "That to-do is no longer there." }` for `missing`, `409 { error: "To do is being set up for this CRM." }` when not ready, `502 { error: "Could not reach the <label> CRM" }` on a database failure (name and code logged only, as `propose/route.ts` does).
  - Body cap 16,384 bytes. Activity log: record `act_details` with the pipeline key for every successful write.
- Produces in `components/monsoon/api.ts`: types `Todo`, `TodoContact`, `Nudge`, `Nudges` (re-exported from the lib types), and
  `loadTodos(estate: string, opts?: { member?: string; allNudges?: boolean }): Promise<ApiResult<TodosReply | { error: string } | null>>` with `TodosReply = { ready: false } | { ready: true; open: Todo[]; done: Todo[]; nudges?: Nudges }`, and `todoAction(estate: string, body: TodoActionBody): Promise<ApiResult<{ status: "ok" | "already"; todo: Todo } | { error: string } | null>>`. Both send the browser's local date as `today`.

- [ ] **Step 1: Failing tests** (`route.db.test.ts`, using the test account helper in `testing/account.ts`): GET on a `makeV1TestDb` CRM answers `{ ready: false }` and POST answers 409; add then GET shows it under the right bucket; complete then outcome writes the two timeline entries; `edit` with `target: null` detaches; a `title` of 301 characters is 400; an unknown `action` is 400; another customer's session cannot read this CRM (existing account guard); `snooze` hides the nudge.
- [ ] **Step 2: Run** `npx vitest run src/app/api/monsoon/todos` — fail.
- [ ] **Step 3: Implement** the route, `Account.viewer()`, and the two client helpers (with tests in `api.test.ts` for the request shapes).
- [ ] **Step 4: Run** `npx vitest run src/app/api/monsoon/todos src/components/monsoon/api.test.ts src/lib/monsoon/accounts` — pass.
- [ ] **Step 5: Commit** `feat(monsoon): the to-do route - list, add, tick, outcome, edit, drop, reopen, not now`.

### Task 8: Ask - to-do tools and proposals; the old next-action proposal goes

**Files:** Create `src/lib/monsoon/ask/todo-actions.ts`, `todo-actions.db.test.ts`; Modify `src/lib/monsoon/ask/{proposal,actions,tools,loop}.ts`, `src/app/api/monsoon/{propose,act}/route.ts`, `src/components/monsoon/{ChangeCard.tsx,api.ts,ProfileActions.tsx}` and their tests

**Interfaces:**
- Consumes: Tasks 5, 6; `Binding`, `sign`/`verifyProposal` pattern in `proposal.ts`.
- Produces proposal kinds (each with `customer`, `estate`, `expires` like the others):

```ts
| { kind: "add_todo"; title: string; dueDate: string | null;
    memberId: string | null; memberKind: MemberKind | null; memberName: string | null; company: string | null;
    aboutPersonId: string | null; about: string | null }
| { kind: "complete_todo"; todoId: string; title: string; memberName: string | null; outcome: string | null }
| { kind: "move_todo"; todoId: string; title: string; memberName: string | null; fromDate: string | null; toDate: string | null }
| { kind: "drop_todo"; todoId: string; title: string; memberName: string | null }
```

  and in `todo-actions.ts`: `proposeAddTodo(db, bind, target: Target | undefined, title, dueDate, nowMs)`, `proposeCompleteTodo(db, bind, viewer, todoId, outcome, nowMs)`, `proposeMoveTodo(db, bind, viewer, todoId, toDate, nowMs)`, `proposeDropTodo(db, bind, viewer, todoId, nowMs)`, each returning `ProposeResult`. `act/route.ts` carries them out with Task 5's functions (`source: "ask"`; `complete_todo` with an outcome calls `completeTodo` then `setOutcome` in one transaction) and maps each to `ACTIVITY` `act_details`.
- Produces tools in `tools.ts`: `list_todos { due?: <a due bucket>, member_id?, person_id? }` → the viewer's open to-dos (id, title, due date, bucket, moved count, contact name, company, stage, priority, last contact; clipped with the existing `clip`); `list_nudges {}` → both lists with totals; `propose_todo { title, due_date?, member_id?, person_id? }`; `propose_complete_todo { todo_id, outcome? }`; `propose_move_todo { todo_id, due_date }` (empty string clears the date); `propose_drop_todo { todo_id }`. The to-do tools are offered only when `todosReady`; on a version 1 CRM the old `set_next_action` tool and proposal keep working (they are removed only from the profile UI, see below).
- System prompt addition in `loop.ts` (exact text): `For "what should I do today" or similar: call list_todos, then list_nudges. Give overdue to-dos first, then today's, then the rest of this week, each ordered by the contact's priority and then by how far along its stage is. Name each to-do and its contact. Then mention up to three contacts from the nudges that need a next step. When asked to prepare the user for a to-do, read the contact and its timeline, then give where things stand in a few lines, talking points, and, when the to-do is a message to send, a draft the user can copy. You never send anything.`
- Removed: the profile's Next action control in `ProfileActions.tsx` (line ~518) and its `set_next_action` call. The `set_next_action` proposal kind, `proposeNextAction`, `setNextAction`, and their branches in `propose`, `act` and `ChangeCard` stay, used only by Ask on version 1 CRMs.

- [ ] **Step 1: Failing tests.** `todo-actions.db.test.ts`: each propose function returns a signed proposal naming the right to-do and contact; `proposeCompleteTodo` on a done to-do is `{ ok: false, reason: "That to-do is already done." }`; a proposal signed for customer A fails `verifyProposal` binding for customer B (existing pattern). `proposal.test.ts`: the four kinds round-trip sign/verify and reject a changed `title` or `toDate`. `tools.test.ts`: `toolsFor` includes the six tools when ready and none of them when not. `actions.db.test.ts` / act route test: acting on `add_todo` creates a to-do with source `ask`; acting on `complete_todo` with an outcome writes the `system` and the `note` entries.
- [ ] **Step 2: Run** `npx vitest run src/lib/monsoon/ask src/app/api/monsoon` — fail.
- [ ] **Step 3: Implement.** `ChangeCard.tsx` titles: `Add to-do`, `Tick off to-do`, `Move to-do`, `Drop to-do`; body shows title, date (or `No date`), contact name when there is one, and the outcome when given.
- [ ] **Step 4: Run** `npx vitest run` and `npx tsc --noEmit` — pass.
- [ ] **Step 5: Commit** `feat(monsoon): Ask reads to-dos and nudges and proposes adding, ticking, moving and dropping one`.

### Task 9: Spoken notes offer to-dos; saving a contact writes them

**Files:** Modify `src/lib/monsoon/refine.ts`, `refine.test.ts`, `src/app/api/monsoon/refine/route.ts`, `src/lib/monsoon/capture.ts`, `capture.db.test.ts`, `src/app/api/monsoon/save/route.ts`, `src/components/monsoon/api.ts`

**Interfaces:**
- Produces: `export type OfferedTodo = { title: string; due: string | null }`; `RefineInput` gains `today: string`; `RefineOutput` gains `todos: OfferedTodo[]`; `export const MAX_OFFERED_TODOS = 5`; `export function cleanOfferedTodos(raw: unknown, today: string): OfferedTodo[]`. `CaptureInput` gains `todos?: OfferedTodo[]`; `capture()` inserts them (source `notes`, owner = the capture's owner, member = the member the capture wrote or matched, `about_person_id` when the person sits under a member company) in its existing transaction, only when the CRM is at version 2. `SaveBody` gains `todos?: OfferedTodo[]`; `refineCard` sends `today` and returns `todos`.
- Prompt: append to `SYSTEM_PROMPT` exactly: ` Also return `todos`: one entry for each thing the dictated text says the user intends to do later (for example "send him the deck by Friday"). `title` is that action in a few plain words, naming the person where it helps. `due` is the day it is to be done by, written YYYY-MM-DD and worked out from `today`, or an empty string when no day was stated. Return an empty list when nothing of the kind was said. Never add a to-do that was not stated.` The user message JSON gains `today`. The output schema gains `todos`: array of `{ title: string, due: string }`, both required.
- `cleanOfferedTodos`: not an array → `[]`; keep entries whose `title` is a non-empty string, trimmed and cut to 300; `due` kept only when `validDay(due)` and `due >= today`, else `null`; first 5.

- [ ] **Step 1: Failing tests.** `refine.test.ts`:

```ts
expect(cleanOfferedTodos([{ title: " Send deck ", due: "2026-11-27" }], "2026-11-26")).toEqual([{ title: "Send deck", due: "2026-11-27" }]);
expect(cleanOfferedTodos([{ title: "x", due: "2026-13-45" }, { title: "y", due: "Friday" }, { title: "z", due: "2026-11-01" }], "2026-11-26"))
  .toEqual([{ title: "x", due: null }, { title: "y", due: null }, { title: "z", due: null }]);
expect(cleanOfferedTodos(Array.from({ length: 8 }, (_, i) => ({ title: `t${i}`, due: "" })), "2026-11-26")).toHaveLength(5);
expect(cleanOfferedTodos("nope", "2026-11-26")).toEqual([]);
```
  plus: `refineContact` with a stubbed client returning `todos` passes them through `cleanOfferedTodos`; a response with no `todos` key yields `[]` rather than throwing. `capture.db.test.ts`: a capture with two `todos` creates two open to-dos on the new contact's member with source `notes`; a capture of a person under a member company sets `about_person_id`; on a `makeV1TestDb` CRM the capture succeeds and writes none. Save route: more than 5 `todos` or a non-array is `400`.
- [ ] **Step 2: Run** `npx vitest run src/lib/monsoon/refine.test.ts src/lib/monsoon/capture.db.test.ts` — fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run` — pass.
- [ ] **Step 5: Commit** `feat(monsoon): spoken notes offer to-dos, saved with the contact`.

### Task 10: To do tab - list, add, edit

**Files:** Create `src/components/monsoon/TodoPanel.tsx`, `TodoRowView.tsx`, `TodoForm.tsx` and tests; Modify `MonsoonApp.tsx`, `MonsoonApp.test.tsx`

**Interfaces:**
- Consumes: `loadTodos`, `todoAction`, `Todo`, `EstateInfo.todos` (Tasks 3, 7); the contact search used by `ContactsPanel` (`searchContacts` in `api.ts`).
- Produces: `mode` in `MonsoonApp` becomes `"capture" | "todo" | "contacts"` with the switch reading `Capture | To do | Contacts`; `TodoPanel` props `{ estate: EstateInfo; state: TodosState; onState(next: TodosState): void; onOpenContact(target: ContactTarget): void; onPrepare(todo: Todo): void }` with `export type TodosState` and `EMPTY_TODOS` held in `MonsoonApp` (like `ContactsState`) so it survives tab switches; `TodoForm` props `{ estate; initial?: Todo; contact?: { target: Target; name: string }; onDone(todo: Todo | null): void }`; `TodoRowView` props `{ todo: Todo; onTick(): void; onOpen(): void; onOpenContact?(): void }`.
- Copy (exact): section headings `Overdue`, `Today`, `This week`, `Later`, `No date`; empty state `Nothing to do yet. Add your first to-do.`; not ready `To do is being set up for this CRM.`; add button `Add`; form labels `What`, `When`, `Who (optional)`; date choices `Today`, `Tomorrow`, `Next week` (today + 7), `Pick a date`, `No date`; edit view buttons `Save`, `Drop`, `Prepare me`; moved hint `moved N times` (shown from 2).
- Row second line for a to-do with a contact: `<company> · <stage label> · last: <kind> <d MMM>`; `(no contact)` otherwise. Tapping the name calls `onOpenContact`, which switches to Contacts with that profile open (`withOpen`).
- A failed write shows the reply's `error` inline and leaves the row as it was.

- [ ] **Step 1: Failing component tests:** renders the five headings only when they have rows; `{ ready: false }` shows the not-ready line and no Add button; Add with `What` = "Call Sarah", `Tomorrow` posts `{ action: "add", title: "Call Sarah", dueDate: <today + 1> }` and the row appears under This week or Today as the date dictates; opening a row and changing the date posts `edit`; Drop posts `drop` and removes the row; `Prepare me` is absent for a to-do with no contact; the tab switch shows three entries and remembers `todo` in the saved choice.
- [ ] **Step 2: Run** `npx vitest run src/components/monsoon/Todo` — fail.
- [ ] **Step 3: Implement,** following `styles.ts` and the layout of `ContactsPanel.tsx`; dictation in `What` uses `useDictation` as `SpeakNotes` does.
- [ ] **Step 4: Run** `npx vitest run src/components/monsoon` and `npx tsc --noEmit` — pass.
- [ ] **Step 5: Commit** `feat(monsoon): the To do tab - what is due, adding and editing`.

### Task 11: Ticking off, the Done list, nudges on the tab

**Files:** Create `src/components/monsoon/TickSheet.tsx`, `NudgeList.tsx` and tests; Modify `TodoPanel.tsx`

**Interfaces:**
- Consumes: Task 10 components, `todoAction`.
- Produces: `TickSheet` props `{ estate; todo: Todo; onClose(result: { outcome: boolean; next: Todo | null }): void }`; `NudgeList` props `{ nudges: Nudges; onAdd(contact: TodoContact): void; onSnooze(memberId: string): void; onShowAll(): void; onOpenContact(contact: TodoContact): void }`.
- Behaviour: tapping the circle posts `complete` at once and moves the row to Done. With a contact, `TickSheet` opens: heading `Done: <title>`, `What happened?` (text, dictation), `What's next?` (text + the Task 10 date choices), `Save`, `Skip`. Save posts `outcome` when the first box is non-empty, then `add` with `source: "next"` and the same contact target when the second is non-empty. With no contact: no sheet, a 6-second `Undo` that posts `reopen`.
- Done fold: `Done (last 30 days)`, collapsed by default; each row has `Reopen`.
- Nudge headings `Needs a next step` and `Gone quiet`; rows `<name> · <stage label> · no to-do` and `<name> · <Priority> · last contact N days ago` (or `no contact yet`); buttons `Add`, `Not now`; `Show more (N)` when the total exceeds the rows shown, which reloads with `allNudges`.

- [ ] **Step 1: Failing tests:** tick posts `complete` before the sheet shows; Save with both boxes posts `outcome` then `add` with `source: "next"` and the contact's target; Skip posts nothing more; a to-do with no contact shows Undo and Undo posts `reopen`; `Not now` posts `snooze` and removes the row; `Add` on a nudge opens `TodoForm` with that contact filled in; a `409`/`502` on tick puts the row back and shows the error.
- [ ] **Step 2: Run** `npx vitest run src/components/monsoon/TickSheet src/components/monsoon/NudgeList src/components/monsoon/TodoPanel` — fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/components/monsoon` — pass.
- [ ] **Step 5: Commit** `feat(monsoon): ticking off asks what happened and what is next; nudges on the To do tab`.

### Task 12: To-dos on a profile, and Prepare me

**Files:** Create `src/components/monsoon/ProfileTodos.tsx` and test; Modify `ProfileView.tsx`, `ProfileActions.tsx`, `AskPanel.tsx`, `MonsoonApp.tsx` and their tests

**Interfaces:**
- Consumes: `loadTodos(estate, { member })`, `TodoRowView`, `TodoForm`, `TickSheet`; the `Profile` type from `contacts.ts` (its member id).
- Produces: `ProfileTodos` props `{ estate: EstateInfo; memberId: string; target: Target; name: string; onPrepare(todo: Todo): void }`, rendered in `ProfileView` where the Next action line was, only when `estate.todos`; when it is false the old read-only Next action line stays. Another person's to-do shows the owner key in small text after the title.
- Produces: `MonsoonApp` `prepare(todo: Todo)`: opens the Ask sheet with the to-do's contact as the viewed contact (the existing `AskViewing` mechanism) and sends this message as if typed: `Prepare me for this to-do with <contact name>: "<title>"<, due <d MMM> when dated>.` `AskPanel` gains an optional prop `send?: { id: string; text: string }` that it submits once per `id`. It is an ordinary Ask turn (one AI use).

- [ ] **Step 1: Failing tests:** `ProfileTodos` lists the member's open to-dos and adds one with the profile's target; `ProfileView` shows no Next action control when `estate.todos` and shows the old line when not; `Prepare me` from the tab opens the Ask sheet and sends exactly the message above once (re-render does not resend); ticking on a profile opens `TickSheet`.
- [ ] **Step 2: Run** `npx vitest run src/components/monsoon/Profile src/components/monsoon/AskPanel src/components/monsoon/MonsoonApp` — fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/components/monsoon` — pass.
- [ ] **Step 5: Commit** `feat(monsoon): a contact's to-dos on its profile, and Prepare me in Ask`.

### Task 13: Offered to-dos in capture and batch review

**Files:** Create `src/components/monsoon/OfferedTodos.tsx` and test; Modify the capture form in `MonsoonApp.tsx`, `SpeakNotes.tsx`, `BatchReview.tsx` and tests

**Interfaces:**
- Consumes: `OfferedTodo`, `refineCard` returning `todos`, `SaveBody.todos` (Task 9).
- Produces: `OfferedTodos` props `{ todos: OfferedTodo[]; onChange(next: OfferedTodo[]): void }`: heading `To do`, one line per to-do (`<title> · <d MMM>` or `· no date`) in the highlighted style used for dictated corrections (`Highlight.tsx`), each with a remove `×`; removing shows a single `Undo` for the last removal. Offered to-dos from a second dictation are appended, skipping an exact title already listed, to at most 5. The form's save sends the remaining ones as `todos`; a batch row keeps its own list. Hidden entirely when the selected estate has `todos: false`.

- [ ] **Step 1: Failing tests:** after a tidy returning two to-dos both lines show; removing one and saving sends one; Undo restores it; a second tidy returning the same title does not duplicate; with `estate.todos` false nothing renders and `todos` is not sent; batch save sends each row's own list.
- [ ] **Step 2: Run** `npx vitest run src/components/monsoon/OfferedTodos src/components/monsoon/SpeakNotes src/components/monsoon/BatchReview src/components/monsoon/MonsoonApp` — fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the whole suite `npx vitest run`, `npx tsc --noEmit`, `npx next build` — pass.
- [ ] **Step 5: Commit** `feat(monsoon): spoken notes show the to-dos they will add, each removable`.

### Task 14: Rollout (with Vincent; nothing here runs without his go-ahead)

Rewritten 2026-11-27 after the final whole-branch review (its rollout risks R1 to R9). Record real outputs in `docs/superpowers/plans/2026-11-26-monsoon-todos-rollout.md` as each step runs.

**Before anything**

- [ ] **Step 1:** Both branches reviewed and green (core 107 tests; app full suite with `--maxWorkers=2 --minWorkers=1`, `tsc`, `next build`). The app's `testing/0002_todos.sql` matches the core file apart from its header.
- [ ] **Step 2:** For each of Traxo and Zero One, find out how the live app signs in: a restricted login with per-table policies, or the full address. Write it down. This decides step 5c.
- [ ] **Step 3:** Vincent has ready: the own-project client's pooler host and its owner password in an env variable in `~/.quantcloud/monsoon-accounts.env`.

**Core estates, one at a time: Qforce, then Zero One, then Traxo**

- [ ] **Step 4:** Merge the core branch to `master`. From then on do not run merge commands from the sibling core worktrees until they are rebased (they do not move to-dos), and migrate all three estates in the same sitting (the core's merge commands now need the `todos` table).
- [ ] **Step 5 (per estate):**
  - a. Check the owners table against the estate manifest (`lookup_drift`). An owner key the app added that is not in the manifest and is in use makes `migrate` refuse; add it to the manifest first.
  - b. Record three counts from `members`: non-blank next actions (`btrim(coalesce(next_action,'')) <> ''`), next actions longer than 300 characters, and rows with a date but no text. Export `id, next_action, next_action_date` to a file. There is no down-migration: the migration cuts text over 300 characters and clears a date that has no text.
  - c. `py -3.13 -m quantcloud.crm <estate> migrate`. If the app's login there is restricted, run the output of `todoGrantStatements(<role>, 'public')` on that database immediately afterwards, in the same sitting (the `upgrade` command refuses core-owned CRMs, so this is by hand). On a Supabase project also confirm `anon` and `authenticated` have no rights on `todos`.
  - d. Verify: `max(version)` is 2; migrated to-dos (`source = 'migrated'`) equal the non-blank count from b; `verify` reports no drift; save a test contact from the live app and set a next action on one (the live app's old-style write must turn into a to-do).

**Client CRMs**

- [ ] **Step 6:** From the app worktree root on this branch, at a quiet moment (the upgrade briefly locks `members`): `upgrade --all-shared`. Every line reads `1 -> 2` or `already at 2`.
- [ ] **Step 7:** `upgrade <client code> <pipeline> --owner-password-from-env <VAR> --pooler <host>` for the one early client on its own project.

**Deploy**

- [ ] **Step 8:** Fetch, rebase on `origin/main`, re-run the suite (`--maxWorkers=2 --minWorkers=1`), `tsc`, `next build`. Push `main`. Wait for Vercel Ready.
- [ ] **Step 9:** Run `upgrade --all-shared` again: anyone who signed up between step 6 and the deploy was built at version 1 by the old app.
- [ ] **Step 10:** Live checks on Vincent's phone: the To do tab lists the migrated to-dos for Traxo and Zero One; add one with and one without a contact; tick with an outcome and a next step and see both on the profile timeline; drop one and undo it; a spoken note with "by Friday" offers a dated to-do; Ask answers "what should I do today?"; Prepare me returns a brief.
- [ ] **Step 11:** Record the session with `wrap_up` and update the `monsoon-capture-app` memory with the To do feature and the `upgrade` command.

---

## Self-review notes

- Spec coverage: 5.1/5.2 → Tasks 1, 2; 5.2 "who sees what" → Tasks 5, 7; 5.3 → Task 5; 6.1, 6.2 → Task 10; 6.3 → Task 11; 6.4 → Task 12; 6.5 → Tasks 7 (first tap) and 8 (confirm); 7 → Tasks 9, 13; 8 → Tasks 8, 12; 9 → Tasks 6, 11; 10 → Tasks 3, 5, 7; 11 → Tasks 1, 3, 4, 14; 12 → each task's tests.
- One deliberate narrowing of the spec: the `set_next_action` proposal stays in the server for Ask on version 1 CRMs and is removed only from the profile, so a CRM that has not been upgraded loses nothing. It can be deleted once every CRM is at version 2.
- The spec's "if the profile's Add note passes through the tidy step": it does not (it posts `add_note` directly), so it is left alone.
