'use strict';

/**
 * Captain test suite.
 *
 *   node test/run.js
 *
 * Needs a Postgres loaded with test/fixtures/example_schema.sql and the
 * connection string in CAPTAIN_TEST_URL. Set CAPTAIN_TEST_URL='' to run only
 * the offline tests (dates, parser, SQL shape).
 */

const assert = require('assert');
const { Client } = require('pg');

const dates = require('../src/dates');
const parser = require('../src/parser');
const sqlBuilder = require('../src/sql');
const rbac = require('../src/rbac');
const engine = require('../src/engine');
const { normalizeTerm, foldTokens } = require('../src/normalize');

const NOW = new Date('2026-09-01T10:00:00Z');

const VESSELS = [
  { id: '9851701', name: 'Aurora Trader', altNames: ['9851701'] },
  { id: '9234567', name: 'Northern Pearl', altNames: ['9234567'] },
];
const SCOPE = { authenticated: true, vessels: VESSELS, vesselIds: ['9851701', '9234567'] };
const ONE = { authenticated: true, vessels: [VESSELS[0]], vesselIds: ['9851701'] };

let passed = 0;
const failures = [];

function t(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures.push({ name, error: e.message }); }
}

async function ta(name, fn) {
  try { await fn(); passed++; }
  catch (e) { failures.push({ name, error: e.message }); }
}

const ask = (text, ctx = {}) => parser.parse(text, Object.assign({ now: NOW, vessels: VESSELS }, ctx));

// ===========================================================================
// 1. Normalisation
// ===========================================================================

t('normalize: dotted abbreviation collapses', () => {
  assert.strictEqual(normalizeTerm('S.P.'), 'sp');
  assert.strictEqual(normalizeTerm('s. p.'), 'sp');
  assert.strictEqual(normalizeTerm('M/E F.O.C.'), 'me foc');
});

t('normalize: case and punctuation', () => {
  assert.strictEqual(normalizeTerm('Shaft-Power'), 'shaft power');
  assert.strictEqual(normalizeTerm('  Shaft   Power  '), 'shaft power');
});

t('normalize: plural folding', () => {
  assert.strictEqual(foldTokens(normalizeTerm('consumptions')), foldTokens(normalizeTerm('consumption')));
});

// ===========================================================================
// 2. Dates — every phrasing from the brief
// ===========================================================================

const dcase = (text, startDate, endDate, grain) => t(`dates: ${text}`, () => {
  const r = dates.resolveTimeRange(text, NOW);
  assert.ok(r && !r.needsDate, `no range for "${text}"`);
  assert.strictEqual(r.startDate, startDate, `start for "${text}"`);
  assert.strictEqual(r.endDate, endDate, `end for "${text}"`);
  if (grain) assert.strictEqual(r.grain, grain);
});

dcase('on 15 August 2026', '2026-08-15', '2026-08-15');
dcase('yesterday', '2026-08-31', '2026-08-31');
dcase('from 1 January until today', '2026-01-01', '2026-09-01');
dcase('last month', '2026-08-01', '2026-08-31');
dcase('last 6 months', '2026-03-02', '2026-09-01');
dcase('on 15th August', '2026-08-15', '2026-08-15');
dcase('between 1 Jan and 31 Mar', '2026-01-01', '2026-03-31');
dcase('last 7 days', '2026-08-26', '2026-09-01');
dcase('Q1 2026', '2026-01-01', '2026-03-31');
dcase('in 2025', '2025-01-01', '2025-12-31');
dcase('15/08/2026', '2026-08-15', '2026-08-15');
dcase('2026-07-04', '2026-07-04', '2026-07-04');
dcase('August 2026', '2026-08-01', '2026-08-31');
dcase('last week', '2026-08-24', '2026-08-30');
dcase('last quarter', '2026-04-01', '2026-06-30');
dcase('yesterday between 09:00 and 17:00', '2026-08-31', '2026-08-31', 'hour');

