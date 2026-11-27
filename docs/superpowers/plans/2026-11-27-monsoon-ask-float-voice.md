# Monsoon Ask: Floating Window and Voice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Monsoon's modal Ask sheet with a floating, minimisable window, make voice the default way to ask on phones (spoken, captioned answers from a stock ElevenLabs voice), and add ratings plus a failure log.

**Architecture:** The Ask request logic moves out of `AskPanel` into a `useAsk` hook owned by `MonsoonApp`, so both the window and a new voice pill drive one conversation. The Ask route gains a `spoken` flag: the loop adds a spoken-reply instruction to the model's copy of the last question, and the route attaches best-effort ElevenLabs audio with caption timings. Ratings and voice failures go to a new append-only accounts table that holds no CRM text.

**Tech Stack:** Next.js App Router, TypeScript, React, node-pg, vitest + Testing Library, Web Speech API, Web Audio API, ElevenLabs `with-timestamps` endpoint.

**Spec:** `docs/superpowers/specs/2026-11-27-monsoon-ask-float-voice-design.md`

**Reference code (read-only, another repo):** `C:\Dev\01website\wt-ask` — `src/components/desk/VoiceAsk.tsx`, `src/components/desk/DeskDrawer.tsx`, `src/lib/desk/speech.ts`, `src/lib/desk/__tests__/speech.test.ts`. Port behaviour, not branding: no Zero One names, colours or pronunciation table.

## Global Constraints

- The app never deletes: no `DELETE` or `TRUNCATE` anywhere; `no-delete.test.ts` must pass.
- Anything Ask proposes still needs a confirmed signed card. No voice path confirms a change.
- No question, answer, contact name or note in any log, `console` call or review table.
- Public repo: no secrets, no client names in code, tests, fixtures or commit messages.
- No new model ids. No audio is ever sent to Monsoon's server.
- Window height `min(62dvh, 580px)`; listening cap 20 s; pause 1.5 s; no-speech 7 s; replay window 12 s; caption linger 1.5 s; spoken answer at most 70 words in two to four sentences; speech timeout 8 s; 150 spoken answers per person per 24 hours; feedback `detail` at most 200 characters.
- Env names: `ELEVENLABS_API_KEY`, `MONSOON_VOICE_ID`. Missing either means captions only, never an error.
- Monsoon colours and the 44px minimum tap target, as in `src/components/monsoon/styles.ts`; light and dark themes.
- Tests: `npx vitest run <files> --maxWorkers=3 --minWorkers=1`. Never run the whole suite with default workers (this PC runs out of memory). Database tests need `MONSOON_TEST_DB=postgresql://postgres:test@127.0.0.1:55434/postgres`.
- Commit after every task; messages start `feat(monsoon):`, `fix(monsoon):` or `test(monsoon):` and end with the `Co-Authored-By` line the session gives.

## Review Focus

1. A second tap on the pill while thinking, or two fast taps when idle, must send one question, not two.
2. An answer that arrives after the estate changed or the conversation was cleared must be dropped: no turn added, no audio played.
3. Audio that cannot be decoded (bad base64, unsupported format) must fall back to captions on their own timing, not hang in "speaking".
4. The phone locking or the tab being hidden while listening or speaking must stop cleanly and return to idle.
5. An empty answer, or one long sentence with no full stop, must not break captions: empty finishes at once; a long one shows in a strip that scrolls rather than covering the page.

Each has a pinned test: 1, 3, 4, 5 in Task 9; 2 in Task 6.

---

### Task 1: Accounts schema version 8 and store functions

**Files:**
- Modify: `src/lib/monsoon/accounts/schema.sql` (every `activity_action_check` list; new version 8 block)
- Modify: `src/lib/monsoon/accounts/store.ts`
- Modify: `src/lib/monsoon/accounts/account.ts`
- Test: `src/lib/monsoon/accounts/schema.db.test.ts`, `src/lib/monsoon/accounts/store.db.test.ts`

