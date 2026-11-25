-- Monsoon accounts database: customers, people, pipelines, setup links, sign-in attempts, activity.
-- Holds no contact data. Idempotent. RLS is enabled with no policies: only the owner role reads it.

CREATE TABLE IF NOT EXISTS accounts_migrations (
  version INT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9-]{3,32}$'),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  claude_key_enc TEXT NULL,
  model TEXT NOT NULL DEFAULT 'claude-haiku-5-5',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS people (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id),
  display_name TEXT NOT NULL,
  owner_key TEXT NOT NULL CHECK (owner_key ~ '^[A-Z]{2,4}$'),
  passcode_hash TEXT NOT NULL,
  session_no INT NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, owner_key)
);

CREATE TABLE IF NOT EXISTS pipelines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id),
  key TEXT NOT NULL CHECK (key ~ '^[a-z0-9-]{2,32}$'),
  label TEXT NOT NULL,
  default_role TEXT NOT NULL,
  position INT NOT NULL DEFAULT 0,
  -- { stages, roles } as entered by Vincent; used to generate the customer's setup script
  vocab JSONB NOT NULL DEFAULT '{}',
  db_url_enc TEXT NULL,
  connected_at TIMESTAMPTZ NULL,
  UNIQUE (customer_id, key)
);

CREATE TABLE IF NOT EXISTS setup_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id),
  pipeline_id UUID NULL REFERENCES pipelines(id),
  token_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK (purpose IN ('connect', 'replace')),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ NULL,
  attempts INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sign_in_attempts (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL,
  person_id UUID NULL,
  address_hash TEXT NOT NULL,
  -- true signed in, false failed, NULL refused while locked (not counted as a failure)
  ok BOOLEAN NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE sign_in_attempts ALTER COLUMN ok DROP NOT NULL;
CREATE INDEX IF NOT EXISTS sign_in_attempts_code_at ON sign_in_attempts (code, at);
CREATE INDEX IF NOT EXISTS sign_in_attempts_code_address_at ON sign_in_attempts (code, address_hash, at);

CREATE TABLE IF NOT EXISTS activity (
  id BIGSERIAL PRIMARY KEY,
  customer_id UUID NOT NULL REFERENCES customers(id),
  person_id UUID NULL,
  pipeline_key TEXT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'sign_in', 'capture', 'batch_save', 'tidy', 'ask', 'act_note', 'act_stage',
    'act_details', 'act_research', 'research', 'setup', 'replace', 'host', 'key', 'profile', 'granola',
    'google_link', 'approve'
  )),
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE accounts_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE people ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipelines ENABLE ROW LEVEL SECURITY;
ALTER TABLE setup_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE sign_in_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity ENABLE ROW LEVEL SECURITY;

INSERT INTO accounts_migrations (version) VALUES (1) ON CONFLICT DO NOTHING;

-- Version 2: hosted databases. Setup links for host and key, pipelines remember their Supabase project.
ALTER TABLE setup_links DROP CONSTRAINT IF EXISTS setup_links_purpose_check,
  ADD CONSTRAINT setup_links_purpose_check CHECK (purpose IN ('connect', 'replace', 'host', 'key'));
ALTER TABLE activity DROP CONSTRAINT IF EXISTS activity_action_check,
  ADD CONSTRAINT activity_action_check CHECK (action IN (
    'sign_in', 'capture', 'batch_save', 'tidy', 'ask', 'act_note', 'act_stage',
    'act_details', 'act_research', 'research', 'setup', 'replace', 'host', 'key', 'profile', 'granola',
    'google_link', 'approve'
  ));
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS project_ref TEXT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS pipelines_project_ref_key ON pipelines (project_ref);

INSERT INTO accounts_migrations (version) VALUES (2) ON CONFLICT DO NOTHING;

-- Version 3: the Claude key in the app. One named person per customer may change the key; the
-- status is the result of the last real Claude call (NULL with a key on file: tested when it was saved).
ALTER TABLE customers ADD COLUMN IF NOT EXISTS key_person_id UUID NULL REFERENCES people(id);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS claude_status TEXT NULL;
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_claude_status_check,
  ADD CONSTRAINT customers_claude_status_check CHECK (claude_status IN ('ok', 'key_rejected', 'no_credit'));
ALTER TABLE customers ADD COLUMN IF NOT EXISTS claude_checked_at TIMESTAMPTZ NULL;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS claude_key_set_at TIMESTAMPTZ NULL;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS claude_key_set_by UUID NULL REFERENCES people(id);
-- A customer with nobody named yet: its earliest person keeps the key.
UPDATE customers c
   SET key_person_id = (SELECT p.id FROM people p WHERE p.customer_id = c.id ORDER BY p.created_at, p.id LIMIT 1)
 WHERE c.key_person_id IS NULL;

INSERT INTO accounts_migrations (version) VALUES (3) ON CONFLICT DO NOTHING;

-- Version 4: the user's own page. Phone and email belong to the person; company, website, role and
-- notes are kept per person per pipeline. Notes are insert-only for the app. Plain text, like contact
-- data in the CRMs. Every action list above also names 'profile': the earlier blocks re-add the check
-- on each run, and a shorter list would fail once a profile row exists.
ALTER TABLE people ADD COLUMN IF NOT EXISTS phone TEXT NULL;
ALTER TABLE people ADD COLUMN IF NOT EXISTS email TEXT NULL;

CREATE TABLE IF NOT EXISTS person_work (
  person_id UUID NOT NULL REFERENCES people(id),
  pipeline_id UUID NOT NULL REFERENCES pipelines(id),
  company TEXT NULL,
  website TEXT NULL,
  role_objectives TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, pipeline_id)
);

