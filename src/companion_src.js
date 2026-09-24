'use strict';

const { profilePrompt } = require('./profile');
const { MODEL_LABEL } = require('./identity');

/**
 * The companion layer — conversation and app guidance.
 *
 * The model is GLM-5.3-Flash (z-ai/glm-5.3-flash) on OpenRouter: set
 * KRIS_LLM_API_KEY and nothing else. Pages still show it as MODEL_LABEL.
 *
 * Transports:
 *
 *   openai_compat   any OpenAI-compatible /v1/chat/completions server   (default)
 *                   OpenRouter, vLLM, llama.cpp server, LM Studio, LocalAI
 *   ollama          Ollama's native /api/chat
 *
 * KRIS_LLM_PROVIDER, KRIS_LLM_URL and KRIS_LLM_MODEL override the defaults.
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

const { readSSE, readNDJSON, SentenceGate, anySignal, hasReasoning, thinkingBeat, guardable } = require('./stream');

const DEFAULTS = {
  provider: 'openai_compat',
  url: 'https://openrouter.ai/api',
  model: 'z-ai/glm-5.3-flash',
  // How long the model may stay SILENT — before its first token, or between
  // tokens. Reasoning tokens count as progress, so a long, careful answer is
  // never cut off while it is still being written.
  timeoutMs: 30000,
  // A ceiling, not a target: reasoning and answer share it. The prompt and
  // the question decide the length.
  maxTokens: 8192,
  temperature: 0.4,   // Ollama only; hosted models run at their own recommended setting
};

// What the model sees of the conversation. Generous on purpose: the context
// window is large, and a follow-up is only as good as what the model can see.
const HISTORY_TURNS = 20;
const HISTORY_CHARS = 6000;
const MESSAGE_CHARS = 8000;

/**
 * Short, simple messages are answered briefly and with light reasoning;
 * substantial ones get the model's full attention. "What does CII stand
 * for" and "explain FuelEU pooling" deserve different amounts of thought.
 */
const HEAVY_RE = /\b(explain|why|how does|how do|compare|analyse|analyze|calculate|work out|difference between|pros and cons|walk me through|step by step|write|draft|summar|plan|evaluate|review|debug)/i;

function isLightMessage(text) {
  const t = String(text || '').trim();
  if (t.length > 140) return false;              // long question, treat as substantial
  if (/\n/.test(t)) return false;                 // multi-line, likely detailed
  if (HEAVY_RE.test(t)) return false;             // asks for reasoning or composition
  return t.split(/\s+/).length <= 14;
}

/**
 * OpenRouter reasoning effort for one message. KRIS_LLM_REASONING_EFFORT pins
 * it (low | medium | high); otherwise it follows the question. GLM-5.3-Flash
 * always reasons; only the depth changes.
 */
function effortFor(text, env) {
  const pinned = String((env && env.KRIS_LLM_REASONING_EFFORT) || '').toLowerCase();
  if (pinned) return pinned;
  const t = String(text || '');
  if (isLightMessage(t)) return 'low';
  return HEAVY_RE.test(t) || t.length > 400 ? 'high' : 'medium';
}

/** A model is set up: a key for the default hosted endpoint, or a server of your own. */
function llmConfigured(env) {
  return !!(env && (env.KRIS_LLM_API_KEY || env.KRIS_LLM_URL));
}

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
// Small models dress the line up ("CHART: {...}", or inside a ``` fence); both are accepted.
const CHART_LINE_RE = /^[ \t]*(?:```[a-z]*[ \t]*\n[ \t]*)?CHART:?[ \t]*(\{[\s\S]*\})[ \t]*(?:\n[ \t]*```)?[ \t]*$/m;

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

/**
 * How the model asks for a visual: a ```visual block holding one JSON spec,
 * placed where it belongs in the answer. The widget draws it; the server holds
 * each block until it is complete and guards its numbers like prose. Shared
 * by the companion and the agent.
 */
