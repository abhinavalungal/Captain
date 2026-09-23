#!/usr/bin/env node
'use strict';

/**
 * K.R.1.S, as a plain Node process. No Netlify, no vendor platform — this is
 * a standard HTTP server you can run on a VPS, Render, Railway, Fly.io,
 * inside Docker, or on your own machine. Deployment is `node server.js`.
 *
 * Serves:
 *   GET  /                    -> public/index.html   (prototype host page)
 *   GET  /kris-widget.js   -> public/*             (static files, compressed + cached)
 *   GET  /api/kris         -> health check (also warms DB + model connections)
 *   POST /api/kris         -> ask a question  (JSON, or streamed NDJSON when
 *                                the body says { "stream": true })
 *   POST /api/kris-sync    -> optional network-triggered sync (see below)
 *
 * All the actual logic lives in src/httpHandler.js — this file is only
 * responsible for turning Node's req/res into the plain objects that file
 * expects, for streaming, and for serving static files.
 *
 * Streaming protocol (POST with { stream: true }):
 *   Content-Type: application/x-ndjson — one JSON object per line:
 *     { "t": "delta",   "text": "..." }   append text (already guard-checked)
 *     { "t": "replace", "text": "..." }   replace everything shown so far
 *     { "t": "status",  "text": "..." }   what K.R.1.S is doing ("Reading the records")
 *     { "t": "final",   "status": 200, "data": { ...the normal JSON answer } }
 *   Answers that need no model (greetings, data lookups, app help) come back
 *   as ordinary JSON even when streaming was requested — there is nothing to
 *   stream, and one JSON body is the fastest thing to send.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { handleKris, handleSync, corsHeaders, warmUp } = require('./src/httpHandler');
const { sync } = require('./src/integrations/sync');

const PORT = parseInt(process.env.PORT || '8787', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = { '.html': 1, '.js': 1, '.css': 1, '.json': 1, '.svg': 1, '.webmanifest': 1, '.txt': 1 };

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) { const e = new Error('body too large'); e.code = 'TOO_LARGE'; throw e; }
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// --- static files: read once, compressed once, served from memory -------------
// The widget is ~100 KB of source; brotli brings it to roughly a fifth of that.
// Each file is cached in memory with an ETag and re-read if it changes on disk.
const staticCache = new Map();
function loadStatic(filePath) {
  let st;
  try { st = fs.statSync(filePath); } catch (_) { return null; }
  if (!st.isFile()) return null;
  const hit = staticCache.get(filePath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
  const raw = fs.readFileSync(filePath);
  const ext = path.extname(filePath);
  const entry = {
    mtimeMs: st.mtimeMs, size: st.size, raw,
    type: MIME[ext] || 'application/octet-stream',
    etag: '"' + crypto.createHash('sha1').update(raw).digest('base64').slice(0, 16) + '"',
    br: COMPRESSIBLE[ext] ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }) : null,
    gz: COMPRESSIBLE[ext] ? zlib.gzipSync(raw, { level: 9 }) : null,
  };
  staticCache.set(filePath, entry);
  return entry;
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch (_) { decoded = rel; }
  const filePath = path.join(PUBLIC_DIR, path.normalize(decoded));
  // Refuse anything that escapes the public directory — the normalize above
  // collapses "..", this checks the result actually still lands inside it.
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Bad path');
  }
  const f = loadStatic(filePath);
  if (!f) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  const headers = {
    'Content-Type': f.type,
    ETag: f.etag,
    Vary: 'Accept-Encoding',
    // The widget can be cached briefly and revalidated cheaply (304) —
    // pages load it from cache instead of re-downloading on every navigation.
    'Cache-Control': f.type.startsWith('text/html') ? 'no-cache' : 'public, max-age=300, stale-while-revalidate=86400',
    // Pages on other origins embed the widget script.
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff',
  };
  if (req.headers['if-none-match'] === f.etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  const ae = String(req.headers['accept-encoding'] || '');
  let body = f.raw;
  if (f.br && /\bbr\b/.test(ae)) { body = f.br; headers['Content-Encoding'] = 'br'; }
  else if (f.gz && /\bgzip\b/.test(ae)) { body = f.gz; headers['Content-Encoding'] = 'gzip'; }
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

async function handleApi(req, res) {
  let body = '';
  if (req.method !== 'GET' && req.method !== 'OPTIONS') {
    try { body = await readBody(req, 64 * 1024); }
    catch (e) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'error', text: 'That message is too long.' }));
    }
  }

  // Cancel model work if the browser goes away (stop button, closed tab).
  const ctrl = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });

  let started = false;
  const onEvent = (evt) => {
    if (res.writableEnded || ctrl.signal.aborted) return;
    if (!started) {
      started = true;
      const cors = corsHeaders(req.headers.origin || '', process.env);
      res.writeHead(200, Object.assign({}, cors, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        'X-Accel-Buffering': 'no',
      }));
      if (res.socket) res.socket.setNoDelay(true);
    }
    res.write(JSON.stringify(evt) + '\n');
  };

  const out = await handleKris({ method: req.method, headers: req.headers, body, env: process.env, onEvent, signal: ctrl.signal });
  if (started) {
    let data;
    try { data = JSON.parse(out.body); } catch (_) { data = { status: 'error', text: 'Something went wrong.' }; }
    return res.end(JSON.stringify({ t: 'final', status: out.statusCode, data }) + '\n');
  }
  res.writeHead(out.statusCode, out.headers);
  return res.end(out.body);
}

const server = http.createServer(async (req, res) => {
  let u;
  try { u = new URL(req.url, 'http://placeholder'); }
  catch (_) { res.writeHead(400); return res.end('Bad request'); }

  try {
    if (u.pathname === '/api/kris') return await handleApi(req, res);
    if (u.pathname === '/api/kris-sync') {
      const out = await handleSync({ method: req.method, headers: req.headers, env: process.env });
      res.writeHead(out.statusCode, out.headers);
      return res.end(out.body);
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(req, res, u.pathname);
    }
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    return res.end('Method not allowed');
  } catch (err) {
    console.error('kris server: unhandled error', err);
    if (res.headersSent) { try { res.end(); } catch (_) { /* ignore */ } return; }
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'error', text: 'Something went wrong. Nothing was changed.' }));
  }
});

