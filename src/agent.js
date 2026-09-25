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
 * This is the default mode. KRIS_MODE=router keeps the old router.
 */

const engine = require('./engine');
const rbac = require('./rbac');
const { searchGuide, GUIDE } = require('./guide');
const { buildBriefing } = require('./alerts');
const { containsStatedFigure, providerRouting, SAFE_REDIRECT, VISUAL_GUIDE, ANSWER_SHAPE, DOMAIN_FACTS, FORMATTING, answerDepth, llmConfigured, effortFor, DEFAULTS: LLM, HISTORY_TURNS, HISTORY_CHARS, MESSAGE_CHARS } = require('./companion_src');
const { readSSE, accumulateOpenAI, SentenceGate, anySignal, hasReasoning, thinkingBeat, guardable } = require('./stream');
const { formatNow } = require('./instant_src');
const { profilePrompt, userFactsFrom } = require('./profile');
const { METRICS } = require('./config');
const { MODEL_LABEL } = require('./identity');
const turns = require('./turn');
const records = require('./records');
const { scopeCache, scopeKey } = require('./cache');

const AGENT_BUILD = '2026-09-25.kris-12';

const DEFAULTS = {
  maxSteps: 4,          // model turns per message, including the final answer
  timeoutMs: 45000,     // longest the model may stay silent (re-armed by every streamed chunk)
  maxTokens: 8192,      // reasoning + answer share it; a ceiling, not a target
};

const UNAVAILABLE =
  "I couldn't reach my reasoning service just now, so I'm running in reduced mode. Ask me a vessel question or an app question and I'll still answer.";

