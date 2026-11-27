# Monsoon Ask: floating window and voice

Date: 2026-11-27. Status: awaiting approval.

## Intent

Monsoon's Ask opens as a sheet that covers 85% of the screen, dims and locks the page behind it,
and is typing-first. The Ask on the Zero One site ("Ask the Blade", in the `01website` repo,
branch `ask/engine`) has moved on: its chat floats over the page without blocking it, minimises to
a bar, and on phones is voice-first (tap, speak, hear the answer, read captions).

This change brings those lessons to Monsoon so that a salesperson can ask while still seeing the
contact or the to-do list, and can ask by voice with one tap, for example walking into a meeting.

## Goals

1. Ask no longer hides or locks what the user was looking at.
2. On a phone, speaking is the default way to ask, and the answer is spoken and captioned.
3. Anything Ask proposes still needs a confirmed, signed card. Voice never changes the CRM.
4. Vincent can see where Ask fails (ratings and failed voice attempts), without Monsoon storing
   what was asked or answered.

## Non-goals

- No hands-free back-and-forth conversation, no wake word.
- No confirming a change by voice.
- No streaming of answers. The answer still arrives whole.
- No spoken answers on a computer with a mouse.
- No audio ever reaches Monsoon's server. The phone's browser turns speech into text, as today.
- No change to the model, the tools, the proposal signing or the note dictation on profiles.
- No per-customer choice of voice.

## Anti-goals (a failure even if it works)

- A spoken answer that says a change is done when a card is still waiting.
- The keyboard popping up over the page when Ask opens on a phone.
- A question, an answer, a contact name or a note in any log or review table.
- Ask being open leaving the page in a state where two writes can run at once.

## Constraints

- Standing Monsoon rules hold: the app never deletes; history only grows; Ask's changes need a
  confirmed signed card; Monsoon never sends email; no new model ids.
- The repo is public: no secrets, no client names in code, tests or commits.
- The Ask route has 60 seconds and the loop a 50-second deadline (`src/lib/monsoon/ask/loop.ts`).
- Phone browsers only start speech recognition from a finished tap, and only play audio later if
  the audio context was unlocked inside that tap. The Blade code already solves both.
- iPhone Safari stops hearing in continuous recognition mode; it must use the non-continuous mode.
- This PC runs out of memory with parallel test runs: vitest with `--maxWorkers=3 --minWorkers=1`,
  one implementer at a time.

## Approaches

**How voice and the window fit together**

- A. One Ask, two faces (chosen by Vincent). The Ask button is the talk pill on phones; the same
  conversation also lives in the floating window; the window opens by itself when an answer
  carries a card. One history.
- B. Two separate modes, as on the Blade. Simpler, but a spoken request that produces a change
  card would have nowhere to show it without switching mode and history.

**How the spoken answer is made**

- A. One request, written for the ear (chosen by Vincent). A voice question tells Ask to answer in
  short spoken sentences; the server returns text, audio and caption timings together.
- B. Speak the normal written answer. No change to Ask, but written answers are long and
  list-shaped and sound bad aloud.

**The voice** (chosen by Vincent): a stock ElevenLabs voice for Monsoon, not Vincent's cloned
voice (that belongs to Zero One) and not the phone's built-in voice (robotic, no caption timing).

## Design

### 1. The floating window (replaces `AskSheet`)

A new `AskWindow` replaces the modal sheet.

- Fixed at the bottom centre, `max-w-md` less a side margin, height `min(62dvh, 580px)`.
  Rounded, shadowed, a 1px ring. No backdrop.
- Expanded, it sits at the very bottom in place of the pill row, which is not rendered (phone and
  computer alike). Minimised, its bar sits just above the pill row, which is rendered and usable.
  Closed, only the pill row shows.
- Not modal: no `aria-modal`, no `inert` on the page, no scroll lock, no focus trap. The page
  behind scrolls and takes taps.
- Header: "Ask", the "Looking at <name> · <company>" line when there is one, a minimise button
  and Close. Tapping the header toggles minimise.
- Minimised: only the header bar shows, with "Tap to return to your conversation" or "Tap to ask
  a question". The conversation and the draft are kept.
- Escape closes it when nothing is in flight. Close is disabled while an answer or a change is in
  flight, as today.
- On a touch screen, opening does not focus the question box. Two exceptions, both explicit
  requests to type: the keyboard button (section 2) and "Ask about this contact" (`focusAsk`).
  On a computer, opening focuses the box as today.
- Closing hands focus back to the Ask button, as today.

`AskPanel` keeps the conversation, the cards, the research offer, Clear and the composer. Its
sticky composer becomes the window's footer.

**What changes because the page is now live while Ask is open** (in `MonsoonApp.tsx`):

- Anything that opens a profile (`openContact`: a contact chip, a To do row, the batch review,
  the match line, the save line) opens it behind and minimises an expanded window. It no longer
  closes Ask.
