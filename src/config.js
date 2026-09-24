'use strict';

/**
 * ============================================================================
 *  KRIS — DATA REGISTRY
 * ============================================================================
 *  THIS IS THE ONLY FILE YOU NEED TO EDIT TO POINT KRIS AT YOUR SCHEMA.
 *
 *  Nothing else in K.R.1.S contains a table name or a column name. Every
 *  identifier that reaches SQL is looked up here first; anything not declared
 *  here can never be queried. That is what makes SQL injection structurally
 *  impossible rather than merely filtered.
 *
 *  Fill in SOURCES (your tables) and METRICS (your columns) below.
 * ============================================================================
 */

/**
 * SOURCES — the tables K.R.1.S is allowed to read.
 *
 *   key            internal id, referenced by metrics
 *   table          real table name (optionally "schema.table")
 *   vesselColumn   column holding the vessel identifier
 *   timeColumn     column holding the report timestamp / date
 *   timeColumnType 'date'        -> a calendar date, no clock time
 *                  'timestamptz' -> an instant (supports hour-level questions)
 *                  'timestamp'
 *   granularity    'daily' | 'hourly' | 'sub_hourly'
 *                  K.R.1.S refuses hour-of-day questions against 'daily'
 *                  sources instead of silently answering the wrong thing.
 *   description    shown to users when K.R.1.S explains where a number came from
 */
const SOURCES = {
  // Departure, noon and arrival reports: one row per report, with the fuel
  // burned since the previous one. Filled by the Geoform sync or db/setup.js.
  geoform_reports: {
    key: 'geoform_reports',
    table: 'kris.geoform_reports',
    vesselColumn: 'imo',
    timeColumn: 'report_date',
    timeColumnType: 'date',
    granularity: 'daily',
    description: 'Vessel reports (departure, noon, arrival)',
  },
  // One row per voyage (kris.voyage_summary in db/001_schema.sql), dated by
  // its departure. A voyage belongs to the period it departed in; nothing is
  // prorated across a period boundary.
  voyages: {
    key: 'voyages',
    table: 'kris.voyage_summary',
    vesselColumn: 'vessel_id',
    timeColumn: 'departure_at',
    timeColumnType: 'timestamptz',
    granularity: 'daily',
    description: 'Voyage summary',
  },
  veson_offhire: {
    key: 'veson_offhire',
    table: 'kris.veson_offhire',
    vesselColumn: 'imo',
    timeColumn: 'start_date',
    timeColumnType: 'date',
    granularity: 'daily',
    description: 'Off-hire events',
  },
};

/**
 * VESSELS — how K.R.1.S finds and names vessels. Vessel ids ARE IMO numbers,
 * because that is the key shared by Veson and Geoform. A question may name a
 * vessel by its name, its IMO or its short code.
 */
const VESSELS = {
  table: 'kris.vessels',
  idColumn: 'id',
  nameColumn: 'name',
  scopeColumn: 'department',
  altNameColumns: ['imo', 'vessel_code'],
};

/**
 * METRICS — one number per row of a source, aggregated over a period.
 * Anything that is a record or a status rather than a measurement (vessel
 * particulars, a voyage's ports, CII ratings, FuelEU after pooling, filings,
 * trades, invoices, emails) is served by RECORDS below instead.
 */
