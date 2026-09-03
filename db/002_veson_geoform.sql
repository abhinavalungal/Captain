-- ============================================================================
--  Captain — migration 002
--  Tables that hold the synced copy of Veson IMOS and Geoform data.
--  Captain answers from these; the sync job (netlify/functions/captain-sync.js
--  or `npm run sync`) fills them.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS vessels (
  id         TEXT PRIMARY KEY,          -- the IMO number
  imo        TEXT NOT NULL,
  name       TEXT NOT NULL,
  department TEXT NOT NULL DEFAULT 'Unassigned'
);
CREATE INDEX IF NOT EXISTS vessels_department ON vessels (department);

CREATE TABLE IF NOT EXISTS veson_legs (
  id                 BIGSERIAL PRIMARY KEY,
  imo                TEXT NOT NULL,
  vessel_name        TEXT,
  voyage_no          TEXT,
  leg_no             TEXT NOT NULL DEFAULT '',
  dep_port           TEXT,
  arr_port           TEXT,
  dep_time           TIMESTAMPTZ NOT NULL,
  arr_time           TIMESTAMPTZ NOT NULL,
  leg_date           DATE NOT NULL,       -- arrival date; the day a leg is booked to
  distance_nm        DOUBLE PRECISION,
  fuel_mt            DOUBLE PRECISION,
  fuel_derived       BOOLEAN NOT NULL DEFAULT FALSE,  -- summed from per-fuel columns
  co2_mt             DOUBLE PRECISION,
  ghg_intensity      DOUBLE PRECISION,    -- gCO2e/MJ
  eu_scope_pct       DOUBLE PRECISION,
  compliance_balance DOUBLE PRECISION,
  raw                JSONB,
  synced_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (imo, dep_time, arr_time, leg_no)
);
CREATE INDEX IF NOT EXISTS veson_legs_lookup ON veson_legs (imo, leg_date);

CREATE TABLE IF NOT EXISTS veson_offhire (
  id            BIGSERIAL PRIMARY KEY,
  imo           TEXT NOT NULL,
  vessel_name   TEXT,
  voyage_no     TEXT,
  start_time    TIMESTAMPTZ NOT NULL,
  end_time      TIMESTAMPTZ,
  start_date    DATE NOT NULL,
  offhire_hours DOUBLE PRECISION,
  offhire_days  DOUBLE PRECISION,
  reason        TEXT,
  raw           JSONB,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (imo, start_time)
);
CREATE INDEX IF NOT EXISTS veson_offhire_lookup ON veson_offhire (imo, start_date);

CREATE TABLE IF NOT EXISTS geoform_reports (
  id               BIGSERIAL PRIMARY KEY,
  imo              TEXT NOT NULL,
  vessel_name      TEXT,
  form_type        TEXT NOT NULL DEFAULT 'form',
  report_time      TIMESTAMPTZ NOT NULL,
  report_date      DATE NOT NULL,
  shaft_power_kw   DOUBLE PRECISION,
  fuel_consumed_mt DOUBLE PRECISION,
  me_fuel_mt       DOUBLE PRECISION,
  ae_fuel_mt       DOUBLE PRECISION,
  distance_nm      DOUBLE PRECISION,
  speed_kn         DOUBLE PRECISION,
  me_rpm           DOUBLE PRECISION,
  co2_mt           DOUBLE PRECISION,
  raw              JSONB,
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (imo, report_time, form_type)
);
CREATE INDEX IF NOT EXISTS geoform_reports_lookup ON geoform_reports (imo, report_date);

CREATE TABLE IF NOT EXISTS captain_sync_log (
  id          BIGSERIAL PRIMARY KEY,
  started_at  TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  legs        INTEGER, offhire INTEGER, geoform INTEGER, vessels INTEGER,
  warnings    JSONB
);

COMMIT;

-- Reader: exactly the tables in src/config.js.
GRANT SELECT ON vessels, veson_legs, veson_offhire, geoform_reports TO captain_reader;

-- Writer: the sync job.
GRANT SELECT, INSERT, UPDATE ON vessels, veson_legs, veson_offhire, geoform_reports, captain_sync_log TO captain_writer;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO captain_writer;
