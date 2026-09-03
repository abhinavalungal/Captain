'use strict';

/**
 * Upstream clients.
 *
 * Both are server-side only. Tokens come from the environment and are sent
 * from the Netlify function or the sync script, never from the browser. The
 * widget has no knowledge these APIs exist.
 *
 * `fetchImpl` is injectable so the sync can be tested without network access.
 */

const DEFAULT_TIMEOUT_MS = 60000;

class UpstreamError extends Error {
  constructor(source, status, detail) {
    super(`${source} request failed${status ? ` (${status})` : ''}${detail ? `: ${detail}` : ''}`);
    this.source = source;
    this.status = status;
  }
}

async function getJson(url, { headers = {}, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, source = 'upstream' } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('No fetch implementation available (Node 18+ required)');
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetchImpl(url, { headers: Object.assign({ Accept: 'application/json' }, headers), signal: ctrl ? ctrl.signal : undefined });
  } catch (e) {
    throw new UpstreamError(source, null, e.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : e.message);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) throw new UpstreamError(source, res.status, text.slice(0, 200));
  try { return JSON.parse(text); }
  catch (_) { throw new UpstreamError(source, res.status, 'response was not JSON: ' + text.slice(0, 120)); }
}

/**
 * Report APIs wrap rows in different envelopes. Find the array of records
 * wherever it is, and refuse to guess if there is more than one candidate.
 */
function extractRows(payload, source) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    for (const k of ['data', 'rows', 'results', 'items', 'records', 'value', 'forms', 'Forms', 'Data', 'result']) {
      if (Array.isArray(payload[k])) return payload[k];
      if (payload[k] && typeof payload[k] === 'object') {
        const inner = extractRows(payload[k], source);
        if (inner.length || Array.isArray(payload[k])) return inner;
      }
    }
    const arrays = Object.entries(payload).filter(([, v]) => Array.isArray(v));
    if (arrays.length === 1) return arrays[0][1];
    if (arrays.length > 1) {
      throw new UpstreamError(source, null, `ambiguous envelope: several arrays (${arrays.map(([k]) => k).join(', ')}) — set the key in extractRows`);
    }
  }
  return [];
}

// --- Veson IMOS -------------------------------------------------------------

function vesonUrl(base, token, params = {}) {
  const u = new URL(base);
  // The token may already be baked into the configured URL; only add if absent.
  if (!u.searchParams.get('apiToken')) u.searchParams.set('apiToken', token);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, v);
  return u.toString();
}

function vesonClient(env = process.env, fetchImpl) {
  const token = env.VESON_API_TOKEN;
  const legBase = env.VESON_LEGWISE_API;
  const offBase = env.VESON_OFFHIRE_API;
  if (!token) throw new Error('VESON_API_TOKEN is not set');
  if (!legBase) throw new Error('VESON_LEGWISE_API is not set');
  if (!offBase) throw new Error('VESON_OFFHIRE_API is not set');

  const redact = (url) => url.replace(/apiToken=[^&]+/, 'apiToken=***');

  return {
    async legWise(params = {}) {
      const url = vesonUrl(legBase, token, params);
      const payload = await getJson(url, { fetchImpl, source: 'Veson leg-wise' });
      return { rows: extractRows(payload, 'Veson leg-wise'), url: redact(url) };
    },
    async offHire(params = {}) {
      const url = vesonUrl(offBase, token, params);
      const payload = await getJson(url, { fetchImpl, source: 'Veson off-hire' });
      return { rows: extractRows(payload, 'Veson off-hire'), url: redact(url) };
    },
  };
}

// --- Geoform ----------------------------------------------------------------

function geoformClient(env = process.env, fetchImpl) {
  const base = env.GEOFORM_API;
  const key = env.GEOFORM_API_KEY;
  const header = env.GEOFORM_API_KEY_HEADER || 'library-api';
  if (!base) throw new Error('GEOFORM_API is not set');
  if (!key) throw new Error('GEOFORM_API_KEY is not set');

  return {
    /**
     * @param {string} imo
     * @param {string} fromDate YYYY-MM-DD
     * @param {string} toDate   YYYY-MM-DD
     */
    async forms(imo, fromDate, toDate) {
      const u = new URL(base);
      u.searchParams.set('imo', imo);
      u.searchParams.set('fromDate', fromDate);
      u.searchParams.set('toDate', toDate);
      const payload = await getJson(u.toString(), { fetchImpl, headers: { [header]: key }, source: `Geoform (${imo})` });
      return { rows: extractRows(payload, 'Geoform'), url: u.toString() };
    },
  };
}

module.exports = { vesonClient, geoformClient, getJson, extractRows, UpstreamError };
