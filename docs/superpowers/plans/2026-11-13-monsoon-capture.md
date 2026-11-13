# Monsoon Capture App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A passcode-locked home-screen web app at `quantcloud.com/monsoon` that photographs a business card or name badge and saves the person into the Traxo or Zero One Monsoon CRM.

**Architecture:** A client page under `src/app/monsoon` talks to four server routes under `src/app/api/monsoon` (session, estates, read, save). `read` sends the photo to Claude Haiku and returns fields; `save` runs a TypeScript port of the Python core's capture transaction directly against the chosen estate's Supabase Postgres. The ported matching rules are pinned to the Python originals by a generated fixture file.

**Tech Stack:** Next.js 15 app router, React 19, Tailwind 3, Vitest 2, `pg` (node-postgres), `@anthropic-ai/sdk`, Postgres 16 in Docker for tests.

**Spec:** `docs/superpowers/specs/2026-11-13-monsoon-capture-design.md`. Read it first; this plan argues from it.

## Global Constraints

- Repo: `C:\Dev\Quantcloud\QCwebsite`. Work on branch `monsoon-capture` in a worktree under `.worktrees/`. The spec and this plan are untracked in the main checkout: the branch's first commit adds both.
- Estates are exactly two: key `traxo` (label "Traxo", env `TRAXO_CRM_DATABASE_URL`, default role `lp_prospect`) and key `zeroone` (label "Zero One", env `ZEROONE_CRM_DATABASE_URL`, default role `investor`).
- `source` on created orgs, people and members, and `channel` on captures rows, is the literal `monsoon-app`. Owner and `by_whom` are the literal `VF`.
- No schema change to either CRM database. No new hosted service.
- Model: default `claude-haiku-5-5`; `MONSOON_MODEL` may override; an id matching `/opus|fable/i` is refused.
- `MONSOON_PASSCODE` must be at least 16 characters; `MONSOON_SESSION_SECRET` at least 32. Session lasts 180 days (15552000 seconds).
- Do not change `next.config.ts` (the `camera=()` header stays). The camera is opened with a file input only.
- The photo is never written to disk, a database or a log.
- Every `/api/monsoon/*` handler except `POST session` returns 401 `{ "error": "unauthorized" }` before any other work when the session cookie is missing or invalid.
- All monsoon routes declare `export const runtime = "nodejs"` and `export const dynamic = "force-dynamic"`.
- Never read, print or commit real connection strings, the passcode or the API key. Tests use stubbed env values and the local test database only.
- Existing conventions: Vitest with `globals: true`, node environment by default, `// @vitest-environment jsdom` docblock for component tests, `@/` alias for `src/`, route tests beside routes as `route.test.ts`.
- Deviations from the spec, decided here: the fixture generator lives in this repo (`scripts/monsoon/`), not in the core, so the core repo is untouched; there is no `use_org` parameter, because picking an existing company just re-saves with that name in `org`.

## Review Focus

1. **Double tap or retry of Save** with the same `capture_id`: exactly one captures row and one touch. (Task 2 test `repeat capture_id writes nothing`, plus Task 6 `disables Save while saving`.)
2. **Session expires mid-use**: a 401 on save shows the passcode screen and the typed fields are still there after signing in again. (Task 6 test `keeps the form across a 401`.)
3. **Photo with nothing legible** (blank badge, blurry shot, not a card): every field comes back empty, no error, the form is usable by hand. (Task 5 test `returns empty fields when the model finds nothing`.)
4. **Name typed with odd case or spacing** (`"  jane   TAN "`): matches the existing Jane Tan rather than adding a twin. (Task 2 test `matches names regardless of case and spacing`.)
5. **One estate's database unreachable**: the other estate still loads and saves; the broken one is shown as unavailable. (Task 4 test `one estate down does not hide the other`.)

---

### Task 1: Matching rules port with Python parity fixtures

**Files:**
- Create: `scripts/monsoon/gen_rule_fixtures.py`
- Create: `src/lib/monsoon/rules.fixtures.json` (generated, committed)
- Create: `src/lib/monsoon/testing/0001_init.sql` (copied by the script, committed)
- Create: `src/lib/monsoon/rules.ts`
- Test: `src/lib/monsoon/rules.test.ts`

**Interfaces:**
- Consumes: the installed Python core (`py -3.13 -c "import quantcloud.crm.rules"` works on this machine); source at `C:\Dev\Quantcloud\core\quantcloud\crm\rules.py`.
- Produces, from `rules.ts`:
  - `nameKey(name: string): string`
  - `isEmpty(value: unknown): boolean`
  - `mergeFillEmpty(existing: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown>`
  - `orgNameCores(name: string): string[]`
  - `sequenceRatio(a: string, b: string): number`
  - `similarOrgNames(name: string, existing: string[]): string[]`

