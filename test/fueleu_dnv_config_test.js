'use strict';
// Proves the SQL Captain would run against fueleu_final/dnv is well-formed —
// correct identifiers, correct quoting, correct params — WITHOUT a live
// connection. Every identifier here is checked against the exact DDL Nav sent.
const assert = require('assert');
const sql = require('../src/sql');
const { METRICS_BY_KEY, SOURCES, validateConfig } = require('../src/config');

const range = { startDate: '2026-08-01', endDate: '2026-08-31', startISO: '2026-08-01T00:00:00.000Z', endExclusiveISO: '2026-09-01T00:00:00.000Z' };
const vesselIds = ['9123456'];

function check(key, expectCols) {
  const metric = METRICS_BY_KEY[key];
  const built = sql.build({ metricKey: key, intent: 'value', range, limit: 500 }, vesselIds);
  const text = built.text;
  assert.ok(/FROM\s+"captain_(fueleu_final|dnv)"/.test(text), key + ' wrong table: ' + text);
  for (const col of expectCols) {
    assert.ok(text.includes('"' + col + '"'), key + ' missing quoted column ' + col + ' in:\n' + text);
  }
  assert.ok(text.includes('"imo"'), key + ' missing vessel column');
  assert.ok(/\$1|\$2|\$3/.test(text), key + ' missing bound params');
  assert.ok(!/9123456/.test(text), key + ' vessel id leaked into SQL text instead of a param');
  console.log('OK', key, '->', text.replace(/\s+/g, ' ').trim());
}

check('gross_cb', ['gross_cb']);
check('cb_at_start', ['cb_at_start']);
check('voyage_gross_days', ['voyage_gross_days']);
check('fueleu_offhire_gross_days', ['offhire_gross_days']);
check('net_gross_days', ['net_gross_days']);
check('dnv_compliance_balance', ['compliance_balance']);
check('fueleu_penalty', ['fueleu_penalty']);
check('fueleu_energy', ['fueleu_energy']);
check('actual_ghg', ['actual_ghg']);

// timeColumn types are right: fueleu_final uses timestamptz (VoyageStart is
// tz-aware), dnv uses date (reallocation_period_start is a bare date).
const b1 = sql.build({ metricKey: 'gross_cb', intent: 'value', range, limit: 500 }, vesselIds);
assert.ok(/"voyage_start"[\s\S]*::timestamptz/.test(b1.text), 'fueleu_final should filter as timestamptz');
const b2 = sql.build({ metricKey: 'dnv_compliance_balance', intent: 'value', range, limit: 500 }, vesselIds);
assert.ok(/"reallocation_period_start"[\s\S]*::date/.test(b2.text), 'dnv should filter as date');

// Config-level sanity beyond SQL text: exactly what config.js declares.
assert.strictEqual(SOURCES.captain_fueleu_final.table, 'captain_fueleu_final');
assert.strictEqual(SOURCES.captain_fueleu_final.vesselColumn, 'imo');
assert.strictEqual(SOURCES.captain_fueleu_final.timeColumn, 'voyage_start');
assert.strictEqual(SOURCES.captain_fueleu_final.timeColumnType, 'timestamptz');
assert.strictEqual(SOURCES.captain_dnv.table, 'captain_dnv');
assert.strictEqual(SOURCES.captain_dnv.timeColumn, 'reallocation_period_start');
assert.strictEqual(SOURCES.captain_dnv.timeColumnType, 'date');
assert.strictEqual(validateConfig(), true, 'full config must still validate with the new sources/metrics');

// Every new metric's unit is still flagged unconfirmed — this is a canary:
// if someone "fixes" the unit without telling Nav, or ships this without the
// flag ever being resolved, this test's *point* is to make that visible.
const unconfirmed = ['gross_cb', 'cb_at_start', 'dnv_compliance_balance', 'fueleu_penalty', 'fueleu_energy', 'actual_ghg'];
for (const k of unconfirmed) {
  assert.ok(/UNCONFIRMED/.test(METRICS_BY_KEY[k].unit), k + ' lost its unconfirmed-unit flag');
}

console.log('\nfueleu/dnv config: all passed — SQL is well-formed; units remain flagged until confirmed');
