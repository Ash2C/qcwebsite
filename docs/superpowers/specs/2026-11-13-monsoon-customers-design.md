# Monsoon for customers: their database, their Claude key

Date: 2026-11-13. Status: approved by Vincent 2026-11-13; build ON HOLD at his request. Accounts database: a new Supabase project in a second free organisation (his decision). Builds on the capture, batch and Ask designs
in this folder.

## 1. Intent

Vincent wants to offer Monsoon to other firms and be able to tell them, truthfully, that he does not
hold their customer data. Each customer brings their own Supabase database and their own Claude API
key. Monsoon works against those. Their contacts live only in their database; their AI traffic runs
under their Anthropic account; and they can cut Monsoon off at any time.

The comfort being sold, stated precisely: Monsoon's server must read a customer's data to do its job,
so this is not "cannot see". It is "does not hold, cannot delete, is logged on your side, and stops the
moment you revoke it", plus "you never handed us your keys": the customer types their credentials into
a setup form and nobody at Monsoon sees them in the clear.

## 2. Goals, non-goals, anti-goals

Goals

- A **customer** concept: a firm with its own people, pipelines, database and Claude key.
- Each person signs in with their company code and their own passcode. What they add or change is
  recorded under their own name in their CRM.
- Customers are **hand-onboarded** (Vincent's choice): Vincent creates the customer and sends a
  one-time setup link; the customer creates a Supabase project and a Claude key, runs one setup script,
  and enters both credentials in the setup form.
- Credentials are tested, then stored encrypted in a new **Monsoon accounts database**. Vincent never
  sees them.
- The database login a customer gives Monsoon is restricted: it can read, add and update, and cannot
  delete, truncate or change the structure.
- Vincent's own setup (Traxo and Zero One, his Claude key) becomes customer number one and keeps
  working exactly as today.
- Sign-in attempts are limited (the accounts database finally gives a place to count them).

Non-goals (this version)

- Self-serve sign-up, billing, plans.
- A customer admin screen (adding people, changing pipelines). Vincent does these by command for now.
- Single sign-on, per-person permissions, teams within a customer.
- Databases other than Supabase.
- Customers hosting Monsoon themselves.
- Moving or copying any CRM data. Nothing in any CRM changes.
- An activity screen for customers. The activity log is recorded; showing it in the app waits.

Anti-goals

- One customer's request ever touching another customer's database or Claude key.
- A customer credential stored or logged in the clear, or shown back to anyone after it is saved.
- Any copy of a customer's contact data kept outside their own database (no cache, no log, no analytics).
- A setup link that works twice, or after it expires.
- Monsoon's server connecting to an arbitrary address a customer typed in.
- Vincent's existing capture, batch, notes and Ask behaviour changing.

## 3. Constraints and facts

- Same site and hosting: Next.js on Vercel, repo `C:\Dev\Quantcloud\QCwebsite`.
- Today the app has one passcode (`MONSOON_PASSCODE`), two estates hardcoded in
  `src/lib/monsoon/estates.ts`, one Claude key (`ANTHROPIC_API_KEY`), a session cookie
  `v1.<expiry>.<hmac>` that identifies nobody, and the owner key `VF` written into
  `capture.ts`, `ask/actions.ts`, `ask/loop.ts` and `alpha.ts`.
- Every CRM uses the core schema (`src/lib/monsoon/testing/0001_init.sql`). Row-level security is on
  with no policies, so a login that is not the database owner sees nothing unless policies allow it.
- Supabase's connection pooler presents a certificate signed by Supabase's own CA; the app already
  ships that CA as `MONSOON_DB_CA_CERT`.
- Supabase's free plan allows two active projects per organisation. Vincent already has two (Traxo,
  Zero One). The accounts database needs a third project (a paid plan or a second organisation) or a
  separate, locked-down schema inside an existing project. **Decision for Vincent, section 10.**
- The public alpha sign-up route writes to Vincent's Zero One CRM and is currently paused.

## 4. Approaches considered

For where customer credentials live:

A. **Encrypted settings on Vercel.** Simplest; rejected by Vincent because the customer would have to
   send their credentials to him to enter.

B. **A Monsoon accounts database, filled by the customer through a setup form (chosen by Vincent).**
   Credentials are encrypted on arrival with a key only the server holds. More build, a cleaner story,
   and the base for self-serve later.

For how a customer is set up: hand-onboarded (chosen by Vincent) over self-serve.

Everything else below is Claude's design within those two decisions.

## 5. What people see

### The customer's administrator, once

1. Vincent sends them: their company code, a setup link (valid 7 days, works once), and a one-page
   guide.
2. They create a Supabase project and open its SQL editor.
3. The setup page shows them a **setup script** already filled in for their firm (their pipeline's
   stages and roles, their people). They paste it into the SQL editor and run it. It builds the
   Monsoon tables and creates a restricted login named `monsoon_app` with a password they choose.