- [ ] **Step 1: Write `scripts/monsoon/gen_rule_fixtures.py`**

It imports `quantcloud.crm.rules` and `difflib.SequenceMatcher`, runs the cases below, and writes `src/lib/monsoon/rules.fixtures.json` as
`{"name_key": [{"in", "out"}], "merge_fill_empty": [{"existing", "incoming", "out"}], "org_name_cores": [{"in", "out"}], "ratio": [{"a", "b", "out"}], "similar_org_names": [{"name", "existing", "out"}]}`.
It also copies `quantcloud/crm/schema/0001_init.sql` (located via `importlib.resources`) to `src/lib/monsoon/testing/0001_init.sql` with a first-line comment `-- Copied from quantcloud core by scripts/monsoon/gen_rule_fixtures.py. Do not edit.`

Cases:
- `name_key`: `"Jane Tan"`, `"  jane   TAN "`, `"Jane\tTan"`, `"JANE\u00a0TAN"`, `"José Álvarez"`, `""`.
- `merge_fill_empty`: existing `{"id": "1", "name": "A", "email": None, "phone": " ", "title": "CEO"}` with incoming `{"name": "B", "email": "a@b.co", "phone": "123", "title": "CFO", "linkedin_url": ""}`; and one where incoming is `{}`.
- `org_name_cores`: `"Meridian Harbour Asset Management (MHAM)"`, `"Northwind Capital"`, `"The Capital Group"`, `"Acme Capital Pte. Ltd."`, `"A&B Partners"`, `"(X)"`, `""`.
- `ratio`: `("brightwater famly", "brightwater family")`, `("corvane", "corvine")`, `("abcdef", "abcdxy")`, `("", "")`, `("abc", "")`, `("northwind", "northwind")`, `("alpha beta", "beta alpha")`.
- `similar_org_names`, all against `existing = ["Meridian Harbour Asset Management (MHAM)", "Northwind Capital", "Corvane", "Brightwater Family Office", "Acme Capital Pte Ltd", "Acme Capital Partners Asia"]`: names `"MHAM"`, `"Northwind Capital Management"`, `"Brightwater Famly Office"`, `"Corvane"`, `"Pinecrest Holdings"`, `"Acme Capital"`, `"acme capital pte ltd"`, `"Corvine"`, `"Corvanne"`, `"Acme"`, `"North"`.

- [ ] **Step 2: Run it**

Run: `py -3.13 scripts/monsoon/gen_rule_fixtures.py`
Expected: both files exist; the JSON has the five keys; `similar_org_names` for `"Acme Capital"` lists more than one name (this is the multi-lookalike case later tasks rely on; if it does not, add a case that does and note its name for Task 2).

- [ ] **Step 3: Write the failing test `rules.test.ts`**

One `describe` per fixture key; each iterates the fixture cases with `it.each` and asserts `toEqual(case.out)`. For `ratio` assert `toBeCloseTo(case.out, 12)`. Add one hand-written test:

```ts
it("treats the 0.85 threshold as inclusive, behind a six-character minimum", () => {
  expect(similarOrgNames("Corvanne", ["Corvane"])).toEqual(["Corvane"]);
  expect(similarOrgNames("Abcde", ["Abcdf"])).toEqual([]); // cores shorter than six
});
```

(If the generated fixture shows `"Corvanne"` is not similar to `"Corvane"`, replace the first line with a pair the fixture proves is.)

- [ ] **Step 4: Run to see it fail**

Run: `npx vitest run src/lib/monsoon/rules.test.ts`
Expected: FAIL, cannot resolve `./rules`.

- [ ] **Step 5: Implement `rules.ts`**

Port `name_key`, `_is_empty`, `merge_fill_empty` (protected keys `id, name, name_key, org_id, source, external_ref, created_at`), `ORG_STOPWORDS`, `org_name_cores` and `similar_org_names` line for line from `rules.py`. `sequenceRatio` reproduces `difflib.SequenceMatcher(None, a, b).ratio()` without the autojunk heuristic (it only applies to strings of 200+ characters): recursively take the longest common contiguous block (on ties the earliest start in `a`, then the earliest in `b`), recurse on the pieces left and right of it, sum the block lengths as `M`, return `2*M/(a.length+b.length)`, or `1` when both are empty.

- [ ] **Step 6: Run to see it pass**

Run: `npx vitest run src/lib/monsoon/rules.test.ts`
Expected: PASS, every fixture case.

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers scripts/monsoon src/lib/monsoon
git commit -m "feat(monsoon): port CRM matching rules with Python parity fixtures"
```

---

### Task 2: Capture transaction against a real Postgres

**Files:**
- Modify: `package.json` (add dependency `pg`, devDependency `@types/pg`)
- Create: `src/lib/monsoon/testing/db.ts`
- Create: `src/lib/monsoon/capture.ts`
- Test: `src/lib/monsoon/capture.db.test.ts`

**Interfaces:**
- Consumes: `nameKey`, `mergeFillEmpty`, `similarOrgNames` from Task 1; `testing/0001_init.sql`.
- Produces, from `capture.ts`:

```ts
import type { ClientBase } from "pg";

