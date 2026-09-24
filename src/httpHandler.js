'use strict';

const { Pool } = require('pg');

// Bump on every delivery. Shows up in GET /api/kris (health) and in every
// error body, so a screenshot alone tells us which build is actually running.
const KRIS_BUILD = '2026-09-24.kris-10';

// Fingerprint every source file so /api/kris shows exactly what is
// deployed. Compare against MANIFEST.txt from the same delivery: a mismatch
// means that file did not land intact.
let FINGERPRINTS = null;
function fileFingerprints() {
  // Hashing every source file is synchronous disk work; do it once per process.
  if (FINGERPRINTS) return FINGERPRINTS;
  FINGERPRINTS = computeFingerprints();
  return FINGERPRINTS;
}
function computeFingerprints() {
  const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
  const out = {};
  const root = path.join(__dirname, '..');
  const targets = [];
  try { fs.readdirSync(__dirname).filter((f) => f.endsWith('.js')).forEach((f) => targets.push(['src/' + f, path.join(__dirname, f)])); } catch (_) { /* ignore */ }
  targets.push(['public/kris-widget.js', path.join(root, 'public', 'kris-widget.js')]);
  for (const [label, file] of targets) {
    try {
      const buf = fs.readFileSync(file);
      // Normalise line endings so CRLF/LF copies of the same file agree.
      const norm = buf.toString('utf8').replace(/\r\n/g, '\n');
      out[label] = crypto.createHash('sha256').update(norm).digest('hex').slice(0, 10) + ' (' + norm.length + ' chars)';
    } catch (_) { out[label] = 'MISSING'; }
  }
  return out;
}

// Last few server-side errors, kept in memory (this process only). Exposed in
// the health JSON ONLY in prototype auth mode (KRIS_DEV_SESSION=1), which is
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
const { findRenames } = require('./envcheck');
const { takeToken } = require('./ratelimit');
const { LIMITS, METRICS, SOURCES } = require('./config');
const { readEnv: llmConfig, warmLLM, llmStatus, HISTORY_TURNS, HISTORY_CHARS, MESSAGE_CHARS } = require('./companion_src');
const { MODEL_LABEL } = require('./identity');
const { sanitizeProfile, addressName } = require('./profile');
const { sync } = require('./integrations/sync');

/**
 * The whole HTTP surface of K.R.1.S, written against plain objects instead
 * of any platform's request/response shape. This is the ONE place the logic
 * lives — server.js (plain Node, runs anywhere) and netlify/functions/*.js
 * (kept only for anyone who still wants Netlify) are both thin adapters over
 * this file. There is exactly one implementation to keep correct.
 *
 * Every function here takes and returns plain data:
 *   handleKris({ method, headers, body, env })  -> { statusCode, headers, body }
 *   handleSync({ method, headers, env })           -> { statusCode, headers, body }
 * `headers` in is a plain lowercase-keyed object; `body` in is a raw string;
 * `body` out is always a JSON string.
 */

let readPool;
let writePool;
let poolEnvKey = null; // detects a changed connection string (tests swap env)

function sslFor(env) {
  return env.KRIS_PG_SSL === 'false' ? false : { rejectUnauthorized: false };
}

/** How long to wait for a TCP+TLS connection before giving up (default 8s). */
/**
 * Turn a raw pg/network error into a short operator-facing cause. Each hint
 * names what to change; none includes the connection string, password, or
 * the raw message. Shown in the widget while KRIS_DIAGNOSTICS is not '0'.
 */
