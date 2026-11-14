# Monsoon as a CRM brain: contacts, any-photo capture, research

Date: 2026-11-13. Status: approved by Vincent 2026-11-13 ("go"), including the capture change in section 12. Builds on the capture, batch and Ask designs in
this folder. The customer-accounts design (`2026-11-13-monsoon-customers-design.md`) is on hold; this
design must not make it harder (see section 9).

## 1. Intent

Vincent's framing: **Monsoon is becoming an agentic CRM brain.** Today it captures cards and answers
questions. He wants it to also (1) let him search for a contact and open their profile, (2) understand
that a photo is often not a business card (a name tag on a shirt, a web page, a slide) and still turn
the name into the right record, and (3) research a contact online when he presses a button, carefully,
to fill in a profile.

The design principle that follows from "brain": these are **capabilities with two ways in**. Vincent
can tap them on a screen, or ask the assistant to do them. Both ways use the same lookups and the same
change path.

## 2. Goals, non-goals, anti-goals

Goals

- **Contacts:** search by name, company or email; open a profile with details, stage, notes and the
  full timeline; add a note, move stage, and edit details from the profile.
- **One change path:** every change, tapped or asked, is a proposed change shown on a card and written
  only after Confirm. Field edits join notes and stage moves on that path.
- **History only grows:** a field edit logs the old and new value to the contact's timeline.
- **Any photo with a name:** cards, badges, name tags, screenshots of a website, a LinkedIn profile, an
  email signature, a slide, an attendee list. Monsoon reads whatever identifying details are there.
- **Match before save:** as soon as a photo is read, Monsoon checks the CRM and shows whether each
  person is already on file, with the choice to open the profile, add what is new, or save as new.
- **Research on demand:** a Research button on a profile (and "research her" in Ask) looks the person
  up online and returns findings with sources; Vincent chooses which to keep.
- The assistant can use all of it: find, open, edit, research.

Non-goals (this version)

- Anything that runs without being asked: scheduled research, digests, reminders, automatic enrichment
  of new contacts. Monsoon may *offer* ("Research her?"); it never starts by itself.
- Researching several contacts at once.
- Sending email or messages to contacts.
- Merging duplicate contacts; deleting anything.
- Editing a company's details beyond what research proposes for it (website, country).
- Setting next actions, owner, priority or tags (still deferred from Ask).
- Showing photos or avatars of people.

Anti-goals

- **False facts on a profile.** A research finding without a source, about the wrong person with the
  same name, or guessed rather than found.
- Research run on a contact Vincent did not ask about, or personal (non-professional) information
  collected about anyone.
- A field silently overwritten: every changed value is shown before and logged after.
- A photo of someone already on file creating a second record.
- Two different ways of changing the CRM that can drift apart (a screen that writes directly while the
  assistant goes through cards).
- Anything deleted.

## 3. Constraints and facts

- Same app, hosting, session, databases and rules as today. No schema change to any CRM.
- The lookups already exist in `src/lib/monsoon/ask/queries.ts` (`findContacts`, `getContact`,
  `getPerson`, and the rest); today only the assistant uses them.
- The change path exists: `ask/proposal.ts` signs a proposal, the UI shows a `ChangeCard`,
  `POST /api/monsoon/act` verifies and writes. It has two kinds today: `add_note`, `move_stage`.
- Editable person details in the schema: `name`, `title`, `email`, `phone`, `linkedin_url`, `country`.
  Company details: `name`, `country`, `website`, `org_type`. Capture already updates the four person
  fields `title, email, phone, linkedin_url`, filling empty ones only.
- Most Traxo people are filed under a company that is the pipeline member; their timeline is the
  company's. A person with neither their own membership nor a member company has no timeline.
- The never-delete scan forbids deleting, and forbids overwriting `notes` columns and timeline text.
  Updating detail fields is allowed (capture does it).
- The photo reader returns up to 12 entries of `name, title, org, email, phone, linkedin, raw_text` and
  is told to expect cards and badges. The read route does not touch a database today.
- Web research needs a web search capability. Claude's API offers a server-side web search tool billed
  per search on the same API key. Whether Claude Haiku 5.5 supports it, and its exact request and
  citation shapes, must be confirmed from the `claude-api` skill before building stage 3.
- Vincent's standing rule: cheap models, never Opus or Fable.
- Route time limit on this Vercel plan: 60 seconds has been accepted for Ask.

## 4. Approaches considered

For how the new screens change data:

A. **Everything through the proposal-and-confirm path (chosen).** Tapping Edit, Add note, Move stage or
   accepting research on a profile produces the same signed proposal the assistant produces, shown on
   the same card. One write path, one set of rules, and the assistant gets every capability for free.

B. **Direct save from the profile screen.** Fewer taps for a hand edit. Rejected: a second write path
   that must separately enforce never-delete, logging and estate checks, and the assistant would need
   its own copy.

For research:

C. **One research run that returns sourced findings for Vincent to accept (chosen).** Bounded, auditable,
   nothing written until he ticks and confirms.

D. **Let the assistant browse freely inside a conversation and update as it goes.** More "agentic",
   rejected for now: hard to bound in time and cost, and too easy to write an unverified claim.

Vincent described outcomes and the "brain" framing; A and C are Claude's calls within it.

## 5. What Vincent sees

### 5.1 Navigation

The switch under the estate selector becomes three: `Capture | Contacts | Ask`.

### 5.2 Contacts

```
┌──────────────────────────────┐
│ [ Capture ][ Contacts ][ Ask ]│
│  🔍 mia                       │
│                              │
│  Mia Ditrolio                │
│  Everberg Capital · Analyst  │
│  LP prospect · Uncontacted   │
│  ─────────────────────────   │
│  Mia Chen                    │
│  filed under Raffles FO      │
└──────────────────────────────┘
```

- Search as he types (two characters or more), by name, company or email. Results show name, company,
  title, and role and stage, or `filed under <company>`, or `on file, not on the pipeline`.
- An empty search shows the 20 contacts most recently added or touched.

### 5.3 Profile

```
┌──────────────────────────────┐
│ ‹ Contacts                   │
│  Mia Ditrolio                │
│  Analyst · Everberg Capital  │
│  [LP prospect] [Uncontacted] │
│                              │
│  Email   mia.ditrolio@...    │
│  Phone   +1 212-970-5762     │
│  LinkedIn  (none)            │
│                              │
│ [Add note][Edit][Research]   │
│                              │
│  Notes                       │
│  Met at the MMW gala ...     │
│                              │
│  Timeline                    │
│  13 Nov  note  Ask who the   │
│          family is ...       │
│  13 Nov  meeting  Card       │
│          captured in person  │
└──────────────────────────────┘
```

- Email, phone and LinkedIn are tappable (mail, call, open).
- A person filed under a company shows that company's stage and timeline, labelled
  `Timeline of <company>`, and a link to the company's own profile. A company profile lists its people.
- **Add note** opens a small box (typing or dictation), then the usual note card to confirm.
- **Stage chip** opens a stage picker, then the usual stage card.
- **Edit** makes the detail fields editable. Saving shows an edit card listing each change as
  `Title: Analyst → Associate`, with Confirm and Cancel.
- **Research** is described in 5.5.
- **Ask about this contact** opens Ask with this contact already in context.
- After any confirmed change the profile reloads and the new timeline entry is at the top.

### 5.4 Photos of anything

- The photo button reads `Snap or choose a photo`. Nothing else changes in how a photo is taken.
- After reading, each person found shows a match line before anything is saved:
  - `New contact` (no match), or
  - `Already on file: Jane Tan, Northwind Capital` with three choices: `Open profile`,
    `Add what's new` (fills empty details and logs the meeting, as capture does today), or
    `Different person` (save as new), or
  - `Possible matches` when only a name was read and several people share it: a short list to pick
    from, or `None of these`.
- A photo that yields only a name (a shirt tag) is fine: the form shows the name, and Company is the
  one field Monsoon asks for if he knows it, because a name alone is weak for matching later.
- A screenshot of a list (attendees, a team page) goes to the batch review, with a match line per row.
- If nothing that looks like a person is found: `No name found in that photo.` and the form stays usable.

### 5.5 Research

1. On a profile he taps **Research**. If the record has nothing to anchor on beyond a name (no company,
   no email, no LinkedIn), Monsoon says `Add a company or email first so I research the right person.`
2. Otherwise a busy state (`Researching Mia Ditrolio at Everberg Capital...`, typically 20 to 50
   seconds), then a **findings card**:

