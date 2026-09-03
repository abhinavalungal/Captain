'use strict';
/**
 * Integration-layer tests. The upstream APIs cannot be reached from CI, so
 * fetch is stubbed with payloads in three DIFFERENT envelope/field styles to
 * prove the mapper and sync are shape-tolerant. Numbers are arbitrary.
 *
 *   CAPTAIN_TEST_URL='postgres://...' node test/integrations.js
 */
const assert = require('assert');
const { Client } = require('pg');
const { resolveMapping, mapRecord, deriveFuelTotal, toTime } = require('../src/integrations/mapping');
const { extractRows, vesonClient, geoformClient } = require('../src/integrations/clients');
const { sync } = require('../src/integrations/sync');

let passed = 0; const fails = [];
const t = (n, f) => { try { f(); passed++; } catch (e) { fails.push(n + ': ' + e.message); } };
const ta = async (n, f) => { try { await f(); passed++; } catch (e) { fails.push(n + ': ' + e.message); } };

const ENV = {
  VESON_API_TOKEN: 'tok', VESON_LEGWISE_API: 'https://api.example/legs', VESON_OFFHIRE_API: 'https://api.example/off',
  GEOFORM_API: 'https://geo.example/getallforms', GEOFORM_API_KEY: 'k', GEOFORM_API_KEY_HEADER: 'library-api',
  CAPTAIN_SYNC_DAYS: '40', CAPTAIN_IMOS: '',
};

// three styles: camelCase array, "Title Case" under data{}, snake_case under result.rows
const LEGS = [
  { imoNumber: 9851701, vesselName: 'Aurora Trader', voyageNo: 'V12', legNo: 1, departurePort: 'ROT', arrivalPort: 'SIN',
    departureTime: '2026-07-01T06:00:00Z', arrivalTime: '2026-07-20T18:00:00Z', distance: 8400.5, HFO_MT: 300.25, VLSFO_MT: 120, co2: 1310.7, ghgIntensity: 90.1, euScope: 50 },
  { imoNumber: 9851701, vesselName: 'Aurora Trader', voyageNo: 'V13', legNo: 1, departurePort: 'SIN', arrivalPort: 'ROT',
    departureTime: '2026-07-25T06:00:00Z', arrivalTime: '2026-08-14T18:00:00Z', distance: 8390, HFO_MT: 280, VLSFO_MT: 130, co2: 1280, ghgIntensity: 89.4, euScope: 50 },
];
const OFF = { data: [
  { 'IMO Number': '9851701', 'Vessel Name': 'Aurora Trader', 'Start': '15/07/2026 08:00', 'End': '16/07/2026 20:00', 'Reason': 'Weather' },
]};
const FORMS = { result: { rows: [
  { imo: '9851701', form_type: 'Noon Report', report_date: '2026-08-10 12:00', shaft_power: '9120.5', total_consumption: 41.2, me_consumption: 35.1, ae_consumption: 6.1, distance: 318, speed: '13.2', rpm: 77 },
  { imo: '9851701', form_type: 'Noon Report', report_date: '2026-08-11 12:00', shaft_power: '9210.0', total_consumption: 42.0, me_consumption: 35.8, ae_consumption: 6.2, distance: 322, speed: '13.4', rpm: 78 },
]}};

const calls = [];
const fetchStub = async (url, init) => {
  calls.push({ url, headers: init.headers });
  const body = url.startsWith(ENV.VESON_LEGWISE_API) ? LEGS : url.startsWith(ENV.VESON_OFFHIRE_API) ? OFF
    : url.startsWith(ENV.GEOFORM_API) ? FORMS : null;
  if (!body) return { ok: false, status: 404, text: async () => 'nope' };
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
};

