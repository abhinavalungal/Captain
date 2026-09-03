#!/usr/bin/env node
'use strict';

/**
 * Captain, as a plain Node process. No Netlify, no vendor platform — this is
 * a standard HTTP server you can run on a VPS, Render, Railway, Fly.io,
 * inside Docker, or on your own machine. Deployment is `node server.js`.
 *
 * Serves:
 *   GET  /                    -> public/index.html   (prototype host page)
 *   GET  /captain-widget.js   -> public/*             (static files)
 *   GET  /api/captain         -> health check
 *   POST /api/captain         -> ask a question
 *   POST /api/captain-sync    -> optional network-triggered sync (see below)
 *
 * All the actual logic lives in src/httpHandler.js — this file is only
 * responsible for turning Node's req/res into the plain objects that file
 * expects, and for serving static files. Nothing platform-specific is mixed
 * into the logic itself.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { handleCaptain, handleSync } = require('./src/httpHandler');
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
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  // Refuse anything that escapes the public directory — the normalize above
  // collapses "..", this checks the result actually still lands inside it.
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Bad path');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  let u;
  try { u = new URL(req.url, 'http://placeholder'); }
  catch (_) { res.writeHead(400); return res.end('Bad request'); }

  try {
    if (u.pathname === '/api/captain') {
      const body = req.method === 'GET' || req.method === 'OPTIONS' ? '' : await readBody(req);
      const out = await handleCaptain({ method: req.method, headers: req.headers, body, env: process.env });
      res.writeHead(out.statusCode, out.headers);
      return res.end(out.body);
    }
    if (u.pathname === '/api/captain-sync') {
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
    console.error('captain server: unhandled error', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'error', text: 'Something went wrong. Nothing was changed.' }));
  }
});

// --- optional built-in scheduler --------------------------------------------
// Off by default. With CAPTAIN_AUTO_SYNC=1 and CAPTAIN_WRITE_URL set, this
// process pulls fresh data on startup and every CAPTAIN_SYNC_INTERVAL_MS
// (default 1 hour) for as long as it keeps running — no external cron
// needed. If your host doesn't keep a process alive continuously (or you'd
// rather control timing yourself), leave this off and run
// `node scripts/sync.js` from a system cron job or pm2's cron-restart
// instead; both call the exact same sync() function.
async function runAutoSync() {
  const { Client } = require('pg');
  const db = new Client({ connectionString: process.env.CAPTAIN_WRITE_URL, ssl: process.env.CAPTAIN_PG_SSL === 'false' ? false : { rejectUnauthorized: false } });
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

if (process.env.CAPTAIN_AUTO_SYNC === '1' && process.env.CAPTAIN_WRITE_URL) {
  const intervalMs = parseInt(process.env.CAPTAIN_SYNC_INTERVAL_MS || '3600000', 10);
  runAutoSync();
  setInterval(runAutoSync, intervalMs);
  console.log('captain: auto-sync enabled, every', Math.round(intervalMs / 60000), 'minutes');
}

server.listen(PORT, () => {
  console.log('Captain listening on http://localhost:' + PORT);
  console.log('  widget:  http://localhost:' + PORT + '/captain-widget.js');
  console.log('  api:     http://localhost:' + PORT + '/api/captain');
  if (!process.env.CAPTAIN_READ_URL) console.log('  \u26a0 CAPTAIN_READ_URL is not set — data questions will return a friendly 503 until it is.');
});

module.exports = server;
