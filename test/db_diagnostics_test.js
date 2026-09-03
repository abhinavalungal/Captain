'use strict';
/**
 * Database failures must say WHY, without leaking secrets. Offline.
 *   node test/db_diagnostics_test.js
 */
const assert = require('assert');
const { classifyDbError, handleCaptain, health } = require('../src/httpHandler');
const router = require('../src/router');

let passed = 0; const fails = [];
const t = (n, f) => { try { f(); passed++; } catch (e) { fails.push(n + ': ' + e.message); } };
const ta = async (n, f) => { try { await f(); passed++; } catch (e) { fails.push(n + ': ' + e.message); } };
const E = (message, code) => Object.assign(new Error(message), code ? { code } : {});

t('wrong / placeholder password -> DB_AUTH with the fix named', () => {
  const d = classifyDbError(E('password authentication failed for user "postgres.abc"', '28P01'));
  assert.strictEqual(d.code, 'DB_AUTH');
  assert.ok(/YOUR-PASSWORD/.test(d.hint) && /%40/.test(d.hint));
});
t('pooler tenant error -> DB_TENANT (username must be postgres.<ref>)', () => {
  assert.strictEqual(classifyDbError(E('Tenant or user not found')).code, 'DB_TENANT');
});
t('IPv6-only direct host -> DB_NO_ROUTE naming the pooler host', () => {
  const d = classifyDbError(E('connect ENETUNREACH 2a05::1:5432', 'ENETUNREACH'));
  assert.strictEqual(d.code, 'DB_NO_ROUTE');
  assert.ok(/pooler\.supabase\.com/.test(d.hint));
});
t('connect timeout -> DB_TIMEOUT', () => {
  assert.strictEqual(classifyDbError(E('Connection terminated due to connection timeout')).code, 'DB_TIMEOUT');
});
t('DNS failure -> DB_DNS', () => {
  assert.strictEqual(classifyDbError(E('getaddrinfo ENOTFOUND db.x.supabase.co', 'ENOTFOUND')).code, 'DB_DNS');
});
t('pooler rejecting a startup parameter -> DB_POOLER_PARAM', () => {
  assert.strictEqual(classifyDbError(E('unsupported startup parameter in options: statement_timeout')).code, 'DB_POOLER_PARAM');
});
t('unknown error: message sanitised, no URL, nothing after "password"', () => {
  const d = classifyDbError(E('failed at https://secret.host/x with password=hunter2 and more'));
  assert.ok(!/hunter2/.test(d.hint), d.hint);
  assert.ok(!/secret\.host/.test(d.hint), d.hint);
});

t('pool config uses client-side query_timeout, never the statement_timeout startup param', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'httpHandler.js'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(/query_timeout:/.test(code));
  assert.ok(!/statement_timeout:/.test(code), 'statement_timeout must not be a Pool option');
});

// End to end: a data question against a database whose connect() fails with a
// classified error surfaces the code + hint, and the raw message never appears.
const failingDb = async () => { throw Object.assign(new Error('password authentication failed for user "postgres"'), { code: '28P01', captainCode: 'DB_AUTH', captainHint: 'hint text' }); };
ta('withDb reply carries code + detail from the classified connection error', async () => {
  const out = await router.route(
    { text: 'fueleu penalty for STI ROTHERHITHE this year', session: { userId: 'u', orgId: 'o', vesselIds: ['v1'] }, now: new Date(), history: [], context: {} },
    failingDb, { orgId: 'o', env: { CAPTAIN_ENABLE_LLM: '0' } }
  );
  assert.strictEqual(out.reason, 'db_unreachable');
  assert.strictEqual(out.code, 'DB_AUTH');
  assert.strictEqual(out.detail, 'hint text');
  assert.ok(!/authentication failed/.test(JSON.stringify(out)));
});
ta('a missing view is named so the operator knows which migration to run', async () => {
  const client = { query: async () => { throw Object.assign(new Error('relation "captain_dnv" does not exist'), { code: '42P01' }); } };
  const out = await router.route(
    { text: 'fueleu penalty for STI ROTHERHITHE this year', session: { userId: 'u', orgId: 'o', vesselIds: ['v1'] }, now: new Date(), history: [], context: {} },
    async () => client, { orgId: 'o', env: { CAPTAIN_ENABLE_LLM: '0' } }
  );
  assert.strictEqual(out.reason, 'query_failed');
  assert.strictEqual(out.code, 'PG_42P01');
  assert.ok(/captain_dnv/.test(out.detail));
});
ta('CAPTAIN_DIAGNOSTICS=0 hides code/detail from the client but keeps the build', async () => {
  // Drive through the HTTP layer with the router monkeypatched to return a classified error.
  const orig = router.route;
  router.route = async () => ({ status: 'error', source: 'router', reason: 'db_unreachable', text: 'x', code: 'DB_AUTH', detail: 'hint' });
  try {
    const token = Buffer.from(JSON.stringify({ sub: 'n' })).toString('base64');
    const on = JSON.parse((await handleCaptain({ method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify({ text: 'q' }), env: { CAPTAIN_DEV_SESSION: '1' } })).body);
    assert.strictEqual(on.code, 'DB_AUTH'); assert.strictEqual(on.detail, 'hint'); assert.ok(on.build);
    const off = JSON.parse((await handleCaptain({ method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify({ text: 'q' }), env: { CAPTAIN_DEV_SESSION: '1', CAPTAIN_DIAGNOSTICS: '0' } })).body);
    assert.strictEqual(off.code, undefined); assert.strictEqual(off.detail, undefined); assert.ok(off.build);
  } finally { router.route = orig; }
});
t('health reports per-file builds', () => {
  const b = health({}).builds;
  assert.ok(b.httpHandler && b.router && b.agent, JSON.stringify(b));
});

(async () => {
  await new Promise((r) => setTimeout(r, 50));
  console.log(`\nDB diagnostics: ${passed} passed, ${fails.length} failed`);
  fails.forEach((f) => console.log('  FAIL ' + f));
  process.exit(fails.length ? 1 : 0);
})();