const VISUAL_GUIDE = 'VISUALS: when a picture makes the answer clearer, include one (at most two per answer) as a fenced code block whose language is "visual", holding one JSON object, placed where it belongs in the answer. Use one when the user asks to see, show, chart, graph, compare or visualise something, or when the answer compares options, sets out several key numbers or a trend, or walks through a process or a timeline. Never for small talk, a single fact, a yes/no answer or a short definition. Still state the key point in words; do not describe or mention the block itself. Pick the form by what the reader must do:\n'
  + '- a few key figures: {"type":"stats","title":"…","items":[{"label":"…","value":89.34,"unit":"gCO2e/MJ","note":"…","tone":"good|warn|bad"}]}\n'
  + '- amounts across categories: {"type":"bar","title":"…","unit":"…","labels":["A","B"],"values":[1,2],"highlight":"B"}\n'
  + '- change over time: {"type":"line","title":"…","unit":"…","labels":["2024","2025","2026"],"series":[{"name":"…","values":[1,2,3]}]} (up to 3 series)\n'
  + '- parts of a whole: {"type":"breakdown","title":"…","unit":"…","items":[{"label":"…","value":60},{"label":"…","value":40}]}\n'
  + '- one value against a limit or a rating scale: {"type":"meter","title":"…","value":5.1,"unit":"…","min":0,"max":10,"target":6,"targetLabel":"Limit","better":"lower","bands":[{"label":"A","to":3},{"label":"B","to":5},{"label":"C","to":10}]}\n'
  + '- options side by side: {"type":"compare","title":"…","items":[{"name":"…","tag":"…","points":["…","…"],"verdict":"…"}],"highlight":"…"}\n'
  + '- a process or procedure: {"type":"steps","title":"…","steps":[{"title":"…","detail":"…"}]}\n'
  + '- dated milestones or a phase-in: {"type":"timeline","title":"…","events":[{"when":"2025","title":"…","detail":"…"}]}\n'
  + '- several views of one subject: {"type":"dashboard","title":"…","blocks":[ any of the above ]}\n'
  + 'Strict JSON: double quotes, plain numbers (no units, thousands separators or % signs inside numbers), short labels, 2 to 12 points per chart. Every number must come from the user, from a tool result in this conversation, or be a well-established public figure (a regulation\'s threshold or phase-in, a conversion factor); never an estimate presented as the user\'s own data.';

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
  const nowLine = opts.nowLabel
    ? '\n\nCurrent date and time: ' + opts.nowLabel + '. Use this for anything about today, dates, deadlines or elapsed time. Never say you do not know the date or time. You do not have live news or prices; if asked about current events, say your knowledge may be out of date rather than guessing.'
    : '';

  const userLine = opts.userName
    ? '\n\nThe user\'s name is ' + opts.userName + '. Address them by name occasionally and naturally \u2014 not in every reply.'
    : '';
  const about = profilePrompt(opts.profile, opts.userName);
  const profileBlock = about ? '\n\n' + about : '';

  return 'You are K.R.1.S (say it "Kris"), the assistant built into ' + opts.appName + ', a maritime compliance and fleet-analytics application. Your name is K.R.1.S; if asked, say so. K.R.1.S is a codename inspired by Lord Krishna, the calm charioteer who guides without taking the wheel. You are a capable general assistant in that spirit: serene, warm, clear-sighted and gently playful, never preachy. Do not quote scripture or make religious claims unless the user raises the subject, and treat it with respect when they do. You run on ' + MODEL_LABEL + ': if asked what model, LLM or AI you are, say you are K.R.1.S running on ' + MODEL_LABEL + ', and never name any other model, vendor or company.\n\n'
    + 'Answer whatever the user actually asks. General knowledge, explanations of concepts (maritime or otherwise), regulation (EU ETS, FuelEU Maritime, CII, EEXI, IMO), arithmetic and unit conversions, comparing numbers the user gives you, writing and code help, and questions about how to use the app are all yours to answer fully and well. Do not steer unrelated questions back to vessels or emissions. People type fast: read past typos and missing punctuation to what they mean ("whoch" is "which", "bisually" is "visually") and never comment on spelling. Work out what they actually need before answering; if a question is genuinely ambiguous, answer the most likely reading and say which one you took.\n\n'
    + 'Lead with the answer in your first sentence. Match the depth to the question: one sentence for a quick fact or a comparison of two numbers; for anything substantial, a complete, well-organised answer that covers what matters and stops there. Think multi-step problems through before you answer, check arithmetic and logic, and state results plainly; show working only where it helps the user follow. Be accurate rather than confident: if you are unsure, or something may have changed since your training, say so briefly.\n\n'
    + 'THE ONE RULE: you have no access to this user\'s vessel records. Never state, estimate or guess a figure as if it were one of their vessels\' actual values (their fuel, power, speed, distance, emissions, compliance balance, off-hire, counts). General maritime facts are fine ("a Panamax bulker might burn 30 tonnes a day"); a claim about THEIR ship is not. If they ask for one of their own figures, say you\'ll need to look it up and tell them to ask it directly as a data question, e.g. "fuel consumption for <vessel> last month". Never present a guess as their data.\n\n'
    + VISUAL_GUIDE + '\n\n'
    + (opts.light && !(opts.profile && opts.profile.style && opts.profile.style.length === 'detailed') ? 'This is a short question: answer it directly in one or two sentences. Do not pad, do not add caveats, do not restate the question.\n\n' : '')
    + 'Formatting (Markdown): plain prose for short answers. For longer ones, use structure where it helps reading: **bold** for key terms, bullet or numbered lists for steps and options, a table to compare several items across the same attributes, ### headings only to separate the sections of a long answer, and fenced code blocks with a language for code. Link only to well-known official sources you are sure exist. No filler, and no closing summary of what you just said.' + nowLine + userLine + profileBlock + guideBlock + ctx;
}