const METRICS = [
  // --- reports -------------------------------------------------------------
  { key: 'shaft_power', label: 'Shaft power', unit: 'kW', source: 'geoform_reports', column: 'shaft_power_kw', kind: 'rate', decimals: 1,
    aliases: ['shaft power', 'sp', 'shaft output', 'shaft kw', 'power', 'me power', 'main engine power', 'shaft pwr', 'brake power'],
    description: 'Main engine shaft power' },
  { key: 'fuel_consumption', label: 'Fuel consumption', unit: 'MT', source: 'geoform_reports', column: 'fuel_consumed_mt', kind: 'quantity', decimals: 3,
    aliases: ['fuel consumption', 'fuel consumed', 'fuel oil consumption', 'foc', 'bunker consumption', 'fuel burn', 'fuel used', 'daily consumption', 'noon consumption', 'report consumption'],
    description: 'Total fuel burned per report, all consumers and fuel types' },
  { key: 'me_consumption', label: 'Main engine consumption', unit: 'MT', source: 'geoform_reports', column: 'me_fuel_mt', kind: 'quantity', decimals: 3,
    aliases: ['main engine consumption', 'me consumption', 'me foc', 'me fuel', 'main engine fuel', 'propulsion consumption'] },
  { key: 'ae_consumption', label: 'Auxiliary engine consumption', unit: 'MT', source: 'geoform_reports', column: 'ae_fuel_mt', kind: 'quantity', decimals: 3,
    aliases: ['auxiliary engine consumption', 'ae consumption', 'ae foc', 'ae fuel', 'auxiliary consumption', 'aux consumption', 'aux fuel'] },
  { key: 'boiler_consumption', label: 'Boiler consumption', unit: 'MT', source: 'geoform_reports', column: 'boiler_fuel_mt', kind: 'quantity', decimals: 3,
    aliases: ['boiler consumption', 'boiler fuel', 'boiler foc'] },
  { key: 'distance', label: 'Distance sailed', unit: 'nm', source: 'geoform_reports', column: 'distance_nm', kind: 'quantity', decimals: 1,
    aliases: ['distance sailed', 'distance run', 'miles', 'nautical miles', 'dist', 'daily distance'] },
  { key: 'hours_underway', label: 'Hours underway', unit: 'hours', source: 'geoform_reports', column: 'hours_underway', kind: 'quantity', decimals: 1,
    aliases: ['hours underway', 'steaming hours', 'hours at sea', 'sailing hours'] },
  { key: 'speed', label: 'Speed over ground', unit: 'kn', source: 'geoform_reports', column: 'speed_kn', kind: 'rate', decimals: 2,
    aliases: ['speed', 'sog', 'speed over ground', 'vessel speed', 'avg speed'] },
  { key: 'rpm', label: 'Main engine RPM', unit: 'rpm', source: 'geoform_reports', column: 'me_rpm', kind: 'rate', decimals: 1,
    aliases: ['rpm', 'revolutions', 'engine rpm', 'me rpm', 'shaft rpm'] },
  { key: 'co2', label: 'CO2 emitted', unit: 'MT', source: 'geoform_reports', column: 'co2_mt', kind: 'quantity', decimals: 3,
    aliases: ['carbon dioxide', 'co2 emissions', 'carbon emitted', 'daily co2', 'report co2'] },

  // --- voyages ---------------------------------------------------------------
  { key: 'leg_fuel', label: 'Voyage fuel consumption', unit: 'MT', source: 'voyages', column: 'fuel_t', kind: 'quantity', decimals: 3,
    aliases: ['voyage consumption', 'voyage fuel', 'leg fuel', 'leg consumption', 'fueleu consumption', 'fueleu fuel', 'leg wise consumption'],
    description: 'Fuel per voyage, all fuel types' },
  { key: 'hsfo_consumption', label: 'HSFO consumption', unit: 'MT', source: 'voyages', column: 'hsfo_t', kind: 'quantity', decimals: 3,
    aliases: ['hsfo', 'hsfo consumption', 'high sulphur fuel oil', 'hfo consumption'] },
  { key: 'vlsfo_consumption', label: 'VLSFO consumption', unit: 'MT', source: 'voyages', column: 'vlsfo_t', kind: 'quantity', decimals: 3,
    aliases: ['vlsfo', 'vlsfo consumption', 'very low sulphur fuel oil'] },
  { key: 'mgo_consumption', label: 'MGO consumption', unit: 'MT', source: 'voyages', column: 'mgo_t', kind: 'quantity', decimals: 3,
    aliases: ['mgo', 'mgo consumption', 'marine gas oil', 'gas oil consumption'] },
  { key: 'lng_consumption', label: 'LNG consumption', unit: 'MT', source: 'voyages', column: 'lng_t', kind: 'quantity', decimals: 3,
    aliases: ['lng', 'lng consumption', 'gas consumption', 'liquefied natural gas'] },
  { key: 'leg_co2', label: 'Voyage CO2', unit: 'MT', source: 'voyages', column: 'co2_t', kind: 'quantity', decimals: 3,
    aliases: ['voyage co2', 'voyage emissions', 'leg co2', 'leg emissions', 'fueleu co2'] },
  { key: 'leg_distance', label: 'Voyage distance', unit: 'nm', source: 'voyages', column: 'distance_nm', kind: 'quantity', decimals: 1,
    aliases: ['voyage distance', 'leg distance', 'leg miles'] },
  { key: 'voyage_days', label: 'Voyage days', unit: 'days', source: 'voyages', column: 'total_days', kind: 'quantity', decimals: 2,
    aliases: ['voyage days', 'total voyage days', 'voyage duration'] },
  { key: 'net_days', label: 'Net voyage days', unit: 'days', source: 'voyages', column: 'net_days', kind: 'quantity', decimals: 2,
    aliases: ['net days', 'net voyage days', 'net sailing days'] },
  { key: 'sea_days', label: 'Days at sea', unit: 'days', source: 'voyages', column: 'sea_days', kind: 'quantity', decimals: 2,
    aliases: ['sea days', 'days at sea', 'at sea days'] },
  { key: 'port_days', label: 'Days in port', unit: 'days', source: 'voyages', column: 'port_days', kind: 'quantity', decimals: 2,
    aliases: ['port days', 'days in port', 'port time', 'port stay'] },
  { key: 'compliance_balance', label: 'Voyage FuelEU compliance balance', unit: 'tCO2e', source: 'voyages', column: 'compliance_balance_t', kind: 'quantity', decimals: 3,
    aliases: ['voyage compliance balance', 'leg compliance balance', 'voyage fueleu balance'],
    description: 'Sum of voyage balances before banking, borrowing and pooling' },
  { key: 'legs', label: 'Voyages', unit: 'voyages', source: 'voyages', column: 'voyage_id', kind: 'quantity', decimals: 0, countOnly: true,
    aliases: ['number of voyages', 'how many voyages', 'voyage count', 'legs', 'voyage legs', 'leg count'] },

  // --- off-hire ----------------------------------------------------------------
  { key: 'offhire_hours', label: 'Off-hire time', unit: 'hours', source: 'veson_offhire', column: 'offhire_hours', kind: 'quantity', decimals: 1,
    aliases: ['off hire', 'offhire', 'off hire hours', 'offhire hours', 'off hire time', 'downtime', 'off hire duration'] },
  { key: 'offhire_days', label: 'Off-hire days', unit: 'days', source: 'veson_offhire', column: 'offhire_days', kind: 'quantity', decimals: 2,
    aliases: ['off hire days', 'offhire days', 'days off hire'] },
];