// ---------------------------------------------------------------------------
// Tool definitions — the whole "API" the model gets. Adding a capability to
// K.R.1.S means adding an entry here and a handler below. Nothing else.
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
          + 'If the user was vague, ask them a clarifying question instead of guessing a vessel or period. '
          + 'Not for questions about how something works, steps, processes, definitions or regulations: '
          + 'those need no records, answer them yourself.',
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
        name: 'get_vessel_records',
        description:
          "Read records about THIS user's vessels: anything that is a fact, a list or a status rather than one "
          + 'measurement over a period. Use it for vessel particulars, voyages and their ports, days and fuel, '
          + 'bunker deliveries, annual DCS/MRV figures, AER and CII ratings, FuelEU balances after banking and '
          + 'pooling and penalties, EU ETS and UK ETS allowances, carbon exposure, compliance filings, carbon '
          + 'trades and allocations, invoices and emails. Rows come newest first. Answer ONLY from what it '
          + 'returns; if it returns nothing, say the records do not hold it. To compare vessels, omit vessel. '
          + 'Topics:\n' + records.topicGuide(),
        parameters: {
          type: 'object',
          properties: {
            topic: { type: 'string', enum: records.TOPICS },
            vessel: { type: 'string', description: 'Vessel name, IMO or code. Omit for every vessel the user can see.' },
            voyage: { type: 'string', description: 'Voyage number or reference, e.g. V2612.' },
            year: { type: 'integer', description: 'Calendar or reporting year.' },
            from: { type: 'string', description: 'Earliest date, YYYY-MM-DD.' },
            to: { type: 'string', description: 'Latest date, YYYY-MM-DD.' },
            filter: { type: 'object', description: 'Equality filters on the columns a topic allows, e.g. {"category":"bdn_request"}, {"regime":"EU_MRV"}, {"status":"overdue"}, {"period":"YEAR"}.', additionalProperties: { type: 'string' } },
            latest: { type: 'boolean', description: 'Only the newest row per vessel, e.g. the latest voyage.' },
            limit: { type: 'integer', description: 'Rows to return (default 8, max 50).' },
          },
          required: ['topic'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_available_data',
        description:
          'List which measurements K.R.1.S can read and which vessels this user is allowed to see. '
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
        name: 'remember_user_details',
        description:
          'Offer to remember basic details the user has just told you about THEMSELVES in their latest message: '
          + 'their name, what to call them, role, company, department or team, where they are based, time zone, '
          + 'professional interests. Copy each value from their own words; never infer, guess or add anything '
          + 'they did not say, and never pass passwords, IDs, contact details, health, religion, politics, family '
          + 'or money. The user is asked to confirm before anything is saved, so never say it is saved.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            preferredName: { type: 'string', description: 'What they asked to be called.' },
            role: { type: 'string' },
            company: { type: 'string' },
            department: { type: 'string' },
            location: { type: 'string' },
            timezone: { type: 'string', description: 'IANA time zone, e.g. Asia/Kolkata.' },
            interests: { type: 'array', items: { type: 'string' } },
          },
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
    'You are K.R.1.S (say it "Kris"), the assistant built into ' + (opts.appName || 'this application')
    + ', a maritime compliance and fleet-analytics application. K.R.1.S is a codename inspired by Lord Krishna, '
    + 'the calm charioteer who guides without taking the wheel. Carry that spirit lightly: serene, warm, '
    + 'clear-sighted, gently playful, never preachy. Do not quote scripture or make religious claims unless the '
    + 'user raises the subject, and treat it with respect when they do. Your name is K.R.1.S; say so if asked, '
    + 'and ask the user their name once, early, if you do not know it.'
  );
  lines.push(
    'You are a fully capable general assistant first. Answer whatever is actually asked — general knowledge, '
    + 'explanations, arithmetic, unit conversions, comparing numbers the user gives you, drafting, or just '
    + 'conversation. Do not steer unrelated questions back to ships. If someone asks which of two numbers is '
    + 'bigger, just answer it; that has nothing to do with vessel data. People type fast: read past typos to what '
    + 'they mean and never comment on spelling.'
  );
  lines.push(
    'You run on ' + MODEL_LABEL + '. If asked what model, LLM or AI you are, say you are K.R.1.S running on '
    + MODEL_LABEL + ', and never name any other model, vendor or company.'
  );
  lines.push(
    'You have tools for the things you cannot know: the user\'s own vessel records, their fleet briefing, and '
    + 'the app\'s help centre. Decide for yourself when one is needed. Use them whenever they make the answer '
    + 'more accurate or more useful: get_vessel_data for a measurement over a period (fuel last month, CO2 this '
    + 'year), get_vessel_records for everything else about their ships (particulars, voyages, ports, CII, '
    + 'FuelEU, allowances, exposure, filings, trades, invoices, emails), search the help centre '
    + 'for anything about using the app. Skip them when they add nothing; general knowledge and conversation '
    + 'need no tool. When the user tells you about themselves (their name, role, company, team, location, time '
    + 'zone or interests), call remember_user_details with exactly what they said, then reply naturally.'
  );
  lines.push(
    'THE ONE HARD RULE: never state, estimate or imply a figure about this user\'s vessels unless a tool '
    + 'returned it in this conversation. General maritime facts are fine ("a Panamax might burn 30 tonnes a '
    + 'day"). A number presented as THEIR ship\'s is not, ever. If a lookup fails or returns nothing, say so '
    + 'plainly — never fill the gap with a plausible number.'
  );
  lines.push(
    'Prefer a useful answer to a clarifying question. Before asking, work out what the user is trying to do and '
    + 'whether you can already help. Ask only when the ambiguity would change the answer materially and no useful '
    + 'answer covers the likely readings: which vessel or which period for a figure from their records is the '
    + 'typical case. A broad question ("what are the steps to verify and report emissions?") gets the general '
    + 'answer, then one line offering the specific version (EU MRV, EU ETS, FuelEU Maritime, IMO DCS). A word '
    + 'with several meanings is not by itself a reason to ask.'
  );
  lines.push(
    'Known, inferred, unknown: state what the conversation, a tool or the reference below gives you; mark an '
    + 'inference as one; say plainly when something is not available. Never invent vessel data, IMO numbers, '
    + 'emission values, regulation details, dates, report names, company facts or database values.'
  );
  lines.push(
    'Lead with the answer. Think multi-step problems through before answering and check arithmetic and logic. '
    + 'Be accurate rather than confident: if you are unsure, or something may have changed since your training, '
    + 'say so briefly. Never mention tools, modules, function names or internal machinery — the user sees '
    + 'K.R.1.S, not a system.'
  );
  lines.push(ANSWER_SHAPE[ANSWER_SHAPE[opts.depth] ? opts.depth : 'brief']);
  lines.push(FORMATTING);
  lines.push(DOMAIN_FACTS);
  if (opts.nowLabel) {
    lines.push('Current date and time: ' + opts.nowLabel
      + '. Use it for anything involving today, dates or elapsed time; never claim not to know the date.');
  }
  if (opts.userName) {
    lines.push('The user\'s name is ' + opts.userName + '. Use it occasionally and naturally, not every reply.');
  }
  if (opts.vesselName) {
    lines.push('The current vessel is "' + opts.vesselName
      + '" (the user chose it or is viewing it in the app), so a vessel question that names no vessel is about that one.');
  } else if (opts.fleet) {
    lines.push('The user set their whole fleet as the current context, so a vessel question that names no vessel is about all of their vessels.');
  }
  const about = profilePrompt(opts.profile, opts.userName);
  if (about) lines.push(about);
  lines.push(VISUAL_GUIDE);
  lines.push(turns.LATEST_RULE);
  if (opts.frame) lines.push(opts.frame);
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
      // Only the LAST lookup's question can still be open.
      visuals.pending = out.pending || null;
      visuals.options = out.pending && Array.isArray(out.options) ? out.options.slice(0, 8) : null;
      return summariseData(out);
    },

    async get_vessel_records(args) {
      const client = await getDb();
      const scope = opts.scopeCache
        ? await scopeCache.load(scopeKey(input.session), function () { return rbac.resolveScope(input.session, client); })
        : await rbac.resolveScope(input.session, client);
      if (!scope.authenticated) return { error: 'not signed in' };
      const out = await records.lookup(client, scope, args || {});
      if (out.rows && out.rows.length) {
        visuals.dataUsed = true;
        visuals.sources = visuals.sources || [];
        if (visuals.sources.indexOf(out.label) < 0) visuals.sources.push(out.label);
        // Positions always come with a map, drawn from the rows themselves, so
        // where the pin sits never depends on the model copying coordinates.
        const map = positionMap(out.topic, out.rows);
        if (map) { visuals.map = map; out.note = 'A map of these positions is shown under your answer; do not draw another.'; }
      }
      return out;
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
        records: records.TOPICS,
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

    async remember_user_details(args) {
      const heard = userFactsFrom(args, input.text);
      if (!heard.length) return { error: 'nothing offered: every value must be something the user said about themselves in their latest message' };
      visuals.remember = heard;
      return { offered: heard.map(function (f) { return f.key; }), note: 'The user will be asked whether to remember these. Do not say they are saved.' };
    },
  };

  return { handlers: handlers, visuals: visuals };
}

