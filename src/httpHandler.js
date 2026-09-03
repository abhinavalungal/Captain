'use strict';

const { Pool } = require('pg');

// Bump on every delivery. Shows up in GET /api/captain (health) and in every
// error body, so a screenshot alone tells us which build is actually running.
const CAPTAIN_BUILD = '2026-09-04.1';
const router = require('./router');
const { LIMITS, METRICS, SOURCES } = require('./config');
const { readEnv: llmConfig } = require('./companion_src');
const { sync } = require('./integrations/sync');

/**
 * The whole HTTP surface of Captain, written against plain objects instead
 * of any platform's request/response shape. This is the ONE place the logic
 * lives — server.js (plain Node, runs anywhere) and netlify/functions/*.js
 * (kept only for anyone who still wants Netlify) are both thin adapters over
 * this file. There is exactly one implementation to keep correct.
 *
 * Every function here takes and returns plain data:
 *   handleCaptain({ method, headers, body, env })  -> { statusCode, headers, body }
 *   handleSync({ method, headers, env })           -> { statusCode, headers, body }
 * `headers` in is a plain lowercase-keyed object; `body` in is a raw string;
 * `body` out is always a JSON string.
 */

let readPool;
let writePool;
let poolEnvKey = null; // detects a changed connection string (tests swap env)

function sslFor(env) {
  return env.CAPTAIN_PG_SSL === 'false' ? false : { rejectUnauthorized: false };
}

/** How long to wait for a TCP+TLS connection before giving up (default 8s). */
function connectTimeoutMs(env) {
  const n = parseInt(env.CAPTAIN_PG_CONNECT_TIMEOUT_MS || '8000', 10);
  return Number.isFinite(n) && n > 0 ? n : 8000;
}

function pools(env) {
  const key = (env.CAPTAIN_READ_URL || '') + '|' + (env.CAPTAIN_WRITE_URL || '');
  if (key !== poolEnvKey) { readPool = null; writePool = null; poolEnvKey = key; }
  if (!writePool && env.CAPTAIN_WRITE_URL) {
    writePool = new Pool({
      connectionString: env.CAPTAIN_WRITE_URL,
      max: 2,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: connectTimeoutMs(env),
      statement_timeout: 5000,
      ssl: sslFor(env),
    });
  }
  if (!readPool) {
    if (!env.CAPTAIN_READ_URL) {
      const e = new Error('CAPTAIN_READ_URL is not set');
      e.code = 'DB_NOT_CONFIGURED';
      throw e;
    }
    readPool = new Pool({
      connectionString: env.CAPTAIN_READ_URL,
      max: 3,
      idleTimeoutMillis: 10000,
      // pg's default is 0 = wait forever. Against a host that silently drops
      // packets (an IPv6-only endpoint from an IPv4 network, a firewall, a
      // wrong region) the request would hang until the platform killed it.
      connectionTimeoutMillis: connectTimeoutMs(env),
      statement_timeout: LIMITS.statementTimeoutMs,
      ssl: sslFor(env),
    });
  }
  return { readPool, writePool };
}

/**
 * Replace this with your real session check. Must return
 *   { userId, orgId, departments?, vesselIds? }   or   null.
 *
 * PROTOTYPE MODE — CAPTAIN_DEV_SESSION=1
 *   Accepts an UNSIGNED token: base64 JSON like
 *     { "sub": "demo", "org": "geoserves", "departments": ["Emission"] }
 *   Convenient for demos. Trusts whatever the browser claims, so it must
 *   never be enabled on a site real users can reach.
 */
async function verifyToken(token, env) {
  if (env.CAPTAIN_DEV_SESSION === '1') {
    try {
      const raw = token.includes('.') ? token.split('.')[1] : token;
      const claims = JSON.parse(Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      if (!claims || typeof claims !== 'object') return null;
      return {
        userId: String(claims.sub || 'demo'),
        orgId: String(claims.org || 'default'),
        departments: Array.isArray(claims.departments) ? claims.departments.map(String) : null,
        vesselIds: Array.isArray(claims.vessel_ids) ? claims.vessel_ids.map(String) : null,
      };
    } catch (_) { return null; }
  }
  return null;
}

async function resolveSession(headers, env) {
  const auth = headers.authorization || headers.Authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!token) return null;
  return verifyToken(token, env);
}

