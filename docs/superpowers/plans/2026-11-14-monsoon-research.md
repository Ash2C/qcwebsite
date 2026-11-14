# Monsoon Research (CRM brain stage 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Research button on a person's profile runs one bounded, sourced web search about that person and shows a findings card; nothing is saved unless the user ticks findings and confirms.

**Architecture:** A new route runs one Claude Haiku call with the server-side web search tool, then a pure guard function drops anything unsourced, off-topic or private. What survives becomes a signed `apply_research` proposal that goes through the existing confirm route (`/api/monsoon/act`), which writes the ticked fields and one `system` timeline entry in one transaction.

**Tech Stack:** Next.js 15 app router, React 19, Vitest 2, node-postgres on a transaction-mode pooler, `@anthropic-ai/sdk` (model `claude-haiku-5-5`, tool `web_search_20250305`, native structured output via `output_config.format`).

**Spec:** `docs/superpowers/specs/2026-11-13-monsoon-brain-design.md` sections 5.5, 5.6, 6.2, 6.4, 6.5, 10 and 12 (section 12 overrides earlier sections).

## Global Constraints

- The web app never deletes or overwrites a contact or note. No `DELETE`, no `UPDATE` of `touches` or of a `notes` column. `src/lib/monsoon/no-delete.test.ts` must stay green and its column-list assertions extended for any new update statement.
- No CRM change without an explicit confirm. The research route writes nothing to the database.
- Research runs only when the user presses a button. The assistant never runs it inside an answer.
- Model: `process.env.MONSOON_RESEARCH_MODEL || "claude-haiku-5-5"`; an id containing `opus` or `fable` throws, as `extract.ts` does for `MONSOON_MODEL`. Resolved per call.
- Web search tool is exactly `{ type: "web_search_20250305", name: "web_search", max_uses: 6, blocked_domains: BLOCKED_DOMAINS }`. Do not use the `_20260209` variant (not available on Haiku). No forced `tool_choice`.
- Database: unnamed parameterised statements only, no session state, TLS verification never disabled. A unique violation is identified by `err.table`, never by constraint name.
- Change-log entries are `touches` rows of kind `system`, by owner `VF`, source `monsoon-app` where a source applies (same constants as `details.ts`).
- Field values are limited to 300 characters; the research summary to 2,000.
- Server logs carry action names and error names only, never contact data, search queries or model output.
- The repository is public: tests and fixtures use invented people and companies only. Do not open any `.env*` file other than `.env.example`.
- Exact copy (verbatim):
  - `Add a company or email first so I research the right person.`
  - `Research works on a person. Open a person's profile.`
  - `Researching <name> at <company>...` (without ` at <company>` when there is no company)
  - `I found several people with this name and can't tell which is yours.`
  - `Nothing I'd trust. No changes suggested.`
  - `Research took too long. Try again.`
  - `Could not run research. Check signal and try again.`
  - Card title `Research: <name>`; buttons `Save selected`, `Discard`, `Research`, `Run research`; summary heading `Summary (added to the timeline)`; source line `source: <host>`; pipeline line `This also adds <name> to the pipeline as <role>.`
  - Timeline entry: `Research saved: <Label>: <from or (empty)> → <to>; ...` then, when a summary is saved, a blank line and the summary, then a blank line and `Sources: <url>, <url>`.
  - Confirm message: `Done. Research saved for <name>.`

## Review Focus

1. A finding citing a URL the search tool did not return in this run (model invents a source): dropped, never shown.
2. A page about a namesake at another firm: identity must be reported established by the model AND at least one surviving finding or summary source must exist; otherwise no findings.
3. The record changes between research and Save (someone edits the title): the stale finding is skipped and reported, the rest are written.
4. The user unticks everything and clears the summary: Save is disabled; the server refuses an empty confirmation.
5. Tampering: a `ticked` id not in the signed proposal, a duplicated id, or a proposal for another estate is refused.

---

### Task 1: The `apply_research` proposal kind

**Files:**
- Modify: `src/lib/monsoon/ask/proposal.ts`
- Test: `src/lib/monsoon/ask/proposal.test.ts`

**Interfaces:**
- Produces:

```ts
export type ResearchField = "title" | "linkedin" | "country" | "email" | "phone" | "website";
export type ResearchFinding = {
  id: string;            // "f1".."f8", unique in the proposal
  target: "person" | "company"; // "company" only for field "website"
  field: ResearchField;
  from: string | null;   // value on file when researched
  to: string;            // 1..300 chars
  source: string;        // https URL, <= 500 chars
};
// added to the Proposal union:
{
  kind: "apply_research";
  estate: EstateKey;
  person: { id: string; name: string };          // id is a UUID
  company: { id: string; name: string } | null;  // the person's company when researched
  identity: string;                               // 1..400 chars, why this is the right person
  findings: ResearchFinding[];                    // 0..8
  summarySources: string[];                       // 0..6 https URLs, <= 500 chars each
  logMemberId: string | null;
  addsToPipeline: string | null;
  expires: number;
}
```

- `KEYS.apply_research` lists exactly those keys. `wellFormedResearch(o)` checks every field strictly: exact key sets on nested objects, UUIDs, `id` matches `/^f[1-8]$/` and is unique, `field`/`target` pairing (`website` ⇔ `company`; a `company` finding requires `company !== null`), no duplicate `(target, field)`, `from !== to`, lengths, every URL parses with `new URL` and has protocol `https:`. A proposal with no findings and no `summarySources` is not well formed.

- [ ] **Step 1: Write failing tests** in `proposal.test.ts`: a valid research proposal signs and verifies; each of these is refused: extra key, missing key, finding id `f9`, duplicate id, duplicate `(target, field)`, `website` on `person`, company finding with `company: null`, `to` of 301 chars, `http:` source, non-URL source, 9 findings, 7 summary sources, empty findings with empty `summarySources`, changed `to` after signing, added finding after signing, expired, wrong estate key value.
- [ ] **Step 2: Run** `npx vitest run src/lib/monsoon/ask/proposal.test.ts` — the new tests fail.
- [ ] **Step 3: Implement** the type, `KEYS` entry and `wellFormedResearch`, dispatched from `wellFormed` like `update_details`.
- [ ] **Step 4: Run** the file again — pass; `npx tsc --noEmit` clean (add `apply_research` handling wherever a `switch`/narrowing on `proposal.kind` no longer compiles, with the smallest change that preserves behaviour; `ChangeCard` and `act` get real handling in later tasks).
- [ ] **Step 5: Commit** `feat(monsoon): apply_research proposal kind`.

### Task 2: Applying research in one transaction

