'use strict';

/**
 * Field mapping from upstream API records to Captain's own tables.
 *
 * Upstream report APIs return rows whose key names Captain does not control
 * and which can change between report versions. Rather than hard-code one
 * spelling, each target column lists the candidate source keys it accepts.
 * Matching is insensitive to case, spaces, underscores, hyphens and dots, so
 * "Vessel Name", "vessel_name", "vesselName" and "VESSEL-NAME" all resolve.
 *
 * Anything the mapper cannot place is reported, never silently dropped:
 *   - unmapped SOURCE fields  -> so you can add a candidate
 *   - unmatched TARGET columns -> so you know a metric will be NULL
 *
 * Run `npm run discover` against the live APIs to see both lists. An override
 * can also be supplied via CAPTAIN_FIELD_MAP as JSON:
 *   {"veson_legs":{"fuel_mt":"TotalFuelConsumedMT"}}
 */

const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Target schemas. `columns` are Captain's own column names — these are the
 * ones referenced in src/config.js. `candidates` are guesses at upstream
 * spellings; `discover` confirms them.
 */
const SCHEMAS = {
  veson_legs: {
    key: ['imo', 'dep_time', 'arr_time', 'leg_no'],
    columns: {
      imo:            { type: 'text',   candidates: ['imo', 'imoNumber', 'imo_no', 'vesselImo', 'IMO Number', 'lloydsNumber'] },
      vessel_name:    { type: 'text',   candidates: ['vesselName', 'vessel', 'shipName', 'vslName', 'Vessel Name', 'name'] },
      voyage_no:      { type: 'text',   candidates: ['voyageNo', 'voyageNumber', 'voyage', 'voyNo', 'Voyage No'] },
      leg_no:         { type: 'text',   candidates: ['legNo', 'legNumber', 'leg', 'legId', 'Leg No', 'sequence'] },
      dep_port:       { type: 'text',   candidates: ['departurePort', 'fromPort', 'depPort', 'portFrom', 'Departure Port', 'loadPort'] },
      arr_port:       { type: 'text',   candidates: ['arrivalPort', 'toPort', 'arrPort', 'portTo', 'Arrival Port', 'dischargePort'] },
      dep_time:       { type: 'time',   candidates: ['departureTime', 'departure', 'depTime', 'atd', 'departureDate', 'sailedGmt', 'Departure', 'startDate', 'legStart'] },
      arr_time:       { type: 'time',   candidates: ['arrivalTime', 'arrival', 'arrTime', 'ata', 'arrivalDate', 'arrivedGmt', 'Arrival', 'endDate', 'legEnd'] },
      distance_nm:    { type: 'number', candidates: ['distance', 'distanceNm', 'distanceNM', 'legDistance', 'Distance', 'milesSailed', 'nauticalMiles'] },
      fuel_mt:        { type: 'number', candidates: ['totalFuel', 'fuelConsumed', 'fuelConsumption', 'totalConsumption', 'consumptionMt', 'fuelMt', 'Total Fuel', 'bunkersConsumed', 'totalFuelConsumed'] },
      co2_mt:         { type: 'number', candidates: ['co2', 'co2Emissions', 'co2Mt', 'totalCo2', 'CO2', 'co2Emitted', 'ghgEmissions', 'emissions'] },
      ghg_intensity:  { type: 'number', candidates: ['ghgIntensity', 'ghgIntensityGCo2eMj', 'intensity', 'GHG Intensity', 'wtwIntensity', 'fuelEuIntensity'] },
      eu_scope_pct:   { type: 'number', candidates: ['euScope', 'euScopePercent', 'scopePct', 'euShare', 'EU Scope', 'coveragePct', 'fuelEuScope'] },
      compliance_balance: { type: 'number', candidates: ['complianceBalance', 'balance', 'fuelEuBalance', 'Compliance Balance', 'surplusDeficit'] },
    },
  },

  veson_offhire: {
    key: ['imo', 'start_time'],
    columns: {
      imo:            { type: 'text',   candidates: ['imo', 'imoNumber', 'imo_no', 'vesselImo', 'IMO Number'] },
      vessel_name:    { type: 'text',   candidates: ['vesselName', 'vessel', 'shipName', 'Vessel Name', 'name'] },
      voyage_no:      { type: 'text',   candidates: ['voyageNo', 'voyageNumber', 'voyage', 'Voyage No'] },
      start_time:     { type: 'time',   candidates: ['startTime', 'start', 'fromDate', 'offHireStart', 'offhireFrom', 'Start', 'from', 'startDate'] },
      end_time:       { type: 'time',   candidates: ['endTime', 'end', 'toDate', 'offHireEnd', 'offhireTo', 'End', 'to', 'endDate'] },
      offhire_hours:  { type: 'number', candidates: ['hours', 'offHireHours', 'duration', 'durationHours', 'Hours', 'totalHours', 'offhireHrs'] },
      offhire_days:   { type: 'number', candidates: ['days', 'offHireDays', 'durationDays', 'Days'] },
      reason:         { type: 'text',   candidates: ['reason', 'offHireReason', 'cause', 'remarks', 'Reason', 'type', 'category'] },
    },
  },

  geoform_reports: {
    key: ['imo', 'report_time', 'form_type'],
    columns: {
      imo:              { type: 'text',   candidates: ['imo', 'imoNumber', 'imo_no', 'vesselImo', 'IMO'] },
      vessel_name:      { type: 'text',   candidates: ['vesselName', 'vessel', 'shipName', 'Vessel Name', 'name'] },
      form_type:        { type: 'text',   candidates: ['formType', 'formName', 'type', 'reportType', 'form', 'template', 'Form Type'] },
      report_time:      { type: 'time',   candidates: ['reportTime', 'reportDate', 'dateTime', 'timestamp', 'submittedAt', 'createdAt', 'date', 'reportDateTime', 'utcTime', 'Report Date'] },
      shaft_power_kw:   { type: 'number', candidates: ['shaftPower', 'shaftPowerKw', 'sp', 'shaftPowerKW', 'Shaft Power', 'mePower', 'mePowerKw'] },
      fuel_consumed_mt: { type: 'number', candidates: ['totalConsumption', 'fuelConsumed', 'fuelConsumption', 'totalFoc', 'consumption', 'Total Consumption', 'totalFuel'] },
      me_fuel_mt:       { type: 'number', candidates: ['meConsumption', 'meFoc', 'mainEngineConsumption', 'meFuel', 'ME Consumption'] },
      ae_fuel_mt:       { type: 'number', candidates: ['aeConsumption', 'aeFoc', 'auxEngineConsumption', 'aeFuel', 'AE Consumption', 'auxConsumption'] },
      distance_nm:      { type: 'number', candidates: ['distance', 'distanceNm', 'distanceRun', 'Distance', 'milesRun', 'dailyDistance'] },
      speed_kn:         { type: 'number', candidates: ['speed', 'avgSpeed', 'speedOverGround', 'sog', 'Speed', 'averageSpeed'] },
      me_rpm:           { type: 'number', candidates: ['rpm', 'meRpm', 'engineRpm', 'RPM', 'avgRpm'] },
      co2_mt:           { type: 'number', candidates: ['co2', 'co2Mt', 'co2Emissions', 'CO2'] },
    },
  },
};