- "Run research" on an offer opens the profile, starts research and minimises the window. The
  rule that withdraws a pending research request when Ask is over the profile now applies only
  while the window is expanded, so minimising for research does not cancel it.
- "Looking at" follows the profile on screen as the user moves between contacts. A Prepare me
  contact stands in only until the user opens a different profile or closes the window; after
  that "Looking at" is the profile on screen, so "this person" never means someone off screen.
- A change confirmed in Ask refreshes what is underneath at once (the open profile and the To do
  list), not on close.
- One write at a time. While the page is busy (`askBlocked`: reading, saving, tidying, a batch
  run, a profile action) the pill, the composer's send and every card's Confirm are disabled.
  While Ask is busy (`askBusy`) the page controls that already check `askBusy` stay disabled; the
  builder audits every control that previously relied on the page being unreachable under the
  sheet (save, batch save, profile actions, to-do actions, estate switch) and makes
  each check `askBusy`.
- Prepare me works while the window is open and idle (today it is ignored when Ask is open).
- Switching estate still clears the conversation.
- The Undo bar (today fixed at `bottom: 6rem`) must not overlap Ask: it sits above whatever Ask
  shows at the bottom, be it the pill row, the minimised bar or the expanded window.

### 2. Voice on phones

Phone or tablet is decided as on the Blade: not `(hover: hover) and (pointer: fine)`. It is
unknown until mounted, so nothing voice-specific renders on the server.

**The pill row** (bottom centre, where the Ask button is today):

- Idle: the pill reads "Ask" with a microphone icon. To its left, a round keyboard button. To its
  right, after an answer, a replay button and thumbs up/down for 12 seconds.
- Tap the pill: listening. The pill turns red and reads "Tap when done".
- A caption strip floats just above the pill row: translucent dark, `max-w-md`, never taller than
  about five lines.
  - Listening: "Listening · 20s" counting down, and the words heard so far.
  - Thinking: "You asked" and the question; the pill shows a spinner and "Thinking".
  - Speaking: the answer one sentence at a time, in step with the audio; the pill reads "Stop".
  - After: the last sentence stays 1.5 seconds, then the strip goes.
- Listening ends on a 1.5-second pause after speech, on a second tap, after 20 seconds, or after
  7 seconds with no speech ("I did not catch that. Tap and try again.").
- Recognition uses the phone's language (`navigator.language`), as `useDictation` does today.
  Continuous mode everywhere except iPhone and iPad.
- The keyboard button opens the window with the question box focused.
- Contact chips for a spoken answer (at most three) show as a row under the caption strip and stay
  for the 12-second replay window. Tapping one opens the profile.
- When a spoken answer carries a change card or a research offer, the window opens expanded with
  the conversation scrolled to it, as soon as the answer arrives. The audio still plays.
- While the window is expanded the pill row is covered by it. In the window, the microphone
  dictates into the question box as today, and answers are written, not spoken. The rule for the
  user: speak to the pill, hear the answer; type in the window, read the answer.
- While the window is minimised, the pill row stays usable and the bar sits above it.
- A voice question that fails (no answer, the Claude key or trial refused, too big) opens the
  window with the question in the box and the usual failure message, exactly as a typed question
  that failed. A 401 goes to the passcode screen with the question kept in the box.
- No speech recognition in this browser: the pill opens the window instead, with the existing
  keyboard-microphone hint. Microphone blocked: a notice in the strip, and the window opens for
  typing.
- Sound off: a speaker button in the window header turns spoken audio off or on, remembered on
  the phone (`localStorage`). With sound off the phone still listens and shows captions on their
  own timing, and the request tells the server not to make audio.

**One history.** A voice question and its answer are appended to the same `AskState.turns` as
typed ones, with refs, cards and research offer intact. The spoken-reply instruction is added on
the server and never appears in the conversation.

A computer with a mouse keeps today's behaviour in the new window: the pill opens it, typing
first, the microphone dictates into the box.

### 3. Server: the spoken answer

`POST /api/monsoon/ask` accepts two new optional fields: `spoken: true` and `sound: false`.

- With `spoken`, the route appends a fixed instruction to the last user message as sent to the
  model. Wording to the effect of: this reply is read aloud and shown as captions; at most 70
  words in two to four short sentences; no lists, headings, markdown or brackets; say names in
  full and dates the way they are spoken; when there are more than three items, give the three
  that matter most and say how many more there are; if you propose a change, say a card is
  waiting to be confirmed and never say it is done.
- The answer text is cleaned for speech (markdown marks and bullets removed) and that cleaned
  text is what is returned, shown and kept in the history.
