'use strict';

const { profilePrompt } = require('./profile');

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
 * Pick with KRIS_LLM_PROVIDER, point at it with KRIS_LLM_URL, choose a
 * model with KRIS_LLM_MODEL. Nothing here is specific to a vendor.
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

const { readSSE, readNDJSON, SentenceGate, anySignal } = require('./stream');

const DEFAULTS = {
  provider: 'ollama',
  url: 'http://127.0.0.1:11434',
  model: 'K.R.1.S',
  timeoutMs: 30000,
  maxTokens: 700,
  temperature: 0.4,
  // Light messages get a small, fast model, a tight token budget and a short
  // timeout — a quick question should never wait on a frontier model.
  fastTimeoutMs: 12000,
  fastMaxTokens: 220,
  // Reasoning models: ask for the LOWEST effort rather than "off". Some models
  // (e.g. GLM-5.3-flash on OpenRouter) have reasoning marked mandatory and
  // default to MAX effort; "enabled: false" is rejected or ignored there and
  // every reply then thinks for tens of seconds. "low" + "exclude" is honoured
  // by both mandatory and optional reasoning models.
  reasoningEffort: 'low',
};

/**
 * The output guard. Its ONLY job is to stop the model presenting a figure as
 * if it were one of the user's vessel records. It is deliberately not a ban on
 * numbers: arithmetic, science, dates, prices, general maritime facts ("a
 * VLCC typically burns 80-100 tonnes a day") and comparisons of numbers the
 * user supplied are all legitimate and pass through.
 *
 * A sentence is blocked only when BOTH hold:
 *   1. it contains a number next to a maritime measurement unit, and
 *   2. it attributes that number to the user's own fleet — "your vessel",
 *      "the ship", a vessel name the page told us about, this fleet, etc.
 *
 * Off-hire and compliance figures use generic units (hours, %), so those are
 * caught by their own keywords rather than by unit.
 */
const MARITIME_UNIT_RE = /(?<![\w.])\d[\d,]*(?:\.\d+)?\s*(?:kw|mw|mt|t\b|tonnes?|tons?|nm|kn|knots|rpm|gco2e|gco2|mj|litres?|liters?)\b/i;
// "your vessel", "the ship", "the fleet" — or a possessive stuck straight onto a
// metric: "your fuel consumption", "our shaft power". Both mean THEIR data.
const OWN_FLEET_RE = new RegExp(
  '\\b(?:your|our|my)\\s+(?:vessels?|ships?|fleet|voyage|legs?)\\b'
  + '|\\b(?:this|that|the)\\s+(?:vessel|ship)\\b'
  + '|\\byour\\b.*\\b(?:vessel|ship|fleet)\\b|\\b(?:vessel|ship|fleet)\\b.*\\byour\\b'
  + '|\\bthe fleet\\b'
  + '|\\b(?:your|our|my)\\s+(?:\\w+\\s+){0,2}?(?:shaft power|power|fuel|consumption|speed|distance|emissions?|co2|rpm|off.?hire|compliance|intensity|balance)\\b',
  'i'
);
const SPECIAL_FIGURE_RE = /(?<![\w.])\d[\d,]*(?:\.\d+)?\s*(?:[a-z-]+\s+)?(?:%|hours?|hrs?|days?)\b/i;
const SPECIAL_CONTEXT_RE = /\b(?:off.?hire|compliance balance|eu scope|ghg intensity|fueleu)\b/i;

function containsStatedFigure(text, vesselNames) {
  const names = (vesselNames || []).map(function (n) { return String(n).toLowerCase(); }).filter(function (n) { return n.length >= 3; });
  const sentences = String(text || '').split(/(?<=[.!?])\s+|\n+/);
  for (const sRaw of sentences) {
    const s = sRaw.toLowerCase();
    const namesHere = names.some(function (n) { return s.includes(n); });
    const ownFleet = OWN_FLEET_RE.test(sRaw) || namesHere;
    if (MARITIME_UNIT_RE.test(sRaw) && ownFleet) return true;
    if (SPECIAL_FIGURE_RE.test(sRaw) && SPECIAL_CONTEXT_RE.test(sRaw) && ownFleet) return true;
  }
  return false;
}

/**
 * Charts from conversation. When a chart would help and the numbers came from
 * the user (or from arithmetic on them), the model ends its reply with one
 * line:  CHART {"type":"bar","title":"...","labels":[...],"values":[...],"unit":"..."}
 * We pull that line out, validate it strictly, and return it as data for the
 * widget to draw. Anything malformed is dropped silently — the prose still
 * stands on its own.
 */