/**
 * Build a concrete key->column resolution for one record shape.
 * `override` is an optional { column: sourceKey } map from CAPTAIN_FIELD_MAP.
 */
function resolveMapping(schemaName, sampleRecord, override = {}) {
  const schema = SCHEMAS[schemaName];
  if (!schema) throw new Error(`Unknown schema ${schemaName}`);

  const sourceKeys = Object.keys(sampleRecord || {});
  const byNorm = new Map(sourceKeys.map((k) => [norm(k), k]));
  const used = new Set();
  const map = {};
  const unmatchedTargets = [];

  for (const [col, spec] of Object.entries(schema.columns)) {
    let hit = null;
    if (override[col] && sourceKeys.includes(override[col])) hit = override[col];
    if (!hit) {
      for (const c of spec.candidates) {
        const k = byNorm.get(norm(c));
        if (k && !used.has(k)) { hit = k; break; }
      }
    }
    if (hit) { map[col] = hit; used.add(hit); }
    else unmatchedTargets.push(col);
  }

  const unmappedSource = sourceKeys.filter((k) => !used.has(k));
  return { schema: schemaName, map, unmatchedTargets, unmappedSource };
}

// --- value coercion ---------------------------------------------------------

function toNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function toText(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/**
 * Accepts ISO strings, "YYYY-MM-DD HH:mm", "DD/MM/YYYY", epoch millis/seconds,
 * and .NET "/Date(1700000000000)/". Returns a Date or null; never guesses.
 */
function toTime(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') return new Date(v < 1e11 ? v * 1000 : v);
  const s = String(v).trim();
  let m = s.match(/^\/Date\((\d+)\)\/$/);
  if (m) return new Date(+m[1]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const iso = s.replace(' ', 'T');
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + 'Z');
  return Number.isNaN(d.getTime()) ? null : d;
}

const COERCE = { number: toNumber, text: toText, time: toTime };

/** Map one upstream record to a normalized row. Keeps the original in `raw`. */
function mapRecord(schemaName, record, resolution) {
  const schema = SCHEMAS[schemaName];
  const row = {};
  for (const [col, spec] of Object.entries(schema.columns)) {
    const src = resolution.map[col];
    row[col] = src != null ? COERCE[spec.type](record[src]) : null;
  }
  row.raw = record;
  return row;
}

/**
 * Some reports split fuel by type (HFO, LFO, MGO, LNG...) with no total. When
 * the total is missing, sum every numeric field whose name looks like a fuel
 * quantity. Reported in provenance as a derived figure.
 */
const FUEL_TYPE_RE = /^(hfo|hsfo|vlsfo|ulsfo|lfo|lsfo|mgo|mdo|lng|lpg|methanol|ammonia|biofuel|bio|ifo)[a-z0-9]*(mt|tons?|tonnes?|consum\w*|qty|quantity)?$/i;

function deriveFuelTotal(record) {
  let sum = 0, found = 0;
  for (const [k, v] of Object.entries(record)) {
    if (FUEL_TYPE_RE.test(norm(k))) {
      const n = toNumber(v);
      if (n != null) { sum += n; found++; }
    }
  }
  return found ? { value: sum, fromFields: found } : null;
}

function loadOverrides(env = process.env) {
  if (!env.CAPTAIN_FIELD_MAP) return {};
  try { return JSON.parse(env.CAPTAIN_FIELD_MAP); }
  catch (e) { throw new Error('CAPTAIN_FIELD_MAP is not valid JSON: ' + e.message); }
}

module.exports = { SCHEMAS, resolveMapping, mapRecord, deriveFuelTotal, loadOverrides, toNumber, toText, toTime, norm };
