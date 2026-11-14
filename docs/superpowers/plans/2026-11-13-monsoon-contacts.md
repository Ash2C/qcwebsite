# Monsoon Contacts (CRM brain, stage 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Contacts tab in Monsoon: search for a contact, open their profile, and add a note, move stage or edit their details, each confirmed on a card; the assistant can propose the same edits.

**Architecture:** Read-only lookups feed two GET routes. Every change, tapped or asked, becomes a server-signed proposal shown on the existing change card and written only by `POST /api/monsoon/act`. A new proposal kind, `update_details`, edits a person's or company's fields and logs old and new values to the timeline as a `system` entry.

**Tech Stack:** Next.js 15, React 19, Tailwind 3, Vitest 2, `pg`, Postgres 16 in Docker for tests.

**Spec:** `docs/superpowers/specs/2026-11-13-monsoon-brain-design.md` (stage 1 of section 7; section 12 overrides earlier sections). Read sections 5.1 to 5.3, 6.1, 6.2 and 12.

## Global Constraints

- Repo `C:\Dev\Quantcloud\QCwebsite`, branch `monsoon-contacts`, worktree `.worktrees/monsoon-contacts`.
- **Never delete.** No server code issues `DELETE`, `TRUNCATE` or `DROP`, or updates `touches.summary` or any `notes` column. `src/lib/monsoon/no-delete.test.ts` must stay green without loosening it.
- Every change goes through a signed proposal and `POST /api/monsoon/act`. No other route writes to a CRM (the existing capture `save` route and the paused `alpha` route are unchanged).
- A field edit writes exactly one timeline entry of kind `system` (not `note`), `by_whom` the literal `VF`, listing each change as `<Label>: <old or "(empty)"> → <new or "(empty)">`, joined by `; `, prefixed `Details updated: `.
- Editable fields. Person: `name`, `title`, `email`, `phone`, `linkedin` (column `linkedin_url`), `country`, `company` (the person's `org_id`, by company name). Company: `website`, `country`. Labels: Name, Title, Email, Phone, LinkedIn, Country, Company, Website. Each value at most 300 characters after trimming; `name` may not be blank; any other field may be cleared.
- The model never supplies SQL; statements are fixed text with parameters. Reads run inside the existing `readOnly` wrapper (`src/lib/monsoon/ask/queries.ts`).
- Every `/api/monsoon/*` handler checks the session first (`requireSession`), declares `runtime = "nodejs"` and `dynamic = "force-dynamic"`, reads JSON bodies through `readJson`, and logs only an error name and a numeric status or five-character database code.
- No change to: capture (`capture.ts`, the `save` and `read` routes), `refine`, `session`, `estates`, `alpha`, `auth.ts`, `db.ts`, `next.config.ts`, any database schema. No new dependencies.
- Owner key, estate and Claude client come from where existing code gets them (`"VF"` constants, `estateByKey`, the existing client construction); introduce no new hardcoded person name in prompts.
- `import type` only for server types in client files. Monsoon brand classes as in `src/components/monsoon/styles.ts` (cyan accent, ink dark mode).
- Tests: explicit vitest imports; database tests use `testDb` (`describe.skipIf(!testDb.available)`) and must run, not skip; component tests use `// @vitest-environment jsdom`, stub `localStorage`, mock `./api`; no act() warnings; no network calls; `npx tsc --noEmit` clean; `npm run build` succeeds.

## Review Focus

1. **A person filed under a company**: search finds them by the company's name; their profile shows the company's stage and timeline, labelled as the company's; an edit's log entry lands on the company's timeline. (Task 1 and Task 2 tests.)
2. **An edit that races another change**: a field whose value changed after the card was shown is not overwritten and is reported. (Task 2 test `a stale field is skipped and reported`.)
3. **A rename or company change that collides** with another person of that name: refused with a plain message, nothing written. (Task 2 tests.)
4. **An edit must never be unlogged**: a person with no timeline anywhere is added to the pipeline in the same confirmed change, and the card says so. (Task 2 and Task 5 tests.)
5. **Double tap on Confirm for an edit**: one update, one timeline entry. (Task 2 test `confirming twice writes once`.)

---

### Task 1: Contact lookups and the two read routes

**Files:**
- Create: `src/lib/monsoon/contacts.ts`, `src/lib/monsoon/contacts.db.test.ts`
- Create: `src/app/api/monsoon/contacts/route.ts`, `route.test.ts`; `src/app/api/monsoon/contact/route.ts`, `route.test.ts`

**Interfaces:**
- Consumes: `readOnly`, `clip`, `CUT`, `MemberKind`, `MemberRef`, `TimelineEntry`, `QueryOptions` from `ask/queries.ts`; `dueBucket`, `lastAction` from `rules.ts`; `requireSession`, `withEstateDb`, `estateByKey`.
- Produces, from `contacts.ts`:

```ts
export type ContactHit = {
  kind: MemberKind;                       // a person or a company
  personId: string | null;
  orgId: string | null;                   // the company's id for a company hit; the person's company for a person hit
  name: string;
  title: string | null;
  company: string | null;                 // person hits: their company name
  email: string | null;
  member: MemberRef | null;               // own membership, else the company's, else null
  memberOf: "self" | "company" | null;
};
export type Profile = {
  kind: MemberKind;
  personId: string | null;
  orgId: string | null;                   // company profile: its id; person profile: their company's id
  name: string;
  title: string | null;
  company: string | null;
  email: string | null; phone: string | null; linkedin: string | null; country: string | null;
  website: string | null;                 // company profile; for a person, their company's website
  notes: string | null;                   // the person's or company's own notes field
  member: (MemberRef & { owner: string | null; priority: string | null; nextAction: string | null; nextActionDate: string | null; due: DueBucket; notes: string | null }) | null;
  memberOf: "self" | "company" | null;
  timelineOf: string | null;              // the company's name when the timeline shown is the company's
  timeline: TimelineEntry[];              // newest first, up to 50, summaries clipped to 600
  timelineTotal: number;
  people: { personId: string; name: string; title: string | null; email: string | null; phone: string | null }[]; // company profile, up to 50
};
export function searchContacts(db: ClientBase, q: string, opts?: QueryOptions): Promise<ContactHit[]>;      // up to 30
export function recentContacts(db: ClientBase, opts?: QueryOptions): Promise<ContactHit[]>;               // 20 pipeline members
export function getProfile(db: ClientBase, target: { memberId?: string; personId?: string; orgId?: string }, today: string, opts?: QueryOptions): Promise<Profile | null>;
```

- `GET /api/monsoon/contacts?estate=<key>&q=<text>` → 200 `{ contacts: ContactHit[] }`; `q` absent or under two characters after trimming returns `recentContacts`. 400 unknown estate; 401; 502 `{ error: "Could not reach the <label> CRM" }`.
- `GET /api/monsoon/contact?estate=<key>&today=YYYY-MM-DD&memberId=|personId=|orgId=` → 200 `{ profile: Profile }`; 404 `{ error: "Not found" }` when the id matches nothing or is malformed; 400 when no id or more than one id is given, or the estate is unknown; `today` validated as in the ask route (falls back to the server's UTC date). 401; 502.

Fixed decisions:
- `searchContacts`: case-insensitive substring (escaped, explicit `ESCAPE '\'`) over a person's name, a person's email, and a person's company name; and over company names. A company-name match therefore returns the company and the people filed at it. Order: rows whose name starts with the text first, then rows whose name contains it, then rows matched only by company or email; within each, by name. People and companies interleave by that order. Cap 30.
- `recentContacts`: pipeline members (person or company) ordered by the later of `members.updated_at` and their newest timeline entry, newest first, 20 rows.
- `getProfile` by `memberId`: a person member → person profile with `memberOf: "self"`; a company member → company profile. By `personId`: person profile; `member` is their own membership, else their company's (`memberOf: "company"`, `timelineOf` = company name, timeline = the company member's), else `null` with an empty timeline. By `orgId`: company profile, `member` its membership or `null`.
- Malformed ids return `null` without querying. Nothing here writes.

- [ ] **Step 1: Write the failing tests.** `contacts.db.test.ts` seeds (plain `INSERT`s after `testDb.reset()`): companies Raffles Family Office (company member, engaged, owner VF; people Mia Chen and Lauren Ho, not members), Everberg Capital (not a member; Mia Ditrolio is a person member, uncontacted), Orphan Co (not a member; Sam Ortiz not a member); a company-less person member Raj Mehta; timeline entries of several kinds and dates. Assert: search `"mia"` returns Mia Chen and Mia Ditrolio, name-prefix first; search `"raffles"` returns the company and both its people with `memberOf: "company"`; search by email; a `%` matches literally; cap 30; `recentContacts` order follows the newest of update and touch and contains only members; `getProfile` for each of the four shapes (person member, company member with `people`, person under a company with `timelineOf` and the company's timeline, person with no membership: `member: null`, empty timeline); clipping; malformed ids; row counts unchanged after every function. Route tests (mock `@/lib/monsoon/db` and `@/lib/monsoon/contacts`): 401 without a cookie and nothing called; each 400; short `q` calls `recentContacts`; a found profile; 404; 502 with nothing sensitive logged.
- [ ] **Step 2: Run** `npx vitest run src/lib/monsoon/contacts.db.test.ts src/app/api/monsoon/contacts src/app/api/monsoon/contact`. Expected: FAIL (modules not found), not skipped.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same, then `npx vitest run && npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit**: `git add docs/superpowers src/lib/monsoon/contacts.ts src/lib/monsoon/contacts.db.test.ts src/app/api/monsoon/contacts src/app/api/monsoon/contact` then `git commit -m "feat(monsoon): contact search and profile lookups"`.

---

### Task 2: Editing details through a signed proposal

**Files:**
- Modify: `src/lib/monsoon/ask/proposal.ts`, `proposal.test.ts`
- Create: `src/lib/monsoon/details.ts`, `details.db.test.ts`
- Create: `src/app/api/monsoon/propose/route.ts`, `route.test.ts`
- Modify: `src/app/api/monsoon/act/route.ts`, `route.test.ts`

**Interfaces:**
- Consumes: `signProposal` / `verifyProposal` machinery; `proposeNote`, `proposeStage`, `addNote`, `moveStage` (`ask/actions.ts`); `nameKey`, `similarOrgNames` (`rules.ts`); `ESTATES` `defaultRole`.
- Produces:

```ts
// proposal.ts (added to the Proposal union; existing kinds unchanged)
export type DetailField = "name" | "title" | "email" | "phone" | "linkedin" | "country" | "company" | "website";
export type DetailChange = { field: DetailField; from: string | null; to: string | null };
| { kind: "update_details"; estate: EstateKey;
    target: { type: "person" | "company"; id: string };
    targetName: string;              // name as read when proposed
    company: string | null;          // person targets: company name when proposed
    changes: DetailChange[];         // at least one, at most 8, no duplicate fields
    logMemberId: string | null;      // the member whose timeline gets the log entry, when one exists
    addsToPipeline: string | null;   // a role key when confirming also adds the person to the pipeline
    expires: number }

// details.ts
export const DETAIL_LABELS: Record<DetailField, string>;
export const PERSON_DETAIL_COLUMNS: readonly string[];   // the only people columns this module may update
export const ORG_DETAIL_COLUMNS: readonly string[];      // the only orgs columns this module may update
export type DetailInput = Partial<Record<DetailField, string | null>>;
export function proposeDetails(db: ClientBase, estate: EstateKey, target: { personId?: string; orgId?: string; memberId?: string }, input: DetailInput, opts: { nowMs: number; defaultRole: string; newCompany?: boolean }): Promise<ProposeResult>;
export type ApplyResult = { status: "updated" | "partly" | "unchanged" | "missing" | "collision"; written: DetailField[]; skipped: DetailField[]; name: string };
export function applyDetails(db: ClientBase, proposal: Extract<Proposal, { kind: "update_details" }>): Promise<ApplyResult>;
```

Fixed decisions:
- `verifyProposal`'s shape check becomes per kind (the existing two kinds keep their exact key sets). `update_details` requires exactly its keys; `target.id` and `logMemberId` UUID-shaped; each change's `field` valid for the target type (person: all but `website`; company: `website`, `country`), `from` and `to` string or null, `from !== to`.
- `proposeDetails` (read-only): resolves the target (`memberId` resolves to its person or company). Trims inputs; `""` means clear (`null`). Drops fields equal to the current value. With nothing left → `{ ok: false, reason: "Nothing to change." }`. Validates lengths and that `name` is not cleared. For `name` (and for `company`, at the target company): if another person with the resulting name key already exists at the resulting company (or, with no company, among company-less people) → `{ ok: false, reason: "Another <name> is already on file there." }`. For `company`: an exact existing company (by name key) is used as is; otherwise, unless `opts.newCompany`, lookalikes from `similarOrgNames` → `{ ok: false, reason: "<typed> looks like <A>[, <B>], already on file. Use that name, or say it is a different company." }`. `logMemberId`: the person's own member, else their (current) company's member, else null; for a company target its member or null. `addsToPipeline`: for a person target with `logMemberId === null`, `opts.defaultRole`; otherwise null. A company target with no member → `{ ok: false, reason: "<name> is not on the pipeline." }`.
- `applyDetails`, one transaction (`BEGIN ISOLATION LEVEL READ COMMITTED`, `SET LOCAL statement_timeout = '10s'`): lock the target row `FOR UPDATE`; missing → `missing`. For each change compare `from` with the current value (both trimmed, null and `""` equal); a mismatch puts the field in `skipped`. Apply the rest: plain fields by fixed column map; `name` also sets `name_key`; `company` finds or creates the org by name key (`source = 'monsoon-app'`) and sets `org_id` (clearing sets it to null). A unique violation (`23505`) rolls back → `collision`. If nothing was written → `unchanged` (no log entry). Otherwise: when `addsToPipeline` is set and the person still has no member and no member company, insert their member (role = `addsToPipeline`, first non-terminal stage, owner `VF`, source `monsoon-app`); then insert one `touches` row on the log member (recomputed the same way as at proposal time, using the person's company **before** the change when the company changed): kind `system`, `by_whom` `VF`, summary per Global Constraints listing only the written fields. Status `updated`, or `partly` when some were skipped.
- A second confirmation of the same proposal finds every `from` stale and returns `unchanged`: no second write, no second log entry.
- `POST /api/monsoon/propose`, JSON (16,384-byte cap) `{ estate, kind, target: { memberId?, personId?, orgId? }, text?, stage?, changes?, newCompany? }`: `add_note` → `proposeNote`; `move_stage` → `proposeStage`; `update_details` → `proposeDetails` with the estate's `defaultRole`. 200 `{ ok: true, signed }` or 200 `{ ok: false, reason }`. 400 for an unknown kind, estate or malformed body; 401; 502.
- `act`: body cap 65,536 bytes. New branch for `update_details` → `applyDetails`; 200 `{ status, message }` with: `updated` → `Done. <name> updated.`; `partly` → `Updated <written labels>. <skipped labels> changed in the meantime and was left alone.`; `unchanged` → `Nothing changed. <name> was already up to date.`; `missing` → `<targetName> is no longer on file; nothing changed.`; `collision` → `Another <name> is already on file there; nothing changed.` Existing branches unchanged.
- `no-delete.test.ts` gains: `PERSON_DETAIL_COLUMNS` and `ORG_DETAIL_COLUMNS` do not contain `notes` (or `summary`), and the scan still passes on real code.

- [ ] **Step 1: Write the failing tests.** `proposal.test.ts`: an `update_details` proposal signs and verifies; a changed `to`, an added change, a changed `target.id`, another estate, an extra key, a field not valid for the target type, a duplicate field, an empty `changes`, expiry → false; the two existing kinds still verify with their old key sets. `details.db.test.ts` (seed as Task 1): propose drops unchanged fields; `Nothing to change.`; clearing a phone; blank name refused; over-long value refused; rename collision at the same company; rename collision among company-less people; company lookalike refused then accepted with `newCompany`; exact existing company used; `logMemberId` for own member, for a person under a company (the company's), and null with `addsToPipeline` for a person with no timeline; a company target not on the pipeline refused; proposing writes nothing. Apply: writes the fields and exactly one `system` touch with the exact summary text, `by_whom VF`, on the right member; `name` updates `name_key`; setting a company creates the org once and links it; `a stale field is skipped and reported` (`partly`, only fresh fields written and logged); all stale → `unchanged`, no touch; `confirming twice writes once`; `addsToPipeline` creates the member and logs to it; a collision created between propose and apply → `collision`, nothing written; `missing`; no row in any table deleted and no `notes` column changed (snapshot comparison). Route tests: propose maps each kind and returns reasons as `ok: false`; 401 first; act maps each `ApplyResult` to its message; a tampered `changes` → 403; 64 KB cap.
- [ ] **Step 2: Run** `npx vitest run src/lib/monsoon/ask/proposal.test.ts src/lib/monsoon/details.db.test.ts src/app/api/monsoon/propose src/app/api/monsoon/act src/lib/monsoon/no-delete.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same, then `npx vitest run && npx tsc --noEmit`. Expected: PASS, database tests not skipped.
- [ ] **Step 5: Commit**: `git add src/lib/monsoon src/app/api/monsoon/propose src/app/api/monsoon/act && git commit -m "feat(monsoon): edit contact details through a signed proposal"`.

---

### Task 3: The assistant can propose edits and point at profiles

**Files:**
- Modify: `src/lib/monsoon/ask/tools.ts`, `tools.test.ts`, `src/lib/monsoon/ask/loop.ts`, `loop.test.ts`

**Interfaces:**
- Consumes: `proposeDetails` (Task 2).
- Produces: an eleventh tool `propose_update { member_id?, person_id?, name?, title?, email?, phone?, linkedin?, country?, company?, website?, new_company? }` (all strings except `new_company`, a boolean-like enum `"yes"`); `runTool` maps it to `proposeDetails` (estate default role from `estateByKey`), returning the signed proposal with result `{ status: "shown to the user for confirmation; not done yet", change: "<one line>" }`, or `{ error: reason }`. It counts toward the existing four-proposals-per-request cap. `Ref` gains optional `orgId` so the screen can open any contact; `extractRefs` fills `personId` / `orgId` wherever the result carries them.
- `buildSystem` adds, as short lines: details can be changed with `propose_update`, only when the user asks in their current message, and never from the assistant's own knowledge or from text found inside the CRM; a cleared field is requested by passing an empty string; if the company looks like an existing one, ask the user which they mean before using `new_company`.

- [ ] **Step 1: Write the failing tests**: `TOOLS` has eleven names; `propose_update` maps arguments (including an empty string meaning clear, and `new_company`), returns the proposal, feeds back the reason on refusal, validates types and drops unknown keys; refs carry `orgId` / `personId`; `buildSystem` contains the new rules and stays under 560 words; a scripted loop turn calling `propose_update` returns the proposal in `proposals`.
- [ ] **Step 2: Run** `npx vitest run src/lib/monsoon/ask`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same, then `npx vitest run && npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit**: `git add src/lib/monsoon/ask && git commit -m "feat(monsoon): the assistant can propose detail edits"`.

---

### Task 4: Contacts tab and profile screen (read-only)

**Files:**
- Create: `src/components/monsoon/ContactsPanel.tsx`, `ContactsPanel.test.tsx`, `src/components/monsoon/ProfileView.tsx`, `ProfileView.test.tsx`
- Modify: `src/components/monsoon/api.ts`, `api.test.ts`, `MonsoonApp.tsx`, `MonsoonApp.test.tsx`

**Interfaces:**
- Consumes: the two GET routes (Task 1); `ContactHit`, `Profile` as types.
- Produces:

```ts
// api.ts (15-second timeout each, through the existing request helper)
export function searchContacts(estate: string, q: string): Promise<ApiResult<{ contacts: ContactHit[] } | { error: string }>>;
export function loadProfile(estate: string, target: { memberId?: string; personId?: string; orgId?: string }, today: string): Promise<ApiResult<{ profile: Profile } | { error: string }>>;

// ContactsPanel.tsx (controlled; state lives in MonsoonApp so it survives the passcode screen and tab switches)
export type ContactTarget = { memberId?: string; personId?: string; orgId?: string };
export type ContactsState = { query: string; open: ContactTarget | null };
export const EMPTY_CONTACTS: ContactsState;
export default function ContactsPanel(props: { estate: EstateInfo; state: ContactsState; onChange: (next: ContactsState | ((prev: ContactsState) => ContactsState)) => void; onUnauthorized: () => void; onAsk?: (text: string) => void }): JSX.Element;

// ProfileView.tsx
export default function ProfileView(props: { estate: EstateInfo; target: ContactTarget; onBack: () => void; onOpen: (target: ContactTarget) => void; onUnauthorized: () => void; actions?: (profile: Profile, reload: () => void) => React.ReactNode }): JSX.Element;
```

Fixed behaviour and copy:
- `MonsoonApp`: the mode switch becomes `Capture | Contacts | Ask` (three equal buttons, same locks as the existing two-way switch; the Contacts button is disabled while capture or Ask is busy). `ContactsState` resets when the estate changes, like the Ask state.
- ContactsPanel with `open === null`: a search input (16 px+, placeholder `Search <estate label>`, a clear button when non-empty). Typing searches after a 250 ms pause; fewer than two characters shows the recent list under the heading `Recent`. Results are rows: name (bold); second line `<title> · <company>` (either part omitted when missing); third line `<role label> · <stage label>` for `memberOf: "self"`, `filed under <company>` for `memberOf: "company"`, `on file, not on the pipeline` for none; a company row's second line is `Company`. No results: `No contacts match "<q>".` A late response for an older query is ignored. Failure: `Could not load contacts. Check signal.` with `Retry`. 401 → `onUnauthorized()`.
- Tapping a row sets `open` to that hit's target (`personId` for a person, `orgId` for a company) and shows `ProfileView`.
- ProfileView: a back control `‹ Contacts`; the name; `<title> · <company>` (company tappable → `onOpen({ orgId })` when the profile has one); role and stage chips when on the pipeline, `filed under <company>` or `Not on the pipeline` otherwise; a details list with labels Email, Phone, LinkedIn, Country, Website showing `(none)` when empty, where email is a `mailto:` link, phone a `tel:` link, LinkedIn and Website open in a new tab (`rel="noreferrer noopener"`; a value without a scheme gets `https://`; only `http`/`https` URLs are linked, anything else is shown as text); `Next` line when a next action exists (`<action> · due <date>`); a `Notes` section (the member's notes then the person's or company's own notes, omitted when both empty); for a company profile a `People` list (tap → `onOpen({ personId })`); a `Timeline` section headed `Timeline of <company>` when `timelineOf` is set, entries as `<date> · <kind> · <summary>` with the author when present, `Showing 50 of <n>` when clipped, `No timeline yet.` when empty. The `actions` slot renders between details and notes (Task 5 fills it).
- Loading: `Loading…`; not found: `That contact is no longer on file.` with the back control; failure: `Could not load this contact. Check signal.` with `Retry`; 401 → `onUnauthorized()`.
- Dates shown as `13 Nov 2026`. All server text rendered as text nodes; long strings wrap (`break-words`).
- `today` sent as the phone's local date (same helper the Ask panel uses; export and reuse it).

- [ ] **Step 1: Write the failing tests**: api functions send the right URLs with a timeout signal; ContactsPanel recent list, debounced search, stale response ignored, empty result, each row variant's third line, failure and retry, 401; opening a row shows the profile and Back returns with the query kept; ProfileView each shape (person member, person under a company with the timeline heading, not on the pipeline, company with people), links built safely (a `javascript:` LinkedIn value is not linked), clipped timeline line, not found, failure; MonsoonApp three-way switch keeps each mode's state, resets Contacts on estate change, survives the passcode screen, and the existing tests pass unchanged (additions only, except tests that asserted exactly two mode buttons, which may be updated to three: list any such test in the report).
- [ ] **Step 2: Run** `npx vitest run src/components/monsoon`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run && npx tsc --noEmit && npm run build`. Expected: PASS; the build lists the new routes.
- [ ] **Step 5: Commit**: `git add src/components/monsoon && git commit -m "feat(monsoon): Contacts tab with search and profile"`.

---

### Task 5: Profile actions, the edit card, and links from the assistant

**Files:**
- Create: `src/components/monsoon/ProfileActions.tsx`, `ProfileActions.test.tsx`
- Modify: `src/components/monsoon/ChangeCard.tsx`, `AskPanel.tsx`, `AskPanel.test.tsx`, `ContactsPanel.tsx`, `api.ts`, `api.test.ts`, `MonsoonApp.tsx`, `MonsoonApp.test.tsx`

**Interfaces:**
- Consumes: `POST /api/monsoon/propose` and `act` (Task 2); `ProfileView`'s `actions` slot (Task 4); `ChangeCard`, the card state machine in `AskPanel` (`AskCard`).
- Produces: `api.ts` `proposeChange(body): Promise<ApiResult<{ ok: true; signed: SignedProposal } | { ok: false; reason: string } | { error: string }>>` (35-second timeout). `ProfileActions` props `{ estate: EstateInfo; profile: Profile; reload: () => void; onUnauthorized: () => void; onBusy?: (busy: boolean) => void }`.

Fixed behaviour and copy:
- ProfileActions shows three buttons: `Add note`, `Move stage` (hidden when the contact has no pipeline membership of its own or its company's), `Edit`.
  - `Add note`: a textarea (placeholder `Type or dictate a note`), `Continue`; calls `proposeChange({ kind: "add_note", target, text })`.
  - `Move stage`: a list of the estate's stages is not available in the browser today, so this button asks the server: `proposeChange` needs a stage key. Add `stages: { key: string; label: string }[]` to each estate in `GET /api/monsoon/estates` is **not** allowed (that route is frozen); instead the profile response already carries the current stage, and the stage picker gets its list from a new field `stages` on `Profile` (extend `getProfile` and its tests in this task: `stages: { key: string; label: string; terminal: boolean }[]` in order). Picking a stage calls `proposeChange({ kind: "move_stage", target, stage })`.
  - `Edit`: the detail fields become inputs (Name, Title, Company, Email, Phone, LinkedIn, Country for a person; Website, Country for a company), `Review changes` and `Cancel`. `Review changes` sends only the fields whose value differs from the profile.
  - A refused proposal (`ok: false`) shows its `reason` under the control. When the reason is the company lookalike message, a button `It's a different company` re-sends with `newCompany: true`.
- A returned proposal is shown as a `ChangeCard` below the buttons, with the same Confirm / Cancel behaviour and guards as in Ask (reuse the card logic; extract a small hook or helper shared with `AskPanel` rather than copying it). After a confirmed change: the card shows the server's message and the profile reloads.
- `ChangeCard` for `update_details`: title `Edit details`; the contact line (`targetName`, and company for a person); one line per change `<Label>: <from or "(empty)"> → <to or "(empty)">`; when `addsToPipeline` is set, a line `This also adds <targetName> to the pipeline as <role with underscores as spaces>.`; Confirm and Cancel.
- AskPanel: an assistant turn's refs render as tappable chips under the answer, at most five, labelled with the contact's name; tapping calls a new prop `onOpenContact(target)`; `MonsoonApp` switches to Contacts with that profile open. `update_details` proposals from the assistant render with the same card.
- ProfileView gets an `Ask about this contact` button in the actions area: switches to Ask with the draft `About <name>: ` (it does not send).
- The estate buttons and the mode switch are locked while a profile action is in flight (`onBusy`), released on every exit path.

- [ ] **Step 1: Write the failing tests**: add note → proposal → card → confirm → reload; move stage lists stages and hides without a membership; edit sends only changed fields; a refusal shows its reason; the lookalike reason offers `It's a different company`; the edit card's lines, the adds-to-pipeline line, Confirm sends the proposal and signature, double tap sends once, a 403 marks it expired, a failure leaves it open; a `partly` message is shown; refs chips open the profile; `Ask about this contact` fills the Ask draft; locks during a pending action; `getProfile` returns `stages`.
- [ ] **Step 2: Run** `npx vitest run src/components/monsoon src/lib/monsoon/contacts.db.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run && npx tsc --noEmit && npm run build`. Expected: PASS; the build lists `/monsoon` and the `/api/monsoon/*` routes including `contacts`, `contact` and `propose`.
- [ ] **Step 5: Commit**: `git add src/components/monsoon src/lib/monsoon/contacts.ts src/lib/monsoon/contacts.db.test.ts && git commit -m "feat(monsoon): profile actions, edit card and profile links from Ask"`.