**Files:**
- Modify: `src/lib/monsoon/details.ts` (extract a reusable core; behaviour of `applyDetails` unchanged)
- Create: `src/lib/monsoon/research-apply.ts`
- Modify: `src/app/api/monsoon/act/route.ts`, `src/lib/monsoon/no-delete.test.ts`
- Test: `src/lib/monsoon/research-apply.db.test.ts`, `src/app/api/monsoon/act/route.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces in `details.ts` (exported, used only inside a caller's transaction):

```ts
/** Locks the row, keeps the changes whose `from` still matches, writes them. No transaction, no log. */
export async function applyRowChanges(
  db: ClientBase,
  target: { type: "person" | "company"; id: string },
  changes: DetailChange[],
): Promise<{ found: boolean; name: string; orgId: string | null; written: DetailChange[]; skipped: DetailField[] }>;
export async function logMemberFor(db, row: { type: string; id: string; orgId: string | null }): Promise<string | null>; // now exported
export async function addToPipeline(db: ClientBase, personId: string, role: string): Promise<string>; // the INSERT INTO members used by applyOnce, returns member id
export function transaction<T>(...)  // now exported
```

  `applyOnce` is rewritten on top of these; every existing `details` test still passes unchanged.

- Produces in `research-apply.ts`:

```ts
export type ResearchApplyResult = {
  status: "saved" | "partly" | "unchanged" | "missing" | "unlogged";
  written: string[];  // labels, e.g. "Title"
  skipped: string[];  // labels
  name: string;
};
export async function applyResearch(
  db: ClientBase,
  proposal: Extract<Proposal, { kind: "apply_research" }>,
  ticked: string[],   // finding ids, validated by the route
  summary: string,    // trimmed, may be ""
): Promise<ResearchApplyResult>;
```

  One transaction (retry once on a `members` unique violation when `addsToPipeline !== null`, as `applyDetails` does): person findings via `applyRowChanges` on the person; the `website` finding via `applyRowChanges` on the company **only if the person's `org_id` still equals `proposal.company.id`** (otherwise it is skipped); the log member is the person's own, else their company's, else created with `addToPipeline` when `addsToPipeline !== null`, else status `unlogged` and rollback. Exactly one `system` touch in the format in Global Constraints: `Sources:` lists the sources of the written findings, then `summarySources` when a summary is saved, de-duplicated, in that order. When nothing was written and the summary is empty: `unchanged`, rollback. A saved summary with zero written findings is `saved`.

- `act` route: for `apply_research` read `b.ticked` (array of distinct strings, each the id of a signed finding; anything else → 400 `Invalid selection`) and `b.text` (string ≤ 2,000 after trim, else 400 `Summary is too long`); refuse 400 `Nothing selected` when `ticked` is empty and the text is empty; a non-empty text is refused 400 `Nothing selected` when `summarySources` is empty. Messages: `saved` → `Done. Research saved for <name>.`; `partly` → `Saved <written labels>. <skipped labels> changed in the meantime and was/were left alone.`; `unchanged` → `Nothing changed. <name> was already up to date.`; `missing` → `<name> is no longer on file; nothing changed.`; `unlogged` → `<name> is no longer on the pipeline, so the research could not be logged; nothing changed.`

- [ ] **Step 1: Write failing DB tests** (`research-apply.db.test.ts`, same harness as `details.db.test.ts`): ticking two of three findings writes only those two and one `system` touch whose text equals the exact expected string; an unticked finding's column is untouched; a finding whose `from` no longer matches is skipped and reported (`partly`); the company `website` finding updates `orgs.website`; it is skipped when the person has moved company; a person with no membership and a member company logs on the company's timeline; a person with no timeline anywhere is added to the pipeline with `addsToPipeline` and the touch lands there; summary only (no ticks) writes one touch and no field; nothing ticked and no summary is `unchanged` with zero new rows; a deleted person is `missing`; row counts of `people`, `orgs`, `touches` never decrease and no existing touch text changes.
- [ ] **Step 2: Write failing route tests** for the `ticked`/`text` validation and each message (mock `applyResearch`).
- [ ] **Step 3: Run both** — fail.
- [ ] **Step 4: Implement** the `details.ts` extraction, `research-apply.ts`, the route branch; extend `no-delete.test.ts` so `research-apply.ts` is scanned and contains no SQL `UPDATE` of its own (it must go through `applyRowChanges`).
- [ ] **Step 5: Run** `npx vitest run` (whole suite, serially if flaky), `npx tsc --noEmit` — pass.
- [ ] **Step 6: Commit** `feat(monsoon): apply research findings through the confirm route`.

### Task 3: The research engine and its guards (no database)

**Files:**
- Create: `src/lib/monsoon/research.ts`
- Test: `src/lib/monsoon/research.test.ts`

**Interfaces:**
- Consumes: `ResearchFinding`, `ResearchField` from Task 1.
- Produces:

```ts
export type ResearchSubject = {
  name: string;
  company: string | null;
  companyWebsite: string | null;
  title: string | null; email: string | null; phone: string | null; linkedin: string | null; country: string | null;
};
export const BLOCKED_DOMAINS: readonly string[]; // people-search and data-broker sites, see below
export const FREE_MAIL: readonly string[];       // gmail.com, googlemail.com, outlook.com, hotmail.com, live.com, yahoo.com, icloud.com, me.com, aol.com, proton.me, protonmail.com, qq.com, 163.com
/** Anchors beyond the name: company, a non-free-mail email domain, or a linkedin.com/in/ URL on file. */
export function anchorsOf(s: ResearchSubject): { company: string | null; emailDomain: string | null; linkedin: string | null };
export function hasAnchor(s: ResearchSubject): boolean;
export type RawResearch = {
  identity: "established" | "not_established";
  identity_reason: string;
  findings: { field: string; value: string; source_url: string }[];
  summary: string;
  summary_sources: string[];
};
export type Vetted =
  | { outcome: "findings"; identity: string; findings: Omit<ResearchFinding, "id">[]; summary: string; summarySources: string[] }
  | { outcome: "not_identified" }
  | { outcome: "nothing" };
