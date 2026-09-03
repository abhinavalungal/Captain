'use strict';

/**
 * The primary deployment tests — no Netlify involved. Exercises:
 *   1. src/httpHandler.js directly, with plain objects
 *   2. server.js as an actual running HTTP server on an ephemeral port,
 *      hit with real fetch() calls: static files, the API, CORS, path
 *      traversal, 404s.
 *
 *   node test/server.js
 */
const assert = require('assert');
const path = require('path');
const { execSync } = require('child_process');

let passed = 0; const fails = [];
const t = (n, f) => { try { f(); passed++; } catch (e) { fails.push(n + ': ' + e.message); } };
const ta = async (n, f) => { try { await f(); passed++; } catch (e) { fails.push(n + ': ' + e.message); } };

for (const k of Object.keys(process.env)) if (/^CAPTAIN_|^VESON_|^GEOFORM_/.test(k)) delete process.env[k];

// ============================================================================
// 1. src/httpHandler.js, unit-level
// ============================================================================
const handler = require('../src/httpHandler');

(async () => {
  await ta('handleCaptain: GET returns health with no secrets leaked', async () => {
    const r = await handler.handleCaptain({ method: 'GET', headers: {}, env: { CAPTAIN_ALLOW_ORIGIN: 'https://perform.geoserves.com' } });
    assert.strictEqual(r.statusCode, 200);
    const h = JSON.parse(r.body);
    assert.strictEqual(h.database, false);
    assert.ok(!JSON.stringify(h).match(/postgres:\/\/|apiToken/));
  });

  await ta('handleCaptain: CORS echoes only a listed origin', async () => {
    const env = { CAPTAIN_ALLOW_ORIGIN: 'https://perform.geoserves.com,https://forms.geoserves.com' };
    const a = await handler.handleCaptain({ method: 'OPTIONS', headers: { origin: 'https://forms.geoserves.com' }, env });
    assert.strictEqual(a.headers['Access-Control-Allow-Origin'], 'https://forms.geoserves.com');
    const b = await handler.handleCaptain({ method: 'OPTIONS', headers: { origin: 'https://evil.example' }, env });
    assert.strictEqual(b.headers['Access-Control-Allow-Origin'], undefined);
  });

  await ta('handleCaptain: headers are matched case-insensitively (raw Node headers are lowercase, but adapters may not be)', async () => {
    const env = { CAPTAIN_DEV_SESSION: '1' };
    const token = Buffer.from(JSON.stringify({ sub: 'x', departments: ['Emission'] })).toString('base64');
    const r = await handler.handleCaptain({ method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: JSON.stringify({ text: 'hi' }), env });
    assert.notStrictEqual(r.statusCode, 401, 'a capitalised Authorization header must still be recognised');
  });

  await ta('handleCaptain: no token is 401, never a crash', async () => {
    const r = await handler.handleCaptain({ method: 'POST', headers: {}, body: JSON.stringify({ text: 'hi' }), env: {} });
    assert.strictEqual(r.statusCode, 401);
  });

  await ta('handleCaptain: a DATA question with no database is a plain 503', async () => {
    const env = { CAPTAIN_DEV_SESSION: '1' };
    const token = Buffer.from(JSON.stringify({ sub: 'x', departments: ['Emission'] })).toString('base64');
    const r = await handler.handleCaptain({ method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify({ text: 'shaft power yesterday' }), env });
    assert.strictEqual(r.statusCode, 503);
    assert.ok(/not configured/.test(JSON.parse(r.body).text));
  });

  await ta('handleCaptain: a GREETING with no database is answered normally (200)', async () => {
    const env = { CAPTAIN_DEV_SESSION: '1', CAPTAIN_ENABLE_LLM: '0' };
    const token = Buffer.from(JSON.stringify({ sub: 'x', departments: ['Emission'] })).toString('base64');
    const r = await handler.handleCaptain({ method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify({ text: 'hi' }), env });
    assert.strictEqual(r.statusCode, 200);
    const b = JSON.parse(r.body);
    assert.strictEqual(b.status, 'answer');
    assert.ok(!/database/.test(b.text), 'a greeting must not mention the database at all: ' + b.text);
  });

  await ta('handleCaptain: an APP question with no database is answered from the guide (200)', async () => {
    const env = { CAPTAIN_DEV_SESSION: '1', CAPTAIN_ENABLE_LLM: '0' };
    const token = Buffer.from(JSON.stringify({ sub: 'x', departments: ['Emission'] })).toString('base64');
    const r = await handler.handleCaptain({ method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify({ text: 'how do I export a report?' }), env });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(JSON.parse(r.body).source, 'guide');
  });

  await ta('handleSync: wrong or missing key is 401, no partial run', async () => {
    const r = await handler.handleSync({ method: 'POST', headers: {}, env: { CAPTAIN_SYNC_KEY: 'right', CAPTAIN_WRITE_URL: 'postgres://x' } });
    assert.strictEqual(r.statusCode, 401);
  });

  // ==========================================================================
  // 2. server.js, as a real running server
  // ==========================================================================
  const PORT = 18787 + (process.pid % 500);
  process.env.PORT = String(PORT);
  process.env.CAPTAIN_ALLOW_ORIGIN = 'https://perform.geoserves.com';
  delete process.env.CAPTAIN_READ_URL;
  const server = require('../server.js');
  await new Promise((resolve) => { if (server.listening) resolve(); else server.once('listening', resolve); });
  const base = 'http://127.0.0.1:' + PORT;

  await ta('server: serves the prototype host page at /', async () => {
    const r = await fetch(base + '/');
    assert.strictEqual(r.status, 200);
    assert.ok((r.headers.get('content-type') || '').includes('text/html'));
    const body = await r.text();
    assert.ok(/Captain/.test(body));
  });

  await ta('server: serves the widget script with the right content type', async () => {
    const r = await fetch(base + '/captain-widget.js');
    assert.strictEqual(r.status, 200);
    assert.ok((r.headers.get('content-type') || '').includes('javascript'));
    const body = await r.text();
    assert.ok(/global\.Captain = Captain/.test(body));
  });

  await ta('server: unknown static path is a plain 404, not a crash', async () => {
    const r = await fetch(base + '/does-not-exist.html');
    assert.strictEqual(r.status, 404);
  });

  await ta('server: path traversal is refused', async () => {
    const r = await fetch(base + '/../../etc/passwd');
    // The browser/URL normaliser collapses ".." before it reaches us in most
    // cases; either a clean 404 (normalised harmlessly) or 400 (caught by the
    // guard) is acceptable — the only failure is a 200 with file content.
    assert.notStrictEqual(r.status, 200);
  });

  await ta('server: GET /api/captain is the health check', async () => {
    const r = await fetch(base + '/api/captain');
    assert.strictEqual(r.status, 200);
    const h = await r.json();
    assert.strictEqual(h.status, 'ok');
    assert.strictEqual(h.database, false);
  });

  await ta('server: CORS preflight only allows the configured origin', async () => {
    const r = await fetch(base + '/api/captain', { method: 'OPTIONS', headers: { Origin: 'https://perform.geoserves.com' } });
    assert.strictEqual(r.status, 204);
    assert.strictEqual(r.headers.get('access-control-allow-origin'), 'https://perform.geoserves.com');
  });

  await ta('server: POST without auth is 401 over real HTTP', async () => {
    const r = await fetch(base + '/api/captain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hi' }) });
    assert.strictEqual(r.status, 401);
  });

  await ta('server: malformed JSON body is 400, not a 500', async () => {
    const r = await fetch(base + '/api/captain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
    assert.strictEqual(r.status, 400);
  });

  await ta('server: with no database configured, an authenticated question gets a plain 503', async () => {
    process.env.CAPTAIN_DEV_SESSION = '1';
    const token = Buffer.from(JSON.stringify({ sub: 'x', departments: ['Emission'] })).toString('base64');
    const r = await fetch(base + '/api/captain', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ text: 'shaft power yesterday' }) });
    assert.strictEqual(r.status, 503);
    const b = await r.json();
    assert.ok(/not configured/.test(b.text));
    delete process.env.CAPTAIN_DEV_SESSION;
  });

  await ta('server: GET /api/captain-sync without a key is refused', async () => {
    const r = await fetch(base + '/api/captain-sync', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    assert.strictEqual(r.status, 401);
  });

  server.close();

  console.log(`\nServer: ${passed} passed, ${fails.length} failed`);
  fails.forEach((f) => console.log('  FAIL ' + f));
  process.exit(fails.length ? 1 : 0);
})();