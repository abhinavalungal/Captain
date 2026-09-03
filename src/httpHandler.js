'use strict';

const { Pool } = require('pg');

// Bump on every delivery. Shows up in GET /api/captain (health) and in every
// error body, so a screenshot alone tells us which build is actually running.
const CAPTAIN_BUILD = '2026-09-04.5';

// Last few server-side errors, kept in memory (this process only). Exposed in
// the health JSON ONLY in prototype auth mode (CAPTAIN_DEV_SESSION=1), which is
// already a dev-only configuration. Secrets are stripped before storing.
const RECENT_ERRORS = [];
function scrubSecrets(text) {
  return String(text || '')
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, 'postgresql://<redacted>')
    .replace(/https?:\/\/[^\s'"]+/gi, '<url>')
    .replace(/(password|api[_-]?key|authorization|bearer)\s*[:=]?\s*\S+/gi, '$1 <redacted>')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-<redacted>')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<jwt>');
}
function recordError(where, err, extra) {
  try {
    const e = err || {};
    RECENT_ERRORS.unshift(Object.assign({
      at: new Date().toISOString(),
      where: where,
      name: String(e.name || 'Error'),
      code: e.code != null ? String(e.code) : undefined,
      message: scrubSecrets(e.message || e).slice(0, 300),
      stack: scrubSecrets(String(e.stack || '')).split('\n').slice(0, 8).map((l) => l.trim()).join(' | ').slice(0, 900),
    }, extra || {}));
    if (RECENT_ERRORS.length > 10) RECENT_ERRORS.length = 10;
  } catch (_) { /* never let diagnostics break a request */ }
}
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
/**
 * Turn a raw pg/network error into a short operator-facing cause. Each hint
 * names what to change; none includes the connection string, password, or
 * the raw message. Shown in the widget while CAPTAIN_DIAGNOSTICS is not '0'.
 */
function classifyDbError(err) {
  const msg = String((err && err.message) || '');
  const code = String((err && err.code) || '');
  if (code === '28P01' || /password authentication failed/i.test(msg)) {
    return { code: 'DB_AUTH', hint: 'The database rejected the password. CAPTAIN_READ_URL still has a wrong or placeholder password - replace [YOUR-PASSWORD] with the real one and URL-encode special characters (@ becomes %40).' };
  }
  if (/tenant or user not found/i.test(msg)) {
    return { code: 'DB_TENANT', hint: 'The pooler could not find the project. With the pooler host the username must be postgres.<project-ref>, not plain postgres.' };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { code: 'DB_DNS', hint: 'The database hostname could not be resolved - check the host part of CAPTAIN_READ_URL for typos.' };
  }
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') {
    return { code: 'DB_NO_ROUTE', hint: 'No network route to the database. db.<ref>.supabase.co is IPv6-only; use the pooler host aws-0-<region>.pooler.supabase.com instead.' };
  }
  if (/unsupported startup parameter/i.test(msg)) {

    return { code: 'DB_POOLER_PARAM', hint: 'The pooler rejected a startup parameter. This build no longer sends one; if you still see this, use the session pooler (port 5432).' };

  }

  if (code === 'ETIMEDOUT' || /connection (terminated due to connection )?timeout|timed out/i.test(msg)) {
    return { code: 'DB_TIMEOUT', hint: 'The connection attempt timed out. Usually an IPv6-only host reached from an IPv4 network, or a firewall - use the pooler connection string.' };
  }
  if (code === 'ECONNREFUSED') {
    return { code: 'DB_REFUSED', hint: 'Connection refused - check the port. Pooler: 6543 (transaction) or 5432 (session).' };
  }
  if (/max client connections/i.test(msg)) {
    return { code: 'DB_POOL_FULL', hint: 'The pooler has no free client slots right now. Retry shortly; if persistent, raise the pool size in Supabase.' };
  }
  if (/certificate|ssl|tls/i.test(msg)) {
    return { code: 'DB_TLS', hint: 'TLS problem talking to the database. Leave CAPTAIN_PG_SSL unset (the default accepts Supabase certificates).' };
  }
  if (code === '3D000') {
    return { code: 'DB_NAME', hint: 'The database name in CAPTAIN_READ_URL does not exist (Supabase projects use "postgres").' };
  }
  if (code === '28000') {
    return { code: 'DB_ROLE', hint: 'That database role is not allowed to connect - check the username in CAPTAIN_READ_URL.' };
  }
  const safe = msg.replace(/https?:\/\/\S+/g, '<url>').replace(/password.*/i, 'password ...').slice(0, 120);
  return { code: code || 'DB_ERROR', hint: safe || 'Unclassified database error - see server log.' };
}

function diagnosticsOn(env) {
  return String(env.CAPTAIN_DIAGNOSTICS || '1') !== '0';
}

