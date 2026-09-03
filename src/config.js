'use strict';

/**
 * ============================================================================
 *  CAPTAIN — DATA REGISTRY
 * ============================================================================
 *  THIS IS THE ONLY FILE YOU NEED TO EDIT TO POINT CAPTAIN AT YOUR SCHEMA.
 *
 *  Nothing else in Captain contains a table name or a column name. Every
 *  identifier that reaches SQL is looked up here first; anything not declared
 *  here can never be queried. That is what makes SQL injection structurally
 *  impossible rather than merely filtered.
 *
 *  Fill in SOURCES (your tables) and METRICS (your columns) below.
 * ============================================================================
 */

/**
 * SOURCES — the tables Captain is allowed to read.
 *
 *   key            internal id, referenced by metrics
 *   table          real table name (optionally "schema.table")
 *   vesselColumn   column holding the vessel identifier
 *   timeColumn     column holding the report timestamp / date
 *   timeColumnType 'date'        -> a calendar date, no clock time
 *                  'timestamptz' -> an instant (supports hour-level questions)
 *                  'timestamp'
 *   granularity    'daily' | 'hourly' | 'sub_hourly'
 *                  Captain refuses hour-of-day questions against 'daily'
 *                  sources instead of silently answering the wrong thing.
 *   description    shown to users when Captain explains where a number came from
 */
const SOURCES = {
  geoform_reports: {
    key: 'geoform_reports',
    table: 'geoform_reports',
    vesselColumn: 'imo',
    timeColumn: 'report_date',
    timeColumnType: 'date',
    granularity: 'daily',
    description: 'Geoform vessel reports',
  },
  veson_legs: {
    key: 'veson_legs',
    table: 'veson_legs',
    vesselColumn: 'imo',
    timeColumn: 'leg_date',
    timeColumnType: 'date',
    granularity: 'daily',
    description: 'Veson IMOS FuelEU leg-wise report',
  },
  veson_offhire: {
    key: 'veson_offhire',
    table: 'veson_offhire',
    vesselColumn: 'imo',
    timeColumn: 'start_date',
    timeColumnType: 'date',
    granularity: 'daily',
    description: 'Veson IMOS FuelEU off-hire report',
  },

  // --- fueleu_final / dnv -----------------------------------------------------
  // Both read through a VIEW, not the raw table (see db/003_captain_fueleu_dnv_views.sql).
  // Reason: the underlying tables use identifiers with spaces ("CB at Start",
  // "Gross CB") that Captain's identifier validator correctly refuses to
  // declare directly — that refusal is what makes SQL injection structurally
  // impossible elsewhere in this file, so the view exists instead of loosening it.
  //
  // GRANULARITY CAVEAT: both sources are per-voyage / per-period rows, not one
  // row per calendar day. "daily" is declared because it is the finest option
  // this schema supports meaningfully — but a voyage spanning e.g. 3 days has
  // ONE row for the whole span, not a value for each day inside it. A question
  // like "gross CB for Aurora Trader yesterday" will only match if a voyage
  // record's own start/end falls inside "yesterday" — it will NOT prorate or
  // interpolate a mid-voyage value. Fine for "this voyage" / "this month"
  // style questions; misleading for anything asking about a single day inside
  // a longer voyage. Flag if that's not the behaviour you want.
  captain_fueleu_final: {
    key: 'captain_fueleu_final',
    table: 'captain_fueleu_final',
    vesselColumn: 'imo',
    timeColumn: 'voyage_start',
    timeColumnType: 'timestamptz',
    granularity: 'daily',
    description: 'FuelEU compliance balance by voyage',
  },
  captain_dnv: {
    key: 'captain_dnv',
    table: 'captain_dnv',
    vesselColumn: 'imo',
    timeColumn: 'reallocation_period_start',
    timeColumnType: 'date',
    granularity: 'daily',
    description: 'DNV FuelEU reallocation period figures',
  },
};

/**
 * VESSELS — how Captain finds and names vessels. Vessel ids ARE IMO numbers,
 * because that is the key shared by Veson and Geoform.
 */
const VESSELS = {
  table: 'vessels',
  idColumn: 'id',
  nameColumn: 'name',
  scopeColumn: 'department',
  altNameColumns: ['imo'],
};

/**
 * METRICS — see the field reference above each block. `column` names here are
 * Captain's own normalized columns (db/002_veson_geoform.sql); the mapping
 * from upstream API field names to these lives in src/integrations/mapping.js.
 */