t('dates: bare month/day looks backwards, never forwards', () => {
  const r = dates.resolveTimeRange('on 5 September', NOW);
  assert.strictEqual(r.startDate, '2025-09-05', 'a bare date must resolve to the most recent past occurrence');
});

t('dates: "August 2026" is not read as day 20 of 2026', () => {
  const r = dates.resolveTimeRange('distance for August 2026', NOW);
  assert.strictEqual(r.days, 31);
});

t('dates: clock window without a date asks rather than assuming', () => {
  const r = dates.resolveTimeRange('between 1 PM and 5 PM', NOW);
  assert.ok(r.needsDate);
});

t('dates: DMY vs MDY honoured', () => {
  assert.strictEqual(dates.resolveTimeRange('03/04/2026', NOW, { dateOrder: 'DMY' }).startDate, '2026-04-03');
  assert.strictEqual(dates.resolveTimeRange('03/04/2026', NOW, { dateOrder: 'MDY' }).startDate, '2026-03-04');
});

t('dates: impossible date is rejected, not clamped', () => {
  assert.strictEqual(dates.resolveTimeRange('on 31 February 2026', NOW), null);
});

// ===========================================================================
// 3. Parser — the brief's example questions
// ===========================================================================

t('parser: shaft power on a specific date', () => {
  const r = ask('What is the Shaft Power for Aurora Trader on 15 August 2026?');
  assert.strictEqual(r.status, 'plan');
  assert.strictEqual(r.plan.metricKey, 'shaft_power');
  assert.deepStrictEqual(r.plan.vesselIds, ['9851701']);
  assert.strictEqual(r.plan.range.startDate, '2026-08-15');
});

t('parser: S.P. resolves to shaft power', () => {
  const r = ask('What was the S.P. for Aurora Trader yesterday?');
  assert.strictEqual(r.status, 'plan');
  assert.strictEqual(r.plan.metricKey, 'shaft_power');
});

t('parser: SP without dots resolves too', () => {
  assert.strictEqual(ask('sp for Aurora Trader yesterday').plan.metricKey, 'shaft_power');
});

t('parser: "shaft output" resolves', () => {
  assert.strictEqual(ask('shaft output for Aurora Trader yesterday').plan.metricKey, 'shaft_power');
});

t('parser: bare "consumption" asks which metric, offering the real candidates', () => {
  const r = ask('What is my consumption?', { vessels: [VESSELS[0]] });
  assert.strictEqual(r.status, 'clarify');
  assert.strictEqual(r.reason, 'ambiguous_metric', 'must be a metric choice, not a yes/no confirmation');
  const keys = r.options.map((o) => o.value).sort();
  assert.deepStrictEqual(keys, ['ae_consumption', 'fuel_consumption', 'leg_fuel', 'me_consumption']);
});

t('parser: "consumption from 1 January until today" asks rather than guessing', () => {
  const r = ask('Tell me the consumption from 1 January until today.', { vessels: [VESSELS[0]] });
  assert.strictEqual(r.status, 'clarify');
  assert.strictEqual(r.reason, 'ambiguous_metric');
  assert.ok(r.options.length === 4, 'geoform fuel x3 plus Veson leg fuel');
});

t('parser: answering the ambiguity keeps the original date range', () => {
  const first = ask('Tell me the consumption from 1 January until today.', { vessels: [VESSELS[0]] });
  const second = parser.parse('fuel_consumption', {
    now: NOW, vessels: [VESSELS[0]],
    pending: Object.assign({}, first.pending, { metricKey: 'fuel_consumption' }),
  });
  assert.strictEqual(second.status, 'plan');
  assert.strictEqual(second.plan.metricKey, 'fuel_consumption');
  assert.strictEqual(second.plan.range.startDate, '2026-01-01');
});

