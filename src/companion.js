'use strict';

/**
 * The companion layer — conversation and app guidance, running on a model you
 * host yourself. No paid API is involved anywhere in this file.
 *
 * Supported backends (all open-source, all free):
 *
 *   ollama          Ollama's native /api/chat            (default)
 *   openai_compat   any OpenAI-compatible /v1/chat/completions server:
 *                   vLLM, llama.cpp server, LM Studio, LocalAI, text-generation-webui
 *
 * Pick with CAPTAIN_LLM_PROVIDER, point at it with CAPTAIN_LLM_URL, choose a
 * model with CAPTAIN_LLM_MODEL. Nothing here is specific to a vendor.
 *
 * This module is never the path for a vessel figure — the router only reaches
 * it after the data parser and the guide matcher have both had a turn. Two
 * independent guarantees back that up:
 *
 *   1. STRUCTURAL: converse() receives no database handle and no query tool.
 *      Nothing here can execute SQL. It can only ever fabricate a number,
 *      never retrieve one.
 *
 *   2. DEFENSIVE: every reply is scanned before it is returned. A number next
 *      to a unit token, or a suspicious bare number, is treated as a stated
 *      measurement and the whole reply is replaced with a fixed redirect.
 *      This holds even if the model ignores its instructions, and it is
 *      unit-tested directly.
 */

const DEFAULTS = {
  provider: 'ollama',
  url: 'http://127.0.0.1:11434',
  model: 'llama3.1:8b',
  timeoutMs: 25000,
  maxTokens: 320,
  temperature: 0.4,
};

// Unit tokens that make a nearby number look like a stated vessel figure.
const UNIT_WORDS = [
  'kw', 'mt', 'nm', 'kn', 'knots', 'rpm', 'gco2e', 'gco2', 'co2', '%',
  'hours?', 'days?', 'mj', 'tonnes?', 'tons?', 'liters?', 'litres?', 'legs?',
];
const FIGURE_RE = new RegExp(
  String.raw`(?<![\w.])\d[\d,]*(?:\.\d+)?\s*(?:${UNIT_WORDS.join('|')})\b`, 'i'
);
// A grouped or decimal bare number is suspicious too — Captain has no reason
// to state one in conversation.
const BARE_NUMBER_RE = /(?<![\w.])\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\w])|(?<![\w.])\d+\.\d+(?![\w])/;

function containsStatedFigure(text) {
  return FIGURE_RE.test(text) || BARE_NUMBER_RE.test(text);
}

const SAFE_REDIRECT =
  "I don't want to guess at a number in conversation \u2014 ask me directly (for example \"fuel consumption for <vessel> last month\") and I'll pull it from the records.";

const UNAVAILABLE =
  "I couldn't reach the conversation service just now \u2014 I can still answer vessel questions and app questions, so ask away.";

function systemPrompt(opts) {
  const guideBlock = opts.guideSnippets.length
    ? '\n\nRelevant help-center entries (use only these for app-navigation questions; do not invent features):\n'
      + opts.guideSnippets.map(function (g) { return '- ' + g.title + ': ' + g.answer; }).join('\n')
    : '';
  const ctx = opts.context && opts.context.vesselName
    ? '\n\nThe user is currently viewing the vessel "' + opts.context.vesselName + '" in the app. You may refer to it by name; you still must not state any figure about it.'
    : '';

  return 'You are Captain, the assistant built into ' + opts.appName + ', a maritime compliance and fleet-analytics application. You help users find their way around the app and answer general questions in a warm, brief, professional tone \u2014 like an experienced, trustworthy ship\'s captain.\n\n'
    + 'HARD RULE: you have no access to vessel data and must never state, estimate, or guess any numeric measurement, statistic, or figure about a vessel (fuel, power, speed, distance, emissions, compliance balance, off-hire, counts, percentages \u2014 anything that could have come from vessel records). If the user asks for one, do not answer it yourself: tell them to ask you directly as a data question and give one example in their phrasing, then stop. A wrong or invented number is worse than no answer.\n\n'
    + 'Keep replies to two or three sentences unless a short list is clearly needed. Do not claim to have looked anything up. Plain text only, no markdown headers.' + guideBlock + ctx;
}