// --- mapping ---------------------------------------------------------------------
t('mapping: camelCase leg fields resolve', () => {
  const r = resolveMapping('veson_legs', LEGS[0]);
  assert.strictEqual(r.map.imo, 'imoNumber');
  assert.strictEqual(r.map.dep_time, 'departureTime');
  assert.strictEqual(r.map.co2_mt, 'co2');
  assert.ok(r.unmatchedTargets.includes('fuel_mt'), 'no total-fuel column in this shape');
});
t('mapping: per-fuel columns are summed when no total exists, and flagged', () => {
  const d = deriveFuelTotal(LEGS[0]);
  assert.strictEqual(d.value, 420.25);
  assert.strictEqual(d.fromFields, 2);
});
t('mapping: "Title Case" off-hire fields resolve', () => {
  const r = resolveMapping('veson_offhire', OFF.data[0]);
  assert.strictEqual(r.map.imo, 'IMO Number');
  assert.strictEqual(r.map.start_time, 'Start');
  assert.strictEqual(r.map.reason, 'Reason');
});
t('mapping: snake_case Geoform fields resolve and strings coerce to numbers', () => {
  const r = resolveMapping('geoform_reports', FORMS.result.rows[0]);
  const row = mapRecord('geoform_reports', FORMS.result.rows[0], r);
  assert.strictEqual(row.shaft_power_kw, 9120.5);
  assert.strictEqual(row.speed_kn, 13.2);
  assert.strictEqual(row.form_type, 'Noon Report');
});
t('mapping: unmapped upstream fields are reported, not lost', () => {
  const r = resolveMapping('veson_legs', LEGS[0]);
  assert.ok(r.unmappedSource.includes('HFO_MT'));
});
t('mapping: override wins', () => {
  const r = resolveMapping('veson_legs', LEGS[0], { fuel_mt: 'HFO_MT' });
  assert.strictEqual(r.map.fuel_mt, 'HFO_MT');
});
t('mapping: DD/MM/YYYY HH:mm parses as UTC, never guesses', () => {
  assert.strictEqual(toTime('15/07/2026 08:00').toISOString(), '2026-07-15T08:00:00.000Z');
  assert.strictEqual(toTime('/Date(1785715200000)/').getTime(), 1785715200000);
  assert.strictEqual(toTime('not a date'), null);
});
t('envelope: bare array, data{}, and result.rows all yield rows', () => {
  assert.strictEqual(extractRows(LEGS).length, 2);
  assert.strictEqual(extractRows(OFF).length, 1);
  assert.strictEqual(extractRows(FORMS).length, 2);
});
t('envelope: several arrays is refused, not guessed', () => {
  assert.throws(() => extractRows({ a: [1], b: [2] }, 'x'), /ambiguous/);
});
t('clients: token is appended to Veson URLs and never duplicated', async () => {});