CREATE TABLE IF NOT EXISTS person_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES people(id),
  pipeline_id UUID NOT NULL REFERENCES pipelines(id),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS person_notes_person_pipeline_at ON person_notes (person_id, pipeline_id, created_at DESC);

ALTER TABLE activity DROP CONSTRAINT IF EXISTS activity_action_check,
  ADD CONSTRAINT activity_action_check CHECK (action IN (
    'sign_in', 'capture', 'batch_save', 'tidy', 'ask', 'act_note', 'act_stage',
    'act_details', 'act_research', 'research', 'setup', 'replace', 'host', 'key', 'profile', 'granola',
    'google_link', 'approve'
  ));

ALTER TABLE person_work ENABLE ROW LEVEL SECURITY;
ALTER TABLE person_notes ENABLE ROW LEVEL SECURITY;

INSERT INTO accounts_migrations (version) VALUES (4) ON CONFLICT DO NOTHING;

-- Version 5: a person's own Granola key (read-only, used by Ask). Encrypted like the Claude key, under
-- the field name granola:<person id>. The status is the result of the last real Granola call (NULL
-- with a key on file: tested when it was saved). Every action list above also names 'granola', for
-- the same reason as 'profile'.
ALTER TABLE people ADD COLUMN IF NOT EXISTS granola_key_enc TEXT NULL;
ALTER TABLE people ADD COLUMN IF NOT EXISTS granola_status TEXT NULL;
ALTER TABLE people DROP CONSTRAINT IF EXISTS people_granola_status_check,
  ADD CONSTRAINT people_granola_status_check CHECK (granola_status IN ('ok', 'key_rejected', 'no_access'));
ALTER TABLE people ADD COLUMN IF NOT EXISTS granola_checked_at TIMESTAMPTZ NULL;
ALTER TABLE people ADD COLUMN IF NOT EXISTS granola_key_set_at TIMESTAMPTZ NULL;

ALTER TABLE activity DROP CONSTRAINT IF EXISTS activity_action_check,
  ADD CONSTRAINT activity_action_check CHECK (action IN (
    'sign_in', 'capture', 'batch_save', 'tidy', 'ask', 'act_note', 'act_stage',
    'act_details', 'act_research', 'research', 'setup', 'replace', 'host', 'key', 'profile', 'granola',
    'google_link', 'approve'
  ));

INSERT INTO accounts_migrations (version) VALUES (5) ON CONFLICT DO NOTHING;

-- Version 6: sign up with Google. A request waits in signups until it is approved or declined (a
-- status change; nothing is ever removed). Matching is on Google's permanent account id (google_sub)
-- only, never on an email. A person who signed up with Google has no passcode, so passcode_hash may
-- be NULL (the code screen skips such a person). A pipeline hosted in the shared database names its
-- schema there. Every action list above also names 'google_link' and 'approve', for the same reason
-- as 'profile' and 'granola'. A request whose Google id was linked to a person who already had an
-- account (they tapped Sign in with Google before linking) is marked 'linked': it is kept, but it
-- no longer waits, can never be approved or re-opened, and does not count as waiting.
CREATE TABLE IF NOT EXISTS signups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'linked')),
  customer_id UUID NULL REFERENCES customers(id),
  address_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS signups_address_at ON signups (address_hash, created_at);
CREATE INDEX IF NOT EXISTS signups_status_at ON signups (status, created_at DESC);
ALTER TABLE signups ENABLE ROW LEVEL SECURITY;
-- The same check again by name, for a signups table made before 'linked' was in the list.
ALTER TABLE signups DROP CONSTRAINT IF EXISTS signups_status_check,
  ADD CONSTRAINT signups_status_check CHECK (status IN ('pending', 'approved', 'declined', 'linked'));

ALTER TABLE people ADD COLUMN IF NOT EXISTS google_sub TEXT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS people_google_sub_key ON people (google_sub);
ALTER TABLE people ALTER COLUMN passcode_hash DROP NOT NULL;

ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS shared_schema TEXT NULL;

ALTER TABLE activity DROP CONSTRAINT IF EXISTS activity_action_check,
  ADD CONSTRAINT activity_action_check CHECK (action IN (
    'sign_in', 'capture', 'batch_save', 'tidy', 'ask', 'act_note', 'act_stage',
    'act_details', 'act_research', 'research', 'setup', 'replace', 'host', 'key', 'profile', 'granola',
    'google_link', 'approve'
  ));

INSERT INTO accounts_migrations (version) VALUES (6) ON CONFLICT DO NOTHING;

-- Version 7: the free trial. A customer made by an approved sign-up is given a number of AI uses
-- (trial_uses_limit); a customer with NULL there never has a trial. The clock (trial_started_at,
-- trial_ends_at) starts at the person's first sign-in after approval. Each AI request on the trial
-- is one row in trial_uses, written before Claude is called. The trial runs on one key held by the
-- server (never stored here); trial_key_health is the result of its last real call, in one row, so
-- its failures are never written onto a customer.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS trial_uses_limit INT NULL;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMPTZ NULL;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ NULL;

CREATE TABLE IF NOT EXISTS trial_uses (
  id BIGSERIAL PRIMARY KEY,
  customer_id UUID NOT NULL REFERENCES customers(id),
  person_id UUID NULL,
  kind TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trial_uses_customer ON trial_uses (customer_id);
ALTER TABLE trial_uses ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS trial_key_health (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  status TEXT NOT NULL CHECK (status IN ('ok', 'key_rejected', 'no_credit')),
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE trial_key_health ENABLE ROW LEVEL SECURITY;

INSERT INTO accounts_migrations (version) VALUES (7) ON CONFLICT DO NOTHING;
