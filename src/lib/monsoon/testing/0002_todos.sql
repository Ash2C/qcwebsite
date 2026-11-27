-- Copied from quantcloud core by scripts/monsoon/gen_rule_fixtures.py. Do not edit.
-- Canonical CRM schema, version 2: to-dos. The to-do table is the single source of truth for
-- what to do next; `members.next_action` and `next_action_date` stay as a mirror of each
-- member's earliest open to-do, and a direct write to them is turned into to-do changes.
-- Everything here is safe to run twice and names no schema.

ALTER TABLE members ADD COLUMN IF NOT EXISTS nudge_after DATE;

CREATE TABLE IF NOT EXISTS todos (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title           TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 300),
    due_date        DATE,
    first_due_date  DATE,
    moved_count     INTEGER NOT NULL DEFAULT 0,
    member_id       UUID REFERENCES members(id) ON DELETE SET NULL,
    about_person_id UUID REFERENCES people(id)  ON DELETE SET NULL,
    owner           TEXT REFERENCES owners(key),
    status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dropped')),
    outcome         TEXT CHECK (outcome IS NULL OR length(outcome) <= 2000),
    closed_at       TIMESTAMPTZ,
    source          TEXT NOT NULL CHECK (source IN ('app', 'ask', 'notes', 'next', 'migrated', 'core')),
    -- clock_timestamp: undated to-dos order by creation time, also within one transaction.
    created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_todos_status_due  ON todos (status, due_date);
CREATE INDEX IF NOT EXISTS idx_todos_member_open ON todos (member_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_todos_owner_open  ON todos (owner) WHERE status = 'open';

ALTER TABLE todos ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_todos_updated ON todos;
CREATE TRIGGER trg_todos_updated BEFORE UPDATE ON todos
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Date history and close time: first_due_date is the first date ever given, moved_count counts
-- the pushes later, closed_at marks done or dropped and is cleared on reopen.
CREATE OR REPLACE FUNCTION todos_dates() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.first_due_date := NEW.due_date;
        IF NEW.status IN ('done', 'dropped') AND NEW.closed_at IS NULL THEN
            NEW.closed_at := now();
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.first_due_date IS NULL AND NEW.due_date IS NOT NULL THEN
        NEW.first_due_date := NEW.due_date;
    END IF;
    IF OLD.due_date IS NOT NULL AND NEW.due_date IS NOT NULL AND NEW.due_date > OLD.due_date THEN
        NEW.moved_count := NEW.moved_count + 1;
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NEW.status IN ('done', 'dropped') THEN
            NEW.closed_at := now();
        ELSIF NEW.status = 'open' THEN
            NEW.closed_at := NULL;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_todos_dates ON todos;
CREATE TRIGGER trg_todos_dates BEFORE INSERT OR UPDATE ON todos
    FOR EACH ROW EXECUTE FUNCTION todos_dates();

-- The mirror: each affected member's next action becomes its earliest open to-do (dated first
-- by date, then undated by creation time), both null when none is open.
CREATE OR REPLACE FUNCTION todos_sync_member() RETURNS TRIGGER AS $$
DECLARE
    mid       UUID;
    new_title TEXT;
    new_due   DATE;
BEGIN
    FOREACH mid IN ARRAY ARRAY[NEW.member_id,
                               CASE WHEN TG_OP = 'UPDATE' AND OLD.member_id IS DISTINCT FROM NEW.member_id
                                    THEN OLD.member_id END]
    LOOP
        CONTINUE WHEN mid IS NULL;
        new_title := NULL;
        new_due := NULL;
        SELECT t.title, t.due_date INTO new_title, new_due
          FROM todos t
         WHERE t.member_id = mid AND t.status = 'open'
         ORDER BY t.due_date NULLS LAST, t.created_at, t.id
         LIMIT 1;
        UPDATE members
           SET next_action = new_title, next_action_date = new_due
         WHERE id = mid
           AND (next_action IS DISTINCT FROM new_title OR next_action_date IS DISTINCT FROM new_due);
    END LOOP;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_todos_sync_member ON todos;
CREATE TRIGGER trg_todos_sync_member AFTER INSERT OR UPDATE OF status, title, due_date, member_id ON todos
    FOR EACH ROW EXECUTE FUNCTION todos_sync_member();

-- A direct write to members.next_action (old code) becomes to-do changes. pg_trigger_depth() is
-- 1 for a write made by a statement and higher when the mirror trigger above made it, which
-- this guard leaves alone. Blank or null text counts as cleared.
CREATE OR REPLACE FUNCTION members_next_action_guard() RETURNS TRIGGER AS $$
DECLARE
    earliest UUID;
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND NEW.next_action IS NOT DISTINCT FROM OLD.next_action
       AND NEW.next_action_date IS NOT DISTINCT FROM OLD.next_action_date THEN
        RETURN NEW;
    END IF;
    SELECT t.id INTO earliest
      FROM todos t
     WHERE t.member_id = NEW.id AND t.status = 'open'
     ORDER BY t.due_date NULLS LAST, t.created_at, t.id
     LIMIT 1;
    IF btrim(coalesce(NEW.next_action, '')) <> '' THEN
        IF earliest IS NOT NULL THEN
            UPDATE todos SET title = left(btrim(NEW.next_action), 300), due_date = NEW.next_action_date
             WHERE id = earliest;
        ELSE
            INSERT INTO todos (title, due_date, member_id, owner, source)
            VALUES (left(btrim(NEW.next_action), 300), NEW.next_action_date, NEW.id, NEW.owner, 'core');
        END IF;
    ELSIF earliest IS NOT NULL THEN
        UPDATE todos SET status = 'dropped' WHERE id = earliest;
    ELSIF NEW.next_action IS NOT NULL OR NEW.next_action_date IS NOT NULL THEN
        -- Cleared with no open to-do: a stray date or blank text must not stay on the mirror.
        UPDATE members SET next_action = NULL, next_action_date = NULL WHERE id = NEW.id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_members_next_action ON members;
CREATE TRIGGER trg_members_next_action AFTER INSERT OR UPDATE OF next_action, next_action_date ON members
    FOR EACH ROW EXECUTE FUNCTION members_next_action_guard();

-- Existing next actions become open to-dos, once: a member that already has an open to-do is
-- skipped, so running this file again adds nothing.
INSERT INTO todos (title, due_date, member_id, owner, source)
SELECT left(btrim(m.next_action), 300), m.next_action_date, m.id, m.owner, 'migrated'
  FROM members m
 WHERE btrim(coalesce(m.next_action, '')) <> ''
   AND NOT EXISTS (SELECT 1 FROM todos t WHERE t.member_id = m.id AND t.status = 'open');

-- A blank text or a date with no text stood for no next action; clear it so the mirror holds
-- only what an open to-do says. Members with an open to-do are already in step.
UPDATE members m SET next_action = NULL, next_action_date = NULL
 WHERE btrim(coalesce(m.next_action, '')) = ''
   AND (m.next_action IS NOT NULL OR m.next_action_date IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM todos t WHERE t.member_id = m.id AND t.status = 'open');