function typeErrorDetail(err) {
  const msg = String(err.message || '').replace(/https?:\/\/\S+/g, '<url>').slice(0, 160);
  const frame = String(err.stack || '').split('\n').map((l) => l.trim()).find((l) => /^at /.test(l)) || '';
  const m = frame.match(/([^\/\\\s(]+\.js):(\d+)/);
  return msg + (m ? ' @ ' + m[1] + ':' + m[2] : '');
}

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
      query_timeout: 5000,
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
      // query_timeout is enforced CLIENT-side by node-postgres. statement_timeout
      // would be sent as a server startup parameter, which connection poolers
      // (Supavisor transaction mode, PgBouncer) can reject with
      // "unsupported startup parameter" - breaking every connection.
      query_timeout: LIMITS.statementTimeoutMs,
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

function safeAgentBuild() {
  try { return require('./agent').AGENT_BUILD || 'pre-2026-09-04'; } catch (_) { return 'missing'; }
}

function health(env) {
  const llm = llmConfig(env);
  return {
    status: 'ok',
    service: 'captain',
    build: CAPTAIN_BUILD,
    // Every file that matters reports its own stamp. If these disagree, a
    // deploy shipped a mix of old and new files - the exact failure mode a
    // copy/paste pipeline produces.
    builds: { httpHandler: CAPTAIN_BUILD, router: router.ROUTER_BUILD || 'pre-2026-09-04', agent: safeAgentBuild() },
    database: !!env.CAPTAIN_READ_URL,
    writer: !!env.CAPTAIN_WRITE_URL,
    auth: env.CAPTAIN_DEV_SESSION === '1' ? 'prototype' : 'production',
    companion: llm.enabled ? { provider: llm.provider, model: llm.model, url: llm.url ? '(configured)' : null } : { enabled: false },
    sources: Object.values(SOURCES).map((s) => s.description),
    metrics: METRICS.filter((m) => !m.finerVersionOf).length,
    allowedOrigins: allowedOriginsList(env),
    mode: String(env.CAPTAIN_MODE || 'router'),
    diagnostics: diagnosticsOn(env),
    node: process.version,
    recentErrors: env.CAPTAIN_DEV_SESSION === '1' ? RECENT_ERRORS : undefined,
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
  let lastDbError = null;           // so the reply can name the cause even if router.js is older
  const getDb = async function () {
    if (client) return client;
    try {
      const p = pools(env);         // throws DB_NOT_CONFIGURED if no URL
      client = await p.readPool.connect();
    } catch (err) {
      if (!(err && err.code === 'DB_NOT_CONFIGURED')) {
        console.error('captain: database connect failed', err);
        recordError('database connect', err);
        const d = classifyDbError(err);
        const e = (err && typeof err === 'object') ? err : new Error(String(err));
        e.captainCode = d.code;     // never carries secrets
        e.captainHint = d.hint;
        lastDbError = e;
        throw e;                    // router turns this into a plain answer
      }
      throw err;
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
      recordError('router:' + (out.reason || out.source || ''), { name: 'Error', message: out.error });
      delete out.error;
    }
    if (out.status === 'error') {
      out.build = CAPTAIN_BUILD;
      // Belt and braces: if the router did not attach the cause (older
      // router.js), attach it here from the connection error we saw.
      if (!out.code && lastDbError && /^db_/.test(out.reason || '')) {
        out.code = lastDbError.captainCode;
        out.detail = lastDbError.captainHint;
      }
      // A mixed deploy (new handler, old router) is the failure mode a copy /
      // paste pipeline produces. Say so on the card instead of hiding it.
      const rb = router.ROUTER_BUILD || 'pre-2026-09-04';
      if (rb !== CAPTAIN_BUILD) {
        out.detail = (out.detail ? out.detail + ' | ' : '') + 'FILES OUT OF SYNC: router.js is build ' + rb + ', httpHandler.js is ' + CAPTAIN_BUILD + ' - redeploy every file from the same delivery.';
      }
      if (!diagnosticsOn(env)) { delete out.detail; delete out.code; }
    }
    // A database problem is reported as 503 so monitoring can see it, but only
    // for the message that actually needed the database.
    const status = out.status === 'error' && /^db_|^query_failed$/.test(out.reason || '') ? 503 : 200;
    return reply(status, out);
  } catch (err) {
    console.error('captain: query failed', err);
    recordError('handleCaptain catch-all', err, { text: String(text || '').slice(0, 80) });
    // The error's class/code is safe to expose and is often all that is needed
    // to diagnose from a screenshot; the message itself stays in the log.
    return reply(500, {
      status: 'error',
      text: 'Something went wrong on my side. Nothing was changed \u2014 please try again in a moment.',
      build: CAPTAIN_BUILD,
      code: String((err && (err.code || err.name)) || 'Error').slice(0, 40),
      // A TypeError is a programming error, not a data error: its message
      // ("x is not a function", "cannot read properties of undefined") never
      // carries user data or credentials, and the top stack frame (file:line,
      // basename only) is exactly what is needed to fix it from a screenshot.
      detail: (err instanceof TypeError && diagnosticsOn(env)) ? typeErrorDetail(err) : undefined,
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

module.exports = { handleCaptain, handleSync, health, corsHeaders, verifyToken, resolveSession, allowedOriginsList, classifyDbError, CAPTAIN_BUILD };