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

  return think
    + 'You are Captain Nav, the assistant built into ' + opts.appName + ', a maritime compliance and fleet-analytics application. Your name is Captain Nav; if asked, say so. You are a capable general assistant with the manner of an experienced, trustworthy ship\'s captain: warm, direct, precise.\n\n'
    + 'Answer whatever the user actually asks. General knowledge, explanations of concepts (maritime or otherwise), arithmetic and unit conversions, comparing numbers the user gives you, writing help, and questions about how to use the app are all yours to answer fully and well. Do not steer unrelated questions back to vessels or emissions. Match the depth to the question: one line for a quick fact, a short structured answer for something that needs it. Show working for calculations.\n\n'
    + 'THE ONE RULE: you have no access to this user\'s vessel records. Never state, estimate or guess a figure as if it were one of their vessels\' actual values (their fuel, power, speed, distance, emissions, compliance balance, off-hire, counts). General maritime facts are fine ("a Panamax bulker might burn 30 tonnes a day"); a claim about THEIR ship is not. If they ask for one of their own figures, say you\'ll need to look it up and tell them to ask it directly as a data question, e.g. "fuel consumption for <vessel> last month". Never present a guess as their data.\n\n'
    + 'Charts: when a chart would genuinely help and every number came from the user or from your own arithmetic on their numbers, end your reply with exactly one line in this form and nothing after it:\n'
    + 'CHART {"type":"bar","title":"...","labels":["A","B"],"values":[1,2],"unit":""}\n'
    + '(type is "bar" or "line"; 2 to 24 points). Do not add a chart to answers that don\'t need one.\n\n'
    + (opts.light ? 'This is a short question: answer it directly in one or two sentences. Do not pad, do not add caveats, do not restate the question.\n\n' : '')
    + 'Formatting: plain prose by default. You may use **bold**, short bullet lists ("- item") and `code`. No headings, no tables, no links.' + nowLine + userLine + guideBlock + ctx;
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
    // Reasoning models think for many seconds before speaking. That is wasted
    // time for conversation and app help, so it is off by default. Set
    // CAPTAIN_LLM_REASONING=on to keep it.
    reasoningOff: (env.CAPTAIN_LLM_REASONING || 'off').toLowerCase() !== 'on',
    reasoningEffort: (env.CAPTAIN_LLM_REASONING_EFFORT || DEFAULTS.reasoningEffort).toLowerCase(),
    // A second, smaller model for short questions. Falls back to the main
    // model if unset, so this is optional configuration, not required.
    fastModel: env.CAPTAIN_LLM_FAST_MODEL || null,
    fastTimeoutMs: parseInt(env.CAPTAIN_LLM_FAST_TIMEOUT_MS || String(DEFAULTS.fastTimeoutMs), 10),
    // Ollama unloads a model after ~5 idle minutes by default; the NEXT message
    // then waits 20-60s while it reloads from disk. Keeping it resident is the
    // single biggest latency fix for a self-hosted setup.
    keepAlive: env.CAPTAIN_LLM_KEEP_ALIVE || '30m',
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

function buildRequest(cfg, system, messages, light) {
  if (cfg.provider === 'openai_compat') {
    return {
      url: cfg.url + '/v1/chat/completions',
      headers: Object.assign({ 'Content-Type': 'application/json' }, cfg.apiKey ? { Authorization: 'Bearer ' + cfg.apiKey } : {}),
      body: Object.assign({
        model: (light && cfg.fastModel) ? cfg.fastModel : cfg.model,
        messages: [{ role: 'system', content: system }].concat(messages),
        max_tokens: light ? DEFAULTS.fastMaxTokens : DEFAULTS.maxTokens,
        temperature: DEFAULTS.temperature,
        stream: false,
      },
      // OpenRouter's unified switch for reasoning models. Other OpenAI-compatible
      // servers ignore unknown fields, but we only send it where it is known to
      // be understood, to avoid a strict server rejecting the request.
      (cfg.reasoningOff && /openrouter\.ai/i.test(cfg.url)) ? { reasoning: reasoningDirective(cfg) } : {}),
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
      model: (light && cfg.fastModel) ? cfg.fastModel : cfg.model,
      messages: [{ role: 'system', content: system }].concat(messages),
      stream: false,
      keep_alive: cfg.keepAlive,
      options: { temperature: DEFAULTS.temperature, num_predict: light ? DEFAULTS.fastMaxTokens : DEFAULTS.maxTokens },
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

  const light = !!opts.light;
  const system = systemPrompt({ appName: cfg.appName, guideSnippets: opts.guideSnippets || [], context: opts.context, reasoningOff: cfg.reasoningOff, light: light, nowLabel: opts.nowLabel, userName: opts.userName || null });
  const req = buildRequest(cfg, system, messages, light);
  // No tools field in either request shape. That is the structural guarantee.

  // A light message gets a short leash: better a fast honest fallback than a
  // user staring at a spinner.
  const budgetMs = light ? cfg.fastTimeoutMs : cfg.timeoutMs;
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, budgetMs) : null;

  let res;
  try {
    res = await fetchImpl(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: ctrl ? ctrl.signal : undefined });
  } catch (e) {
    if (timer) clearTimeout(timer);
    return { text: UNAVAILABLE, blocked: false, error: e.name === 'AbortError' ? 'timed out after ' + budgetMs + 'ms' : e.message, provider: cfg.provider, model: cfg.model };
  }

  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch (_) { /* ignore */ }
    // A provider that does not understand the reasoning field says so with a
    // 400. Send the same request once more without it.
    if (rejectsReasoning(res.status, detail) && req.body.reasoning) {
      const body2 = Object.assign({}, req.body); delete body2.reasoning;
      try {
        res = await fetchImpl(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(body2), signal: ctrl ? ctrl.signal : undefined });
      } catch (e) {
        if (timer) clearTimeout(timer);
        return { text: UNAVAILABLE, blocked: false, error: e.name === 'AbortError' ? 'timed out after ' + budgetMs + 'ms' : e.message, provider: cfg.provider, model: cfg.model };
      }
      if (!res.ok) { try { detail = await res.text(); } catch (_) { /* ignore */ } }
    }
    if (!res.ok) {
      if (timer) clearTimeout(timer);
      return { text: UNAVAILABLE, blocked: false, error: 'HTTP ' + res.status + ': ' + detail.slice(0, 150), provider: cfg.provider, model: cfg.model };
    }
  }
  if (timer) clearTimeout(timer);

  let data;
  try { data = await res.json(); } catch (_) { return { text: UNAVAILABLE, blocked: false, error: 'non-JSON response', provider: cfg.provider, model: cfg.model }; }

  const raw = (req.extract(data) || '').trim();
  if (!raw) return { text: UNAVAILABLE, blocked: false, error: 'empty reply', provider: cfg.provider, model: cfg.model };
  const names = [].concat(opts.vesselNames || [], opts.context && opts.context.vesselName ? [opts.context.vesselName] : []);
  if (containsStatedFigure(raw, names)) return { text: SAFE_REDIRECT, blocked: true, rawBlocked: raw, provider: cfg.provider, model: cfg.model };
  const parsed = extractChart(raw);
  return { text: parsed.text, chart: parsed.chart, blocked: false, provider: cfg.provider, model: cfg.model };
}

module.exports = { converse: converse, reasoningDirective: reasoningDirective, containsStatedFigure: containsStatedFigure, extractChart: extractChart, systemPrompt: systemPrompt, buildRequest: buildRequest, readEnv: readEnv, SAFE_REDIRECT: SAFE_REDIRECT, DEFAULTS: DEFAULTS };