function classifyDbError(err) {
  const msg = String((err && err.message) || '');
  const code = String((err && err.code) || '');
  if (code === '28P01' || /password authentication failed/i.test(msg)) {
    return { code: 'DB_AUTH', hint: 'The database rejected the password. KRIS_READ_URL still has a wrong or placeholder password - replace [YOUR-PASSWORD] with the real one and URL-encode special characters (@ becomes %40).' };
  }
  if (/tenant or user not found/i.test(msg)) {
    return { code: 'DB_TENANT', hint: 'The pooler could not find the project. With the pooler host the username must be postgres.<project-ref>, not plain postgres.' };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { code: 'DB_DNS', hint: 'The database hostname could not be resolved - check the host part of KRIS_READ_URL for typos.' };
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
    return { code: 'DB_TLS', hint: 'TLS problem talking to the database. Leave KRIS_PG_SSL unset (the default accepts Supabase certificates).' };
  }
  if (code === '3D000') {
    return { code: 'DB_NAME', hint: 'The database name in KRIS_READ_URL does not exist (Supabase projects use "postgres").' };
  }
  if (code === '28000') {
    return { code: 'DB_ROLE', hint: 'That database role is not allowed to connect - check the username in KRIS_READ_URL.' };
  }
  const safe = msg.replace(/https?:\/\/\S+/g, '<url>').replace(/password.*/i, 'password ...').slice(0, 120);
  return { code: code || 'DB_ERROR', hint: safe || 'Unclassified database error - see server log.' };
}

function diagnosticsOn(env) {
  return String(env.KRIS_DIAGNOSTICS || '1') !== '0';
}