/**
 * METRIC_GROUPS — words that legitimately refer to more than one metric.
 * K.R.1.S asks instead of picking. An organisation can resolve a group for
 * itself by teaching K.R.1.S ("consumption means fuel consumption").
 */
const METRIC_GROUPS = [
  { term: 'consumption', metrics: ['fuel_consumption', 'me_consumption', 'ae_consumption', 'leg_fuel'] },
  { term: 'fuel', metrics: ['fuel_consumption', 'me_consumption', 'ae_consumption', 'leg_fuel'] },
  { term: 'burn', metrics: ['fuel_consumption', 'me_consumption', 'ae_consumption'] },
  { term: 'bunkers', metrics: ['fuel_consumption', 'leg_fuel'] },
  { term: 'emissions', metrics: ['co2', 'leg_co2'] },
  { term: 'co2', metrics: ['co2', 'leg_co2'] },
  { term: 'distance', metrics: ['distance', 'leg_distance'] },
];

/**
 * RECORDS — what K.R.1.S can look up that is not a single measurement: the
 * rows of a view, limited to the user's vessels, newest first. The model
 * reaches them through the get_vessel_records tool (src/records.js), which
 * builds its SQL from this block only. Same rule as SOURCES: nothing typed
 * by a user ever becomes an identifier.
 *
 *   table          view or table ("schema.name")
 *   vesselColumn   vessel id column (default vessel_id)
 *   timeColumn     for "latest", period filters and default ordering
 *   yearColumn     for a year filter, when the rows are per year
 *   voyageColumns  columns a voyage number or reference can match
 *   filters        columns that may be filtered for equality (value bound)
 *   orderBy        "col [ASC|DESC] [NULLS FIRST|LAST], ..." (default timeColumn DESC)
 *   columns        explicit column list (default: every column of the view)
 *   longText       columns clipped in the reply
 *   about          what the rows hold; the model reads this
 */