t('parser: a learned mapping overrides the built-in ambiguity', () => {
  const learned = [{ term: 'consumption', metric_key: 'fuel_consumption' }];
  const r = ask('consumption for Aurora Trader last month', { learned });
  assert.strictEqual(r.status, 'plan', 'teaching the term should stop the questions');
  assert.strictEqual(r.plan.metricKey, 'fuel_consumption');
});

t('parser: "fuel consumption" still beats the ambiguous "consumption"', () => {
  const r = ask('fuel consumption for Aurora Trader last month');
  assert.strictEqual(r.status, 'plan');
  assert.strictEqual(r.plan.metricKey, 'fuel_consumption');
});

t('parser: "main engine consumption" beats bare "consumption"', () => {
  const r = ask('main engine consumption for Aurora Trader last month');
  assert.strictEqual(r.status, 'plan');
  assert.strictEqual(r.plan.metricKey, 'me_consumption');
});

t('parser: sum is the default for a quantity over a range', () => {
  const r = ask('fuel consumption for Aurora Trader from 1 January until today');
  assert.strictEqual(r.plan.aggregation, 'sum');
  assert.ok(r.plan.aggregationWasAssumed);
});

t('parser: average is the default for a rate over a range', () => {
  const r = ask('shaft power for Aurora Trader last month');
  assert.strictEqual(r.plan.aggregation, 'avg');
});

t('parser: summing a rate is refused, not answered', () => {
  const r = ask('total shaft power for Aurora Trader last month');
  assert.strictEqual(r.status, 'unsupported');
  assert.strictEqual(r.reason, 'aggregation_not_meaningful');
});

t('parser: "analyse the data of my vessel" becomes a whole-vessel overview', () => {
  const r = ask('Analyse the data of Aurora Trader of last 6 month');
  assert.strictEqual(r.status, 'plan');
  assert.strictEqual(r.plan.intent, 'overview');
  assert.ok(r.plan.metricKeys.includes('fuel_consumption'));
  assert.strictEqual(r.plan.range.startDate, '2026-03-02');
});

t('parser: analyse WITH a named metric stays a single-metric summary', () => {
  const r = ask('analyse fuel consumption for Aurora Trader last month');
  assert.strictEqual(r.plan.intent, 'summary');
  assert.strictEqual(r.plan.metricKey, 'fuel_consumption');
});

t('parser: explicit aggregations are honoured', () => {
  assert.strictEqual(ask('average shaft power Aurora Trader last month').plan.aggregation, 'avg');
  assert.strictEqual(ask('max shaft power Aurora Trader last month').plan.aggregation, 'max');
  assert.strictEqual(ask('minimum speed Aurora Trader last month').plan.aggregation, 'min');
  assert.strictEqual(ask('total fuel consumption Aurora Trader last month').plan.aggregation, 'sum');
});

t('parser: trend request groups sensibly', () => {
  const r = ask('fuel consumption trend for Aurora Trader last 30 days');
  assert.strictEqual(r.plan.intent, 'trend');
  assert.strictEqual(r.plan.group, 'day');
});

t('parser: long trend auto-coarsens the buckets', () => {
  const r = ask('fuel consumption trend for Aurora Trader in 2025');
  assert.strictEqual(r.plan.group, 'week');
});

t('parser: hour question against a daily-only metric is refused', () => {
  const r = ask('speed for Aurora Trader between 1 PM and 5 PM on 12 August 2026');
  assert.strictEqual(r.status, 'unsupported');
  assert.strictEqual(r.reason, 'granularity');
});

t('parser: hour question against shaft power is refused too (no sub-daily source)', () => {
  const r = ask('shaft power for Aurora Trader between 1 PM and 5 PM on 12 August 2026');
  assert.strictEqual(r.status, 'unsupported');
  assert.strictEqual(r.reason, 'granularity');
  assert.ok(!/\d{3,}/.test(r.message), 'refusal must not contain a figure');
});

