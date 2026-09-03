'use strict';

/**
 * AI-FIRST MODE — the model decides, the tools stay deterministic.
 *
 * This is the alternative to router.js. Instead of a ladder of matchers
 * deciding what a message is, EVERY message goes to the model together with a
 * set of tool definitions. The model reads the conversation, works out what
 * the user actually means, and either answers directly or calls a tool. There
 * are no keyword rules, no phrase lists, no "if the user says X do Y".
 *
 *   user message ──► model ──► answers directly            (chat, maths,
 *                     │                                     explanations,
 *                     │                                     comparisons)
 *                     └──► calls a tool ──► deterministic code ──► model
 *                                                                    │
 *                                                                    ▼
 *                                                              final answer
 *
 * What is deliberately NOT the model's job:
 *
 *   - Writing SQL. get_vessel_data hands the question to engine.ask, which
 *     builds parameterised SQL from the metric registry. The model chooses
 *     WHEN to look something up and phrases the lookup; it never touches the
 *     database, so SQL injection stays structurally impossible and RBAC still
 *     scopes every row.
 *   - Inventing figures. If no data tool returned numbers this turn, the
 *     answer is checked by the same output guard the companion uses, and a
 *     fabricated vessel figure is replaced rather than shown.
 *
 * Everything else — intent, tone, follow-ups, clarification, whether a
 * question is even about vessels — is the model's judgement, which is the
 * point.
 *
 * Enable with CAPTAIN_MODE=agent. Anything else keeps the old router.
 */

const engine = require('./engine');
const rbac = require('./rbac');
const { searchGuide, GUIDE } = require('./guide');
const { buildBriefing } = require('./alerts');
const { containsStatedFigure } = require('./companion_src');
const { formatNow } = require('./instant_src');
const { METRICS } = require('./config');

const AGENT_BUILD = '2026-09-04.2';

const DEFAULTS = {
  maxSteps: 4,          // model turns per message, including the final answer
  timeoutMs: 45000,     // whole message budget, all steps together
  maxTokens: 900,
  temperature: 0.4,
  historyTurns: 10,
};

const UNAVAILABLE =
  "I couldn't reach my reasoning service just now, so I'm running in reduced mode. Ask me a vessel question or an app question and I'll still answer.";

// ---------------------------------------------------------------------------
// Tool definitions — the whole "API" the model gets. Adding a capability to
// Captain means adding an entry here and a handler below. Nothing else.
// ---------------------------------------------------------------------------

function toolDefs() {
  return [
    {
      type: 'function',
      function: {
        name: 'get_vessel_data',
        description:
          "Look up a real figure from THIS user's vessel records (the only way to get their actual data). "
          + 'Use it whenever the user asks about their own ships: fuel, power, speed, distance, emissions, '
          + 'compliance balance, off-hire, trends, comparisons between periods or vessels. '
          + 'Never answer such a question from your own knowledge. '
          + 'Ask in plain English naming the measurement, the vessel if known, and the period, '
          + 'e.g. "fuel consumption for Aurora Trader last month". '
          + 'If the user was vague, ask them a clarifying question instead of guessing a vessel or period.',
        parameters: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: 'The data question in plain English: measurement + vessel (optional) + period.',
            },
          },
          required: ['question'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_available_data',
        description:
          'List which measurements Captain can read and which vessels this user is allowed to see. '
          + 'Call this when you are unsure whether something is available, or when the user asks what you can look up.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_fleet_briefing',
        description:
          "Get a short automatic briefing of anything notable across the user's fleet right now "
          + '(gaps in reporting, unusual readings, compliance flags). Use for "anything I should know", '
          + '"how is the fleet doing", "give me a briefing".',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_app_help',
        description:
          'Search the help centre for how to DO something in the application (exporting, adding a vessel, '
          + 'inviting users, permissions, password reset, how often data syncs). Use only for questions about '
          + 'operating the app, not about data.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: 'What the user wants to do in the app.' } },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'show_chart',
        description:
          'Draw a chart in the chat. Use it whenever a visual would help and you already have the numbers — '
          + 'either numbers the user gave you, or numbers a previous get_vessel_data call returned. '
          + 'Never invent values to fill a chart.',
        parameters: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['bar', 'line'] },
            title: { type: 'string' },
            labels: { type: 'array', items: { type: 'string' }, description: '2 to 24 labels.' },
            values: { type: 'array', items: { type: 'number' }, description: 'Same length as labels.' },
            unit: { type: 'string', description: 'Optional unit, e.g. "MT".' },
          },
          required: ['type', 'labels', 'values'],
        },
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// System prompt — describes the situation, not a decision tree.
// ---------------------------------------------------------------------------

