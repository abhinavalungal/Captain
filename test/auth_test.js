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

  console.log(`\nAuth: ${passed} passed, ${fails.length} failed`);
  fails.forEach((f) => console.log('  FAIL ' + f));
  process.exit(fails.length ? 1 : 0);
})();
