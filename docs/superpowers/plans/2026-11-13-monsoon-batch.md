# Monsoon Batch Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One photo containing several business cards yields one normal CRM entry per card, through a review list with Save all.

**Architecture:** The photo-reading call returns a list of cards instead of one. The screen keeps today's single form for 0 or 1 cards and shows a new controlled `BatchReview` component for 2 or more; each card is saved through the unchanged `/api/monsoon/save` route with its own `captureId`. The text and prompt logic for a save result is pulled out of `MonsoonApp.tsx` into a pure module both screens use.

**Tech Stack:** Next.js 15, React 19, Tailwind 3, Vitest 2, `@anthropic-ai/sdk` (native structured outputs).

**Spec:** `docs/superpowers/specs/2026-11-13-monsoon-batch-design.md` (extends `2026-11-13-monsoon-capture-design.md`).

## Global Constraints

- Repo `C:\Dev\Quantcloud\QCwebsite`, branch `monsoon-batch`, worktree `.worktrees/monsoon-batch`.
- No change to `src/app/api/monsoon/save`, `src/lib/monsoon/capture.ts`, `rules.ts`, `auth.ts`, `db.ts`, the session or estates routes, `next.config.ts`, or any database.
- Model default stays `claude-haiku-5-5`; `resolveModel()` unchanged (Opus and Fable refused). Native structured outputs via `output_config.format`; no tools, no `tool_choice`.
- The read route keeps: session check first, the Content-Length precheck, the 3,700,000-byte limit, the three accepted image types, logging only an error name and numeric status.
- At most 12 cards per photo. Cards whose seven fields are all empty are dropped.
- Each card saved gets its own `crypto.randomUUID()` `captureId`, kept across that card's re-saves, never shared between cards.
- A photo with exactly one card must behave exactly as the single form does today; every existing `MonsoonApp.test.tsx` test keeps passing (adjusted only for the `readCards` rename and `{ cards }` shape).
- The photo is never stored or logged. No new dependencies.
- `import type` only for server types in client files.
- Tests: explicit vitest imports, `// @vitest-environment jsdom` for component tests, no act() warnings, `npx tsc --noEmit` clean, `npm run build` succeeds.

## Review Focus

1. **Two cards read as one, or one as two**: the prompt must say never merge and never split; `extractCards` must not invent structure. (Task 1 test `passes through each card separately`.)
2. **A batch where one card needs an answer**: the others still save, and answering re-saves only that card. (Task 2 test `a lookalike on one card does not block the rest`.)
3. **Double tap on Save all**: no card is saved twice. (Task 2 test `Save all is ignored while a batch save is running`.)
4. **Session expires mid-batch**: passcode screen, then the batch is intact with saved rows still marked saved. (Task 2 test `keeps the batch across a 401`.)
5. **Model returns more than 12 cards, or junk entries**: capped at 12, empties dropped, non-object entries ignored. (Task 1 test `caps at 12 and drops empty or malformed entries`.)

---

### Task 1: Read several cards from one photo

**Files:**
- Modify: `src/lib/monsoon/extract.ts`, `src/lib/monsoon/extract.test.ts`
- Modify: `src/app/api/monsoon/read/route.ts`, `src/app/api/monsoon/read/route.test.ts`
- Modify: `src/components/monsoon/api.ts`, `src/components/monsoon/image.ts`
- Modify: `src/components/monsoon/MonsoonApp.tsx`, `src/components/monsoon/MonsoonApp.test.tsx` (rename and shape only)

**Interfaces:**
- Produces:
  - `extract.ts`: `MAX_CARDS = 12`; `extractCards(image: { base64: string; mediaType: "image/jpeg" | "image/png" | "image/webp" }): Promise<CardFields[]>` replaces `extractCard` (remove the old export). `CardFields` and `resolveModel` unchanged.
  - `POST /api/monsoon/read` → 200 `{ cards: CardFields[] }` (was `{ fields }`); every other status unchanged.
  - `api.ts`: `readCards(image: Blob): Promise<ApiResult<{ cards: CardFields[] } | { error: string }>>` replaces `readCard`.
  - `image.ts`: `downsizeImage(file: File, maxSide = 2400, quality = 0.8, maxBytes = 3_600_000): Promise<Blob>`.