function systemPrompt(opts) {
  const lines = [];
  lines.push(
    'You are Captain Nav, the assistant built into ' + (opts.appName || 'this application')
    + ', a maritime compliance and fleet-analytics application. You have the manner of an experienced ship\'s '
    + 'captain: warm, direct, precise, never pompous. Your name is Captain Nav; say so if asked, and ask the '
    + 'user their name once, early, if you do not know it.'
  );
  lines.push(
    'You are a fully capable general assistant first. Answer whatever is actually asked — general knowledge, '
    + 'explanations, arithmetic, unit conversions, comparing numbers the user gives you, drafting, or just '
    + 'conversation. Do not steer unrelated questions back to ships. If someone asks which of two numbers is '
    + 'bigger, just answer it; that has nothing to do with vessel data.'
  );
  lines.push(
    'You have tools for the things you cannot know: the user\'s own vessel records, their fleet briefing, and '
    + 'the app\'s help centre. Decide for yourself when a tool is needed. Most messages need none. Use a tool '
    + 'only when the answer genuinely depends on this user\'s data or on how the product works.'
  );
  lines.push(
    'THE ONE HARD RULE: never state, estimate or imply a figure about this user\'s vessels unless a tool '
    + 'returned it in this conversation. General maritime facts are fine ("a Panamax might burn 30 tonnes a '
    + 'day"). A number presented as THEIR ship\'s is not, ever. If a lookup fails or returns nothing, say so '
    + 'plainly — never fill the gap with a plausible number.'
  );
  lines.push(
    'When a request is genuinely ambiguous (which vessel? which period?), ask one short clarifying question '
    + 'instead of guessing. When it is clear enough, act — do not interrogate the user over details you can '
    + 'reasonably infer from the conversation.'
  );
  lines.push(
    'Formatting: plain prose by default. Short bullet lists and **bold** are fine. No headings, no tables, '
    + 'no links. Keep short questions to one or two sentences; do not pad, do not restate the question, do '
    + 'not add disclaimers nobody asked for. Never mention tools, modules, function names or internal '
    + 'machinery — the user sees a captain, not a system.'
  );
  if (opts.nowLabel) {
    lines.push('Current date and time: ' + opts.nowLabel
      + '. Use it for anything involving today, dates or elapsed time; never claim not to know the date.');
  }
  if (opts.userName) {
    lines.push('The user\'s name is ' + opts.userName + '. Use it occasionally and naturally, not every reply.');
  }
  if (opts.vesselName) {
    lines.push('The user is currently viewing the vessel "' + opts.vesselName
      + '" in the app, so an unqualified "the vessel" probably means that one.');
  }
  return lines.join('\n\n');
}

// ---------------------------------------------------------------------------
// Tool handlers — deterministic code, the same code the router calls.
// ---------------------------------------------------------------------------

/**
 * Compact a full engine answer into something a model reads well, keeping the
 * visual parts (series, provenance) aside for the widget.
 */
function summariseData(out) {
  const brief = { status: out.status };
  if (out.text) brief.text = String(out.text).slice(0, 1200);
  if (out.value != null) brief.value = out.value;
  if (out.unit) brief.unit = out.unit;
  if (out.empty) brief.empty = true;
  if (out.rowsUsed != null) brief.reports_read = out.rowsUsed;
  if (out.provenance) {
    brief.vessels = out.provenance.vessels;
    brief.period = out.provenance.period;
    brief.metric = out.provenance.metric;
  }
  if (Array.isArray(out.series)) {
    brief.series = out.series.slice(0, 40).map(function (p) { return { bucket: p.bucket, value: p.value }; });
  }
  if (out.comparison) brief.comparison = out.comparison;
  if (out.stats) brief.stats = out.stats;
  if (Array.isArray(out.options) && out.options.length) brief.options = out.options.slice(0, 8);
  return brief;
}

