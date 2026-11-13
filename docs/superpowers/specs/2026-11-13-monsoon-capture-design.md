# Monsoon capture app: design

Date: 2026-11-13. Status: approved by Vincent 2026-11-13.

## 1. Intent

Vincent meets people at events and wants them in the right CRM before the card goes in a pocket.
Monsoon is a one-screen app on his iPhone: pick Traxo or Zero One, photograph a business card or
name badge, glance at the fields, save. The person lands in that estate's Monsoon CRM, written by
the same rules every other capture follows.

It takes the place of the Telegram card bot planned in the CRM roadmap
(`C:\Dev\Quantcloud\core\docs\superpowers\specs\2026-10-09-crm-core-design.md`, decision 4), which
was never built.

## 2. Goals, non-goals, anti-goals

Goals

- Photo to saved contact in a few taps, one-handed, on an iPhone.
- Two estates: Traxo and Zero One. The selector remembers the last choice.
- A confirm step: extracted fields are shown and editable before anything is written.
- A capture from the phone follows the core's capture rules (`Crm.capture` in
  `C:\Dev\Quantcloud\core\quantcloud\crm\db.py`). The deliberate differences are listed in 6.4.
- Only Vincent can use it.

Non-goals (this version)

- Quantcloud and Qforce estates. Quantcloud has no CRM; Qforce's is on a laptop-only Postgres.
- Writing one card to both estates in one action. (The `capture_id` is still generated per photo,
  so this can be added later without a schema change.)
- Offline use, a queue for bad signal, or background upload.
- Storing the photo.
- Browsing, searching or editing the CRM from the phone.
- A native app, TestFlight, or the App Store.
- Multiple users or accounts.

Anti-goals

- Saving a misread badge without Vincent seeing it.
- Creating a twin of a person or company already on file.
- Any unauthenticated path to the CRM databases, the model key, or the read/save routes.
- A second set of capture rules that drifts from the Python core.

## 3. Constraints

- Lives at `quantcloud.com/monsoon`, inside the existing site: Next.js 15 (app router), React 19,
  Tailwind 3, Vitest, deployed on Vercel as project `qcwebsite`. Repo: `C:\Dev\Quantcloud\QCwebsite`.
- The site sends `Permissions-Policy: camera=()` on every path. That blocks in-page camera streams
  (`getUserMedia`). It does not block a file input that opens the system camera, which is what
  this app uses, so the header stays as it is.
- Each estate has its own Supabase Postgres database with the core schema
  (`C:\Dev\Quantcloud\core\quantcloud\crm\schema\0001_init.sql`). Row-level security is on with no
  policies, so only a direct server-side database connection can read or write. The connection
  strings are the ones in `~/.quantcloud/crm.env` (`TRAXO_CRM_DATABASE_URL`,
  `ZEROONE_CRM_DATABASE_URL`); both point at the Supabase transaction pooler (port 6543), so the
  driver must not rely on session-level prepared statements.
- Vercel caps a request body at 4.5 MB; iPhone photos are larger.
- The core's rule is "no estate content in the core". This app is not in the core, so it may name
  the two estates.
- No schema change to either database.

## 4. Approaches considered

A. **Routes inside the quantcloud.com site (chosen).** A `/monsoon` page and three server routes
   in the existing Next.js app. One project, one deploy, existing hosting. Cost: the capture rules
   are re-implemented in TypeScript, pinned to the Python originals by shared test cases (section 8).

B. **A separate Python service proxied at `/monsoon`.** Reuses `Crm.capture` directly, so one copy
   of the rules. Rejected: a second deployed project, the private core repo shipped into it, and a
   proxy hop, for a one-screen app.

C. **Phone writes a pending row; the laptop files it later.** Simplest app, one copy of the rules.
   Rejected: the contact is not in the CRM until the laptop runs, and a lookalike-company warning
   arrives hours after the card is gone.

Vincent chose a home-screen web app over a native TestFlight app, and `quantcloud.com/monsoon` as
the address. The choice of A over B and C is Claude's call, made because Vincent described outcomes
and left the build to Claude.

## 5. What Vincent sees

```
┌──────────────────────────┐
│  [ Traxo ] [ Zero One ]  │  remembers the last choice
│                          │
│      📷  Take photo      │
│                          │
│  Name    Jane Tan        │
│  Title   Partner         │
│  Org     Acme Capital    │
│  Email   jane@acme.com   │
│  Phone   +65 ...         │
│  LinkedIn                │
│  Role    [LP prospect ▾] │
│  Notes   met at ...      │
│                          │
│        [  Save  ]        │
└──────────────────────────┘
```

1. First open: a passcode screen. Once entered, the phone stays signed in for 180 days.
2. Main screen: estate selector, a large "Take photo" button. Tapping it opens the iPhone camera
   (with the option of the photo library).
3. While the photo is read, a busy state. Then the fields appear, all editable. Fields the reader
   could not find are empty, not guessed.
