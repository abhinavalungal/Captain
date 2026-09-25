-- ============================================================================
--  K.R.1.S — database schema
--
--  One file, for a fresh Supabase project. Run it with `node db/setup.js`
--  (which also creates the role passwords and, optionally, the test data), or
--  paste it into Supabase → SQL Editor as the `postgres` user.
--  Safe to re-run: tables are created if missing, views are replaced,
--  reference rows are upserted.
--
--  LAYOUT
--    Everything lives in the schema `kris`. Supabase's Data API only exposes
--    the schemas listed under Settings → API (public by default), so nothing
--    here can be read with the publishable/anon key. The server connects to
--    Postgres directly as one of two least-privilege roles:
--      kris_reader  SELECT on every table and view here, read-only session
--      kris_writer  the Veson/Geoform sync, vocabulary and query log only
--    Row-level security is enabled on every table as a second line: a role
--    with no policy (anon, authenticated, anything granted by mistake later)
--    sees no rows.
--
--  WHAT IS STORED AND WHAT IS DERIVED
--    Tables hold facts: vessels, voyages, port calls, daily reports, fuel by
--    type, bunker deliveries, filings, trades, allocations, invoices, emails,
--    and the regulatory parameters (emission factors, CII reference lines,
--    FuelEU targets, ETS phase-in). Everything computed from those facts —
--    voyage days, CO2, energy, GHG intensity, compliance balance, penalties,
--    AER/CII and its rating, allowance obligations, exposure, invoice status —
--    is a VIEW, so a figure can never disagree with the facts it came from.
--
--  UNITS are in the column names: _t tonnes, _nm nautical miles, _kw kW,
--    _mj megajoules, _g grams CO2e, _eur / _gbp money, _pct percent.
-- ============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS kris;
COMMENT ON SCHEMA kris IS 'K.R.1.S vessel, voyage, emissions, compliance and commercial data. Not exposed through the Supabase Data API.';

-- ============================================================================
--  1. Reference data
-- ============================================================================