function makeTools(input, getDb, opts) {
  const visuals = { chart: null, series: null, provenance: null, dataUsed: false, pending: null };

  const handlers = {
    async get_vessel_data(args) {
      const question = String((args && args.question) || '').trim();
      if (!question) return { error: 'question is required' };
      const client = await getDb();
      const out = await engine.ask(
        Object.assign({}, input, { text: question, pending: null }),
        client,
        opts
      );
      if (out.status === 'answer') {
        visuals.dataUsed = true;
        if (out.series) visuals.series = out.series;
        if (out.provenance) visuals.provenance = out.provenance;
        if (out.unit && !visuals.unit) visuals.unit = out.unit;
      }
      // A clarify/confirm from the engine is information for the model, not a
      // dead end: it decides whether to ask the user or retry differently.
      if (out.pending) visuals.pending = out.pending;
      return summariseData(out);
    },

    async list_available_data() {
      const client = await getDb().catch(function () { return null; });
      let vessels = [];
      if (client) {
        const scope = await rbac.resolveScope(input.session, client).catch(function () { return null; });
        if (scope && scope.vessels) vessels = scope.vessels.map(function (v) { return v.name; });
      }
      return {
        measurements: METRICS.filter(function (m) { return !m.finerVersionOf; })
          .map(function (m) { return { name: m.label, unit: m.unit, about: m.description }; }),
        vessels: vessels,
        help_topics: GUIDE.map(function (g) { return g.title; }),
      };
    },

    async get_fleet_briefing() {
      const client = await getDb();
      const scope = await rbac.resolveScope(input.session, client);
      if (!scope.authenticated) return { error: 'not signed in' };
      if (!scope.vessels.length) return { error: 'no vessels in this user\'s scope' };
      const briefing = await buildBriefing(
        scope.vesselIds,
        scope.vessels.map(function (v) { return v.name; }),
        client
      );
      visuals.dataUsed = true;
      return { text: String(briefing.text || '').slice(0, 2000), findings: briefing.findings };
    },

    async search_app_help(args) {
      const hits = searchGuide(String((args && args.query) || ''), 3);
      if (!hits.length) return { matches: [], note: 'nothing in the help centre covers this' };
      return { matches: hits.map(function (g) { return { title: g.title, answer: g.answer }; }) };
    },

    async show_chart(args) {
      const labels = Array.isArray(args && args.labels) ? args.labels.map(String) : [];
      const values = Array.isArray(args && args.values) ? args.values.map(Number) : [];
      if (labels.length < 2 || labels.length !== values.length || labels.length > 24) {
        return { error: 'labels and values must be the same length, between 2 and 24 points' };
      }
      if (values.some(function (v) { return !isFinite(v); })) return { error: 'values must all be numbers' };
      visuals.chart = {
        type: args.type === 'line' ? 'line' : 'bar',
        title: args.title ? String(args.title).slice(0, 80) : undefined,
        labels: labels.slice(0, 24),
        values: values.slice(0, 24),
        unit: args.unit ? String(args.unit).slice(0, 16) : undefined,
      };
      return { ok: true, note: 'chart is now displayed to the user; do not repeat every value in your reply' };
    },
  };

  return { handlers: handlers, visuals: visuals };
}

// ---------------------------------------------------------------------------
// Model transport — OpenAI-compatible /chat/completions with tools.
// ---------------------------------------------------------------------------