```
┌ Research: Mia Ditrolio ──────┐
│ Looks like the right person: │
│ name and firm match on       │
│ everbergcapital.com          │
│                              │
│ ☑ LinkedIn                   │
│   linkedin.com/in/...        │
│   source: linkedin.com       │
│ ☑ Title: Analyst → Associate │
│   source: everbergcapital... │
│ ☐ Location: New York         │
│   source: linkedin.com       │
│                              │
│ Summary (added as a note)    │
│ Joined Everberg in 2024 ...  │
│   sources: 2 links           │
│                              │
│ [ Save selected ] [ Discard ]│
└──────────────────────────────┘
```

3. Each finding shows the value, where it came from (a link he can open), and whether it fills an
   empty field or differs from what is on file. Findings that fill an empty field are ticked by
   default; ones that would change an existing value are **not** ticked by default.
4. `Save selected` writes the ticked fields and one timeline note: the summary plus the list of what
   was added and the source links. `Discard` writes nothing.
5. If Monsoon is not confident it found the right person, it says so plainly
   (`I found several people with this name and can't tell which is yours.`) and offers nothing to tick.
6. If it finds nothing reliable: `Nothing I'd trust. No changes suggested.`
7. After saving a sparse new contact, Monsoon may show one line: `Research her?` It does nothing unless
   tapped.

### 5.6 The assistant

- "Find Mia" answers and offers `Open profile`.
- "Change her title to Associate" produces the edit card.
- "Research her" produces a card with a `Run research` button; pressing it runs 5.5. The assistant does
  not run research by itself inside an answer.

## 6. How it works

### 6.1 Reading

- `GET /api/monsoon/contacts?estate=&q=` returns matches from `findContacts`; with no `q`, the 20 most
  recently added or touched contacts.
- `GET /api/monsoon/contact?estate=&memberId=` or `&personId=` returns the profile from `getContact` /
  `getPerson`, including for a person under a company the company member's stage and timeline.
- Both are session-first, read-only (the existing read-only transaction wrapper), and return only the
  signed-in user's estate data.

### 6.2 One change path

- `POST /api/monsoon/propose` takes `{ estate, kind, target, ... }` and returns a signed proposal, for
  the kinds below. It is how screens ask for a change; the assistant's propose tools call the same
  functions. `POST /api/monsoon/act` stays the only route that writes them.
- Kinds:
  - `add_note` and `move_stage`: as today.
  - `update_details` (new): a set of field changes on one person or one company. The proposal carries,
    signed, the target, and for each field the old value **as read when proposed** and the new value.
    On Confirm the server checks each old value still matches the database; a field that changed in
    the meantime is not written and is reported. It updates the fields, then writes one timeline note
    listing each change (`Title: Analyst → Associate`), by the signed-in user. Editable fields: person
    `name`, `title`, `email`, `phone`, `linkedin_url`, `country`; company `website`, `country`.
    Renaming a person re-computes the name key; a rename that would collide with another person at the
    same company is refused with a plain message.
  - `apply_research` (new): like `update_details`, plus the research summary and sources written into
    the same timeline note. The proposal is signed over every finding and source; the set of ticked
    findings travels with the confirmation and must be a subset of the signed findings.
- A person with no timeline anywhere (not a member, company not a member) can still have details
  edited; the change log then has nowhere to go. For that case the edit is refused with
  `Add <name> to the pipeline first.` and a button that does so (creates their membership with the
  estate's default role, as capture does), after which the edit proceeds. History is never skipped.
- Field values are length-limited as in capture (300 characters). Notes and timeline text are never
  edited or removed.

### 6.3 Photos

- The reader's instruction is widened: the image may be a business card, badge, name tag, a screenshot
  of a website, profile, email signature, slide or list, or any image showing people's names. It
  returns one entry per person it can identify by a visible name, with only details visibly attached
  to that person; it never fills a field from elsewhere in the image by guesswork. It also returns
  `kind` per entry (`card`, `badge`, `screen`, `other`) for the timeline wording.
- The read route gains the estate and, after reading, runs a **match** for each entry against that
  estate: exact name key at the same company, exact email, then same name at any company, then (name
  only) everyone with that name. It returns each entry with `match: none | exact | same_name | several`
  and the candidates (member or person id, name, company, stage). Matching is read-only.
- The timeline entry written at save says how the contact was captured:
  `Card captured in person`, `Badge captured in person`, or `Captured from a screenshot`.
- `Add what's new` and `Different person` map onto capture's existing behaviour (`samePerson` set to
  the matched id, or `false`), so the save path and its duplicate guard are unchanged.

### 6.4 Research

- `POST /api/monsoon/research` `{ estate, memberId | personId }`. Session-first. Refuses without an
  anchor (company, email domain, or LinkedIn URL on the record).