4. They create a Claude API key in their Anthropic console.
5. On the setup page they enter: their Supabase project reference and pooler host (both shown on
   Supabase's Connect screen), the password they chose for `monsoon_app`, and the Claude key. Monsoon
   builds the connection itself; they never assemble a connection string.
6. They press `Test and connect`. Monsoon checks, and tells them in plain words:
   - it can connect, with the certificate verified;
   - the tables are present and at the expected version;
   - the login **cannot** delete (Monsoon tries a delete inside a transaction that it then cancels,
     and expects to be refused);
   - the Claude key works (one tiny request).
7. On success: `Connected. You can close this page.` The link stops working. The credentials are never
   shown again.

To replace a credential later (a rotated password or key) Vincent sends a fresh link; the form then
replaces only what they enter.

### Each person, every day

- The sign-in screen asks for **company code** and **passcode** (the code is remembered on the phone).
- After that Monsoon is the same app: their pipelines in the selector, capture, batch, spoken notes,
  Ask. Notes and changes carry their name.

### Vincent

- Signs in with code `quantcloud` and his existing passcode. Nothing else changes.
- Manages customers from his PC with a small command-line tool (create a customer, add a person, make
  a setup link, suspend a customer, list customers and whether they are connected).

## 6. How it works

### 6.1 The accounts database

A separate Postgres database that holds accounts and encrypted credentials only. No contact data.

- `customers`: id, code (unique, lowercase), name, status (`active` | `suspended`), claude key
  (encrypted), model, created.
- `people`: id, customer, display name, owner key (the short code written into that customer's CRM,
  e.g. `VF`), passcode hash, status.
- `pipelines`: id, customer, key, label, default role, position, database address (encrypted),
  connected-at.
- `setup_links`: id, customer, token hash, expires, used-at, purpose (`connect` | `replace`).
- `sign_in_attempts`: customer code, person (if known), time, outcome, a hash of the caller's network
  address. Used for limiting, pruned after 30 days.
- `activity`: customer, person, time, action (`sign_in`, `capture`, `batch_save`, `tidy`, `ask`,
  `act_note`, `act_stage`, `setup`, `replace`), pipeline. **Never** contact data, note text or
  questions.

### 6.2 Secrets

- Credentials are encrypted with AES-256-GCM under a master key held only in the server's settings
  (`MONSOON_MASTER_KEY`, 32 random bytes). Each value has its own random nonce and is bound to its
  customer and field, so a value copied to another row will not decrypt. The stored form carries a key
  version so the master key can be rotated.
- Passcodes are stored as salted scrypt hashes. Setup tokens are stored as SHA-256 hashes.
- Decrypted values live only in memory for the length of one request. They are never logged, never
  returned by any route, and never sent to the browser.
- The accounts database itself is reached with its own connection string (`MONSOON_ACCOUNTS_DATABASE_URL`).

### 6.3 Signing in

- `POST /api/monsoon/session` takes `{ code, passcode }`. It finds the customer by code and checks
  the passcode against each active person's hash (constant work whether or not the code exists).
- Limit: 5 failed attempts per company code and per network address in 15 minutes, then a 15-minute
  lock, answered with the same message as a wrong passcode plus `Try again later.`
- The session cookie becomes `v2.<customer id>.<person id>.<expiry>.<hmac>`, still HttpOnly, Secure,
  SameSite=Strict, 180 days. A `v1` cookie is no longer accepted: Vincent signs in once after this
  ships.
- Every Monsoon route resolves **customer and person from the cookie**, then loads that customer's
  pipelines and Claude key. Nothing identifying a customer is ever read from the request body. A
  suspended customer or person is refused on the next request.

### 6.4 Per-customer data paths

- The pipeline list comes from the accounts database, replacing the hardcoded two.
- A database connection for a request is built from the decrypted address of the pipeline that the
  signed-in customer chose. A pipeline key from the browser is only ever looked up **within that
  customer's pipelines**.
- Address guard: Monsoon will only connect to a host ending in `.supabase.com` or `.supabase.co`, on
  port 5432 or 6543, with certificate verification against Supabase's CA. This stops a typed-in
  address being used to reach anything else.
- Claude calls (card reading, tidying, Ask) use the signed-in customer's key and model. Default model
  Claude Haiku 5.5. For Vincent's own account the rule "never Opus or Fable" stays; a customer's model
  is set per customer by Vincent's tool.
- The owner written into the CRM (`owner`, `by_whom`) is the signed-in person's owner key, replacing
  the fixed `VF`. Ask's instructions name the signed-in person and their owner key.
- The public alpha sign-up route keeps writing to Vincent's Zero One pipeline, now looked up as
  customer `quantcloud`, pipeline `zeroone`.
- A short-lived in-memory cache (60 seconds) of a customer's pipeline list and status is allowed, to
  avoid a lookup on every request. Decrypted secrets are not cached.

### 6.5 The customer's database

The setup script (generated per customer, shown on the setup page, also printable by Vincent's tool):

1. Creates the core tables exactly as `0001_init.sql` does, and records the schema version.
2. Fills `stages`, `roles` and `owners` from what Vincent entered for that customer.
3. Creates the login `monsoon_app` with the password the administrator sets in the script.
4. Grants it `SELECT`, `INSERT`, `UPDATE` on the Monsoon tables and nothing else: no `DELETE`, no
   `TRUNCATE`, no structure changes.
5. Adds row-level-security policies allowing `monsoon_app` to read, insert and update.

Their database owner login is never given to Monsoon. Revoking access is one statement on their side
(`DROP ROLE` or a password change), after which Monsoon shows that pipeline as unavailable.

When the core schema changes in future, Monsoon checks the version at connect time and, if a customer
is behind, shows `This pipeline needs an update` and gives them an update script to run. Monsoon never
changes a customer's structure itself (its login cannot).

### 6.6 The setup form

- `GET /monsoon/setup/<token>` shows the page if the token's hash matches an unused, unexpired link.
  Otherwise `This setup link has expired. Ask for a new one.`
- `POST /api/monsoon/setup` with the token and the two credentials runs the four checks of section 5,
  in order, stopping at the first failure with a plain message that never echoes a credential.
- On success, in one transaction: store both values encrypted, mark the pipeline connected, mark the
  link used, write an `activity` row.
- Limited to 10 attempts per link.
- The page is served with headers forbidding caching and framing; the form fields are password-type
  and are cleared on success.

### 6.7 Vincent's command-line tool

`scripts/monsoon/admin.mjs`, run on his PC against the accounts database (address in
`~/.quantcloud/monsoon.env`). Commands: `customer add`, `person add` (prints the passcode once),
`pipeline add` (label, stages, roles), `link` (prints a setup link), `status`, `suspend`, `resume`,
`script` (prints a customer's setup script). It can never print a stored credential: it has no access
to the master key.

### 6.8 Moving Vincent's own setup

A one-off step at deploy: create customer `quantcloud`, person Vincent (owner `VF`, his existing
passcode), pipelines `traxo` and `zeroone`, and store his two database addresses and Claude key
encrypted. This needs the master key, so it runs as a guarded one-time server action using the values
already in the server's settings, not from his PC. After it succeeds the old settings
(`MONSOON_PASSCODE`, the two database URLs, `ANTHROPIC_API_KEY`) are removed.

His existing full-access database logins stay as they are for now; swapping them for restricted
`monsoon_app` logins is offered as a follow-up, since it needs a step in each of his Supabase projects.

## 7. Calls Claude made (not decisions Vincent stated)

- Company code plus personal passcode as the sign-in, with one passcode per person.
- The restricted `monsoon_app` login, and the delete-refusal test at setup.
- Monsoon only connects to Supabase addresses.
- The activity log records actions without content, and is not shown in the app yet.
- Sign-in limiting: 5 failures per 15 minutes.
- Old `v1` sign-ins stop working; Vincent signs in once.
- Vincent's own account moves into the same system rather than staying a special case.
- A command-line tool instead of an admin screen.
- A customer's model is chosen per customer; the no-Opus-or-Fable rule applies to Vincent's account.
- Schema updates are scripts the customer runs.

## 8. Testing

- Encryption: round trip; a value moved to another customer or field fails to decrypt; a tampered
  value fails; key versions.
- Sign-in: right and wrong passcode, unknown code (same timing path), limiting and lock, suspended
  customer and person, cookie forgery and expiry, `v1` refused.
- Isolation, against two real test databases standing in for two customers: every route, signed in as
  customer A, can only ever read or write A's database and use A's key; a pipeline key belonging to B
  is refused; a request body naming B is ignored.
- Setup: token expiry, single use, attempt limit, each of the four checks failing in turn, the address
  guard, nothing stored on failure, no credential in any response or log.
- The restricted login: created by the generated script on a test database; Monsoon's capture, batch,
  tidy, Ask and both Ask changes work through it; a delete is refused.
- The owner key: writes carry the signed-in person's key.
- Existing behaviour: the full existing suite passes with Vincent's account as customer number one.
- The never-delete scan now also covers the accounts-database code, with one stated exception: the
  30-day pruning of `sign_in_attempts`, which holds no customer data.

## 9. Left to the builder

- Table and column details of the accounts database, and its migration.
- The scrypt parameters and the exact stored format of encrypted values.
- How the network address is derived on Vercel for limiting.
- The setup page's design, in the Monsoon brand.
- The wording of the one-page customer guide.
- Order of work, provided Vincent's own sign-in is never broken in production between deploys.

## 10. Decisions and inputs needed from Vincent

1. **Where the accounts database lives.** Supabase's free plan allows two projects and both are used.
   Options: (a) a new Supabase project on a paid plan (about US$25 a month for the organisation) or in
   a second free organisation; (b) a separate locked-down schema inside the Zero One project (free,
   but accounts and a CRM then share one project). Claude recommends (a), in a second free
   organisation if he wants to avoid the cost.
2. **The first customer's details**, when there is one: firm name, the people who will use it, and
   their pipeline's stages and roles.

## 11. Resolved in review (these override earlier sections where they differ)

**Connecting to a customer's database**

- Supabase's pooler needs the username `monsoon_app.<project-ref>`, and the direct database host is
  not reachable from Vercel. The setup form therefore takes the project reference, the pooler host and
  the `monsoon_app` password, and Monsoon builds the connection (transaction pooler, port 6543).
- The address guard accepts only hosts matching `<name>.pooler.supabase.com`.

**The restricted login, exactly**

- Grants to `monsoon_app`: `SELECT` on every Monsoon table; `INSERT` on `orgs`, `people`, `members`,
  `touches`, `captures` and `owners`; `UPDATE` on `people`, `members` and `touches`. Nothing else.
- Row-level-security policies are written `TO monsoon_app` only, with `USING (true)` and
  `WITH CHECK (true)`, one per granted action per table. No policy names any other role, so Supabase's
  public `anon` and `authenticated` roles still see nothing through the project's auto-generated API.
- The stage-change trigger runs as the caller, so it relies on the `INSERT` grant and policy on
  `touches`. A stage move through the restricted login is part of the tests.
- The setup check is stronger than one refused delete. It passes only if all of these hold: a `DELETE`
  inside a cancelled transaction fails with Postgres error `42501` (no error counts as a failure);
  `has_table_privilege` reports no `DELETE` or `TRUNCATE` on any Monsoon table; the role is not a
  superuser, cannot bypass row security, cannot create roles or databases, and is not a member of any
  other role; and `anon` and `authenticated` have no policies on the Monsoon tables.

**People**

- Passcodes are generated by Vincent's tool (five random words, as his own is), never chosen, so they
  are strong and unique within a customer. At most 50 people per customer.
- A person's owner key must exist in the customer's `owners` table. Monsoon inserts it on that person's
  first sign-in if it is missing (`INSERT ... ON CONFLICT DO NOTHING`; this is why `owners` has an
  insert grant), so adding a person later needs nothing from the customer.
- The session cookie also carries a per-person session number. Resetting a passcode or suspending a
  person raises that number, which signs their devices out. Format:
  `v2.<customer id>.<person id>.<session number>.<expiry>.<hmac>`; ids are UUIDs.

**Sign-in limiting**

- 5 failures in 15 minutes for the same company code from the same network address locks that pair
  for 15 minutes. Separately, 50 failures in 15 minutes for one company code from anywhere locks the
  code for 15 minutes. (A lock on the code alone at 5 would let anyone who knows a code lock a firm out.)

**Suspension and caching**

- The 60-second cache means a suspension takes effect within one minute, not on the very next request.

**Setup form details**

- Messages come from a fixed list; database and API errors are mapped to them and never echoed.
- The link is consumed atomically (`UPDATE ... WHERE used_at IS NULL RETURNING`), so two simultaneous
  submissions cannot both succeed. Attempts are counted outside the storing transaction.

**The master key**

- `MONSOON_MASTER_KEY` exists only in the server's settings. No copy is kept on Vincent's PC, because
  holding it would let him decrypt customer credentials. If it is ever lost, stored credentials become
  unreadable and each customer re-enters theirs through a fresh setup link; no CRM data is affected.
  Anyone with access to the Vercel project's settings could read the key; today that is only Vincent,
  which is the honest limit of "does not hold".

**Proving the restricted path before a customer uses it**

- Before the first outside customer is onboarded, Vincent's own two pipelines are switched to
  `monsoon_app` logins (he runs the setup script's login-and-policies part in his Traxo and Zero One
  projects and reconnects through a setup link). This makes his daily use the production proof of the
  restricted path. It is a rollout step, not optional.

**Wiring that the earlier sections left implicit**

- Every route that acts for a customer writes one `activity` row (action and pipeline only).
- `ask/loop.ts` names Vincent and `VF` in its instructions; these become the signed-in person's name
  and owner key, and "who should I chase" means that person's contacts plus unassigned ones.
- The never-delete scan is taught one exception: pruning `sign_in_attempts` in the accounts database.