/** Pure. `returned` is every URL the search tool returned in this run. */
export function vet(raw: RawResearch, returned: string[], subject: ResearchSubject): Vetted;
export type ResearchRun = { vetted: Vetted } | { failed: "timeout" | "refused" | "malformed" };
export async function runResearch(client: Anthropic, subject: ResearchSubject, opts?: { timeoutMs?: number }): Promise<ResearchRun>;
```

- `BLOCKED_DOMAINS` (exact list): `zoominfo.com, rocketreach.co, apollo.io, lusha.com, signalhire.com, contactout.com, datanyze.com, spokeo.com, whitepages.com, beenverified.com, truepeoplesearch.com, fastpeoplesearch.com, peoplefinders.com, intelius.com, radaris.com, mylife.com, pipl.com, peekyou.com, thatsthem.com, clustrmaps.com, nuwber.com, usphonebook.com, idcrawl.com, instantcheckmate.com, truthfinder.com, checkpeople.com, leadiq.com, seamless.ai, hunter.io, snov.io, facebook.com, instagram.com, tiktok.com`.
- `vet` rules, in order:
  1. `identity !== "established"` → `not_identified`.
  2. URL comparison is by normalised form: lower-case host without a leading `www.`, path without a trailing slash, no query, no fragment. A source counts only if its normalised form equals that of a URL in `returned`, its protocol is `https:`, and its host is not a blocked domain or a subdomain of one.
  3. Field mapping from the model: `title`, `linkedin_url`→`linkedin`, `country`, `company_website`→`website`, `work_email`→`email`, `work_phone`→`phone`; anything else is dropped. First occurrence of a field wins.
  4. Values are trimmed, internal whitespace collapsed, and dropped when empty, over 300 chars, or containing a line break before collapsing.
  5. `linkedin` must match `^https://([a-z]{2,3}\.)?linkedin\.com/in/[^/?#]+/?$` after trimming query and fragment; stored without a trailing slash.
  6. `website` must be an `https` URL; stored as origin only (`https://host`); dropped when its host is a blocked domain, `linkedin.com`, or a `FREE_MAIL` domain; target `company`; dropped when the subject has no company.
  7. `email` and `phone` are kept only when the source's host is the company website's host on file (or a subdomain), or the host of a surviving `website` finding. `email` must contain exactly one `@` and no spaces.
  8. `title` longer than 120 chars or containing `(` is dropped (a job title only, not a sentence).
  9. A finding equal to what is on file (trimmed, case-insensitive; LinkedIn and website compared in normalised URL form) is dropped.
  10. Summary: trimmed, at most 2,000 chars (longer is cut at the last sentence end before the limit); `summarySources` keeps only sources that pass rule 2, at most 6; a summary with no surviving source is dropped.
  11. No surviving finding and no summary → `nothing`. Otherwise `findings`, with `identity` = `identity_reason` trimmed and cut to 400 chars, `from` = the value on file or null.
- `runResearch`: one `client.messages.create` with `max_tokens: 4000`, the system instruction below, the tool from Global Constraints, `output_config: { format: { type: "json_schema", schema } }` for `RawResearch` (with `additionalProperties: false`), and request options `{ timeout: opts?.timeoutMs ?? 45_000, maxRetries: 0 }`. `returned` is collected from every `web_search_tool_result` block whose `content` is an array (an error object contributes nothing). `stop_reason` `refusal` → `refused`; `pause_turn` or `max_tokens` → `timeout`; an SDK timeout or connection error → `timeout`; JSON that does not parse or lacks the required keys → `malformed`. The last `text` block is the JSON.
- System instruction (exact rules; wording may be tightened, the rules may not be weakened): research one business contact for a CRM; first establish identity — treat a page as about this person only if it matches the name and at least one given anchor (company, email domain, LinkedIn URL); if identity is not established return no findings and say why; report only what a page returned by search states, no inference, no "likely"; professional information only — current job title (the title alone), LinkedIn profile URL, work country, company website, and a two-to-four sentence professional summary (role, focus, career; a city may be mentioned here); a work email or work phone only when published for this person on the employer's own website; never home address, personal phone or email, age, family, health, politics, religion, photos, or anything from people-search or data-broker sites; every finding names the URL of the page that states it; if sources conflict, leave the finding out. The user message carries only: name, company, company website, email domain, LinkedIn URL, and current title when on file.