export type CaptureInput = {
  captureId: string;              // UUID
  name: string;
  role: string;
  org?: string;
  title?: string;
  email?: string;
  phone?: string;
  linkedin?: string;
  notes?: string;
  rawText?: string;
  extracted?: unknown;            // reader's original output
  newOrg?: boolean;
  samePerson?: string | false;    // person id, or false = a different person
};

export type CaptureResult =
  | { outcome: "added"; person: string; org: string | null; role: string; filled: string[] }
  | { outcome: "existing"; person: string; org: string | null; role: string; filled: string[] }
  | { outcome: "duplicate"; person: string; org: string | null }
  | { outcome: "org_lookalike"; similar: string[] }
  | { outcome: "same_name"; matches: { personId: string; org: string | null }[] }
  | { outcome: "ambiguous"; orgs: (string | null)[] }
  | { outcome: "invalid"; error: string };

export async function capture(db: ClientBase, input: CaptureInput): Promise<CaptureResult>;
```

  `capture` runs its own `BEGIN`/`COMMIT` on `db` and rolls back on any thrown error and on every non-writing outcome (`org_lookalike`, `same_name`, `ambiguous`, `invalid`, `duplicate`). In `added`/`existing`, `role` is the role on the member row and `filled` is the list of person columns that were filled (`title`, `email`, `phone`, `linkedin_url`).
- Produces, from `testing/db.ts`: `testDb: { available: boolean; reason: string; connect(): Promise<Client>; reset(): Promise<void> }`.

- [ ] **Step 1: Install and write the test harness `testing/db.ts`**

Run: `npm install pg && npm install -D @types/pg`

`testDb` uses admin URL `process.env.MONSOON_TEST_DB ?? "postgresql://postgres:test@127.0.0.1:55433/postgres"`. On first use it creates database `monsoon_test` if absent, and refuses to proceed unless the target database name contains `test`. `reset()` drops and recreates schema `public` in `monsoon_test`, loads `0001_init.sql`, and seeds: stages `uncontacted`(ord 0), `contacted`(1), `engaged`(2), `client`(3, terminal), `passed`(4, terminal); roles `investor`, `introducer`; owner `VF`. `available` is false with a `reason` when the server cannot be reached. Start the server once with:

```bash
docker run -d --name monsoon-test -e POSTGRES_PASSWORD=test -p 55433:5432 postgres:16-alpine
```

- [ ] **Step 2: Write the failing tests `capture.db.test.ts`**

`describe.skipIf(!testDb.available)`, `beforeEach(() => testDb.reset())`. A helper `input(over)` returns `{ captureId: randomUUID(), name: "Jane Tan", role: "investor", ...over }`. Tests and their assertions:

- `adds a new person, org, member, capture row and meeting touch`: with `org: "Acme Capital", email: "jane@acme.com", notes: "met at SFF"` → outcome `added`, `org: "Acme Capital"`; one row each in `orgs`, `people`, `members`, `captures`, `touches`; member has `person_id` set, `org_id` null, `stage = 'uncontacted'`, `owner = 'VF'`, `source = 'monsoon-app'`, `notes = 'met at SFF'`; capture row has `channel = 'monsoon-app'`, `status = 'written'`, `image_ref` null, `person_id` and `org_id` set; touch has `kind = 'meeting'`, `by_whom = 'VF'`, `summary = 'Card captured in person: met at SFF'`.
- `touch summary without notes is exactly "Card captured in person"`.
- `stores rawText and extracted on the capture row`.
- `existing person at the same org: fills only empty fields, leaves the member alone`: first save with `email`, role `investor`; second save (new `captureId`) with a different `email`, a `phone`, role `introducer` → outcome `existing`, `role: "investor"`, `filled: ["phone"]`; email unchanged; still one member; two touches.
- `matches names regardless of case and spacing`: second save with `name: "  jane   TAN "` and the same org → `existing`, one `people` row.
- `lookalike org is refused, then accepted with newOrg`: seed org via a first save with `org: "Northwind Capital"`, then save a different name with `org: "Northwind Capital Management"` → `org_lookalike`, `similar: ["Northwind Capital"]`, and no new rows of any kind; re-save with `newOrg: true` → `added`, two orgs.
- `lookalike org resolved by re-saving with the existing name` → `added`, one org.
- `several lookalikes are all returned`: seed `"Acme Capital Pte Ltd"` and `"Acme Capital Partners Asia"`, save `org: "Acme Capital"` → `similar` has both, in name order.
- `same name under another company asks first`: Jane Tan exists at `Acme Capital`; save Jane Tan with `org: "Borealis Partners"` → `same_name`, `matches: [{ personId, org: "Acme Capital" }]`, no new rows.
- `same person keeps the company on file and notes the card's company`: re-save with `samePerson: personId, phone: "123"` → `existing`, `org: "Acme Capital"`, `filled: ["phone"]`; no `Borealis Partners` org row; newest touch summary is `Card captured in person (card shows Borealis Partners)`.
- `different person creates a second one`: re-save with `samePerson: false` → `added`, two `people` rows, `org: "Borealis Partners"`.
- `samePerson naming a person who is not a match is invalid`.
- `no company, one match: reused`; `no company, no match: orgless person added` (`org: null`); `no company, several matches: ambiguous` with `orgs` listing the companies.
- `unknown role is invalid and writes nothing`; `blank name is invalid`; `captureId that is not a UUID is invalid`.
- `repeat capture_id writes nothing`: same `input` twice → second outcome `duplicate` with the same person; one captures row, one touch.
- `two concurrent saves of one capture_id write once`: two clients, `Promise.all` of the same input → outcomes are one `added` and one `duplicate`; one captures row, one touch.
- `a thrown error rolls everything back`: delete owner `VF` before saving (the member insert then violates its foreign key) → `capture` rejects, and `orgs`, `people` and `members` are all empty.