- Unless `sound` is false, the route asks ElevenLabs for speech with character timings (the
  `with-timestamps` endpoint, as in the Blade's `src/lib/desk/speech.ts`) and returns `audio`
  (base64) and `captions` (`{text, start, end}` per sentence). The sentence splitting and caption
  timing functions are ported from that file with their tests. The Blade's pronunciation table and
  ticker stripping are not ported.
- Speech is best effort. No key, a failure, a timeout or the daily cap: `audio` is null and
  captions are timed by sentence length. The answer is never lost because speech failed.
- Time: speech gets an 8-second timeout. For a spoken request the loop's deadline is shortened by
  the same amount so the route stays inside 60 seconds.
- Configuration: `ELEVENLABS_API_KEY` and `MONSOON_VOICE_ID` in the Vercel project. Quantcloud's
  key serves every customer, including those on their own Claude key.
- Cap: at most 150 spoken answers per person per day, counted from a new `speak` activity row (`speak` is added to
  every `activity_action_check` list in `schema.sql`, as its comment requires).
  Over the cap the answer comes back with captions only and no message.
- Only the answer text goes to ElevenLabs. No customer or person identifier goes with it, and
  nothing about the exchange is logged beyond the `speak` activity row.
- Use of the AI allowance is unchanged: one `ask` use per question.

### 4. Ratings and the failure log

- Thumbs up/down appear on each answer in the window, and beside the pill after a spoken answer.
- A new accounts table `ask_feedback` (accounts schema version 8): `id`, `customer_id`,
  `person_id`, `pipeline_key`, `at`, `kind`, `mode` (`voice` or `typed`), `detail`.
  - `kind`: `up`, `down`, `no_speech`, `mic_blocked`, `unsupported`, `replay`, `stopped`,
    `typed_instead`. All are written by the phone. A failure to make audio on the server is not
    recorded here; the server logs its error name and status only, as the route does today.
  - `detail`: at most 200 characters, only the browser's speech error code and the browser's
    user-agent string. Never the question, the answer or anything from the CRM. The server
    accepts `detail` only for the failure kinds and drops it otherwise.
- `POST /api/monsoon/ask/feedback`, signed-in only, rate-limited per person, append-only. A
  changed mind writes a new row, and the review simply counts rows.
- Review: a new admin command, `ask-review`, in `scripts/monsoon/admin-commands.ts`, printing per
  customer for the last 7 and 30 days: questions asked (from `activity`), spoken answers, ups,
  downs, and each failure kind with the most common error codes. No web page.

### 5. Smaller changes

- Suggested questions send on one tap. "Tell me about " (unfinished) still only fills the box.
- `AskSheet.tsx` and its tests are removed once `AskWindow` replaces it.

## Decisions Vincent made

- Approach A for the layout, approach A for the spoken answer, a stock ElevenLabs voice.
- All five items in one build.

## Calls made by Claude (correct any of these)

- Voice answers come only from the pill; the window's microphone still dictates into the box.
- A card or research offer opens the window; contact chips alone do not (most answers name a
  contact, and the window would open every time).
- Ratings and failures store no question or answer text. This keeps client content out of
  Quantcloud's database, at the price that a thumbs-down shows that an answer was poor but not
  which question it was.
- 150 spoken answers per person per day.
- Review is a terminal command, not a page.
- Spoken answers on phones and tablets only.
- The privacy statement is a client-facing document outside this repo; Claude drafts one line for
  it ("spoken answers are produced by a speech provider, which receives the answer text") and
  Vincent places it.

## Left to the builder

- Component split inside `src/components/monsoon/` (for example `AskWindow.tsx`, `VoicePill.tsx`,
  `useVoiceAsk.ts`, `askSpeech.ts` on the client; `src/lib/monsoon/ask/speech.ts` on the server).
- Exact wording of the spoken-reply instruction, checked against real answers.
- The ElevenLabs model: start from the Blade's settings; a faster model is a tuning choice made
  when the voices are sampled.
- Whether `useDictation` is extended or the Blade's listening logic is ported beside it; either
  way the pause, cap and iPhone rules above hold.

## Testing

- Unit and component tests with vitest, written first: the window (not modal, minimise, focus
  rules, busy rules), the voice phases with a fake recognition and a fake audio context, the
  card-opens-the-window rule, one-tap suggestions, sound off.
- Route tests: `spoken` adds the instruction only to the model's copy; speech failure, missing
  key, timeout and the cap all return the answer with captions; `sound: false` makes no speech
  call. ElevenLabs is always a fake in tests.
- Feedback route tests: `detail` dropped for ratings, length capped, signed-in only; the
  no-delete test still passes.
- Accounts schema test for version 8.
- By hand, by Vincent, on an iPhone (Safari) and an Android phone (Chrome): ask by voice, hear
  and read the answer, replay, stop, sound off, a spoken "add a to-do for Friday" opens the card,
  minimise and scroll the page, chip opens the profile behind.

## Rollout

1. Vincent picks the voice from three samples; its id goes in `MONSOON_VOICE_ID`.
2. Accounts schema version 8 applied to the accounts database.
3. `ELEVENLABS_API_KEY` and `MONSOON_VOICE_ID` added to the Monsoon project on Vercel. Without
   them the build is safe to ship: voice works with captions only.
4. The privacy line is in place.
5. Push to `main`; phone checks.
