'use strict';

const { METRICS_BY_KEY, SOURCES, LIMITS } = require('./config');
const parser = require('./parser');
const sqlBuilder = require('./sql');
const rbac = require('./rbac');
const terms = require('./terms');
const { humanDate } = require('./dates');

/**
 * The answer pipeline.
 *
 *   question -> scope -> parse -> authorise -> SQL -> Postgres -> format
 *
 * There is exactly one place a number can enter an answer: a value read out
 * of a result set from the query built for this question. Nothing in this
 * file computes a figure from anything else, and there is no fallback path
 * that produces a number when the query returns no rows.
 */

const NO_DATA = 'I could not find this information in the available vessel data.';

function fmt(value, metric) {
  if (value == null || Number.isNaN(value)) return null;
  const d = metric.decimals != null ? metric.decimals : 2;
  const n = Number(value);
  return n.toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function withUnit(value, metric) {
  const f = fmt(value, metric);
  return f == null ? null : `${f} ${metric.unit}`;
}

function atLabel(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return humanDate(d);
}

const AGG_WORD = {
  sum: 'Total', avg: 'Average', min: 'Lowest', max: 'Highest',
  count: 'Report count', delta: 'Change', value: 'Value',
};

/**
 * Run a parsed plan and build the answer.
 */
async function execute(plan, scope, db, ctx = {}) {
  const auth = rbac.authorizeVesselIds(plan.vesselIds, scope);
  if (!auth.ok) {
    return { status: 'denied', text: 'You do not have access to the vessel data needed to answer that.' };
  }

  const vesselNamesFor = (ids) => ids
    .map((id) => (scope.vessels.find((v) => String(v.id) === String(id)) || {}).name)
    .filter(Boolean);

  if (plan.intent === 'overview') {
    return executeOverview(plan, auth, db, vesselNamesFor(auth.vesselIds));
  }

  const metric = METRICS_BY_KEY[plan.metricKey];
  const source = SOURCES[metric.source];
  const statement = sqlBuilder.build(plan, auth.vesselIds);

  const started = Date.now();
  const result = await db.query(statement.text, statement.values);
  const elapsedMs = Date.now() - started;

  const vesselNames = auth.vesselIds
    .map((id) => (scope.vessels.find((v) => String(v.id) === String(id)) || {}).name)
    .filter(Boolean);

  const nameById = new Map(scope.vessels.map((v) => [String(v.id), v.name]));
  const provenance = {
    vesselNameFor: (id) => nameById.get(String(id)) || String(id),
    metric: metric.label,
    unit: metric.unit,
    source: source.description,
    table: source.table,
    column: metric.column,
    granularity: source.granularity,
    vessels: vesselNames,
    period: plan.range ? plan.range.label : plan.ranges.map((r) => r.label).join(' vs '),
    aggregation: plan.aggregation,
    aggregationWasAssumed: !!plan.aggregationWasAssumed,
    sql: statement.text,
    sqlValues: statement.values,
    elapsedMs,
  };

  const answer = formatAnswer(statement.shape, result.rows, plan, metric, provenance);
  delete provenance.vesselNameFor;
  return Object.assign({ status: 'answer', provenance }, answer);
}

/**
 * "Analyse my vessel over the last 6 months" — every registered metric over
 * one period. Metrics with no rows are reported as having no rows rather than
 * omitted, so a gap is visible instead of invisible.
 */
async function executeOverview(plan, auth, db, vesselNames) {
  const statements = sqlBuilder.buildOverview(plan, auth.vesselIds);
  const started = Date.now();
  const blocks = [];
  let reportsSeen = 0;

  for (const st of statements) {
    const { rows } = await db.query(st.text, st.values);
    const r = rows[0] || {};
    reportsSeen = Math.max(reportsSeen, Number(r.n_reports || 0));
    for (const key of st.metrics) {
      const metric = METRICS_BY_KEY[key];
      const n = Number(r[`${key}__n`] || 0);
      blocks.push({
        metric: metric.label,
        unit: metric.unit,
        reports: n,
        headline: n === 0 ? null : (metric.kind === 'quantity' ? Number(r[`${key}__total`]) : Number(r[`${key}__avg`])),
        headlineKind: metric.kind === 'quantity' ? 'total' : 'average',
        average: r[`${key}__avg`] == null ? null : Number(r[`${key}__avg`]),
        minimum: r[`${key}__min`] == null ? null : Number(r[`${key}__min`]),
        maximum: r[`${key}__max`] == null ? null : Number(r[`${key}__max`]),
        formatted: n === 0 ? 'no data' : withUnit(metric.kind === 'quantity' ? r[`${key}__total`] : r[`${key}__avg`], metric),
      });
    }
  }

  const withData = blocks.filter((b) => b.reports > 0);
  const provenance = {
    metric: 'Overview',
    source: statements.map((s) => SOURCES[s.sourceKey].description).join(', '),
    vessels: vesselNames,
    period: plan.range.label,
    aggregation: 'overview',
    granularity: SOURCES[statements[0].sourceKey].granularity,
    sql: statements.map((s) => s.text).join(';\n\n'),
    sqlValues: statements.map((s) => s.values),
    elapsedMs: Date.now() - started,
  };

  if (!withData.length) {
    return {
      status: 'answer',
      provenance,
      empty: true,
      rowsUsed: 0,
      text: `${NO_DATA} There are no records at all for ${vesselNames.join(', ')} in ${plan.range.label}.`,
    };
  }

  return {
    status: 'answer',
    provenance,
    rowsUsed: reportsSeen,
    overview: blocks,
    text: `${vesselNames.join(', ')}, ${plan.range.label}: ${reportsSeen} reports covering ${withData.length} of ${blocks.length} recorded measurements.`,
    note: coverageNote(plan, reportsSeen),
  };
}

function formatAnswer(shape, rows, plan, metric, provenance) {
  const vesselPhrase = provenance.vessels.length === 1
    ? provenance.vessels[0]
    : `${provenance.vessels.length} vessels`;

  if (shape === 'scalar') {
    const r = rows[0] || {};
    const n = Number(r.n_rows || 0);
    if (!n || r.value == null) return noData(plan, metric, provenance);
    const word = AGG_WORD[plan.aggregation] || 'Value';
    const value = plan.aggregation === 'count' ? String(n) : withUnit(r.value, metric);
    return {
      text: `${word} ${metric.label.toLowerCase()} for ${vesselPhrase}, ${provenance.period}: ${value}.`,
      value: plan.aggregation === 'count' ? n : Number(r.value),
      unit: plan.aggregation === 'count' ? 'reports' : metric.unit,
      rowsUsed: n,
      coverage: { firstAt: atLabel(r.first_at), lastAt: atLabel(r.last_at) },
      note: assumptionNote(plan, metric, n),
    };
  }

  if (shape === 'rows') {
    if (!rows.length) return noData(plan, metric, provenance);
    const values = rows.map((r) => ({ at: atLabel(r.at), value: Number(r.value), vesselId: r.vessel_id }));
    const head = values.length === 1
      ? `${metric.label} for ${vesselPhrase} on ${values[0].at}: ${withUnit(values[0].value, metric)}.`
      : `${values.length} ${metric.label.toLowerCase()} readings for ${vesselPhrase}, ${provenance.period}.`;
    return {
      text: head,
      value: values.length === 1 ? values[0].value : null,
      unit: metric.unit,
      rows: values,
      rowsUsed: values.length,
      truncated: values.length >= LIMITS.maxRawRows,
    };
  }

  if (shape === 'series') {
    if (!rows.length) return noData(plan, metric, provenance);
    const series = rows.map((r) => ({
      bucket: atLabel(r.bucket),
      bucketISO: r.bucket instanceof Date ? r.bucket.toISOString() : String(r.bucket),
      value: Number(r.value),
      rowsUsed: Number(r.n_rows),
    }));
    const first = series[0].value;
    const last = series[series.length - 1].value;
    const pct = first !== 0 ? ((last - first) / Math.abs(first)) * 100 : null;
    const direction = last > first ? 'up' : last < first ? 'down' : 'flat';
    const trendText = series.length < 2
      ? `Only one ${plan.group} of data in that period.`
      : `From ${withUnit(first, metric)} on ${series[0].bucket} to ${withUnit(last, metric)} on ${series[series.length - 1].bucket} — ${direction}${pct == null ? '' : ` ${Math.abs(pct).toFixed(1)}%`}.`;
    return {
      text: `${metric.label} by ${plan.group} for ${vesselPhrase}, ${provenance.period}. ${trendText}`,
      series,
      unit: metric.unit,
      rowsUsed: series.reduce((a, s) => a + s.rowsUsed, 0),
      chart: { type: 'line', xKey: 'bucket', yKey: 'value', unit: metric.unit, label: metric.label },
      // A neutral explanation of how the buckets were built. Kept separate
      // from `note`, which is reserved for things that affect whether the
      // figure can be trusted — assumptions made, and gaps in coverage.
      footnote: `Each point is the ${metric.kind === 'quantity' ? 'total' : 'average'} of the reports in that ${plan.group}.`,
      note: coverageNote(plan, series.reduce((a, s) => a + s.rowsUsed, 0)),
    };
  }

  if (shape === 'summary') {
    const r = rows[0] || {};
    const n = Number(r.n_rows || 0);
    if (!n) return noData(plan, metric, provenance);
    const headline = metric.kind === 'quantity'
      ? `Total ${withUnit(r.total, metric)} across ${n} reports`
      : `Average ${withUnit(r.average, metric)} across ${n} reports`;
    return {
      text: `${metric.label} for ${vesselPhrase}, ${provenance.period}. ${headline}.`,
      unit: metric.unit,
      rowsUsed: n,
      stats: {
        reports: n,
        vessels: Number(r.n_vessels || 0),
        total: metric.kind === 'quantity' ? Number(r.total) : null,
        average: r.average == null ? null : Number(r.average),
        minimum: r.minimum == null ? null : Number(r.minimum),
        maximum: r.maximum == null ? null : Number(r.maximum),
        stddev: r.stddev == null ? null : Number(r.stddev),
        firstAt: atLabel(r.first_at),
        lastAt: atLabel(r.last_at),
      },
      coverage: { firstAt: atLabel(r.first_at), lastAt: atLabel(r.last_at) },
      note: coverageNote(plan, n),
    };
  }

  if (shape === 'by_vessel') {
    const named = rows.map((r) => ({
      vesselId: r.vessel_id,
      vessel: provenance.vesselNameFor ? provenance.vesselNameFor(r.vessel_id) : String(r.vessel_id),
      value: r.value == null ? null : Number(r.value),
      rowsUsed: Number(r.n_rows || 0),
    })).filter((x) => x.rowsUsed > 0);
    if (!named.length) return noData(plan, metric, provenance);
    const word = AGG_WORD[plan.aggregation] || 'Value';
    const missing = provenance.vessels.filter((n) => !named.some((x) => x.vessel === n));

    // Ranking: lead with the answer (a vessel), then the ordered list.
    if (plan.ranking) {
      const desc = plan.ranking.order !== 'asc';
      const ranked = named.filter((x) => x.value != null).sort((a, b) => desc ? b.value - a.value : a.value - b.value);
      if (!ranked.length) return noData(plan, metric, provenance);
      const top = ranked.slice(0, plan.ranking.limit || 5);
      const superlative = desc ? 'highest' : 'lowest';
      const lead = `${ranked[0].vessel} has the ${superlative} ${word.toLowerCase()} ${metric.label.toLowerCase()} ${provenance.period}: ${withUnit(ranked[0].value, metric)}.`;
      const rest = top.slice(1).map((x, i) => `${i + 2}. ${x.vessel} ${withUnit(x.value, metric)}`).join('; ');
      const coverage = ranked.length < provenance.vessels.length
        ? ` Ranked across ${ranked.length} of ${provenance.vessels.length} vessels; ${missing.length ? missing.length + ' had no records in that period.' : ''}`
        : ` Ranked across all ${ranked.length} vessels.`;
      return {
        text: lead + (rest ? ` Then: ${rest}.` : '') + coverage.replace(/\s+$/, ''),
        unit: metric.unit,
        rowsUsed: named.reduce((a, x) => a + x.rowsUsed, 0),
        byVessel: top,
        ranking: { order: desc ? 'desc' : 'asc', shown: top.length, of: ranked.length },
        chart: { type: 'bar', title: `${word} ${metric.label.toLowerCase()} by vessel — ${provenance.period}`, labels: top.map((x) => x.vessel), values: top.map((x) => x.value), unit: metric.unit, decimals: metric.decimals },
        note: assumptionNote(plan, metric, named.reduce((a, x) => a + x.rowsUsed, 0)),
      };
    }

    const parts = named.map((x) => `${x.vessel} ${withUnit(x.value, metric)} (${x.rowsUsed} report${x.rowsUsed === 1 ? '' : 's'})`);
    return {
      text: `${word} ${metric.label.toLowerCase()}, ${provenance.period}: ${parts.join('; ')}.` + (missing.length ? ` No records for ${missing.join(', ')} in that period.` : ''),
      unit: metric.unit,
      rowsUsed: named.reduce((a, x) => a + x.rowsUsed, 0),
      byVessel: named,
      chart: { type: 'bar', title: `${word} ${metric.label.toLowerCase()} — ${provenance.period}`, labels: named.map((x) => x.vessel), values: named.map((x) => x.value), unit: metric.unit, decimals: metric.decimals },
      note: assumptionNote(plan, metric, named.reduce((a, x) => a + x.rowsUsed, 0)),
    };
  }

  if (shape === 'compare') {
    const r = rows[0] || {};
    const aRows = Number(r.a_rows || 0);
    const bRows = Number(r.b_rows || 0);
    if (!aRows && !bRows) return noData(plan, metric, provenance);
    const [ra, rb] = plan.ranges;
    if (!aRows || !bRows) {
      const missing = !aRows ? ra : rb;
      return {
        text: `I have no ${metric.label.toLowerCase()} data for ${missing.label}, so I cannot compare the two periods. The other period (${(!aRows ? rb : ra).label}) has ${!aRows ? bRows : aRows} reports.`,
        rowsUsed: aRows + bRows,
        partial: true,
      };
    }
    const a = Number(r.a_value);
    const b = Number(r.b_value);
    const diff = b - a;
    const pct = a !== 0 ? (diff / Math.abs(a)) * 100 : null;
    const word = plan.aggregation === 'sum' ? 'Total' : 'Average';
    return {
      text: `${word} ${metric.label.toLowerCase()} for ${vesselPhrase}: ${withUnit(a, metric)} in ${ra.label} (${aRows} reports) versus ${withUnit(b, metric)} in ${rb.label} (${bRows} reports). That is ${diff >= 0 ? 'an increase' : 'a decrease'} of ${withUnit(Math.abs(diff), metric)}${pct == null ? '' : ` (${Math.abs(pct).toFixed(1)}%)`}.`,
      unit: metric.unit,
      comparison: {
        a: { label: ra.label, value: a, rows: aRows },
        b: { label: rb.label, value: b, rows: bRows },
        difference: diff,
        percentChange: pct,
      },
      chart: { type: 'bar', title: `${word} ${metric.label.toLowerCase()}`, labels: [ra.label, rb.label], values: [a, b], unit: metric.unit, decimals: metric.decimals },
      rowsUsed: aRows + bRows,
      note: aRows !== bRows ? `The two periods do not have the same number of reports (${aRows} vs ${bRows}), so the comparison is not like-for-like.` : null,
    };
  }

  return noData(plan, metric, provenance);
}

function noData(plan, metric, provenance) {
  return {
    text: `${NO_DATA} There are no ${metric.label.toLowerCase()} records for ${provenance.vessels.join(', ') || 'that vessel'} in ${provenance.period}.`,
    value: null,
    rowsUsed: 0,
    empty: true,
  };
}

function assumptionNote(plan, metric, n) {
  const parts = [];
  if (plan.aggregationWasAssumed) {
    const word = { sum: 'total', avg: 'average', delta: 'change', value: 'the recorded value' }[plan.aggregation] || plan.aggregation;
    parts.push(`You did not say which figure you wanted, so I gave the ${word} — ${metric.kind === 'quantity' ? 'this metric accumulates across reports' : 'this metric is a reading, not an amount'}.`);
  }
  if (plan.range && plan.range.days > 1) parts.push(`Based on ${n} reports.`);
  // A total over a period with missing days is the commonest way to be
  // confidently wrong, so the gap is always stated alongside the figure.
  const gap = coverageNote(plan, n);
  if (gap) parts.push(gap);
  return parts.join(' ') || null;
}

function coverageNote(plan, n) {
  if (!plan.range || plan.range.days <= 1) return null;
  const pct = Math.round((n / plan.range.days) * 100);
  if (pct >= 95) return null;
  return `${n} reports cover a ${plan.range.days}-day period, so roughly ${100 - pct}% of days have no report.`;
}

/**
 * Handle one message end to end.
 *
 * @param {object} input { text, session, pending, now }
 * @param {object} db    a pg client/pool bound to the READ-ONLY role
 * @param {object} opts  { orgId, writeDb, log }
 */
async function ask(input, db, opts = {}) {
  const scope = await rbac.resolveScope(input.session, db);

  if (!scope.authenticated) {
    return { status: 'unauthenticated', text: 'Sign in and I can look at your vessel data.' };
  }
  if (!scope.vessels.length) {
    return { status: 'no_scope', text: 'Your account is not linked to any vessel, so there is nothing for me to read.' };
  }

  const learned = opts.orgId ? await terms.loadMappings(db, opts.orgId).catch(() => []) : [];

  // Confirming a term the previous turn proposed.
  if (input.pending && input.pending.kind === 'teach') {
    const yes = /^\s*(y|yes|yep|sure|ok|okay|save|confirm|yes,? save it)\b/i.test(input.text || '');
    if (!yes) return { status: 'ack', text: 'Left as it was.' };
    if (!opts.writeDb) return { status: 'ack', text: 'I cannot save vocabulary right now — the mapping store is not writable.' };
    const saved = await terms.saveMapping(opts.writeDb, {
      orgId: opts.orgId,
      term: input.pending.term,
      metricKey: input.pending.metricKey,
      userId: input.session && input.session.userId,
    });
    if (!saved.ok) {
      const why = saved.reason === 'collides_with_config'
        ? `"${input.pending.term}" already means ${saved.collidesWith} here, so I have not changed it.`
        : 'I could not save that mapping.';
      return { status: 'ack', text: why };
    }
    return { status: 'ack', text: `Saved. "${input.pending.term}" now means ${METRICS_BY_KEY[input.pending.metricKey].label}.` };
  }

  const parsed = parser.parse(input.text, {
    now: input.now,
    vessels: scope.vessels,
    learned,
    pending: input.pending && input.pending.kind === 'clarify' ? input.pending : null,
    dateOrder: opts.dateOrder,
    defaultVesselId: input.context && input.context.vesselId ? String(input.context.vesselId) : null,
  });

  if (parsed.status === 'teach') {
    return {
      status: 'confirm',
      text: parsed.question,
      options: parsed.options,
      pending: { kind: 'teach', term: parsed.term, metricKey: parsed.metricKey },
    };
  }

  if (parsed.status === 'clarify') {
    await logQuery(opts, input, 'clarify', parsed.reason);
    return {
      status: 'clarify',
      text: parsed.question,
      options: parsed.options,
      pending: Object.assign({ kind: 'clarify' }, parsed.pending),
    };
  }

  if (parsed.status === 'unsupported') {
    await logQuery(opts, input, 'unsupported', parsed.reason);
    return { status: 'unsupported', text: parsed.message, options: parsed.options || null };
  }

  if (parsed.status === 'unparsed') {
    await logQuery(opts, input, 'unparsed', (parsed.missing || []).join(','));
    return {
      status: 'unparsed',
      text: `${parsed.message} I can read: ${(parsed.suggestions || []).join(', ')}. Ask me "help" for the full list.`,
    };
  }

  if (parsed.status === 'help') {
    return {
      status: 'help',
      text: 'I answer from your vessel records only. Here is what I can read.',
      metrics: parsed.metrics,
      vessels: parsed.vessels,
    };
  }

  const out = await execute(parsed.plan, scope, db, opts);
  await logQuery(opts, input, out.status === 'answer' ? (out.empty ? 'empty' : 'answered') : out.status, parsed.plan.metricKey);
  return out;
}

async function logQuery(opts, input, outcome, detail) {
  if (!opts.writeDb || opts.disableLog) return;
  try {
    await opts.writeDb.query(
      `INSERT INTO captain_query_log (org_id, user_id, question, outcome, detail)
       VALUES ($1, $2, $3, $4, $5)`,
      [opts.orgId || null, (input.session && input.session.userId) || null, String(input.text || '').slice(0, 500), outcome, String(detail || '').slice(0, 200)]
    );
  } catch (_) { /* logging must never break an answer */ }
}

module.exports = { ask, execute, NO_DATA };