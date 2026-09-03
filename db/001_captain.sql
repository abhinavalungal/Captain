-- ============================================================================
--  Captain — migration 001
--  Creates the two tables Captain owns, plus the two database roles it uses.
--  Safe to run against an existing database: it touches nothing else.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Learned vocabulary. This is the ONLY table Captain ever writes operational
-- meaning into, and it stores words, never measurements.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS captain_term_mappings (
  id              BIGSERIAL PRIMARY KEY,
  org_id          TEXT        NOT NULL,
  term            TEXT        NOT NULL,
  term_normalized TEXT        NOT NULL,
  metric_key      TEXT        NOT NULL,
  active          BOOLEAN     NOT NULL DEFAULT TRUE,
  hit_count       INTEGER     NOT NULL DEFAULT 0,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at    TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS captain_term_mappings_key
  ON captain_term_mappings (org_id, term_normalized);

CREATE INDEX IF NOT EXISTS captain_term_mappings_active
  ON captain_term_mappings (org_id) WHERE active;

-- ---------------------------------------------------------------------------
-- Query log. Its real job is to show you which questions Captain could not
-- parse, so you can add the missing alias instead of guessing at vocabulary.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS captain_query_log (
  id         BIGSERIAL PRIMARY KEY,
  org_id     TEXT,
  user_id    TEXT,
  question   TEXT        NOT NULL,
  outcome    TEXT        NOT NULL,  -- answered | empty | clarify | unsupported | unparsed
  detail     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS captain_query_log_outcome
  ON captain_query_log (outcome, created_at DESC);

COMMIT;

-- ============================================================================
--  Roles
--
--  captain_reader — used for every question. SELECT only, on exactly the
--                   tables in your registry. It cannot write anything, so a
--                   bug in Captain cannot corrupt operational data.
--
--  captain_writer — used only for vocabulary and logging. It can write to
--                   the two tables above and nothing else.
--
--  Set the passwords before running, and give each role its own connection
--  string in the environment (CAPTAIN_READ_URL / CAPTAIN_WRITE_URL).
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'captain_reader') THEN
    CREATE ROLE captain_reader LOGIN PASSWORD 'CHANGE_ME_READER';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'captain_writer') THEN
    CREATE ROLE captain_writer LOGIN PASSWORD 'CHANGE_ME_WRITER';
  END IF;
END
$$;

-- Reader: connect and look, nothing more.
GRANT CONNECT ON DATABASE CURRENT_DATABASE_PLACEHOLDER TO captain_reader;
GRANT USAGE ON SCHEMA public TO captain_reader;

-- Data-table grants live in db/002_veson_geoform.sql, next to the tables.
GRANT SELECT ON captain_term_mappings TO captain_reader;

-- Belt and braces: even if a GRANT is added by mistake later, the role
-- itself cannot write.
ALTER ROLE captain_reader SET default_transaction_read_only = on;
ALTER ROLE captain_reader SET statement_timeout = '8s';
ALTER ROLE captain_reader SET idle_in_transaction_session_timeout = '15s';

-- Writer: vocabulary and logging only.
GRANT CONNECT ON DATABASE CURRENT_DATABASE_PLACEHOLDER TO captain_writer;
GRANT USAGE ON SCHEMA public TO captain_writer;
GRANT SELECT, INSERT, UPDATE ON captain_term_mappings TO captain_writer;
GRANT SELECT, INSERT           ON captain_query_log   TO captain_writer;
GRANT USAGE, SELECT ON SEQUENCE captain_term_mappings_id_seq TO captain_writer;
GRANT USAGE, SELECT ON SEQUENCE captain_query_log_id_seq     TO captain_writer;
ALTER ROLE captain_writer SET statement_timeout = '5s';

-- ============================================================================
--  Optional: row-level security as a second line of defence.
--
--  Captain always filters by vessel id in the query itself. Enabling RLS as
--  well means a missing filter fails closed rather than leaking. Uncomment
--  once you have decided how to pass the caller's scope
--  (SET LOCAL captain.vessel_ids = '...') on each connection.
-- ============================================================================
--
-- ALTER TABLE noon_reports ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY captain_scope ON noon_reports FOR SELECT TO captain_reader
--   USING (vessel_id::text = ANY (string_to_array(current_setting('captain.vessel_ids', true), ',')));