t('parser: Veson leg metrics resolve', () => {
  assert.strictEqual(ask('ghg intensity for Aurora Trader last quarter').plan.metricKey, 'ghg_intensity');
  assert.strictEqual(ask('leg fuel for Aurora Trader in 2026').plan.metricKey, 'leg_fuel');
  assert.strictEqual(ask('off hire hours for Aurora Trader this year').plan.metricKey, 'offhire_hours');
});

t('parser: "co2" is ambiguous between report CO2 and leg CO2', () => {
  const r = ask('co2 for Aurora Trader last month');
  assert.strictEqual(r.status, 'clarify');
  assert.deepStrictEqual(r.options.map((o) => o.value).sort(), ['co2', 'leg_co2']);
});

t('parser: count-only metric is always counted', () => {
  const r = ask('how many legs for Aurora Trader in 2026');
  assert.strictEqual(r.plan.aggregation, 'count');
});

t('parser: clock window with no date asks which date', () => {
  const r = ask('What was the S.P. for Aurora Trader between 1 PM and 5 PM?');
  assert.strictEqual(r.status, 'clarify');
  assert.strictEqual(r.reason, 'clock_without_date');
});

t('parser: naming two vessels compares them side by side instead of asking which', () => {
  const r = ask('compare fuel consumption for Aurora Trader and Northern Pearl last month');
  assert.strictEqual(r.status, 'plan');
  assert.strictEqual(r.plan.intent, 'by_vessel');
  assert.strictEqual(r.plan.aggregation, 'sum');
  assert.deepStrictEqual(r.plan.vesselIds.sort(), ['9234567', '9851701']);
});

t('parser: "by vessel" across the fleet is a per-vessel plan', () => {
  const r = ask('shaft power across the fleet by vessel in August');
  assert.strictEqual(r.plan.intent, 'by_vessel');
  assert.strictEqual(r.plan.aggregation, 'avg', 'rates average, they do not sum');
});