- [ ] **Step 1: Write the failing tests**

`extract.test.ts` (update existing tests to the new function and add):
- the request has `output_config.format.type === "json_schema"` whose schema is an object with one required property `cards`: an array whose items are objects with exactly the seven string keys, all required, `additionalProperties: false`; no `tools`, no `tool_choice`; user text block is `Read every card in this photo.`
- `passes through each card separately`: a response of `{ cards: [{ name: " Jane Tan ", org: "Acme" }, { name: "Raj Mehta", email: "raj@corvane.example" }] }` returns two `CardFields`, in order, trimmed, missing keys `""`.
- `caps at 12 and drops empty or malformed entries`: 15 valid cards → 12; `{ cards: [{}, { name: "" }, "x", null, 5, { name: "A" }] }` → one card; non-string values become `""`.
- returns `[]` for: `{ cards: [] }`, `{}`, `{ cards: "x" }`, a top-level array, unparseable text, no text block, `stop_reason` `refusal`, `stop_reason` `max_tokens`.
- an API error still rejects; a model id matching `/opus|fable/i` still rejects before `create` is called.

`read/route.test.ts`: the success case expects `{ cards: [...] }` from a mocked `extractCards`; a mocked `[]` returns 200 `{ cards: [] }`; all other existing cases unchanged.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run src/lib/monsoon/extract.test.ts src/app/api/monsoon/read`
Expected: FAIL (`extractCards` is not exported).

- [ ] **Step 3: Implement**

`extract.ts` system instruction, verbatim:

> You read one photo that may show one or several business cards or conference name badges. Return one entry in `cards` for each separate card or badge, in reading order: top to bottom, then left to right. Never merge two cards into one entry and never split one card into two. Copy each value exactly as printed on that card. If a value is not printed on that card, leave that field as an empty string; never guess, infer, or borrow a value from another card. `name` is the person's name only. `org` is the company or organisation. `linkedin` is a LinkedIn URL or handle if printed. `raw_text` is all legible text on that card, line by line. If the photo shows no card or badge, or nothing is legible, return an empty `cards` list.

Keep `max_tokens: 8192`, the client options, and the refusal / `max_tokens` / unparseable handling (they now yield `[]`).

`image.ts`: after encoding, if the blob is larger than `maxBytes`, re-encode the same canvas at quality 0.6; if still larger, redraw at `maxSide * 0.75` and encode at 0.6; return that result. Update the header comment.

`api.ts`: rename and retype as above. `MonsoonApp.tsx`: call `readCards`, and for now use `cards[0]` when present, otherwise treat as an empty read (form cleared for typing by hand, typed Notes kept). Update `MonsoonApp.test.tsx` mocks to `readCards` resolving `{ cards: [...] }`.

- [ ] **Step 4: Run to see them pass**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all pass, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/monsoon/extract.ts src/lib/monsoon/extract.test.ts src/app/api/monsoon/read src/components/monsoon
git commit -m "feat(monsoon): read several cards from one photo"
```

---

### Task 2: Batch review screen

**Files:**
- Create: `src/components/monsoon/outcomes.ts`, `src/components/monsoon/outcomes.test.ts`
- Create: `src/components/monsoon/BatchReview.tsx`, `src/components/monsoon/BatchReview.test.tsx`
- Modify: `src/components/monsoon/MonsoonApp.tsx`, `src/components/monsoon/MonsoonApp.test.tsx`

**Interfaces:**
- Consumes: `readCards`, `saveCard`, `SaveBody`, `EstateInfo` from `./api`; `CardFields`, `CaptureResult` as types.
- Produces, from `outcomes.ts` (pure, no React):