const RECORDS = {
  vessels: {
    table: 'kris.vessel_particulars', label: 'Vessel particulars', orderBy: 'vessel_name ASC',
    about: 'name, IMO, code, type, flag, owner, manager, charterer, customer, GT, NT, DWT, cargo capacity, main engine, cylinders, MCR, RPM, auxiliary engines, scrubber, dual-fuel, fuel types, year built, builder, class, design and reference speed, whether it is test data',
  },
  voyages: {
    table: 'kris.voyage_summary', label: 'Voyages', timeColumn: 'departure_at', voyageColumns: ['voyage_no', 'voyage_ref'],
    filters: ['status', 'leg_type', 'from_port', 'to_port'],
    about: 'one row per voyage: from and to port (name, UN/LOCODE, country), departure, arrival, status (underway, in_port, completed), sea, port, total, off-hire and net days, distance at sea and in port, hours underway, average speed, cargo and quantity, charterer, fuel total and by type (HSFO, VLSFO, MGO, MDO, LNG), fuel and CO2 at sea and in port, ME/AE/boiler fuel, CO2e, energy, WtW GHG intensity, EU scope share and EU CO2, the voyage FuelEU balance (tCO2e, before pooling), transport work and EEOI',
  },
  port_calls: {
    table: 'kris.port_call_log', label: 'Port calls', timeColumn: 'arrival_at', voyageColumns: ['voyage_no'], filters: ['locode', 'purpose'],
    about: 'port name, UN/LOCODE, country, region, purpose, arrival, berthing, departure, hours and days in port, whether still in port',
  },
  voyage_fuel: {
    table: 'kris.voyage_fuel', label: 'Fuel by voyage and fuel type', timeColumn: 'first_report_at', voyageColumns: ['voyage_no'], filters: ['fuel_code'],
    about: 'per voyage and fuel type: tonnes at sea, in port, main engine, auxiliary engines, boiler, total, CO2 emission factor, CO2, energy',
  },
  reports: {
    table: 'kris.geoform_reports', label: 'Vessel reports', vesselColumn: 'imo', timeColumn: 'report_time', filters: ['form_type', 'mode'],
    columns: ['imo', 'vessel_name', 'form_type', 'report_time', 'mode', 'hours_underway', 'distance_nm', 'speed_kn', 'shaft_power_kw', 'me_rpm',
      'me_fuel_mt', 'ae_fuel_mt', 'boiler_fuel_mt', 'fuel_consumed_mt', 'co2_mt'],
    about: 'departure, noon and arrival reports: mode (sea or port), hours underway, distance, speed, shaft power, RPM, ME/AE/boiler fuel, total fuel and CO2 since the previous report',
  },
  bunkers: {
    table: 'kris.bunker_log', label: 'Bunker deliveries (BDNs)', timeColumn: 'delivered_at', voyageColumns: ['voyage_no'], filters: ['fuel_code', 'status', 'locode'],
    about: 'BDN number, port, delivery date, fuel, quantity, sulphur, density, supplier, voyage, status (requested, received, verified, disputed)',
  },
  annual: {
    table: 'kris.annual_operations', label: 'Annual operations (IMO DCS and EU MRV figures)', yearColumn: 'year', orderBy: 'year DESC',
    about: 'per calendar year: voyages, port calls, distance, hours underway, fuel total and by type, CO2, CO2e, energy, EU-scope fuel and CO2, CO2 at berth in the EU, transport work, EEOI, whether the year is complete',
  },
  cii: {
    table: 'kris.cii_annual', label: 'AER and CII by year', yearColumn: 'year', orderBy: 'year DESC',
    about: 'per year: ship type, capacity, distance, CO2, corrections, AER, attained CII, reference line, reduction factor, required CII, attained/required ratio, A-E rating boundaries, rating, the two previous ratings, status (compliant, attention, corrective action plan required, provisional)',
  },
  fueleu: {
    table: 'kris.fueleu_period', label: 'FuelEU Maritime by period', yearColumn: 'year', orderBy: 'year DESC, period DESC', filters: ['period'],
    about: 'per quarter (Q1 to Q4) and year (period YEAR): energy in scope, WtT, TtW and WtW GHG intensity, target, compliance balance (g and tCO2e), banked in and out, borrowed, pool and pool transfer, final balance, penalty before and after flexibility (EUR), status. Only YEAR rows carry banking, pooling and the penalty',
  },
  allowances: {
    table: 'kris.ets_obligations', label: 'EU ETS and UK ETS allowances', yearColumn: 'year', orderBy: 'year DESC, scheme ASC', filters: ['scheme'],
    about: 'per scheme (EU_ETS, UK_ETS) and year: gases, emissions in scope, surrender share, allowances required, surrendered, allocated (requested, confirmed, transferred), held, outstanding, surrender deadline, days to deadline, status',
  },
  exposure: {
    table: 'kris.carbon_exposure', label: 'Carbon exposure', yearColumn: 'reporting_year', orderBy: 'reporting_year DESC',
    about: 'per reporting year: EUAs required and still open, latest EUA price, estimated cost of the open EUAs, actual cost of confirmed allocations, the same for UKAs in GBP, FuelEU final balance and penalty, total open exposure in EUR and in GBP, status (covered or exposed), as-of date',
  },
  compliance: {
    table: 'kris.compliance_overview', label: 'Compliance filings', yearColumn: 'period_year', orderBy: 'period_year DESC NULLS LAST, regime ASC', filters: ['regime'],
    about: 'regimes IMO_DCS, EU_MRV, EU_ETS, UK_ETS, FUELEU, CII, SEEMP_I, SEEMP_II, SEEMP_III: document, submission status, verification status, due date, submitted, verified, approved, next review, verifier, reference, notes, and the figures each reports (fuel, distance, hours underway, CO2, EU CO2, transport work, CII and rating, FuelEU balance and penalty, allowances)',
  },
  carbon_trades: {
    table: 'kris.vessel_carbon_trades', label: 'Carbon trades and allocations', timeColumn: 'trade_date', filters: ['instrument', 'allocation_status'],
    about: 'EUA and UKA trades allocated to the vessel: trade and allocation reference, trade date, side, trade and allocated quantity, price, currency, allocated value, counterparty, customer, scheme, obligation year, trade status, requested, confirmed and transferred dates, allocation status, invoices',
  },
  invoices: {
    table: 'kris.invoice_status', label: 'Invoices', timeColumn: 'issue_date', filters: ['status', 'invoice_type'],
    about: 'invoice number, customer, type, issue and due date, amount, currency, status (draft, pending, overdue, paid, void), days overdue, paid date, trade and allocation reference, description, related emails',
  },
  emails: {
    table: 'kris.communication_log', label: 'Emails', timeColumn: 'sent_at', filters: ['category', 'status', 'thread_id'], longText: ['body'],
    about: 'date, direction, sender, recipients, subject, body, category (bdn_request, bdn_received, vessel_report, allocation_request, allocation_confirmation, customer_query, fueleu_query, eu_mrv_query, imo_dcs_query, uka_query, invoice_query, carbon_trading), priority, status, customer, linked voyage, BDN, invoice, trade, allocation and filing, attachments',
  },
  offhire: {
    table: 'kris.veson_offhire', label: 'Off-hire events', vesselColumn: 'imo', timeColumn: 'start_time', voyageColumns: ['voyage_no'],
    columns: ['imo', 'vessel_name', 'voyage_no', 'start_time', 'end_time', 'offhire_hours', 'offhire_days', 'reason'],
    about: 'off-hire events: voyage, start, end, hours, days, reason',
  },
};