- [ ] **Step 3: Run to see them fail**

Run: `npx vitest run src/lib/monsoon/capture.db.test.ts`
Expected: FAIL, cannot resolve `./capture`. (If it reports skipped, the Docker container is not up.)

- [ ] **Step 4: Implement `capture.ts`**

Follow spec section 6.4 steps 1 to 7 in that order, mirroring `Crm.capture`, `find_or_create_org`, `find_or_create_person`, `add_member` and `find_member` in `C:\Dev\Quantcloud\core\quantcloud\crm\db.py`. Decisions the spec and tests do not fix:
- Validate first, before `BEGIN`: trimmed `name` non-empty; `captureId` matches the UUID pattern. Empty-string optional fields are treated as absent.
- Lock: `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))` with the `captureId`.
- Same-name check (step 3) runs only when `org` is given, and only when no person with that `name_key` already sits at the org whose `name_key` equals the typed org. It runs before the lookalike guard.
- Person lookups order by `created_at, id`. Lookalike results are sorted by name.
- Touch summary: `"Card captured in person"`, then `": " + notes` when notes are present, then `" (card shows " + org + ")"` when step 3 reused a person whose company on file differs from the typed one.
- All SQL is parameterised and uses unnamed statements only (the production pooler is transaction-mode).

- [ ] **Step 5: Run to see them pass**

Run: `npx vitest run src/lib/monsoon/capture.db.test.ts`
Expected: PASS, none skipped.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/lib/monsoon
git commit -m "feat(monsoon): capture transaction ported from the CRM core"
```

---

### Task 3: Passcode session

**Files:**
- Create: `src/lib/monsoon/auth.ts`
- Create: `src/app/api/monsoon/session/route.ts`
- Test: `src/lib/monsoon/auth.test.ts`, `src/app/api/monsoon/session/route.test.ts`
- Modify: `.env.example` (add the six names from spec 6.5, no values)

**Interfaces:**
- Produces, from `auth.ts`:
  - `SESSION_COOKIE = "monsoon_session"`, `SESSION_SECONDS = 15552000`
  - `authConfigured(): boolean` (passcode ≥ 16 chars and secret ≥ 32 chars)
  - `checkPasscode(candidate: string): boolean` (constant time: compare SHA-256 digests with `timingSafeEqual`)
  - `signSession(nowMs?: number): string` → `v1.<expiryEpochSeconds>.<hex HMAC-SHA256 of "v1.<expiry>" under MONSOON_SESSION_SECRET>`
  - `verifySession(token: string | undefined, nowMs?: number): boolean`
  - `requireSession(request: Request): Response | null` → `null` when valid, else a 401 JSON response `{ error: "unauthorized" }`
- `POST /api/monsoon/session` body `{ passcode: string }`: 200 `{ ok: true }` with `Set-Cookie: monsoon_session=…; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=15552000`; wrong passcode waits 1000 ms then 401 `{ error: "Wrong passcode" }`; not configured → 500 `{ error: "Monsoon is not configured" }`; bad JSON → 400.
- `DELETE /api/monsoon/session`: 200, cookie cleared with `Max-Age=0`.

- [ ] **Step 1: Write the failing tests**

`auth.test.ts` (env stubbed with `vi.stubEnv`: passcode `correct-horse-battery-staple`, secret 32 `x`):
- `verifySession(signSession(now), now)` is true; false at `now + SESSION_SECONDS*1000 + 1000`; false for a token with one character of the signature changed; false for a token whose expiry was edited upward; false for `undefined`, `""`, `"v1.abc"`; false when signed under a different secret.
- `checkPasscode` true for the exact passcode, false for a prefix, a longer string and `""`.
- `authConfigured()` false when the passcode is 15 characters or the secret is 31.
- `requireSession` returns `null` for a request with a valid cookie among other cookies, and a 401 response otherwise.

`route.test.ts` (fake timers for the delay): correct passcode → 200 and a `Set-Cookie` containing `HttpOnly`, `Secure`, `SameSite=Strict`, `Max-Age=15552000`, `Path=/`; wrong passcode → 401, no `Set-Cookie`, and the response does not resolve before 1000 ms have elapsed; passcode of 15 chars configured → 500; `DELETE` → `Max-Age=0`.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run src/lib/monsoon/auth.test.ts src/app/api/monsoon/session`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `auth.ts` and the session route** using `node:crypto` only.

