-- Copied from quantcloud core by scripts/monsoon/gen_rule_fixtures.py. Do not edit.
-- Canonical CRM schema, version 1. Applied by `py -3.13 -m quantcloud.crm <estate> migrate`.
-- Estate vocabulary (stages, roles, owners) lives in lookup tables that `migrate` reconciles
-- with the estate manifest; nothing in this file names an estate's values.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stages (
    key      TEXT PRIMARY KEY,
    ord      INTEGER NOT NULL,
    label    TEXT NOT NULL,
    terminal BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS roles (
    key   TEXT PRIMARY KEY,
    label TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS owners (
    key          TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    email        TEXT
);

CREATE TABLE IF NOT EXISTS orgs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name         TEXT NOT NULL,
    name_key     TEXT NOT NULL UNIQUE,
    country      TEXT,
    org_type     TEXT,
    aum_usd      NUMERIC(16,2),
    website      TEXT,
    notes        TEXT,
    source       TEXT NOT NULL,
    external_ref TEXT,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS people (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id           UUID REFERENCES orgs(id) ON DELETE SET NULL,
    name             TEXT NOT NULL,
    name_key         TEXT NOT NULL,
    title            TEXT,
    email            TEXT,
    email_confidence TEXT,
    phone            TEXT,
    linkedin_url     TEXT,
    country          TEXT,
    notes            TEXT,
    source           TEXT NOT NULL,
    external_ref     TEXT,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE NULLS NOT DISTINCT (org_id, name_key)
);

CREATE TABLE IF NOT EXISTS members (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id           UUID REFERENCES orgs(id)   ON DELETE CASCADE,
    person_id        UUID REFERENCES people(id) ON DELETE CASCADE,
    role             TEXT NOT NULL REFERENCES roles(key),
    stage            TEXT NOT NULL REFERENCES stages(key),
    owner            TEXT REFERENCES owners(key),
    priority         TEXT CHECK (priority IS NULL OR priority IN ('high', 'medium', 'low')),
    anchor           BOOLEAN NOT NULL DEFAULT FALSE,
    ticket_usd       NUMERIC(16,2),
    next_action      TEXT,
    next_action_date DATE,
    notes            TEXT,
    source           TEXT NOT NULL,
    external_ref     TEXT,
    mirrored_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT member_one_target CHECK (
        (org_id IS NOT NULL)::int + (person_id IS NOT NULL)::int = 1),
    UNIQUE NULLS NOT DISTINCT (org_id, person_id)
);

CREATE TABLE IF NOT EXISTS touches (
    id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    kind      TEXT NOT NULL CHECK (kind IN ('note', 'email', 'call', 'meeting', 'stage', 'system')),
    by_whom   TEXT REFERENCES owners(key),
    summary   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
    key   TEXT PRIMARY KEY,
    label TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS member_tags (
    member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    tag_key   TEXT NOT NULL REFERENCES tags(key) ON DELETE CASCADE,
    PRIMARY KEY (member_id, tag_key)
);

-- One physical business card has one capture_id across every estate it was written to.
CREATE TABLE IF NOT EXISTS captures (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    capture_id  UUID NOT NULL,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    channel     TEXT NOT NULL,
    raw_text    TEXT,
    extracted   JSONB,
    image_ref   TEXT,
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'written', 'rejected')),
    person_id   UUID REFERENCES people(id) ON DELETE SET NULL,
    org_id      UUID REFERENCES orgs(id)   ON DELETE SET NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_members_stage    ON members (stage);
CREATE INDEX IF NOT EXISTS idx_members_owner    ON members (owner);
CREATE INDEX IF NOT EXISTS idx_members_pending  ON members (mirrored_at, updated_at);
CREATE INDEX IF NOT EXISTS idx_members_priority ON members (priority) WHERE priority IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_members_anchor   ON members (anchor) WHERE anchor;
CREATE INDEX IF NOT EXISTS idx_people_email     ON people (email);
CREATE INDEX IF NOT EXISTS idx_people_org       ON people (org_id);
CREATE INDEX IF NOT EXISTS idx_people_country   ON people (country);
CREATE INDEX IF NOT EXISTS idx_touches_member   ON touches (member_id, at);
CREATE INDEX IF NOT EXISTS idx_captures_capture ON captures (capture_id);
CREATE INDEX IF NOT EXISTS idx_captures_status  ON captures (status) WHERE status = 'pending';

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_orgs_updated ON orgs;
CREATE TRIGGER trg_orgs_updated BEFORE UPDATE ON orgs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_people_updated ON people;
CREATE TRIGGER trg_people_updated BEFORE UPDATE ON people
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_members_updated ON members;
CREATE TRIGGER trg_members_updated BEFORE UPDATE ON members
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A stage change always leaves a footprint on the timeline.
CREATE OR REPLACE FUNCTION log_stage_change() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.stage IS DISTINCT FROM OLD.stage THEN
        INSERT INTO touches (member_id, kind, by_whom, summary)
        VALUES (NEW.id, 'stage', NEW.owner, OLD.stage || ' -> ' || NEW.stage);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_members_stage ON members;
CREATE TRIGGER trg_members_stage AFTER UPDATE OF stage ON members
    FOR EACH ROW EXECUTE FUNCTION log_stage_change();

-- Service role only: RLS on, no policies, so anon and authenticated roles see nothing.
ALTER TABLE orgs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE people      ENABLE ROW LEVEL SECURITY;
ALTER TABLE members     ENABLE ROW LEVEL SECURITY;
ALTER TABLE touches     ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags        ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE captures    ENABLE ROW LEVEL SECURITY;
ALTER TABLE stages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles       ENABLE ROW LEVEL SECURITY;
ALTER TABLE owners      ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