// ---------------------------------------------------------------------------
// Model transport — OpenAI-compatible /chat/completions with tools.
// ---------------------------------------------------------------------------

function readEnv(env) {
  return {
    url: (env.KRIS_LLM_URL || LLM.url).replace(/\/+$/, ''),
    model: env.KRIS_LLM_MODEL || LLM.model,
    apiKey: env.KRIS_LLM_API_KEY || null,
    appName: env.KRIS_APP_NAME || 'this application',
    maxSteps: clampInt(env.KRIS_AGENT_MAX_STEPS, DEFAULTS.maxSteps, 1, 8),
    timeoutMs: clampInt(env.KRIS_AGENT_TIMEOUT_MS, DEFAULTS.timeoutMs, 3000, 180000),
    maxTokens: clampInt(env.KRIS_AGENT_MAX_TOKENS, DEFAULTS.maxTokens, 128, 32768),
    // Unset = the model's own recommended temperature.
    temperature: Number.isFinite(parseFloat(env.KRIS_AGENT_TEMPERATURE)) ? parseFloat(env.KRIS_AGENT_TEMPERATURE) : undefined,
    effort: 'medium',   // set per message by run()
    referer: env.KRIS_LLM_REFERER || null,
    title: env.KRIS_LLM_TITLE || 'K.R.1.S',
    env: env,
  };
}