```ts
export type SavePrompt =
  | { kind: "org_lookalike"; similar: string[] }
  | { kind: "same_name"; matches: { personId: string; org: string | null }[] };

export type Outcome =
  | { kind: "done"; text: string }                       // added | existing | duplicate
  | { kind: "prompt"; text: string; prompt: SavePrompt } // org_lookalike | same_name
  | { kind: "info"; text: string };                      // ambiguous

export function describeResult(
  result: CaptureResult,                                 // never called with outcome "invalid"
  ctx: { name: string; org: string; estateLabel: string; roleLabel: (key: string) => string },
): Outcome;
```

  The texts are exactly the strings `MonsoonApp.tsx` produces today for each outcome (move them, do not reword). `MonsoonApp.tsx` is refactored to call `describeResult`; its behaviour and tests do not change.
- Produces, from `BatchReview.tsx`:

```ts
export type BatchRow = {
  id: string;                    // local key
  captureId: string;             // crypto.randomUUID(), fixed for the row's life
  fields: { name: string; title: string; org: string; email: string; phone: string; linkedin: string };
  extracted: CardFields;
  role?: string;                 // undefined = use the batch role
  notes?: string;                // undefined = use the batch note
  newOrg?: boolean;
  samePerson?: string | false;
  status: "pending" | "saving" | "saved" | "needs" | "failed";
  message?: string;
  prompt?: SavePrompt;
};
export type Batch = { rows: BatchRow[]; role: string; note: string };

export function makeBatch(cards: CardFields[], role: string, note: string): Batch;

export default function BatchReview(props: {
  estate: EstateInfo;
  batch: Batch;
  onChange: (next: Batch | ((prev: Batch) => Batch)) => void;   // state lives in MonsoonApp
  onUnauthorized: () => void;                                    // a save returned 401
  onClose: (summary: string | null) => void;                     // Done (summary text) or Discard (null)
}): JSX.Element;
```

