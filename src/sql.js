'use strict';

const { SOURCES, METRICS_BY_KEY, VESSELS, LIMITS, assertIdent } = require('./config');

/**
 * Plan -> parameterized SQL.
 *
 * Two rules hold everywhere in this file:
 *   1. Table and column names are read from the registry only. No string from
 *      the user ever becomes an identifier.
 *   2. Every value is a bound parameter. No interpolation of user data.
 *
 * The vessel scope is passed in by the caller after authorisation and is
 * applied as a mandatory predicate on every statement. There is no code path
 * that builds a query without it.
 */

function q(ident) {
  assertIdent(ident, 'sql identifier');
  return ident.split('.').map((p) => `"${p}"`).join('.');
}

/** Time predicate appropriate to the column's declared type. */
function timePredicate(source, range, params) {
  const col = `t.${q(source.timeColumn)}`;
  if (source.timeColumnType === 'date') {
    params.push(range.startDate, range.endDate);
    return `${col} >= $${params.length - 1}::date AND ${col} <= $${params.length}::date`;
  }
  params.push(range.startISO, range.endExclusiveISO);
  return `${col} >= $${params.length - 1}::timestamptz AND ${col} < $${params.length}::timestamptz`;
}

function scopePredicate(source, vesselIds, params) {
  params.push(vesselIds);
  return `t.${q(source.vesselColumn)} = ANY($${params.length})`;
}

function baseFrom(metric, range, vesselIds, params) {
  const source = SOURCES[metric.source];
  const where = [
    scopePredicate(source, vesselIds, params),
    timePredicate(source, range, params),
    `t.${q(metric.column)} IS NOT NULL`,
  ];
  return { source, from: `FROM ${q(source.table)} t`, where: `WHERE ${where.join(' AND ')}` };
}

const GROUP_TRUNC = { hour: 'hour', day: 'day', week: 'week', month: 'month', year: 'year' };

/**
 * Build the statement for a plan.
 * @returns {{ text, values, shape }} shape describes how to read the result.
 */
function build(plan, vesselIds) {
  const metric = METRICS_BY_KEY[plan.metricKey];
  if (!metric) throw new Error(`Unknown metric ${plan.metricKey}`);
  if (!Array.isArray(vesselIds) || !vesselIds.length) throw new Error('Refusing to build a query with an empty vessel scope');

  switch (plan.intent) {
    case 'value':   return buildRaw(plan, metric, vesselIds);
    case 'trend':   return buildTrend(plan, metric, vesselIds);
    case 'summary': return buildSummary(plan, metric, vesselIds);
    case 'compare': return buildCompare(plan, metric, vesselIds);
    case 'delta':   return buildDelta(plan, metric, vesselIds);
    default:        return buildScalar(plan, metric, vesselIds);
  }
}

function buildRaw(plan, metric, vesselIds) {
  const params = [];
  const { source, from, where } = baseFrom(metric, plan.range, vesselIds, params);
  params.push(Math.min(plan.limit || LIMITS.maxRawRows, LIMITS.maxRawRows));
  const text = `
SELECT t.${q(source.vesselColumn)} AS vessel_id,
       t.${q(source.timeColumn)}   AS at,
       t.${q(metric.column)}       AS value
${from}
${where}
ORDER BY t.${q(source.timeColumn)} ASC, t.${q(source.vesselColumn)} ASC
LIMIT $${params.length}`.trim();
  return { text, values: params, shape: 'rows' };
}