function clampInt(raw, dflt, lo, hi) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

function buildBody(cfg, messages, stream) {
  const body = {
    model: cfg.model,
    messages: messages,
    tools: toolDefs(),
    tool_choice: 'auto',
    max_tokens: cfg.maxTokens,
    stream: !!stream,
  };
  if (cfg.temperature !== undefined) body.temperature = cfg.temperature;
  // Reasoning streams back as a heartbeat for the idle timer; it is never shown.
  if (/openrouter\.ai/i.test(cfg.url)) body.reasoning = { effort: cfg.effort || 'medium' };
  const routing = providerRouting(cfg.env, cfg.url);
  if (routing) body.provider = routing;
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

/**
 * POST one completion. Retries once without the reasoning/provider fields if
 * the provider rejects them with a 400. Returns the raw Response.
 */
async function postCompletion(cfg, messages, fetchImpl, signal, stream) {
  const url = cfg.url + '/v1/chat/completions';
  let body = buildBody(cfg, messages, stream);
  let res = await fetchImpl(url, { method: 'POST', headers: headersFor(cfg), body: JSON.stringify(body), signal: signal });
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch (_) { /* ignore */ }
    if (res.status === 400 && (body.reasoning || body.provider) && /reasoning|provider/i.test(String(detail))) {
      body = Object.assign({}, body); delete body.reasoning; delete body.provider;
      res = await fetchImpl(url, { method: 'POST', headers: headersFor(cfg), body: JSON.stringify(body), signal: signal });
      if (!res.ok) { try { detail = await res.text(); } catch (_) { /* ignore */ } }
    }
    if (!res.ok) {
      const err = new Error('HTTP ' + res.status + ': ' + String(detail).slice(0, 200));
      err.httpStatus = res.status;
      throw err;
    }
  }
  return res;
}

async function callModel(cfg, messages, fetchImpl, signal) {
  const res = await postCompletion(cfg, messages, fetchImpl, signal, false);
  const data = await res.json();
  const choice = data && data.choices && data.choices[0];
  if (!choice || !choice.message) throw new Error('no choices in response');
  return choice.message;
}

/**
 * Streamed completion. Content deltas go to onContent as they arrive; tool
 * call fragments are accumulated. Resolves to the assembled message.
 * A provider that ignores stream:true and answers with JSON still works.
 */