4. Role is a dropdown of that estate's roles, read from the database. Defaults: Traxo
   `lp_prospect`, Zero One `investor`. Changing the estate after a photo keeps the fields and
   resets the role to the new estate's default.
5. Save. Outcomes:
   - **Added**: "Jane Tan added to Traxo." The form clears, ready for the next card.
   - **Already on file**: "Jane Tan is already in Traxo as LP prospect; filled in phone." (or
     "nothing new"). It states the role on file, because the chosen role is not applied to an
     existing member.
   - **Company lookalike**: "Acme Capital looks like Acme Capital Pte Ltd, already on file."
     Two buttons: use the existing company, or it is a different company. Either re-saves.
     When several existing companies look alike, the existing ones are a pick-list.
   - **Same name, other company**: "Jane Tan is already on file at Acme Capital. Same person?"
     Two buttons: same person, or a different Jane Tan. See 6.4 step 3.
   - **Name is ambiguous** (no company given and several people share the name): asks for the
     company.
   - **Failure** (no signal, database down): an error with the fields kept so Save can be retried.
6. The form can also be filled by hand without a photo, for a badge too poor to read.

Installed with Safari's "Add to Home Screen": opens full-screen, own icon, title "Monsoon".

## 6. How it works

### 6.1 Pieces

- `src/app/monsoon/`: the page (client component), its own layout with the home-screen metadata
  (web manifest scoped to `/monsoon`, apple touch icon, standalone display, `noindex`). It does not
  use the marketing site's header or footer.
- `src/app/api/monsoon/session`: POST passcode, sets the session cookie. DELETE signs out.
- `src/app/api/monsoon/estates`: GET, returns for each estate its key, label, roles (from the
  database `roles` table) and default role.
- `src/app/api/monsoon/read`: POST one image, returns extracted fields.
- `src/app/api/monsoon/save`: POST estate, fields, role, `capture_id`, the extracted JSON, and
  optional `new_org` / `use_org` / `same_person`; writes to that estate's database.
- `src/lib/monsoon/`: `rules.ts` (the ported pure rules), `capture.ts` (the transaction),
  `estates.ts` (the two estates and their env var names), `auth.ts`, `extract.ts`.

### 6.2 Access

- One passcode in `MONSOON_PASSCODE`. Compared in constant time. On success, an HMAC-signed,
  `HttpOnly`, `Secure`, `SameSite=Strict` cookie scoped to path `/` with a 180-day expiry, signed
  with `MONSOON_SESSION_SECRET`.
- Every `/api/monsoon/*` route except `session` POST rejects a request without a valid cookie
  with 401, before doing anything else.
- No lockout counter, so no extra store is needed. Guessing is made impractical instead: the
  passcode must be at least 16 characters (the route refuses to start with a shorter
  `MONSOON_PASSCODE`), and every failed attempt waits a fixed second before answering. Vincent
  types it once per 180 days.
- The page itself is public HTML with nothing sensitive in it; it shows the passcode screen when
  the API returns 401.

### 6.3 Reading the photo

- The browser downsizes the photo before upload (longest side about 1600 px, JPEG) so it fits the
  request cap and reads quickly. This also converts HEIC.
- `read` sends the image to Claude through the Anthropic API (`ANTHROPIC_API_KEY`) and asks for a
  fixed structure: `name, title, org, email, phone, linkedin, raw_text`. `raw_text` is
  everything legible on the card. The instruction is to leave a field empty when it is not on the
  card. A name badge with only a first name returns only that.
- Vincent's decision: use a cheap model, never Opus or Fable. The default is Claude Haiku 5.5
  (`claude-haiku-5-5`). `MONSOON_MODEL` can override it, and the route refuses an id containing
  `opus` or `fable`. The builder loads the `claude-api` skill before writing this call.
- The image is held in memory for the request and never written anywhere.

### 6.4 Saving

`save` opens a connection to the chosen estate's database and, in one transaction, does the
following. Steps 2, 4 and 5 are the core's `Crm.capture`; steps 1, 3, 6 and 7 are additions.

1. Take a transaction-level advisory lock keyed on the `capture_id`. If a `captures` row with
   this `capture_id` already exists in this database, return the earlier result and write
   nothing. (The schema has no unique constraint on `capture_id`, so this check is the guard.)
2. Validate the role against the database `roles` table.
3. Same-name check, which the core does not do when a company is given. Look the person up by
   `name_key` across all orgs. If a person with that name exists only under a different company
   (or with no company) and the request carries no `same_person` answer, write nothing and return
   the "same name, other company" outcome with the existing company names.
   - `same_person = <person id>`: use that existing person. Fill empty fields only. Their company
     on file is not changed; the company on the new card goes into the touch summary (step 7).
   - `same_person = false`: carry on to step 4 and create a separate person.
