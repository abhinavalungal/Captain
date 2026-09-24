'use strict';
/**
 * The database, end to end, with no server to install: db/001_schema.sql and
 * the test data are loaded into an in-memory Postgres (PGlite), then checked
 * structurally, for security, for consistency, and through K.R.1.S's own code
 * — the engine, the records tool, the briefing and the router.
 *
 *   node test/db_test.js
 */
const assert = require('assert');
const { PGlite } = require('@electric-sql/pglite');
const setup = require('../db/setup');
const rbac = require('../src/rbac');
const records = require('../src/records');
const engine = require('../src/engine');
const router = require('../src/router');
const { buildBriefing } = require('../src/alerts');

let passed = 0; const fails = [];
const ta = async (n, f) => { try { await f(); passed++; } catch (e) { fails.push(n + ': ' + e.message); } };

const UNTIL = '2026-09-24T12:00:00Z';
const NOW = new Date(UNTIL);
const [TV01, TV02] = setup.TEST_IDS;
const session = { userId: 'u', orgId: 'o', vesselIds: setup.TEST_IDS };
const ENV = { KRIS_MODE: 'agent', KRIS_LLM_URL: 'https://openrouter.ai/api', KRIS_LLM_MODEL: 'test/model', KRIS_LLM_API_KEY: 'sk-test' };

