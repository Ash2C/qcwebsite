# Monsoon Any-Photo Capture (CRM brain, stage 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any photo showing a person's name (card, badge, name tag, website, slide, list) becomes the right CRM record: Monsoon checks for a match as soon as the photo is read and lets Vincent open the profile, add what's new, or save as new.

**Architecture:** The reader's instruction is widened and each entry gets a `kind`. The read route, given the estate, runs a read-only match for each entry and returns it with the cards. The capture transaction gains: choosing a matched person by id (same name or same email), logging on a member company's timeline instead of creating a second pipeline entry, capture-kind wording, and a "needs company" answer for a namesake with no company. The single form and the batch list show a match line per person.

**Tech Stack:** Next.js 15, React 19, Tailwind 3, Vitest 2, `pg`, `@anthropic-ai/sdk` (native structured outputs), Postgres 16 in Docker for tests.

**Spec:** `docs/superpowers/specs/2026-11-13-monsoon-brain-design.md`, stage 2 of section 7: sections 5.4, 6.3 and the "Capture changes" part of section 12 (section 12 overrides).

## Global Constraints

- Repo `C:\Dev\Quantcloud\QCwebsite`, branch `monsoon-photos`, worktree `.worktrees/monsoon-photos`.
- **Never delete.** No server code issues `DELETE`, `TRUNCATE` or `DROP`, or updates `touches.summary` or any `notes` column. `src/lib/monsoon/no-delete.test.ts` stays green without loosening.
- Capture still writes only what it writes today (orgs, people, members, captures, touches inserts; fill-empty updates of `title, email, phone, linkedin_url`), through the one transaction in `src/lib/monsoon/capture.ts`. Matching is read-only.
- Owner and `by_whom` stay the literal `VF`; `source` and `channel` stay `monsoon-app`.
- The reader: model default `claude-haiku-5-5`, `resolveModel()` unchanged, native structured outputs (`output_config.format`), no tools, at most 12 entries, all-empty entries dropped, `max_tokens` stop throws, client `{ timeout: 25_000, maxRetries: 0 }`.
- The read route keeps: session first, the Content-Length precheck, the 3,700,000-byte limit, the three image types, logging only an error name and status. A failed or unavailable match never fails the read.
- Capture kinds: `card`, `badge`, `screen`, `other`. Timeline wording by kind: `Card captured in person`, `Badge captured in person`, `Captured from a screenshot`, `Captured from a photo`; no kind given → `Card captured in person` (today's wording).
- No change to: `auth.ts`, `db.ts`, `next.config.ts`, the session, estates, refine, ask, act, propose, contacts, contact and alpha routes, the Contacts tab, any database schema. No new dependencies.
- Existing duplicate guards stay: the capture-id lock, the lookalike-company check, the same-name prompt at save.
- `import type` only for server types in client files. Monsoon brand classes from `src/components/monsoon/styles.ts`.
- Tests: explicit vitest imports; database tests use `testDb` (`describe.skipIf(!testDb.available)`) and must run, not skip; component tests use `// @vitest-environment jsdom`, stub `localStorage`, mock `./api` and `./image`; no act() warnings; no network calls; `npx tsc --noEmit` clean; `npm run build` succeeds.

## Review Focus

1. **A photo of someone already on file must not create a second record**: exact match by name and company, by email under a different spelling, and by name alone. (Task 2 match tests; Task 3 `choosing a match by email`.)
2. **A person at a company that is already a pipeline member**: no second pipeline entry; the meeting lands on the company's timeline with the person's name first. (Task 3 tests.)
3. **Two different people with the same name**: `Different person` with a company creates a second person; without a company Monsoon asks for it and writes nothing. (Task 3 `needs_company`.)
4. **The match lookup is down or slow**: the photo still reads and the form is usable; nothing claims "New contact" when matching did not run. (Task 2 route test; Task 4 `no match line when matching did not run`.)
5. **A name tag with only a first name, or an image with no person**: one entry with just the name; zero entries with `No name found in that photo.` (Task 1 and Task 4 tests.)

---

### Task 1: The reader accepts any photo with a name

**Files:**
- Modify: `src/lib/monsoon/extract.ts`, `src/lib/monsoon/extract.test.ts`

**Interfaces:**
- Produces: `export type CardKind = "card" | "badge" | "screen" | "other"`; `CardFields` gains `kind: CardKind` (eighth key). `extractCards` signature unchanged.

Fixed decisions:
- Schema: each entry gains required `kind`, a string enum of the four values. A missing or unknown `kind` in the model's output becomes `"other"`. An entry counts as empty (and is dropped) when its seven text fields are all empty, whatever its `kind`.
- User text block: `Find every person named in this image.`
- System instruction, verbatim:

> You are given one image. It may be a business card, a conference badge, a name tag on clothing, a screenshot of a website, a LinkedIn profile, an email signature, a slide, an attendee or team list, or anything else that shows people's names. Return one entry in `cards` for each person you can identify by a visible name, in reading order: top to bottom, then left to right. Never merge two people into one entry and never split one person into two. For each person, copy only the details that are visibly attached to that person, exactly as shown: `name` is the person's name only; `title` their job title; `org` their company or organisation; `email`, `phone` and `linkedin` only if shown for that person. If a detail is not shown for that person, leave that field as an empty string; never guess, infer, or borrow a detail from another person or from elsewhere in the image. A company logo or page header may be used as `org` only when the image is clearly about that one company (a card, a badge, a company's own team page). `raw_text` is the text belonging to that person, line by line. `kind` is `card` for a business card, `badge` for a badge or name tag, `screen` for a screenshot, slide or other image of a screen or document, and `other` for anything else. If the image names no person, or nothing is legible, return an empty `cards` list.

- [ ] **Step 1: Write the failing tests** (mocked SDK): the schema has `kind` as a required enum on each entry; the user text; a name-tag reply `{ cards: [{ name: "Priya", kind: "badge" }] }` returns one entry with only `name` set and `kind: "badge"`; a web-page reply with three people returns three in order with `kind: "screen"`; a missing or invalid `kind` becomes `"other"`; an entry with only `kind` set is dropped; the 12 cap; `{ cards: [] }` → `[]`; a `max_tokens` stop still throws; existing malformed-output cases still pass.
- [ ] **Step 2: Run** `npx vitest run src/lib/monsoon/extract.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same, then `npx tsc --noEmit` (fix the type fallout of the new key in other files minimally: default `kind: "card"` where a `CardFields` literal is built, and say where in the report). Expected: PASS.
- [ ] **Step 5: Commit**: `git add docs/superpowers src/lib/monsoon/extract.ts src/lib/monsoon/extract.test.ts` plus any file touched for the type fallout, then `git commit -m "feat(monsoon): read any photo that shows a person's name"`.

---

### Task 2: Match before save

**Files:**
- Create: `src/lib/monsoon/match.ts`, `src/lib/monsoon/match.db.test.ts`
- Modify: `src/app/api/monsoon/read/route.ts`, `route.test.ts`

**Interfaces:**
- Consumes: `CardFields` (Task 1); `readOnly`, `MemberRef` (`ask/queries.ts`); `nameKey` (`rules.ts`); `withEstateDb`, `estateByKey`.
- Produces:

```ts
// match.ts
export type MatchCandidate = {
  personId: string; name: string; title: string | null; company: string | null; email: string | null;
  member: MemberRef | null;                 // own membership, else the company's, else null
  memberOf: "self" | "company" | null;
  by: "name_company" | "email" | "name";    // why this person matched
};
export type CardMatch = { match: "none" | "exact" | "same_name" | "several"; candidates: MatchCandidate[] };
export function matchCards(db: ClientBase, cards: { name: string; org: string; email: string }[], opts?: QueryOptions): Promise<CardMatch[]>;   // one per card, same order
```

- `POST /api/monsoon/read`: an optional multipart field `estate`. Response 200 `{ cards: CardFields[], matches: CardMatch[] | null }`. `matches` is `null` when no valid `estate` was sent, when there are no cards, or when the match lookup throws (logged by error name and code only); the read still answers 200. All other statuses unchanged.

Fixed decisions (per card):
- A card with a blank name → `none`.
- `exact`: a person whose name key equals the card's and whose company's name key equals the card's `org` (`by: "name_company"`); and/or a person whose email equals the card's email, case-insensitively, when the card has one (`by: "email"`). One distinct person → `exact`. Two or more distinct people → `several` (all listed, email matches first).
- Otherwise people with the same name key (`by: "name"`): one → `same_name`; two or more → `several`; none → `none`.
- At most 5 candidates per card, ordered: email, name and company, then name, each by `created_at, id`.
- One read-only transaction for the whole batch of cards; set-based queries (no query per candidate beyond what the card count needs); never throws for odd input (blank, very long, `%`).

- [ ] **Step 1: Write the failing tests.** `match.db.test.ts` (seed: Northwind Capital a company member with people Jane Tan (jane@northwind.example) and Omar Reyes; Acme Capital not a member with person-member Li Wei; a company-less person member Jane Tan; Sam Ortiz at Orphan Co with no membership): `Jane Tan` + `Northwind Capital` → `exact` by name_company with `memberOf: "company"`; case and spacing differences in name and company still match; `Jon Tan` + email `JANE@northwind.example` → `exact` by email; name `Jane Tan` with no org → `several` (both Janes); `Li Wei` with org `Other Co` → `same_name`; `Sam Ortiz` → `same_name` with `member: null`; an email belonging to one person and a name+company belonging to another → `several`; unknown → `none`; blank name → `none`; a batch of mixed cards returns results in order; five-candidate cap; row counts unchanged and the connection left outside a transaction. Route tests (mock `@/lib/monsoon/match`, `@/lib/monsoon/db`, `@/lib/monsoon/extract`): no `estate` → `matches: null` and no database call; valid estate → `matchCards` called with each card's `name, org, email` and its result returned; unknown estate → `matches: null`; `matchCards` rejecting → 200 with the cards and `matches: null`, logged without the message; zero cards → `matches: null`; the existing 401, 411, 413, 415, 502 cases unchanged.
- [ ] **Step 2: Run** `npx vitest run src/lib/monsoon/match.db.test.ts src/app/api/monsoon/read`. Expected: FAIL, not skipped.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same, then `npx vitest run && npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit**: `git add src/lib/monsoon/match.ts src/lib/monsoon/match.db.test.ts src/app/api/monsoon/read && git commit -m "feat(monsoon): match people in a photo against the CRM before saving"`.

---

### Task 3: Capture changes

**Files:**
- Modify: `src/lib/monsoon/capture.ts`, `src/lib/monsoon/capture.db.test.ts`
- Modify: `src/app/api/monsoon/save/route.ts`, `route.test.ts`
- Modify: `src/components/monsoon/outcomes.ts`, `outcomes.test.ts`

**Interfaces:**
- `CaptureInput` gains `kind?: CardKind`.
- `CaptureResult` gains:
  - `{ outcome: "filed"; person: string; org: string; role: string; filled: string[]; created: boolean }` (the meeting was logged on the person's company's pipeline entry; `role` is that entry's role; `created` says whether the person record is new)
  - `{ outcome: "needs_company"; orgs: (string | null)[] }` (a different person with this name and no company cannot be stored without one)
- `save` route: body gains optional `kind`; passed through when it is one of the four values, dropped otherwise. 200 for the two new outcomes like the others.
- `outcomes.ts` `describeResult` handles them: `filed` with `created` → `{ kind: "done", text: "<name> filed under <org>." }`; `filed` without → `<name> is already on file under <org>; meeting logged.` (and `; filled in <fields>` before the full stop when `filled` is non-empty); `needs_company` → `{ kind: "info", text: "Add their company so I can tell them apart." }`.

Fixed decisions (in the order capture runs):
- **Choosing a match by id.** `samePerson` as a string is accepted when that person exists and either has the same name key as the entry **or** has an email equal (case-insensitively) to the entry's email. Otherwise `invalid` as today. The reused person keeps their name and company on file; the existing "card shows <company>" note applies when the typed company differs.
- **Different person without a company.** When `samePerson === false`, no company was typed, and at least one person with this name key exists → `needs_company` with those people's companies, nothing written. (Today this case silently reuses a single namesake or returns `ambiguous`.) `samePerson === false` with a company proceeds as today and creates a separate person at that company.
- **A person at a member company.** At step 5, when the person has no membership of their own and their company (the person's `org_id`) has a pipeline member, do not create a member: use the company's member for the timeline entry and return `filed`. This applies to a brand-new person as well as an existing one. The Notes text goes only into the timeline entry (the company member's `notes` column is never touched). A person with their own membership, or whose company is not a member, behaves exactly as today (`existing` / `added`).
- **Timeline wording.** The base text comes from `kind` (Global Constraints). For `filed` the summary is prefixed with the person's name: `<name>: <base>[: <notes>][ (card shows <company>)]`.
- `COMMIT` on `added`, `existing` and `filed`; `ROLLBACK` on everything else.
- The captures row, the capture-id duplicate check, the role check, the lookalike guard and the same-name prompt are unchanged.

- [ ] **Step 1: Write the failing tests** (`capture.db.test.ts` additions; the existing tests must keep passing, except any that asserted a second pipeline entry for a person at a member company, which are updated and listed in the report): `choosing a match by email`: `samePerson` = an existing person whose name differs but whose email equals the entry's → reused, no new person, details filled; `samePerson` naming a person with a different name and a different email → `invalid`; `a new person at a member company is filed under it`: Northwind is a company member; capture `Omar Reyes` at `Northwind Capital` → `filed`, `created: true`, one new `people` row, no new `members` row, one `touches` row on Northwind's member with summary `Omar Reyes: Card captured in person`, the company member's `notes` unchanged; `an existing person at a member company is filed again` → `filed`, `created: false`, second touch; with notes and a kind: `Omar Reyes: Badge captured in person: met at SFF`; a person with their own membership at a member company still gets `existing` and logs on their own member; `needs_company`: a company-less Jane Tan exists; capture `Jane Tan` with `samePerson: false` and no company → `needs_company`, nothing written; the same with a company → `added` and two people; kind wording for `badge`, `screen`, `other`, and no kind; `filed` commits and a repeat of the same `captureId` is `duplicate`. `save/route.test.ts`: `kind` passed through when valid and dropped when not; the new outcomes return 200. `outcomes.test.ts`: the three new texts exactly.
- [ ] **Step 2: Run** `npx vitest run src/lib/monsoon/capture.db.test.ts src/app/api/monsoon/save src/components/monsoon/outcomes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Keep `tsc` green in the screens that switch on `CaptureResult` with the smallest change that preserves their behaviour (treat `filed` like `existing` and `needs_company` like `ambiguous` where a screen must do something); Task 4 and Task 5 refine the screens.
- [ ] **Step 4: Run** the same, then `npx vitest run && npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit**: `git add src/lib/monsoon/capture.ts src/lib/monsoon/capture.db.test.ts src/app/api/monsoon/save src/components/monsoon/outcomes.ts src/components/monsoon/outcomes.test.ts` plus any screen file touched for the type fallout, then `git commit -m "feat(monsoon): capture files people under member companies and takes a matched person by id"`.

---

### Task 4: Match line on the single form

**Files:**
- Create: `src/components/monsoon/MatchLine.tsx`, `MatchLine.test.tsx`
- Modify: `src/components/monsoon/api.ts`, `api.test.ts`, `MonsoonApp.tsx`, `MonsoonApp.test.tsx`

**Interfaces:**
- Consumes: the read route's `{ cards, matches }` (Task 2); `CardMatch`, `MatchCandidate`, `CardKind` as types; `openContact` in `MonsoonApp` (already used by the Ask chips).
- Produces: `api.ts` `readCards(image: Blob, estate: string)` sends the `estate` field and returns `{ cards, matches }`; `SaveBody` gains `kind?: CardKind`.

```ts
// MatchLine.tsx
export type MatchChoice = { samePerson: string | false } | null;   // null = not chosen yet
export default function MatchLine(props: {
  match: CardMatch;
  choice: MatchChoice;
  onChoose: (choice: MatchChoice) => void;
  onOpen: (personId: string) => void;
  disabled?: boolean;
}): JSX.Element;
```

Fixed behaviour and copy:
- The photo button reads `Snap or choose a photo` (was `Take photo`); while reading, `Reading photo…`.
- After a read with exactly one entry, the form is filled as today and the entry's `kind` is kept for the save. Zero entries: the form is cleared for typing (typed Notes kept) and the message `No name found in that photo.` is shown.
- When `matches` is `null`, no match line is shown at all (matching did not run).
- `MatchLine` by `match.match`:
  - `none`: one quiet line `New contact`.
  - `exact` or `same_name` (one candidate): `Already on file: <name>, <company or "no company">` and, when the candidate is filed under a company or on the pipeline, a second quiet line `<role label or key> · <stage>` / `filed under <company>`; three buttons `Open profile`, `Add what's new`, `Different person`. The chosen one of the last two is shown selected.
  - `several`: `Possible matches` then one row per candidate (`<name>, <company or "no company">`) each with `This one` and `Open`; and a final `None of these` button.
- Defaults: for `exact`, `Add what's new` is preselected (`choice = { samePerson: <candidate id> }`); for `same_name` and `several` nothing is preselected.
- Choices map to the save: `Add what's new` / `This one` → `samePerson: <personId>`; `Different person` / `None of these` → `samePerson: false`; nothing chosen → `samePerson` not sent (the server's own same-name prompt applies as today).
- `Open profile` / `Open` switches to the Contacts tab with that person's profile open, keeping the capture form as it is.
- Editing the Name or Company field after a read hides the match line and clears the choice (the match no longer describes what will be saved). Editing other fields keeps it.
- A name-only read (no company): a quiet hint under the Company field, `Add their company if you know it.`, until the field is non-empty.
- The save sends `kind` from the read (nothing for a hand-typed entry).
- Result messages use `describeResult` (Task 3), so `filed` and `needs_company` show their texts; after `needs_company` the form stays with the cursor in Company.
- The match line is locked (buttons disabled) while reading, saving or tidying.

- [ ] **Step 1: Write the failing tests**: `MatchLine` each variant's text and buttons, the selected state, callbacks, disabled; `api` `readCards` sends `estate` and returns matches; `MonsoonApp`: button label; `no match line when matching did not run` (`matches: null`); `New contact`; an `exact` match preselects `Add what's new` and Save sends `samePerson` = that id and `kind`; `Different person` sends `samePerson: false`; a `same_name` match with nothing chosen sends no `samePerson`; `several` → `This one` sends that id; editing Name hides the line and clears the choice; editing Email keeps it; `Open profile` switches to Contacts with the form kept; zero entries shows `No name found in that photo.`; the company hint; a `filed` result shows its text; `needs_company` shows its text and keeps the form. Existing tests updated only for the button label and the `readCards` signature (list them in the report).
- [ ] **Step 2: Run** `npx vitest run src/components/monsoon`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run && npx tsc --noEmit && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit**: `git add src/components/monsoon && git commit -m "feat(monsoon): show whether a photographed person is already on file"`.

---

### Task 5: Match lines in the batch list

**Files:**
- Modify: `src/components/monsoon/BatchReview.tsx`, `BatchReview.test.tsx`, `MonsoonApp.tsx`, `MonsoonApp.test.tsx`

**Interfaces:**
- Consumes: `MatchLine`, `MatchChoice` (Task 4); `CardMatch`, `CardKind`.
- `BatchRow` gains `kind: CardKind` and `match: CardMatch | null`; `makeBatch(cards, matches, role, note)` takes the matches array (or `null`).

Fixed behaviour and copy:
- A batch opens for two or more entries as today; a screenshot of a list is just a batch.
- Each row's summary line gains a small tag: `New` (match `none`), `On file` (`exact`), `Check` (`same_name` or `several`), nothing when `match` is `null`.
- The row editor shows the same `MatchLine` above its fields, with the same defaults and choice mapping, writing to the row's `samePerson`. Editing the row's Name or Company clears the row's match and choice.
- `Save all` sends each row's `kind`, and its `samePerson` when chosen. A row tagged `Check` with nothing chosen is saved as today (the server may answer with its same-name prompt on that row).
- `Open profile` from a row is offered only when no batch save is running, and asks nothing: it switches to Contacts and the batch stays open underneath.
- Row result texts come from `describeResult`; `filed` is a saved row; `needs_company` puts the row in the needs-answer state with its message and no buttons (editing Company makes it pending again).
- Header copy unchanged (`<n> cards found` / `1 card found`).

- [ ] **Step 1: Write the failing tests**: tags per match kind and none when `match` is null; an `exact` row saves with `samePerson` preselected and `kind`; choosing `Different person` in a row; editing a row's Name clears its match; a `filed` result marks the row saved with its text; `needs_company` puts the row in needs-answer and editing Company returns it to pending; `Open profile` hidden during a running save; `makeBatch` keeps matches aligned with rows when all-empty cards were dropped upstream (matches index by card).
- [ ] **Step 2: Run** `npx vitest run src/components/monsoon`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run && npx tsc --noEmit && npm run build`. Expected: PASS; the build lists `/monsoon` and the `/api/monsoon/*` routes.
- [ ] **Step 5: Commit**: `git add src/components/monsoon && git commit -m "feat(monsoon): match lines in the batch list"`.
