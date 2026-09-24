'use strict';

/**
 * A per-user message limit: one token bucket per signed-in user, in this
 * process's memory. KRIS_RATE_PER_MIN messages a minute (default 20, 0 turns
 * it off), with a burst of the same size. It keeps one user, or one stuck
 * script, from running up the model bill or crowding everyone else out.
 *
 * With several server instances each keeps its own count, so the effective
 * limit is per instance; a load balancer with sticky sessions keeps it exact.
 */
const buckets = new Map();
let lastSweep = 0;

/** @returns {{ ok: true } | { ok: false, retryAfter: number }}  retryAfter in seconds */
function takeToken(key, env, now) {
  const raw = env && env.KRIS_RATE_PER_MIN;
  const perMin = raw == null || raw === '' ? 20 : parseInt(raw, 10);
  if (!(perMin > 0)) return { ok: true };
  now = now || Date.now();
  let b = buckets.get(key);
  if (!b) { b = { tokens: perMin, at: now }; buckets.set(key, b); }
  b.tokens = Math.min(perMin, b.tokens + ((now - b.at) * perMin) / 60000);
  b.at = now;
  sweep(now);
  if (b.tokens >= 1) { b.tokens -= 1; return { ok: true }; }
  return { ok: false, retryAfter: Math.max(1, Math.ceil(((1 - b.tokens) * 60) / perMin)) };
}

/** Forget users idle for two minutes (their bucket is full again by then anyway). */
function sweep(now) {
  if (now - lastSweep < 30000) return;
  lastSweep = now;
  for (const [k, b] of buckets) if (now - b.at > 120000) buckets.delete(k);
}

module.exports = { takeToken, _buckets: buckets };