function readEnv(env) {
  return {
    url: (env.CAPTAIN_LLM_URL || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
    model: env.CAPTAIN_AGENT_MODEL || env.CAPTAIN_LLM_MODEL || '',
    apiKey: env.CAPTAIN_LLM_API_KEY || null,
    appName: env.CAPTAIN_APP_NAME || 'this application',
    maxSteps: clampInt(env.CAPTAIN_AGENT_MAX_STEPS, DEFAULTS.maxSteps, 1, 8),
    timeoutMs: clampInt(env.CAPTAIN_AGENT_TIMEOUT_MS, DEFAULTS.timeoutMs, 3000, 180000),
    maxTokens: clampInt(env.CAPTAIN_AGENT_MAX_TOKENS, DEFAULTS.maxTokens, 128, 4096),
    temperature: Number.isFinite(parseFloat(env.CAPTAIN_AGENT_TEMPERATURE))
      ? parseFloat(env.CAPTAIN_AGENT_TEMPERATURE) : DEFAULTS.temperature,
    // Reasoning models burn seconds before speaking. Off unless asked for.
    reasoningOff: (env.CAPTAIN_LLM_REASONING || 'off').toLowerCase() !== 'on',
    referer: env.CAPTAIN_LLM_REFERER || null,
    title: env.CAPTAIN_LLM_TITLE || 'Captain Nav',
  };
}

function clampInt(raw, dflt, lo, hi) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

function buildBody(cfg, messages) {
  const body = {
    model: cfg.model,
    messages: messages,
    tools: toolDefs(),
    tool_choice: 'auto',
    max_tokens: cfg.maxTokens,
    temperature: cfg.temperature,
    stream: false,
  };
  if (cfg.reasoningOff && /openrouter\.ai/i.test(cfg.url)) body.reasoning = { enabled: false };
  return body;
}

function headersFor(cfg) {
  const h = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) h.Authorization = 'Bearer ' + cfg.apiKey;
  // OpenRouter attribution headers; harmless elsewhere.
  if (/openrouter\.ai/i.test(cfg.url)) {
    if (cfg.referer) h['HTTP-Referer'] = cfg.referer;
    if (cfg.title) h['X-Title'] = cfg.title;
  }
  return h;
}

async function callModel(cfg, messages, fetchImpl, signal) {
  const res = await fetchImpl(cfg.url + '/v1/chat/completions', {
    method: 'POST',
    headers: headersFor(cfg),
    body: JSON.stringify(buildBody(cfg, messages)),
    signal: signal,
  });
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch (_) { /* ignore */ }
    const err = new Error('HTTP ' + res.status + ': ' + String(detail).slice(0, 200));
    err.httpStatus = res.status;
    throw err;
  }
  const data = await res.json();
  const choice = data && data.choices && data.choices[0];
  if (!choice || !choice.message) throw new Error('no choices in response');
  return choice.message;
}

/** Tool arguments arrive as a JSON string and are not always valid JSON. */
function parseArgs(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_) { /* fall through */ }
  // Some models wrap the JSON in a code fence.
  const m = String(raw).match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) { /* give up */ } }
  return null;
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/**
 * @param {object} input  { text, session, pending, now, history, context }
 * @param {Function} getDb  async () => pg client (throws if unavailable)
 * @param {object} opts   { orgId, writeDb, dateOrder, env, fetchImpl }
 */