- [ ] **Step 4: Run to see them pass**

Run: same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/monsoon/auth.ts src/lib/monsoon/auth.test.ts src/app/api/monsoon/session .env.example
git commit -m "feat(monsoon): passcode session"
```

---

### Task 4: Estates and the save route

**Files:**
- Create: `src/lib/monsoon/estates.ts`
- Create: `src/lib/monsoon/db.ts`
- Create: `src/app/api/monsoon/estates/route.ts`
- Create: `src/app/api/monsoon/save/route.ts`
- Test: `src/lib/monsoon/db.test.ts`, `src/app/api/monsoon/estates/route.test.ts`, `src/app/api/monsoon/save/route.test.ts`

**Interfaces:**
- Consumes: `requireSession` (Task 3); `capture`, `CaptureInput`, `CaptureResult` (Task 2).
- Produces, from `estates.ts`:
  - `type EstateKey = "traxo" | "zeroone"`
  - `ESTATES: readonly { key: EstateKey; label: string; dbEnv: string; defaultRole: string }[]` (values in Global Constraints, Traxo first)
  - `estateByKey(key: unknown): (typeof ESTATES)[number] | undefined`
- Produces, from `db.ts`:
  - `clientConfig(url: string): import("pg").ClientConfig`: removes any `sslmode` query parameter; for any host other than `localhost`, `127.0.0.1` or `::1` sets `ssl: { rejectUnauthorized: true }`, adding `ca: process.env.MONSOON_DB_CA_CERT` (a PEM string) when that variable is set. Certificate verification is never turned off. `connectionTimeoutMillis: 8000`, `statement_timeout: 10000`.
  - `withEstateDb<T>(estate: (typeof ESTATES)[number], fn: (db: import("pg").Client) => Promise<T>): Promise<T>`: one `Client` per call, always ended; throws `Error("<dbEnv> is not set")` when the env var is empty.
- `GET /api/monsoon/estates` → 200 `{ estates: [{ key, label, defaultRole, available: boolean, roles: [{ key, label }] }] }`, roles from `SELECT key, label FROM roles ORDER BY key`; an estate whose database fails has `available: false, roles: []`. The two estates are queried in parallel.
- `POST /api/monsoon/save` body `{ estate, captureId, role, fields: { name, title?, org?, email?, phone?, linkedin?, notes? }, extracted?, newOrg?, samePerson? }`:
  - 200 with the `CaptureResult` for every outcome except `invalid`;
  - 400 `{ outcome: "invalid", error }` for `invalid`, for an unknown estate (`error: "Unknown estate"`) and for malformed JSON;
  - 502 `{ error: "Could not reach the <label> CRM" }` when the database call throws. The thrown error is logged with `console.error` without the connection string.
  - `rawText` passed to `capture` is `extracted.raw_text` when it is a string.
  - `export const maxDuration = 30`.

- [ ] **Step 1: Write the failing tests**

`db.test.ts`: `clientConfig("postgresql://u:p@db.example.com:6543/postgres?sslmode=require")` has `ssl.rejectUnauthorized === true`, no `ssl.ca`, and a connection string without `sslmode`; with `MONSOON_DB_CA_CERT` stubbed to a PEM string, `ssl.ca` equals it; `clientConfig("postgresql://u:p@127.0.0.1:55433/x")` has no `ssl`; `withEstateDb` rejects with `TRAXO_CRM_DATABASE_URL is not set` when the env is empty.

`estates/route.test.ts` (mock `@/lib/monsoon/db` with `vi.mock`):
- no cookie → 401 and `withEstateDb` not called;
- both up → two estates in order `traxo`, `zeroone`, with `defaultRole` `lp_prospect` and `investor` and the mocked roles;
- `one estate down does not hide the other`: the mock rejects for `traxo` → 200, `traxo.available === false`, `zeroone.available === true` with its roles.

`save/route.test.ts` (mock `@/lib/monsoon/db` to call `fn` with a fake client and mock `@/lib/monsoon/capture`):
- no cookie → 401, `capture` not called;
- unknown estate `"qforce"` → 400;
- a valid body calls `capture` once with `{ captureId, name, role, org, title, email, phone, linkedin, notes, rawText, extracted, newOrg, samePerson }` mapped from the body, and returns its result with 200;
- `capture` resolving `{ outcome: "invalid", error: "x" }` → 400;
- `capture` resolving `org_lookalike` → 200 with that body;
- `withEstateDb` rejecting → 502 `{ error: "Could not reach the Zero One CRM" }` for estate `zeroone`.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run src/lib/monsoon/db.test.ts src/app/api/monsoon/estates src/app/api/monsoon/save`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `estates.ts`, `db.ts` and the two routes.**