/** Runtime limits. */
const LIMITS = {
  maxRawRows: 500,          // rows returned for a "show me the values" answer
  maxSeriesPoints: 400,     // points returned for a trend
  statementTimeoutMs: 8000,
  maxRangeDays: 1830,       // ~5 years; wider ranges are refused, not truncated
};

// ---------------------------------------------------------------------------
// Derived indexes + validation. Nothing below here needs editing.
// ---------------------------------------------------------------------------

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
// One ORDER BY term of a RECORDS entry: a column, a direction, a nulls position.
const ORDER_PART = /^\s*[A-Za-z_][A-Za-z0-9_]*(\s+(ASC|DESC))?(\s+NULLS\s+(FIRST|LAST))?\s*$/i;

function assertIdent(value, what) {
  if (typeof value !== 'string' || !IDENT.test(value)) {
    throw new Error(`K.R.1.S config: invalid identifier for ${what}: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Which aggregations are meaningful for each metric kind.
 * Blocking `sum` on rates is deliberate — see METRICS.kind above.
 */
const AGGREGATIONS_BY_KIND = {
  quantity: ['value', 'sum', 'avg', 'min', 'max', 'count', 'trend', 'compare', 'summary'],
  rate: ['value', 'avg', 'min', 'max', 'count', 'trend', 'compare', 'summary'],
  counter: ['value', 'delta', 'min', 'max', 'trend', 'compare', 'summary'],
};

function validateConfig() {
  const errors = [];

  for (const src of Object.values(SOURCES)) {
    try {
      assertIdent(src.table, `source ${src.key}.table`);
      assertIdent(src.vesselColumn, `source ${src.key}.vesselColumn`);
      assertIdent(src.timeColumn, `source ${src.key}.timeColumn`);
    } catch (e) { errors.push(e.message); }
    if (!['date', 'timestamp', 'timestamptz'].includes(src.timeColumnType)) {
      errors.push(`K.R.1.S config: source ${src.key} has unknown timeColumnType`);
    }
    if (!['daily', 'hourly', 'sub_hourly'].includes(src.granularity)) {
      errors.push(`K.R.1.S config: source ${src.key} has unknown granularity`);
    }
  }

  try {
    assertIdent(VESSELS.table, 'VESSELS.table');
    assertIdent(VESSELS.idColumn, 'VESSELS.idColumn');
    assertIdent(VESSELS.nameColumn, 'VESSELS.nameColumn');
    if (VESSELS.scopeColumn) assertIdent(VESSELS.scopeColumn, 'VESSELS.scopeColumn');
    for (const c of VESSELS.altNameColumns || []) assertIdent(c, 'VESSELS.altNameColumns');
  } catch (e) { errors.push(e.message); }

  const seenKeys = new Set();
  for (const m of METRICS) {
    if (seenKeys.has(m.key)) errors.push(`K.R.1.S config: duplicate metric key ${m.key}`);
    seenKeys.add(m.key);
    if (!SOURCES[m.source]) errors.push(`K.R.1.S config: metric ${m.key} references unknown source ${m.source}`);
    if (!AGGREGATIONS_BY_KIND[m.kind]) errors.push(`K.R.1.S config: metric ${m.key} has unknown kind ${m.kind}`);
    try { assertIdent(m.column, `metric ${m.key}.column`); } catch (e) { errors.push(e.message); }
    if (!m.unit) errors.push(`K.R.1.S config: metric ${m.key} is missing a unit`);
  }

  for (const g of METRIC_GROUPS) {
    if (!g.metrics || g.metrics.length < 2) {
      errors.push(`K.R.1.S config: group "${g.term}" must point at two or more metrics`);
    }
    for (const k of g.metrics || []) {
      if (!METRICS.some((m) => m.key === k)) {
        errors.push(`K.R.1.S config: group "${g.term}" references unknown metric ${k}`);
      }
    }
  }

  for (const [key, r] of Object.entries(RECORDS)) {
    try {
      assertIdent(r.table, `record ${key}.table`);
      assertIdent(r.vesselColumn || 'vessel_id', `record ${key}.vesselColumn`);
      for (const c of [r.timeColumn, r.yearColumn].filter(Boolean)) assertIdent(c, `record ${key} time/year column`);
      for (const c of [...(r.voyageColumns || []), ...(r.filters || []), ...(r.columns || []), ...(r.longText || [])]) assertIdent(c, `record ${key} column`);
      for (const part of String(r.orderBy || '').split(',').filter((x) => x.trim())) {
        if (!ORDER_PART.test(part)) throw new Error(`K.R.1.S config: record ${key} has an invalid orderBy: ${JSON.stringify(r.orderBy)}`);
      }
      if (!r.label || !r.about) throw new Error(`K.R.1.S config: record ${key} needs a label and an about`);
    } catch (e) { errors.push(e.message); }
  }

  if (errors.length) throw new Error(errors.join('\n'));
  return true;
}

validateConfig();

const METRICS_BY_KEY = Object.fromEntries(METRICS.map((m) => [m.key, m]));

function allowedAggregations(metric) {
  return AGGREGATIONS_BY_KIND[metric.kind] || [];
}

/** True when the metric's own table can resolve questions at this granularity. */
function sourceSupports(sourceKey, needed) {
  const order = { daily: 1, hourly: 2, sub_hourly: 3 };
  const have = order[SOURCES[sourceKey].granularity] || 0;
  return have >= (order[needed] || 0);
}

/**
 * If a question needs finer resolution than the metric's default source
 * offers, look for a declared finer sibling. Returns null when none exists —
 * the caller then tells the user the data does not exist, rather than
 * answering at the wrong resolution.
 */
function finerMetricFor(metricKey, neededGranularity) {
  if (sourceSupports(METRICS_BY_KEY[metricKey].source, neededGranularity)) {
    return METRICS_BY_KEY[metricKey];
  }
  const sibling = METRICS.find(
    (m) => m.finerVersionOf === metricKey && sourceSupports(m.source, neededGranularity)
  );
  return sibling || null;
}

module.exports = {
  SOURCES,
  VESSELS,
  RECORDS,
  ORDER_PART,
  METRICS,
  METRIC_GROUPS,
  METRICS_BY_KEY,
  LIMITS,
  AGGREGATIONS_BY_KIND,
  allowedAggregations,
  sourceSupports,
  finerMetricFor,
  validateConfig,
  assertIdent,
};