async function run(input, getDb, opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const cfg = readEnv(env);
  const fetchImpl = opts.fetchImpl || globalThis.fetch;

  if (!cfg.model) {
    return { status: 'error', source: 'agent', reason: 'no_model', text: UNAVAILABLE, error: 'CAPTAIN_LLM_MODEL is not set' };
  }

  const tz = input.context && input.context.tz ? String(input.context.tz) : null;
  const system = systemPrompt({
    appName: cfg.appName,
    nowLabel: formatNow(input.now ? new Date(input.now) : new Date(), tz).label,
    userName: input.context && input.context.userName ? String(input.context.userName).slice(0, 60) : null,
    vesselName: input.context && input.context.vesselName ? String(input.context.vesselName).slice(0, 80) : null,
  });

  const messages = [{ role: 'system', content: system }];
  (input.history || []).slice(-DEFAULTS.historyTurns).forEach(function (h) {
    if (!h || !h.text) return;
    messages.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.text).slice(0, 1000) });
  });
  messages.push({ role: 'user', content: String(input.text || '').slice(0, 2000) });

  const tools = makeTools(input, getDb, opts);

  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, cfg.timeoutMs) : null;
  const trace = [];

  try {
    for (let step = 0; step < cfg.maxSteps; step++) {
      const msg = await callModel(cfg, messages, fetchImpl, ctrl ? ctrl.signal : undefined);
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

      if (!calls.length) {
        // Only the un-toolled path needs the fleet's names, and only for the
        // fabrication guard below — so the lookup happens here, not up front.
        const names = await fleetNames(input, getDb, tools.visuals);
        return finish(String(msg.content || '').trim(), tools.visuals, cfg, trace, input, names);
      }

      // Record the assistant's tool-call turn verbatim; the protocol requires
      // it to precede the matching tool results.
      messages.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });

      for (const call of calls) {
        const name = call.function && call.function.name;
        const handler = tools.handlers[name];
        let result;
        if (!handler) {
          result = { error: 'unknown tool: ' + name };
        } else {
          const args = parseArgs(call.function && call.function.arguments);
          if (args === null) {
            result = { error: 'arguments were not valid JSON; call the tool again with a proper JSON object' };
          } else {
            try {
              result = await handler(args);
            } catch (err) {
              // A failed tool is a fact for the model to relay honestly, not a
              // crash and not something to paper over with a guess.
              const notConfigured = err && err.code === 'DB_NOT_CONFIGURED';
              result = {
                error: notConfigured
                  ? 'the vessel database is not configured on this deployment'
                  : 'the lookup failed: ' + String((err && err.message) || err).slice(0, 200),
                tell_the_user: true,
              };
            }
          }
          trace.push({ tool: name, ok: !result || !result.error });
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: name,
          content: JSON.stringify(result).slice(0, 6000),
        });
      }
    }

    // Out of steps: ask for a plain answer with what it has, no more tools.
    messages.push({
      role: 'user',
      content: 'Answer now in plain language using what you already have. Do not call any more tools.',
    });
    const last = await callModel(cfg, messages, fetchImpl, ctrl ? ctrl.signal : undefined);
    return finish(String(last.content || '').trim(), tools.visuals, cfg, trace, input, await fleetNames(input, getDb, tools.visuals));
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    return {
      status: 'error',
      source: 'agent',
      reason: aborted ? 'timeout' : 'model_error',
      text: aborted
        ? 'That took longer than I could wait for. Nothing was changed — try asking again, or more simply.'
        : UNAVAILABLE,
      error: String((err && err.message) || err).slice(0, 300),
      model: cfg.model,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The names of the vessels this user can see, for the fabrication guard. Only
 * consulted when no tool ran (so the model had no legitimate source for a
 * figure); if the database is unreachable the guard simply falls back to its
 * phrase-based detection.
 */
async function fleetNames(input, getDb, visuals) {
  if (visuals.dataUsed) return [];
  const fromContext = input.context && input.context.vesselName ? [String(input.context.vesselName)] : [];
  try {
    const client = await getDb();
    const scope = await rbac.resolveScope(input.session, client);
    const names = (scope && scope.vessels ? scope.vessels : []).map(function (v) { return v.name; });
    return fromContext.concat(names);
  } catch (_) {
    return fromContext;
  }
}

/**
 * Final assembly plus the one safety check that survives AI-first mode: if no
 * tool returned data this turn, a figure that looks like one of the user's
 * vessel readings cannot have come from anywhere real, so it is replaced.
 */
function finish(text, visuals, cfg, trace, input, fleet) {
  let blocked = false;
  let out = text;

  if (!out) {
    out = 'I did not manage to put an answer together for that one. Try asking it a different way?';
  } else if (!visuals.dataUsed) {
    if (containsStatedFigure(out, fleet || [])) {
      blocked = true;
      out = "I don't want to guess at one of your figures. Ask me directly \u2014 for example "
        + '"fuel consumption for <vessel> last month" \u2014 and I\'ll pull it from the records.';
    }
  }

  const answer = {
    status: 'answer',
    source: 'agent',
    text: out,
    model: cfg.model,
  };
  if (visuals.chart) answer.chart = visuals.chart;
  if (visuals.series) answer.series = visuals.series;
  if (visuals.provenance) answer.provenance = visuals.provenance;
  if (visuals.unit) answer.unit = visuals.unit;
  if (visuals.pending) answer.pending = visuals.pending;
  if (blocked) answer.blocked = true;
  if (trace.length) answer.toolsUsed = trace.map(function (t) { return t.tool; });
  return answer;
}

module.exports = { run, systemPrompt, toolDefs, readEnv, parseArgs, summariseData, fleetNames, DEFAULTS, AGENT_BUILD };