4. If a company is given (and step 3 did not settle the person): apply the lookalike guard
   (`guard_new_org`), then find or create the org by `name_key`, then find or create the person
   by `(org_id, name_key)`, filling only empty fields on an existing person (`merge_fill_empty`).
   If no company: look the person up by `name_key` across all orgs; one match is reused (fill
   empty), several is the "ambiguous" outcome, none creates an orgless person.
5. Add the member if this person has none. The member row carries `person_id` only, never
   `org_id` (the `member_one_target` check allows exactly one). Role as chosen; stage = the first
   non-terminal stage (`SELECT key FROM stages WHERE NOT terminal ORDER BY ord LIMIT 1`, which is
   the core's `default_stage`); owner `VF` (the core leaves owner empty unless told; here the
   capturer is always Vincent); notes = the Notes field. An existing member is left untouched,
   including its role.
6. Insert a `captures` row: `capture_id` (a UUID the browser generated when the photo was taken,
   or at save for a hand-typed entry), `channel = 'monsoon-app'`, `status = 'written'`,
   `raw_text`, `extracted` (the reader's original output, before Vincent's edits), `image_ref`
   null, `person_id`, `org_id`.
7. Log a touch on the member: kind `meeting`, by `VF`, summary "Card captured in person" plus the
   Notes text when present, plus "card shows <company>" when step 3 reused a person filed under
   another company. This is logged for an existing member too, since meeting someone again is a
   real event.

`source` on any org, person or member created here is `monsoon-app`.

`use_org` is the exact existing company name Vincent picked from the lookalike prompt; it replaces
the typed company. `new_org` skips the guard, as `--new-org` does in the core.

### 6.5 Configuration (Vercel environment, production only)

`TRAXO_CRM_DATABASE_URL`, `ZEROONE_CRM_DATABASE_URL`, `ANTHROPIC_API_KEY`, `MONSOON_PASSCODE`,
`MONSOON_SESSION_SECRET`, optional `MONSOON_MODEL`, optional `MONSOON_DB_CA_CERT` (Supabase's CA
certificate, only if the pooler certificate is not already trusted; verification stays on either
way). Vincent supplies the passcode; the builder
generates the session secret. `.env.example` lists the names without values. All are marked
sensitive and set for production only, so preview deployments cannot reach the CRMs; the routes
are proven against a local Postgres (section 8) before the first live save.

## 7. Calls Claude made (not decisions Vincent stated)

- Approach A.
- A new contact lands in the estate's first stage, like every other capture, and the fact of
  meeting is recorded as a `meeting` touch. The stage is not auto-advanced to `met` or `contacted`.
- Default roles: Traxo `lp_prospect`, Zero One `investor`.
- LinkedIn is extracted when printed on the card. Country is not a field: it is not written
  anywhere, though it survives in the card's raw text.
- When the name is already on file under another company, the app asks whether it is the same
  person rather than silently adding a second one; "same person" keeps the company on file.
- No lockout counter; a 16-character minimum passcode and a fixed delay instead.
- The existing full-access database connection strings go into Vercel as production-only,
  sensitive environment variables (Vincent agreed 2026-11-13). Vincent supplies the Anthropic key.
- The reader's original output and the card's raw text are kept in the `captures` row for audit.
- 180-day sign-in.
- Roles come from the database, not from a copy of the manifest.
- File-input camera, leaving the site's camera policy header unchanged.

## 8. Keeping the two copies of the rules in step

The TypeScript rules (`name_key`, `merge_fill_empty`, `org_name_cores`, `similar_org_names`) must
give the same answers as `C:\Dev\Quantcloud\core\quantcloud\crm\rules.py`.

- A script in the core runs the Python functions over a case list (including every org-name case
  in `core/tests/crm`) and writes a JSON file of inputs and outputs. That file is committed in this
  repo and the Vitest suite asserts the TypeScript functions reproduce every output.
- `similar_org_names` uses Python's `difflib.SequenceMatcher.ratio()` with a 0.85 threshold. The
  port must reproduce that ratio (it is not Levenshtein), and the fixture must include cases on
  both sides of the threshold.
- The capture transaction is tested against a real Postgres loaded with `0001_init.sql`, covering:
  new person and org; existing person, fill-empty; lookalike org refused, then `new_org`, then
  `use_org` (including several lookalikes); ambiguous orgless name; same name under another
  company, answered both ways; existing member untouched with its role kept; repeated
  `capture_id`, including two concurrent saves.

## 9. Left to the builder

- Database driver and connection handling for serverless.
- The exact model prompt and structured-output mechanism.
- Visual design of the screen, within the site's Tailwind setup; it should feel like an app, with
  large touch targets and no marketing chrome.
- Icon artwork (the Quantcloud mark is in the repo root as `Quantcloud Logo Blue.png`).
- How Postgres is provided to the tests locally and whether those tests run in the default
  `vitest run` or a separate command.
- Rollout order. The last step is Vincent adding the page to his home screen and saving one real
  card into each estate.
