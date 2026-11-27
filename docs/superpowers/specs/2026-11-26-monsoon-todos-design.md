# Monsoon To do - design

Date: 2026-11-26
Status: draft for Vincent's approval
Code base: `QCwebsite` at `origin/main` (ecf1c87 or later; the main checkout is behind, work from a fresh worktree) and the Quantcloud core at `C:\Dev\Quantcloud\core\quantcloud\crm`.

Lines marked **(Vincent)** are his decisions. Lines marked **(call)** are choices made on his behalf that he can overrule.

## 1. Intent

Monsoon gets a to-do list. Each to-do has a date to complete it by and can be tied to a contact or company in the CRM. **(Vincent)**

The why, in Vincent's words: the to-do list helps the system accumulate context on the work a person is doing with their contacts, and it should be very effective at helping people execute on engaging their CRM and closing business and revenue.

So the list is not a general task manager. It is the place where a salesperson's intended next steps live, where finishing a step records what happened, and where Monsoon points out the contacts that have no next step at all.

## 2. Goals, non-goals, anti-goals

Goals (all in this one build) **(Vincent: everything at once)**:

1. A To do tab listing open to-dos by when they are due.
2. Adding a to-do from the tab, from a contact's profile, and from Ask.
3. Ticking off a to-do asks "what happened?" and "what's next?", and the answers land on the contact's timeline and as the next to-do.
4. Spoken notes offer to-dos ("send him the deck by Friday").
5. Nudges: active contacts with no open to-do, and important contacts that have gone quiet.
6. Ask can answer "what should I do today?" and can prepare the user for a to-do (history, talking points, a draft message to copy).

A to-do can exist without a contact. **(Vincent)**

Non-goals for this build:

- Assigning a to-do to a colleague, and a team view. A to-do belongs to the signed-in person. **(call)**
- Push notifications, calendar entries, email reminders. Monsoon never sends email (standing rule).
- Recurring to-dos, sub-tasks, projects, labels.
- Turning Granola meeting action items or imported files into to-dos.
- One list across several pipelines. The tab shows the selected pipeline, like Contacts does. **(call)**
- To-do tools on the `quantcloud` MCP server. The core gets the schema, the migration and whatever keeps its existing tools correct, nothing more.

Anti-goals (a failure even if it works):

- A to-do or its history can be deleted. The standing rule holds: the app never deletes, history only grows.
- The assistant creates, completes or changes a to-do without the user confirming a card.
- Nudges become noise: a wall of hundreds of cold leads, or the same contact nagging every day with no way to wave it off.
- The existing "next action" on a contact and the to-do list disagree.

## 3. What exists today