(async () => {
  await ta('clients: Veson URL carries the token once; Geoform sends the key header', async () => {
    calls.length = 0;
    await vesonClient(ENV, fetchStub).legWise();
    assert.strictEqual((calls[0].url.match(/apiToken=/g) || []).length, 1);
    const baked = Object.assign({}, ENV, { VESON_LEGWISE_API: ENV.VESON_LEGWISE_API + '?apiToken=tok' });
    await vesonClient(baked, fetchStub).legWise();
    assert.strictEqual((calls[1].url.match(/apiToken=/g) || []).length, 1, 'must not double-append');
    await geoformClient(ENV, fetchStub).forms('9851701', '2026-08-01', '2026-08-31');
    assert.strictEqual(calls[2].headers['library-api'], 'k');
    assert.ok(/imo=9851701&fromDate=2026-08-01&toDate=2026-08-31/.test(calls[2].url));
  });

  await ta('clients: non-2xx becomes a typed error with no token in the message', async () => {
    const bad = Object.assign({}, ENV, { VESON_LEGWISE_API: 'https://api.example/missing' });
    await assert.rejects(vesonClient(bad, fetchStub).legWise(), (e) => e.name === 'Error' && /failed \(404\)/.test(e.message) && !/tok/.test(e.message.replace(/tok\b/, '')) );
  });

  if (!process.env.CAPTAIN_TEST_URL) { finish(); return; }
  const db = new Client({ connectionString: process.env.CAPTAIN_TEST_URL });
  await db.connect();
  await db.query("DELETE FROM veson_legs WHERE voyage_no IN ('V12','V13'); DELETE FROM veson_offhire WHERE reason='Weather'; DELETE FROM geoform_reports WHERE form_type='Noon Report';");

  await ta('sync: pulls all three sources into Postgres and reports the mapping', async () => {
    const stats = await sync({ db, env: ENV, fetchImpl: fetchStub, now: new Date('2026-09-02T10:00:00Z') });
    assert.strictEqual(stats.legs, 2);
    assert.strictEqual(stats.offhire, 1);
    assert.ok(stats.geoform >= 2);
    assert.ok(stats.mappings.veson_legs.map.imo === 'imoNumber');
    const { rows } = await db.query("SELECT fuel_mt, fuel_derived, leg_date FROM veson_legs WHERE voyage_no='V12'");
    assert.strictEqual(rows[0].fuel_mt, 420.25);
    assert.strictEqual(rows[0].fuel_derived, true);
    assert.strictEqual(rows[0].leg_date.toISOString().slice(0, 10), '2026-07-20');
  });
  await ta('sync: off-hire hours derived from start/end when the API gives none', async () => {
    const { rows } = await db.query("SELECT offhire_hours, offhire_days FROM veson_offhire WHERE reason='Weather'");
    assert.strictEqual(rows[0].offhire_hours, 36);
    assert.strictEqual(rows[0].offhire_days, 1.5);
  });
  await ta('sync: re-running is idempotent', async () => {
    const before = await db.query("SELECT count(*) c FROM veson_legs WHERE voyage_no IN ('V12','V13')");
    await sync({ db, env: ENV, fetchImpl: fetchStub, now: new Date('2026-09-02T10:00:00Z') });
    const after = await db.query("SELECT count(*) c FROM veson_legs WHERE voyage_no IN ('V12','V13')");
    assert.strictEqual(before.rows[0].c, after.rows[0].c);
  });
  await ta('sync: synced rows are answerable by the engine with correct provenance', async () => {
    const engine = require('../src/engine');
    const out = await engine.ask({ text: 'leg fuel for Aurora Trader in July 2026', session: { userId: 'u', orgId: 'o', vesselIds: ['9851701'] }, now: new Date('2026-09-02T10:00:00Z') }, db, {});
    assert.strictEqual(out.status, 'answer');
    const { rows } = await db.query("SELECT SUM(fuel_mt)::double precision s FROM veson_legs WHERE imo='9851701' AND leg_date BETWEEN '2026-07-01' AND '2026-07-31'");
    assert.ok(Math.abs(out.value - rows[0].s) < 1e-9);
  });
  await ta('sync: a Geoform failure for one IMO is a warning, not an abort', async () => {
    const flaky = async (url, init) => url.startsWith(ENV.GEOFORM_API) ? { ok: false, status: 500, text: async () => 'boom' } : fetchStub(url, init);
    const stats = await sync({ db, env: ENV, fetchImpl: flaky, now: new Date('2026-09-02T10:00:00Z') });
    assert.strictEqual(stats.legs, 2);
    assert.ok(stats.warnings.some((w) => /Geoform 9851701/.test(w)));
  });
  await db.query("DELETE FROM veson_legs WHERE voyage_no IN ('V12','V13'); DELETE FROM veson_offhire WHERE reason='Weather'; DELETE FROM geoform_reports WHERE form_type='Noon Report';");
  await db.end();
  finish();
})();

function finish() {
  console.log(`\nIntegrations: ${passed} passed, ${fails.length} failed`);
  fails.forEach((f) => console.log('  FAIL ' + f));
  process.exit(fails.length ? 1 : 0);
}