// Load balancers (Render, most PaaS) keep idle connections open for ~60 s.
// Node's default keep-alive timeout is 5 s, so a browser that pauses between
// messages would find its connection closed and pay a new TCP + TLS handshake.
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

// --- optional built-in scheduler --------------------------------------------
// Off by default. With KRIS_AUTO_SYNC=1 and KRIS_WRITE_URL set, this
// process pulls fresh data on startup and every KRIS_SYNC_INTERVAL_MS
// (default 1 hour) for as long as it keeps running — no external cron
// needed. If your host doesn't keep a process alive continuously (or you'd
// rather control timing yourself), leave this off and run
// `node scripts/sync.js` from a system cron job or pm2's cron-restart
// instead; both call the exact same sync() function.
async function runAutoSync() {
  const { Client } = require('pg');
  const db = new Client({ connectionString: process.env.KRIS_WRITE_URL, ssl: process.env.KRIS_PG_SSL === 'false' ? false : { rejectUnauthorized: false } });
  try {
    await db.connect();
    const stats = await sync({ db, log: (m) => console.log('[auto-sync]', m) });
    console.log('[auto-sync] done:', stats.legs, 'legs,', stats.offhire, 'off-hire,', stats.geoform, 'geoform,', stats.warnings.length, 'warnings');
  } catch (err) {
    console.error('[auto-sync] failed:', err.message);
  } finally {
    await db.end().catch(() => {});
  }
}

if (process.env.KRIS_AUTO_SYNC === '1' && process.env.KRIS_WRITE_URL) {
  const intervalMs = parseInt(process.env.KRIS_SYNC_INTERVAL_MS || '3600000', 10);
  runAutoSync();
  setInterval(runAutoSync, intervalMs);
  console.log('kris: auto-sync enabled, every', Math.round(intervalMs / 60000), 'minutes');
}

server.listen(PORT, () => {
  console.log('K.R.1.S listening on http://localhost:' + PORT);
  console.log('  widget:  http://localhost:' + PORT + '/kris-widget.js');
  console.log('  api:     http://localhost:' + PORT + '/api/kris');
  const renames = require('./src/envcheck').findRenames(process.env);
  if (renames.length) {
    console.log('  ⚠ ' + renames.length + ' setting(s) use another prefix and are being IGNORED — this build reads KRIS_*. Rename them on the host:');
    for (const r of renames) console.log('      ' + r.from + '  ->  ' + r.to);
  }
  if (!process.env.KRIS_READ_URL) console.log('  ⚠ KRIS_READ_URL is not set — data questions will return a friendly 503 until it is.');
  if (process.env.KRIS_DEV_SESSION !== '1') console.log('  ⚠ KRIS_DEV_SESSION is not 1 and verifyToken() is the stub — every signed-in question will be refused (401) until one of them changes.');
  // Open the database and model connections now, not on the first message,
  // and warm the fast lane so the first "hi" after a restart is still instant.
  warmUp(process.env);
  try { require('./src/router').prewarm(); } catch (_) { /* best-effort */ }
  // Pre-compress the widget so the first page load is served from memory.
  loadStatic(path.join(PUBLIC_DIR, 'kris-widget.js'));
});

module.exports = server;