function readEnv(env) {
  return {
    provider: (env.CAPTAIN_LLM_PROVIDER || DEFAULTS.provider).toLowerCase(),
    url: (env.CAPTAIN_LLM_URL || DEFAULTS.url).replace(/\/+$/, ''),
    model: env.CAPTAIN_LLM_MODEL || DEFAULTS.model,
    apiKey: env.CAPTAIN_LLM_API_KEY || null,   // only for self-hosted servers that require one; never a vendor key
    enabled: env.CAPTAIN_ENABLE_LLM !== '0',
    timeoutMs: parseInt(env.CAPTAIN_LLM_TIMEOUT_MS || String(DEFAULTS.timeoutMs), 10),
    appName: env.CAPTAIN_APP_NAME || 'this application',
  };
}

function buildRequest(cfg, system, messages) {
  if (cfg.provider === 'openai_compat') {
    return {
      url: cfg.url + '/v1/chat/completions',
      headers: Object.assign({ 'Content-Type': 'application/json' }, cfg.apiKey ? { Authorization: 'Bearer ' + cfg.apiKey } : {}),
      body: {
        model: cfg.model,
        messages: [{ role: 'system', content: system }].concat(messages),
        max_tokens: DEFAULTS.maxTokens,
        temperature: DEFAULTS.temperature,
        stream: false,
      },
      extract: function (data) {
        const c = data && data.choices && data.choices[0];
        return c && c.message && typeof c.message.content === 'string' ? c.message.content : '';
      },
    };
  }
  // Ollama native
  return {
    url: cfg.url + '/api/chat',
    headers: { 'Content-Type': 'application/json' },
    body: {
      model: cfg.model,
      messages: [{ role: 'system', content: system }].concat(messages),
      stream: false,
      options: { temperature: DEFAULTS.temperature, num_predict: DEFAULTS.maxTokens },
    },
    extract: function (data) {
      return data && data.message && typeof data.message.content === 'string' ? data.message.content : '';
    },
  };
}

/**
 * @param {string} text
 * @param {object} opts  { env, guideSnippets, history, context, fetchImpl }
 * @returns {Promise<{ text, blocked, disabled?, error?, provider?, model? }>}
 */
async function converse(text, opts) {
  opts = opts || {};
  const cfg = readEnv(opts.env || process.env);
  if (!cfg.enabled) {
    return { text: 'I can help with vessel data and app questions \u2014 what would you like to know?', blocked: false, disabled: true };
  }

  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const messages = (opts.history || [])
    .slice(-6)
    .map(function (h) { return { role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.text || '').slice(0, 500) }; })
    .concat([{ role: 'user', content: String(text || '').slice(0, 1000) }]);

  const system = systemPrompt({ appName: cfg.appName, guideSnippets: opts.guideSnippets || [], context: opts.context });
  const req = buildRequest(cfg, system, messages);
  // No tools field in either request shape. That is the structural guarantee.

  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, cfg.timeoutMs) : null;

  let res;
  try {
    res = await fetchImpl(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: ctrl ? ctrl.signal : undefined });
  } catch (e) {
    if (timer) clearTimeout(timer);
    return { text: UNAVAILABLE, blocked: false, error: e.name === 'AbortError' ? 'timed out after ' + cfg.timeoutMs + 'ms' : e.message, provider: cfg.provider, model: cfg.model };
  }
  if (timer) clearTimeout(timer);

  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch (_) { /* ignore */ }
    return { text: UNAVAILABLE, blocked: false, error: 'HTTP ' + res.status + ': ' + detail.slice(0, 150), provider: cfg.provider, model: cfg.model };
  }

  let data;
  try { data = await res.json(); } catch (_) { return { text: UNAVAILABLE, blocked: false, error: 'non-JSON response', provider: cfg.provider, model: cfg.model }; }

  const raw = (req.extract(data) || '').trim();
  if (!raw) return { text: SAFE_REDIRECT, blocked: true, provider: cfg.provider, model: cfg.model };
  if (containsStatedFigure(raw)) return { text: SAFE_REDIRECT, blocked: true, rawBlocked: raw, provider: cfg.provider, model: cfg.model };
  return { text: raw, blocked: false, provider: cfg.provider, model: cfg.model };
}

module.exports = { converse: converse, containsStatedFigure: containsStatedFigure, systemPrompt: systemPrompt, buildRequest: buildRequest, readEnv: readEnv, SAFE_REDIRECT: SAFE_REDIRECT, DEFAULTS: DEFAULTS };