-- Owners, managers, charterers, GeoServe customers, trading counterparties,
-- verifiers, bunker suppliers — one table, a company can play several roles.
CREATE TABLE IF NOT EXISTS kris.companies (
  id            text PRIMARY KEY CHECK (id ~ '^[A-Z0-9][A-Z0-9-]{1,31}$'),
  name          text NOT NULL,
  roles         text[] NOT NULL DEFAULT '{}'
                CHECK (roles <@ ARRAY['owner','manager','charterer','customer','counterparty','verifier','supplier']::text[]),
  country_code  char(2),
  email_domain  text,
  is_test       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- region decides regulatory scope: EEA (EU MRV, EU ETS, FuelEU), UK (UK ETS).
CREATE TABLE IF NOT EXISTS kris.ports (
  locode        char(5) PRIMARY KEY CHECK (locode ~ '^[A-Z]{2}[A-Z0-9]{3}$'),
  name          text NOT NULL,
  country_code  char(2) NOT NULL,
  country       text NOT NULL,
  region        text NOT NULL CHECK (region IN ('EEA', 'UK', 'OTHER')),
  in_eca        boolean NOT NULL DEFAULT false,   -- inside an emission control area (0.10% sulphur)
  latitude      numeric(8,5),
  longitude     numeric(8,5)
);

-- Emission factors. cf_* are tonnes of gas per tonne of fuel (MARPOL Annex VI,
-- EU MRV); lcv, wtt and slip are the FuelEU Maritime Annex II defaults.
CREATE TABLE IF NOT EXISTS kris.fuel_types (
  code              text PRIMARY KEY CHECK (code ~ '^[A-Z0-9_]{2,16}$'),
  name              text NOT NULL,
  imo_class         text NOT NULL,
  lcv_mj_per_t      numeric NOT NULL CHECK (lcv_mj_per_t > 0),
  cf_co2            numeric NOT NULL CHECK (cf_co2 >= 0),
  cf_ch4            numeric NOT NULL DEFAULT 0 CHECK (cf_ch4 >= 0),
  cf_n2o            numeric NOT NULL DEFAULT 0 CHECK (cf_n2o >= 0),
  slip_pct          numeric NOT NULL DEFAULT 0 CHECK (slip_pct BETWEEN 0 AND 100),
  wtt_gco2e_per_mj  numeric NOT NULL,
  is_renewable      boolean NOT NULL DEFAULT false,
  factor_source     text NOT NULL
);

-- CII reference lines (IMO MEPC.353(78)) and rating boundaries (MEPC.354(78)).
-- Add a row per ship type your fleet has; the CII view reads only this table.
CREATE TABLE IF NOT EXISTS kris.cii_ship_types (
  ship_type       text PRIMARY KEY CHECK (ship_type ~ '^[a-z_]{3,40}$'),
  label           text NOT NULL,
  capacity_basis  text NOT NULL CHECK (capacity_basis IN ('DWT', 'GT')),
  capacity_cap    numeric CHECK (capacity_cap > 0),   -- capacity used is LEAST(capacity, cap) where the guideline caps it
  a               numeric NOT NULL CHECK (a > 0),
  c               numeric NOT NULL CHECK (c >= 0),
  d1 numeric NOT NULL, d2 numeric NOT NULL, d3 numeric NOT NULL, d4 numeric NOT NULL,
  source          text NOT NULL,
  CHECK (d1 < d2 AND d2 < 1 AND 1 < d3 AND d3 < d4)
);

-- Required-CII reduction below the 2019 reference line (MEPC.338(76)).
CREATE TABLE IF NOT EXISTS kris.cii_reduction_factors (
  year           smallint PRIMARY KEY CHECK (year >= 2023),
  reduction_pct  numeric NOT NULL CHECK (reduction_pct BETWEEN 0 AND 100),
  source         text NOT NULL
);

-- FuelEU Maritime GHG-intensity limits (Regulation (EU) 2023/1805, Art. 4 and Annex IV).
CREATE TABLE IF NOT EXISTS kris.fueleu_targets (
  from_year                 smallint PRIMARY KEY CHECK (from_year >= 2025),
  to_year                   smallint NOT NULL,
  reduction_pct             numeric NOT NULL CHECK (reduction_pct BETWEEN 0 AND 100),
  reference_gco2e_per_mj    numeric NOT NULL DEFAULT 91.16,
  penalty_eur_per_t_vlsfo   numeric NOT NULL DEFAULT 2400,
  vlsfo_mj_per_t            numeric NOT NULL DEFAULT 41000,
  CHECK (to_year >= from_year)
);

-- EU ETS and UK ETS maritime: what share of a year's emissions must be
-- surrendered, which gases count, and by when.
CREATE TABLE IF NOT EXISTS kris.ets_years (
  scheme              text NOT NULL CHECK (scheme IN ('EU_ETS', 'UK_ETS')),
  year                smallint NOT NULL,
  in_scope_from       date NOT NULL,
  surrender_pct       numeric NOT NULL CHECK (surrender_pct BETWEEN 0 AND 100),
  gases               text NOT NULL CHECK (gases IN ('CO2', 'CO2e')),
  surrender_deadline  date NOT NULL,
  PRIMARY KEY (scheme, year)
);

-- Sea distance between two ports on the usual route, for distance to go and ETA.
CREATE TABLE IF NOT EXISTS kris.route_distances (
  from_port  char(5) NOT NULL REFERENCES kris.ports (locode),
  to_port    char(5) NOT NULL REFERENCES kris.ports (locode),
  nm         numeric NOT NULL CHECK (nm > 0),
  PRIMARY KEY (from_port, to_port),
  CHECK (from_port <> to_port)
);

-- ============================================================================
--  2. Vessels
-- ============================================================================

-- id is the IMO number as text: every data table, the Veson/Geoform sync and
-- access control (department) key on it.
CREATE TABLE IF NOT EXISTS kris.vessels (
  id                     text PRIMARY KEY,
  imo                    text NOT NULL UNIQUE,
  name                   text NOT NULL,
  department             text NOT NULL DEFAULT 'Emission',
  vessel_code            text UNIQUE,
  ship_type              text REFERENCES kris.cii_ship_types (ship_type),
  vessel_type            text,
  flag                   text,
  owner_id               text REFERENCES kris.companies (id),
  manager_id             text REFERENCES kris.companies (id),
  charterer_id           text REFERENCES kris.companies (id),
  customer_id            text REFERENCES kris.companies (id),
  gross_tonnage          integer CHECK (gross_tonnage > 0),
  net_tonnage            integer CHECK (net_tonnage > 0),
  deadweight_t           integer CHECK (deadweight_t > 0),
  cargo_capacity         numeric CHECK (cargo_capacity > 0),
  cargo_capacity_unit    text CHECK (cargo_capacity_unit IN ('m3', 'TEU', 't', 'CEU')),
  main_engine            text,
  main_engine_cylinders  smallint CHECK (main_engine_cylinders > 0),
  main_engine_mcr_kw     integer CHECK (main_engine_mcr_kw > 0),
  main_engine_rpm        integer CHECK (main_engine_rpm > 0),
  aux_engines            text,
  scrubber               text CHECK (scrubber IN ('none', 'open_loop', 'closed_loop', 'hybrid')),
  dual_fuel              boolean NOT NULL DEFAULT false,
  year_built             smallint CHECK (year_built BETWEEN 1950 AND 2100),
  builder                text,
  class_society          text,
  design_speed_kn        numeric CHECK (design_speed_kn > 0),
  reference_speed_kn     numeric CHECK (reference_speed_kn > 0),
  is_test                boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (net_tonnage IS NULL OR gross_tonnage IS NULL OR net_tonnage <= gross_tonnage)
);
CREATE INDEX IF NOT EXISTS vessels_department ON kris.vessels (department);

CREATE TABLE IF NOT EXISTS kris.vessel_fuel_types (
  vessel_id  text NOT NULL REFERENCES kris.vessels (id) ON DELETE CASCADE,
  fuel_code  text NOT NULL REFERENCES kris.fuel_types (code),
  usage      text NOT NULL CHECK (usage IN ('main', 'pilot', 'eca', 'port', 'backup')),
  opening_rob_t  numeric CHECK (opening_rob_t >= 0),   -- on board when the data starts; fuel on board is derived from it
  opening_at     timestamptz,
  PRIMARY KEY (vessel_id, fuel_code)
);
ALTER TABLE kris.vessel_fuel_types ADD COLUMN IF NOT EXISTS opening_rob_t numeric CHECK (opening_rob_t >= 0);
ALTER TABLE kris.vessel_fuel_types ADD COLUMN IF NOT EXISTS opening_at timestamptz;

-- ============================================================================
--  3. Voyages and port calls
--
--  A voyage is one passage and the stay at its destination: it starts when
--  the vessel leaves from_port and ends when it leaves to_port, which is when
--  the next voyage starts. Arrival, port time, sea time, net days and status
--  are derived (kris.voyage_summary).
-- ============================================================================

CREATE TABLE IF NOT EXISTS kris.voyages (
  id            bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  vessel_id     text NOT NULL REFERENCES kris.vessels (id) ON DELETE CASCADE,
  voyage_no     text NOT NULL,
  voyage_ref    text NOT NULL UNIQUE,
  from_port     char(5) NOT NULL REFERENCES kris.ports (locode),
  to_port       char(5) NOT NULL REFERENCES kris.ports (locode),
  departure_at  timestamptz NOT NULL,
  leg_type      text NOT NULL CHECK (leg_type IN ('laden', 'ballast')),
  cargo         text,
  cargo_qty_t   numeric CHECK (cargo_qty_t > 0),
  charterer_id  text REFERENCES kris.companies (id),
  UNIQUE (vessel_id, voyage_no),
  UNIQUE (vessel_id, id),
  CHECK (from_port <> to_port),
  CHECK ((leg_type = 'laden') = (cargo_qty_t IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS voyages_vessel_departure ON kris.voyages (vessel_id, departure_at DESC);

CREATE TABLE IF NOT EXISTS kris.port_calls (
  id                   bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  voyage_id            bigint NOT NULL REFERENCES kris.voyages (id) ON DELETE CASCADE,
  locode               char(5) NOT NULL REFERENCES kris.ports (locode),
  purpose              text NOT NULL CHECK (purpose IN ('load', 'discharge', 'bunkering', 'repairs', 'orders', 'canal')),
  arrival_at           timestamptz NOT NULL,
  berthed_at           timestamptz,
  departure_at         timestamptz,                 -- null while the vessel is still in port
  distance_in_port_nm  numeric NOT NULL DEFAULT 0 CHECK (distance_in_port_nm >= 0),
  UNIQUE (voyage_id, arrival_at),
  CHECK (departure_at IS NULL OR departure_at > arrival_at),
  CHECK (berthed_at IS NULL OR (berthed_at >= arrival_at AND (departure_at IS NULL OR berthed_at <= departure_at)))
);
CREATE INDEX IF NOT EXISTS port_calls_voyage ON kris.port_calls (voyage_id);

-- ============================================================================
--  4. Synced operational data (Veson IMOS, Geoform) — written by the sync job
--
--  Column-compatible with the sync in src/integrations/sync.js, which writes
--  vessel rows after report rows and does not normalise IMO numbers, so these
--  tables deliberately carry no foreign key to kris.vessels. The canonical
--  additions to geoform_reports (voyage, mode, hours, boiler fuel) are
--  optional: the sync leaves them NULL.
-- ============================================================================

CREATE TABLE IF NOT EXISTS kris.geoform_reports (
  id               bigserial PRIMARY KEY,
  imo              text NOT NULL,
  vessel_name      text,
  form_type        text NOT NULL DEFAULT 'form',
  report_time      timestamptz NOT NULL,
  report_date      date NOT NULL,
  shaft_power_kw   double precision,
  fuel_consumed_mt double precision,
  me_fuel_mt       double precision,
  ae_fuel_mt       double precision,
  distance_nm      double precision,
  speed_kn         double precision,
  me_rpm           double precision,
  co2_mt           double precision,
  raw              jsonb,
  synced_at        timestamptz NOT NULL DEFAULT now(),
  voyage_id        bigint,
  mode             text CHECK (mode IN ('sea', 'port')),
  hours_underway   double precision CHECK (hours_underway BETWEEN 0 AND 25),
  boiler_fuel_mt   double precision CHECK (boiler_fuel_mt >= 0),
  latitude         numeric(8,5) CHECK (latitude BETWEEN -90 AND 90),
  longitude        numeric(8,5) CHECK (longitude BETWEEN -180 AND 180),
  course_deg       smallint CHECK (course_deg BETWEEN 0 AND 359),
  wind_force_bft   smallint CHECK (wind_force_bft BETWEEN 0 AND 12),
  UNIQUE (imo, report_time, form_type),
  FOREIGN KEY (imo, voyage_id) REFERENCES kris.voyages (vessel_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS geoform_reports_lookup ON kris.geoform_reports (imo, report_date);
CREATE INDEX IF NOT EXISTS geoform_reports_voyage ON kris.geoform_reports (voyage_id) WHERE voyage_id IS NOT NULL;
-- Added after the first release of this file; a no-op on a fresh database.
ALTER TABLE kris.geoform_reports ADD COLUMN IF NOT EXISTS latitude numeric(8,5) CHECK (latitude BETWEEN -90 AND 90);
ALTER TABLE kris.geoform_reports ADD COLUMN IF NOT EXISTS longitude numeric(8,5) CHECK (longitude BETWEEN -180 AND 180);
ALTER TABLE kris.geoform_reports ADD COLUMN IF NOT EXISTS course_deg smallint CHECK (course_deg BETWEEN 0 AND 359);
ALTER TABLE kris.geoform_reports ADD COLUMN IF NOT EXISTS wind_force_bft smallint CHECK (wind_force_bft BETWEEN 0 AND 12);

CREATE TABLE IF NOT EXISTS kris.veson_legs (
  id                 bigserial PRIMARY KEY,
  imo                text NOT NULL,
  vessel_name        text,
  voyage_no          text,
  leg_no             text NOT NULL DEFAULT '',
  dep_port           text,
  arr_port           text,
  dep_time           timestamptz NOT NULL,
  arr_time           timestamptz NOT NULL,
  leg_date           date NOT NULL,
  distance_nm        double precision,
  fuel_mt            double precision,
  fuel_derived       boolean NOT NULL DEFAULT false,
  co2_mt             double precision,
  ghg_intensity      double precision,
  eu_scope_pct       double precision,
  compliance_balance double precision,
  raw                jsonb,
  synced_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (imo, dep_time, arr_time, leg_no)
);
CREATE INDEX IF NOT EXISTS veson_legs_lookup ON kris.veson_legs (imo, leg_date);

-- Off-hire events. voyage_no ties an event to kris.voyages.
CREATE TABLE IF NOT EXISTS kris.veson_offhire (
  id            bigserial PRIMARY KEY,
  imo           text NOT NULL,
  vessel_name   text,
  voyage_no     text,
  start_time    timestamptz NOT NULL,
  end_time      timestamptz,
  start_date    date NOT NULL,
  offhire_hours double precision CHECK (offhire_hours >= 0),
  offhire_days  double precision CHECK (offhire_days >= 0),
  reason        text,
  raw           jsonb,
  synced_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (imo, start_time)
);
CREATE INDEX IF NOT EXISTS veson_offhire_lookup ON kris.veson_offhire (imo, start_date);

CREATE TABLE IF NOT EXISTS kris.kris_sync_log (
  id          bigserial PRIMARY KEY,
  started_at  timestamptz NOT NULL,
  finished_at timestamptz,
  legs integer, offhire integer, geoform integer, vessels integer,
  warnings    jsonb
);

-- ============================================================================
--  5. Fuel and bunkers
-- ============================================================================

CREATE TABLE IF NOT EXISTS kris.bunker_deliveries (
  id              bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  bdn_no          text NOT NULL UNIQUE,
  vessel_id       text NOT NULL REFERENCES kris.vessels (id) ON DELETE CASCADE,
  voyage_id       bigint,
  locode          char(5) NOT NULL REFERENCES kris.ports (locode),
  delivered_at    timestamptz NOT NULL,
  fuel_code       text NOT NULL REFERENCES kris.fuel_types (code),
  quantity_t      numeric NOT NULL CHECK (quantity_t > 0),
  sulphur_pct     numeric CHECK (sulphur_pct BETWEEN 0 AND 4),
  density_kg_m3   numeric CHECK (density_kg_m3 BETWEEN 400 AND 1100),
  supplier_id     text REFERENCES kris.companies (id),
  status          text NOT NULL CHECK (status IN ('requested', 'received', 'verified', 'disputed')),
  received_at     timestamptz,
  verified_at     timestamptz,
  FOREIGN KEY (vessel_id, voyage_id) REFERENCES kris.voyages (vessel_id, id),
  CHECK ((status = 'requested') = (received_at IS NULL)),
  CHECK ((status = 'verified') = (verified_at IS NOT NULL)),
  CHECK (verified_at IS NULL OR verified_at >= received_at)
);
CREATE INDEX IF NOT EXISTS bunker_deliveries_vessel ON kris.bunker_deliveries (vessel_id, delivered_at DESC);

-- Fuel burned per daily report, per fuel type and consumer.
CREATE TABLE IF NOT EXISTS kris.fuel_consumption (
  id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  report_id  bigint NOT NULL REFERENCES kris.geoform_reports (id) ON DELETE CASCADE,
  fuel_code  text NOT NULL REFERENCES kris.fuel_types (code),
  me_t       numeric NOT NULL DEFAULT 0 CHECK (me_t >= 0),
  ae_t       numeric NOT NULL DEFAULT 0 CHECK (ae_t >= 0),
  boiler_t   numeric NOT NULL DEFAULT 0 CHECK (boiler_t >= 0),
  total_t    numeric GENERATED ALWAYS AS (me_t + ae_t + boiler_t) STORED,
  UNIQUE (report_id, fuel_code),
  CHECK (me_t + ae_t + boiler_t > 0)
);

-- ============================================================================
--  6. Regulatory flexibility, filings, allowances
-- ============================================================================

-- CII corrections and voyage adjustments (MEPC.355(78)) a vessel has claimed.
CREATE TABLE IF NOT EXISTS kris.cii_adjustments (
  id                     bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  vessel_id              text NOT NULL REFERENCES kris.vessels (id) ON DELETE CASCADE,
  year                   smallint NOT NULL,
  co2_deduction_t        numeric NOT NULL DEFAULT 0 CHECK (co2_deduction_t >= 0),
  distance_deduction_nm  numeric NOT NULL DEFAULT 0 CHECK (distance_deduction_nm >= 0),
  reason                 text NOT NULL,
  reference              text,
  UNIQUE (vessel_id, year, reason)
);

CREATE TABLE IF NOT EXISTS kris.fueleu_pools (
  id             text PRIMARY KEY,
  year           smallint NOT NULL,
  name           text NOT NULL,
  manager_id     text REFERENCES kris.companies (id),
  verifier_id    text REFERENCES kris.companies (id),
  status         text NOT NULL CHECK (status IN ('forming', 'registered', 'verified')),
  registered_at  timestamptz
);

-- Banking, borrowing and pooling applied to a vessel's annual FuelEU balance.
CREATE TABLE IF NOT EXISTS kris.fueleu_flexibility (
  vessel_id        text NOT NULL REFERENCES kris.vessels (id) ON DELETE CASCADE,
  year             smallint NOT NULL,
  banked_in_g      numeric NOT NULL DEFAULT 0 CHECK (banked_in_g >= 0),    -- surplus banked in an earlier period, used here
  borrowed_g       numeric NOT NULL DEFAULT 0 CHECK (borrowed_g >= 0),     -- advance balance borrowed from the next period
  banked_out_g     numeric NOT NULL DEFAULT 0 CHECK (banked_out_g >= 0),   -- surplus carried to the next period
  pool_id          text REFERENCES kris.fueleu_pools (id),
  pool_transfer_g  numeric NOT NULL DEFAULT 0,                             -- + received from the pool, - given to it
  PRIMARY KEY (vessel_id, year),
  CHECK (pool_id IS NOT NULL OR pool_transfer_g = 0)
);

CREATE TABLE IF NOT EXISTS kris.compliance_filings (
  id                   bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  vessel_id            text NOT NULL REFERENCES kris.vessels (id) ON DELETE CASCADE,
  regime               text NOT NULL CHECK (regime IN ('IMO_DCS', 'EU_MRV', 'EU_ETS', 'UK_ETS', 'FUELEU', 'CII', 'SEEMP_I', 'SEEMP_II', 'SEEMP_III')),
  period_year          smallint,
  document             text NOT NULL,
  submission_status    text NOT NULL CHECK (submission_status IN ('not_started', 'in_preparation', 'submitted', 'accepted', 'rejected')),
  verification_status  text NOT NULL CHECK (verification_status IN ('not_required', 'pending', 'in_review', 'verified', 'rejected')),
  due_date             date,
  submitted_at         timestamptz,
  verified_at          timestamptz,
  approved_at          date,
  next_review_at       date,
  verifier_id          text REFERENCES kris.companies (id),
  reference            text,
  notes                text,
  UNIQUE NULLS NOT DISTINCT (vessel_id, regime, period_year, document),
  CHECK ((submitted_at IS NULL) = (submission_status IN ('not_started', 'in_preparation'))),
  CHECK ((verified_at IS NOT NULL) = (verification_status = 'verified'))
);
CREATE INDEX IF NOT EXISTS compliance_filings_vessel ON kris.compliance_filings (vessel_id, regime, period_year);

CREATE TABLE IF NOT EXISTS kris.allowance_surrenders (
  id               bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  vessel_id        text NOT NULL REFERENCES kris.vessels (id) ON DELETE CASCADE,
  scheme           text NOT NULL,
  obligation_year  smallint NOT NULL,
  quantity         integer NOT NULL CHECK (quantity > 0),
  surrendered_at   timestamptz NOT NULL,
  registry_ref     text NOT NULL UNIQUE,
  FOREIGN KEY (scheme, obligation_year) REFERENCES kris.ets_years (scheme, year)
);

-- ============================================================================
--  7. Carbon trading and invoicing
-- ============================================================================

CREATE TABLE IF NOT EXISTS kris.carbon_prices (
  instrument  text NOT NULL CHECK (instrument IN ('EUA', 'UKA')),
  price_date  date NOT NULL,
  price       numeric NOT NULL CHECK (price > 0),
  currency    text NOT NULL,
  source      text NOT NULL,
  PRIMARY KEY (instrument, price_date),
  CHECK ((instrument = 'EUA' AND currency = 'EUR') OR (instrument = 'UKA' AND currency = 'GBP'))
);

CREATE TABLE IF NOT EXISTS kris.carbon_trades (
  id               bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  trade_ref        text NOT NULL UNIQUE,
  trade_date       date NOT NULL,
  instrument       text NOT NULL CHECK (instrument IN ('EUA', 'UKA')),
  side             text NOT NULL CHECK (side IN ('buy', 'sell')),
  quantity         integer NOT NULL CHECK (quantity > 0),
  price            numeric NOT NULL CHECK (price > 0),
  currency         text NOT NULL,
  counterparty_id  text NOT NULL REFERENCES kris.companies (id),
  customer_id      text NOT NULL REFERENCES kris.companies (id),
  status           text NOT NULL CHECK (status IN ('executed', 'settled', 'cancelled')),
  settled_at       date,
  CHECK ((instrument = 'EUA' AND currency = 'EUR') OR (instrument = 'UKA' AND currency = 'GBP')),
  CHECK ((status = 'settled') = (settled_at IS NOT NULL)),
  CHECK (settled_at IS NULL OR settled_at >= trade_date)
);

-- Allowances bought for a customer, allocated to one vessel's obligation.
-- Status follows from the timestamps: requested -> confirmed -> transferred.
CREATE TABLE IF NOT EXISTS kris.carbon_allocations (
  id               bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  allocation_ref   text NOT NULL UNIQUE,
  trade_id         bigint NOT NULL REFERENCES kris.carbon_trades (id),
  vessel_id        text NOT NULL REFERENCES kris.vessels (id) ON DELETE CASCADE,
  scheme           text NOT NULL,
  obligation_year  smallint NOT NULL,
  quantity         integer NOT NULL CHECK (quantity > 0),
  requested_at     timestamptz NOT NULL,
  confirmed_at     timestamptz,
  confirmed_by     text,
  transferred_at   timestamptz,
  FOREIGN KEY (scheme, obligation_year) REFERENCES kris.ets_years (scheme, year),
  CHECK (confirmed_at IS NULL OR confirmed_at >= requested_at),
  CHECK (transferred_at IS NULL OR (confirmed_at IS NOT NULL AND transferred_at >= confirmed_at)),
  CHECK ((confirmed_at IS NULL) = (confirmed_by IS NULL))
);
CREATE INDEX IF NOT EXISTS carbon_allocations_vessel ON kris.carbon_allocations (vessel_id, obligation_year);
CREATE INDEX IF NOT EXISTS carbon_allocations_trade ON kris.carbon_allocations (trade_id);

-- state is what was done to the invoice; the status people ask about
-- (pending, overdue) also depends on today's date, so it is derived.
CREATE TABLE IF NOT EXISTS kris.invoices (
  id             bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  invoice_no     text NOT NULL UNIQUE,
  customer_id    text NOT NULL REFERENCES kris.companies (id),
  vessel_id      text REFERENCES kris.vessels (id),
  invoice_type   text NOT NULL CHECK (invoice_type IN ('carbon_recharge', 'fueleu_pooling', 'verification_fee', 'service_fee')),
  issue_date     date NOT NULL,
  due_date       date NOT NULL,
  amount         numeric(14,2) NOT NULL CHECK (amount >= 0),
  currency       text NOT NULL CHECK (currency IN ('EUR', 'GBP', 'USD')),
  trade_id       bigint REFERENCES kris.carbon_trades (id),
  allocation_id  bigint REFERENCES kris.carbon_allocations (id),
  state          text NOT NULL CHECK (state IN ('draft', 'issued', 'paid', 'void')),
  paid_at        date,
  description    text,
  CHECK (due_date >= issue_date),
  CHECK ((state = 'paid') = (paid_at IS NOT NULL)),
  CHECK (paid_at IS NULL OR paid_at >= issue_date)
);
CREATE INDEX IF NOT EXISTS invoices_vessel ON kris.invoices (vessel_id, issue_date DESC);
CREATE INDEX IF NOT EXISTS invoices_customer ON kris.invoices (customer_id, issue_date DESC);

-- ============================================================================
--  8. Communications (email)
-- ============================================================================

CREATE TABLE IF NOT EXISTS kris.communications (
  id             bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  message_id     text NOT NULL UNIQUE,
  thread_id      text NOT NULL,
  direction      text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  sent_at        timestamptz NOT NULL,
  from_address   text NOT NULL,
  to_addresses   text[] NOT NULL CHECK (cardinality(to_addresses) > 0),
  cc_addresses   text[] NOT NULL DEFAULT '{}',
  subject        text NOT NULL,
  body           text NOT NULL,
  category       text NOT NULL CHECK (category IN (
                   'bdn_request', 'bdn_received', 'vessel_report', 'allocation_request', 'allocation_confirmation',
                   'customer_query', 'fueleu_query', 'eu_mrv_query', 'imo_dcs_query', 'uka_query', 'invoice_query',
                   'carbon_trading')),
  priority       text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  status         text NOT NULL CHECK (status IN ('open', 'awaiting_reply', 'resolved')),
  vessel_id      text REFERENCES kris.vessels (id) ON DELETE CASCADE,
  customer_id    text REFERENCES kris.companies (id),
  voyage_id      bigint,
  bdn_id         bigint REFERENCES kris.bunker_deliveries (id),
  invoice_id     bigint REFERENCES kris.invoices (id),
  trade_id       bigint REFERENCES kris.carbon_trades (id),
  allocation_id  bigint REFERENCES kris.carbon_allocations (id),
  filing_id      bigint REFERENCES kris.compliance_filings (id),
  attachments    jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(attachments) = 'array'),
  FOREIGN KEY (vessel_id, voyage_id) REFERENCES kris.voyages (vessel_id, id)
);
CREATE INDEX IF NOT EXISTS communications_vessel ON kris.communications (vessel_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS communications_thread ON kris.communications (thread_id, sent_at);

-- ============================================================================
--  9. K.R.1.S's own tables
-- ============================================================================

-- Learned vocabulary: words, never measurements.
CREATE TABLE IF NOT EXISTS kris.kris_term_mappings (
  id              bigserial PRIMARY KEY,
  org_id          text        NOT NULL,
  term            text        NOT NULL,
  term_normalized text        NOT NULL,
  metric_key      text        NOT NULL,
  active          boolean     NOT NULL DEFAULT true,
  hit_count       integer     NOT NULL DEFAULT 0,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz,
  UNIQUE (org_id, term_normalized)
);

-- What was asked and how it went; shows which questions need a new alias.
CREATE TABLE IF NOT EXISTS kris.kris_query_log (
  id         bigserial PRIMARY KEY,
  org_id     text,
  user_id    text,
  question   text        NOT NULL,
  outcome    text        NOT NULL,
  detail     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kris_query_log_outcome ON kris.kris_query_log (outcome, created_at DESC);

-- ============================================================================
--  10. Reference rows (upserted: re-running refreshes them)
-- ============================================================================

INSERT INTO kris.fuel_types (code, name, imo_class, lcv_mj_per_t, cf_co2, cf_ch4, cf_n2o, slip_pct, wtt_gco2e_per_mj, factor_source) VALUES
  ('HSFO',  'High-sulphur fuel oil',        'HFO',     40500, 3.114, 0.00005, 0.00018, 0,   13.5, 'MEPC.364(79) Cf; FuelEU Annex II (HFO)'),
  ('VLSFO', 'Very-low-sulphur fuel oil',    'LFO',     41000, 3.151, 0.00005, 0.00018, 0,   13.2, 'MEPC.364(79) Cf; FuelEU Annex II (LFO)'),
  ('MGO',   'Marine gas oil',               'MDO/MGO', 42700, 3.206, 0.00005, 0.00018, 0,   14.4, 'MEPC.364(79) Cf; FuelEU Annex II (MDO/MGO)'),
  ('MDO',   'Marine diesel oil',            'MDO/MGO', 42700, 3.206, 0.00005, 0.00018, 0,   14.4, 'MEPC.364(79) Cf; FuelEU Annex II (MDO/MGO)'),
  ('LNG',   'Liquefied natural gas (dual-fuel, low-pressure Otto, slow speed)', 'LNG', 49100, 2.750, 0, 0.00011, 1.7, 18.5, 'MEPC.364(79) Cf; FuelEU Annex II (LNG Otto slow speed, 1.7% slip)')
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name, imo_class = EXCLUDED.imo_class, lcv_mj_per_t = EXCLUDED.lcv_mj_per_t, cf_co2 = EXCLUDED.cf_co2,
  cf_ch4 = EXCLUDED.cf_ch4, cf_n2o = EXCLUDED.cf_n2o, slip_pct = EXCLUDED.slip_pct,
  wtt_gco2e_per_mj = EXCLUDED.wtt_gco2e_per_mj, factor_source = EXCLUDED.factor_source;

INSERT INTO kris.cii_ship_types (ship_type, label, capacity_basis, capacity_cap, a, c, d1, d2, d3, d4, source) VALUES
  ('bulk_carrier',   'Bulk carrier',   'DWT', 279000, 4745, 0.622, 0.86, 0.94, 1.06, 1.18, 'MEPC.353(78), MEPC.354(78)'),
  ('tanker',         'Tanker',         'DWT', NULL,   5247, 0.610, 0.82, 0.93, 1.08, 1.28, 'MEPC.353(78), MEPC.354(78)'),
  ('container_ship', 'Container ship', 'DWT', NULL,   1984, 0.489, 0.83, 0.94, 1.07, 1.19, 'MEPC.353(78), MEPC.354(78)')
ON CONFLICT (ship_type) DO UPDATE SET
  label = EXCLUDED.label, capacity_basis = EXCLUDED.capacity_basis, capacity_cap = EXCLUDED.capacity_cap,
  a = EXCLUDED.a, c = EXCLUDED.c, d1 = EXCLUDED.d1, d2 = EXCLUDED.d2, d3 = EXCLUDED.d3, d4 = EXCLUDED.d4, source = EXCLUDED.source;

INSERT INTO kris.cii_reduction_factors (year, reduction_pct, source) VALUES
  (2023, 5, 'MEPC.338(76)'), (2024, 7, 'MEPC.338(76)'), (2025, 9, 'MEPC.338(76)'), (2026, 11, 'MEPC.338(76)')
ON CONFLICT (year) DO UPDATE SET reduction_pct = EXCLUDED.reduction_pct, source = EXCLUDED.source;

INSERT INTO kris.fueleu_targets (from_year, to_year, reduction_pct) VALUES
  (2025, 2029, 2), (2030, 2034, 6), (2035, 2039, 14.5), (2040, 2044, 31), (2045, 2049, 62), (2050, 2050, 80)
ON CONFLICT (from_year) DO UPDATE SET to_year = EXCLUDED.to_year, reduction_pct = EXCLUDED.reduction_pct;

INSERT INTO kris.ets_years (scheme, year, in_scope_from, surrender_pct, gases, surrender_deadline) VALUES
  ('EU_ETS', 2024, '2024-01-01', 40,  'CO2',  '2025-09-30'),
  ('EU_ETS', 2025, '2025-01-01', 70,  'CO2',  '2026-09-30'),
  ('EU_ETS', 2026, '2026-01-01', 100, 'CO2e', '2027-09-30'),
  ('UK_ETS', 2026, '2026-07-01', 100, 'CO2e', '2027-04-30')
ON CONFLICT (scheme, year) DO UPDATE SET
  in_scope_from = EXCLUDED.in_scope_from, surrender_pct = EXCLUDED.surrender_pct,
  gases = EXCLUDED.gases, surrender_deadline = EXCLUDED.surrender_deadline;

-- ============================================================================
--  11. Derived views — what K.R.1.S reads
--
--  security_invoker: a view runs with the caller's rights, so row-level
--  security on the tables underneath still applies.
--  GWP100 for CO2e: CH4 25, N2O 298 (FuelEU Maritime Annex I).
-- ============================================================================

DROP VIEW IF EXISTS
  kris.vessel_positions, kris.fuel_on_board, kris.report_log,
  kris.communication_log, kris.compliance_overview, kris.invoice_status, kris.vessel_carbon_trades,
  kris.carbon_exposure, kris.ets_obligations, kris.fueleu_period, kris.cii_annual, kris.annual_operations,
  kris.voyage_fuel, kris.voyage_summary, kris.port_call_log, kris.bunker_log, kris.fuel_emissions,
  kris.vessel_particulars, kris.fuel_factors CASCADE;

CREATE VIEW kris.fuel_factors WITH (security_invoker = true) AS
SELECT f.*,
       -- tank-to-wake CO2e per tonne of fuel, methane slip included
       (1 - f.slip_pct / 100) * (f.cf_co2 + f.cf_ch4 * 25 + f.cf_n2o * 298) + (f.slip_pct / 100) * 25 AS ttw_co2e_per_t,
       ((1 - f.slip_pct / 100) * (f.cf_co2 + f.cf_ch4 * 25 + f.cf_n2o * 298) + (f.slip_pct / 100) * 25)
         / (f.lcv_mj_per_t / 1e6) AS ttw_gco2e_per_mj,
       f.wtt_gco2e_per_mj
         + ((1 - f.slip_pct / 100) * (f.cf_co2 + f.cf_ch4 * 25 + f.cf_n2o * 298) + (f.slip_pct / 100) * 25)
           / (f.lcv_mj_per_t / 1e6) AS wtw_gco2e_per_mj
  FROM kris.fuel_types f;

CREATE VIEW kris.vessel_particulars WITH (security_invoker = true) AS
SELECT v.id AS vessel_id, v.name AS vessel_name, v.imo, v.vessel_code, v.vessel_type, st.label AS cii_ship_type,
       v.flag, o.name AS owner, m.name AS manager, ch.name AS charterer, cu.name AS customer,
       v.gross_tonnage, v.net_tonnage, v.deadweight_t, v.cargo_capacity, v.cargo_capacity_unit,
       v.main_engine, v.main_engine_cylinders, v.main_engine_mcr_kw, v.main_engine_rpm, v.aux_engines,
       v.scrubber, v.dual_fuel,
       (SELECT string_agg(vf.fuel_code || ' (' || vf.usage || ')', ', ' ORDER BY vf.usage, vf.fuel_code)
          FROM kris.vessel_fuel_types vf WHERE vf.vessel_id = v.id) AS fuel_types,
       v.year_built, v.builder, v.class_society, v.design_speed_kn, v.reference_speed_kn,
       v.department, v.is_test
  FROM kris.vessels v
  LEFT JOIN kris.cii_ship_types st ON st.ship_type = v.ship_type
  LEFT JOIN kris.companies o  ON o.id  = v.owner_id
  LEFT JOIN kris.companies m  ON m.id  = v.manager_id
  LEFT JOIN kris.companies ch ON ch.id = v.charterer_id
  LEFT JOIN kris.companies cu ON cu.id = v.customer_id;

-- One row per fuel type per report: the emissions ledger. Scope follows the
-- voyage: a passage between two EEA ports is 100% in EU scope, EEA to or
-- from elsewhere 50%, at berth in an EEA port 100%. UK ETS counts voyages
-- between UK ports and time at berth in the UK, from its start date.
CREATE VIEW kris.fuel_emissions WITH (security_invoker = true) AS
SELECT fc.id, r.id AS report_id, r.imo AS vessel_id, r.report_time, r.report_date, r.form_type,
       r.voyage_id, v.voyage_no, r.mode, fc.fuel_code,
       fc.me_t, fc.ae_t, fc.boiler_t, fc.total_t,
       ff.cf_co2, ff.lcv_mj_per_t, ff.wtw_gco2e_per_mj,
       fc.total_t * ff.cf_co2                                   AS co2_t,
       fc.total_t * ff.ttw_co2e_per_t                           AS co2e_t,
       fc.total_t * ff.lcv_mj_per_t                             AS energy_mj,
       fc.total_t * ff.lcv_mj_per_t * ff.wtt_gco2e_per_mj       AS wtt_g,
       fc.total_t * ff.lcv_mj_per_t * ff.ttw_gco2e_per_mj       AS ttw_g,
       fc.total_t * ff.lcv_mj_per_t * ff.wtw_gco2e_per_mj       AS wtw_g,
       CASE WHEN v.id IS NULL THEN 0
            WHEN r.mode = 'port' THEN CASE WHEN tp.region = 'EEA' THEN 100 ELSE 0 END
            WHEN fp.region = 'EEA' AND tp.region = 'EEA' THEN 100
            WHEN fp.region = 'EEA' OR tp.region = 'EEA' THEN 50
            ELSE 0 END                                          AS eu_scope_pct,
       CASE WHEN v.id IS NULL
              OR r.report_time < (SELECT min(y.in_scope_from) FROM kris.ets_years y WHERE y.scheme = 'UK_ETS') THEN 0
            WHEN r.mode = 'port' THEN CASE WHEN tp.region = 'UK' THEN 100 ELSE 0 END
            WHEN fp.region = 'UK' AND tp.region = 'UK' THEN 100
            ELSE 0 END                                          AS uk_scope_pct
  FROM kris.fuel_consumption fc
  JOIN kris.geoform_reports r ON r.id = fc.report_id
  JOIN kris.fuel_factors ff   ON ff.code = fc.fuel_code
  LEFT JOIN kris.voyages v    ON v.id = r.voyage_id
  LEFT JOIN kris.ports fp     ON fp.locode = v.from_port
  LEFT JOIN kris.ports tp     ON tp.locode = v.to_port;

CREATE VIEW kris.report_log WITH (security_invoker = true) AS
SELECT r.imo AS vessel_id, r.vessel_name, v.voyage_no, r.form_type, r.report_time, r.mode,
       r.latitude, r.longitude, r.course_deg, r.wind_force_bft,
       r.hours_underway, r.distance_nm, r.speed_kn, r.shaft_power_kw, r.me_rpm,
       r.me_fuel_mt, r.ae_fuel_mt, r.boiler_fuel_mt, r.fuel_consumed_mt, r.co2_mt
  FROM kris.geoform_reports r
  LEFT JOIN kris.voyages v ON v.id = r.voyage_id;

-- Where each vessel is now: its latest report, the voyage it is on, and for a
-- vessel at sea the distance to go and an ETA at the average speed so far.
CREATE VIEW kris.vessel_positions WITH (security_invoker = true) AS
WITH last AS (
  SELECT DISTINCT ON (r.imo) r.*
    FROM kris.geoform_reports r
   WHERE r.latitude IS NOT NULL
   ORDER BY r.imo, r.report_time DESC
), sailed AS (
  SELECT voyage_id, SUM(distance_nm) AS nm, SUM(hours_underway) AS h
    FROM kris.geoform_reports WHERE voyage_id IS NOT NULL GROUP BY voyage_id
)
SELECT l.imo AS vessel_id, vs.name AS vessel_name, vs.vessel_type, l.report_time AS position_at, l.form_type AS last_report,
       l.latitude, l.longitude, l.course_deg, l.speed_kn, l.wind_force_bft,
       CASE WHEN l.form_type = 'departure' THEN 'departing ' || tp.name
            WHEN pc.arrival_at IS NULL OR pc.arrival_at > l.report_time THEN 'at sea'
            WHEN pc.berthed_at IS NOT NULL AND pc.berthed_at <= l.report_time THEN 'alongside at ' || tp.name
            ELSE 'at anchor off ' || tp.name END AS situation,
       v.voyage_no, v.voyage_ref, v.leg_type, v.cargo,
       v.from_port, fp.name AS from_port_name, v.to_port, tp.name AS to_port_name, tp.country AS to_country,
       v.departure_at, pc.arrival_at, pc.berthed_at,
       round(s.nm::numeric, 1) AS distance_sailed_nm,
       CASE WHEN pc.arrival_at IS NULL AND rt.nm IS NOT NULL THEN round(GREATEST(rt.nm - s.nm, 0)::numeric, 1) END AS distance_to_go_nm,
       CASE WHEN pc.arrival_at IS NULL AND rt.nm IS NOT NULL AND s.h > 0
            THEN l.report_time + make_interval(secs => (GREATEST(rt.nm - s.nm, 0) / (s.nm / s.h)) * 3600) END AS eta
  FROM last l
  JOIN kris.vessels vs ON vs.id = l.imo
  LEFT JOIN kris.voyages v ON v.id = l.voyage_id
  LEFT JOIN kris.ports fp ON fp.locode = v.from_port
  LEFT JOIN kris.ports tp ON tp.locode = v.to_port
  LEFT JOIN kris.port_calls pc ON pc.voyage_id = v.id AND pc.locode = v.to_port
  LEFT JOIN sailed s ON s.voyage_id = v.id
  LEFT JOIN kris.route_distances rt ON rt.from_port = v.from_port AND rt.to_port = v.to_port;

-- Fuel remaining on board per vessel and fuel type: opening quantity, plus
-- what the BDNs delivered, minus what the reports burned, up to the latest report.
CREATE VIEW kris.fuel_on_board WITH (security_invoker = true) AS
WITH last AS (SELECT imo, max(report_time) AS at FROM kris.geoform_reports GROUP BY imo), x AS (
SELECT f.vessel_id, vs.name AS vessel_name, f.fuel_code, l.at AS as_of,
       f.opening_rob_t,
       COALESCE((SELECT SUM(b.quantity_t) FROM kris.bunker_deliveries b
                  WHERE b.vessel_id = f.vessel_id AND b.fuel_code = f.fuel_code AND b.delivered_at <= l.at
                    AND b.delivered_at >= COALESCE(f.opening_at, '-infinity')), 0) AS delivered_t,
       COALESCE((SELECT SUM(c.total_t) FROM kris.fuel_consumption c JOIN kris.geoform_reports r ON r.id = c.report_id
                  WHERE r.imo = f.vessel_id AND c.fuel_code = f.fuel_code
                    AND r.report_time > COALESCE(f.opening_at, '-infinity')), 0) AS burned_t
  FROM kris.vessel_fuel_types f
  JOIN kris.vessels vs ON vs.id = f.vessel_id
  JOIN last l ON l.imo = f.vessel_id
 WHERE f.opening_rob_t IS NOT NULL)
SELECT x.vessel_id, x.vessel_name, x.fuel_code, x.as_of, x.opening_rob_t,
       round(x.delivered_t, 1) AS delivered_t, round(x.burned_t, 1) AS burned_t,
       round(x.opening_rob_t + x.delivered_t - x.burned_t, 1) AS rob_t
  FROM x;

CREATE VIEW kris.port_call_log WITH (security_invoker = true) AS
SELECT v.vessel_id, vs.name AS vessel_name, v.voyage_no, pc.id AS port_call_id, pc.locode, p.name AS port_name,
       p.country, p.region, pc.purpose, pc.arrival_at, pc.berthed_at, pc.departure_at,
       round((EXTRACT(EPOCH FROM (COALESCE(pc.departure_at, now()) - pc.arrival_at)) / 3600)::numeric, 1) AS hours_in_port,
       round((EXTRACT(EPOCH FROM (COALESCE(pc.departure_at, now()) - pc.arrival_at)) / 86400)::numeric, 2) AS days_in_port,
       pc.departure_at IS NULL AS still_in_port, pc.distance_in_port_nm
  FROM kris.port_calls pc
  JOIN kris.voyages v  ON v.id = pc.voyage_id
  JOIN kris.vessels vs ON vs.id = v.vessel_id
  JOIN kris.ports p    ON p.locode = pc.locode;

CREATE VIEW kris.bunker_log WITH (security_invoker = true) AS
SELECT b.vessel_id, vs.name AS vessel_name, b.bdn_no, b.delivered_at, b.locode, p.name AS port_name,
       b.fuel_code, b.quantity_t, b.sulphur_pct, b.density_kg_m3, s.name AS supplier,
       v.voyage_no, b.status, b.received_at, b.verified_at
  FROM kris.bunker_deliveries b
  JOIN kris.vessels vs ON vs.id = b.vessel_id
  JOIN kris.ports p    ON p.locode = b.locode
  LEFT JOIN kris.companies s ON s.id = b.supplier_id
  LEFT JOIN kris.voyages v   ON v.id = b.voyage_id;

-- One row per voyage: ports, times, days, distance, fuel, emissions and the
-- voyage's own FuelEU balance (against the target for its departure year).
CREATE VIEW kris.voyage_summary WITH (security_invoker = true) AS
WITH dest AS (
  SELECT DISTINCT ON (pc.voyage_id) pc.voyage_id, pc.arrival_at, pc.berthed_at, pc.departure_at
    FROM kris.port_calls pc
    JOIN kris.voyages v ON v.id = pc.voyage_id AND pc.locode = v.to_port
   ORDER BY pc.voyage_id, pc.arrival_at DESC
), in_port AS (
  SELECT voyage_id, SUM(distance_in_port_nm) AS distance_in_port_nm FROM kris.port_calls GROUP BY voyage_id
), ops AS (
  SELECT voyage_id, SUM(distance_nm) AS distance_at_sea_nm, SUM(hours_underway) AS hours_underway
    FROM kris.geoform_reports WHERE voyage_id IS NOT NULL GROUP BY voyage_id
), fuel AS (
  SELECT voyage_id,
         SUM(total_t) AS fuel_t,
         SUM(total_t) FILTER (WHERE fuel_code = 'HSFO')  AS hsfo_t,
         SUM(total_t) FILTER (WHERE fuel_code = 'VLSFO') AS vlsfo_t,
         SUM(total_t) FILTER (WHERE fuel_code = 'MGO')   AS mgo_t,
         SUM(total_t) FILTER (WHERE fuel_code = 'MDO')   AS mdo_t,
         SUM(total_t) FILTER (WHERE fuel_code = 'LNG')   AS lng_t,
         SUM(total_t) FILTER (WHERE mode = 'sea')        AS fuel_at_sea_t,
         SUM(total_t) FILTER (WHERE mode = 'port')       AS fuel_in_port_t,
         SUM(me_t) AS me_fuel_t, SUM(ae_t) AS ae_fuel_t, SUM(boiler_t) AS boiler_fuel_t,
         SUM(co2_t) AS co2_t,
         SUM(co2_t) FILTER (WHERE mode = 'sea')  AS co2_at_sea_t,
         SUM(co2_t) FILTER (WHERE mode = 'port') AS co2_in_port_t,
         SUM(co2e_t) AS co2e_t,
         SUM(energy_mj) AS energy_mj,
         SUM(wtw_g) AS wtw_g,
         SUM(co2_t * eu_scope_pct / 100)     AS eu_co2_t,
         SUM(energy_mj * eu_scope_pct / 100) AS fueleu_energy_mj,
         SUM(wtw_g * eu_scope_pct / 100)     AS fueleu_wtw_g
    FROM kris.fuel_emissions WHERE voyage_id IS NOT NULL GROUP BY voyage_id
), offhire AS (
  SELECT imo, voyage_no, SUM(offhire_days) AS offhire_days FROM kris.veson_offhire GROUP BY imo, voyage_no
), base AS (
  SELECT v.*, vs.name AS vessel_name, vs.imo,
         fp.name AS from_port_name, fp.country AS from_country, fp.region AS from_region,
         tp.name AS to_port_name,   tp.country AS to_country,   tp.region AS to_region,
         ch.name AS charterer,
         d.arrival_at, d.berthed_at, d.departure_at AS port_departure_at,
         EXTRACT(EPOCH FROM (COALESCE(d.arrival_at, now()) - v.departure_at)) / 86400 AS sea_days,
         CASE WHEN d.arrival_at IS NULL THEN 0
              ELSE EXTRACT(EPOCH FROM (COALESCE(d.departure_at, now()) - d.arrival_at)) / 86400 END AS port_days,
         COALESCE(o.offhire_days, 0) AS offhire_days,
         t.reference_gco2e_per_mj * (1 - t.reduction_pct / 100) AS fueleu_target
    FROM kris.voyages v
    JOIN kris.vessels vs ON vs.id = v.vessel_id
    JOIN kris.ports fp   ON fp.locode = v.from_port
    JOIN kris.ports tp   ON tp.locode = v.to_port
    LEFT JOIN kris.companies ch ON ch.id = v.charterer_id
    LEFT JOIN dest d            ON d.voyage_id = v.id
    LEFT JOIN offhire o         ON o.imo = v.vessel_id AND o.voyage_no = v.voyage_no
    LEFT JOIN kris.fueleu_targets t
           ON EXTRACT(YEAR FROM v.departure_at) BETWEEN t.from_year AND t.to_year
)
SELECT b.vessel_id, b.vessel_name, b.imo, b.id AS voyage_id, b.voyage_no, b.voyage_ref, b.leg_type,
       b.cargo, b.cargo_qty_t, b.charterer,
       b.from_port, b.from_port_name, b.from_country, b.to_port, b.to_port_name, b.to_country,
       CASE WHEN b.from_region = 'EEA' AND b.to_region = 'EEA' THEN 100
            WHEN b.from_region = 'EEA' OR b.to_region = 'EEA' THEN 50 ELSE 0 END AS eu_scope_pct,
       b.departure_at, b.arrival_at, b.berthed_at, b.port_departure_at,
       CASE WHEN b.arrival_at IS NULL THEN 'underway'
            WHEN b.port_departure_at IS NULL THEN 'in_port'
            ELSE 'completed' END AS status,
       round(b.sea_days::numeric, 2)                                   AS sea_days,
       round(b.port_days::numeric, 2)                                  AS port_days,
       round((b.sea_days + b.port_days)::numeric, 2)                   AS total_days,
       round(b.offhire_days::numeric, 2)                               AS offhire_days,
       round((b.sea_days + b.port_days - b.offhire_days)::numeric, 2)  AS net_days,
       round(ops.distance_at_sea_nm::numeric, 1)                                         AS distance_at_sea_nm,
       round(COALESCE(ip.distance_in_port_nm, 0)::numeric, 1)                            AS distance_in_port_nm,
       round((COALESCE(ops.distance_at_sea_nm, 0) + COALESCE(ip.distance_in_port_nm, 0))::numeric, 1) AS distance_nm,
       round(ops.hours_underway::numeric, 1)                                             AS hours_underway,
       round((ops.distance_at_sea_nm / NULLIF(ops.hours_underway, 0))::numeric, 2)       AS avg_speed_kn,
       round(f.fuel_t, 3) AS fuel_t, round(f.hsfo_t, 3) AS hsfo_t, round(f.vlsfo_t, 3) AS vlsfo_t,
       round(f.mgo_t, 3) AS mgo_t, round(f.mdo_t, 3) AS mdo_t, round(f.lng_t, 3) AS lng_t,
       round(f.fuel_at_sea_t, 3) AS fuel_at_sea_t, round(f.fuel_in_port_t, 3) AS fuel_in_port_t,
       round(f.me_fuel_t, 3) AS me_fuel_t, round(f.ae_fuel_t, 3) AS ae_fuel_t, round(f.boiler_fuel_t, 3) AS boiler_fuel_t,
       round(f.co2_t, 3) AS co2_t, round(f.co2_at_sea_t, 3) AS co2_at_sea_t, round(f.co2_in_port_t, 3) AS co2_in_port_t,
       round(f.co2e_t, 3) AS co2e_t, round(f.energy_mj, 0) AS energy_mj,
       round(f.wtw_g / NULLIF(f.energy_mj, 0), 3) AS ghg_intensity_wtw,
       round(f.eu_co2_t, 3) AS eu_co2_t,
       round(f.fueleu_energy_mj, 0) AS fueleu_energy_mj,
       round(f.fueleu_wtw_g / NULLIF(f.fueleu_energy_mj, 0), 3) AS fueleu_ghg_intensity,
       round(b.fueleu_target, 4) AS fueleu_target,
       round(((b.fueleu_target - f.fueleu_wtw_g / NULLIF(f.fueleu_energy_mj, 0)) * f.fueleu_energy_mj / 1e6)::numeric, 3)
         AS compliance_balance_t,
       round((b.cargo_qty_t * ops.distance_at_sea_nm)::numeric, 0) AS transport_work_t_nm,
       round((f.co2_t * 1e6 / NULLIF(b.cargo_qty_t * ops.distance_at_sea_nm, 0))::numeric, 3) AS eeoi_g_per_t_nm
  FROM base b
  LEFT JOIN ops ON ops.voyage_id = b.id
  LEFT JOIN in_port ip ON ip.voyage_id = b.id
  LEFT JOIN fuel f ON f.voyage_id = b.id;

CREATE VIEW kris.voyage_fuel WITH (security_invoker = true) AS
SELECT e.vessel_id, vs.name AS vessel_name, e.voyage_id, e.voyage_no, e.fuel_code,
       round(SUM(e.total_t) FILTER (WHERE e.mode = 'sea'), 3)  AS at_sea_t,
       round(SUM(e.total_t) FILTER (WHERE e.mode = 'port'), 3) AS in_port_t,
       round(SUM(e.me_t), 3) AS me_t, round(SUM(e.ae_t), 3) AS ae_t, round(SUM(e.boiler_t), 3) AS boiler_t,
       round(SUM(e.total_t), 3) AS total_t,
       max(e.cf_co2) AS co2_factor,
       round(SUM(e.co2_t), 3) AS co2_t,
       round(SUM(e.energy_mj), 0) AS energy_mj,
       min(e.report_time) AS first_report_at, max(e.report_time) AS last_report_at
  FROM kris.fuel_emissions e
  JOIN kris.vessels vs ON vs.id = e.vessel_id
 WHERE e.voyage_id IS NOT NULL
 GROUP BY e.vessel_id, vs.name, e.voyage_id, e.voyage_no, e.fuel_code;

-- One row per vessel per calendar year: the IMO DCS / EU MRV figures.
CREATE VIEW kris.annual_operations WITH (security_invoker = true) AS
WITH r AS (
  SELECT r.imo AS vessel_id, EXTRACT(YEAR FROM r.report_time)::int AS year,
         SUM(r.distance_nm) AS distance_at_sea_nm, SUM(r.hours_underway) AS hours_underway,
         SUM(r.distance_nm * v.cargo_qty_t) AS transport_work_t_nm, count(*) AS reports
    FROM kris.geoform_reports r
    LEFT JOIN kris.voyages v ON v.id = r.voyage_id
   GROUP BY 1, 2
), p AS (
  SELECT v.vessel_id, EXTRACT(YEAR FROM pc.arrival_at)::int AS year, SUM(pc.distance_in_port_nm) AS distance_in_port_nm,
         count(*) AS port_calls
    FROM kris.port_calls pc JOIN kris.voyages v ON v.id = pc.voyage_id
   GROUP BY 1, 2
), vy AS (
  SELECT vessel_id, EXTRACT(YEAR FROM departure_at)::int AS year, count(*) AS voyages
    FROM kris.voyages GROUP BY 1, 2
), f AS (
  SELECT vessel_id, EXTRACT(YEAR FROM report_time)::int AS year,
         SUM(total_t) AS fuel_t,
         SUM(total_t) FILTER (WHERE fuel_code = 'HSFO')  AS hsfo_t,
         SUM(total_t) FILTER (WHERE fuel_code = 'VLSFO') AS vlsfo_t,
         SUM(total_t) FILTER (WHERE fuel_code = 'MGO')   AS mgo_t,
         SUM(total_t) FILTER (WHERE fuel_code = 'MDO')   AS mdo_t,
         SUM(total_t) FILTER (WHERE fuel_code = 'LNG')   AS lng_t,
         SUM(co2_t) AS co2_t, SUM(co2e_t) AS co2e_t, SUM(energy_mj) AS energy_mj,
         SUM(total_t * eu_scope_pct / 100) AS eu_fuel_t,
         SUM(co2_t * eu_scope_pct / 100)   AS eu_co2_t,
         SUM(co2_t) FILTER (WHERE mode = 'port' AND eu_scope_pct > 0) AS eu_co2_at_berth_t
    FROM kris.fuel_emissions GROUP BY 1, 2
)
SELECT r.vessel_id, v.name AS vessel_name, r.year,
       r.year < EXTRACT(YEAR FROM now())::int AS is_complete_year,
       COALESCE(vy.voyages, 0) AS voyages, COALESCE(p.port_calls, 0) AS port_calls,
       round((r.distance_at_sea_nm + COALESCE(p.distance_in_port_nm, 0))::numeric, 1) AS distance_nm,
       round(r.hours_underway::numeric, 1) AS hours_underway,
       round(f.fuel_t, 3) AS fuel_t, round(f.hsfo_t, 3) AS hsfo_t, round(f.vlsfo_t, 3) AS vlsfo_t,
       round(f.mgo_t, 3) AS mgo_t, round(f.mdo_t, 3) AS mdo_t, round(f.lng_t, 3) AS lng_t,
       round(f.co2_t, 3) AS co2_t, round(f.co2e_t, 3) AS co2e_t, round(f.energy_mj, 0) AS energy_mj,
       round(f.eu_fuel_t, 3) AS eu_fuel_t, round(f.eu_co2_t, 3) AS eu_co2_t,
       round(f.eu_co2_at_berth_t, 3) AS eu_co2_at_berth_t,
       round(r.transport_work_t_nm::numeric, 0) AS transport_work_t_nm,
       round((f.co2_t * 1e6 / NULLIF(r.transport_work_t_nm, 0))::numeric, 3) AS eeoi_g_per_t_nm
  FROM r
  JOIN kris.vessels v ON v.id = r.vessel_id
  LEFT JOIN p  ON p.vessel_id = r.vessel_id AND p.year = r.year
  LEFT JOIN vy ON vy.vessel_id = r.vessel_id AND vy.year = r.year
  LEFT JOIN f  ON f.vessel_id = r.vessel_id AND f.year = r.year;

-- AER and CII per vessel per year, and the rating: nothing here is stored.
--   attained CII = CO2 (g) / (capacity x distance)       (MEPC.352(78))
--   required CII = (1 - Z/100) x a x capacity^-c         (MEPC.353(78), MEPC.338(76))
--   rating       = attained against d1..d4 x required    (MEPC.354(78))
--   AER          = CO2 (g) / (DWT x distance)            (the CII metric for bulk carriers and tankers)
CREATE VIEW kris.cii_annual WITH (security_invoker = true) AS
WITH base AS (
  SELECT a.vessel_id, a.vessel_name, a.year, a.is_complete_year, v.imo, v.ship_type, st.label AS ship_type_label,
         st.capacity_basis, st.a, st.c, st.d1, st.d2, st.d3, st.d4, v.deadweight_t,
         CASE st.capacity_basis WHEN 'DWT' THEN LEAST(v.deadweight_t, COALESCE(st.capacity_cap, v.deadweight_t))
                                ELSE LEAST(v.gross_tonnage, COALESCE(st.capacity_cap, v.gross_tonnage)) END AS capacity,
         a.distance_nm, a.co2_t,
         COALESCE(adj.co2_deduction_t, 0) AS co2_deduction_t,
         COALESCE(adj.distance_deduction_nm, 0) AS distance_deduction_nm,
         rf.reduction_pct
    FROM kris.annual_operations a
    JOIN kris.vessels v         ON v.id = a.vessel_id
    JOIN kris.cii_ship_types st ON st.ship_type = v.ship_type
    LEFT JOIN (SELECT vessel_id, year, SUM(co2_deduction_t) AS co2_deduction_t, SUM(distance_deduction_nm) AS distance_deduction_nm
                 FROM kris.cii_adjustments GROUP BY vessel_id, year) adj
           ON adj.vessel_id = a.vessel_id AND adj.year = a.year
    LEFT JOIN kris.cii_reduction_factors rf ON rf.year = a.year
), calc AS (
  SELECT base.*,
         co2_t - co2_deduction_t          AS cii_co2_t,
         distance_nm - distance_deduction_nm AS cii_distance_nm,
         a * power(capacity, -c)          AS reference_cii,
         (1 - reduction_pct / 100) * a * power(capacity, -c) AS required_cii,
         (co2_t - co2_deduction_t) * 1e6 / NULLIF(capacity * (distance_nm - distance_deduction_nm), 0) AS attained_cii,
         co2_t * 1e6 / NULLIF(deadweight_t * distance_nm, 0) AS aer
    FROM base
), rated AS (
  SELECT calc.*,
         CASE WHEN required_cii IS NULL OR attained_cii IS NULL THEN NULL
              WHEN attained_cii < d1 * required_cii THEN 'A'
              WHEN attained_cii < d2 * required_cii THEN 'B'
              WHEN attained_cii < d3 * required_cii THEN 'C'
              WHEN attained_cii < d4 * required_cii THEN 'D'
              ELSE 'E' END AS rating
    FROM calc
), history AS (
  SELECT rated.*,
         LAG(rating, 1) OVER w AS rating_prev_year,
         LAG(rating, 2) OVER w AS rating_two_years_ago
    FROM rated WINDOW w AS (PARTITION BY vessel_id ORDER BY year)
)
SELECT vessel_id, vessel_name, imo, year, is_complete_year, ship_type_label AS ship_type, capacity_basis,
       capacity, round(distance_nm, 1) AS distance_nm, round(co2_t, 3) AS co2_t,
       co2_deduction_t, distance_deduction_nm,
       round(capacity * cii_distance_nm, 0) AS transport_work_capacity_nm,
       round(aer::numeric, 3) AS aer, round(attained_cii::numeric, 3) AS attained_cii,
       round(reference_cii::numeric, 3) AS reference_cii, reduction_pct,
       round(required_cii::numeric, 3) AS required_cii,
       round((attained_cii / NULLIF(required_cii, 0))::numeric, 3) AS attained_to_required,
       round((d1 * required_cii)::numeric, 3) AS boundary_a_b, round((d2 * required_cii)::numeric, 3) AS boundary_b_c,
       round((d3 * required_cii)::numeric, 3) AS boundary_c_d, round((d4 * required_cii)::numeric, 3) AS boundary_d_e,
       rating, rating_prev_year, rating_two_years_ago,
       CASE WHEN rating IS NULL THEN NULL
            WHEN NOT is_complete_year THEN 'provisional (year to date)'
            WHEN rating = 'E' OR (rating = 'D' AND rating_prev_year = 'D' AND rating_two_years_ago = 'D')
              THEN 'corrective action plan required (SEEMP Part III)'
            WHEN rating = 'D' THEN 'attention: rated D'
            ELSE 'compliant' END AS status
  FROM history;

-- FuelEU Maritime per quarter and per year (period = 'Q1'..'Q4' or 'YEAR').
-- Banking, borrowing, pooling and the penalty apply to the annual row only.
--   compliance balance (gCO2e) = (target - actual GHG intensity) x energy in scope
--   penalty (EUR) = |final balance| / (actual intensity x 41 000) x 2 400,
--                   x (1 + (n - 1)/10) for the n-th consecutive year in deficit
CREATE VIEW kris.fueleu_period WITH (security_invoker = true) AS
WITH e AS (
  SELECT vessel_id, EXTRACT(YEAR FROM report_time)::int AS year, EXTRACT(QUARTER FROM report_time)::int AS quarter,
         energy_mj * eu_scope_pct / 100 AS energy_mj, wtt_g * eu_scope_pct / 100 AS wtt_g,
         ttw_g * eu_scope_pct / 100 AS ttw_g, wtw_g * eu_scope_pct / 100 AS wtw_g
    FROM kris.fuel_emissions
   WHERE eu_scope_pct > 0 AND report_time >= DATE '2025-01-01'
), g AS (
  SELECT vessel_id, year, quarter, GROUPING(quarter) = 1 AS is_annual,
         SUM(energy_mj) AS energy_mj, SUM(wtt_g) AS wtt_g, SUM(ttw_g) AS ttw_g, SUM(wtw_g) AS wtw_g
    FROM e GROUP BY vessel_id, year, GROUPING SETS ((quarter), ())
), bal AS (
  SELECT g.*, t.reference_gco2e_per_mj * (1 - t.reduction_pct / 100) AS target, t.penalty_eur_per_t_vlsfo, t.vlsfo_mj_per_t,
         g.wtw_g / NULLIF(g.energy_mj, 0) AS ghg_intensity
    FROM g JOIN kris.fueleu_targets t ON g.year BETWEEN t.from_year AND t.to_year
), fin AS (
  SELECT bal.*, (target - ghg_intensity) * energy_mj AS cb_g,
         fx.banked_in_g, fx.borrowed_g, fx.banked_out_g, fx.pool_id, fx.pool_transfer_g,
         (target - ghg_intensity) * energy_mj
           + CASE WHEN is_annual THEN COALESCE(fx.banked_in_g, 0) + COALESCE(fx.borrowed_g, 0)
                                    + COALESCE(fx.pool_transfer_g, 0) - COALESCE(fx.banked_out_g, 0) ELSE 0 END AS cb_final_g
    FROM bal
    LEFT JOIN kris.fueleu_flexibility fx ON fx.vessel_id = bal.vessel_id AND fx.year = bal.year AND bal.is_annual
), streak AS (
  SELECT fin.*,
         CASE WHEN is_annual AND cb_final_g < 0
              THEN count(*) FILTER (WHERE cb_final_g < 0) OVER (PARTITION BY vessel_id, is_annual ORDER BY year) END AS deficit_years
    FROM fin
)
SELECT s.vessel_id, vs.name AS vessel_name, s.year,
       CASE WHEN s.is_annual THEN 'YEAR' ELSE 'Q' || s.quarter END AS period,
       CASE WHEN s.is_annual THEN make_date(s.year, 1, 1) ELSE make_date(s.year, s.quarter * 3 - 2, 1) END AS period_start,
       CASE WHEN s.is_annual THEN make_date(s.year, 12, 31)
            ELSE (make_date(s.year, s.quarter * 3 - 2, 1) + INTERVAL '3 months' - INTERVAL '1 day')::date END AS period_end,
       (CASE WHEN s.is_annual THEN make_date(s.year, 12, 31)
             ELSE (make_date(s.year, s.quarter * 3 - 2, 1) + INTERVAL '3 months' - INTERVAL '1 day')::date END) < current_date AS is_complete,
       round(s.energy_mj, 0) AS energy_in_scope_mj,
       round(s.wtt_g / NULLIF(s.energy_mj, 0), 3) AS wtt_intensity,
       round(s.ttw_g / NULLIF(s.energy_mj, 0), 3) AS ttw_intensity,
       round(s.ghg_intensity, 3) AS ghg_intensity,
       round(s.target, 4) AS target_intensity,
       round(s.cb_g, 0) AS compliance_balance_g,
       round(s.cb_g / 1e6, 3) AS compliance_balance_t,
       round(s.banked_in_g, 0) AS banked_in_g, round(s.borrowed_g, 0) AS borrowed_g,
       round(s.banked_out_g, 0) AS banked_out_g,
       s.pool_id, p.name AS pool_name, round(s.pool_transfer_g, 0) AS pool_transfer_g,
       CASE WHEN s.is_annual THEN round(s.cb_final_g, 0) END AS final_balance_g,
       CASE WHEN s.is_annual THEN round(s.cb_final_g / 1e6, 3) END AS final_balance_t,
       CASE WHEN s.cb_g < 0 THEN round((-s.cb_g / (s.ghg_intensity * s.vlsfo_mj_per_t) * s.penalty_eur_per_t_vlsfo)::numeric, 2) ELSE 0 END
         AS penalty_before_flexibility_eur,
       CASE WHEN NOT s.is_annual THEN NULL
            WHEN s.cb_final_g < 0 THEN round((-s.cb_final_g / (s.ghg_intensity * s.vlsfo_mj_per_t) * s.penalty_eur_per_t_vlsfo
                                              * (1 + (s.deficit_years - 1) / 10.0))::numeric, 2)
            ELSE 0 END AS penalty_eur,
       CASE WHEN NOT s.is_annual THEN 'quarter (indicative, before flexibility)'
            WHEN s.cb_g >= 0 THEN 'surplus'
            WHEN s.cb_final_g >= 0 THEN 'deficit covered by ' || concat_ws(' and ',
                   CASE WHEN s.pool_transfer_g > 0 THEN 'pooling' END,
                   CASE WHEN s.banked_in_g > 0 THEN 'banked surplus' END,
                   CASE WHEN s.borrowed_g > 0 THEN 'borrowing' END)
            ELSE 'deficit: penalty due' END
         || CASE WHEN s.is_annual AND make_date(s.year, 12, 31) >= current_date THEN ' (provisional, year to date)' ELSE '' END AS status
  FROM streak s
  JOIN kris.vessels vs ON vs.id = s.vessel_id
  LEFT JOIN kris.fueleu_pools p ON p.id = s.pool_id;

-- EU ETS and UK ETS allowances per vessel per year: owed, surrendered,
-- allocated, still open, and the status against the deadline.
CREATE VIEW kris.ets_obligations WITH (security_invoker = true) AS
WITH em AS (
  SELECT vessel_id, 'EU_ETS'::text AS scheme, EXTRACT(YEAR FROM report_time)::int AS year,
         SUM(co2_t * eu_scope_pct / 100) AS co2_t, SUM(co2e_t * eu_scope_pct / 100) AS co2e_t
    FROM kris.fuel_emissions WHERE eu_scope_pct > 0 GROUP BY 1, 2, 3
  UNION ALL
  SELECT vessel_id, 'UK_ETS', EXTRACT(YEAR FROM report_time)::int,
         SUM(co2_t * uk_scope_pct / 100), SUM(co2e_t * uk_scope_pct / 100)
    FROM kris.fuel_emissions WHERE uk_scope_pct > 0 GROUP BY 1, 2, 3
), sur AS (
  SELECT vessel_id, scheme, obligation_year AS year, SUM(quantity) AS surrendered, max(surrendered_at) AS last_surrendered_at
    FROM kris.allowance_surrenders GROUP BY 1, 2, 3
), alloc AS (
  SELECT a.vessel_id, a.scheme, a.obligation_year AS year,
         SUM(a.quantity) FILTER (WHERE a.confirmed_at IS NULL)     AS requested,
         SUM(a.quantity) FILTER (WHERE a.confirmed_at IS NOT NULL) AS confirmed,
         SUM(a.quantity) FILTER (WHERE a.transferred_at IS NOT NULL) AS transferred
    FROM kris.carbon_allocations a JOIN kris.carbon_trades t ON t.id = a.trade_id AND t.status <> 'cancelled'
   GROUP BY 1, 2, 3
), o AS (
  SELECT em.vessel_id, em.scheme, em.year, y.gases, y.surrender_pct, y.surrender_deadline,
         CASE y.gases WHEN 'CO2' THEN em.co2_t ELSE em.co2e_t END AS emissions_t,
         ceil(CASE y.gases WHEN 'CO2' THEN em.co2_t ELSE em.co2e_t END * y.surrender_pct / 100)::int AS required,
         COALESCE(sur.surrendered, 0) AS surrendered, sur.last_surrendered_at,
         COALESCE(alloc.requested, 0) AS requested, COALESCE(alloc.confirmed, 0) AS confirmed,
         COALESCE(alloc.transferred, 0) AS transferred
    FROM em
    JOIN kris.ets_years y ON y.scheme = em.scheme AND y.year = em.year
    LEFT JOIN sur   ON sur.vessel_id = em.vessel_id AND sur.scheme = em.scheme AND sur.year = em.year
    LEFT JOIN alloc ON alloc.vessel_id = em.vessel_id AND alloc.scheme = em.scheme AND alloc.year = em.year
)
SELECT o.vessel_id, vs.name AS vessel_name, o.scheme, CASE o.scheme WHEN 'EU_ETS' THEN 'EUA' ELSE 'UKA' END AS instrument,
       o.year, o.year < EXTRACT(YEAR FROM now())::int AS is_complete_year,
       o.gases, round(o.emissions_t, 3) AS emissions_in_scope_t, o.surrender_pct,
       o.required AS allowances_required, o.surrendered AS allowances_surrendered, o.last_surrendered_at,
       o.requested AS allocations_requested, o.confirmed AS allocations_confirmed, o.transferred AS allocations_transferred,
       o.transferred - o.surrendered AS allowances_held,
       GREATEST(o.required - o.surrendered, 0) AS allowances_outstanding,
       o.surrender_deadline, o.surrender_deadline - current_date AS days_to_deadline,
       CASE WHEN o.year >= EXTRACT(YEAR FROM now())::int THEN 'accruing (year to date)'
            WHEN o.surrendered >= o.required THEN 'surrendered'
            WHEN o.surrender_deadline < current_date THEN 'overdue'
            WHEN o.confirmed + o.surrendered >= o.required THEN 'covered, surrender pending'
            ELSE 'due: allowances still to be sourced' END AS status
  FROM o JOIN kris.vessels vs ON vs.id = o.vessel_id;

-- Carbon and FuelEU exposure per vessel per year, priced at the latest
-- market price in kris.carbon_prices. EUA and FuelEU amounts are EUR,
-- UKA amounts GBP; they are not converted or added across currencies.
CREATE VIEW kris.carbon_exposure WITH (security_invoker = true) AS
WITH px AS (
  SELECT DISTINCT ON (instrument) instrument, price, price_date FROM kris.carbon_prices ORDER BY instrument, price_date DESC
), cost AS (
  SELECT a.vessel_id, a.scheme, a.obligation_year AS year, SUM(a.quantity * t.price) AS actual_cost
    FROM kris.carbon_allocations a JOIN kris.carbon_trades t ON t.id = a.trade_id
   WHERE a.confirmed_at IS NOT NULL AND t.status <> 'cancelled'
   GROUP BY 1, 2, 3
), yrs AS (
  SELECT vessel_id, year FROM kris.ets_obligations
  UNION SELECT vessel_id, year FROM kris.fueleu_period WHERE period = 'YEAR'
), x AS (
  SELECT y.vessel_id, y.year,
         eu.allowances_required AS eua_required,
         GREATEST(COALESCE(eu.allowances_required, 0) - GREATEST(COALESCE(eu.allowances_surrendered, 0), COALESCE(eu.allocations_confirmed, 0)), 0) AS eua_open,
         uk.allowances_required AS uka_required,
         GREATEST(COALESCE(uk.allowances_required, 0) - GREATEST(COALESCE(uk.allowances_surrendered, 0), COALESCE(uk.allocations_confirmed, 0)), 0) AS uka_open,
         ceu.actual_cost AS eua_actual_cost_eur, cuk.actual_cost AS uka_actual_cost_gbp,
         fe.penalty_eur AS fueleu_penalty_eur, fe.penalty_before_flexibility_eur AS fueleu_penalty_before_flexibility_eur,
         fe.final_balance_t AS fueleu_final_balance_t
    FROM yrs y
    LEFT JOIN kris.ets_obligations eu ON eu.vessel_id = y.vessel_id AND eu.year = y.year AND eu.scheme = 'EU_ETS'
    LEFT JOIN kris.ets_obligations uk ON uk.vessel_id = y.vessel_id AND uk.year = y.year AND uk.scheme = 'UK_ETS'
    LEFT JOIN cost ceu ON ceu.vessel_id = y.vessel_id AND ceu.year = y.year AND ceu.scheme = 'EU_ETS'
    LEFT JOIN cost cuk ON cuk.vessel_id = y.vessel_id AND cuk.year = y.year AND cuk.scheme = 'UK_ETS'
    LEFT JOIN kris.fueleu_period fe ON fe.vessel_id = y.vessel_id AND fe.year = y.year AND fe.period = 'YEAR'
)
SELECT x.vessel_id, vs.name AS vessel_name, x.year AS reporting_year, current_date AS as_of,
       x.eua_required, x.eua_open, eua.price AS eua_price_eur, eua.price_date AS eua_price_date,
       round(x.eua_open * eua.price, 2) AS eua_open_cost_eur, round(x.eua_actual_cost_eur, 2) AS eua_actual_cost_eur,
       x.uka_required, x.uka_open, uka.price AS uka_price_gbp,
       round(x.uka_open * uka.price, 2) AS uka_open_cost_gbp, round(x.uka_actual_cost_gbp, 2) AS uka_actual_cost_gbp,
       x.fueleu_final_balance_t, COALESCE(x.fueleu_penalty_eur, 0) AS fueleu_penalty_eur,
       x.fueleu_penalty_before_flexibility_eur,
       round(COALESCE(x.eua_open * eua.price, 0) + COALESCE(x.fueleu_penalty_eur, 0), 2) AS open_exposure_eur,
       round(COALESCE(x.uka_open * uka.price, 0), 2) AS open_exposure_gbp,
       CASE WHEN COALESCE(x.eua_open, 0) = 0 AND COALESCE(x.uka_open, 0) = 0 AND COALESCE(x.fueleu_penalty_eur, 0) = 0
            THEN 'covered' ELSE 'exposed' END AS status
  FROM x
  JOIN kris.vessels vs ON vs.id = x.vessel_id
  LEFT JOIN px eua ON eua.instrument = 'EUA'
  LEFT JOIN px uka ON uka.instrument = 'UKA';

CREATE VIEW kris.vessel_carbon_trades WITH (security_invoker = true) AS
SELECT a.vessel_id, vs.name AS vessel_name, a.allocation_ref, t.trade_ref, t.trade_date, t.instrument, t.side,
       t.quantity AS trade_quantity, a.quantity AS allocated_quantity, t.price, t.currency,
       round(a.quantity * t.price, 2) AS allocated_value,
       cp.name AS counterparty, cu.name AS customer, a.scheme, a.obligation_year,
       t.status AS trade_status, t.settled_at,
       a.requested_at, a.confirmed_at, a.confirmed_by, a.transferred_at,
       CASE WHEN t.status = 'cancelled' THEN 'cancelled'
            WHEN a.transferred_at IS NOT NULL THEN 'transferred'
            WHEN a.confirmed_at IS NOT NULL THEN 'confirmed'
            ELSE 'requested' END AS allocation_status,
       (SELECT string_agg(i.invoice_no, ', ') FROM kris.invoices i WHERE i.allocation_id = a.id) AS invoices
  FROM kris.carbon_allocations a
  JOIN kris.carbon_trades t ON t.id = a.trade_id
  JOIN kris.vessels vs      ON vs.id = a.vessel_id
  JOIN kris.companies cp    ON cp.id = t.counterparty_id
  JOIN kris.companies cu    ON cu.id = t.customer_id;

CREATE VIEW kris.invoice_status WITH (security_invoker = true) AS
SELECT i.vessel_id, vs.name AS vessel_name, i.invoice_no, cu.name AS customer, i.invoice_type,
       i.issue_date, i.due_date, i.amount, i.currency,
       CASE WHEN i.state IN ('draft', 'paid', 'void') THEN i.state
            WHEN i.due_date < current_date THEN 'overdue'
            ELSE 'pending' END AS status,
       CASE WHEN i.state = 'issued' AND i.due_date < current_date THEN current_date - i.due_date END AS days_overdue,
       i.paid_at, t.trade_ref, a.allocation_ref, i.description,
       (SELECT string_agg(c.message_id, ', ' ORDER BY c.sent_at) FROM kris.communications c WHERE c.invoice_id = i.id) AS emails
  FROM kris.invoices i
  JOIN kris.companies cu ON cu.id = i.customer_id
  LEFT JOIN kris.vessels vs ON vs.id = i.vessel_id
  LEFT JOIN kris.carbon_trades t ON t.id = i.trade_id
  LEFT JOIN kris.carbon_allocations a ON a.id = i.allocation_id;

-- Every filing with the figures it reports. Figures that do not belong to a
-- regime are NULL on its rows.
CREATE VIEW kris.compliance_overview WITH (security_invoker = true) AS
SELECT f.vessel_id, vs.name AS vessel_name, f.regime, f.period_year, f.document,
       f.submission_status, f.verification_status, f.due_date, f.submitted_at, f.verified_at,
       f.approved_at, f.next_review_at, ver.name AS verifier, f.reference, f.notes,
       CASE WHEN f.regime IN ('IMO_DCS', 'EU_MRV') THEN ao.fuel_t END          AS fuel_t,
       CASE WHEN f.regime IN ('IMO_DCS', 'EU_MRV') THEN ao.distance_nm END     AS distance_nm,
       CASE WHEN f.regime IN ('IMO_DCS', 'EU_MRV') THEN ao.hours_underway END  AS hours_underway,
       CASE WHEN f.regime = 'IMO_DCS' THEN ao.co2_t END                         AS co2_t,
       CASE WHEN f.regime = 'EU_MRV' THEN ao.eu_fuel_t END                      AS eu_fuel_t,
       CASE WHEN f.regime = 'EU_MRV' THEN ao.eu_co2_t END                       AS eu_co2_t,
       CASE WHEN f.regime = 'EU_MRV' THEN ao.transport_work_t_nm END            AS transport_work_t_nm,
       CASE WHEN f.regime IN ('CII', 'SEEMP_III') THEN ci.attained_cii END      AS attained_cii,
       CASE WHEN f.regime IN ('CII', 'SEEMP_III') THEN ci.required_cii END      AS required_cii,
       CASE WHEN f.regime IN ('CII', 'SEEMP_III') THEN ci.rating END            AS cii_rating,
       CASE WHEN f.regime = 'FUELEU' THEN fe.ghg_intensity END                  AS ghg_intensity,
       CASE WHEN f.regime = 'FUELEU' THEN fe.final_balance_t END                AS fueleu_final_balance_t,
       CASE WHEN f.regime = 'FUELEU' THEN fe.penalty_eur END                    AS fueleu_penalty_eur,
       CASE WHEN f.regime = 'FUELEU' THEN fe.pool_name END                      AS fueleu_pool,
       CASE WHEN f.regime IN ('EU_ETS', 'UK_ETS') THEN eo.allowances_required END    AS allowances_required,
       CASE WHEN f.regime IN ('EU_ETS', 'UK_ETS') THEN eo.allowances_surrendered END AS allowances_surrendered,
       CASE WHEN f.regime IN ('EU_ETS', 'UK_ETS') THEN eo.status END                 AS allowance_status
  FROM kris.compliance_filings f
  JOIN kris.vessels vs ON vs.id = f.vessel_id
  LEFT JOIN kris.companies ver ON ver.id = f.verifier_id
  LEFT JOIN kris.annual_operations ao ON ao.vessel_id = f.vessel_id AND ao.year = f.period_year
  LEFT JOIN kris.cii_annual ci        ON ci.vessel_id = f.vessel_id AND ci.year = f.period_year
  LEFT JOIN kris.fueleu_period fe     ON fe.vessel_id = f.vessel_id AND fe.year = f.period_year AND fe.period = 'YEAR'
  LEFT JOIN kris.ets_obligations eo   ON eo.vessel_id = f.vessel_id AND eo.year = f.period_year AND eo.scheme = f.regime;

CREATE VIEW kris.communication_log WITH (security_invoker = true) AS
SELECT c.vessel_id, vs.name AS vessel_name, c.message_id, c.thread_id, c.sent_at, c.direction,
       c.from_address, array_to_string(c.to_addresses, ', ') AS to_addresses, c.subject, c.body,
       c.category, c.priority, c.status, cu.name AS customer,
       v.voyage_no, b.bdn_no, i.invoice_no, t.trade_ref, a.allocation_ref,
       CASE WHEN f.id IS NOT NULL THEN f.regime || ' ' || COALESCE(f.period_year::text, '') END AS filing,
       (SELECT string_agg(x ->> 'name', ', ') FROM jsonb_array_elements(c.attachments) x) AS attachments
  FROM kris.communications c
  LEFT JOIN kris.vessels vs ON vs.id = c.vessel_id
  LEFT JOIN kris.companies cu ON cu.id = c.customer_id
  LEFT JOIN kris.voyages v ON v.id = c.voyage_id
  LEFT JOIN kris.bunker_deliveries b ON b.id = c.bdn_id
  LEFT JOIN kris.invoices i ON i.id = c.invoice_id
  LEFT JOIN kris.carbon_trades t ON t.id = c.trade_id
  LEFT JOIN kris.carbon_allocations a ON a.id = c.allocation_id
  LEFT JOIN kris.compliance_filings f ON f.id = c.filing_id;

-- ============================================================================
--  12. Roles, grants, row-level security
--
--  Roles are created without a password; `node db/setup.js` sets one and
--  writes KRIS_READ_URL / KRIS_WRITE_URL. Run from the SQL editor instead?
--  Then: ALTER ROLE kris_reader PASSWORD '...'; ALTER ROLE kris_writer PASSWORD '...';
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kris_reader') THEN CREATE ROLE kris_reader LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kris_writer') THEN CREATE ROLE kris_writer LOGIN; END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO kris_reader, kris_writer', current_database());
  -- Supabase's API roles get nothing here, whatever changes later in the dashboard.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA kris FROM anon';
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA kris FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA kris FROM authenticated';
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA kris FROM authenticated';
  END IF;
END
$$;

-- Reader: every table and view, nothing else, in a read-only session.
GRANT USAGE ON SCHEMA kris TO kris_reader, kris_writer;
GRANT SELECT ON ALL TABLES IN SCHEMA kris TO kris_reader;
ALTER ROLE kris_reader SET default_transaction_read_only = on;
ALTER ROLE kris_reader SET statement_timeout = '8s';
ALTER ROLE kris_reader SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE kris_reader SET search_path = kris;

-- Writer: the sync tables, vocabulary and the query log.
GRANT SELECT, INSERT, UPDATE ON kris.geoform_reports, kris.veson_legs, kris.veson_offhire, kris.vessels,
                                kris.kris_sync_log, kris.kris_term_mappings TO kris_writer;
GRANT SELECT, INSERT ON kris.kris_query_log TO kris_writer;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA kris TO kris_writer;
ALTER ROLE kris_writer SET statement_timeout = '15s';
ALTER ROLE kris_writer SET search_path = kris;

-- Row-level security on every table: the two roles above see what their
-- grants allow; any other role without a policy sees no rows at all.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'kris' AND c.relkind = 'r' LOOP
    EXECUTE format('ALTER TABLE kris.%I ENABLE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('DROP POLICY IF EXISTS kris_reader_select ON kris.%I', t.relname);
    EXECUTE format('CREATE POLICY kris_reader_select ON kris.%I FOR SELECT TO kris_reader USING (true)', t.relname);
  END LOOP;
  FOR t IN SELECT unnest(ARRAY['geoform_reports', 'veson_legs', 'veson_offhire', 'vessels',
                               'kris_sync_log', 'kris_term_mappings', 'kris_query_log']) AS relname LOOP
    EXECUTE format('DROP POLICY IF EXISTS kris_writer_all ON kris.%I', t.relname);
    EXECUTE format('CREATE POLICY kris_writer_all ON kris.%I FOR ALL TO kris_writer USING (true) WITH CHECK (true)', t.relname);
  END LOOP;
END
$$;

COMMIT;