Fixed behaviour and copy:
- `MonsoonApp` holds `batch: Batch | null`. After a read: 0 cards → as today; 1 card → as today; 2 or more → `setBatch(makeBatch(cards, <current role>, <Notes typed in the single form>))` and render `<BatchReview>` in place of the single form (estate selector stays above it). The batch survives the passcode screen because it lives in `MonsoonApp` state.
- Header: `<n> cards found` (n = rows not removed). Below it the batch Role select (the estate's roles) and batch Note input.
- Row summary: `<name> · <org>`; without an org, `<name> · <email>` or just `<name>`; without a name the name part is `(no name)` and the row shows the flag `Add a name`.
- Tapping a row toggles its editor: the six fields, a Role select whose first option is `Same as batch`, a Notes input with placeholder `Same as batch`, and a `Remove` button. Editing a field of a row whose status is `needs` or `failed` returns it to `pending` and clears its message and prompt. A `saved` row is read-only and cannot be removed.
- Eligible rows: status `pending` or `failed`, with a non-blank name. Button: `Save all (<eligible count>)`, disabled when the count is 0 or a batch save is running.
- Save all: a ref guard ignores a second call while one runs. Eligible rows are saved strictly one after another (never in parallel), each with `{ estate: estate.key, captureId: row.captureId, role: row.role ?? batch.role, fields: { ...row.fields, notes: (row.notes ?? batch.note) || undefined }, extracted: row.extracted, newOrg: row.newOrg || undefined, samePerson: row.samePerson }` (empty optional fields omitted, as the single form does). Per result:
  - 200 → `describeResult`: `done` → status `saved`, message = its text; `prompt` → status `needs`, message and prompt set; `info` (ambiguous) → status `needs`, message set, no prompt (editing the company makes it pending again).
  - 400 → status `failed`, message = the server's `error` string.
  - 401 → stop the loop immediately, leave that row `pending`, call `onUnauthorized()`.
  - any other status or a thrown error → status `failed`, message `Could not save. Retry.`; the loop continues with the next row.
- Prompt buttons on a `needs` row, same labels as the single form: `Use <similar>` (sets `fields.org` to that name), `It's a different company` (sets `newOrg: true`), `Same person (<org or "no company">)` (sets `samePerson` to that id), `Different person` (sets `samePerson: false`). Each then saves that one row immediately (same guard), keeping its `captureId` and any earlier `samePerson` answer.
- When no row is `pending`, `needs`, `failed` or `saving` and at least one is `saved`: show `<k> saved to <estate label>.` (k = saved rows) and a `Done` button → `onClose("<k> saved to <estate label>.")`. `Discard batch` is always shown → `onClose(null)`; if any row is still unsaved it asks once with `window.confirm("Discard the unsaved cards?")`.
- In `MonsoonApp`: while a batch has any `saved` row the estate buttons are disabled; switching estate before that resets `batch.role` to the new estate's start role and clears every row's `role` override. `onClose(summary)` clears the batch, clears the single form, and shows the summary as the ok message when non-null. Taking a new photo while a batch is open is not offered (the photo button is hidden during a batch).
- Styling follows the existing classes in `MonsoonApp.tsx` (`card`, `fieldInput`, `fieldLabel`, `primaryButton`, `secondaryButton`); export those constants from a small `styles.ts` if both components need them. 16 px+ inputs, 44 px+ touch targets, light and dark.

- [ ] **Step 1: Write the failing tests**

`outcomes.test.ts`: one test per `CaptureResult` outcome (`added`; `existing` with fills; `existing` with none; `duplicate`; `org_lookalike` with one similar; with several; `same_name`; `ambiguous`) asserting the exact text currently produced by `MonsoonApp.tsx` and the `kind` / `prompt` payload.

`BatchReview.test.tsx` (mock `./api`; render through a small wrapper holding the `Batch` in `useState`):
- `lists one row per card with the batch role and note`.
- `a nameless card is flagged and not counted`: three cards, one without a name → button reads `Save all (2)`.
- `Save all saves each eligible card once, in order, with its own captureId`: `saveCard` called n times sequentially (the second call starts only after the first resolves), captureIds all different, each body carries the batch role and note.
- `per-card role and note override the batch values`.
- `a lookalike on one card does not block the rest`: card 2 returns `org_lookalike` → cards 1 and 3 are `saved`, card 2 shows its buttons; clicking `Use <similar>` calls `saveCard` once more with that org, the same captureId as card 2's first attempt, and no `newOrg`; `It's a different company` sends `newOrg: true`.
- `same name on one card`: `Same person (...)` re-saves with `samePerson` = that id; `Different person` with `false`.
- `a failed card shows "Could not save. Retry." and the next Save all retries only it`.
- `a 400 shows the server's error on that row`.
- `Save all is ignored while a batch save is running`: with the first `saveCard` pending, a second click makes no extra calls.
- `a 401 stops the batch and calls onUnauthorized`: the remaining rows are not sent and stay pending.
- `editing a needs row makes it pending again and clears its buttons`.
- `removing a card drops it; a saved card cannot be removed`.
- `shows "<k> saved to Traxo." and Done when every remaining card is saved`; `Done` calls `onClose` with that text.
- `Discard batch asks before dropping unsaved cards` (stub `window.confirm`).

`MonsoonApp.test.tsx` additions:
- `two or more cards open the batch review`; `one card still fills the single form`; `zero cards leaves the form usable`.
- `keeps the batch across a 401`: a batch save returns 401 → passcode screen → after sign-in the batch rows are still there and a previously saved row is still marked saved.
- `estate buttons are disabled once a batch card is saved`; `switching estate before saving resets the batch role`.
- `Done returns to the single form with the summary message`.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run src/components/monsoon`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement `outcomes.ts`, refactor `MonsoonApp.tsx` onto it, then `BatchReview.tsx` and the `MonsoonApp` wiring.**

- [ ] **Step 4: Run the full checks**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: all pass; the build lists `/monsoon` and the four `/api/monsoon/*` routes.

- [ ] **Step 5: Commit**

```bash
git add src/components/monsoon
git commit -m "feat(monsoon): batch review for photos with several cards"
```