- [ ] **Step 4: Run to see them pass**

Run: same command, then `npx vitest run` for the whole suite.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/monsoon src/app/api/monsoon
git commit -m "feat(monsoon): estates and save routes"
```

---

### Task 5: Reading the photo

**Files:**
- Modify: `package.json` (add `@anthropic-ai/sdk`)
- Create: `src/lib/monsoon/extract.ts`
- Create: `src/app/api/monsoon/read/route.ts`
- Test: `src/lib/monsoon/extract.test.ts`, `src/app/api/monsoon/read/route.test.ts`

**Interfaces:**
- Consumes: `requireSession` (Task 3).
- Produces, from `extract.ts`:
  - `type CardFields = { name: string; title: string; org: string; email: string; phone: string; linkedin: string; raw_text: string }` (always all seven keys, trimmed, `""` when absent)
  - `resolveModel(): string` → `process.env.MONSOON_MODEL || "claude-haiku-5-5"`; throws `Error("MONSOON_MODEL must not be an Opus or Fable model")` when the id matches `/opus|fable/i`
  - `extractCard(image: { base64: string; mediaType: "image/jpeg" | "image/png" | "image/webp" }): Promise<CardFields>`
- `POST /api/monsoon/read`: `multipart/form-data` with one file field `image`. 200 `{ fields: CardFields }`; 400 when the field is missing; 415 when the type is not jpeg, png or webp; 413 when the file is over 4,000,000 bytes; 502 `{ error: "Could not read the photo" }` when `extractCard` throws. `export const maxDuration = 30`.

- [ ] **Step 1: Load the `claude-api` skill** and confirm the current TypeScript SDK shape for a message with a base64 image block and a forced tool call. Use what it says over this plan if they differ.

- [ ] **Step 2: Write the failing tests**

`extract.test.ts` (mock `@anthropic-ai/sdk` so `messages.create` is a `vi.fn`):
- `resolveModel()` is `claude-haiku-5-5` by default, returns an override such as `claude-sonnet-5-5`, and throws for `claude-opus-5-5`, `claude-fable-5-2` and `CLAUDE-OPUS-X`;
- `extractCard` calls `messages.create` once with `model: "claude-haiku-5-5"`, an image content block carrying the given base64 and media type, a single tool named `record_card` whose input schema has exactly the seven `CardFields` keys as strings, and a tool choice forcing `record_card`;
- a tool-use response of `{ name: " Jane Tan ", org: "Acme" }` returns `{ name: "Jane Tan", title: "", org: "Acme", email: "", phone: "", linkedin: "", raw_text: "" }`;
- `returns empty fields when the model finds nothing`: a tool-use response of `{}` returns all seven keys as `""`, and so does a response with no tool-use block;
- non-string values in the tool input (a number, `null`) become `""`.

`read/route.test.ts` (mock `@/lib/monsoon/extract`): no cookie → 401 and `extractCard` not called; missing field → 400; `text/plain` file → 415; 4,000,001-byte jpeg → 413; a small jpeg → 200 with the mocked fields and `extractCard` called with the file's base64 and `image/jpeg`; `extractCard` rejecting → 502.

- [ ] **Step 3: Run to see them fail**

Run: `npm install @anthropic-ai/sdk && npx vitest run src/lib/monsoon/extract.test.ts src/app/api/monsoon/read`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement `extract.ts` and the route**

`max_tokens: 1024`. System instruction, verbatim:

> You read one photo of a business card or conference name badge. Call record_card once. Copy each value exactly as printed. If a value is not printed on the card, leave that field as an empty string; never guess or infer one. `name` is the person's name only. `org` is the company or organisation. `linkedin` is a LinkedIn URL or handle if printed. `raw_text` is all legible text on the card, line by line. If the photo is not a card or badge, or nothing is legible, return every field empty.

- [ ] **Step 5: Run to see them pass**

Run: `npx vitest run src/lib/monsoon/extract.test.ts src/app/api/monsoon/read`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/lib/monsoon/extract.ts src/lib/monsoon/extract.test.ts src/app/api/monsoon/read
git commit -m "feat(monsoon): read a card photo with Claude Haiku"
```