- [ ] **Step 1: Write failing tests** with scripted model responses (a fake client whose `messages.create` returns fixed content blocks): a clean run yields the expected findings; a finding citing a URL not in `returned` is dropped; `www.`/trailing-slash/fragment differences still match; a blocked-domain source is dropped even when returned; a subdomain of a blocked domain is dropped; `not_established` yields `not_identified` even with findings present; a company-page LinkedIn URL and a `linkedin.com/pub/` URL are dropped; a title sentence with parentheses is dropped; an email sourced from the employer's site is kept and one sourced elsewhere is dropped; an unknown field (`home_address`, `age`) is dropped; a finding equal to the value on file (different case) is dropped; a summary whose only source is blocked is dropped; everything dropped yields `nothing`; a search-result error block contributes no URLs; `refusal`, `pause_turn`, a thrown timeout and malformed JSON map to the right `failed` value; the request carries the exact tool object, `maxRetries: 0`, and a model id; `MONSOON_RESEARCH_MODEL=claude-opus-5-5` throws; `hasAnchor` is false for name only and for a gmail address only, true for a company, a work email domain, or a LinkedIn `/in/` URL.
- [ ] **Step 2: Run** `npx vitest run src/lib/monsoon/research.test.ts` — fail.
- [ ] **Step 3: Implement** `research.ts`.
- [ ] **Step 4: Run** the file and `npx tsc --noEmit` — pass.
- [ ] **Step 5: Commit** `feat(monsoon): bounded web research with source guards`.

### Task 4: The research route

**Files:**
- Create: `src/lib/monsoon/research-subject.ts`, `src/app/api/monsoon/research/route.ts`
- Test: `src/lib/monsoon/research-subject.db.test.ts`, `src/app/api/monsoon/research/route.test.ts`
- Modify: `src/lib/monsoon/no-delete.test.ts` only if its file list is explicit

**Interfaces:**
- Consumes: `runResearch`, `vet` output, `hasAnchor`, `ResearchSubject` (Task 3); proposal type and `signProposal`, `PROPOSAL_TTL_MS` (Task 1); `logMemberFor` (Task 2).
- Produces:

```ts
export type SubjectRead =
  | { ok: true; subject: ResearchSubject; person: { id: string; name: string }; company: { id: string; name: string } | null; logMemberId: string | null }
  | { ok: false; reason: "missing" | "company" };
/** Read-only. memberId of a company member → "company". */
export function readSubject(db: ClientBase, target: { memberId?: string; personId?: string }): Promise<SubjectRead>;
```

- Route `POST /api/monsoon/research`, body `{ estate, memberId? , personId? }` (≤ 2 KB via `readJson`), `maxDuration = 60`, session first. Responses (all 200 unless stated):
  - `{ status: "findings", signed: SignedProposal, summary: string }` — the proposal carries `addsToPipeline: logMemberId === null ? <estate default role, as the propose route obtains it> : null`; finding ids are `f1`.. in order.
  - `{ status: "none", message }` with `Add a company or email first so I research the right person.` (no anchor; the model is not called), `Research works on a person. Open a person's profile.`, `I found several people with this name and can't tell which is yours.` (`not_identified`), `Nothing I'd trust. No changes suggested.` (`nothing`, `refused`, `malformed`), `Research took too long. Try again.` (`timeout`).
  - 400 unknown estate or no valid id; 404 `{ error: "No such contact." }`; 502 `Could not reach the <estate> CRM` when the read fails.
  - The database connection is used only for `readSubject` and is released before the model call. Nothing is written. One log line per run: `monsoon: research <outcome>` with no contact data.