const METRICS = [
  // --- Geoform reports -----------------------------------------------------
  { key: 'shaft_power', label: 'Shaft power', unit: 'kW', source: 'geoform_reports', column: 'shaft_power_kw', kind: 'rate', decimals: 1,
    aliases: ['shaft power', 'sp', 'shaft output', 'shaft kw', 'power', 'me power', 'main engine power', 'shaft pwr', 'brake power'],
    description: 'Main engine shaft power' },
  { key: 'fuel_consumption', label: 'Fuel consumption', unit: 'MT', source: 'geoform_reports', column: 'fuel_consumed_mt', kind: 'quantity', decimals: 3,
    aliases: ['fuel consumption', 'fuel consumed', 'fuel oil consumption', 'foc', 'bunker consumption', 'fuel burn', 'fuel used', 'daily consumption', 'noon consumption', 'report consumption'],
    description: 'Total fuel burned per report, all consumers' },
  { key: 'me_consumption', label: 'Main engine consumption', unit: 'MT', source: 'geoform_reports', column: 'me_fuel_mt', kind: 'quantity', decimals: 3,
    aliases: ['main engine consumption', 'me consumption', 'me foc', 'me fuel', 'main engine fuel', 'propulsion consumption'] },
  { key: 'ae_consumption', label: 'Auxiliary engine consumption', unit: 'MT', source: 'geoform_reports', column: 'ae_fuel_mt', kind: 'quantity', decimals: 3,
    aliases: ['auxiliary engine consumption', 'ae consumption', 'ae foc', 'ae fuel', 'auxiliary consumption', 'aux consumption', 'aux fuel'] },
  { key: 'distance', label: 'Distance sailed', unit: 'nm', source: 'geoform_reports', column: 'distance_nm', kind: 'quantity', decimals: 1,
    aliases: ['distance sailed', 'distance run', 'miles', 'nautical miles', 'dist', 'daily distance'] },
  { key: 'speed', label: 'Speed over ground', unit: 'kn', source: 'geoform_reports', column: 'speed_kn', kind: 'rate', decimals: 2,
    aliases: ['speed', 'sog', 'speed over ground', 'vessel speed', 'avg speed'] },
  { key: 'rpm', label: 'Main engine RPM', unit: 'rpm', source: 'geoform_reports', column: 'me_rpm', kind: 'rate', decimals: 1,
    aliases: ['rpm', 'revolutions', 'engine rpm', 'me rpm', 'shaft rpm'] },
  { key: 'co2', label: 'CO2 emitted', unit: 'MT', source: 'geoform_reports', column: 'co2_mt', kind: 'quantity', decimals: 3,
    aliases: ['carbon dioxide', 'co2 emissions', 'carbon emitted', 'daily co2', 'report co2'] },

  // --- Veson leg-wise ---------------------------------------------------------
  { key: 'leg_fuel', label: 'Leg fuel consumption', unit: 'MT', source: 'veson_legs', column: 'fuel_mt', kind: 'quantity', decimals: 3,
    aliases: ['leg fuel', 'leg consumption', 'voyage consumption', 'voyage fuel', 'fueleu consumption', 'fueleu fuel', 'imos consumption', 'veson consumption', 'leg wise consumption'],
    description: 'Fuel per voyage leg from the FuelEU leg-wise report' },
  { key: 'leg_co2', label: 'Leg CO2', unit: 'MT', source: 'veson_legs', column: 'co2_mt', kind: 'quantity', decimals: 3,
    aliases: ['leg co2', 'voyage co2', 'fueleu co2', 'voyage emissions', 'leg emissions'] },
  { key: 'leg_distance', label: 'Leg distance', unit: 'nm', source: 'veson_legs', column: 'distance_nm', kind: 'quantity', decimals: 1,
    aliases: ['leg distance', 'voyage distance', 'leg miles'] },
  { key: 'ghg_intensity', label: 'GHG intensity', unit: 'gCO2e/MJ', source: 'veson_legs', column: 'ghg_intensity', kind: 'rate', decimals: 2,
    aliases: ['ghg intensity', 'ghg', 'intensity', 'fueleu intensity', 'wtw intensity', 'carbon intensity', 'gco2e mj'] },
  { key: 'eu_scope', label: 'EU scope share', unit: '%', source: 'veson_legs', column: 'eu_scope_pct', kind: 'rate', decimals: 1,
    aliases: ['eu scope', 'eu share', 'scope', 'fueleu scope', 'eu coverage'] },
  { key: 'compliance_balance', label: 'FuelEU compliance balance', unit: 'gCO2e', source: 'veson_legs', column: 'compliance_balance', kind: 'quantity', decimals: 0,
    aliases: ['compliance balance', 'fueleu balance', 'balance', 'surplus', 'deficit', 'compliance surplus', 'compliance deficit'] },
  { key: 'legs', label: 'Voyage legs', unit: 'legs', source: 'veson_legs', column: 'leg_date', kind: 'quantity', decimals: 0, countOnly: true,
    aliases: ['legs', 'voyage legs', 'number of legs', 'how many legs', 'leg count'] },

  // --- Veson off-hire -----------------------------------------------------------
  { key: 'offhire_hours', label: 'Off-hire time', unit: 'hours', source: 'veson_offhire', column: 'offhire_hours', kind: 'quantity', decimals: 1,
    aliases: ['off hire', 'offhire', 'off hire hours', 'offhire hours', 'off hire time', 'downtime', 'off hire duration'] },
  { key: 'offhire_days', label: 'Off-hire days', unit: 'days', source: 'veson_offhire', column: 'offhire_days', kind: 'quantity', decimals: 2,
    aliases: ['off hire days', 'offhire days', 'days off hire'] },

  // --- fueleu_final (via captain_fueleu_final view) ---------------------------
  // UNIT NOT CONFIRMED: gCO2e is a guess, matching how `compliance_balance`
  // above is declared for veson_legs, and matching bigint values that size.
  // Confirm with Nav before this reaches a user.
  { key: 'gross_cb', label: 'Gross compliance balance', unit: 'gCO2e /* UNCONFIRMED */', source: 'captain_fueleu_final', column: 'gross_cb', kind: 'quantity', decimals: 0,
    aliases: ['gross cb', 'gross compliance balance', 'voyage compliance balance', 'fueleu gross cb'],
    description: 'Gross FuelEU compliance balance for the voyage' },
  { key: 'cb_at_start', label: 'Compliance balance at voyage start', unit: 'gCO2e /* UNCONFIRMED */', source: 'captain_fueleu_final', column: 'cb_at_start', kind: 'quantity', decimals: 0,
    aliases: ['cb at start', 'starting compliance balance', 'opening cb', 'compliance balance at start'] },
  { key: 'voyage_gross_days', label: 'Voyage gross days', unit: 'days', source: 'captain_fueleu_final', column: 'voyage_gross_days', kind: 'quantity', decimals: 2,
    aliases: ['voyage gross days', 'gross voyage days', 'voyage days'] },
  { key: 'fueleu_offhire_gross_days', label: 'Off-hire gross days (FuelEU)', unit: 'days', source: 'captain_fueleu_final', column: 'offhire_gross_days', kind: 'quantity', decimals: 2,
    aliases: ['fueleu offhire gross days', 'fueleu off hire gross days'] },
  { key: 'net_gross_days', label: 'Net gross days', unit: 'days', source: 'captain_fueleu_final', column: 'net_gross_days', kind: 'quantity', decimals: 2,
    aliases: ['net gross days', 'net voyage days'] },

  // --- dnv (via captain_dnv view) ----------------------------------------------
  // UNIT NOT CONFIRMED for all four below — best guesses only.
  { key: 'dnv_compliance_balance', label: 'DNV compliance balance', unit: 'gCO2e /* UNCONFIRMED */', source: 'captain_dnv', column: 'compliance_balance', kind: 'quantity', decimals: 0,
    aliases: ['dnv cb', 'dnv compliance balance', 'reallocation compliance balance', 'dnv balance'],
    description: 'FuelEU compliance balance for the reallocation period, per DNV' },
  { key: 'fueleu_penalty', label: 'FuelEU penalty', unit: 'EUR /* UNCONFIRMED */', source: 'captain_dnv', column: 'fueleu_penalty', kind: 'quantity', decimals: 2,
    aliases: ['fueleu penalty', 'dnv penalty', 'compliance penalty', 'fueleu fine'] },
  { key: 'fueleu_energy', label: 'FuelEU energy', unit: 'MJ /* UNCONFIRMED */', source: 'captain_dnv', column: 'fueleu_energy', kind: 'quantity', decimals: 0,
    aliases: ['fueleu energy', 'dnv energy', 'energy used fueleu'] },
  { key: 'actual_ghg', label: 'Actual GHG intensity', unit: 'gCO2e/MJ /* UNCONFIRMED */', source: 'captain_dnv', column: 'actual_ghg', kind: 'rate', decimals: 2,
    aliases: ['actual ghg', 'actual ghg intensity', 'dnv ghg', 'realised ghg intensity'] },
];