function buildScalar(plan, metric, vesselIds) {
  const params = [];
  const { from, where } = baseFrom(metric, plan.range, vesselIds, params);
  const col = `t.${q(metric.column)}`;
  const fn = { sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX', count: 'COUNT' }[plan.aggregation];
  if (!fn) throw new Error(`Unsupported aggregation ${plan.aggregation}`);

  const text = `
SELECT ${fn}(${col})::double precision AS value,
       COUNT(${col})                   AS n_rows,
       MIN(t.${q(SOURCES[metric.source].timeColumn)}) AS first_at,
       MAX(t.${q(SOURCES[metric.source].timeColumn)}) AS last_at
${from}
${where}`.trim();
  return { text, values: params, shape: 'scalar' };
}

/** Counter metrics: the value over a period is last reading minus first. */
function buildDelta(plan, metric, vesselIds) {
  const params = [];
  const source = SOURCES[metric.source];
  const { from, where } = baseFrom(metric, plan.range, vesselIds, params);
  const text = `
WITH ordered AS (
  SELECT t.${q(source.vesselColumn)} AS vessel_id,
         t.${q(source.timeColumn)}   AS at,
         t.${q(metric.column)}       AS value,
         ROW_NUMBER() OVER (PARTITION BY t.${q(source.vesselColumn)} ORDER BY t.${q(source.timeColumn)} ASC)  AS rn_first,
         ROW_NUMBER() OVER (PARTITION BY t.${q(source.vesselColumn)} ORDER BY t.${q(source.timeColumn)} DESC) AS rn_last
  ${from}
  ${where}
)
SELECT SUM(CASE WHEN rn_last = 1 THEN value END) - SUM(CASE WHEN rn_first = 1 THEN value END) AS value,
       COUNT(*) AS n_rows,
       MIN(at)  AS first_at,
       MAX(at)  AS last_at
FROM ordered`.trim();
  return { text, values: params, shape: 'scalar' };
}

function buildTrend(plan, metric, vesselIds) {
  const params = [];
  const source = SOURCES[metric.source];
  const { from, where } = baseFrom(metric, plan.range, vesselIds, params);
  const trunc = GROUP_TRUNC[plan.group || 'day'];
  if (!trunc) throw new Error(`Unsupported grouping ${plan.group}`);
  const fn = metric.kind === 'quantity' ? 'SUM' : 'AVG';
  params.push(LIMITS.maxSeriesPoints);

  const text = `
SELECT date_trunc('${trunc}', t.${q(source.timeColumn)}::timestamp) AS bucket,
       ${fn}(t.${q(metric.column)})::double precision               AS value,
       COUNT(t.${q(metric.column)})                                 AS n_rows
${from}
${where}
GROUP BY 1
ORDER BY 1 ASC
LIMIT $${params.length}`.trim();
  return { text, values: params, shape: 'series', seriesAgg: fn.toLowerCase() };
}

function buildSummary(plan, metric, vesselIds) {
  const params = [];
  const source = SOURCES[metric.source];
  const { from, where } = baseFrom(metric, plan.range, vesselIds, params);
  const col = `t.${q(metric.column)}`;
  const text = `
SELECT COUNT(${col})                                   AS n_rows,
       COUNT(DISTINCT t.${q(source.vesselColumn)})     AS n_vessels,
       SUM(${col})::double precision                   AS total,
       AVG(${col})::double precision                   AS average,
       MIN(${col})::double precision                   AS minimum,
       MAX(${col})::double precision                   AS maximum,
       STDDEV_SAMP(${col})::double precision           AS stddev,
       MIN(t.${q(source.timeColumn)})                  AS first_at,
       MAX(t.${q(source.timeColumn)})                  AS last_at
${from}
${where}`.trim();
  return { text, values: params, shape: 'summary' };
}

function buildCompare(plan, metric, vesselIds) {
  const [a, b] = plan.ranges;
  const params = [];
  const source = SOURCES[metric.source];
  const col = `t.${q(metric.column)}`;
  const fn = plan.aggregation === 'sum' ? 'SUM' : 'AVG';

  const scope = scopePredicate(source, vesselIds, params);
  const pa = timePredicate(source, a, params);
  const pb = timePredicate(source, b, params);

  const text = `
SELECT
  ${fn}(${col}) FILTER (WHERE ${pa})::double precision AS a_value,
  COUNT(${col}) FILTER (WHERE ${pa})                   AS a_rows,
  ${fn}(${col}) FILTER (WHERE ${pb})::double precision AS b_value,
  COUNT(${col}) FILTER (WHERE ${pb})                   AS b_rows
FROM ${q(source.table)} t
WHERE ${scope} AND ((${pa}) OR (${pb})) AND ${col} IS NOT NULL`.trim();
  return { text, values: params, shape: 'compare' };
}

/**
 * Overview: every registered metric over one period, one statement per source
 * table. Used when a user asks Captain to look at a vessel without naming a
 * measurement.
 */
function buildOverview(plan, vesselIds) {
  if (!Array.isArray(vesselIds) || !vesselIds.length) throw new Error('Refusing to build a query with an empty vessel scope');

  const bySource = new Map();
  for (const key of plan.metricKeys) {
    const m = METRICS_BY_KEY[key];
    if (!m) continue;
    if (!bySource.has(m.source)) bySource.set(m.source, []);
    bySource.get(m.source).push(m);
  }

  const statements = [];
  for (const [sourceKey, metrics] of bySource) {
    const source = SOURCES[sourceKey];
    const params = [];
    const where = [
      scopePredicate(source, vesselIds, params),
      timePredicate(source, plan.range, params),
    ];
    const cols = metrics.flatMap((m) => m.countOnly
      ? [
        `COUNT(t.${q(m.column)})                    AS ${q(`${m.key}__n`)}`,
        `COUNT(t.${q(m.column)})::double precision  AS ${q(`${m.key}__total`)}`,
        `NULL::double precision                     AS ${q(`${m.key}__avg`)}`,
        `NULL::double precision                     AS ${q(`${m.key}__min`)}`,
        `NULL::double precision                     AS ${q(`${m.key}__max`)}`,
      ]
      : [
        `COUNT(t.${q(m.column)})                 AS ${q(`${m.key}__n`)}`,
        `SUM(t.${q(m.column)})::double precision AS ${q(`${m.key}__total`)}`,
        `AVG(t.${q(m.column)})::double precision AS ${q(`${m.key}__avg`)}`,
        `MIN(t.${q(m.column)})::double precision AS ${q(`${m.key}__min`)}`,
        `MAX(t.${q(m.column)})::double precision AS ${q(`${m.key}__max`)}`,
      ]);
    const text = `
SELECT COUNT(*) AS n_reports,
       MIN(t.${q(source.timeColumn)}) AS first_at,
       MAX(t.${q(source.timeColumn)}) AS last_at,
       ${cols.join(',\n       ')}
FROM ${q(source.table)} t
WHERE ${where.join(' AND ')}`.trim();

    statements.push({ sourceKey, metrics: metrics.map((m) => m.key), text, values: params });
  }
  return statements;
}

/** Vessels the current scope may see. Used to resolve names in questions. */
function buildVesselList(scope) {
  const params = [];
  const cols = [
    `v.${q(VESSELS.idColumn)} AS id`,
    `v.${q(VESSELS.nameColumn)} AS name`,
    ...(VESSELS.altNameColumns || []).map((c, i) => `v.${q(c)} AS alt_${i}`),
  ];
  const where = [];
  if (scope.vesselIds && scope.vesselIds.length) {
    params.push(scope.vesselIds);
    where.push(`v.${q(VESSELS.idColumn)} = ANY($${params.length})`);
  }
  if (scope.departments && scope.departments.length && VESSELS.scopeColumn) {
    params.push(scope.departments);
    where.push(`v.${q(VESSELS.scopeColumn)} = ANY($${params.length})`);
  }
  if (!where.length) throw new Error('Refusing to list vessels without a scope');

  const text = `
SELECT ${cols.join(', ')}
FROM ${q(VESSELS.table)} v
WHERE ${where.join(' AND ')}
ORDER BY v.${q(VESSELS.nameColumn)} ASC
LIMIT 2000`.trim();
  return { text, values: params };
}

module.exports = { build, buildOverview, buildVesselList, q };
