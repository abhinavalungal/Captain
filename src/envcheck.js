'use strict';

/**
 * Environment check — catches settings that are present under a different
 * prefix than the one this build reads.
 *
 * Every setting is read as KRIS_<NAME>. When a host still carries a whole
 * family of settings under another prefix (for example after a rename), the
 * server starts, answers the health check, and then quietly runs on defaults:
 * no database, production sign-in, the default model. Every signed-in question
 * is refused with a 401 and nothing in the logs says why.
 *
 * findRenames() reports those settings — names only, never values — so the
 * server can say so at startup and in GET /api/kris.
 */

const PREFIX = 'KRIS_';

// Every setting this build reads, without the prefix.
const SETTINGS = [
  'READ_URL', 'WRITE_URL', 'PG_SSL', 'PG_IDLE_MS', 'PG_KEEPALIVE_MS', 'PG_CONNECT_TIMEOUT_MS',
  'DEV_SESSION', 'ALLOW_ORIGIN', 'APP_NAME', 'DATE_ORDER', 'EXPOSE_SQL', 'DIAGNOSTICS', 'MODE',
  'ENABLE_LLM', 'LLM_PROVIDER', 'LLM_URL', 'LLM_MODEL', 'LLM_API_KEY', 'LLM_TIMEOUT_MS',
  'LLM_FAST_MODEL', 'LLM_FAST_TIMEOUT_MS', 'LLM_KEEP_ALIVE', 'LLM_PROVIDER_SORT', 'LLM_REASONING',
  'LLM_REASONING_EFFORT', 'LLM_REFERER', 'LLM_TITLE', 'SMALLTALK_MODEL',
  'AGENT_DIRECT_DATA', 'AGENT_FALLBACK', 'AGENT_MAX_STEPS', 'AGENT_MAX_TOKENS', 'AGENT_MODEL',
  'AGENT_TEMPERATURE', 'AGENT_TIMEOUT_MS',
  'SYNC_KEY', 'SYNC_DAYS', 'SYNC_INTERVAL_MS', 'AUTO_SYNC', 'IMOS', 'FIELD_MAP',
];
const KNOWN = new Set(SETTINGS);

// Upstream integrations have their own prefixes by design.
const NOT_OURS = new Set(['VESON', 'GEOFORM']);

// A prefix only counts when it carries at least this many of our settings, so
// an unrelated variable that happens to end in _MODE or _IMOS is ignored.
const MIN_FAMILY = 3;

/**
 * @param {object} env
 * @returns {{ from: string, to: string }[]}  settings to rename, sorted
 */
function findRenames(env) {
  const byPrefix = new Map();
  for (const key of Object.keys(env || {})) {
    if (key.startsWith(PREFIX)) continue;
    const m = /^([A-Z][A-Z0-9]*)_(.+)$/.exec(key);
    if (!m || NOT_OURS.has(m[1])) continue;
    // Match the longest known setting the key ends with, so LLM_FAST_MODEL is
    // not mistaken for FAST_MODEL or MODEL.
    let prefix = m[1]; let rest = m[2];
    while (!KNOWN.has(rest)) {
      const n = /^([A-Z0-9]+)_(.+)$/.exec(rest);
      if (!n) { rest = null; break; }
      prefix += '_' + n[1]; rest = n[2];
    }
    if (!rest) continue;
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push(rest);
  }
  const out = [];
  for (const [prefix, names] of byPrefix) {
    if (names.length < MIN_FAMILY) continue;
    for (const name of names) {
      if (env[PREFIX + name] === undefined) out.push({ from: prefix + '_' + name, to: PREFIX + name });
    }
  }
  return out.sort((a, b) => a.to.localeCompare(b.to));
}

module.exports = { findRenames, SETTINGS, PREFIX };
