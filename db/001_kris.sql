-- ============================================================================
--  K.R.1.S — migration 001
--  Creates the two tables K.R.1.S owns, plus the two database roles it uses.
--  Safe to run against an existing database: it touches nothing else.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Learned vocabulary. This is the ONLY table K.R.1.S ever writes operational
-- meaning into, and it stores words, never measurements.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kris_term_mappings (
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

CREATE UNIQUE INDEX IF NOT EXISTS kris_term_mappings_key
  ON kris_term_mappings (org_id, term_normalized);

CREATE INDEX IF NOT EXISTS kris_term_mappings_active
  ON kris_term_mappings (org_id) WHERE active;

-- ---------------------------------------------------------------------------
-- Query log. Its real job is to show you which questions K.R.1.S could not
-- parse, so you can add the missing alias instead of guessing at vocabulary.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kris_query_log (
  id         BIGSERIAL PRIMARY KEY,
  org_id     TEXT,
  user_id    TEXT,
  question   TEXT        NOT NULL,
  outcome    TEXT        NOT NULL,  -- answered | empty | clarify | unsupported | unparsed
  detail     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kris_query_log_outcome
  ON kris_query_log (outcome, created_at DESC);

COMMIT;

-- ============================================================================
--  Roles
--
--  kris_reader — used for every question. SELECT only, on exactly the
--                   tables in your registry. It cannot write anything, so a
--                   bug in K.R.1.S cannot corrupt operational data.
--
--  kris_writer — used only for vocabulary and logging. It can write to
--                   the two tables above and nothing else.
--
--  Set the passwords before running, and give each role its own connection
--  string in the environment (KRIS_READ_URL / KRIS_WRITE_URL).
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kris_reader') THEN
    CREATE ROLE kris_reader LOGIN PASSWORD 'CHANGE_ME_READER';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kris_writer') THEN
    CREATE ROLE kris_writer LOGIN PASSWORD 'CHANGE_ME_WRITER';
  END IF;
END
$$;

-- Reader: connect and look, nothing more.
GRANT CONNECT ON DATABASE CURRENT_DATABASE_PLACEHOLDER TO kris_reader;
GRANT USAGE ON SCHEMA public TO kris_reader;

-- Data-table grants live in db/002_veson_geoform.sql, next to the tables.
GRANT SELECT ON kris_term_mappings TO kris_reader;

-- Belt and braces: even if a GRANT is added by mistake later, the role
-- itself cannot write.
ALTER ROLE kris_reader SET default_transaction_read_only = on;
ALTER ROLE kris_reader SET statement_timeout = '8s';
ALTER ROLE kris_reader SET idle_in_transaction_session_timeout = '15s';

-- Writer: vocabulary and logging only.
GRANT CONNECT ON DATABASE CURRENT_DATABASE_PLACEHOLDER TO kris_writer;
GRANT USAGE ON SCHEMA public TO kris_writer;
GRANT SELECT, INSERT, UPDATE ON kris_term_mappings TO kris_writer;
GRANT SELECT, INSERT           ON kris_query_log   TO kris_writer;
GRANT USAGE, SELECT ON SEQUENCE kris_term_mappings_id_seq TO kris_writer;
GRANT USAGE, SELECT ON SEQUENCE kris_query_log_id_seq     TO kris_writer;
ALTER ROLE kris_writer SET statement_timeout = '5s';

-- ============================================================================
--  Optional: row-level security as a second line of defence.
--
--  K.R.1.S always filters by vessel id in the query itself. Enabling RLS as
--  well means a missing filter fails closed rather than leaking. Uncomment
--  once you have decided how to pass the caller's scope
--  (SET LOCAL kris.vessel_ids = '...') on each connection.
-- ============================================================================
--
-- ALTER TABLE noon_reports ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY kris_scope ON noon_reports FOR SELECT TO kris_reader
--   USING (vessel_id::text = ANY (string_to_array(current_setting('kris.vessel_ids', true), ',')));