async function callModelStream(cfg, messages, fetchImpl, signal, onContent, onActivity) {
  const res = await postCompletion(cfg, messages, fetchImpl, signal, true);
  const ctype = String((res.headers && res.headers.get && res.headers.get('content-type')) || '');
  if (/application\/json/i.test(ctype)) {
    const data = await res.json();
    const choice = data && data.choices && data.choices[0];
    if (!choice || !choice.message) throw new Error('no choices in response');
    if (choice.message.content && !(choice.message.tool_calls && choice.message.tool_calls.length)) onContent(String(choice.message.content));
    return choice.message;
  }
  const acc = accumulateOpenAI();
  await readSSE(res, function (chunk) { if (onActivity) onActivity(chunk); acc.push(chunk, onContent); });
  return acc.result();
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
 * @param {object} opts   { orgId, writeDb, dateOrder, env, fetchImpl,
 *                          onDelta?, signal?, fleetNames? }
 *   onDelta   stream the answer: { t: 'delta', text } / { t: 'replace', text }
 *   fleetNames  async () => string[] — the user's vessel names for the
 *             fabrication guard, from a cache. Started in PARALLEL with the
 *             model call so it never adds latency.
 */
async function run(input, getDb, opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const cfg = readEnv(env);
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const streaming = typeof opts.onDelta === 'function';

  if (!llmConfigured(env)) {
    return { status: 'error', source: 'agent', reason: 'no_model', text: UNAVAILABLE, error: 'no model configured: set KRIS_LLM_API_KEY' };
  }
  cfg.effort = effortFor(input.text, env);

  const tz = input.context && input.context.tz ? String(input.context.tz) : null;
  const turn = input.turn || turns.analyseTurn(input);
  const system = systemPrompt({
    frame: turns.frameLine(turn),
    appName: cfg.appName,
    nowLabel: formatNow(input.now ? new Date(input.now) : new Date(), tz).label,
    userName: input.context && input.context.userName ? String(input.context.userName).slice(0, 60) : null,
    vesselName: input.context && input.context.vesselName ? String(input.context.vesselName).slice(0, 80) : null,
    fleet: !!(input.context && input.context.fleet),
    profile: input.context && input.context.profile ? input.context.profile : null,
    depth: answerDepth(input.text, input.context && input.context.profile),
  });

  const messages = [{ role: 'system', content: system }]
    .concat(turns.modelHistory(input.history, HISTORY_TURNS, HISTORY_CHARS));
  messages.push({ role: 'user', content: String(input.text || '').slice(0, MESSAGE_CHARS) });
  // Figures already said in this conversation may be restated; only new ones are checked.
  const known = turns.knownFigures(input.history, input.text);

  const tools = makeTools(input, getDb, opts);

  // Names for the guard: resolved in parallel with the model, from cache.
  const fromContext = input.context && input.context.vesselName ? [String(input.context.vesselName)] : [];
  let fleet = fromContext.slice();
  const namesP = (typeof opts.fleetNames === 'function'
    ? Promise.resolve().then(opts.fleetNames).catch(function () { return []; })
    : fleetNames(input, getDb, tools.visuals)
  ).then(function (names) { fleet = fromContext.concat(names || []); return fleet; });
  const namesReady = function () {
    return Promise.race([namesP, new Promise(function (r) { const t = setTimeout(r, 400); if (t.unref) t.unref(); })]);
  };

  // An idle timer: re-armed at every model turn and by every streamed chunk
  // (reasoning included), so silence fails and a long answer does not.
  // Unstreamed, nothing arrives until the turn is written: a longer leash.
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer = null;
  const arm = function () {
    if (!ctrl) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { ctrl.abort(); }, streaming ? cfg.timeoutMs : cfg.timeoutMs * 4);
  };
  const beat = thinkingBeat(streaming ? opts.onDelta : null, 5000);
  const onActivity = function (chunk) { arm(); if (hasReasoning(chunk)) beat(); };
  const signal = anySignal([ctrl ? ctrl.signal : null, opts.signal || null]);
  const trace = [];

  // Streaming state across steps.
  let shown = '';           // text actually released to the user so far
  let replaced = false;
  let gate = null;
  let namesAwaited = false;
  const pendingPieces = [];
  const openGate = function () {
    gate = new SentenceGate({
      guard: !tools.visuals.dataUsed,
      check: function (piece) { return containsStatedFigure(piece, fleet, known); },
      emit: function (piece) {
        const sep = shown && !/\s$/.test(shown) && gate._first ? '\n\n' : '';
        gate._first = false;
        shown += sep + piece;
        opts.onDelta({ t: 'delta', text: sep + piece });
      },
      onHold: function () { opts.onDelta({ t: 'status', text: 'Preparing a visual', phase: 'visual' }); },
    });
    gate._first = true;
  };
  const onContent = function (delta) {
    if (!gate || gate.blocked) return;
    if (!namesAwaited) {
      // Hold text until the guard has the fleet names (normally already here).
      pendingPieces.push(delta);
      return;
    }
    gate.push(delta);
    if (gate.blocked && ctrl) ctrl.abort();
  };
  const call = async function () {
    arm();
    if (!streaming) return callModel(cfg, messages, fetchImpl, signal);
    openGate();
    namesAwaited = false;
    namesReady().then(function () {
      namesAwaited = true;
      const held = pendingPieces.splice(0).join('');
      if (held) { gate.push(held); if (gate.blocked && ctrl) ctrl.abort(); }
    });
    let msg;
    try {
      msg = await callModelStream(cfg, messages, fetchImpl, signal, onContent, onActivity);
    } catch (err) {
      if (gate && gate.blocked) return { content: '', blocked: true };
      throw err;
    }
    await namesReady();
    namesAwaited = true;
    const held = pendingPieces.splice(0).join('');
    if (held) gate.push(held);
    if (!gate.blocked) gate.end();
    if (gate.blocked) return { content: '', blocked: true };
    return msg;
  };

  let nudged = false;
  try {
    for (let step = 0; step < cfg.maxSteps; step++) {
      const msg = await call();
      if (msg.blocked) { replaced = true; break; }
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

      if (!calls.length) {
        const names = await namesReady().then(function () { return fleet; });
        const final = streaming ? shown.trim() || String(msg.content || '').trim() : String(msg.content || '').trim();
        // Validation: a reply that repeats one of the last two replies (the
        // same clarifying question, the same answer) is a loop. One retry,
        // told so; the second attempt stands whatever it is.
        if (!nudged && step < cfg.maxSteps - 1 && turns.repeatsRecent(final, input.history)) {
          nudged = true;
          messages.push({ role: 'assistant', content: final });
          messages.push({ role: 'user', content: 'You just repeated your previous reply. Do not repeat it or ask it again: answer my latest message directly, with the most reasonable reading.' });
          if (streaming) { shown = ''; opts.onDelta({ t: 'replace', text: '' }); }
          continue;
        }
        return finish(final, tools.visuals, cfg, trace, input, names, streaming, opts, false, known);
      }

      // Record the assistant's tool-call turn verbatim; the protocol requires
      // it to precede the matching tool results.
      messages.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
      if (streaming) opts.onDelta({ t: 'status', text: statusFor(calls) });

      for (const c of calls) {
        const name = c.function && c.function.name;
        const handler = tools.handlers[name];
        let result;
        if (!handler) {
          result = { error: 'unknown tool: ' + name };
        } else {
          const args = parseArgs(c.function && c.function.arguments);
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
          tool_call_id: c.id,
          name: name,
          content: JSON.stringify(result).slice(0, 16000),
        });
      }
      // The records have been read: give the connection back before the
      // model writes its answer (seconds), so it can serve another user.
      if (typeof opts.releaseDb === 'function') opts.releaseDb();
    }

    if (replaced) {
      opts.onDelta({ t: 'replace', text: SAFE_REDIRECT });
      return finish(SAFE_REDIRECT, tools.visuals, cfg, trace, input, fleet, streaming, opts, true);
    }

    // Out of steps: ask for a plain answer with what it has, no more tools.
    messages.push({
      role: 'user',
      content: 'Answer now in plain language using what you already have. Do not call any more tools.',
    });
    const last = await call();
    if (last.blocked) {
      opts.onDelta({ t: 'replace', text: SAFE_REDIRECT });
      return finish(SAFE_REDIRECT, tools.visuals, cfg, trace, input, fleet, streaming, opts, true);
    }
    await namesReady();
    return finish(streaming ? shown.trim() || String(last.content || '').trim() : String(last.content || '').trim(), tools.visuals, cfg, trace, input, fleet, streaming, opts, false, known);
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    const external = opts.signal && opts.signal.aborted;
    return {
      status: 'error',
      source: 'agent',
      reason: external ? 'cancelled' : aborted ? 'timeout' : 'model_error',
      text: aborted
        ? 'That took longer than I could wait for. Nothing was changed \u2014 try asking again, or more simply.'
        : UNAVAILABLE,
      error: String((err && err.message) || err).slice(0, 300),
      model: cfg.model,
      partial: streaming && shown ? shown : undefined,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A map visual for rows that carry positions: the current position, or a voyage's reports as a track. */
function positionMap(topic, rows) {
  const at = rows.filter(function (r) { return typeof r.latitude === 'number' && typeof r.longitude === 'number'; });
  if (!at.length) return null;
  if (topic === 'positions') {
    return {
      type: 'map', title: at.length === 1 ? at[0].vessel_name + ' now' : 'Where your vessels are',
      points: at.map(function (r) {
        const bits = [r.situation, r.to_port_name && r.situation === 'at sea' ? 'to ' + r.to_port_name : null,
          r.speed_kn ? r.speed_kn + ' kn' : null, r.eta ? 'ETA ' + String(r.eta).slice(0, 10) : null];
        return { name: r.vessel_name, lat: r.latitude, lon: r.longitude, note: bits.filter(Boolean).join(', ') };
      }),
    };
  }
  if (topic === 'reports' && at.length > 2 && new Set(at.map(function (r) { return r.vessel_id; })).size === 1) {
    const newest = at[0];
    return {
      type: 'map', title: newest.vessel_name + (newest.voyage_no ? ' voyage ' + newest.voyage_no : '') + ' track',
      points: [{ name: newest.vessel_name, lat: newest.latitude, lon: newest.longitude, note: String(newest.report_time).slice(0, 16) }],
      track: at.slice().reverse().map(function (r) { return [r.latitude, r.longitude]; }),
    };
  }
  return null;
}

/** A short line for the widget while a tool runs ("Reading the records"). */
function statusFor(calls) {
  const names = calls.map(function (c) { return c.function && c.function.name; });
  if (names.indexOf('get_vessel_data') >= 0 || names.indexOf('get_vessel_records') >= 0) return 'Reading the records';
  if (names.indexOf('get_fleet_briefing') >= 0) return 'Checking your fleet';
  if (names.indexOf('search_app_help') >= 0) return 'Looking that up';
  if (names.indexOf('remember_user_details') >= 0) return 'Noting that';
  return 'Working on it';
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
function finish(text, visuals, cfg, trace, input, fleet, streaming, opts, alreadyBlocked, known) {
  let blocked = !!alreadyBlocked;
  let out = text;

  if (!out) {
    out = 'I did not manage to put an answer together for that one. Try asking it a different way?';
    if (streaming && opts && opts.onDelta) opts.onDelta({ t: 'replace', text: out });
  } else if (!visuals.dataUsed && !blocked) {
    if (containsStatedFigure(guardable(out), fleet || [], known)) {
      blocked = true;
      out = "I don't want to guess at one of your figures. Ask me directly \u2014 for example "
        + '"fuel consumption for <vessel> last month" \u2014 and I\'ll pull it from the records.';
      if (streaming && opts && opts.onDelta) opts.onDelta({ t: 'replace', text: out });
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
  // Where a record answer came from, in one line under it.
  if (visuals.sources && visuals.sources.length && !visuals.provenance) answer.footnote = 'From the records: ' + visuals.sources.join(', ');
  if (visuals.map) answer.visuals = [visuals.map];
  if (visuals.unit) answer.unit = visuals.unit;
  // An engine question stays open only if the reply actually asks one and no
  // later lookup answered it; otherwise it would hijack the next message.
  if (visuals.pending && !visuals.dataUsed && /\?/.test(out)) {
    answer.pending = visuals.pending;
    if (visuals.options && visuals.options.length) answer.options = visuals.options;
  }
  // Details the model heard the user state about themselves: the widget asks before keeping any.
  if (visuals.remember && visuals.remember.length) answer.remember = { facts: visuals.remember };
  if (blocked) answer.blocked = true;
  if (streaming) answer.streamed = true;
  if (trace.length) answer.toolsUsed = trace.map(function (t) { return t.tool; });
  return answer;
}

module.exports = { run, systemPrompt, toolDefs, readEnv, parseArgs, summariseData, fleetNames, buildBody, DEFAULTS, AGENT_BUILD };