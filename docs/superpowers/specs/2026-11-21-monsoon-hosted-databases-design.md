# Monsoon hosted client databases - design

Date: 2026-11-21. Amends `2026-11-13-monsoon-customers-design.md` (and its section 11). Where the two
disagree, this file wins.

## 1. Decision (Vincent, 2026-11-21)

- Monsoon clients never give Monsoon a database connection string. Their CRM lives in Vincent's
  Supabase account, one separate Supabase project per client (not a shared project, not shared
  tables).
- Clients still pay for their own Claude use: the setup page asks for one thing only, their Claude
  API key (from the Claude Console; a claude.ai subscription cannot be used).
- A client moves to their own Supabase only when they ask. Vincent does the move; the client is
  still never asked for a connection string in Monsoon.
- Vincent's own pipelines (customer `quantcloud`: Traxo and Zero One) do not change.

## 2. How a client is onboarded

1. Vincent runs the existing `customer add`, `person add` and `pipeline add` commands.
2. Vincent creates a new Supabase project for the client and notes its project reference, pooler host
   and database (owner) password.
3. Vincent runs `host <code> <pipeline> --ref <ref> --pooler <host> --owner-password-from-env <VAR>`.
   The admin tool, on his PC:
   - refuses if the project reference is already used by any pipeline, or if the project already
     holds Monsoon people and `--replace` was not given;
   - connects as the project owner and runs the pipeline's setup script (CRM tables, vocabulary,
     owners, restricted `monsoon_app` login) with a generated 32-byte password nobody sees;
   - creates a `host` setup link (single use, 15 minutes) and immediately submits the project
     reference, pooler host and generated password to `POST /api/monsoon/setup` itself;
   - the server runs the same setup checks as today (connects as `monsoon_app`; tables, version,
     vocabulary, cannot delete, no extra privileges or flags, no public policies), then stores the
     address encrypted and records the project reference on the pipeline.
4. Vincent runs `link <code>`: a `key` setup link (single use, 7 days) that he sends to the client.
   The page shows one field, Claude API key; the server tests the key with one Haiku call and stores it
   encrypted. A `key` link always replaces any key on file.

## 3. Rules kept from the customers design

- The master key stays only on the server; the admin tool never reads it and never prints a
  credential, password, connection string or driver message.
- The server only connects to Supabase pooler hosts.
- No client's request touches another client's database or key.

## 4. Changes to existing behaviour

- Link purposes become `host` (admin tool only; never renders a page) and `key` (client-facing).
  Links of the old purposes `connect` and `replace` are refused as expired by both the page and the
  route; none are in use.
- `link` takes only the customer code and makes a `key` link; `--replace` goes.
- `script` stays (for a client who later moves to their own Supabase and runs the script there).
- Accounts schema version 2: purposes `host`/`key`, activity actions `host`/`key`, and
  `pipelines.project_ref` (unique, not secret).

## 5. Moving a client to their own Supabase later (runbook, no new code)

The client creates a project and gives Vincent its owner password. Vincent copies the data across with
`pg_dump`/`pg_restore` (data only, into a project prepared by `host ... --replace`), checks the counts,
then the client's Monsoon runs on the new project. Written up as a runbook section in the plan.

## 6. Out of scope

Self-serve sign-up; billing; an automated move command; backups beyond Supabase's own; the per-client
memory brain.

## 7. Open before the first real client

Supabase plan: the free plan's active-project limit and idle pausing, and the per-project compute
charge on the paid plan. Check current terms.
