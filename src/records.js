'use strict';

/**
 * Record lookups: the rows behind a question that is not one measurement over
 * a period — a vessel's particulars, its latest voyage and ports, CII by
 * year, FuelEU after pooling, allowances, filings, trades, invoices, emails.
 *
 * Same two rules as src/sql.js:
 *   1. every identifier comes from RECORDS in src/config.js;
 *   2. every value is a bound parameter, and the user's vessel scope is a
 *      mandatory predicate on every statement.
 */

const { RECORDS, assertIdent } = require('./config');

const MAX_ROWS = 50;
const DEFAULT_ROWS = 8;
const LONG_TEXT = 700;
const REPLY_BUDGET = 14000;   // characters of JSON handed to the model

function q(ident) {
  assertIdent(ident, 'records identifier');
  return ident.split('.').map((p) => `"${p}"`).join('.');
}

function orderClause(r) {
  const spec = r.orderBy || (r.timeColumn ? `${r.timeColumn} DESC` : null);
  if (!spec) return '';
  return spec.split(',').map((part) => {
    const [col, ...rest] = part.trim().split(/\s+/);
    return `t.${q(col)} ${rest.join(' ').toUpperCase()}`.trim();
  }).join(', ');
}

/**
 * @param {string} topic   a key of RECORDS
 * @param {object} args
 *   vesselIds  string[]  the ids this lookup may read (already authorised)
 *   voyage     string    voyage number or reference
 *   year       number    calendar or reporting year
 *   from, to   string    YYYY-MM-DD bounds on the time column
 *   filter     object    { column: value } on the topic's declared filters
 *   latest     boolean   only the newest row per vessel
 *   limit      number
 * @returns {{ text, values, limit }}
 */
function build(topic, args) {
  const r = RECORDS[topic];
  if (!r) throw new Error(`Unknown records topic ${topic}`);
  const ids = args.vesselIds;
  if (!Array.isArray(ids) || !ids.length) throw new Error('Refusing to build a records query with an empty vessel scope');
  const vcol = r.vesselColumn || 'vessel_id';
  const params = [ids];
  const where = [`t.${q(vcol)} = ANY($1)`];

  if (args.voyage && r.voyageColumns && r.voyageColumns.length) {
    params.push(String(args.voyage).trim());
    where.push('(' + r.voyageColumns.map((c) => `t.${q(c)}::text = $${params.length}`).join(' OR ') + ')');
  }
  const year = parseInt(args.year, 10);
  if (Number.isFinite(year) && year > 1990 && year < 2100) {
    if (r.yearColumn) {
      params.push(year);
      where.push(`t.${q(r.yearColumn)} = $${params.length}`);
    } else if (r.timeColumn) {
      params.push(`${year}-01-01`, `${year + 1}-01-01`);
      where.push(`t.${q(r.timeColumn)} >= $${params.length - 1}::date AND t.${q(r.timeColumn)} < $${params.length}::date`);
    }
  }
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (r.timeColumn && day.test(String(args.from || ''))) { params.push(args.from); where.push(`t.${q(r.timeColumn)} >= $${params.length}::date`); }
  if (r.timeColumn && day.test(String(args.to || '')))   { params.push(args.to);   where.push(`t.${q(r.timeColumn)} < ($${params.length}::date + 1)`); }
  for (const [col, value] of Object.entries(args.filter || {})) {
    if (!(r.filters || []).includes(col) || value == null || value === '') continue;   // undeclared: ignored, never interpolated
    params.push(String(value));
    where.push(`t.${q(col)}::text ILIKE $${params.length}`);
  }

  const cols = r.columns ? r.columns.map((c) => `t.${q(c)}`).join(', ') : 't.*';
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || DEFAULT_ROWS, 1), MAX_ROWS);
  params.push(limit);
  const order = orderClause(r);
  let text;
  if (args.latest && (r.timeColumn || r.yearColumn)) {
    // The newest row per vessel: DISTINCT ON needs the vessel first in the ORDER BY.
    const newest = r.timeColumn ? `t.${q(r.timeColumn)} DESC` : `t.${q(r.yearColumn)} DESC`;
    text = `SELECT * FROM (SELECT DISTINCT ON (t.${q(vcol)}) ${cols} FROM ${q(r.table)} t WHERE ${where.join(' AND ')} ORDER BY t.${q(vcol)}, ${newest}) t`
      + (order ? ` ORDER BY ${order}` : '') + ` LIMIT $${params.length}`;
  } else {
    text = `SELECT ${cols} FROM ${q(r.table)} t WHERE ${where.join(' AND ')}` + (order ? ` ORDER BY ${order}` : '') + ` LIMIT $${params.length}`;
  }
  return { text, values: params, limit };
}

