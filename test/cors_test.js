'use strict';
/**
 * CAPTAIN_ALLOW_ORIGIN accepts three shapes: an exact origin, "*" for any
 * origin, and "*.domain" for any subdomain (including Netlify-style preview
 * URLs) under that domain. Entirely offline - pure string/URL logic.
 *
 *   node test/cors_test.js
 */
const assert = require('assert');
const { corsHeaders, allowedOriginsList } = require('../src/httpHandler');

let passed = 0; const fails = [];
const t = (n, f) => { try { f(); passed++; } catch (e) { fails.push(n + ': ' + e.message); } };

t('exact origin match still works (today\'s behaviour, unchanged)', () => {
  const h = corsHeaders('https://perform.geoserves.com', { CAPTAIN_ALLOW_ORIGIN: 'https://perform.geoserves.com' });
  assert.strictEqual(h['Access-Control-Allow-Origin'], 'https://perform.geoserves.com');
});

t('a non-listed exact origin is refused', () => {
  const h = corsHeaders('https://evil.example.com', { CAPTAIN_ALLOW_ORIGIN: 'https://perform.geoserves.com' });
  assert.strictEqual(h['Access-Control-Allow-Origin'], undefined);
});

t('bare "*" allows anything, as before', () => {
  const h = corsHeaders('https://anything-at-all.example.org', { CAPTAIN_ALLOW_ORIGIN: '*' });
  assert.strictEqual(h['Access-Control-Allow-Origin'], '*');
});

t('*.netlify.app matches a preview deploy subdomain', () => {
  const h = corsHeaders('https://deploy-preview-123--geoserve-fueleu.netlify.app', { CAPTAIN_ALLOW_ORIGIN: '*.netlify.app' });
  assert.strictEqual(h['Access-Control-Allow-Origin'], 'https://deploy-preview-123--geoserve-fueleu.netlify.app');
});

t('*.netlify.app matches the bare app domain too', () => {
  const h = corsHeaders('https://geoserve-fueleu.netlify.app', { CAPTAIN_ALLOW_ORIGIN: '*.netlify.app' });
  assert.strictEqual(h['Access-Control-Allow-Origin'], 'https://geoserve-fueleu.netlify.app');
});

t('*.netlify.app does NOT match an unrelated domain', () => {
  const h = corsHeaders('https://netlify.app.evil.com', { CAPTAIN_ALLOW_ORIGIN: '*.netlify.app' });
  assert.strictEqual(h['Access-Control-Allow-Origin'], undefined);
});

t('*.netlify.app does NOT match netlify.app being a substring elsewhere', () => {
  const h = corsHeaders('https://notnetlify.app', { CAPTAIN_ALLOW_ORIGIN: '*.netlify.app' });
  assert.strictEqual(h['Access-Control-Allow-Origin'], undefined);
});

t('mixed list: literal domain + wildcard domain, both honoured', () => {
  const env = { CAPTAIN_ALLOW_ORIGIN: 'https://perform.geoserves.com,*.netlify.app' };
  assert.strictEqual(corsHeaders('https://perform.geoserves.com', env)['Access-Control-Allow-Origin'], 'https://perform.geoserves.com');
  assert.strictEqual(corsHeaders('https://preview-9--geoserve-fueleu.netlify.app', env)['Access-Control-Allow-Origin'], 'https://preview-9--geoserve-fueleu.netlify.app');
  assert.strictEqual(corsHeaders('https://someone-elses-site.com', env)['Access-Control-Allow-Origin'], undefined);
});

t('a request with no Origin header (curl, health check) still works when "*" is set', () => {
  const h = corsHeaders('', { CAPTAIN_ALLOW_ORIGIN: '*' });
  assert.strictEqual(h['Access-Control-Allow-Origin'], '*');
});

t('a request with no Origin header is fine even with a strict allowlist (no CORS headers needed for non-browser callers)', () => {
  const h = corsHeaders('', { CAPTAIN_ALLOW_ORIGIN: 'https://perform.geoserves.com' });
  assert.strictEqual(h['Access-Control-Allow-Origin'], undefined);
});

t('a malformed Origin header does not crash the matcher', () => {
  const h = corsHeaders('not-a-valid-url', { CAPTAIN_ALLOW_ORIGIN: '*.netlify.app' });
  assert.strictEqual(h['Access-Control-Allow-Origin'], undefined);
});

t('allowedOriginsList trims whitespace and drops empties, unchanged', () => {
  assert.deepStrictEqual(allowedOriginsList({ CAPTAIN_ALLOW_ORIGIN: ' https://a.com , *.netlify.app ,' }), ['https://a.com', '*.netlify.app']);
});

console.log(`\nCORS: ${passed} passed, ${fails.length} failed`);
fails.forEach((f) => console.log('  FAIL ' + f));
process.exit(fails.length ? 1 : 0);