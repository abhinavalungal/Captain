'use strict';
/**
 * Sign-in refusals and settings that were not renamed. No database, no model.
 *
 *   node test/auth_test.js
 */
const assert = require('assert');
const { handleKris, health } = require('../src/httpHandler');
const { findRenames } = require('../src/envcheck');

let passed = 0; const fails = [];
const ta = async (n, f) => { try { await f(); passed++; } catch (e) { fails.push(n + ': ' + e.message); } };
const t = (n, f) => { try { f(); passed++; } catch (e) { fails.push(n + ': ' + e.message); } };

const devToken = Buffer.from(JSON.stringify({ sub: 'u', org: 'o', departments: ['Emission'] })).toString('base64');
const ask = (env, body, headers) => handleKris({ method: 'POST', headers: Object.assign({ 'content-type': 'text/plain' }, headers || {}), body: JSON.stringify(body), env });
// A host that still carries a whole family of settings under an older prefix.
const LEGACY = { OLDAPP_READ_URL: 'postgres://x', OLDAPP_DEV_SESSION: '1', OLDAPP_LLM_API_KEY: 'secret-value', OLDAPP_MODE: 'agent', RENDER_GIT_BRANCH: 'main' };

(async () => {
  t('envcheck: a family of settings under another prefix is reported, names only', () => {
    const r = findRenames(LEGACY);
    assert.deepStrictEqual(r.map((x) => x.to), ['KRIS_DEV_SESSION', 'KRIS_LLM_API_KEY', 'KRIS_MODE', 'KRIS_READ_URL']);
    assert.ok(r.every((x) => x.from.startsWith('OLDAPP_')));
    assert.ok(!JSON.stringify(r).includes('secret-value'), 'a value leaked');
  });
  t('envcheck: unrelated variables and already-renamed settings are left alone', () => {
    assert.deepStrictEqual(findRenames({ DEBUG_MODE: '1', APP_NAME: 'x', RENDER_SERVICE_ID: 'y', VESON_API_TOKEN: 't', GEOFORM_API_KEY: 'k' }), []);
    const r = findRenames(Object.assign({ KRIS_READ_URL: 'postgres://y' }, LEGACY));
    assert.ok(!r.some((x) => x.to === 'KRIS_READ_URL'));
  });
  t('health: lists settings that need renaming', () => {
    const h = health(LEGACY);
    assert.deepStrictEqual(h.renameNeeded, ['OLDAPP_DEV_SESSION -> KRIS_DEV_SESSION', 'OLDAPP_LLM_API_KEY -> KRIS_LLM_API_KEY', 'OLDAPP_MODE -> KRIS_MODE', 'OLDAPP_READ_URL -> KRIS_READ_URL']);
    assert.strictEqual(h.auth, 'production');
    assert.deepStrictEqual(health({ KRIS_DEV_SESSION: '1' }).renameNeeded, []);
  });

  await ta('401: no token at all asks the user to sign in', async () => {
    const r = await ask({}, { text: 'fuel consumption last month' });
    assert.strictEqual(r.statusCode, 401);
    const b = JSON.parse(r.body);
    assert.strictEqual(b.reason, 'no_token');
    assert.ok(/Sign in/.test(b.text));
  });
  await ta('401: a token on a server with no sign-in set up says so, and never "expired"', async () => {
    const r = await ask({}, { text: 'fuel consumption last month', token: devToken });
    assert.strictEqual(r.statusCode, 401);
    const b = JSON.parse(r.body);
    assert.strictEqual(b.reason, 'auth_not_configured');
    assert.ok(/sign-in isn’t set up on this server/.test(b.text), b.text);
    assert.ok(!/expired/i.test(b.text));
    assert.ok(/KRIS_DEV_SESSION/.test(b.detail), 'no hint for whoever runs the server');
  });
  await ta('401: when settings were not renamed, the hint names exactly which', async () => {
    const r = await ask(LEGACY, { text: 'fuel consumption last month', token: devToken });
    const b = JSON.parse(r.body);
    assert.strictEqual(b.reason, 'auth_not_configured');
    assert.ok(/OLDAPP_DEV_SESSION → KRIS_DEV_SESSION/.test(b.detail), b.detail);
    assert.ok(!r.body.includes('secret-value'), 'a value leaked');
  });
  await ta('401: diagnostics off keeps the hint out of the reply', async () => {
    const r = await ask({ KRIS_DIAGNOSTICS: '0' }, { text: 'fuel', token: devToken });
    assert.strictEqual(JSON.parse(r.body).detail, undefined);
  });
  await ta('prototype sign-in accepts the dev token (no 401)', async () => {
    const r = await ask({ KRIS_DEV_SESSION: '1', KRIS_ENABLE_LLM: '0' }, { text: 'hi', token: devToken });
    assert.notStrictEqual(r.statusCode, 401, r.body);
  });
  await ta('vessel list for the picker: needs sign-in; without a database it says so and offers nothing', async () => {
    assert.strictEqual((await ask({}, { action: 'vessels' })).statusCode, 401);
    const r = await ask({ KRIS_DEV_SESSION: '1' }, { action: 'vessels', token: devToken });
    const body = JSON.parse(r.body);
    assert.strictEqual(r.statusCode, 503, r.body);
    assert.deepStrictEqual(body.vessels, []);
    assert.strictEqual(body.reason, 'db_unreachable');
  });

  // --- the per-user message limit -------------------------------------------------
  const tokenFor = (sub) => Buffer.from(JSON.stringify({ sub, org: 'o', departments: ['Emission'] })).toString('base64');
  await ta('rate limit: past KRIS_RATE_PER_MIN a user gets a 429 with Retry-After and plain words; other users are unaffected', async () => {
    const env = { KRIS_DEV_SESSION: '1', KRIS_ENABLE_LLM: '0', KRIS_RATE_PER_MIN: '3' };
    for (let i = 0; i < 3; i++) {
      const ok = await ask(env, { text: 'what is 2+2', token: tokenFor('busy-user') });
      assert.strictEqual(ok.statusCode, 200, 'message ' + (i + 1) + ' was refused');
    }
    const r = await ask(env, { text: 'what is 2+2', token: tokenFor('busy-user') });
    assert.strictEqual(r.statusCode, 429);
    const body = JSON.parse(r.body);
    assert.strictEqual(body.code, 'RATE_LIMITED');
    assert.ok(/ask again/.test(body.text) && body.retryAfter >= 1, body.text);
    assert.strictEqual(r.headers['Retry-After'], String(body.retryAfter));
    const other = await ask(env, { text: 'what is 2+2', token: tokenFor('someone-else') });
    assert.strictEqual(other.statusCode, 200, 'another user was limited too');
  });
  await ta('rate limit: prototype visitors sharing the demo sign-in are told apart by their address', async () => {
    const env = { KRIS_DEV_SESSION: '1', KRIS_ENABLE_LLM: '0', KRIS_RATE_PER_MIN: '1' };
    const same = tokenFor('prototype-user');
    const a1 = await ask(env, { text: 'what is 3+3', token: same }, { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' });
    const b1 = await ask(env, { text: 'what is 3+3', token: same }, { 'x-forwarded-for': '198.51.100.20' });
    const a2 = await ask(env, { text: 'what is 3+3', token: same }, { 'x-forwarded-for': '203.0.113.7' });
    assert.deepStrictEqual([a1.statusCode, b1.statusCode, a2.statusCode], [200, 200, 429]);
  });
  t('rate limit: the bucket refills over the minute, and 0 turns the limit off', () => {
    const { takeToken } = require('../src/ratelimit');
    const env = { KRIS_RATE_PER_MIN: '2' };
    const t0 = 1e12;
    assert.ok(takeToken('refill', env, t0).ok && takeToken('refill', env, t0).ok);
    assert.ok(!takeToken('refill', env, t0).ok, 'third in the same instant should wait');
    assert.ok(takeToken('refill', env, t0 + 31000).ok, 'half a minute gives one back at 2 a minute');
    for (let i = 0; i < 50; i++) assert.ok(takeToken('off', { KRIS_RATE_PER_MIN: '0' }, t0).ok);
  });

  console.log(`\nAuth: ${passed} passed, ${fails.length} failed`);
  fails.forEach((f) => console.log('  FAIL ' + f));
  process.exit(fails.length ? 1 : 0);
})();