- `members` (a contact or company in a pipeline) carries one `next_action` text and one `next_action_date`. `dueBucket` in `src/lib/monsoon/rules.ts` (a port of `quantcloud/crm/rules.py`) sorts it into overdue, today, week, later, undated, none.
- The profile can set, change and clear it (`set_next_action` proposal kind, commit abe6a55). Ask reads it (`queries.ts`) and can propose setting it.
- There is no list screen, one contact holds only one, and replacing it leaves no record of the old one being done.
- The timeline is the `touches` table. Kinds are fixed by a CHECK: note, email, call, meeting, stage, system. `lastAction` counts note, email, call and meeting as real contact; system and stage do not count.
- A person filed under a pipeline-member company has no member row of their own: a note about them goes on the company's timeline with the person's name first ("about").
- The CRM schema is owned by the core: `core/quantcloud/crm/schema/0001_init.sql`, copied into QCwebsite by `scripts/monsoon/gen_rule_fixtures.py` as `src/lib/monsoon/testing/0001_init.sql`, and baked into `accounts/crm-schema.generated.ts` for new client CRMs. There has never been a version 2, so nothing today upgrades an existing client CRM.
- The app's login on client CRMs can read, insert and update, never delete, never create tables (`setup-script.ts`, `provision.ts`, `setup-check.ts`). Sign-up clients share one Supabase project, each in schema `c_<customer id>`. Earlier clients (the owner's own two pipelines and one early client) are on their own projects.
- Spoken notes are tidied by `refine.ts` (one call to the customer's configured model, `account.model()`, returning fields and notes).
- `CRM_SCHEMA_VERSION = 1` in `accounts/account.ts` gates the whole app: `estates/route.ts` marks a pipeline `needs_update` when its version is lower. `setup-check.ts` requires version `>= 1` and the tables in `MONSOON_TABLES` whenever a CRM is connected or reconnected.
- `MonsoonApp.tsx` has two modes, capture and contacts. Ask is a sheet over either and is told which contact is open.

## 4. Approaches

A. **A to-do table in every CRM, with the old next action kept in step from it.** Chosen. Many to-dos per contact, to-dos without a contact, full history, and everything that already reads `next_action` (Ask, the core tools, `dueBucket`) keeps working. Cost: the first schema change since version 1, so an upgrade path for existing CRMs has to be built.

B. **To-dos as timeline entries.** No new table. Rejected: the timeline is append-only by rule and a to-do has to change (tick it, move its date), and `touches` requires a member, so a to-do without a contact has nowhere to go.

C. **Keep one next action per contact and add a list screen.** Cheapest. Rejected: no to-dos without a contact, one per contact, no history.

Vincent talks in outcomes and handed over the how; A was presented to him with B and C on 2026-11-26 and he proceeded on it.

## 5. Data

### 5.1 New table `todos` (schema version 2, core file `0002_todos.sql`)

| column | type | meaning |
|---|---|---|
| `id` | uuid, primary key | |
| `title` | text, not null | what to do, up to 300 characters |
| `due_date` | date, null | the date to complete it by; optional **(call)** |
| `first_due_date` | date, null | the first date it was given, never changed afterwards |
| `moved_count` | integer, default 0 | how many times the date was pushed later |
| `member_id` | uuid, null, references `members(id)` ON DELETE SET NULL | the contact or company it is about; null for a to-do with no contact |
| `about_person_id` | uuid, null, references `people(id)` ON DELETE SET NULL | the person, when the member is their company (same idea as "about" on notes) |
| `owner` | text, null, references `owners(key)` | whose to-do it is; null when nobody is named (a migrated to-do whose contact has no owner) |
| `status` | text, CHECK in (`open`, `done`, `dropped`), default `open` | |
| `outcome` | text, null | what the user said happened, up to 2000 characters |
| `closed_at` | timestamptz, null | when it became done or dropped; cleared on reopen |
| `source` | text, not null | `app`, `ask`, `notes`, `next`, `migrated`, `core` |
| `created_at`, `updated_at` | timestamptz | `updated_at` by the existing `set_updated_at` trigger |

Indexes: `(status, due_date)`, `(member_id) WHERE status = 'open'`, `(owner) WHERE status = 'open'`. Row security on, no public policies, like every other table.

One new column on `members`: `nudge_after DATE` (null by default). A nudge for that contact stays hidden until that date.

### 5.2 The old next action stays in step

The to-do table is the single source of truth. A database trigger on `todos` (after insert, and after update of status, title, due date or member) rewrites `members.next_action` and `next_action_date` for the affected member (both the old and the new member when it moves) to that member's **earliest open to-do**: dated ones first by date, then undated ones by creation time; both null when none is open. Doing it in the database keeps the Python core and the web app from drifting.

**Direct writes are converted, not lost. (call)** Old code still writes `next_action` straight onto `members`: the live app between "migrate" and "push", the core's `set_next`, `_member_update` and merge fold, and five sibling core worktrees that carry version 1 copies. A second trigger on `members` catches a change to `next_action` or `next_action_date` that did not come from the to-do trigger (inside the guard, `pg_trigger_depth()` is 1 for a direct write and higher when another trigger made the change) and turns it into to-do changes:

- new text or date, and the member has an open to-do: its earliest open to-do takes the new title and date (the old meaning of "replace the next action");
- new text and no open to-do: a new open to-do is added (`source = 'core'`, owner = the member's owner);
- cleared: the earliest open to-do is dropped.

The to-do trigger then writes the mirror back. This makes the rollout safe in either order and keeps the anti-goal (the two disagreeing) out of reach.

**Merging contacts.** When the core's `merge_members` removes the dropped member, its to-dos (open and closed) move to the kept member first. `ON DELETE SET NULL` is only the backstop.

**Who sees what. (call)** Until Monsoon has several people per customer, ownership must never hide a to-do:

- When the customer has one person, the tab and Ask show every open to-do in the pipeline.
- When it has several, they show the signed-in person's to-dos plus those with no owner or an owner key that matches no app person (the core's manifest keys on Traxo and Zero One may differ from the app's).
- A contact's profile always shows all of that contact's to-dos, with the owner's initials when it is someone else's. Anyone signed in to the customer may tick or edit any to-do.

With that in place, the direct writers are also cleaned up:

- The app's `set_next_action` proposal kind, its route branches, its ChangeCard branch and the profile control are removed. The profile's to-do section replaces them.
- Ask's tool for proposing a next action is replaced by the to-do tools in section 8.
- Any writer in the core (`db.py`, `cli.py`) that sets `next_action` directly is changed to add or close a to-do instead. The builder checks which exist.

The migration turns every existing non-empty `next_action` into one open to-do (`source = 'migrated'`, owner = the member's owner, title = the text, due date = the date). It must be safe to run twice.

### 5.3 Timeline entries

Only to-dos tied to a contact write to the timeline. **(call)**

| event | timeline entry |
|---|---|
| to-do added | none (the to-do itself is the record) |
| ticked off | `system`: `To-do done: <title>` |
| outcome given | `note`: `<outcome>` prefixed with the to-do title, so it counts as real contact |
| dropped | `system`: `To-do dropped: <title>` |
| reopened | `system`: `To-do reopened: <title>` |
| title or date edited | none; the date's history is `first_due_date` and `moved_count` |

When the to-do names a person under a company, the entry starts with the person's name, as notes do today. For a to-do with no contact the outcome is kept on the to-do row only.

## 6. Screens

### 6.1 To do tab

A third mode beside Capture and Contacts. The remembered-tab behaviour stays as it is. **(call)**

```
To do                                      [+ Add]
OVERDUE
 ○ Send deck to Alex Chen           Mon 23 Nov
   Acme · Meeting held · last: call 19 Nov
TODAY
 ○ Call Sarah Lin re pricing
 ○ Prepare Q1 pitch deck               (no contact)
THIS WEEK
 ○ Intro email to James Wu             Fri 27 Nov
LATER / NO DATE
 ...
NEEDS A NEXT STEP                          (nudges)
 Dana Cho · Proposal sent · no to-do   [Add] [Not now]
GONE QUIET
 Ravi Patel · High · last contact 41 days ago
                                       [Add] [Not now]
Done (last 30 days)  ▸
```

- Groups use the existing `dueBucket` boundaries (week = within 7 days) and the existing `resolveToday` for the user's date.
- A row tied to a contact shows the contact, company, stage and last real contact; tapping the name opens the profile. A pushed date shows quietly ("moved 3 times").
- Tapping the row body opens it for editing: title, date, contact, Drop, and **Prepare me** when it has a contact.
- Which to-dos are listed follows "Who sees what" in section 5.2.

### 6.2 Adding

`+ Add` opens a short form: what (typed or dictated), date (Today, Tomorrow, Next week, pick a date, none), contact (optional search, the same search Contacts uses). On a profile the contact is already filled in.

### 6.3 Ticking off

Tapping the circle saves the to-do as done at once (first tap, no confirm) and, for a to-do with a contact, opens a small sheet:

```
Done: Send deck to Alex Chen
What happened?   [ speak or type ............ ]
What's next?     [ ....................... ] [date]
                          [Save]   [Skip]
```

Both boxes are optional. "What happened?" becomes the outcome and a timeline note. "What's next?" becomes a new to-do for the same contact (`source = 'next'`). Skip leaves just the done line. A to-do with no contact skips the sheet and shows a short Undo.

Done to-dos can be reopened from the Done list. Dropping is from the edit view. Nothing is ever deleted.

### 6.4 On a contact's profile

A To do section replaces the single Next action line: that contact's open to-dos with circles to tick, `+ Add`, and the done ones behind a "Done" fold.

### 6.5 Confirm rules

Adding, ticking, editing, moving a date, dropping and reopening by the user's own hand happen on the first tap, in line with Vincent's 2026-11-23/24 rule for notes and stage. **(call)** Anything the assistant proposes in Ask needs a confirm on a signed card, as today.

## 7. Spoken notes offer to-dos

`refine.ts` returns one more field, `todos`: a list of `{ title, due }` (due as YYYY-MM-DD or empty). The prompt adds: list a to-do only when the dictated text states something the user intends to do; resolve a spoken date ("Friday", "next week") against today's date, which the request now carries; never invent one. The server drops anything malformed, caps the list at 5 and the title at 300 characters.

The capture form and batch review show the offered to-dos under Notes, pre-ticked, each removable, in the same highlighted-with-Undo style used for field corrections. They are written in the same transaction that saves the contact (`source = 'notes'`). If the profile's Add note also passes through the tidy step, it offers to-dos the same way; if it does not, it is left alone.

## 8. Ask

Read tools:

- `list_todos`: the user's open to-dos, filterable by due bucket and by contact, each with the contact's stage, priority and last real contact.
- `list_nudges`: the same two nudge lists the tab shows.

The system prompt gains a short instruction for "what should I do today?": overdue first, then today, then by the contact's priority and how far along the stage is; name each item and link the contact; then mention up to three nudges.

Proposal kinds (signed cards, confirm required): `add_todo`, `complete_todo` (with optional outcome), `move_todo` (new date), `drop_todo`. They follow the existing proposal pattern in `ask/proposal.ts`, `propose/route.ts` and `act/route.ts`, bound to the customer and pipeline.

**Prepare me.** A button on a to-do that has a contact. It opens the Ask sheet with the contact set as the one on screen and sends a fixed request: prepare me for "<title>" with <name>. Ask answers from what it can already read (details, stage, timeline, open to-dos, Granola when connected): a few lines of where things stand, talking points, and when the to-do is a message, a draft to copy. No new model route. It counts as one AI use for trial accounts. Monsoon sends nothing.

## 9. Nudges

Computed on request, never stored, for the selected pipeline and the signed-in owner's contacts (members with that owner, or with no owner when the customer has one person).

- **Needs a next step:** a member in a non-terminal stage that is past the pipeline's first stage, or with priority high, and with no open to-do. **(call)** The first stage is left out so a pile of cold leads does not flood the list.
- **Gone quiet:** priority high with no real contact for 30 days, or priority medium for 60 days, non-terminal stage, whether or not it has a to-do. **(call)** A contact that has never had real contact counts from the day it was added (imports write only `system` entries, so an imported high-priority contact shows up after 30 days). The `meeting` entry a photo capture writes counts as contact, as it does everywhere else.

Each list shows at most 10, highest priority and furthest stage first, with "Show more". `Add` opens the add form for that contact. `Not now` sets `members.nudge_after` to 14 days ahead. A contact in both lists appears once, under Needs a next step.

## 10. Server pieces

- `src/lib/monsoon/todos.ts`: list (grouped), add, complete, set outcome, add next, edit, move, drop, reopen, nudges. Every write in one transaction with its timeline entry.
- `src/app/api/monsoon/todos/route.ts` (and sub-routes as needed), using `requireAccount` and `account.pipeline` like the other routes, with the accounts activity log.
- The earliest-open-to-do ordering lives in one place, the database trigger, and is pinned by database tests in both repos. No copy in `rules.ts` or `rules.py`. The date bookkeeping (`first_due_date`, `moved_count`) is also a database trigger, so every writer gets it.
- `INSERT_TABLES` and `UPDATE_TABLES` in `setup-script.ts` gain `todos`, and the script builds new CRMs at version 2. `no-delete.test.ts` covers the new code.
- A CRM still at version 1 must not break the app. `CRM_SCHEMA_VERSION` stays at 1 as the gate for the app as a whole, and `setup-check.ts` keeps accepting a version 1 CRM (it checks `todos` only when the CRM says it is at version 2). A separate to-do readiness check (version 2 or later) decides whether the to-do routes work: below it they answer "not ready yet", the tab says so, the profile keeps no to-do section, and the rest of the app works.

## 11. Rolling out the schema change

This is the first version 2, so the upgrade path is part of the build.

1. Core: `0002_todos.sql`, `expected_v2.json`, `CORE_TABLES` updated. `migrate.py` names `expected_v1.json` in `expected_shape` and `write_expected`; both follow the latest version instead. `LOOKUP_USES["owners"]` gains `("todos", "owner")`. `py -3.13 -m quantcloud.crm <estate> migrate` upgrades Traxo, Zero One and Qforce.
2. QCwebsite: `gen_rule_fixtures.py` copies every schema file; `gen_setup_schema.mjs` (today it reads only `0001_init.sql`) builds the generated schema from all of them; `schemaStatements` and `setupStatements` record version 2 instead of the hardcoded 1. A new sign-up gets version 2 from the start.
3. A new admin command (working name `upgrade`) applies pending versions to a client CRM on the owner's connection and gives the restricted login its select, insert and update rights and policies on `todos`. For the shared project it uses `MONSOON_SHARED_DB_ADMIN_URL` and covers every `c_<id>` schema. For a client on its own project Monsoon keeps no owner password, so the command takes it once the way `host` does (`--owner-password-from-env`). No client has run the setup script in their own database, so no script for clients to run is needed. Safe to run twice.
4. Order: migrate every CRM first, check, then push (the push deploys). Because direct writes are converted (section 5.2) and the app tolerates version 1 (section 10), a slip in the order degrades the To do tab only.

## 12. Tests

Database tests against the local test Postgres for: the trigger keeping `next_action` in step (add, tick, move, reopen, move to another contact), the migration of existing next actions run twice, every write and its timeline entry, nudge rules and caps, the upgrade command on a version 1 CRM, and the restricted login being unable to delete from `todos`. Component tests for the tab, the tick sheet, the add form, offered to-dos in capture and batch, and the Ask cards. Parity fixtures for the ordering rule.

## 13. Left to the builder

- Exact route shapes and whether first-tap writes reuse the propose/act path or post directly, following whatever first-tap notes do today.
- Component split and styling, following `styles.ts` and the existing panels.
- The wording of the "what should I do today?" and Prepare me prompts.
- Which core writers of `next_action` exist and how each maps to a to-do.
- How the app's logins on Traxo and Zero One get access to the new table (they may still use full-access addresses).