**Interfaces — Produces:**
```ts
// store.ts
export type ActivityAction = /* existing */ | "speak";
export type FeedbackKind = "up" | "down" | "no_speech" | "mic_blocked" | "unsupported" | "replay" | "stopped" | "typed_instead";
export const FEEDBACK_KINDS: readonly FeedbackKind[];
export const FEEDBACK_DAILY_LIMIT = 300;
/** Rows of this action by this person in the last 24 hours. */
export async function activityInLastDay(customerId: string, personId: string, action: ActivityAction): Promise<number>;
/** Appends one row; false (and nothing written) once the person has FEEDBACK_DAILY_LIMIT rows in 24 hours. */
export async function recordFeedback(a: { customerId: string; personId: string; pipelineKey: string | null; kind: FeedbackKind; mode: "voice" | "typed"; detail: string | null }): Promise<boolean>;
// account.ts, on the Account object
countInLastDay(action: ActivityAction): Promise<number>;
feedback(a: { pipelineKey: string | null; kind: FeedbackKind; mode: "voice" | "typed"; detail: string | null }): Promise<boolean>;
```
Table (version 8): `ask_feedback (id BIGSERIAL PK, customer_id UUID NOT NULL REFERENCES customers(id), person_id UUID NULL, pipeline_key TEXT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now(), kind TEXT NOT NULL CHECK (kind IN (...8 kinds)), mode TEXT NOT NULL CHECK (mode IN ('voice','typed')), detail TEXT NULL CHECK (detail IS NULL OR length(detail) <= 200))`, index on `(customer_id, at)`, RLS enabled, `INSERT INTO accounts_migrations (version) VALUES (8)`.

- [ ] **Step 1: Failing tests.** In `schema.db.test.ts`: version 8 is recorded; `ask_feedback` rejects a 201-character `detail`, an unknown `kind` and an unknown `mode`; an `activity` row with action `speak` inserts; running the schema twice succeeds. In `store.db.test.ts`: `activityInLastDay` counts only that person's rows of that action newer than 24 hours (insert one row with `at = now() - interval '25 hours'` and expect it uncounted); `recordFeedback` returns true and writes the row; with 300 rows already present it returns false and the count stays 300.
- [ ] **Step 2: Run** `npx vitest run src/lib/monsoon/accounts/schema.db.test.ts src/lib/monsoon/accounts/store.db.test.ts --maxWorkers=3 --minWorkers=1` — expect failures on the new cases.
- [ ] **Step 3: Implement.** Add `'speak'` to every existing action list in `schema.sql` (the comment at the version 4 block explains why all of them), then the version 8 block. Add the store functions and the two `Account` methods (customer and person ids come from the session, as `record` does).
- [ ] **Step 4: Run** the same command — expect pass. Also run `npx vitest run src/lib/monsoon/accounts --maxWorkers=3 --minWorkers=1`.
- [ ] **Step 5: Commit.**

### Task 2: Server speech library

**Files:**
- Create: `src/lib/monsoon/ask/speech.ts`
- Test: `src/lib/monsoon/ask/speech.test.ts`

**Interfaces — Produces:**
```ts
export const SPEECH_TIMEOUT_MS = 8_000;
export const SPOKEN_REPLY_INSTRUCTION: string;
export type Caption = { text: string; start: number; end: number };
export type Alignment = { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };
export function cleanForSpeech(text: string): string;          // strips ** __ ` and leading "- " / "* " bullets, trims
export function splitSentences(text: string): string[];        // split on . ! ? followed by whitespace; "1.2" stays whole
export function captionsFor(answer: string, alignment: Alignment | null): Caption[];
export function spokenText(question: string): string;           // `${question}\n\n(${SPOKEN_REPLY_INSTRUCTION})`
/** Never throws. audio is null without both env values, on any failure, or on timeout. */
export async function speak(answer: string, deps: { env: Record<string, string | undefined>; fetchFn?: typeof fetch; timeoutMs?: number }): Promise<{ audio: string | null; captions: Caption[] }>;
```
`SPOKEN_REPLY_INSTRUCTION` exact text:
> Spoken reply: this answer is read aloud and shown as captions. Answer in at most 70 words, in two to four short spoken sentences. No lists, headings, markdown or brackets. Say names in full and dates the way they are spoken. When there are more than three items, give the three that matter most and say how many more there are. If you propose a change, say that a card is waiting to be confirmed, and never say the change is done.

`speak` calls `POST https://api.elevenlabs.io/v1/text-to-speech/${MONSOON_VOICE_ID}/with-timestamps` with header `xi-api-key`, body `{ text, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.8, similarity_boost: 0.75 } }`, aborted after `timeoutMs` (default `SPEECH_TIMEOUT_MS`). On failure it logs `console.error("monsoon: speech failed", <error name or HTTP status>)` and nothing else. Without alignment, captions spread over `total = characters / 15` seconds in proportion to sentence length.