function scripted(script) {
  const seen = [];
  const impl = async (url, init) => {
    seen.push(JSON.parse(init.body));
    const msg = script[Math.min(seen.length - 1, script.length - 1)];
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: msg }] }), text: async () => '' };
  };
  impl.seen = seen;
  return impl;
}
const say = (content) => ({ role: 'assistant', content });
const tool = (name, args) => ({ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const lastToolResult = (seen) => {
  const msgs = seen[seen.length - 1].messages;
  return JSON.parse(msgs.filter((m) => m.role === 'tool').pop().content);
};

(async () => {
  const db = new PGlite();
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

  await ta('schema loads, and loads again (idempotent)', async () => {
    await setup.applySchema(db);
    await setup.applySchema(db);
  });
  await ta('test data loads, and reloads cleanly', async () => {
    await setup.seedTestData(db, UNTIL);
    await setup.seedTestData(db, UNTIL);
    assert.strictEqual(Number((await one('SELECT count(*) AS n FROM kris.vessels WHERE is_test')).n), 2);
  });
  await ta('every structural, security and consistency check passes', async () => {
    const results = await setup.verify(db);
    const bad = results.filter((r) => !r.ok);
    assert.deepStrictEqual(bad, [], JSON.stringify(bad));
    assert.ok(results.length >= 18, 'checks ran: ' + results.length);
  });

  // --- security ---------------------------------------------------------------
  await ta('kris_reader reads the views and cannot write', async () => {
    await db.exec('SET ROLE kris_reader');
    try {
      assert.ok(Number((await one('SELECT count(*) AS n FROM kris.voyage_summary')).n) > 100);
      await assert.rejects(db.query("INSERT INTO kris.kris_query_log (question, outcome) VALUES ('x', 'y')"), /permission denied/);
      await assert.rejects(db.query('DELETE FROM kris.voyages'), /permission denied/);
    } finally { await db.exec('RESET ROLE'); }
  });
  await ta('row-level security: a role granted SELECT but given no policy sees no rows', async () => {
    await db.exec(`CREATE ROLE probe NOLOGIN; GRANT USAGE ON SCHEMA kris TO probe; GRANT SELECT ON kris.vessels, kris.invoices TO probe;`);
    await db.exec('SET ROLE probe');
    try {
      assert.strictEqual(Number((await one('SELECT count(*) AS n FROM kris.vessels')).n), 0);
      assert.strictEqual(Number((await one('SELECT count(*) AS n FROM kris.invoices')).n), 0);
    } finally { await db.exec('RESET ROLE'); }
  });

  // --- derived figures behave as designed ---------------------------------------
  await ta('CII: TEST VESSEL 01 rated D three years running needs a corrective plan; TEST VESSEL 02 rated A', async () => {
    const r = (await db.query('SELECT vessel_id, year, rating, status, aer, attained_cii FROM kris.cii_annual WHERE year BETWEEN 2023 AND 2025 ORDER BY 1, 2')).rows;
    assert.deepStrictEqual(r.filter((x) => x.vessel_id === TV01).map((x) => x.rating), ['D', 'D', 'D']);
    assert.ok(/corrective action plan/.test(r.find((x) => x.vessel_id === TV01 && x.year === 2025).status));
    assert.deepStrictEqual(r.filter((x) => x.vessel_id === TV02).map((x) => x.rating), ['A', 'A', 'A']);
    // Bulk carrier: attained CII is the AER.
    for (const x of r.filter((y) => y.vessel_id === TV01)) assert.strictEqual(x.aer, x.attained_cii);
  });
  await ta('FuelEU 2025: the deficit is pooled away, the pool balances, no penalty', async () => {
    const r = (await db.query("SELECT vessel_id, compliance_balance_t, final_balance_t, penalty_eur, penalty_before_flexibility_eur, status FROM kris.fueleu_period WHERE year = 2025 AND period = 'YEAR' ORDER BY 1")).rows;
    const a = r.find((x) => x.vessel_id === TV01); const b = r.find((x) => x.vessel_id === TV02);
    assert.ok(Number(a.compliance_balance_t) < 0 && Number(a.final_balance_t) >= 0, JSON.stringify(a));
    assert.strictEqual(Number(a.penalty_eur), 0);
    assert.ok(Number(a.penalty_before_flexibility_eur) > 0);
    assert.ok(/pooling/.test(a.status));
    assert.ok(Number(b.compliance_balance_t) > 0 && /surplus/.test(b.status));
  });
  await ta('quarters add up to the year', async () => {
    const r = await one(`SELECT SUM(compliance_balance_g) FILTER (WHERE period <> 'YEAR') AS q, SUM(compliance_balance_g) FILTER (WHERE period = 'YEAR') AS y
                           FROM kris.fueleu_period WHERE vessel_id = $1 AND year = 2025`, [TV02]);
    assert.ok(Math.abs(Number(r.q) - Number(r.y)) <= 4, `${r.q} vs ${r.y}`);
  });
  await ta('voyage totals equal the reports they are made of', async () => {
    const r = await one(`SELECT (SELECT SUM(fuel_t) FROM kris.voyage_summary WHERE vessel_id = $1) AS voyages,
                                (SELECT SUM(fuel_consumed_mt) FROM kris.geoform_reports WHERE imo = $1) AS reports`, [TV01]);
    assert.ok(Math.abs(Number(r.voyages) - Number(r.reports)) < 0.5, `${r.voyages} vs ${r.reports}`);
  });
  await ta('UK ETS starts with the Immingham-Teesport voyage of August 2026', async () => {
    const r = await one("SELECT allowances_required, allocations_confirmed FROM kris.ets_obligations WHERE vessel_id = $1 AND scheme = 'UK_ETS' AND year = 2026", [TV01]);
    assert.ok(r && Number(r.allowances_required) > 0, 'no UK ETS obligation');
    assert.ok(Number(r.allocations_confirmed) >= Number(r.allowances_required));
  });

  // --- through K.R.1.S -----------------------------------------------------------
  const scope = await rbac.resolveScope(session, db);
  await ta('access control finds both vessels by the new register', async () => {
    assert.deepStrictEqual(scope.vessels.map((v) => v.name), ['TEST VESSEL 01', 'TEST VESSEL 02']);
    assert.ok(scope.vessels[0].altNames.includes('TV01'), 'vessel code is an alternative name');
  });
  await ta('every records topic returns rows', async () => {
    for (const topic of records.TOPICS) {
      const out = await records.lookup(db, scope, { topic, limit: 2 });
      assert.ok(!out.error && out.row_count > 0, `${topic}: ${out.error || 'no rows'}`);
    }
  });
  await ta('records: a vessel can be named by name, number, code or IMO; nothing outside the scope', async () => {
    for (const name of ['TEST VESSEL 01', 'test vessel 1', 'TV01', '1000019']) {
      const out = await records.lookup(db, scope, { topic: 'vessels', vessel: name });
      assert.deepStrictEqual(out.rows.map((r) => r.imo), [TV01], name);
    }
    const other = await records.lookup(db, { vessels: [scope.vessels[1]] }, { topic: 'vessels', vessel: 'TEST VESSEL 01' });
    assert.ok(other.error && !other.rows, 'a vessel outside the scope must not be found');
  });
  await ta('records: latest voyage, its ports and days', async () => {
    const out = await records.lookup(db, scope, { topic: 'voyages', vessel: 'TEST VESSEL 01', latest: true });
    assert.strictEqual(out.row_count, 1);
    const v = out.rows[0];
    assert.ok(v.from_port_name && v.to_port_name && v.departure_at && v.status, JSON.stringify(v));
    const prev = await records.lookup(db, scope, { topic: 'voyages', vessel: 'TV01', limit: 2 });
    assert.strictEqual(prev.rows[1].to_port, v.from_port, 'the latest voyage starts where the previous one ended');
    const done = prev.rows[1];
    assert.ok(Math.abs(done.total_days - (done.sea_days + done.port_days)) < 0.02 && Math.abs(done.net_days - (done.total_days - (done.offhire_days || 0))) < 0.02);
  });
  await ta('records: filters and years are bound, undeclared filters ignored', async () => {
    const mrv = await records.lookup(db, scope, { topic: 'compliance', vessel: 'TV01', year: 2025, filter: { regime: 'EU_MRV' } });
    assert.strictEqual(mrv.row_count, 1);
    assert.strictEqual(mrv.rows[0].verification_status, 'in_review');
    const evil = await records.lookup(db, scope, { topic: 'invoices', filter: { "status' OR 1=1 --": 'x', status: "' OR ''='" } });
    assert.strictEqual(evil.row_count, 0, 'a filter value is data, never SQL');
    const built = records.build('invoices', { vesselIds: ['1'], filter: { nope: 'x' } });
    assert.ok(!/nope/.test(built.text), 'undeclared filter columns never reach SQL');
  });
  await ta('engine: a figure over a period matches an independent SQL sum', async () => {
    const out = await engine.ask({ text: 'fuel consumption for TEST VESSEL 01 last month', session, now: NOW }, db, { orgId: 'o', disableLog: true });
    assert.strictEqual(out.status, 'answer', out.text);
    const r = await one("SELECT SUM(fuel_consumed_mt) AS s FROM kris.geoform_reports WHERE imo = $1 AND report_date BETWEEN '2026-08-01' AND '2026-08-31'", [TV01]);
    assert.ok(Math.abs(out.value - Number(r.s)) < 0.01, `${out.value} vs ${r.s}`);
  });
  await ta('engine: VLSFO for a year reads the voyage summary', async () => {
    const out = await engine.ask({ text: 'VLSFO consumption for TEST VESSEL 02 in 2025', session, now: NOW }, db, { orgId: 'o', disableLog: true });
    assert.strictEqual(out.status, 'answer', out.text);
    const r = await one("SELECT SUM(vlsfo_t) AS s FROM kris.voyage_summary WHERE vessel_id = $1 AND departure_at >= '2025-01-01' AND departure_at < '2026-01-01'", [TV02]);
    assert.ok(Math.abs(out.value - Number(r.s)) < 0.01, `${out.value} vs ${r.s}`);
  });
  await ta('briefing runs every rule against the new schema', async () => {
    const b = await buildBriefing(setup.TEST_IDS, ['TEST VESSEL 01', 'TEST VESSEL 02'], db);
    assert.ok(!b.degraded, 'a briefing rule failed: ' + b.text);
  });

  await ta('setup: role connection strings follow the admin URL; placeholders are never kept', async () => {
    const pooler = 'postgresql://postgres.rpiuxplctquqwqvmgxqk:secret@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres';
    const url = setup.roleUrl(pooler, 'kris_reader', 'p@ss/word');
    assert.strictEqual(url, 'postgresql://kris_reader.rpiuxplctquqwqvmgxqk:p%40ss%2Fword@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres');
    assert.strictEqual(setup.existingPassword(url, 'kris_reader', pooler), 'p@ss/word');
    const direct = 'postgresql://postgres:secret@db.rpiuxplctquqwqvmgxqk.supabase.co:5432/postgres';
    assert.ok(setup.roleUrl(direct, 'kris_writer', 'x').startsWith('postgresql://kris_writer:x@db.'));
    assert.strictEqual(setup.existingPassword('postgresql://kris_reader:[YOUR-PASSWORD]@db.rpiuxplctquqwqvmgxqk.supabase.co:5432/postgres', 'kris_reader', direct), null);
    assert.strictEqual(setup.existingPassword(url, 'kris_reader', direct), null, 'a password for another host is not reused');
  });

  // --- the router with a scripted model: questions from the brief -------------------
  const route = (text, script) => {
    const fetchImpl = scripted(script);
    return router.route({ text, session, now: NOW, history: [], context: {} }, async () => db,
      { orgId: 'o', env: ENV, fetchImpl, disableLog: true }).then((out) => ({ out, seen: fetchImpl.seen }));
  };
  await ta('"Give me the details of TEST VESSEL 01." is answered from the particulars', async () => {
    const { out, seen } = await route('Give me the details of TEST VESSEL 01.', [
      tool('get_vessel_records', { topic: 'vessels', vessel: 'TEST VESSEL 01' }),
      say('TEST VESSEL 01 (IMO 1000019) is a 63,520 DWT Ultramax bulk carrier built in 2016.'),
    ]);
    const res = lastToolResult(seen);
    assert.strictEqual(res.rows[0].imo, TV01);
    assert.strictEqual(res.rows[0].deadweight_t, 63520);
    assert.ok(/63,520 DWT/.test(out.text) && !out.blocked, 'a figure read from the records is not blocked: ' + out.text);
    assert.strictEqual(out.footnote, 'From the records: Vessel particulars');
  });
  await ta('"What is the FuelEU compliance balance?" reaches the model with the pooled balance', async () => {
    const { out, seen } = await route('What is the FuelEU compliance balance for TEST VESSEL 01?', [
      tool('get_vessel_records', { topic: 'fueleu', vessel: 'TEST VESSEL 01', year: 2025, filter: { period: 'YEAR' } }),
      say('ok'),
    ]);
    assert.strictEqual(out.source, 'agent');
    const row = lastToolResult(seen).rows[0];
    assert.ok(/pooling/.test(row.status) && row.penalty_eur === 0 && row.pool_id === 'TEST-POOL-2025', JSON.stringify(row));
  });
  await ta('"How much VLSFO did TEST VESSEL 01 consume?" (no period) goes to the model, not "over what period?"', async () => {
    const { out } = await route('How much VLSFO did TEST VESSEL 01 consume?', [
      tool('get_vessel_records', { topic: 'annual', vessel: 'TEST VESSEL 01' }), say('By year: ...'),
    ]);
    assert.strictEqual(out.source, 'agent');
    assert.notStrictEqual(out.status, 'clarify');
  });
  await ta('a complete figure question is answered by the engine with no model call', async () => {
    const { out, seen } = await route('CO2 emissions for TEST VESSEL 02 last month', [say('unused')]);
    assert.strictEqual(out.status, 'answer', out.text);
    assert.strictEqual(seen.length, 0);
  });

  console.log(`\nDatabase: ${passed} passed, ${fails.length} failed`);
  fails.forEach((f) => console.log('  FAIL ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