- One model run with the web search tool, at most 6 searches and about 45 seconds, given the contact's
  name and anchors and these rules:
  - First establish identity: only treat a page as about this person if it matches the name **and** at
    least one anchor (the company, the email domain's company, or the LinkedIn URL). If identity is not
    established, return no findings and say why.
  - Report only what a cited page states. No inference, no "likely".
  - Professional information only: current title, employer, LinkedIn URL, work location (city or
    country), company website, and a two-to-four sentence professional summary (role, focus, career).
    Never: home address, personal phone or email, age, family, health, politics, religion, photos, or
    anything from people-search or data-broker sites.
  - An email address or phone number is reported only if published on the employer's own website for
    that person.
- The server does not trust the model's output alone:
  - Every finding must cite a URL that the search tool actually returned in this run; findings citing
    anything else are dropped.
  - Data-broker and people-search domains are dropped by a blocklist.
  - Values are length-limited and cleaned; a LinkedIn finding must be a `linkedin.com/in/` URL.
  - Findings equal to what is already on file are dropped.
- The result is an `apply_research` proposal (not yet written) with the identity statement, findings,
  summary and sources. Nothing is stored unless he saves.
- Model: `MONSOON_RESEARCH_MODEL`, default Claude Haiku 5.5 if it supports web search well enough in a
  live check on three known contacts; otherwise Claude Sonnet 5.5, with the cost difference told to
  Vincent before shipping. Opus and Fable stay refused.
- Each run is logged to the server log by name of action only (no contact data), and written to the
  timeline only when findings are saved, so the timeline shows when research was accepted.

### 6.5 The assistant

- New tools: `propose_update` (field changes for a person or company) and `propose_research` (returns
  a card with a `Run research` button; it does not search). `find_contacts` results and answers carry
  the ids the UI needs to offer `Open profile`.
- The assistant's rules gain: field changes follow the same "only when the user asks, confirm before
  saving" rule as notes and stages; it never states facts about a person from its own knowledge, only
  from the CRM or from saved research.

## 7. Stages (each shippable on its own)

1. **Contacts:** navigation, search, profile, add note and move stage from the profile, the `propose`
   route, `update_details`, Edit, and `propose_update` for the assistant.
2. **Photos:** the widened reader, `kind`, match-before-save in the single form and the batch list.
3. **Research:** the research route and guards, `apply_research`, the findings card, the profile
   button, the offer after saving, and `propose_research`.

## 8. Calls Claude made (not decisions Vincent stated)

- One change path for taps and the assistant; hand-editing included.
- Field edits log old and new values to the timeline; an edit is refused rather than left unlogged.
- Three-way navigation.
- Match-before-save with the three choices, and Company as the one extra field asked for on a
  name-only photo.
- Research needs an anchor beyond a name; identity must be established before any finding is offered.
- Findings that would change an existing value are unticked by default.
- Professional information only, with the listed exclusions and a blocklist of people-search sites.
- Emails and phone numbers only from the employer's own site.
- Research is one bounded run, and the assistant offers it but does not run it inside an answer.
- Nothing runs in the background in this version.
- Haiku first for research, Sonnet only if a live check shows Haiku is not good enough.

## 9. Keeping the customer-accounts design open

That design replaces the fixed owner `VF`, the hardcoded estates and the single Claude key with
per-customer values. To avoid rework: new code takes the owner key, the estate and the Claude client
from the same places existing code does (so the later change is made once, in those places), names no
person in prompts except through the same variable Ask already uses, and adds no new setting that
would have to become per-customer other than `MONSOON_RESEARCH_MODEL`.

## 10. Testing

- Lookups and both new change kinds against a real Postgres: search ranking and limits; profile for a
  person member, a company member, a person under a company, a person with no membership; an edit
  writes the fields and exactly one timeline note with old and new values; a stale old value is not
  written; a rename collision is refused; research apply writes only ticked findings; nothing else
  changes; nothing is deleted (the scan stays green).
- Proposals: `update_details` and `apply_research` signatures cover every field, value and source; a
  tampered value, an added finding, another estate, and an expired proposal are refused.
- Matching: each match outcome, case and spacing differences, email match, name-only with several
  candidates, and that matching writes nothing.
- The reader: mocked model output for a card, a name tag (name only), a web page with several people,
  an image with no person; malformed output; the 12 cap.
- Research guards with scripted model and search results: a finding citing a URL the tool did not
  return is dropped; a blocklisted source is dropped; identity not established yields no findings; a
  non-`/in/` LinkedIn URL is dropped; personal information categories in the output are dropped;
  limits on searches and time; nothing written before save.
- Screens: search, profile, edit card, findings card (ticking, defaults, save, discard), match lines in
  the single form and batch, navigation keeping each mode's state, and the existing locks.
- Live checks before each stage ships, read-only where possible: search and profile against Traxo;
  three real photos that are not cards; research on three known contacts with nothing saved, judged
  for wrong-person and unsourced claims.

## 11. Left to the builder

- Query details for "most recently added or touched" and for matching.
- The exact reader and research instructions, within sections 6.3 and 6.4, and the web search tool's
  request and citation handling (load the `claude-api` skill first).
- The blocklist's contents.
- Screen design within the Monsoon brand, and where `Ask about this contact` sits.
- How a profile link is represented so the assistant's answers can offer `Open profile`.

## 12. Resolved in review (these override earlier sections where they differ)

**Search**

- Search uses a new query, not `findContacts`: people by name, email or their company's name, and
  companies by name, so searching "Raffles" finds the people filed under Raffles as well as the
  company. Results are ordered by how well they match (a name starting with the text first), then by
  name.
- An empty search lists the 20 pipeline members (people or companies) most recently added or active,
  by the later of the member's last update and its newest timeline entry. People who are only on file
  under a company do not appear in that list; they are found by searching.

**Capture changes (section 6.3 said the save path was unchanged; it is not)**

- **Choosing a match by id.** `Add what's new` passes the matched person's id. Capture accepts it when
  that person has the same name key **or** the same email as the entry, so an email match under a
  different spelling ("Jon" / "Jonathan") works. The server re-checks this; an arbitrary id is refused.
- **A person at a company that is already a pipeline member.** Today capture gives such a person their
  own new pipeline entry beside the company's. From this design on, when the person has no membership
  of their own and their company is a member, the meeting is logged on the **company's** timeline,
  prefixed with the person's name, and no second pipeline entry is created. This matches how Ask
  already treats such people. It changes live capture behaviour and is called out for Vincent.
- **`Different person` needs a company.** The database allows only one person with a given name and no
  company. If a namesake is on file and the new person has no company, Monsoon asks for the company
  (`Add their company so I can tell them apart.`) before saving as new.
- **How it was captured.** Capture takes the entry's `kind` and writes `Card captured in person`,
  `Badge captured in person` or `Captured from a screenshot`.
- The read route takes the estate and matches against that one estate.

**Editing**

- **Company is editable too.** A person's company can be set (when empty) or changed (a job move) from
  Edit or by asking. The new company is found or created with the same lookalike check capture uses;
  a change that would collide with a same-named person at the target company is refused. Without this
  a name-only contact could never gain the anchor research needs.
- **Rename collisions** cover both cases: another person with that name at the same company, or, for
  someone with no company, any other company-less person with that name.
- **Change log entries are `system` timeline entries, not `note`.** The pipeline's "last action" and
  "gone quiet" logic counts notes, calls, emails and meetings; logging an edit or a research result as
  a note would make a contact look recently contacted. `system` entries appear in the timeline but do
  not count as contact.
- **A person with no timeline.** Confirming an edit (or research) for someone who is not on the
  pipeline and whose company is not either adds them to the pipeline as part of the same confirmed
  change, with the estate's default role and first stage. The card says so:
  `This also adds <name> to the pipeline as <role>.` One card, not two.
- The edit code keeps its own fixed list of updatable columns, with a test that the list can never
  include `notes`.

**Research**

- Findings about the person update the person; a company website or country updates the person's
  company when they have one, in the same confirmed change. The log entry goes on the person's
  timeline home (their own, else their company's).
- There is no city field: a location finding is the **country**; a city, if found, is mentioned in the
  summary only.
- The research summary is editable on the findings card before saving, like a note's text; up to
  2,000 characters. The findings and sources are signed; the summary text is not.

**Proposals**

- The proposal format is extended (target person or company ids, field lists, findings) and its
  strict shape check is rewritten per kind. The confirm route accepts up to 64 KB for the two new
  kinds. Profiles for a person return the person id an edit needs.

**To confirm before building stage 3**

- That the web search tool is enabled on Vincent's Claude key and works with Haiku 5.5, and that a
  run of up to 6 searches fits the 60-second route limit. If it does not fit, the run is cut to fewer
  searches rather than made to run in the background.