/**
 * METRIC_GROUPS — words that legitimately refer to more than one metric.
 * Captain asks instead of picking. An organisation can resolve a group for
 * itself by teaching Captain ("consumption means fuel consumption").
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

function assertIdent(value, what) {
  if (typeof value !== 'string' || !IDENT.test(value)) {
    throw new Error(`Captain config: invalid identifier for ${what}: ${JSON.stringify(value)}`);
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
      errors.push(`Captain config: source ${src.key} has unknown timeColumnType`);
    }
    if (!['daily', 'hourly', 'sub_hourly'].includes(src.granularity)) {
      errors.push(`Captain config: source ${src.key} has unknown granularity`);
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
    if (seenKeys.has(m.key)) errors.push(`Captain config: duplicate metric key ${m.key}`);
    seenKeys.add(m.key);
    if (!SOURCES[m.source]) errors.push(`Captain config: metric ${m.key} references unknown source ${m.source}`);
    if (!AGGREGATIONS_BY_KIND[m.kind]) errors.push(`Captain config: metric ${m.key} has unknown kind ${m.kind}`);
    try { assertIdent(m.column, `metric ${m.key}.column`); } catch (e) { errors.push(e.message); }
    if (!m.unit) errors.push(`Captain config: metric ${m.key} is missing a unit`);
  }

  for (const g of METRIC_GROUPS) {
    if (!g.metrics || g.metrics.length < 2) {
      errors.push(`Captain config: group "${g.term}" must point at two or more metrics`);
    }
    for (const k of g.metrics || []) {
      if (!METRICS.some((m) => m.key === k)) {
        errors.push(`Captain config: group "${g.term}" references unknown metric ${k}`);
      }
    }
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