- [ ] **Step 1: Failing tests** (port the cases from the reference `speech.test.ts`, minus pronunciations and tickers), plus: `captionsFor("", null)` is `[]`; a single sentence with no full stop yields one caption starting at 0; with a fake alignment the i-th caption ends at the end time of the i-th sentence's last character and each starts where the previous ended; `speak` with no key makes no fetch and returns `audio: null` with length-timed captions; `speak` with a fetch that rejects, returns HTTP 500, or never resolves within `timeoutMs: 20` returns `audio: null` and does not throw; the request body sent contains only `text`, `model_id` and `voice_settings`; `spokenText("Who is next?")` ends with the instruction in brackets.
- [ ] **Step 2: Run** `npx vitest run src/lib/monsoon/ask/speech.test.ts --maxWorkers=3 --minWorkers=1` — expect fail (module missing).
- [ ] **Step 3: Implement** `speech.ts`.
- [ ] **Step 4: Run** — expect pass.
- [ ] **Step 5: Commit.**

### Task 3: Spoken answers in the loop and the Ask route

**Files:**
- Modify: `src/lib/monsoon/ask/loop.ts` (`runAsk` deps, `DEADLINE_MS` use)
- Modify: `src/app/api/monsoon/ask/route.ts`
- Test: `src/lib/monsoon/ask/loop.test.ts`, `src/app/api/monsoon/ask/route.test.ts`

**Interfaces:**
- Consumes: Task 1 `account.countInLastDay`, `account.record("speak")`; Task 2 `speak`, `spokenText`, `cleanForSpeech`, `SPEECH_TIMEOUT_MS`, `Caption`.
- Produces: `runAsk` deps gain `spoken?: boolean`. With it, the last user message in the model's conversation is `spokenText(content)`, the loop's deadline is `DEADLINE_MS - SPEECH_TIMEOUT_MS`, and the returned `answer` is `cleanForSpeech(answer)`. Request body gains `spoken?: boolean`, `sound?: boolean` (anything but literal `true` / `false` is ignored). Response for a spoken request: `AskResult & { audio: string | null; captions: Caption[] }`; for any other request the body is unchanged. `export const SPOKEN_DAILY_LIMIT = 150` in `route.ts`.

Route order for a spoken request, after `runAsk` returns: if `sound !== false` and `await account.countInLastDay("speak") < SPOKEN_DAILY_LIMIT`, call `speak(result.answer, { env: process.env })` and, when `audio` is not null, `await account.record("speak", estate.key)`; otherwise captions come from `captionsFor(result.answer, null)`. A throw from the count is treated as over the cap (captions only). `beginAi("ask")` and `record("ask")` are unchanged.

- [ ] **Step 1: Failing tests.** Loop: with `spoken`, the fake client's last user message ends with the instruction and earlier messages are untouched; the returned answer has markdown stripped; without `spoken` the request is byte-for-byte as before; with `spoken` and a clock at `DEADLINE_MS - SPEECH_TIMEOUT_MS` the loop returns the existing "too big" result. Route (ElevenLabs faked through a mocked `speak`): `spoken: true` returns `audio` and `captions` and records `speak`; `sound: false` never calls `speak` and returns length-timed captions; a count of 150 never calls `speak`; `speak` returning `audio: null` records no `speak` row and still returns 200 with the answer; a non-spoken request has no `audio` or `captions` key; `spoken: "yes"` is treated as absent.
- [ ] **Step 2: Run** `npx vitest run src/lib/monsoon/ask/loop.test.ts src/app/api/monsoon/ask/route.test.ts --maxWorkers=3 --minWorkers=1` — expect the new cases to fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — expect pass; also `src/lib/monsoon/ask/loop.db.test.ts`.
- [ ] **Step 5: Commit.**

### Task 4: Feedback route, client API and the review command

**Files:**
- Create: `src/app/api/monsoon/ask/feedback/route.ts`, `src/app/api/monsoon/ask/feedback/route.test.ts`
- Modify: `src/components/monsoon/api.ts`
- Modify: `scripts/monsoon/admin-commands.ts`; Test: `scripts/monsoon/admin.db.test.ts`

**Interfaces:**
- Consumes: Task 1 `account.feedback`, `FEEDBACK_KINDS`, `ask_feedback`, `activity`.
- Produces:
```ts
// api.ts
export type AskReply = AskResult & { audio?: string | null; captions?: Caption[] };
export async function askCrm(body: { estate: string; today: string; messages: AskMessage[]; viewing?: ...; spoken?: boolean; sound?: boolean }): Promise<ApiResult<AskReply | { error: string }>>;
/** Fire and forget, keepalive; never throws, never awaited by callers. */
export function sendAskFeedback(body: { estate: string; kind: FeedbackKind; mode: "voice" | "typed"; detail?: string }): void;
```
Route `POST /api/monsoon/ask/feedback`: `requireAccount`; body at most 2,048 bytes; `estate` must be one of the account's pipelines (400 otherwise); `kind` in `FEEDBACK_KINDS` and `mode` in `voice|typed` (400 otherwise); `detail` kept only for `no_speech`, `mic_blocked`, `unsupported`, cut to 200 characters, else stored null; always answers `204` when valid, whether or not the daily limit dropped the row.

