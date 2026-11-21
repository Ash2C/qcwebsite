# Monsoon Hosted Client Databases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clients are asked only for their Claude API key. Vincent puts each client's CRM in its own Supabase project in his account with one admin command, `host`.

**Architecture:** The admin tool (on Vincent's PC, no master key) builds the client's CRM in the new project as its owner, with a generated `monsoon_app` password. It then hands project ref, pooler host and that password to the live server through a single-use 15-minute `host` setup link it submits itself. The server runs the existing setup checks and encrypts and stores the address. The client-facing link becomes a Claude-key-only `key` link.

**Tech Stack:** Next.js route handlers on Vercel, TypeScript, `pg`, Vitest (database tests against local Postgres `docker start monsoon-test`, port 55433), Supabase pooler.

**Spec:** `docs/superpowers/specs/2026-11-21-monsoon-hosted-databases-design.md` (amends `docs/superpowers/specs/2026-11-13-monsoon-customers-design.md`).

## Global Constraints

- The admin tool never reads `MONSOON_MASTER_KEY` and never prints a password, connection string, Claude key or driver message (the existing "CLI source never mentions the master key or deletes" test must keep passing).
- Every server log line about setup carries only the error class name and the 5-character Postgres code (existing `logError` pattern).
- The server connects only to `*.pooler.supabase.com` on ports 6543/5432 (`parseAllowedDbUrl`, unchanged).
- `host` links: single use, expire 15 minutes after creation, never render a page. `key` links: single use, 7 days, `SETUP_MAX_ATTEMPTS` (10) attempts.
- Generated `monsoon_app` password: `randomBytes(32).toString("base64url")`.
- Client page copy, exact: heading text "Enter your Claude API key. Monsoon tests it before keeping it. You can create a key in the Claude Console at platform.claude.com (a claude.ai subscription can't be used)." Field label "Claude API key". Success message stays `SETUP_SUCCESS` ("Connected. You can close this page.").
- Customer `quantcloud` (Traxo, Zero One) and the app's capture/Ask/Contacts behaviour do not change.
- Run tests and builds from a clean worktree (the main checkout's untracked folders break `tsc`/`vitest`/`next build`). A push to `main` deploys; do not push or merge without Vincent.

## Review Focus

1. **Wrong project ref typed:** `host` aimed at a project that already holds another client's Monsoon people must refuse, not mix two clients. Covered: Task 4 test "refuses a project that already holds Monsoon people unless --replace".
2. **Same project for two pipelines:** a ref already recorded on any pipeline must be refused before anything runs. Covered: Task 4 test "refuses a project ref already used by a pipeline", Task 1 unique column.
3. **`host --replace` fails half-way:** the password is rotated in the database but the server refuses or is unreachable, so the live pipeline now has a stale stored password. The command must exit 1 and say plainly that the pipeline is disconnected until `host ... --replace` runs again. Covered: Task 4 test "a server refusal after the script ran exits 1 and says to run host again".
4. **An old `connect`/`replace` link opened after deploy:** must show the expired message, never a database form. Covered: Task 2 test "legacy connect and replace links are refused as expired" and Task 3 page test.
5. **Owner password env var missing or empty:** clear one-line error, nothing connects, nothing echoed. Covered: Task 4 test "a missing owner password variable fails before connecting".

---

### Task 1: Accounts schema version 2

**Files:**
- Modify: `src/lib/monsoon/accounts/schema.sql`
- Modify: `scripts/monsoon/admin-commands.ts` (the `migrate` case, lines ~161-180)
- Test: `src/lib/monsoon/accounts/schema.db.test.ts`, `scripts/monsoon/admin.db.test.ts`

**Interfaces:**
- Produces: `setup_links.purpose` accepts `'connect','replace','host','key'`. `activity.action` additionally accepts `'host','key'`. New column `pipelines.project_ref TEXT NULL` with a unique index `pipelines_project_ref_key` (NULLs allowed many times). `accounts_migrations` holds version 2.

- [ ] **Step 1: Write failing tests** in `schema.db.test.ts`:
  - `"version 2: setup_links accepts host and key purposes"`: insert a link with purpose `'host'` and one with `'key'` succeeds; `'other'` fails with code `23514`.
  - `"version 2: activity accepts host and key actions"`.
  - `"version 2: a project ref can be recorded on only one pipeline"`: two pipelines with the same `project_ref` fails with `23505`; two with NULL succeed.
  - `"version 2 applies over a version 1 database"`: apply the v1 file content (keep a copy of today's file as the test fixture `src/lib/monsoon/accounts/testing/schema-v1.sql`), insert a `connect` link, apply `schema.sql`, the link survives, `SELECT max(version)` is 2.
  
  In `admin.db.test.ts`, change `"migrate is idempotent"` to expect the text `Schema already applied (version 2).`
- [ ] **Step 2: Run** `npx vitest run src/lib/monsoon/accounts/schema.db.test.ts scripts/monsoon/admin.db.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Append to `schema.sql` (idempotent): `ALTER TABLE setup_links DROP CONSTRAINT IF EXISTS setup_links_purpose_check, ADD CONSTRAINT setup_links_purpose_check CHECK (purpose IN ('connect','replace','host','key'))`. Do the same for `activity_action_check` with the existing list plus `'host','key'`. Add `ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS project_ref TEXT NULL`, `CREATE UNIQUE INDEX IF NOT EXISTS pipelines_project_ref_key ON pipelines (project_ref)`, and `INSERT INTO accounts_migrations (version) VALUES (2) ON CONFLICT DO NOTHING`. In `migrate`, short-circuit only when version 2 is present, printing `Schema already applied (version 2).` Otherwise run `schema.sql`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(monsoon): accounts schema v2 - host and key links, pipeline project ref`.

### Task 2: Setup route and page lookup handle `host` and `key`

**Files:**
- Modify: `src/app/api/monsoon/setup/route.ts`
- Modify: `src/lib/monsoon/accounts/setup-link.ts`
- Test: `src/app/api/monsoon/setup/route.test.ts`, `src/lib/monsoon/accounts/setup-link.db.test.ts`

**Interfaces:**
- Consumes: Task 1 schema.
- Produces:
  - `POST /api/monsoon/setup` body for `host`: `{ token, projectRef, poolerHost, password }`. It requires all three, takes no Claude key, runs `runSetupChecks` with `claudeKey: null`, and stores `db_url_enc`, `connected_at = now()` and `project_ref = projectRef`, with activity `host`. A ref held by another pipeline gives 409 `{ error: "That project is already used by another pipeline." }`.
  - Body for `key`: `{ token, claudeKey }`. It requires the key, runs `tryClaude`, and stores `customers.claude_key_enc`, with activity `key`. Database fields sent on a `key` link give 400.
  - `connect`/`replace` links give 410 with `SETUP_EXPIRED`.
  - `SetupPage` becomes `{ kind: "expired" } | { kind: "ok"; purpose: "key"; claudeKeyOnFile: boolean }`. `host`, `connect` and `replace` links load as `expired`.

- [ ] **Step 1: Write failing route tests** (replace the `connect`/`replace` cases; keep the check-failure cases, now driven through `host` links):
  - `"host: stores the address encrypted and the project ref, consumes the link, records host"`: decrypt `db_url_enc` with `decryptSecret(v, customerId, "pipeline:" + pipelineId)` and expect it to contain the test role. `project_ref` equals `REF`. Activity `host`. No Anthropic call (`h.create` not called).
  - `"host: a project ref used by another pipeline is refused with 409 and nothing stored"`.
  - `"host: missing password is refused with 422 connect"`.
  - Keep `vocabulary`, `can_delete`, `role_flags`, `public_policies`, `address`, wrong password, ten attempts then 429, concurrent submissions: issue `host` links in each.
  - `"key: stores the Claude key encrypted, records key"`. `"key: a key Anthropic refuses is 422 claude_key and nothing stored"`. `"key: blank key is 422 claude_key"`. `"key: database fields on a key link are refused with 400"`. `"key: replaces a key already on file"`.
  - `"legacy connect and replace links are refused as expired"`: 410 `EXPIRED`, `h.create` not called, attempts unchanged.
  
  In `setup-link.db.test.ts`: `"a key link loads with claudeKeyOnFile"`, and `"host, connect and replace links load as expired"`.
- [ ] **Step 2: Run** `npx vitest run src/app/api/monsoon/setup src/lib/monsoon/accounts/setup-link.db.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.** In `claimAttempt`, keep the attempt counting for every purpose, then refuse `connect`/`replace` as expired. Split `POST` into a `host` branch and a `key` branch. In the `store` transaction, set `project_ref` for `host` and map a unique violation (`23505` on `pipelines_project_ref_key`) to the 409 reply; identify it by `err.table === "pipelines"` and code, never by constraint text alone (repo rule). In `loadSetupPage`, drop the script generation (`generateSetupScript` is no longer imported there).
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(monsoon): setup route takes host links (database) and key links (Claude key only)`.

### Task 3: Client setup page asks only for the Claude key

**Files:**
- Modify: `src/app/monsoon/setup/[token]/page.tsx`
- Modify: `src/components/monsoon/SetupForm.tsx` (drop `SetupScript` export and the three database rows)
- Test: `src/components/monsoon/SetupForm.test.tsx`, add `src/app/monsoon/setup/[token]/page.test.tsx`

**Interfaces:**
- Consumes: Task 2 `SetupPage`.
- Produces: `SetupForm({ token }: { token: string })` posts `{ token, claudeKey }`.

- [ ] **Step 1: Write failing tests:**
  - `SetupForm`: `"shows one field, Claude API key, and posts only token and claudeKey"`, `"clears and hides the form after success"` (keep the existing behaviour), `"shows the server error"`. Assert there is no textbox or password field labelled Project reference, Pooler host or monsoon_app password.
  - `page.test.tsx` (mock `loadSetupPage`): `"a key link shows the exact instruction text and the form"` (the copy in Global Constraints); `"an expired link shows SETUP_EXPIRED and no form"`; `"the page never renders a SQL script"` (no `<pre>`, no text `CREATE TABLE`).
- [ ] **Step 2: Run** `npx vitest run src/components/monsoon/SetupForm.test.tsx "src/app/monsoon/setup"`. Expected: FAIL.
- [ ] **Step 3: Implement** the page and form per the interfaces and copy above.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(monsoon): client setup page asks only for the Claude API key`.

### Task 4: Admin `host` command and key-only `link`

**Files:**
- Modify: `src/lib/monsoon/accounts/setup-script.ts` (optional `password` on `SetupVocabulary`)
- Modify: `scripts/monsoon/admin-commands.ts`, `scripts/monsoon/admin.ts`
- Test: `src/lib/monsoon/accounts/setup-script.db.test.ts`, `scripts/monsoon/admin.db.test.ts`

**Interfaces:**
- Consumes: Task 1 column and purposes, and the Task 2 route contract.
- Produces:
  - `SetupVocabulary.password?: string`. When set, it must be at least 16 characters (else throw `invalid password`), and the generated `DO` block uses it in place of `PASSWORD_PLACEHOLDER` via `lit()`.
  - `AdminDeps` gains `connectOwner?: (url: string) => Promise<ClientBase & { end(): Promise<void> }>`, `post?: (url: string, body: Record<string, string>) => Promise<{ status: number; body: { ok?: boolean; error?: string; failure?: string } }>`, `randomPassword?: () => string` and `appRole?: string` (default `"monsoon_app"`, a test-only override). `admin.ts` wires `connectOwner` to `new Client(clientConfig(url))` plus `connect()`, and `post` to `fetch` with JSON and a 70 s timeout.
  - Usage lines: `host <code> <pipeline key> --ref <ref> --pooler <host> --owner-password-from-env <VAR> [--replace]` and `link <code>`.

- [ ] **Step 1: Write failing tests.**

  In `setup-script.db.test.ts`:
  - `"a script with a password runs unedited and the login signs in with it"`.
  - `"a password under 16 characters is refused"`.

  In `admin.db.test.ts`, which drives `host` with `connectOwner` returning a connection to a fresh local CRM test database (`makeTestDb`), `appRole` set to the per-worker test role, `randomPassword` returning a fixed 43-character value, and `post` as a recorder:
  - `"host builds the CRM, posts ref, pooler and generated password to the setup route on a host link, prints no secret"`. Assert:
    - the CRM has the 11 tables, the pipeline's stages and roles, and the owners;
    - the test role signs in with the generated password;
    - the posted URL is `${MONSOON_PUBLIC_URL}/api/monsoon/setup`;
    - the posted body has the `token` of a `host` link expiring in 15 minutes or less;
    - no output line contains the password or the owner password;
    - the exit code is 0 and the output contains `Pipeline main hosted on project abcdefghij0123456789.`
  - `"refuses a project ref already used by a pipeline"`: exit 1, `connectOwner` never called.
  - `"refuses a project that already holds Monsoon people unless --replace"`: exit 1 with `That project already holds Monsoon data. Check the project reference, or pass --replace.`; with `--replace`, exit 0.
  - `"refuses a pipeline that is already connected unless --replace"`.
  - `"a server refusal after the script ran exits 1 and says to run host again"`: `post` returns 422 `{ failure: "can_delete", error: "..." }`. The output contains the server's `error` and `The pipeline is not connected until host runs again successfully.`
  - `"a missing owner password variable fails before connecting"`: exit 1, `connectOwner` not called, output `Error: environment variable X is not set`.
  - `"refuses a malformed ref or a non-pooler host before connecting"`.
  - `"link makes a 7-day key link for the customer"`, replacing the old link test. `link acme main` (extra positional) exits 1. `--replace` is an unknown flag.
- [ ] **Step 2: Run** `npx vitest run scripts/monsoon/admin.db.test.ts src/lib/monsoon/accounts/setup-script.db.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `host`** in `admin-commands.ts`, in this order (each refusal happens before the next step runs):
  1. Validate the flags. The ref must match `^[a-z0-9]{20}$` and the pooler host `^[a-z0-9-]+\.pooler\.supabase\.com$`; export these two regexes from `address.ts` rather than copying them.
  2. Read the owner password from the named env var.
  3. Look up the customer and pipeline. Refuse if the pipeline is connected and `--replace` was not given.
  4. Refuse if the ref is on any pipeline other than this one.
  5. Connect with `connectOwner("postgresql://postgres.<ref>:<enc pw>@<pooler>:5432/postgres")`.
  6. If `to_regclass('public.people')` exists and holds rows and `--replace` was not given, refuse.
  7. Run `generateSetupScript({ ...vocabulary, owners, roleName: appRole, password })` as one query.
  8. Create the `host` link, then `post` it.
  9. Report the result. On failure, print the server's `error` string (a `SETUP_MESSAGES` text, credential-free) and the "not connected" line. Wrap driver errors with the existing class-name-and-code formatter.
  10. Close the owner connection in `finally`.

  Move the vocabulary and owners lookup that `script` already does into a shared helper.
- [ ] **Step 4: Run** the same command plus `npx vitest run scripts/monsoon`. Expected: PASS, including `"the CLI source never mentions the master key or deletes"`.
- [ ] **Step 5: Commit** `feat(monsoon-admin): host command builds a client CRM in a Supabase project; link makes Claude-key links`.

### Task 5: Live check on a real Supabase project, and the runbook

**Files:**
- Create: `docs/superpowers/plans/2026-11-21-monsoon-hosted-databases-runbook.md`

**Interfaces:**
- Consumes: Tasks 1-4 deployed (only after Vincent approves the merge and push).

- [ ] **Step 1: Full suite and build in the clean worktree.** Run `npx vitest run` then `npx tsc --noEmit` then `npx next build`. Expected: all pass (the known `BatchReview.test.tsx` flake passes when re-run alone).
- [ ] **Step 2: Whole-branch review** by a fresh reviewer against this plan and the spec. Fix its findings, then rerun Step 1.
- [ ] **Step 3: With Vincent: deploy and test.**
  1. Merge, then deploy in this order: push, wait until Vercel reports the deploy Ready, run `migrate` on the accounts database, and only then issue any `host` or `key` link. Reason: old production code treats unknown link purposes as `replace` and would connect a pipeline without recording `project_ref`.
     - Before migrating, confirm the live constraint names with `SELECT conname FROM pg_constraint WHERE conrelid IN ('setup_links'::regclass,'activity'::regclass)`; they should include `setup_links_purpose_check` and `activity_action_check`.
  2. Create a throwaway customer `test-client` with one person and one pipeline.
  3. Vincent creates a free Supabase project for it.
  4. Run `host test-client main --ref ... --pooler ... --owner-password-from-env MONSOON_TEST_OWNER_PW`.
  
  Expected: `Pipeline main hosted on project <ref>.`, and `status` shows `main connected <date>`.
  5. After the live `host` run, check the Supabase project's Postgres logs (Logs Explorer) to confirm the generated monsoon_app password does not appear.
- [ ] **Step 4: Key link and phone check.** Run `link test-client`, open the link, enter a Claude key, and expect "Connected. You can close this page." Sign in as the test person on a phone, capture a card, and check the row lands in the new project. Then run `forget test-client` and pause or delete the throwaway project, Vincent's call.
- [ ] **Step 5: Write the runbook** with four sections:
  - **Onboard a client:** the five commands in order, where each value comes from, and the Supabase plan check.
  - **Rotate the client's database login:** `host ... --replace`.
  - **Move a client to their own Supabase:**
    1. The client creates a project and shares its owner password with Vincent.
    2. Run `host <code> <pipeline> --ref <new> --pooler <new> --owner-password-from-env <VAR> --replace` to build the empty CRM on the new project. Note: the pipeline points at the new, empty project from this step on.
    3. Copy the data: `pg_dump --data-only` over the pooler's session port from the old project for the 11 Monsoon tables, then `pg_restore`, or `psql` as the new project's owner.
    4. Check the row counts match, then retire the old project.
    
    Do it outside the client's working hours.
  - **Offboard:** `forget <code>`, then export the project's data for the client if they ask, then pause the project.
- [ ] **Step 6: Commit** `docs(monsoon): hosted client databases runbook`.
