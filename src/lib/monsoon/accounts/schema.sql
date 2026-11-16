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
    'act_details', 'act_research', 'research', 'setup', 'replace'
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