const CHART_LINE_RE = /^\s*CHART\s+(\{[\s\S]*\})\s*$/m;

function extractChart(text) {
  const m = String(text || '').match(CHART_LINE_RE);
  if (!m) return { text: text, chart: null };
  let spec;
  try { spec = JSON.parse(m[1]); } catch (_) { return { text: text.replace(CHART_LINE_RE, '').trim(), chart: null }; }
  const type = spec.type === 'line' ? 'line' : 'bar';
  const labels = Array.isArray(spec.labels) ? spec.labels.map(function (l) { return String(l).slice(0, 40); }) : null;
  const values = Array.isArray(spec.values) ? spec.values.map(Number) : null;
  const ok = labels && values && labels.length === values.length && values.length >= 2 && values.length <= 24
    && values.every(function (v) { return Number.isFinite(v); });
  const chart = ok ? { type: type, title: String(spec.title || '').slice(0, 80), labels: labels, values: values, unit: String(spec.unit || '').slice(0, 16) } : null;
  return { text: text.replace(CHART_LINE_RE, '').trim(), chart: chart };
}

const SAFE_REDIRECT =
  "I don't want to guess at a number in conversation \u2014 ask me directly (for example \"fuel consumption for <vessel> last month\") and I'll pull it from the records.";

const UNAVAILABLE =
  "I couldn't reach the conversation service just now \u2014 I can still answer vessel questions and app questions, so ask away.";

function systemPrompt(opts) {
  const guideBlock = opts.guideSnippets.length
    ? '\n\nRelevant help-center entries for questions about the app itself (use only these for app-navigation questions; do not invent features):\n'
      + opts.guideSnippets.map(function (g) { return '- ' + g.title + ': ' + g.answer; }).join('\n')
    : '';
  const ctx = opts.context && opts.context.vesselName
    ? '\n\nThe user is currently viewing the vessel "' + opts.context.vesselName + '" in the app. You may refer to it by name, but you have no data about it.'
    : '';
  const think = opts.reasoningOff ? '/no_think\n\n' : '';
  const nowLine = opts.nowLabel
    ? '\n\nCurrent date and time: ' + opts.nowLabel + '. Use this for anything about today, dates, deadlines or elapsed time. Never say you do not know the date or time. You do not have live news or prices; if asked about current events, say your knowledge may be out of date rather than guessing.'
    : '';

  const userLine = opts.userName
    ? '\n\nThe user\'s name is ' + opts.userName + '. Address them by name occasionally and naturally \u2014 not in every reply.'
    : '';
  const about = profilePrompt(opts.profile);
  const profileBlock = about ? '\n\n' + about : '';

  return think
    + 'You are K.R.1.S (say it "Kris"), the assistant built into ' + opts.appName + ', a maritime compliance and fleet-analytics application. Your name is K.R.1.S; if asked, say so. K.R.1.S is a codename inspired by Lord Krishna, the calm charioteer who guides without taking the wheel. You are a capable general assistant in that spirit: serene, warm, clear-sighted and gently playful, never preachy. Do not quote scripture or make religious claims unless the user raises the subject, and treat it with respect when they do.\n\n'
    + 'Answer whatever the user actually asks. General knowledge, explanations of concepts (maritime or otherwise), arithmetic and unit conversions, comparing numbers the user gives you, writing help, and questions about how to use the app are all yours to answer fully and well. Do not steer unrelated questions back to vessels or emissions. Match the depth to the question: one line for a quick fact, a short structured answer for something that needs it. Show working for calculations.\n\n'
    + 'THE ONE RULE: you have no access to this user\'s vessel records. Never state, estimate or guess a figure as if it were one of their vessels\' actual values (their fuel, power, speed, distance, emissions, compliance balance, off-hire, counts). General maritime facts are fine ("a Panamax bulker might burn 30 tonnes a day"); a claim about THEIR ship is not. If they ask for one of their own figures, say you\'ll need to look it up and tell them to ask it directly as a data question, e.g. "fuel consumption for <vessel> last month". Never present a guess as their data.\n\n'
    + 'Charts: when a chart would genuinely help and every number came from the user or from your own arithmetic on their numbers, end your reply with exactly one line in this form and nothing after it:\n'
    + 'CHART {"type":"bar","title":"...","labels":["A","B"],"values":[1,2],"unit":""}\n'
    + '(type is "bar" or "line"; 2 to 24 points). Do not add a chart to answers that don\'t need one.\n\n'
    + (opts.light && !(opts.profile && opts.profile.style && opts.profile.style.length === 'detailed') ? 'This is a short question: answer it directly in one or two sentences. Do not pad, do not add caveats, do not restate the question.\n\n' : '')
    + 'Formatting: plain prose by default. You may use **bold**, short bullet lists ("- item") and `code`. No headings, no tables, no links.' + nowLine + userLine + profileBlock + guideBlock + ctx;
}