function typeErrorDetail(err) {
  const msg = String(err.message || '').replace(/https?:\/\/\S+/g, '<url>').slice(0, 160);
  const frame = String(err.stack || '').split('\n').map((l) => l.trim()).find((l) => /^at /.test(l)) || '';
  const m = frame.match(/([^\/\\\s(]+\.js):(\d+)/);
  return msg + (m ? ' @ ' + m[1] + ':' + m[2] : '');
}

function connectTimeoutMs(env) {
  const n = parseInt(env.KRIS_PG_CONNECT_TIMEOUT_MS || '8000', 10);
  return Number.isFinite(n) && n > 0 ? n : 8000;
}

/** Idle connections are kept (default 5 min) so the next data question skips the TCP + TLS + auth handshake. */
function idleMs(env) {
  const n = parseInt(env.KRIS_PG_IDLE_MS || '300000', 10);
  return Number.isFinite(n) && n >= 1000 ? n : 300000;
}

/** Read connections per server process (KRIS_PG_POOL_MAX, default 10). */
function poolMax(env) {
  const n = parseInt(env.KRIS_PG_POOL_MAX || '10', 10);
  return Number.isFinite(n) ? Math.min(100, Math.max(1, n)) : 10;
}

function makePool(connectionString, max, queryTimeout, env, label) {
  const pool = new Pool({
    connectionString,
    max,
    idleTimeoutMillis: idleMs(env),
    // pg's default is 0 = wait forever. Against a host that silently drops
    // packets (an IPv6-only endpoint from an IPv4 network, a firewall, a
    // wrong region) the request would hang until the platform killed it.
    connectionTimeoutMillis: connectTimeoutMs(env),
    // query_timeout is enforced CLIENT-side by node-postgres. statement_timeout
    // would be sent as a server startup parameter, which connection poolers
    // (Supavisor transaction mode, PgBouncer) can reject with
    // "unsupported startup parameter" - breaking every connection.
    query_timeout: queryTimeout,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    ssl: sslFor(env),
  });
  // An idle client that the pooler drops emits 'error' on the POOL. Without a
  // listener Node treats that as an unhandled 'error' event and the whole
  // process crashes. Log it; the pool discards the client and reconnects.
  pool.on('error', (err) => {
    console.error('kris: idle ' + label + ' connection dropped -', (err && err.message) || err);
  });
  return pool;
}

function pools(env) {
  const key = (env.KRIS_READ_URL || '') + '|' + (env.KRIS_WRITE_URL || '') + '|' + poolMax(env);
  if (key !== poolEnvKey) {
    if (readPool) readPool.end().catch(() => {});
    if (writePool) writePool.end().catch(() => {});
    readPool = null; writePool = null; poolEnvKey = key;
  }
  if (!writePool && env.KRIS_WRITE_URL) {
    writePool = makePool(env.KRIS_WRITE_URL, 2, 5000, env, 'writer');
  }
  if (!readPool) {
    if (!env.KRIS_READ_URL) {
      const e = new Error('KRIS_READ_URL is not set');
      e.code = 'DB_NOT_CONFIGURED';
      throw e;
    }
    readPool = makePool(env.KRIS_READ_URL, poolMax(env), LIMITS.statementTimeoutMs, env, 'reader');
  }
  return { readPool, writePool };
}

/** The read pool if configured, else null. Never throws. For background work. */
function readPoolOrNull(env) {
  try { return pools(env).readPool; } catch (_) { return null; }
}

/**
 * Open one database connection in the background so the first data question
 * does not pay for it, and keep one warm with a trivial query every few
 * minutes (poolers and NAT gateways drop idle TCP connections). Never blocks
 * a request, never throws. KRIS_PG_KEEPALIVE_MS=0 turns the ping off.
 */
let warmingDb = null;
let keepAliveTimer = null;
function warmDb(env) {
  if (!env.KRIS_READ_URL || warmingDb) return warmingDb;
  const pool = readPoolOrNull(env);
  if (!pool) return null;
  warmingDb = pool.query('SELECT 1').catch((err) => {
    recordError('database warm-up', err);
  }).then(() => { warmingDb = null; });
  const every = parseInt(env.KRIS_PG_KEEPALIVE_MS || '240000', 10);
  if (!keepAliveTimer && Number.isFinite(every) && every > 0) {
    keepAliveTimer = setInterval(() => {
      const p = readPoolOrNull(env);
      if (p && p.idleCount > 0) p.query('SELECT 1').catch(() => {});
    }, every);
    if (keepAliveTimer.unref) keepAliveTimer.unref();
  }
  return warmingDb;
}

/** Warm everything a first message might need: DB connection, model connection. */
function warmUp(env) {
  try { warmDb(env); } catch (_) { /* best-effort */ }
  try { warmLLM(env); } catch (_) { /* best-effort */ }
}

/**
 * Set to true once verifyToken() below checks real sessions. While it is
 * false, and prototype sign-in is off, every token is refused — and the 401
 * says so plainly ("sign-in isn't set up on this server") instead of telling
 * the user their session expired.
 */
const REAL_VERIFIER = false;

/**
 * Replace this with your real session check. Must return
 *   { userId, orgId, departments?, vesselIds? }   or   null.
 *
 * PROTOTYPE MODE — KRIS_DEV_SESSION=1
 *   Accepts an UNSIGNED token: base64 JSON like
 *     { "sub": "demo", "org": "geoserves", "departments": ["Emission"] }
 *   Convenient for demos. Trusts whatever the browser claims, so it must
 *   never be enabled on a site real users can reach.
 */
async function verifyToken(token, env) {
  if (env.KRIS_DEV_SESSION === '1') {
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

/**
 * The token may arrive in the Authorization header OR in the JSON body as
 * `token`. The widget sends it in the body with Content-Type text/plain: that
 * makes every message a CORS "simple request", so the browser sends it
 * immediately instead of first doing an OPTIONS preflight round trip.
 */
async function resolveSession(headers, env, bodyToken) {
  const auth = headers.authorization || headers.Authorization || '';
  let token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!token && typeof bodyToken === 'string' && bodyToken.length < 8192) token = bodyToken.trim();
  if (!token) return null;
  return verifyToken(token, env);
}

/** Why a request without a session was refused: the user, or the server. */
function refusal(headers, env, bodyToken) {
  const renames = findRenames(env);
  const hasToken = /^Bearer \S/.test(headers.authorization || '') || (typeof bodyToken === 'string' && bodyToken.trim() !== '');
  if (hasToken && env.KRIS_DEV_SESSION !== '1' && !REAL_VERIFIER) {
    return {
      status: 'unauthenticated',
      reason: 'auth_not_configured',
      text: 'I can\u2019t confirm who you are yet \u2014 sign-in isn\u2019t set up on this server. Your session is fine; nothing needs to be done on your side.',
      // Names only, never values. Shown under the message so whoever runs the
      // server can see the cause at a glance.
      detail: diagnosticsOn(env)
        ? (renames.length
          ? 'Server settings not renamed: ' + renames.map((r) => r.from + ' \u2192 ' + r.to).join(', ')
          : 'Server: set KRIS_DEV_SESSION=1 (prototype) or wire verifyToken()')
        : undefined,
    };
  }
  if (!hasToken) return { status: 'unauthenticated', reason: 'no_token', text: 'Sign in and I can look at your vessel data.' };
  return { status: 'unauthenticated', reason: 'session_rejected', text: 'Your sign-in wasn\u2019t accepted. Sign in again and ask me once more.' };
}

// --- CORS: works the same regardless of host --------------------------------
// KRIS_ALLOW_ORIGIN may be one origin, a comma-separated list, "*" for
// any origin, or a subdomain wildcard like "*.netlify.app" or
// "*.geoserves.com" \u2014 the last matches every subdomain (including Netlify's
// per-deploy preview URLs) under that domain, without matching arbitrary
// third-party sites the way a bare "*" would. Entries can be mixed freely:
// "https://perform.geoserves.com,*.netlify.app" is valid.
function allowedOriginsList(env) {
  return String(env.KRIS_ALLOW_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
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
    h['Access-Control-Max-Age'] = '7200';   // browsers cap this at 2h; preflights are rare anyway
    h['Access-Control-Expose-Headers'] = 'Server-Timing';
  }
  return h;
}

function safeAgentBuild() {
  try { return require('./agent').AGENT_BUILD || 'pre-2026-09-04'; } catch (_) { return 'missing'; }
}

function health(env) {
  const llm = llmConfig(env);
  const state = llmStatus();
  return {
    status: 'ok',
    service: 'kris',
    build: KRIS_BUILD,
    // Every file that matters reports its own stamp. If these disagree, a
    // deploy shipped a mix of old and new files - the exact failure mode a
    // copy/paste pipeline produces.
    builds: { httpHandler: KRIS_BUILD, router: router.ROUTER_BUILD || 'pre-2026-09-04', agent: safeAgentBuild() },
    database: !!env.KRIS_READ_URL,
    writer: !!env.KRIS_WRITE_URL,
    auth: env.KRIS_DEV_SESSION === '1' ? 'prototype' : 'production',
    // `label` is the only model name a page should show; `model` is for whoever runs the server.
    // `reachable` is the last probe or message: true, false, or null before the first one.
    companion: llm.enabled
      ? { provider: llm.provider, model: llm.model, label: MODEL_LABEL, url: llm.url ? '(configured)' : null, configured: llm.configured,
        reachable: state ? state.ok : null, problem: state && !state.ok ? state.code : undefined }
      : { enabled: false, label: MODEL_LABEL },
    sources: Object.values(SOURCES).map((s) => s.description),
    metrics: METRICS.filter((m) => !m.finerVersionOf).length,
    allowedOrigins: allowedOriginsList(env),
    mode: String(env.KRIS_MODE || 'agent'),
    features: { stream: true, bodyToken: true, fastLane: true, profile: true },
    diagnostics: diagnosticsOn(env),
    // Settings found under another prefix than KRIS_ — names only. Non-empty
    // means the server is running on defaults until they are renamed.
    renameNeeded: findRenames(env).map((r) => r.from + ' -> ' + r.to),
    node: process.version,
    recentErrors: env.KRIS_DEV_SESSION === '1' ? RECENT_ERRORS : undefined,
    files: env.KRIS_DEV_SESSION === '1' ? fileFingerprints() : undefined,
  };
}

/**
 * The page and person context the widget sends with every message. Nothing
 * about its shape is trusted: known keys only, every value capped. The
 * profile is what the user has allowed K.R.1.S to remember (see
 * src/profile.js) — it shapes how K.R.1.S talks and is never read by the
 * data engine.
 */
function readContext(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  // One line each: a newline in a name would let it pose as a new prompt section.
  const str = (v, max) => {
    if (v == null || typeof v === 'object') return null;
    const s = String(v).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
    return s || null;
  };
  const profile = sanitizeProfile(raw.profile);
  const userName = str(raw.userName, 60) || addressName(profile);
  return {
    vesselId: str(raw.vesselId, 40),
    vesselName: str(raw.vesselName, 80),
    userName: userName || null,
    page: str(raw.page, 80),
    tz: str(raw.tz, 64),
    locale: str(raw.locale, 16),
    profile: profile,
  };
}

/**
 * Whose message this is, for the rate limit. A signed-in user is their own
 * key. Prototype sign-in hands every visitor the same claims, so there (and
 * for any session without a user id) the visitor's address tells them apart:
 * the first X-Forwarded-For hop behind a proxy such as Render's, else the socket.
 */
function rateKey(session, headers, remote, env) {
  const who = (session.orgId || '') + ':' + (session.userId || '');
  if (env.KRIS_DEV_SESSION !== '1' && session.userId) return who;
  const addr = String(headers['x-forwarded-for'] || headers['x-real-ip'] || remote || '').split(',')[0].trim();
  return who + '|' + addr;
}

/**
 * Handle one request to the question endpoint.
 * @param {object} req  { method, headers (lowercase keys), body (raw string), env }
 */
async function handleKris(req) {
  const env = req.env || process.env;
  const headers = lowercaseKeys(req.headers || {});
  const origin = headers.origin || '';
  const cors = corsHeaders(origin, env);
  const reply = (statusCode, obj, extra) => ({ statusCode, headers: extra ? Object.assign({}, cors, extra) : cors, body: JSON.stringify(obj) });

  if (req.method === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  // GET doubles as the widget's warm-up ping: it answers at once and, in the
  // background, opens a database connection and the model connection so the
  // first real message pays for neither.
  if (req.method === 'GET') { warmUp(env); return reply(200, health(env)); }
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' });

  let payload;
  try { payload = JSON.parse(req.body || '{}'); }
  catch (_) { return reply(400, { error: 'Body must be JSON.' }); }

  const text = String(payload.text || '').slice(0, MESSAGE_CHARS);
  if (!text.trim()) return reply(400, { error: 'Ask a question.' });

  const t0 = Date.now();
  const streaming = payload.stream === true && typeof req.onEvent === 'function';

  let session;
  try {
    session = await resolveSession(headers, env, payload.token);
  } catch (err) {
    console.error('kris: auth error', err);
    return reply(500, { status: 'error', text: 'Authentication is misconfigured.' });
  }
  if (!session) return reply(401, refusal(headers, env, payload.token));

  // One user can't crowd everyone else out, or run up the model bill.
  const allowed = takeToken(rateKey(session, headers, req.remote, env), env);
  if (!allowed.ok) {
    return reply(429, {
      status: 'error', source: 'router', reason: 'rate_limited', code: 'RATE_LIMITED', retryAfter: allowed.retryAfter,
      text: 'You’re sending messages faster than I can answer them well. Give me ' + allowed.retryAfter + (allowed.retryAfter === 1 ? ' second' : ' seconds') + ' and ask again.',
    }, { 'Retry-After': String(allowed.retryAfter) });
  }

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
        console.error('kris: database connect failed', err);
        recordError('database connect', err);
        const d = classifyDbError(err);
        const e = (err && typeof err === 'object') ? err : new Error(String(err));
        e.krisCode = d.code;     // never carries secrets
        e.krisHint = d.hint;
        lastDbError = e;
        throw e;                    // router turns this into a plain answer
      }
      throw err;
    }
    return client;
  };
  const releaseDb = function () {
    if (!client) return;
    const c = client;
    client = null;
    try { c.release(); } catch (_) { /* already gone */ }
  };
  const wp = writePoolIfConfigured(env);

  // Client went away (stop button, closed tab): cancel model work.
  const signal = req.signal || undefined;

  try {
    const out = await router.route(
      {
        text,
        session,
        pending: payload.pending || null,
        now: new Date(),
        // History arrives from the browser; trust nothing about its shape.
        history: Array.isArray(payload.history)
          ? payload.history.filter((h) => h && typeof h === 'object').slice(-HISTORY_TURNS)
              .map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', text: String(h.text || '').slice(0, HISTORY_CHARS) }))
          : null,
        context: readContext(payload.context),
      },
      getDb,
      {
        orgId: session.orgId, writeDb: wp, dateOrder: env.KRIS_DATE_ORDER || 'DMY', env,
        // Reuse RBAC scope + vocabulary for a minute; refresh caches in the
        // background on the pool, never on this request's connection.
        scopeCache: true,
        pool: () => readPoolOrNull(env),
        releaseDb,
        signal,
        onDelta: streaming ? (evt) => { try { req.onEvent(evt); } catch (_) { /* client gone */ } } : undefined,
      }
    );
    const ms = Date.now() - t0;
    out.ms = ms;

    if (out.provenance && env.KRIS_EXPOSE_SQL !== '1') {
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
      console.error('kris: error surfaced to user -', out.source || 'unknown', out.reason || '', '-', out.error);
      recordError('router:' + (out.reason || out.source || ''), { name: 'Error', message: out.error });
      delete out.error;
    }
    delete out.model; // the backend model id never reaches the browser; pages show MODEL_LABEL
    if (out.status === 'error') {
      out.build = KRIS_BUILD;
      // Belt and braces: if the router did not attach the cause (older
      // router.js), attach it here from the connection error we saw.
      if (!out.code && lastDbError && /^db_/.test(out.reason || '')) {
        out.code = lastDbError.krisCode;
        out.detail = lastDbError.krisHint;
      }
      // A mixed deploy (new handler, old router) is the failure mode a copy /
      // paste pipeline produces. Say so on the card instead of hiding it.
      const rb = router.ROUTER_BUILD || 'pre-2026-09-04';
      if (rb !== KRIS_BUILD) {
        out.detail = (out.detail ? out.detail + ' | ' : '') + 'FILES OUT OF SYNC: router.js is build ' + rb + ', httpHandler.js is ' + KRIS_BUILD + ' - redeploy every file from the same delivery.';
      }
      if (!diagnosticsOn(env)) { delete out.detail; delete out.code; }
    }
    // A database problem is reported as 503 so monitoring can see it, but only
    // for the message that actually needed the database.
    const status = out.status === 'error' && /^db_|^query_failed$/.test(out.reason || '') ? 503 : 200;
    const r = reply(status, out);
    r.headers = Object.assign({}, r.headers, { 'Server-Timing': 'kris;desc="' + String(out.source || 'route') + '";dur=' + ms });
    return r;
  } catch (err) {
    console.error('kris: query failed', err);
    recordError('handleKris catch-all', err, { text: String(text || '').slice(0, 80) });
    // The error's class/code is safe to expose and is often all that is needed
    // to diagnose from a screenshot; the message itself stays in the log.
    return reply(500, {
      status: 'error',
      text: 'Something went wrong on my side. Nothing was changed \u2014 please try again in a moment.',
      build: KRIS_BUILD,
      code: String((err && (err.code || err.name)) || 'Error').slice(0, 40),
      // A TypeError is a programming error, not a data error: its message
      // ("x is not a function", "cannot read properties of undefined") never
      // carries user data or credentials, and the top stack frame (file:line,
      // basename only) is exactly what is needed to fix it from a screenshot.
      detail: (err instanceof TypeError && diagnosticsOn(env)) ? typeErrorDetail(err) : undefined,
    });
  } finally {
    releaseDb();
  }
}

/** The writer pool is only for vocabulary and logging; never a reason to fail a request. */
function writePoolIfConfigured(env) {
  if (!env.KRIS_WRITE_URL) return null;
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

  const key = headers['x-kris-sync-key'];
  if (!env.KRIS_SYNC_KEY || key !== env.KRIS_SYNC_KEY) {
    return reply(401, { error: 'sync key required' });
  }
  if (!env.KRIS_WRITE_URL) return reply(400, { error: 'KRIS_WRITE_URL is not set' });

  const { Client } = require('pg');
  const db = new Client({ connectionString: env.KRIS_WRITE_URL, ssl: sslFor(env) });
  await db.connect();
  try {
    const stats = await sync({ db, env, log: (m) => console.log('kris-sync:', m) });
    return reply(200, stats);
  } catch (err) {
    console.error('kris-sync failed', err);
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

module.exports = { handleKris, handleSync, health, corsHeaders, verifyToken, resolveSession, allowedOriginsList, classifyDbError, warmUp, readPoolOrNull, readContext, KRIS_BUILD };