- [ ] **Step 1: Write failing DB tests** for `readSubject`: a person member with a company; a person filed under a member company (log member is the company's); a person with no membership anywhere (`logMemberId` null); a company member id → `company`; an unknown id → `missing`; the read runs inside the read-only wrapper.
- [ ] **Step 2: Write failing route tests** (mock `readSubject`, `runResearch`, session): each response above; no anchor never calls `runResearch`; the returned proposal verifies with `verifyProposal`, has ids `f1..`, and `summary` is returned outside the signature; `addsToPipeline` set only when there is no log member; no session → 401; the DB callback has completed before `runResearch` starts.
- [ ] **Step 3: Run** — fail. **Step 4: Implement.** **Step 5: Run** the whole suite and `npx tsc --noEmit`, `npm run build` — pass.
- [ ] **Step 6: Commit** `feat(monsoon): research route returning a signed findings proposal`.

### Task 5: The findings card and the Research button

**Files:**
- Create: `src/components/monsoon/ResearchCard.tsx`
- Modify: `src/components/monsoon/api.ts`, `src/components/monsoon/useCardConfirm.ts`, `src/components/monsoon/ProfileActions.tsx` (and `ProfileView.tsx` / `ContactsPanel.tsx` only as needed to host it)
- Test: `src/components/monsoon/ResearchCard.test.tsx`, additions to `ProfileActions.test.tsx` (or the file that tests it), `useCardConfirm` tests, `api.test.ts`

**Interfaces:**
- Consumes: route responses (Task 4), act body `{ estate, proposal, signature, text, ticked }` (Task 2).
- Produces:
  - `api.ts`: `researchContact(body: { estate: string; memberId?: string; personId?: string }): Promise<ApiResult<ResearchResponse | { error: string } | null>>` with a 70-second timeout; `actOnCrm` body gains optional `ticked?: string[]`.
  - `useCardConfirm` options gain `extras?: (card: AskCard) => Record<string, unknown>` merged into the act body (the existing `add_note` text stays as is).
  - `ResearchCard` props: `{ signed, summary, roleLabel?, state, message?, onSave(ticked: string[], summary: string), onDiscard() }`.
- Behaviour:
  - `Research` sits with the profile's other actions, only on a person profile. Pressing it shows `Researching <name> at <company>...`, disables the other actions, and ignores a second press. Leaving the profile, changing estate or signing out drops a late result.
  - A `none` response shows its message in the profile's existing message style. A failed request shows `Could not run research. Check signal and try again.`; 401 goes to sign-in.
  - The card shows the title, the identity sentence, then one row per finding: a checkbox, `<Label>: <to>` when `from` is null or `<Label>: <from> → <to>` otherwise, and `source: <host>` as a link (`target="_blank" rel="noopener noreferrer"`). Rows that fill an empty field are ticked by default; rows that change an existing value are not. Then, when there are summary sources, the heading `Summary (added to the timeline)`, an editable text area (max 2,000) pre-filled with the summary, and `sources: N links` listing the links. When the proposal has `addsToPipeline`, the pipeline line.
  - `Save selected` is disabled when nothing is ticked and the summary is empty, and while saving. It confirms through `useCardConfirm` with `extras` → `{ ticked, text }`. On success the card shows the server message and the profile reloads; 403 shows the expired message; a failure leaves the card open with the save-failure message. `Discard` closes the card and sends nothing.
  - Labels come from `DETAIL_LABELS` (`linkedin` → `LinkedIn`, `website` → `Website`).

- [ ] **Step 1: Write failing tests:** default ticks; toggling; Save sends exactly the ticked ids and the edited summary; Save disabled with nothing selected; Discard sends nothing; source links have the right `href`, `target`, `rel`; the pipeline line appears only with `addsToPipeline`; busy text with and without a company; double press sends one request; `none` message shown; late result after leaving the profile is dropped; success reloads the profile; `Research` absent on a company profile.
- [ ] **Step 2: Run** — fail. **Step 3: Implement.** **Step 4:** `npx vitest run`, `npx tsc --noEmit`, `npm run build` — pass with no act() warnings.
- [ ] **Step 5: Commit** `feat(monsoon): Research button and findings card on a profile`.

### Task 6: The assistant offers research

**Files:**
- Modify: `src/lib/monsoon/ask/tools.ts`, `src/lib/monsoon/ask/loop.ts` (rules text and outcome plumbing), `src/components/monsoon/AskPanel.tsx`, `src/components/monsoon/MonsoonApp.tsx` (only to pass the open-and-research request to Contacts)
- Test: the existing test files beside each

**Interfaces:**
- Produces: tool `propose_research` with input `{ member_id?: string, person_id?: string }` (ids from earlier tool results, validated against refs as the other propose tools do). It does **not** search and does not touch the network: it resolves the person (read-only), and returns `{ offered: true }` plus an outcome field `research: { personId: string; name: string; company: string | null }`; for a company or unknown id it returns a plain refusal the model can relay. The ask response carries `research` alongside `proposal`. `AskPanel` renders a small card `Research: <name>` with one button `Run research`, which switches to Contacts, opens that person's profile and starts research there (same code path as Task 5's button). The assistant's rules gain: offer research only when the user asks for it; never state facts about a person from your own knowledge, only from the CRM or saved research.

- [ ] **Step 1: Write failing tests:** the tool returns the offer for a person ref and a refusal for a company; it makes no model or network call; the loop passes `research` through; AskPanel shows the card and `Run research` calls the open-and-research handler once; MonsoonApp switches to Contacts with that person and research starting.
- [ ] **Step 2: Run** — fail. **Step 3: Implement.** **Step 4:** whole suite, `tsc`, build — pass.
- [ ] **Step 5: Commit** `feat(monsoon): the assistant can offer research on a contact`.

---

**Left out on purpose (design 5.5 item 7, "may show"):** the one-line research offer after saving a sparse new contact. The profile button covers it; add later if wanted.