function readEnv(env) {
  return {
    provider: (env.KRIS_LLM_PROVIDER || DEFAULTS.provider).toLowerCase(),
    url: (env.KRIS_LLM_URL || DEFAULTS.url).replace(/\/+$/, ''),
    model: env.KRIS_LLM_MODEL || DEFAULTS.model,
    apiKey: env.KRIS_LLM_API_KEY || null,   // only for self-hosted servers that require one; never a vendor key
    enabled: env.KRIS_ENABLE_LLM !== '0',
    timeoutMs: parseInt(env.KRIS_LLM_TIMEOUT_MS || String(DEFAULTS.timeoutMs), 10),
    appName: env.KRIS_APP_NAME || 'this application',
    // Reasoning models think for many seconds before speaking. That is wasted
    // time for conversation and app help, so it is off by default. Set
    // KRIS_LLM_REASONING=on to keep it.
    reasoningOff: (env.KRIS_LLM_REASONING || 'off').toLowerCase() !== 'on',
    reasoningEffort: (env.KRIS_LLM_REASONING_EFFORT || DEFAULTS.reasoningEffort).toLowerCase(),
    // A second, smaller model for short questions. Falls back to the main
    // model if unset, so this is optional configuration, not required.
    fastModel: env.KRIS_LLM_FAST_MODEL || null,
    fastTimeoutMs: parseInt(env.KRIS_LLM_FAST_TIMEOUT_MS || String(DEFAULTS.fastTimeoutMs), 10),
    // Ollama unloads a model after ~5 idle minutes by default; the NEXT message
    // then waits 20-60s while it reloads from disk. Keeping it resident is the
    // single biggest latency fix for a self-hosted setup.
    keepAlive: env.KRIS_LLM_KEEP_ALIVE || '30m',
  };
}

/**
 * OpenRouter's unified reasoning control. Low effort with the reasoning text
 * excluded from the reply is the fastest setting that every reasoning model
 * accepts — including ones where reasoning cannot be disabled at all.
 */
function reasoningDirective(cfg) {
  return { effort: cfg.reasoningEffort || 'low', exclude: true };
}

/** True if a provider's 400 is complaining about the reasoning field itself. */
function rejectsReasoning(status, detail) {
  return status === 400 && /reasoning/i.test(String(detail || ''));
}

/**
 * OpenRouter only: prefer the provider with the lowest latency for this model.
 * Other OpenAI-compatible servers never see the field. Override with
 * KRIS_LLM_PROVIDER_SORT=throughput|price, or "off" to leave routing alone.
 */
function providerRouting(env, url) {
  if (!/openrouter\.ai/i.test(String(url || ''))) return null;
  const sort = String((env && env.KRIS_LLM_PROVIDER_SORT) || 'latency').toLowerCase();
  if (sort === 'off' || sort === 'none') return null;
  return { sort: sort };
}

function buildRequest(cfg, system, messages, light, stream) {
  if (cfg.provider === 'openai_compat') {
    const routing = providerRouting(cfg.env, cfg.url);
    return {
      url: cfg.url + '/v1/chat/completions',
      headers: Object.assign({ 'Content-Type': 'application/json' }, cfg.apiKey ? { Authorization: 'Bearer ' + cfg.apiKey } : {},
        /openrouter\.ai/i.test(cfg.url) ? { 'X-Title': 'K.R.1.S' } : {}),
      body: Object.assign({
        model: (light && cfg.fastModel) ? cfg.fastModel : cfg.model,
        messages: [{ role: 'system', content: system }].concat(messages),
        max_tokens: light ? DEFAULTS.fastMaxTokens : DEFAULTS.maxTokens,
        temperature: DEFAULTS.temperature,
        stream: !!stream,
      },
      // OpenRouter's unified switch for reasoning models. Other OpenAI-compatible
      // servers ignore unknown fields, but we only send it where it is known to
      // be understood, to avoid a strict server rejecting the request.
      (cfg.reasoningOff && /openrouter\.ai/i.test(cfg.url)) ? { reasoning: reasoningDirective(cfg) } : {},
      routing ? { provider: routing } : {}),
      extract: function (data) {
        const c = data && data.choices && data.choices[0];
        return c && c.message && typeof c.message.content === 'string' ? c.message.content : '';
      },
      streamKind: 'sse',
    };
  }
  // Ollama native
  return {
    url: cfg.url + '/api/chat',
    headers: { 'Content-Type': 'application/json' },
    body: {
      model: (light && cfg.fastModel) ? cfg.fastModel : cfg.model,
      messages: [{ role: 'system', content: system }].concat(messages),
      stream: !!stream,
      keep_alive: cfg.keepAlive,
      options: { temperature: DEFAULTS.temperature, num_predict: light ? DEFAULTS.fastMaxTokens : DEFAULTS.maxTokens },
    },
    extract: function (data) {
      return data && data.message && typeof data.message.content === 'string' ? data.message.content : '';
    },
    streamKind: 'ndjson',
  };
}

