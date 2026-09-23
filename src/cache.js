'use strict';

/**
 * Small in-process caches that keep the database off the critical path.
 *
 *   ttlCache({ ttlMs, staleMs, max })
 *     .get(key)                    -> fresh value or undefined (never blocks)
 *     .peek(key)                   -> fresh OR stale value, or undefined
 *     .load(key, loader)           -> Promise of a value: fresh hit, else one
 *                                     shared in-flight load (concurrent callers
 *                                     never trigger duplicate queries)
 *     .refresh(key, loader)        -> fire-and-forget background load
 *     .set / .delete / .clear
 *
 * Two caches are shared across the whole process:
 *
 *   scopeCache    RBAC scope per session shape (vessel list for a user's
 *                 departments / allow-list). Every data question used to run
 *                 this SELECT first; now it runs at most once a minute per
 *                 distinct scope.
 *   learnedCache  learned vocabulary per organisation (kris_term_mappings).
 *
 * Nothing here ever holds a figure from an operational table — only the list
 * of vessels a user may see and the org's vocabulary. Values are per process
 * and vanish on restart, which is the correct failure mode.
 */

function ttlCache(opts = {}) {
  const ttlMs = opts.ttlMs || 60000;
  const staleMs = opts.staleMs != null ? opts.staleMs : ttlMs * 10;
  const max = opts.max || 500;
  const map = new Map();       // key -> { value, at }
  const inflight = new Map();  // key -> Promise

  function prune() {
    if (map.size <= max) return;
    const drop = map.size - max;
    let i = 0;
    for (const k of map.keys()) { map.delete(k); if (++i >= drop) break; }
  }

  const api = {
    get(key) {
      const hit = map.get(key);
      return hit && Date.now() - hit.at < ttlMs ? hit.value : undefined;
    },
    peek(key) {
      const hit = map.get(key);
      return hit && Date.now() - hit.at < ttlMs + staleMs ? hit.value : undefined;
    },
    set(key, value) { map.delete(key); map.set(key, { value, at: Date.now() }); prune(); return value; },
    delete(key) { map.delete(key); inflight.delete(key); },
    clear() { map.clear(); inflight.clear(); },
    load(key, loader) {
      const fresh = api.get(key);
      if (fresh !== undefined) return Promise.resolve(fresh);
      if (inflight.has(key)) return inflight.get(key);
      const p = Promise.resolve().then(loader).then(
        (v) => { inflight.delete(key); api.set(key, v); return v; },
        (e) => { inflight.delete(key); throw e; }
      );
      inflight.set(key, p);
      return p;
    },
    refresh(key, loader) {
      if (inflight.has(key) || api.get(key) !== undefined) return;
      api.load(key, loader).catch(() => { /* background: a miss is not an error */ });
    },
    get size() { return map.size; },
  };
  return api;
}

const scopeCache = ttlCache({ ttlMs: 60000, staleMs: 9 * 60000, max: 1000 });
const learnedCache = ttlCache({ ttlMs: 60000, staleMs: 9 * 60000, max: 200 });

/** Stable cache key for a session's data scope (not its identity). */
function scopeKey(session) {
  if (!session) return 'anon';
  const ids = Array.isArray(session.vesselIds) ? session.vesselIds.map(String).sort() : [];
  const deps = Array.isArray(session.departments) ? session.departments.map(String).sort() : [];
  return (session.orgId || '') + '|v:' + ids.join(',') + '|d:' + deps.join(',');
}

module.exports = { ttlCache, scopeCache, learnedCache, scopeKey };