Admin command `ask-review` (no arguments): for each customer with any row in the window, two lines (last 7 days, last 30 days) of: questions (`activity.action = 'ask'`), spoken (`'speak'`), `up`, `down`, and each failure kind count; then, per failure kind, the three most common `detail` prefixes (text before the first `;`, at most 40 characters). Read-only.

- [ ] **Step 1: Failing tests.** Route: 401 signed out; 400 for unknown estate, kind, mode; `detail` on `kind: "up"` is stored null; a 500-character detail on `no_speech` is stored at 200; valid request answers 204 and calls `account.feedback` with the session's ids, not any from the body. Admin: seeded rows produce the expected counts for 7 and 30 days and a row 31 days old is counted in neither.
- [ ] **Step 2: Run** `npx vitest run src/app/api/monsoon/ask/feedback scripts/monsoon/admin.db.test.ts --maxWorkers=3 --minWorkers=1` — expect fail.
- [ ] **Step 3: Implement** the route, the two `api.ts` changes and the command (add it to the command's usage text).
- [ ] **Step 4: Run** — expect pass; `npx vitest run src/lib/monsoon/no-delete.test.ts` passes.
- [ ] **Step 5: Commit.**

### Task 5: `AskWindow` component

**Files:**
- Create: `src/components/monsoon/AskWindow.tsx`, `src/components/monsoon/AskWindow.test.tsx`
- (`AskSheet.tsx` stays until Task 7 removes it.)

**Interfaces — Produces:**
```tsx
export default function AskWindow(props: {
  busy: boolean;
  collapsed: boolean;
  onCollapsed(next: boolean): void;
  onClose(): void;
  /** "Looking at …" line; null hides it. */
  looking: string | null;
  /** True when the conversation has at least one turn (picks the minimised hint). */
  hasConversation: boolean;
  /** Sound toggle; null hides the button (computers). */
  sound: { on: boolean; onToggle(): void } | null;
  children: ReactNode;
}): JSX.Element;
```
Behaviour: `role="dialog"`, `aria-label="Ask"`, no `aria-modal`, no backdrop, no `inert`, no body scroll lock, no focus trap. Wrapper `pointer-events-none fixed inset-x-0 z-20 flex justify-center px-3`; panel `pointer-events-auto w-full max-w-md rounded-2xl` with the sheet's colours, a 1px ring, a shadow and the existing `ask-sheet-up` animation. Expanded: `bottom-0` with safe-area padding, height `min(62dvh, 580px)`, children in a scrolling column. Collapsed: only the header, positioned `bottom-[calc(5.5rem+env(safe-area-inset-bottom))]` (above the pill row). Header: a button spanning title and hint that toggles collapse (`aria-expanded`); title "Ask"; second line is `looking` when expanded, and when collapsed "Tap to return to your conversation" or "Tap to ask a question"; then the sound button (`aria-label` "Turn spoken answers off" / "Turn spoken answers on", `aria-pressed`), a minimise/expand button ("Minimise Ask and keep reading" / "Expand Ask") and "Close" (`disabled` while `busy`). All header controls at least 44px. Escape (not during IME composition) calls `onClose` only when not `busy`.

- [ ] **Step 1: Failing tests:** no element has `aria-modal`; `document.body.style.overflow` is unchanged after mount; a sibling of the window is not `inert`; no backdrop test id; header toggles `onCollapsed`; collapsed renders no children and shows the right hint for `hasConversation` true and false; Close disabled when busy; Escape closes when idle and not when busy; `sound: null` renders no sound button; the sound button reflects `on`.
- [ ] **Step 2: Run** `npx vitest run src/components/monsoon/AskWindow.test.tsx --maxWorkers=3 --minWorkers=1` — expect fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — expect pass.
- [ ] **Step 5: Commit.**

### Task 6: `useAsk` — the request logic leaves `AskPanel`

**Files:**
- Create: `src/components/monsoon/useAsk.ts`, `src/components/monsoon/useAsk.test.tsx`
- Modify: `src/components/monsoon/AskPanel.tsx`, `src/components/monsoon/AskPanel.test.tsx`, `src/components/monsoon/AskPanel.guard.test.tsx`
- Modify: `src/components/monsoon/MonsoonApp.tsx` (call the hook, pass its result down; no layout change yet)

**Interfaces:**
- Consumes: Task 4 `askCrm` (`spoken`, `sound`), `AskReply`.
- Produces:
```ts
// AskTurn gains: rating?: "up" | "down"; spoken?: boolean
export type AskOutcome =
  | { ok: true; turn: AskTurn; audio: string | null; captions: Caption[] }
  | { ok: false; reason: "busy" | "empty" | "unauthorized" | "failed" | "stale" };
export function useAsk(args: {
  estate: EstateInfo | null;
  state: AskState;
  onChange(next: AskState | ((prev: AskState) => AskState)): void;
  viewing: AskViewing | null;
  onUnauthorized(): void;
}): {
  asking: boolean;
  failure: string | null;
  clearFailure(): void;
  /** Drops any answer still on its way (estate change, Clear). */
  generation(): number;
  /** text undefined sends the draft and empties it; a given text leaves the draft alone. */
  send(text?: string, opts?: { spoken?: boolean; sound?: boolean }): Promise<AskOutcome>;
};
```
`send` is today's `AskPanel.send` moved as it is (the `askRef` guard, the generation check, `toMessages`, `restore` putting a failed question back into the draft, `claudeFailureText`), returning an outcome instead of nothing. A stale answer (generation changed) adds no turn and returns `{ ok: false, reason: "stale" }`. `AskPanel` now receives `ask: ReturnType<typeof useAsk>` and keeps cards, chips, research offer, Clear, dictation and the composer; `busy` stays `ask.asking || working` and is still reported through `onBusy`. The `send` prop for Prepare me stays on `AskPanel` and calls `ask.send(text)`.

- [ ] **Step 1: Failing tests** in `useAsk.test.tsx` (mock `askCrm`): a successful send appends the user and assistant turns and returns `ok` with the turn; `opts.spoken` reaches `askCrm` and the assistant turn has `spoken: true`; `audio` and `captions` from the reply are returned; a second `send` while the first is in flight returns `{ ok: false, reason: "busy" }` and `askCrm` was called once; a 401 restores the question to the draft, calls `onUnauthorized` and returns `unauthorized`; a 502 restores the draft, sets `failure` and returns `failed`; **(Review Focus 2)** when `state.turns` is cleared, or `estate.key` changes, while a request is in flight, the late reply adds no turn and returns `stale`.
- [ ] **Step 2: Run** `npx vitest run src/components/monsoon/useAsk.test.tsx --maxWorkers=3 --minWorkers=1` — expect fail.
- [ ] **Step 3: Implement** the hook; change `AskPanel` to use it; update the two existing `AskPanel` test files to supply the hook (a small test wrapper component that calls `useAsk` keeps their assertions unchanged).
- [ ] **Step 4: Run** `npx vitest run src/components/monsoon/useAsk.test.tsx src/components/monsoon/AskPanel.test.tsx src/components/monsoon/AskPanel.guard.test.tsx src/components/monsoon/MonsoonApp --maxWorkers=3 --minWorkers=1` — expect pass with no behaviour change.
- [ ] **Step 5: Commit.**

### Task 7: The window replaces the sheet in `MonsoonApp`

**Files:**
- Modify: `src/components/monsoon/MonsoonApp.tsx`, `src/components/monsoon/UndoBar.tsx`, and the `MonsoonApp*.test.tsx` files that open Ask
- Delete: `src/components/monsoon/AskSheet.tsx`, `src/components/monsoon/AskSheet.test.tsx`

**Interfaces:**
- Consumes: Task 5 `AskWindow`; Task 6 `useAsk`.
- Produces: state `askCollapsed: boolean` beside `askOpen`; `type AskFootprint = "pill" | "bar" | "window"` (closed, minimised, expanded) and `UndoBar` prop `above: AskFootprint` choosing its `bottom` offset: pill `6rem`, bar `10rem`, window `calc(min(62dvh, 580px) + 1.5rem)`, each plus the safe-area inset. `openAsk(opts?: { focus?: boolean })` and `minimiseAsk()` helpers used by later tasks.

Rules to implement (spec section 1):
1. The pill row renders when Ask is closed or minimised, not when expanded. Close returns focus to the pill.
2. `openContact` and `openAndResearch` minimise an expanded window instead of calling `closeAsk()`. All five `openContact` callers get this.
3. The effect that clears `contacts.autoResearch` runs when `mode !== "contacts"` or the window is open **and expanded**.
4. `prepared` is dropped when the profile on screen changes to a different target, and on close. The window's `looking` is `prepared ?? viewing`.
5. A confirmed change bumps `profileReload` and reloads the To do list at once (`onChanged`), not on close.
6. `prepare(todo)` works when the window is open and idle; it expands a minimised window. It is still ignored while `askBusy` or `askBlocked`.
7. One write at a time: `AskPanel` gets `blocked={askBlocked}` which disables its send button, suggestion buttons and every card's Confirm; the pill is disabled while `askBlocked`. Find every control that starts a write or a model call (save, batch save, tidy, profile actions, to-do add/tick/drop/move, research, estate switch) and make sure each is disabled while `askBusy`; list the ones changed in the task report.
8. On a touch device (`(pointer: coarse)`) opening does not focus the question box unless `openAsk({ focus: true })` (used by `askAbout`).

- [ ] **Step 1: Failing tests** (in the existing MonsoonApp test files or a new `MonsoonApp.askwindow.test.tsx`): with Ask open, a page button behind is clickable and not inert; tapping a contact chip opens the profile and the window is minimised with the conversation kept; a To do row opened while Ask is expanded minimises it; Run research minimises and research still starts; after Prepare me, opening another profile makes "Looking at" name that profile; confirming a card reloads the profile without closing; while `askBlocked` the card's Confirm and the send button are disabled; while Ask is asking, the to-do tick control is disabled; `UndoBar` gets `above="window"` when expanded, `"bar"` when minimised, `"pill"` when closed; Prepare me from the To do tab while the window is minimised expands it and sends once.
- [ ] **Step 2: Run** `npx vitest run src/components/monsoon/MonsoonApp --maxWorkers=3 --minWorkers=1` — expect the new cases to fail.
- [ ] **Step 3: Implement**; delete `AskSheet` and its test; update tests that asserted the modal behaviour (backdrop, inert, scroll lock) to the new behaviour.
- [ ] **Step 4: Run** `npx vitest run src/components/monsoon --maxWorkers=3 --minWorkers=1` — expect pass.
- [ ] **Step 5: Commit.**

### Task 8: Ratings and one-tap suggestions in the window

**Files:**
- Modify: `src/components/monsoon/AskPanel.tsx`, `src/components/monsoon/AskPanel.test.tsx`

**Interfaces:**
- Consumes: Task 4 `sendAskFeedback`; Task 6 `AskTurn.rating`, `AskTurn.spoken`.
- Produces: `export function RateButtons(props: { rating: "up" | "down" | null; onRate(r: "up" | "down"): void; size?: "sm" | "md" }): JSX.Element` (exported from `AskPanel.tsx` for the voice pill in Task 10).

Behaviour: under each assistant answer, thumbs up and down (`aria-label` "Good answer" / "Poor answer", `aria-pressed`). A tap sets `turn.rating` and calls `sendAskFeedback({ estate, kind, mode: turn.spoken ? "voice" : "typed" })`; tapping the other thumb changes it and sends again; tapping the pressed one does nothing. Suggestions: a tap sends the question at once through `ask.send(text)`; the one ending in a space ("Tell me about ") still fills the box and focuses it.

- [ ] **Step 1: Failing tests:** thumbs render under assistant answers only (not notes, not user turns); a tap sends feedback with the right `kind` and `mode` and marks it pressed; a suggestion tap calls `askCrm` with that text without touching the draft; "Tell me about " fills the draft and sends nothing.
- [ ] **Step 2: Run** `npx vitest run src/components/monsoon/AskPanel.test.tsx --maxWorkers=3 --minWorkers=1` — expect fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — expect pass.
- [ ] **Step 5: Commit.**

### Task 9: `useVoiceAsk` — listening, thinking, speaking

**Files:**
- Create: `src/components/monsoon/useVoiceAsk.ts`, `src/components/monsoon/useVoiceAsk.test.tsx`
- Create: `src/components/monsoon/askDevice.ts` (+ test in the same test file or `askDevice.test.ts`)

**Interfaces:**
- Consumes: Task 6 `AskOutcome`, `Caption`.
- Produces:
```ts
// askDevice.ts
/** null until mounted; true unless matchMedia("(hover: hover) and (pointer: fine)") matches. */
export function useIsPhone(): boolean | null;
export function isAppleTouch(): boolean;
/** Stored at localStorage "monsoon.ask.sound": absent or "on" is on, "off" is off. Storage errors mean on. */
export function useAskSound(): [boolean, (on: boolean) => void];

// useVoiceAsk.ts
export type VoicePhase = "idle" | "listening" | "thinking" | "speaking";
export type VoiceNotice = "not_heard" | "mic_blocked" | null;
export function useVoiceAsk(args: {
  /** Sends the question; the hook passes { spoken: true, sound }. */
  send(text: string, opts: { spoken: true; sound: boolean }): Promise<AskOutcome>;
  sound: boolean;
  disabled: boolean;
  onEvent(kind: "no_speech" | "mic_blocked" | "unsupported" | "replay" | "stopped", detail?: string): void;
  /** The answer arrived (called before audio starts). */
  onAnswer(turn: AskTurn): void;
  /** No recognition here, mic blocked, or the send failed: the caller opens the window. */
  onNeedsWindow(reason: "unsupported" | "mic_blocked" | "failed" | "unauthorized"): void;
}): {
  phase: VoicePhase;
  heard: string;          // live transcript, then the question while thinking
  caption: string;        // current sentence, "" when none
  notice: VoiceNotice;
  secondsLeft: number;    // 20 counting down while listening
  canReplay: boolean;     // true for 12 s after an answer ends
  lastTurn: AskTurn | null; // the turn canReplay refers to
  onPill(): void;         // idle: listen; listening: stop and ask; speaking: stop
  replay(): void;
};
```
Port from the reference `VoiceAsk.tsx`: audio context created and unlocked inside the pill tap; recognition `continuous = !isAppleTouch()`, `interimResults = true`, `lang = navigator.language || "en-US"`; pause timer 1.5 s after any heard text; 7 s with nothing heard; 20 s cap; captions follow `AudioContext.currentTime`; with no audio (null, sound off, decode failure) captions run on a 150 ms timer from their own times. Constants exported: `MAX_LISTEN_SECONDS = 20`, `PAUSE_MS = 1500`, `NO_SPEECH_MS = 7000`, `REPLAY_WINDOW_MS = 12_000`, `CAPTION_LINGER_MS = 1500`. `detail` for events is `` `${errorCode}; ${navigator.userAgent}` `` cut to 200 characters. Not ported: mouse press-and-hold, typing mode, upgrade notice, pronunciations. Everything is torn down on unmount.

- [ ] **Step 1: Failing tests** with a fake `SpeechRecognition`, a fake `AudioContext` and fake timers: tap → listening, a result then 1.5 s of silence → `send` called once with the transcript and `{ spoken: true, sound: true }`; 7 s of nothing → idle, notice `not_heard`, event `no_speech`; 20 s cap stops listening; `not-allowed` error → `onNeedsWindow("mic_blocked")`, event `mic_blocked`; no recognition class → `onNeedsWindow("unsupported")`, event `unsupported`, no listening; a successful outcome → `onAnswer`, phase speaking, first caption shown, and after the audio ends phase idle, `canReplay` true for 12 s then false, caption cleared after 1.5 s; `replay` plays again and sends event `replay`; pill during speaking → idle and event `stopped`; outcome `failed` → `onNeedsWindow("failed")` and phase idle; `sound: false` → no audio decode, captions on timer; on Apple touch `continuous` is false. **Review Focus 1:** `onPill` twice in the same tick when idle starts one recognition; `onPill` during thinking does nothing and `send` was called once. **Review Focus 3:** `decodeAudioData` rejecting → captions run on the timer and the phase reaches idle. **Review Focus 4:** a `visibilitychange` to hidden while listening aborts recognition without sending; while speaking stops audio; both end idle. **Review Focus 5:** an outcome with `captions: []` goes straight to idle with `canReplay` false; a single 600-character caption is shown whole (the strip scrolls; assert the hook does not truncate).
- [ ] **Step 2: Run** `npx vitest run src/components/monsoon/useVoiceAsk.test.tsx --maxWorkers=3 --minWorkers=1` — expect fail.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** — expect pass.
- [ ] **Step 5: Commit.**

### Task 10: The voice pill, the caption strip and their wiring

**Files:**
- Create: `src/components/monsoon/VoicePill.tsx`, `src/components/monsoon/VoicePill.test.tsx`
- Modify: `src/components/monsoon/MonsoonApp.tsx`, a `MonsoonApp` test file for voice

**Interfaces:**
- Consumes: Task 9 `useVoiceAsk`, `useIsPhone`, `useAskSound`; Task 8 `RateButtons`; Task 7 `openAsk`, `minimiseAsk`, `AskFootprint`; Task 5 `AskWindow` `sound` prop; Task 4 `sendAskFeedback`.
- Produces:
```tsx
export default function VoicePill(props: {
  voice: ReturnType<typeof useVoiceAsk>;
  disabled: boolean;
  buttonRef: Ref<HTMLButtonElement>;
  onKeyboard(): void;                         // opens the window with the box focused
  onRate(r: "up" | "down"): void;
  rating: "up" | "down" | null;
  chips: { key: string; name: string; onOpen(): void }[];  // at most 3
}): JSX.Element;
```
Layout (spec section 2): the pill row at the bottom centre exactly where the Ask button is now; the pill keeps the Ask button's size and colours when idle with a microphone icon and the label "Ask"; listening is red with a pulsing dot and "Tap when done"; thinking shows the `MonsoonLoader` and "Thinking" and is disabled; speaking shows a stop square and "Stop". Left of the pill when idle: a round 48px keyboard button, `aria-label="Type a question instead"`. Right of the pill while `canReplay`: `RateButtons` (size `sm`) and a round replay button, `aria-label="Replay the answer"`. The caption strip: `role="status" aria-live="polite"`, fixed just above the pill row, `max-w-md`, `bg-black/75 text-white backdrop-blur-sm rounded-2xl`, `max-h-[7.5rem] overflow-y-auto`; shows "Listening · {n}s" and `heard` (placeholder "Ask about your CRM…"), or "You asked" and `heard`, or `caption`, or the notice text ("I did not catch that. Tap and try again."); under it, while `canReplay`, the chips row.

Wiring in `MonsoonApp`:
- `useIsPhone() === true` and the estate present: render `VoicePill` in place of the Ask button whenever the window is not expanded. `null`: render nothing voice-specific (the plain Ask button, as today, until mounted). `false`: the plain Ask button opens the window with the box focused.
- `voice.send` is `ask.send`; `sound` from `useAskSound()`, also passed to `AskWindow`'s `sound` prop on phones (null on computers).
- `onAnswer(turn)`: if the turn has cards or a research offer, expand the window (it scrolls to the end as `AskPanel` already does). Chips for the strip come from the turn's refs, first three distinct.
- `onNeedsWindow`: `failed` and `unauthorized` open the window (the draft already holds the question; `unauthorized` has already gone to the passcode screen); `unsupported` opens the window focused and shows the existing keyboard-microphone hint; `mic_blocked` opens the window focused.
- `onEvent` → `sendAskFeedback({ estate, kind, mode: "voice", detail })`. The keyboard button sends `typed_instead`.
- The pill's thumbs set `rating` on `voice.lastTurn` in the conversation (so the window shows the same rating) and send feedback with `mode: "voice"`.
- Pill `disabled` while `askBlocked` or the window's `AskPanel` is busy.

- [ ] **Step 1: Failing tests.** `VoicePill`: the label and `aria-label` for each phase; keyboard button only when idle; replay and thumbs only while `canReplay`; at most three chips; the strip is a polite live region. `MonsoonApp` (mock `useIsPhone` true, mock `askCrm`, fake recognition): a spoken question appears in the window's conversation afterwards as an ordinary turn; a reply with a proposal expands the window and the card is visible and unconfirmed; a reply with only refs does not open the window and shows chips; a failed reply opens the window with the question in the box and the failure text; the keyboard button opens the window with the box focused and sends `typed_instead`; with the window minimised the pill is rendered and with it expanded it is not; sound off sends `sound: false`; on a computer (`useIsPhone` false) no `VoicePill` renders and Ask opens the window.
- [ ] **Step 2: Run** `npx vitest run src/components/monsoon/VoicePill.test.tsx src/components/monsoon/MonsoonApp --maxWorkers=3 --minWorkers=1` — expect fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/components/monsoon --maxWorkers=3 --minWorkers=1` — expect pass.
- [ ] **Step 5: Commit.**

### Task 11: Final checks, voice samples and the rollout runbook

**Files:**
- Create: `scripts/monsoon/voice-samples.mjs`
- Modify: this plan (tick the runbook as it is done)

- [ ] **Step 1:** `npx tsc --noEmit` clean; `npx vitest run --maxWorkers=2 --minWorkers=1` (whole suite, two workers); `npx next build` succeeds. Record the numbers. The known flaky `BatchReview.test.tsx` case may fail in the full run and must pass alone.
- [ ] **Step 2:** `voice-samples.mjs`: reads `ELEVENLABS_API_KEY` from the environment, takes voice ids as arguments and writes one mp3 per voice to an output folder given as the first argument, each saying the fixed line "You have three things due today. The first is a call with Anna Lee at Northwind about the renewal. Two more are in your list." No key in the file; exits with a clear message when the key is missing.
- [ ] **Step 3: Rollout runbook (the controller does these with Vincent, not a subagent):**
  1. Generate three stock-voice samples; Vincent picks one.
  2. Apply accounts schema version 8 with the existing `migrate` admin command; confirm version 8.
  3. Vincent adds `ELEVENLABS_API_KEY` and `MONSOON_VOICE_ID` to the Monsoon project on Vercel.
  4. Give Vincent the privacy line: "Spoken answers are produced by a speech provider, which receives the text of the answer."
  5. Rebase on `origin/main` if it moved, re-run Step 1, push to `main`, confirm the deployed build, check `/monsoon` loads signed out and `/api/monsoon/ask/feedback` answers 401 signed out.
  6. Vincent's phone checks from the spec's Testing section (iPhone Safari and Android Chrome).
  7. Run `ask-review` after a day of use.
- [ ] **Step 4: Commit.**