/**
 * Open the TLS connection to the model host before the first real message
 * needs it. Node's fetch (undici) keeps connections alive and pools them per
 * origin, so a warm connection saves the TCP + TLS handshake (often 150-400 ms
 * to a hosted provider) on the next request. Fire-and-forget, at most once a
 * minute, never throws.
 */
let lastWarm = 0;
function warmLLM(env, fetchImpl) {
  try {
    const cfg = readEnv(env || process.env);
    if (!cfg.enabled || !cfg.url) return;
    if (Date.now() - lastWarm < 60000) return;
    lastWarm = Date.now();
    const f = fetchImpl || globalThis.fetch;
    if (typeof f !== 'function') return;
    const url = cfg.provider === 'openai_compat' ? cfg.url + '/v1/models' : cfg.url + '/api/tags';
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = ctrl ? setTimeout(() => ctrl.abort(), 5000) : null;
    if (t && t.unref) t.unref();
    Promise.resolve(f(url, { method: 'GET', headers: cfg.apiKey ? { Authorization: 'Bearer ' + cfg.apiKey } : {}, signal: ctrl ? ctrl.signal : undefined }))
      .then((r) => (r && r.body && typeof r.body.cancel === 'function' ? r.body.cancel() : r && r.text && r.text()))
      .catch(() => {})
      .then(() => { if (t) clearTimeout(t); });
  } catch (_) { /* warming is best-effort */ }
}

/**
 * @param {string} text
 * @param {object} opts  { env, guideSnippets, history, context, fetchImpl,
 *                         onDelta?, signal?, vesselNames? }
 *   onDelta(evt)  when present the reply is STREAMED: evt is
 *                 { t: 'delta', text } for each released, guard-checked
 *                 sentence, or { t: 'replace', text } if the guard stopped it.
 * @returns {Promise<{ text, blocked, disabled?, error?, provider?, model?, streamed? }>}
 */
