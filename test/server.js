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

for (const k of Object.keys(process.env)) if (/^KRIS_|^VESON_|^GEOFORM_/.test(k)) delete process.env[k];

// ============================================================================
// 1. src/httpHandler.js, unit-level
// ============================================================================
const handler = require('../src/httpHandler');

(async () => {
  await ta('handleKris: GET returns health with no secrets leaked', async () => {
    const r = await handler.handleKris({ method: 'GET', headers: {}, env: { KRIS_ALLOW_ORIGIN: 'https://perform.geoserves.com' } });
    assert.strictEqual(r.statusCode, 200);
    const h = JSON.parse(r.body);
    assert.strictEqual(h.database, false);
    assert.ok(!JSON.stringify(h).match(/postgres:\/\/|apiToken/));
  });

  await ta('handleKris: CORS echoes only a listed origin', async () => {
    const env = { KRIS_ALLOW_ORIGIN: 'https://perform.geoserves.com,https://forms.geoserves.com' };
    const a = await handler.handleKris({ method: 'OPTIONS', headers: { origin: 'https://forms.geoserves.com' }, env });
    assert.strictEqual(a.headers['Access-Control-Allow-Origin'], 'https://forms.geoserves.com');
    const b = await handler.handleKris({ method: 'OPTIONS', headers: { origin: 'https://evil.example' }, env });
    assert.strictEqual(b.headers['Access-Control-Allow-Origin'], undefined);
  });

  await ta('handleKris: headers are matched case-insensitively (raw Node headers are lowercase, but adapters may not be)', async () => {
    const env = { KRIS_DEV_SESSION: '1' };
    const token = Buffer.from(JSON.stringify({ sub: 'x', departments: ['Emission'] })).toString('base64');
    const r = await handler.handleKris({ method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: JSON.stringify({ text: 'hi' }), env });
    assert.notStrictEqual(r.statusCode, 401, 'a capitalised Authorization header must still be recognised');
  });

  await ta('handleKris: no token is 401, never a crash', async () => {
    const r = await handler.handleKris({ method: 'POST', headers: {}, body: JSON.stringify({ text: 'hi' }), env: {} });
    assert.strictEqual(r.statusCode, 401);
  });

  await ta('handleKris: a DATA question with no database is a plain 503', async () => {
    const env = { KRIS_DEV_SESSION: '1' };
    const token = Buffer.from(JSON.stringify({ sub: 'x', departments: ['Emission'] })).toString('base64');
    const r = await handler.handleKris({ method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify({ text: 'shaft power yesterday' }), env });
    assert.strictEqual(r.statusCode, 503);
    assert.ok(/not configured/.test(JSON.parse(r.body).text));
  });

  await ta('handleKris: a GREETING with no database is answered normally (200)', async () => {
    const env = { KRIS_DEV_SESSION: '1', KRIS_ENABLE_LLM: '0' };
    const token = Buffer.from(JSON.stringify({ sub: 'x', departments: ['Emission'] })).toString('base64');
    const r = await handler.handleKris({ method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify({ text: 'hi' }), env });
    assert.strictEqual(r.statusCode, 200);
    const b = JSON.parse(r.body);
    assert.strictEqual(b.status, 'answer');
    assert.ok(!/database/.test(b.text), 'a greeting must not mention the database at all: ' + b.text);
  });

  await ta('handleKris: an APP question with no database is answered from the guide (200)', async () => {
    const env = { KRIS_DEV_SESSION: '1', KRIS_ENABLE_LLM: '0' };
    const token = Buffer.from(JSON.stringify({ sub: 'x', departments: ['Emission'] })).toString('base64');
    const r = await handler.handleKris({ method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify({ text: 'how do I export a report?' }), env });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(JSON.parse(r.body).source, 'guide');
  });

  await ta('handleSync: wrong or missing key is 401, no partial run', async () => {
    const r = await handler.handleSync({ method: 'POST', headers: {}, env: { KRIS_SYNC_KEY: 'right', KRIS_WRITE_URL: 'postgres://x' } });
    assert.strictEqual(r.statusCode, 401);
  });

  // ==========================================================================
  // 2. server.js, as a real running server
  // ==========================================================================
  const PORT = 18787 + (process.pid % 500);
  process.env.PORT = String(PORT);
  process.env.KRIS_ALLOW_ORIGIN = 'https://perform.geoserves.com';
  delete process.env.KRIS_READ_URL;
  const server = require('../server.js');
  await new Promise((resolve) => { if (server.listening) resolve(); else server.once('listening', resolve); });
  const base = 'http://127.0.0.1:' + PORT;

  await ta('server: serves the prototype host page at /', async () => {
    const r = await fetch(base + '/');
    assert.strictEqual(r.status, 200);
    assert.ok((r.headers.get('content-type') || '').includes('text/html'));
    const body = await r.text();
    assert.ok(/K\.R\.1\.S/.test(body));
  });

  await ta('server: the host page carries the Shuddha now branding, and every brand asset is served', async () => {
    const page = await (await fetch(base + '/')).text();
    assert.ok(/<title>Shuddha now \u2014 K\.R\.1\.S prototype<\/title>/.test(page), 'title');
    assert.ok(/<meta name="application-name" content="Shuddha now">/.test(page), 'application-name');
    assert.ok(/<meta name="theme-color" content="#0F3D2E">/.test(page), 'theme colour');
    assert.ok(/<link rel="icon" type="image\/svg\+xml" href="assets\/favicon\.svg">/.test(page), 'svg favicon');
    assert.ok(/<img src="assets\/shuddha-now-logo-reverse\.svg"[^>]+alt="Shuddha now"/.test(page), 'header logo');
    assert.ok(!/geo\s*monitor/i.test(page), 'old product name left on the page');
    const assets = {
      '/assets/shuddha-now-logo.svg': 'image/svg+xml',
      '/assets/shuddha-now-logo-reverse.svg': 'image/svg+xml',
      '/assets/shuddha-now-mark.svg': 'image/svg+xml',
      '/assets/favicon.svg': 'image/svg+xml',
      '/favicon.ico': 'image/x-icon',
      '/assets/apple-touch-icon.png': 'image/png',
      '/assets/shuddha-now-app-icon-192.png': 'image/png',
      '/assets/shuddha-now-app-icon-512.png': 'image/png',
      '/assets/shuddha-now-social.png': 'image/png',
      '/assets/fonts/manrope-400.woff2': 'font/woff2',
      '/assets/fonts/manrope-600.woff2': 'font/woff2',
      '/assets/fonts/manrope-700.woff2': 'font/woff2',
      '/site.webmanifest': 'application/manifest+json',
    };
    for (const [path, type] of Object.entries(assets)) {
      const r = await fetch(base + path);
      assert.strictEqual(r.status, 200, path);
      assert.strictEqual(r.headers.get('content-type'), type, path);
      if (type === 'image/svg+xml') {
        const svg = await r.text();
        assert.ok(/^<svg[^>]+viewBox=/.test(svg) && /<title id="t">Shuddha now/.test(svg), path + ' is not the logo');
        assert.ok(!/<text\b|<image\b|https?:\/\/(?!www\.w3\.org)/.test(svg), path + ' must be self-contained vector art');
      } else {
        await r.arrayBuffer();
      }
    }
    const manifest = await (await fetch(base + '/site.webmanifest')).json();
    assert.strictEqual(manifest.name, 'Shuddha now');
    assert.strictEqual(manifest.theme_color, '#0F3D2E');
  });

  await ta('server: serves the widget script with the right content type', async () => {
    const r = await fetch(base + '/kris-widget.js');
    assert.strictEqual(r.status, 200);
    assert.ok((r.headers.get('content-type') || '').includes('javascript'));
    const body = await r.text();
    assert.ok(/global\.KRIS = KRIS/.test(body));
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

  await ta('server: GET /api/kris is the health check', async () => {
    const r = await fetch(base + '/api/kris');
    assert.strictEqual(r.status, 200);
    const h = await r.json();
    assert.strictEqual(h.status, 'ok');
    assert.strictEqual(h.database, false);
  });

  await ta('server: CORS preflight only allows the configured origin', async () => {
    const r = await fetch(base + '/api/kris', { method: 'OPTIONS', headers: { Origin: 'https://perform.geoserves.com' } });
    assert.strictEqual(r.status, 204);
    assert.strictEqual(r.headers.get('access-control-allow-origin'), 'https://perform.geoserves.com');
  });

  await ta('server: POST without auth is 401 over real HTTP', async () => {
    const r = await fetch(base + '/api/kris', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hi' }) });
    assert.strictEqual(r.status, 401);
  });

  await ta('server: malformed JSON body is 400, not a 500', async () => {
    const r = await fetch(base + '/api/kris', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
    assert.strictEqual(r.status, 400);
  });

  await ta('server: with no database configured, an authenticated question gets a plain 503', async () => {
    process.env.KRIS_DEV_SESSION = '1';
    const token = Buffer.from(JSON.stringify({ sub: 'x', departments: ['Emission'] })).toString('base64');
    const r = await fetch(base + '/api/kris', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ text: 'shaft power yesterday' }) });
    assert.strictEqual(r.status, 503);
    const b = await r.json();
    assert.ok(/not configured/.test(b.text));
    delete process.env.KRIS_DEV_SESSION;
  });

  await ta('server: GET /api/kris-sync without a key is refused', async () => {
    const r = await fetch(base + '/api/kris-sync', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    assert.strictEqual(r.status, 401);
  });

  server.close();

  console.log(`\nServer: ${passed} passed, ${fails.length} failed`);
  fails.forEach((f) => console.log('  FAIL ' + f));
  process.exit(fails.length ? 1 : 0);
})();