---

### Task 6: The screen

**Files:**
- Create: `src/app/monsoon/layout.tsx`, `src/app/monsoon/page.tsx`
- Create: `src/components/monsoon/MonsoonApp.tsx`, `src/components/monsoon/api.ts`, `src/components/monsoon/image.ts`
- Create: `public/monsoon/manifest.webmanifest`, `public/monsoon/icon-192.png`, `public/monsoon/icon-512.png`, `public/monsoon/apple-touch-icon.png` (180 px)
- Test: `src/components/monsoon/MonsoonApp.test.tsx`

**Interfaces:**
- Consumes: the four routes' request and response shapes (Tasks 3 to 5); `CaptureResult` and `CardFields` as types only.
- Produces: `api.ts` exports `signIn(passcode)`, `loadEstates()`, `readCard(blob)`, `saveCard(body)`; each returns `{ status: number; body: … }` and never throws on a non-2xx status. `image.ts` exports `downsizeImage(file: File, maxSide = 1600, quality = 0.8): Promise<Blob>` (decode with `createImageBitmap(file, { imageOrientation: "from-image" })`, draw to a canvas scaled so the longest side is at most `maxSide`, export `image/jpeg`).

Fixed behaviour and copy:
- `layout.tsx` metadata: title `Monsoon`; `robots: { index: false, follow: false }`; `manifest: "/monsoon/manifest.webmanifest"`; `appleWebApp: { capable: true, title: "Monsoon", statusBarStyle: "default" }`; `icons.apple: "/monsoon/apple-touch-icon.png"`. Viewport: `width=device-width, initialScale: 1, viewportFit: "cover"`. Manifest: `name` and `short_name` `Monsoon`, `start_url` and `scope` `/monsoon`, `display: "standalone"`, the two icons.
- Inputs use a font size of at least 16 px (smaller makes iOS zoom on focus). Touch targets at least 44 px tall. No marketing header or footer.
- Photo button: a `<label>` wrapping `<input type="file" accept="image/*" capture="environment" hidden>`, text `Take photo`.
- Estate choice is stored in `localStorage` under `monsoon.estate`; first run defaults to `traxo`. An unavailable estate's button is disabled and reads `<label> (unavailable)`.
- `captureId` is a fresh `crypto.randomUUID()` when a photo is chosen, and when Save is pressed on a hand-typed form that has none. It is kept across lookalike / same-name re-saves and replaced after a successful save.
- Changing estate keeps the fields and sets Role to that estate's `defaultRole`.
- Save is disabled while a request is in flight and while Name is empty.
- Messages (exact; `E` = estate label, `R` = role label):
  - added: `<name> added to E.`
  - existing with fills: `<name> is already in E as R; filled in <comma-separated fields>.`
  - existing, nothing new: `<name> is already in E as R; nothing new.`
  - duplicate: `<name> saved to E.`
  - org lookalike: `<org> looks like a company already on file.` then one button per similar name (`Use <similar>`) and `It's a different company`.
  - same name: `<name> is already on file at <org or "no company">. Same person?` then one `Same person (<org>)` button per match and `Different person`.
  - ambiguous: `Several people are named <name>. Add the company to say which one.`
  - read failure: `Could not read the photo. Try again or type the details.`
  - save failure (502 or network): `Could not save. Check signal and try again.` with the fields kept.
- After `added`, `existing` or `duplicate` the form clears and the message stays visible until the next photo.

- [ ] **Step 1: Write the failing tests `MonsoonApp.test.tsx`**