async function converse(text, opts) {
  opts = opts || {};
  const cfg = readEnv(opts.env || process.env);
  cfg.env = opts.env || process.env;
  if (!cfg.enabled) {
    return { text: 'I can help with vessel data and app questions — what would you like to know?', blocked: false, disabled: true };
  }

  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const messages = (opts.history || [])
    .slice(-6)
    .map(function (h) { return { role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.text || '').slice(0, 500) }; })
    .concat([{ role: 'user', content: String(text || '').slice(0, 1000) }]);

  const light = !!opts.light;
  const streaming = typeof opts.onDelta === 'function';
  const system = systemPrompt({ appName: cfg.appName, guideSnippets: opts.guideSnippets || [], context: opts.context, reasoningOff: cfg.reasoningOff, light: light, nowLabel: opts.nowLabel, userName: opts.userName || null, profile: opts.profile || null });
  const req = buildRequest(cfg, system, messages, light, streaming);
  // No tools field in either request shape. That is the structural guarantee.

  // A light message gets a short leash: better a fast honest fallback than a
  // user staring at a spinner.
  const budgetMs = light ? cfg.fastTimeoutMs : cfg.timeoutMs;
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, budgetMs) : null;
  const signal = anySignal([ctrl ? ctrl.signal : null, opts.signal || null]);
  const names = [].concat(opts.vesselNames || [], opts.context && opts.context.vesselName ? [opts.context.vesselName] : []);
  const fail = function (error) {
    if (timer) clearTimeout(timer);
    return { text: UNAVAILABLE, blocked: false, error: error, provider: cfg.provider, model: cfg.model };
  };

  const send = function (body) {
    return fetchImpl(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(body), signal: signal });
  };

  let res;
  try {
    res = await send(req.body);
  } catch (e) {
    return fail(e.name === 'AbortError' ? 'timed out after ' + budgetMs + 'ms' : e.message);
  }

  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch (_) { /* ignore */ }
    // A provider that does not understand the reasoning (or routing) field says
    // so with a 400. Send the same request once more without them.
    if (res.status === 400 && (req.body.reasoning || req.body.provider) && /reasoning|provider/i.test(String(detail))) {
      const body2 = Object.assign({}, req.body); delete body2.reasoning; delete body2.provider;
      try { res = await send(body2); } catch (e) { return fail(e.name === 'AbortError' ? 'timed out after ' + budgetMs + 'ms' : e.message); }
      if (!res.ok) { try { detail = await res.text(); } catch (_) { /* ignore */ } }
    }
    if (!res.ok) return fail('HTTP ' + res.status + ': ' + String(detail).slice(0, 150));
  }

  // --- non-streamed: unchanged behaviour ----------------------------------------
  if (!streaming) {
    if (timer) clearTimeout(timer);
    let data;
    try { data = await res.json(); } catch (_) { return { text: UNAVAILABLE, blocked: false, error: 'non-JSON response', provider: cfg.provider, model: cfg.model }; }
    const raw = (req.extract(data) || '').trim();
    if (!raw) return { text: UNAVAILABLE, blocked: false, error: 'empty reply', provider: cfg.provider, model: cfg.model };
    if (containsStatedFigure(raw, names)) return { text: SAFE_REDIRECT, blocked: true, rawBlocked: raw, provider: cfg.provider, model: cfg.model };
    const parsed = extractChart(raw);
    return { text: parsed.text, chart: parsed.chart, blocked: false, provider: cfg.provider, model: cfg.model };
  }

  // --- streamed: released a sentence at a time, each one guard-checked ----------
  const gate = new SentenceGate({
    check: function (piece) { return containsStatedFigure(piece, names); },
    emit: function (piece) { opts.onDelta({ t: 'delta', text: piece }); },
  });
  const isJsonBody = /application\/json/i.test(String((res.headers && res.headers.get && res.headers.get('content-type')) || ''));
  try {
    if (isJsonBody) {
      // A server that ignored stream:true and answered in one piece.
      const data = await res.json();
      gate.push(req.extract(data) || '');
    } else if (req.streamKind === 'sse') {
      await readSSE(res, function (chunk) {
        const c = chunk && chunk.choices && chunk.choices[0];
        const d = c && (c.delta || c.message);
        if (d && typeof d.content === 'string') gate.push(d.content);
        if (gate.blocked && ctrl) ctrl.abort();
      });
    } else {
      await readNDJSON(res, function (obj) {
        if (obj && obj.message && typeof obj.message.content === 'string') gate.push(obj.message.content);
        if (gate.blocked) { if (ctrl) ctrl.abort(); return false; }
        return true;
      });
    }
  } catch (e) {
    if (!gate.blocked) {
      if (timer) clearTimeout(timer);
      const partial = gate.released.trim();
      if (partial) {
        // Keep what was already shown; say plainly that it was cut short.
        return { text: partial + '\n\n_(I lost the connection before finishing that answer.)_', blocked: false, streamed: true, error: e.name === 'AbortError' ? 'timed out after ' + budgetMs + 'ms' : e.message, provider: cfg.provider, model: cfg.model };
      }
      return fail(e.name === 'AbortError' ? 'timed out after ' + budgetMs + 'ms' : e.message);
    }
  }
  if (timer) clearTimeout(timer);

  if (gate.blocked) {
    opts.onDelta({ t: 'replace', text: SAFE_REDIRECT });
    return { text: SAFE_REDIRECT, blocked: true, streamed: true, provider: cfg.provider, model: cfg.model };
  }
  const raw = gate.end().trim();
  if (gate.blocked) {
    opts.onDelta({ t: 'replace', text: SAFE_REDIRECT });
    return { text: SAFE_REDIRECT, blocked: true, streamed: true, provider: cfg.provider, model: cfg.model };
  }
  if (!raw) return { text: UNAVAILABLE, blocked: false, error: 'empty reply', provider: cfg.provider, model: cfg.model };
  const parsed = extractChart(raw);
  return { text: parsed.text, chart: parsed.chart, blocked: false, streamed: true, provider: cfg.provider, model: cfg.model };
}

module.exports = { converse: converse, warmLLM: warmLLM, providerRouting: providerRouting, reasoningDirective: reasoningDirective, containsStatedFigure: containsStatedFigure, extractChart: extractChart, systemPrompt: systemPrompt, buildRequest: buildRequest, readEnv: readEnv, SAFE_REDIRECT: SAFE_REDIRECT, DEFAULTS: DEFAULTS };