// --- CORS: works the same regardless of host --------------------------------
// CAPTAIN_ALLOW_ORIGIN may be one origin, a comma-separated list, "*" for
// any origin, or a subdomain wildcard like "*.netlify.app" or
// "*.geoserves.com" \u2014 the last matches every subdomain (including Netlify's
// per-deploy preview URLs) under that domain, without matching arbitrary
// third-party sites the way a bare "*" would. Entries can be mixed freely:
// "https://perform.geoserves.com,*.netlify.app" is valid.
function allowedOriginsList(env) {
  return String(env.CAPTAIN_ALLOW_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** True if `hostname` is exactly `suffixDomain` or a subdomain of it. */
function hostMatchesSuffix(hostname, suffixDomain) {
  return hostname === suffixDomain || hostname.endsWith('.' + suffixDomain);
}

function originMatchesPattern(requestOrigin, pattern, requestHostname) {
  if (pattern === '*') return true;
  if (pattern === requestOrigin) return true;
  if (pattern.startsWith('*.') && requestHostname) {
    return hostMatchesSuffix(requestHostname, pattern.slice(2));
  }
  return false;
}

function corsHeaders(requestOrigin, env) {
  const allowed = allowedOriginsList(env);
  let allow = '';
  if (requestOrigin) {
    let hostname = null;
    try { hostname = new URL(requestOrigin).hostname; } catch (_) { hostname = null; }
    if (allowed.some((p) => originMatchesPattern(requestOrigin, p, hostname))) {
      // Echo the exact requesting origin rather than "*" whenever a specific
      // match (literal or wildcard) fired \u2014 this is what lets the caller
      // still use credentialed requests later if it ever needs to, and it is
      // more auditable in logs than a blanket "*" on every response.
      allow = allowed.includes('*') && !allowed.some((p) => p !== '*' && originMatchesPattern(requestOrigin, p, hostname))
        ? '*'
        : requestOrigin;
    }
  } else if (allowed.includes('*')) {
    allow = '*'; // non-browser caller (health checks, curl) sends no Origin header
  }

  const h = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Vary': 'Origin' };
  if (allow) {
    h['Access-Control-Allow-Origin'] = allow;
    h['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    h['Access-Control-Max-Age'] = '600';
  }
  return h;
}

function health(env) {
  const llm = llmConfig(env);
  return {
    status: 'ok',
    service: 'captain',
    build: CAPTAIN_BUILD,
    database: !!env.CAPTAIN_READ_URL,
    writer: !!env.CAPTAIN_WRITE_URL,
    auth: env.CAPTAIN_DEV_SESSION === '1' ? 'prototype' : 'production',
    companion: llm.enabled ? { provider: llm.provider, model: llm.model, url: llm.url ? '(configured)' : null } : { enabled: false },
    sources: Object.values(SOURCES).map((s) => s.description),
    metrics: METRICS.filter((m) => !m.finerVersionOf).length,
    allowedOrigins: allowedOriginsList(env),
  };
}

/**
 * Handle one request to the question endpoint.
 * @param {object} req  { method, headers (lowercase keys), body (raw string), env }
 */
async function handleCaptain(req) {
  const env = req.env || process.env;
  const headers = lowercaseKeys(req.headers || {});
  const origin = headers.origin || '';
  const cors = corsHeaders(origin, env);
  const reply = (statusCode, obj) => ({ statusCode, headers: cors, body: JSON.stringify(obj) });

  if (req.method === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (req.method === 'GET') return reply(200, health(env));
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' });

  let payload;
  try { payload = JSON.parse(req.body || '{}'); }
  catch (_) { return reply(400, { error: 'Body must be JSON.' }); }

  const text = String(payload.text || '').slice(0, 1000);
  if (!text.trim()) return reply(400, { error: 'Ask a question.' });

  let session;
  try {
    session = await resolveSession(headers, env);
  } catch (err) {
    console.error('captain: auth error', err);
    return reply(500, { status: 'error', text: 'Authentication is misconfigured.' });
  }
  if (!session) return reply(401, { status: 'unauthenticated', text: 'Sign in and I can look at your vessel data.' });

  // The database is NOT opened here. The router decides whether this message
  // needs vessel records at all; only then does it call getDb(). A greeting or
  // an app question is answered even when Postgres is down or not configured.
  let client = null;
  const getDb = async function () {
    if (client) return client;
    const p = pools(env);           // throws DB_NOT_CONFIGURED if no URL
    try {
      client = await p.readPool.connect();
    } catch (err) {
      console.error('captain: database connect failed', err);
      throw err;                    // router turns this into a plain answer
    }
    return client;
  };
  const wp = writePoolIfConfigured(env);

  try {
    const out = await router.route(
      {
        text,
        session,
        pending: payload.pending || null,
        now: new Date(),
        // History arrives from the browser; trust nothing about its shape.
        history: Array.isArray(payload.history)
          ? payload.history.filter((h) => h && typeof h === 'object').slice(-6)
              .map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', text: String(h.text || '').slice(0, 500) }))
          : null,
        context: payload.context && typeof payload.context === 'object'
          ? { vesselId: payload.context.vesselId != null ? String(payload.context.vesselId).slice(0, 40) : null,
              vesselName: payload.context.vesselName != null ? String(payload.context.vesselName).slice(0, 80) : null,
              userName: payload.context.userName != null ? String(payload.context.userName).slice(0, 60) : null,
              page: payload.context.page != null ? String(payload.context.page).slice(0, 80) : null,
              tz: payload.context.tz != null ? String(payload.context.tz).slice(0, 64) : null,
              locale: payload.context.locale != null ? String(payload.context.locale).slice(0, 16) : null }
          : null,
      },
      getDb,
      { orgId: session.orgId, writeDb: wp, dateOrder: env.CAPTAIN_DATE_ORDER || 'DMY', env }
    );

    if (out.provenance && env.CAPTAIN_EXPOSE_SQL !== '1') {
      delete out.provenance.sql;
      delete out.provenance.sqlValues;
      delete out.provenance.table;
      delete out.provenance.column;
    }
    // Diagnostic detail (raw Postgres/provider error text) is for the server
    // log, never the browser - it can name real table/column names or provider
    // internals. Every code path that attaches `.error` already logs its own
    // context; this is the one place all of them funnel through before the
    // response leaves the server, so it is caught here regardless of source.
    if (out.error) {
      console.error('captain: error surfaced to user -', out.source || 'unknown', out.reason || '', '-', out.error);
      delete out.error;
    }
    // A database problem is reported as 503 so monitoring can see it, but only
    // for the message that actually needed the database.
    const status = out.status === 'error' && /^db_|^query_failed$/.test(out.reason || '') ? 503 : 200;
    return reply(status, out);
  } catch (err) {
    console.error('captain: query failed', err);
    // The error's class/code is safe to expose and is often all that is needed
    // to diagnose from a screenshot; the message itself stays in the log.
    return reply(500, {
      status: 'error',
      text: 'Something went wrong on my side. Nothing was changed \u2014 please try again in a moment.',
      build: CAPTAIN_BUILD,
      code: String((err && (err.code || err.name)) || 'Error').slice(0, 40),
    });
  } finally {
    if (client) client.release();
  }
}

/** The writer pool is only for vocabulary and logging; never a reason to fail a request. */
function writePoolIfConfigured(env) {
  if (!env.CAPTAIN_WRITE_URL) return null;
  try { return pools(env).writePool; } catch (_) { return null; }
}

/**
 * Handle a sync trigger over HTTP. Optional — running `node scripts/sync.js`
 * on a schedule (cron, pm2) needs no network exposure at all and is the
 * simpler default; this exists for hosts where only inbound HTTP is
 * reachable (a serverless platform, a scheduler that can only call a URL).
 */
async function handleSync(req) {
  const env = req.env || process.env;
  const headers = lowercaseKeys(req.headers || {});
  const reply = (statusCode, obj) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

  const key = headers['x-captain-sync-key'];
  if (!env.CAPTAIN_SYNC_KEY || key !== env.CAPTAIN_SYNC_KEY) {
    return reply(401, { error: 'sync key required' });
  }
  if (!env.CAPTAIN_WRITE_URL) return reply(400, { error: 'CAPTAIN_WRITE_URL is not set' });

  const { Client } = require('pg');
  const db = new Client({ connectionString: env.CAPTAIN_WRITE_URL, ssl: sslFor(env) });
  await db.connect();
  try {
    const stats = await sync({ db, env, log: (m) => console.log('captain-sync:', m) });
    return reply(200, stats);
  } catch (err) {
    console.error('captain-sync failed', err);
    return reply(500, { error: err.message });
  } finally {
    await db.end();
  }
}

function lowercaseKeys(obj) {
  const out = {};
  for (const k of Object.keys(obj)) out[k.toLowerCase()] = obj[k];
  return out;
}

module.exports = { handleCaptain, handleSync, health, corsHeaders, verifyToken, resolveSession, allowedOriginsList, CAPTAIN_BUILD };