function readEnv(env) {
  return {
    provider: (env.KRIS_LLM_PROVIDER || DEFAULTS.provider).toLowerCase(),
    url: (env.KRIS_LLM_URL || DEFAULTS.url).replace(/\/+$/, ''),
    model: env.KRIS_LLM_MODEL || DEFAULTS.model,
    apiKey: env.KRIS_LLM_API_KEY || null,
    configured: llmConfigured(env),
    enabled: env.KRIS_ENABLE_LLM !== '0',
    timeoutMs: parseInt(env.KRIS_LLM_TIMEOUT_MS || String(DEFAULTS.timeoutMs), 10),
    appName: env.KRIS_APP_NAME || 'this application',
    // Ollama unloads a model after ~5 idle minutes by default; the NEXT message
    // then waits 20-60s while it reloads from disk. Keeping it resident is the
    // single biggest latency fix for a self-hosted setup.
    keepAlive: env.KRIS_LLM_KEEP_ALIVE || '30m',
  };
}

/**
 * OpenRouter's unified reasoning control. The reasoning text is streamed back
 * (not excluded) only so the server can see the model is still working; it is
 * read as a heartbeat and dropped: never shown, never stored, never guarded
 * because it never reaches the user.
 */
function reasoningDirective(effort) {
  return { effort: effort || 'medium' };
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

function buildRequest(cfg, system, messages, effort, stream) {
  if (cfg.provider === 'openai_compat') {
    const routing = providerRouting(cfg.env, cfg.url);
    return {
      url: cfg.url + '/v1/chat/completions',
      headers: Object.assign({ 'Content-Type': 'application/json' }, cfg.apiKey ? { Authorization: 'Bearer ' + cfg.apiKey } : {},
        /openrouter\.ai/i.test(cfg.url) ? { 'X-Title': 'K.R.1.S' } : {}),
      body: Object.assign({
        model: cfg.model,
        messages: [{ role: 'system', content: system }].concat(messages),
        max_tokens: DEFAULTS.maxTokens,
        stream: !!stream,
      },
      // OpenRouter's unified switch for reasoning models. Other OpenAI-compatible
      // servers ignore unknown fields, but we only send it where it is known to
      // be understood, to avoid a strict server rejecting the request.
      /openrouter\.ai/i.test(cfg.url) ? { reasoning: reasoningDirective(effort) } : {},
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
      model: cfg.model,
      messages: [{ role: 'system', content: system }].concat(messages),
      stream: !!stream,
      keep_alive: cfg.keepAlive,
      options: { temperature: DEFAULTS.temperature, num_predict: DEFAULTS.maxTokens },
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

// The model server's last known state, reported by GET /api/kris so a status
// page can say "unreachable" instead of showing a green light while every
// conversational message fails. null until the first probe or message.
let llmState = null;
function setState(ok, code) { llmState = { ok: ok, code: ok ? undefined : code, at: Date.now() }; }
function llmStatus() { return llmState; }
function failureCode(error) {
  const m = String(error || '').match(/HTTP (\d{3})/);
  return m ? 'LLM_HTTP_' + m[1] : /timed out/i.test(String(error)) ? 'LLM_TIMEOUT' : 'LLM_UNREACHABLE';
}

function warmLLM(env, fetchImpl) {
  try {
    const cfg = readEnv(env || process.env);
    if (!cfg.enabled || !cfg.configured) return;
    if (Date.now() - lastWarm < 60000) return;
    lastWarm = Date.now();
    const f = fetchImpl || globalThis.fetch;
    if (typeof f !== 'function') return;
    const url = cfg.provider === 'openai_compat' ? cfg.url + '/v1/models' : cfg.url + '/api/tags';
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = ctrl ? setTimeout(() => ctrl.abort(), 5000) : null;
    if (t && t.unref) t.unref();
    Promise.resolve(f(url, { method: 'GET', headers: cfg.apiKey ? { Authorization: 'Bearer ' + cfg.apiKey } : {}, signal: ctrl ? ctrl.signal : undefined }))
      .then((r) => {
        if (!r || !r.ok) { setState(false, 'LLM_HTTP_' + (r ? r.status : '000')); return r && r.text && r.text(); }
        // Ollama lists the models it has pulled; a model that was never pulled
        // answers every message with a 404, so say so here.
        if (cfg.provider !== 'openai_compat' && typeof r.json === 'function') {
          return r.json().then((j) => {
            const names = ((j && j.models) || []).map((m) => m.name || m.model);
            setState(names.includes(cfg.model) || names.includes(cfg.model + ':latest'), 'LLM_MODEL_MISSING');
          });
        }
        setState(true);
        return r.body && typeof r.body.cancel === 'function' ? r.body.cancel() : r.text && r.text();
      })
      .catch(() => setState(false, 'LLM_UNREACHABLE'))
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

  if (!cfg.configured) {
    setState(false, 'LLM_NOT_CONFIGURED');
    return { text: UNAVAILABLE, blocked: false, error: 'no model configured', provider: cfg.provider, model: cfg.model };
  }

  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const messages = (opts.history || [])
    .slice(-HISTORY_TURNS)
    .map(function (h) { return { role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.text || '').slice(0, HISTORY_CHARS) }; })
    .concat([{ role: 'user', content: String(text || '').slice(0, MESSAGE_CHARS) }]);

  const light = opts.light != null ? !!opts.light : isLightMessage(text);
  const streaming = typeof opts.onDelta === 'function';
  const system = systemPrompt({ appName: cfg.appName, guideSnippets: opts.guideSnippets || [], context: opts.context, light: light, nowLabel: opts.nowLabel, userName: opts.userName || null, profile: opts.profile || null });
  const req = buildRequest(cfg, system, messages, effortFor(text, cfg.env), streaming);
  // No tools field in either request shape. That is the structural guarantee.

  // An idle timer, re-armed by every streamed chunk: silence fails, a long
  // answer does not. Unstreamed, nothing arrives until the whole answer is
  // written, so that wait gets a longer leash.
  const budgetMs = streaming ? cfg.timeoutMs : cfg.timeoutMs * 4;
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer = null;
  const arm = function () { if (!ctrl) return; if (timer) clearTimeout(timer); timer = setTimeout(function () { ctrl.abort(); }, budgetMs); };
  arm();
  const signal = anySignal([ctrl ? ctrl.signal : null, opts.signal || null]);
  const names = [].concat(opts.vesselNames || [], opts.context && opts.context.vesselName ? [opts.context.vesselName] : []);
  const fail = function (error) {
    if (timer) clearTimeout(timer);
    if (!(opts.signal && opts.signal.aborted)) setState(false, failureCode(error)); // the user pressing stop is not an outage
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
  setState(true);

  // --- non-streamed: unchanged behaviour ----------------------------------------
  if (!streaming) {
    if (timer) clearTimeout(timer);
    let data;
    try { data = await res.json(); } catch (_) { return { text: UNAVAILABLE, blocked: false, error: 'non-JSON response', provider: cfg.provider, model: cfg.model }; }
    const raw = (req.extract(data) || '').trim();
    if (!raw) return { text: UNAVAILABLE, blocked: false, error: 'empty reply', provider: cfg.provider, model: cfg.model };
    if (containsStatedFigure(guardable(raw), names)) return { text: SAFE_REDIRECT, blocked: true, rawBlocked: raw, provider: cfg.provider, model: cfg.model };
    const parsed = extractChart(raw);
    return { text: parsed.text, chart: parsed.chart, blocked: false, provider: cfg.provider, model: cfg.model };
  }

  // --- streamed: released a sentence at a time, each one guard-checked ----------
  const gate = new SentenceGate({
    check: function (piece) { return containsStatedFigure(piece, names); },
    emit: function (piece) { opts.onDelta({ t: 'delta', text: piece }); },
    onHold: function () { opts.onDelta({ t: 'status', text: 'Preparing a visual', phase: 'visual' }); },
  });
  const beat = thinkingBeat(opts.onDelta, 5000);
  const isJsonBody = /application\/json/i.test(String((res.headers && res.headers.get && res.headers.get('content-type')) || ''));
  try {
    if (isJsonBody) {
      // A server that ignored stream:true and answered in one piece.
      const data = await res.json();
      gate.push(req.extract(data) || '');
    } else if (req.streamKind === 'sse') {
      await readSSE(res, function (chunk) {
        arm(); // content or reasoning: the model is still working
        if (hasReasoning(chunk)) beat();
        const c = chunk && chunk.choices && chunk.choices[0];
        const d = c && (c.delta || c.message);
        if (d && typeof d.content === 'string') gate.push(d.content);
        if (gate.blocked && ctrl) ctrl.abort();
      });
    } else {
      await readNDJSON(res, function (obj) {
        arm();
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

module.exports = { VISUAL_GUIDE: VISUAL_GUIDE, converse: converse, warmLLM: warmLLM, llmStatus: llmStatus, llmConfigured: llmConfigured, providerRouting: providerRouting, reasoningDirective: reasoningDirective, effortFor: effortFor, isLightMessage: isLightMessage, HISTORY_TURNS: HISTORY_TURNS, HISTORY_CHARS: HISTORY_CHARS, MESSAGE_CHARS: MESSAGE_CHARS, containsStatedFigure: containsStatedFigure, extractChart: extractChart, systemPrompt: systemPrompt, buildRequest: buildRequest, readEnv: readEnv, SAFE_REDIRECT: SAFE_REDIRECT, DEFAULTS: DEFAULTS };