// --- presenting rows to the model ----------------------------------------------

// Postgres NUMERIC (1700) and BIGINT (20) arrive as strings; only those become
// numbers. A text column that looks numeric (an IMO number) stays text.
const NUMERIC_TYPES = new Set([20, 1700]);

function value(v, long, numeric) {
  if (v === null || v === undefined) return undefined;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return undefined;
    // A DATE column arrives as midnight (UTC or local, depending on the driver):
    // show the calendar day, not a shifted instant.
    const utcMidnight = v.getUTCHours() === 0 && v.getUTCMinutes() === 0 && v.getUTCSeconds() === 0 && v.getUTCMilliseconds() === 0;
    const localMidnight = v.getHours() === 0 && v.getMinutes() === 0 && v.getSeconds() === 0 && v.getMilliseconds() === 0;
    if (utcMidnight) return v.toISOString().slice(0, 10);
    if (localMidnight) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
    return v.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }
  if (typeof v === 'string') {
    if (numeric && Number.isFinite(Number(v))) return Number(v);
    return long && v.length > LONG_TEXT ? v.slice(0, LONG_TEXT) + ' …' : v;
  }
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 400);
  return v;
}

function shape(r, rows, fields) {
  const long = new Set(r.longText || []);
  const numeric = new Set((fields || []).filter((f) => NUMERIC_TYPES.has(f.dataTypeID)).map((f) => f.name));
  return rows.map((row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      const x = value(v, long.has(k), numeric.has(k));
      if (x !== undefined) out[k] = x;
    }
    return out;
  });
}

/**
 * Run a lookup. `vessel` (a name, IMO or code) narrows the scope; it can only
 * ever select among the vessels in `scope`.
 *
 * @param {object} db     pg client or pool
 * @param {object} scope  { vessels: [{ id, name, altNames }] } from rbac.resolveScope
 * @param {object} args   { topic, vessel?, voyage?, year?, from?, to?, filter?, latest?, limit? }
 */
async function lookup(db, scope, args) {
  const topic = String((args && args.topic) || '');
  const r = RECORDS[topic];
  if (!r) return { error: `unknown topic "${topic}"`, topics: Object.keys(RECORDS) };
  let vessels = (scope && scope.vessels) || [];
  if (!vessels.length) return { error: 'no vessels in this user\'s scope', rows: [] };
  if (args.vessel) {
    const hit = matchVessels(args.vessel, vessels);
    if (!hit.length) {
      return { error: `no vessel matching "${String(args.vessel).slice(0, 60)}" in this user's fleet`, vessels: vessels.map((v) => v.name) };
    }
    vessels = hit;
  }
  const { text, values, limit } = build(topic, Object.assign({}, args, { vesselIds: vessels.map((v) => v.id) }));
  const res = await db.query(text, values);
  let rows = shape(r, res.rows || [], res.fields);
  let truncated = rows.length >= limit;
  // Keep the reply inside what the model is handed; say so if rows were dropped.
  while (rows.length > 1 && JSON.stringify(rows).length > REPLY_BUDGET) { rows = rows.slice(0, rows.length - 1); truncated = true; }
  return {
    topic, label: r.label, vessels: vessels.map((v) => v.name),
    row_count: rows.length, truncated, rows,
    note: rows.length ? undefined : 'No matching records.',
  };
}

function norm(s) {
  // "TEST VESSEL 1", "test vessel 01" and "Test-Vessel-01" are the same name.
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b0+(\d)/g, '$1').trim();
}

function matchVessels(text, vessels) {
  const want = norm(text);
  if (!want) return [];
  const exact = vessels.filter((v) => [v.name, ...(v.altNames || [])].some((n) => n && norm(n) === want));
  if (exact.length) return exact;
  return vessels.filter((v) => [v.name, ...(v.altNames || [])].some((n) => {
    const m = norm(n);
    return m.length >= 3 && (` ${want} `.includes(` ${m} `) || ` ${m} `.includes(` ${want} `));
  }));
}

/** One line per topic, for the tool definition. */
function topicGuide() {
  return Object.entries(RECORDS).map(([k, r]) => `${k}: ${r.about}`).join('\n');
}

module.exports = { lookup, build, matchVessels, topicGuide, TOPICS: Object.keys(RECORDS) };
