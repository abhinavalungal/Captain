'use strict';
/**
 * Netlify function handler tests — the deployment-facing behaviour:
 * health check, CORS allow-list, auth gating, prototype sign-in, and
 * graceful failure when the database is not configured. No database needed.
 *
 *   node test/functions.js
 */
const assert = require('assert');
let passed = 0; const fails = [];
const t = (n, f) => { try { f(); passed++; } catch (e) { fails.push(n + ': ' + e.message); } };
const ta = async (n, f) => { try { await f(); passed++; } catch (e) { fails.push(n + ': ' + e.message); } };

// isolate env for this suite
for (const k of Object.keys(process.env)) if (/^CAPTAIN_|^VESON_|^GEOFORM_/.test(k)) delete process.env[k];
process.env.CAPTAIN_ALLOW_ORIGIN = 'https://perform.geoserves.com, https://staging.geoserves.com';

const fn = require('../netlify/functions/captain.js');
const call = (method, headers = {}, body) => fn.handler({ httpMethod: method, headers, body: body == null ? undefined : JSON.stringify(body) });
const devToken = (claims) => Buffer.from(JSON.stringify(claims)).toString('base64');

(async () => {
  await ta('GET returns a health payload with no secrets', async () => {
    const r = await call('GET', { origin: 'https://perform.geoserves.com' });
    assert.strictEqual(r.statusCode, 200);
    const h = JSON.parse(r.body);
    assert.strictEqual(h.status, 'ok');
    assert.strictEqual(h.database, false, 'no CAPTAIN_READ_URL in this suite');
    assert.strictEqual(h.auth, 'production');
    assert.ok(Array.isArray(h.sources) && h.sources.length === 3);
    assert.ok(!JSON.stringify(h).match(/postgres:\/\/|apiToken|4251D09D/), 'health must never leak a credential');
  });

  await ta('CORS: listed origin is echoed back', async () => {
    const r = await call('OPTIONS', { origin: 'https://staging.geoserves.com' });
    assert.strictEqual(r.statusCode, 204);
    assert.strictEqual(r.headers['Access-Control-Allow-Origin'], 'https://staging.geoserves.com');
    assert.ok(/Authorization/.test(r.headers['Access-Control-Allow-Headers']));
  });
  await ta('CORS: unlisted origin gets no allow header', async () => {
    const r = await call('OPTIONS', { origin: 'https://evil.example' });
    assert.strictEqual(r.statusCode, 204);
    assert.strictEqual(r.headers['Access-Control-Allow-Origin'], undefined);
  });
  await ta('CORS: wildcard is honoured when configured', async () => {
    process.env.CAPTAIN_ALLOW_ORIGIN = '*';
    const r = await call('GET', { origin: 'https://anything.example' });
    assert.strictEqual(r.headers['Access-Control-Allow-Origin'], '*');
    process.env.CAPTAIN_ALLOW_ORIGIN = 'https://perform.geoserves.com';
  });

  await ta('POST without a token is 401, never 500', async () => {
    const r = await call('POST', {}, { text: 'shaft power yesterday' });
    assert.strictEqual(r.statusCode, 401);
    assert.strictEqual(JSON.parse(r.body).status, 'unauthenticated');
  });
  await ta('POST with a token is rejected in production mode (no verifier wired)', async () => {
    const r = await call('POST', { authorization: 'Bearer ' + devToken({ sub: 'x', departments: ['Emission'] }) }, { text: 'hi' });
    assert.strictEqual(r.statusCode, 401, 'prototype tokens must not be trusted unless CAPTAIN_DEV_SESSION=1');
  });
  await ta('bad JSON body is 400', async () => {
    const r = await fn.handler({ httpMethod: 'POST', headers: {}, body: '{nope' });
    assert.strictEqual(r.statusCode, 400);
  });
  await ta('empty question is 400', async () => {
    const r = await call('POST', {}, { text: '   ' });
    assert.strictEqual(r.statusCode, 400);
  });

  process.env.CAPTAIN_DEV_SESSION = '1';
  await ta('prototype sign-in: token decodes into a department-scoped session', async () => {
    const s = await fn._verifyToken(devToken({ sub: 'demo', org: 'geoserves', departments: ['Emission'] }));
    assert.deepStrictEqual(s, { userId: 'demo', orgId: 'geoserves', departments: ['Emission'], vesselIds: null });
  });
  await ta('prototype sign-in: garbage token is null, not an exception', async () => {
    assert.strictEqual(await fn._verifyToken('not-base64!!'), null);
  });
  await ta('with a session but no database, the user gets a plain 503 explanation', async () => {
    const r = await call('POST', { authorization: 'Bearer ' + devToken({ sub: 'demo', departments: ['Emission'] }) }, { text: 'shaft power yesterday' });
    assert.strictEqual(r.statusCode, 503);
    const b = JSON.parse(r.body);
    assert.ok(/not configured/.test(b.text), b.text);
    assert.ok(!/\d{3,}/.test(b.text), 'error text must not contain a figure');
  });
  await ta('health reports prototype auth when the flag is on', async () => {
    const h = JSON.parse((await call('GET', {})).body);
    assert.strictEqual(h.auth, 'prototype');
  });

  console.log(`\nFunctions: ${passed} passed, ${fails.length} failed`);
  fails.forEach((f) => console.log('  FAIL ' + f));
  process.exit(fails.length ? 1 : 0);
})();
