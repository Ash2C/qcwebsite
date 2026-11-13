# Monsoon batch capture: short design

Date: 2026-11-13. Status: approved by Vincent 2026-11-13. Extends `2026-11-13-monsoon-capture-design.md`.

## Intent

Vincent wants to photograph several business cards or badges in one frame and have each become its
own normal CRM entry, so a pile of cards after an event takes one photo, not ten.

## Goals, non-goals, anti-goals

- Goal: one photo with N cards yields N contacts, each saved by the unchanged save route with its own
  `captureId`, so every duplicate, lookalike-company and same-name check applies per card.
- Goal: a photo with one card behaves exactly as today.
- Non-goals: queueing several photos at once; a cropped picture of each card beside its row; any
  change to the save route, the capture transaction or the database.
- Anti-goals: merging two cards into one contact; saving a card Vincent never saw; a nameless card
  saved under a guessed name; one problem card blocking the rest of the batch.

## Approach

Extend the existing read route and screen (the only sensible way: the save path is already per card).
Considered and dropped: a separate "batch" page (two screens to maintain for one flow) and saving the
whole batch in one server call (would need a new route and loses the per-card prompts).

## Design

- **Reading.** The model call returns a list. Structured output schema: `{ cards: [ {name, title, org,
  email, phone, linkedin, raw_text} ] }`, one entry per separate card or badge, in reading order.
  Entries with every field empty are dropped. At most 12 cards are returned. Still Claude Haiku 5.5;
  Opus and Fable stay refused. `POST /api/monsoon/read` now answers `{ cards: CardFields[] }`.
- **Photo size.** The browser downsizes to 2400 px on the longest side (was 1600) so small text on a
  crowded photo stays legible, and steps down if the result would exceed the 3.7 MB upload limit.
- **Screen.** 0 cards: today's "nothing found" behaviour (empty form, usable by hand). 1 card: today's
  form. 2 or more: a review list.
  - Header `<n> cards found`. One Role and one Note apply to every card; each card can override both.
  - One row per card: `name · company`. Tapping a row opens the same fields as the single form.
    `Remove` drops a card. A card with no name shows `Add a name` and is held back until it has one.
  - `Save all (<n>)` saves eligible cards one after another. Each row then shows the same message the
    single form would show. A card that needs an answer (lookalike company, same name, ambiguous)
    shows its buttons on its own row; answering re-saves that card only. A failed card shows
    `Could not save. Retry.` and is retried by the next Save all.
  - When every remaining card is saved: `<k> saved to <Estate>.` and `Done` returns to the single form.
    `Discard batch` is always available.
  - The estate cannot be switched once any card in the batch has been saved.
  - A 401 mid-batch shows the passcode screen and the batch is intact after signing in again.

## Calls Claude made

Review list (Vincent did not pick between list and step-through; the list was the stated default);
12-card cap; 2400 px; batch-level role and note with per-card override; estate locked after the first
save in a batch.

---

# Addendum: spoken notes (approved by Vincent 2026-11-13)

## Intent

After a draft contact appears, Vincent wants to talk freely about the person ("met at SFF, runs their
Asia fund, her title is actually Managing Partner, follow up in January") and have Monsoon turn that
into tidy notes and correct any fields he mentioned, without typing.

## Decisions

- **Speech to text is the iPhone keyboard dictation** (the choice Vincent made, "for now"). A `Speak notes`
  button opens a text box with the keyboard up; he taps the keyboard microphone and talks, or types.
  No in-app recording, no microphone permission, no second provider. In-app one-button recording is a
  possible later version and must not be made harder by this one.
- **Tidying is one Claude Haiku 5.5 call** behind the same passcode: current fields + current notes +
  what was said in, updated fields + organised notes out.
- Non-goals: storing the raw speech; changing the save route or database; audio handling of any kind.
- Anti-goals: a field changed that Vincent did not explicitly correct; a field blanked; existing notes
  lost; anything saved before he taps Save.

## Behaviour

1. `Speak notes` is available on the single form and inside the editor of each card in the batch list.
2. `Apply` sends the text. On success the Notes field holds the organised notes (existing notes merged
   in) and any corrected field is updated. Each changed field is highlighted and shows its old value;
   `Undo` restores everything from before the Apply.
3. A field changes only when he states a correction for it. A value he did not state is never invented.
   A field is never emptied.
4. Notes are short plain lines in his words with filler removed (where they met, context, follow-up),
   no headings or markdown.
5. If tidying fails, the text he dictated is kept and `Use as typed` puts it into Notes unchanged.
6. A 401 shows the passcode screen and the dictated text is still there afterwards.

## Calls Claude made

Highlight-and-undo instead of a separate confirm screen; raw speech not stored; 4000-character limit on
the dictated text; never blanking a field even if asked to (he can clear it by hand).