t('sql: by_vessel groups by the vessel column and carries the scope predicate', () => {
  const r = ask('compare fuel consumption for Aurora Trader and Northern Pearl last month');
  const st = sqlBuilder.build(r.plan, r.plan.vesselIds);
  assert.ok(/GROUP BY 1/.test(st.text));
  assert.ok(/imo" = ANY/.test(st.text));
});

t('parser: missing vessel asks when the user has several', () => {
  const r = ask('shaft power yesterday');
  assert.strictEqual(r.status, 'clarify');
  assert.strictEqual(r.reason, 'missing_vessel');
});

t('parser: single-vessel user does not get asked', () => {
  const r = ask('shaft power yesterday', { vessels: [VESSELS[0]] });
  assert.strictEqual(r.status, 'plan');
  assert.deepStrictEqual(r.plan.vesselIds, ['9851701']);
});

t('parser: vessel matched by IMO', () => {
  const r = ask('shaft power for 9234567 yesterday');
  assert.deepStrictEqual(r.plan.vesselIds, ['9234567']);
});

t('parser: missing period asks', () => {
  const r = ask('shaft power for Aurora Trader');
  assert.strictEqual(r.status, 'clarify');
  assert.strictEqual(r.reason, 'missing_range');
});

t('parser: clarification answer is merged with the original question', () => {
  const first = ask('shaft power for Aurora Trader');
  const second = ask('yesterday', { pending: first.pending });
  assert.strictEqual(second.status, 'plan');
  assert.strictEqual(second.plan.metricKey, 'shaft_power');
  assert.strictEqual(second.plan.range.startDate, '2026-08-31');
});

t('parser: unknown metric is not guessed at', () => {
  const r = ask('what is the ballast water salinity for Aurora Trader yesterday');
  assert.ok(['unparsed', 'clarify'].includes(r.status));
  if (r.status === 'plan') assert.fail('should not have invented a metric');
});

t('parser: typo is confirmed, not silently accepted', () => {
  const r = ask('shaft powr for Aurora Trader yesterday');
  assert.strictEqual(r.status, 'clarify');
  assert.strictEqual(r.reason, 'fuzzy_metric');
});

t('parser: short lookalikes are not fuzzy-matched', () => {
  // "ap" must not become "sp" — one character apart, completely different meaning
  const r = ask('ap for Aurora Trader yesterday');
  assert.notStrictEqual(r.status, 'plan');
});

t('parser: comparison builds two ranges', () => {
  const r = ask('compare fuel consumption for Aurora Trader this month vs last month');
  assert.strictEqual(r.status, 'plan');
  assert.strictEqual(r.plan.intent, 'compare');
  assert.strictEqual(r.plan.ranges.length, 2);
});

t('parser: learned term is used', () => {
  const learned = [{ term: 'juice', metric_key: 'fuel_consumption' }];
  const r = ask('juice for Aurora Trader last month', { learned });
  assert.strictEqual(r.status, 'plan');
  assert.strictEqual(r.plan.metricKey, 'fuel_consumption');
});

t('parser: teaching is detected and confirmed before saving', () => {
  const r = ask('S.P. means Shaft Power');
  assert.strictEqual(r.status, 'teach');
  assert.strictEqual(r.metricKey, 'shaft_power');
});

t('parser: teaching a term onto an unknown metric is refused', () => {
  const r = ask('blorp means quantum thrust');
  assert.strictEqual(r.status, 'unsupported');
});

t('parser: fleet-wide phrasing expands to the whole scope', () => {
  const r = ask('total fuel consumption across the fleet last month');
  assert.deepStrictEqual(r.plan.vesselIds.sort(), ['9234567', '9851701']);
});

t('parser: absurdly wide range is refused, not truncated', () => {
  const r = ask('fuel consumption for Aurora Trader from 1 January 1990 until today');
  assert.strictEqual(r.status, 'unsupported');
  assert.strictEqual(r.reason, 'range_too_wide');
});

// ===========================================================================
// 4. SQL construction and injection resistance
// ===========================================================================

t('sql: every value is bound, nothing interpolated', () => {
  const r = ask('shaft power for Aurora Trader on 15 August 2026');
  const st = sqlBuilder.build(r.plan, ['9851701']);
  assert.ok(!/V-001/.test(st.text), 'vessel id must not appear in the SQL text');
  assert.ok(!/2026-08-15/.test(st.text), 'date must not appear in the SQL text');
  assert.ok(st.values.includes('2026-08-15'));
});

t('sql: injection attempt in a vessel name never reaches the statement', () => {
  const evil = [{ id: "9851701'; DROP TABLE geoform_reports;--", name: 'Aurora Trader', altNames: [] }];
  const r = parser.parse('shaft power yesterday', { now: NOW, vessels: evil });
  const st = sqlBuilder.build(r.plan, evil.map((v) => v.id));
  assert.ok(!/DROP TABLE/i.test(st.text));
  assert.ok(st.values.some((v) => Array.isArray(v) && v[0].includes('DROP TABLE')));
});

t('sql: refuses to build without a vessel scope', () => {
  const r = ask('shaft power for Aurora Trader yesterday');
  assert.throws(() => sqlBuilder.build(r.plan, []), /empty vessel scope/);
});

t('sql: scope predicate is present on every statement shape', () => {
  const plans = [
    'shaft power for Aurora Trader on 15 August 2026',
    'average shaft power for Aurora Trader last month',
    'fuel consumption trend for Aurora Trader last 30 days',
    'analyse fuel consumption for Aurora Trader last month',
    'compare fuel consumption for Aurora Trader this month vs last month',
  ];
  for (const p of plans) {
    const r = ask(p);
    assert.strictEqual(r.status, 'plan', p);
    const st = sqlBuilder.build(r.plan, ['9851701']);
    assert.ok(/imo" = ANY/.test(st.text), `missing scope predicate in: ${p}`);
  }
});

// ===========================================================================
// 5. Authorisation
// ===========================================================================

t('rbac: out-of-scope vessel id is dropped', () => {
  const a = rbac.authorizeVesselIds(['9851701', '9999999'], SCOPE);
  assert.deepStrictEqual(a.vesselIds, ['9851701']);
  assert.strictEqual(a.droppedCount, 1);
});

t('rbac: entirely out-of-scope request is denied', () => {
  assert.strictEqual(rbac.authorizeVesselIds(['9999999'], SCOPE).ok, false);
});

t('rbac: a vessel outside the scope cannot even be named', () => {
  const r = parser.parse('shaft power for Kaveri Star yesterday', { now: NOW, vessels: VESSELS });
  // Kaveri Star is not in scope, so it is not recognised as a vessel at all.
  assert.ok(r.status !== 'plan' || !r.plan.vesselIds.includes('9345678'));
});

// ===========================================================================
// 6. End to end against the database
// ===========================================================================

async function e2e() {
  const url = process.env.CAPTAIN_TEST_URL;
  if (!url) {
    console.log('\n(skipping live database tests — CAPTAIN_TEST_URL not set)');
    return;
  }

  const db = new Client({ connectionString: url });
  await db.connect();

  const session = { userId: 'u1', orgId: 'test-org', vesselIds: ['9851701', '9234567'] };
  const run = (text, pending) => engine.ask({ text, session, pending, now: NOW }, db, { orgId: 'test-org' });

  await ta('e2e: single-day value matches the row in the table', async () => {
    const out = await run('What is the Shaft Power for Aurora Trader on 15 August 2026?');
    assert.strictEqual(out.status, 'answer');
    const { rows } = await db.query(
      'SELECT shaft_power_kw FROM geoform_reports WHERE imo=$1 AND report_date=$2', ['9851701', '2026-08-15']);
    assert.ok(rows.length === 1);
    assert.strictEqual(out.value, rows[0].shaft_power_kw);
  });

  await ta('e2e: sum matches an independent SQL sum', async () => {
    const out = await run('fuel consumption for Aurora Trader from 1 January until today');
    const { rows } = await db.query(
      `SELECT SUM(fuel_consumed_mt)::double precision s, COUNT(*) c FROM geoform_reports
        WHERE imo=$1 AND report_date BETWEEN $2 AND $3`, ['9851701', '2026-01-01', '2026-09-01']);
    assert.ok(Math.abs(out.value - rows[0].s) < 1e-6, `${out.value} vs ${rows[0].s}`);
    assert.strictEqual(out.rowsUsed, Number(rows[0].c));
  });

  await ta('e2e: average matches an independent SQL average', async () => {
    const out = await run('average shaft power for Aurora Trader last month');
    const { rows } = await db.query(
      `SELECT AVG(shaft_power_kw)::double precision a FROM geoform_reports
        WHERE imo=$1 AND report_date BETWEEN $2 AND $3`, ['9851701', '2026-08-01', '2026-08-31']);
    assert.ok(Math.abs(out.value - rows[0].a) < 1e-9);
  });

  await ta('e2e: min and max match', async () => {
    const mn = await run('minimum speed for Aurora Trader last month');
    const mx = await run('highest speed for Aurora Trader last month');
    const { rows } = await db.query(
      `SELECT MIN(speed_kn)::double precision mn, MAX(speed_kn)::double precision mx FROM geoform_reports
        WHERE imo=$1 AND report_date BETWEEN $2 AND $3`, ['9851701', '2026-08-01', '2026-08-31']);
    assert.strictEqual(mn.value, rows[0].mn);
    assert.strictEqual(mx.value, rows[0].mx);
  });

  await ta('e2e: missing data says so and returns no number', async () => {
    const out = await run('fuel consumption for Northern Pearl on 10 June 2026');
    assert.ok(out.empty, 'should report the gap');
    assert.strictEqual(out.value, null);
    assert.ok(out.text.includes('could not find'));
  });

  await ta('e2e: coverage gap is disclosed rather than hidden', async () => {
    const out = await run('analyse fuel consumption for Northern Pearl in June 2026');
    assert.strictEqual(out.status, 'answer');
    assert.ok(out.note && /no report/.test(out.note), `expected a coverage note, got: ${out.note}`);
  });

  await ta('e2e: trend returns one point per bucket', async () => {
    const out = await run('fuel consumption trend for Aurora Trader last 30 days');
    assert.ok(Array.isArray(out.series));
    assert.strictEqual(out.series.length, 30);
  });

  await ta('e2e: comparison percentage is arithmetically right', async () => {
    const out = await run('compare fuel consumption for Aurora Trader this month vs last month');
    assert.ok(out.comparison || out.partial);
    if (out.comparison) {
      const { a, b, difference, percentChange } = out.comparison;
      assert.ok(Math.abs((b.value - a.value) - difference) < 1e-9);
      assert.ok(Math.abs(((difference / Math.abs(a.value)) * 100) - percentChange) < 1e-9);
    }
  });

  await ta('e2e: a user scoped to one vessel cannot read the other', async () => {
    const narrow = { userId: 'u2', orgId: 'test-org', vesselIds: ['9851701'] };
    const out = await engine.ask(
      { text: 'shaft power for Northern Pearl on 15 August 2026', session: narrow, now: NOW }, db, { orgId: 'test-org' });
    // Northern Pearl is invisible: it is either unrecognised, or resolved to
    // the only vessel this user can see. It must never return V-002's data.
    if (out.status === 'answer') {
      assert.deepStrictEqual(out.provenance.vessels, ['Aurora Trader']);
    }
  });

  await ta('e2e: department scoping resolves the right fleet', async () => {
    const dept = { userId: 'u3', orgId: 'test-org', departments: ['Performance'] };
    const scope = await rbac.resolveScope(dept, db);
    assert.deepStrictEqual(scope.vessels.map((v) => v.name), ['Kaveri Star']);
  });

  await ta('e2e: unauthenticated request reads nothing', async () => {
    const out = await engine.ask({ text: 'shaft power yesterday', session: null, now: NOW }, db, {});
    assert.strictEqual(out.status, 'unauthenticated');
  });

  await ta('e2e: summing a rate never produces a number', async () => {
    const out = await run('total shaft power for Aurora Trader last month');
    assert.strictEqual(out.status, 'unsupported');
    assert.ok(!/\d{3,}/.test(out.text), 'refusal must not contain a figure');
  });

  await ta('e2e: overview reports every metric, including the empty ones', async () => {
    const out = await run('Analyse the data of Aurora Trader of last 6 month');
    assert.strictEqual(out.status, 'answer');
    assert.ok(Array.isArray(out.overview));
    const fuel = out.overview.find((b) => b.metric === 'Fuel consumption');
    const { rows } = await db.query(
      `SELECT SUM(fuel_consumed_mt)::double precision s FROM geoform_reports
        WHERE imo=$1 AND report_date BETWEEN $2 AND $3`, ['9851701', '2026-03-02', '2026-09-01']);
    assert.ok(Math.abs(fuel.headline - rows[0].s) < 1e-6);
    assert.ok(out.overview.some((b) => b.metric === 'Off-hire time'), 'overview spans every source');
  });

  await ta('e2e: overview over a period with no data says so', async () => {
    const out = await run('analyse Aurora Trader in 2019');
    assert.ok(out.empty);
  });

  await ta('e2e: teaching resolves a group term for that org only', async () => {
    const terms = require('../src/terms');
    const saved = await terms.saveMapping(db, { orgId: 'test-org', term: 'consumption', metricKey: 'fuel_consumption', userId: 'u1' });
    assert.ok(saved.ok, JSON.stringify(saved));
    const out = await run('consumption for Aurora Trader last month');
    assert.strictEqual(out.status, 'answer', out.text);
    assert.strictEqual(out.provenance.metric, 'Fuel consumption');

    const other = await engine.ask(
      { text: 'consumption for Aurora Trader last month',
        session: { userId: 'z', orgId: 'other-org', vesselIds: ['9851701'] }, now: NOW },
      db, { orgId: 'other-org' });
    assert.strictEqual(other.status, 'clarify', 'another org must still be asked');
    await terms.forgetMapping(db, { orgId: 'test-org', term: 'consumption' });
  });

  await ta('e2e: a group term cannot be redirected outside its own group', async () => {
    const terms = require('../src/terms');
    const bad = await terms.saveMapping(db, { orgId: 'test-org', term: 'consumption', metricKey: 'shaft_power' });
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.reason, 'outside_group');
  });

  await ta('e2e: forgetting a term restores the built-in behaviour', async () => {
    const terms = require('../src/terms');
    await terms.saveMapping(db, { orgId: 'test-org', term: 'juice', metricKey: 'fuel_consumption' });
    assert.strictEqual((await run('juice for Aurora Trader last month')).status, 'answer');
    await terms.forgetMapping(db, { orgId: 'test-org', term: 'juice' });
    assert.notStrictEqual((await run('juice for Aurora Trader last month')).status, 'answer');
  });

  await ta('e2e: learning never changes a stored measurement', async () => {
    const terms = require('../src/terms');
    const before = await db.query('SELECT SUM(fuel_consumed_mt)::double precision s FROM geoform_reports');
    await terms.saveMapping(db, { orgId: 'test-org', term: 'gas', metricKey: 'fuel_consumption' });
    await run('gas for Aurora Trader last month');
    const after = await db.query('SELECT SUM(fuel_consumed_mt)::double precision s FROM geoform_reports');
    assert.strictEqual(before.rows[0].s, after.rows[0].s);
    await terms.forgetMapping(db, { orgId: 'test-org', term: 'gas' });
  });

  await ta('e2e: leg fuel total matches an independent SQL sum', async () => {
    const out = await run('total leg fuel for Aurora Trader in 2026');
    const { rows } = await db.query(`SELECT SUM(fuel_mt)::double precision s, COUNT(*) c FROM veson_legs WHERE imo=$1 AND leg_date BETWEEN '2026-01-01' AND '2026-09-01'`, ['9851701']);
    assert.ok(Math.abs(out.value - rows[0].s) < 1e-6);
    assert.strictEqual(out.provenance.source, 'Veson IMOS FuelEU leg-wise report');
  });

  await ta('e2e: off-hire hours sum and name the off-hire report', async () => {
    const out = await run('off hire hours for Aurora Trader in 2026');
    assert.strictEqual(out.value, 96);
    assert.strictEqual(out.provenance.source, 'Veson IMOS FuelEU off-hire report');
  });

  await ta('e2e: leg count uses COUNT', async () => {
    const out = await run('how many legs for Aurora Trader in 2026');
    const { rows } = await db.query(`SELECT COUNT(*) c FROM veson_legs WHERE imo='9851701' AND leg_date BETWEEN '2026-01-01' AND '2026-09-01'`);
    assert.strictEqual(out.value, Number(rows[0].c));
  });

  await ta('e2e: provenance names the real source of the figure', async () => {
    const out = await run('average shaft power for Aurora Trader last month');
    assert.strictEqual(out.provenance.metric, 'Shaft power');
    assert.strictEqual(out.provenance.unit, 'kW');
    assert.deepStrictEqual(out.provenance.vessels, ['Aurora Trader']);
    assert.ok(out.provenance.sql.includes('AVG'));
  });

  await db.end();
}

// ===========================================================================

(async () => {
  await e2e();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  FAIL  ${f.name}\n        ${f.error}`);
    process.exit(1);
  }
})();