`// @vitest-environment jsdom`; mock `./api` and `./image` (`downsizeImage` resolves a small Blob). Use `@testing-library/user-event`.
- `shows the passcode screen when estates returns 401, then the app after sign-in`.
- `wrong passcode shows "Wrong passcode"`.
- `remembers the estate`: `localStorage` has `zeroone` → Zero One is selected and Role shows `investor`.
- `unavailable estate is disabled`.
- `fills the form from a photo`: uploading a file calls `readCard`, then Name/Org/Email inputs hold the returned values.
- `read failure keeps the form usable`: `readCard` → 502 → the read-failure message; typing a name enables Save.
- `saves and clears`: Save calls `saveCard` with `{ estate: "traxo", role: "lp_prospect", captureId: <uuid>, fields: {…}, extracted: <reader output> }`; on `added` the message `Jane Tan added to Traxo.` shows and Name is empty.
- `disables Save while saving`: with `saveCard` pending, the button is disabled and a second click does not call `saveCard` again.
- `org lookalike: choosing an existing company re-saves with that name and the same captureId`.
- `org lookalike: "It's a different company" re-saves with newOrg true`.
- `same name: "Same person" re-saves with samePerson = that personId; "Different person" with samePerson false`.
- `changing estate keeps fields and resets role`.
- `keeps the form across a 401`: `saveCard` → 401 → passcode screen; after `signIn` succeeds the Name input still holds `Jane Tan`.
- `save failure keeps the fields and shows the save-failure message`.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run src/components/monsoon`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `api.ts`, `image.ts`, `MonsoonApp.tsx`, `page.tsx`, `layout.tsx`, the manifest and the icons**

`page.tsx` renders `<MonsoonApp />` only. Icons: the Quantcloud mark from `Quantcloud Logo Blue.png` (repo root, untracked in the main checkout; copy it in) centred on a solid background at 192, 512 and 180 px; any tool will do. Visual design is yours within the constraints above: it should feel like an app, one column, thumb-reachable Save.

- [ ] **Step 4: Run to see them pass, then the full checks**

Run: `npx vitest run && npm run lint && npm run build`
Expected: all tests pass, lint clean, build succeeds with `/monsoon` and the four `/api/monsoon/*` routes listed.

- [ ] **Step 5: Try it locally end to end against the test database**

Create `.env.local` (git-ignored; confirm with `git check-ignore .env.local`) with `TRAXO_CRM_DATABASE_URL` and `ZEROONE_CRM_DATABASE_URL` both pointing at two throwaway databases on the Docker server (load `0001_init.sql` and seed roles `lp_prospect`, `introducer` in one and `investor`, `issuer`, `introducer`, `reader` in the other), a 16+ character `MONSOON_PASSCODE`, a 32+ character `MONSOON_SESSION_SECRET`, and no `ANTHROPIC_API_KEY`. Run `npm run dev`, open `http://localhost:3000/monsoon` at phone width, sign in, type a contact by hand, save it to each estate, and confirm the rows with `psql`. Photo reading is expected to show the read-failure message here; it is proven in Task 7.
Expected: both saves succeed; a repeat save of the same person reports "already in".

- [ ] **Step 6: Commit**

```bash
git add src/app/monsoon src/components/monsoon public/monsoon
git commit -m "feat(monsoon): capture screen and home-screen install"
```

---

### Task 7: Go live (needs Vincent)

Nothing in this task is done without Vincent's say-so at each marked step: it puts secrets on Vercel, ships to the public site and writes to the live CRMs.

- [ ] **Step 1: Find out how `qcwebsite` deploys.** Check `vercel --version`, `vercel whoami`, and whether pushes to `main` on `Ash2C/qcwebsite` deploy by themselves (`vercel project ls`, recent deployments). Also check whether Node's default trust store accepts the two Supabase pooler certificates: with the URLs loaded from `~/.quantcloud/crm.env` into the process environment (never printed), run a one-off script that connects with `clientConfig(url)` and runs `SELECT 1` against each. If verification fails, the fix is Supabase's CA certificate (dashboard → Project Settings → Database → SSL, downloaded by Vincent) set as `MONSOON_DB_CA_CERT`; do not disable verification. Report what you find before going on.

- [ ] **Step 2: Vincent supplies** the Anthropic API key and chooses a passcode of 16+ characters. Generate the session secret with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

- [ ] **Step 3 (confirm with Vincent first): set the production environment variables** on the `qcwebsite` Vercel project, marked sensitive, production only: `TRAXO_CRM_DATABASE_URL` and `ZEROONE_CRM_DATABASE_URL` (values from `~/.quantcloud/crm.env`, piped to `vercel env add` without echoing them), `ANTHROPIC_API_KEY`, `MONSOON_PASSCODE`, `MONSOON_SESSION_SECRET`, and `MONSOON_DB_CA_CERT` if step 1 showed it is needed. Verify with `vercel env ls production` (names only).

- [ ] **Step 4 (confirm with Vincent first): merge `monsoon-capture` into `main` and deploy.** Use superpowers:finishing-a-development-branch.

- [ ] **Step 5: Check the live site without writing anything.**
  - `curl -s -o /dev/null -w "%{http_code}" https://quantcloud.com/monsoon` → `200`
  - `curl -s -o /dev/null -w "%{http_code}" https://quantcloud.com/api/monsoon/estates` → `401`
  - `curl -s -X POST https://quantcloud.com/api/monsoon/save -H "Content-Type: application/json" -d "{}" -o /dev/null -w "%{http_code}"` → `401`
  - the home page `https://quantcloud.com/` still returns `200`.

- [ ] **Step 6: Vincent, on the iPhone:** open `quantcloud.com/monsoon` in Safari, Share → Add to Home Screen, open Monsoon from the icon, enter the passcode, confirm both estates show as available, then photograph one real card into Traxo and one into Zero One.

- [ ] **Step 7: Confirm the two live saves** from the laptop: in each estate folder, `crm_list` (or `py -3.13 -m quantcloud.crm <estate> status`) shows the new member in `uncontacted` with a `meeting` touch, and `captures` has a `monsoon-app` row. Report the result to Vincent.
