'use strict';

/**
 * Entry point for a widget message.
 *
 * The first decision is made WITHOUT the database: does this message need
 * vessel records at all? Greetings, app-navigation questions and small talk
 * never touch Postgres — they are answered even when the database is down
 * or not yet configured. A connection is opened only for messages that are
 * actually asking about data.
 *
 * Precedence, in order:
 *
 *   0. instant facts (no DB, no model): date, time, arithmetic
 *   1. classify (no DB)
 *        help          -> the metric list, from config
 *        data / teach  -> engine.ask()        (needs DB; unchanged, deterministic)
 *        briefing      -> alerts.js           (needs DB; deterministic SQL)
 *        small talk    -> companion.js, or a fixed line with no model (no DB)
 *        other         -> guide.js            (no DB; a warm learned-term cache may veto)
 *                      -> learned-term check  (DB, cached 60s, only if reachable)
 *                      -> companion.js        (no DB access; LLM, output-guarded)
 *
 * The safety property is unchanged: a data-shaped question never reaches the
 * companion. The classifier recognises data shape from the same metric
 * aliases the parser uses, so anything the parser would have handled is
 * still routed to it first.
 */

const engine = require('./engine');
const rbac = require('./rbac');
const parser = require('./parser');
const terms = require('./terms');
const { matchGuide, searchGuide } = require('./guide');
const { isBriefingRequest, buildBriefing } = require('./alerts');
const { converse, isLightMessage, llmConfigured } = require('./companion_src');
const { answerInstant, formatNow } = require('./instant_src');
const identity = require('./identity');
const agent = require('./agent');
const turns = require('./turn');
const { scopeCache, learnedCache, scopeKey } = require('./cache');

const ROUTER_BUILD = '2026-09-25.kris-13';
const dates = require('./dates');
const { METRICS } = require('./config');

const DB_NOT_CONFIGURED = 'My database connection is not configured yet, so I cannot read vessel records. I can still help with the app, or just chat.';
const DB_UNREACHABLE = 'I cannot reach the vessel database right now, so I cannot look that up. Nothing was changed \u2014 try again in a moment. I can still help with the app in the meantime.';
const QUERY_FAILED = 'That lookup did not go through \u2014 nothing was changed. It might be a schema mismatch on my side rather than your question; try rephrasing, or ask me to check a different vessel or period.';


/**
 * @param {object} input   { text, session, pending, now, history, context }
 * @param {object|Function} db
 *   Either a connected pg client (tests) or an async function that returns
 *   one on first call — and throws if it cannot. The function form is what
 *   the HTTP layer passes, so no connection is opened until it's needed.
 * @param {object} opts    { orgId, writeDb, dateOrder, env, fetchImpl,
 *                           onDelta?, signal?, pool?, scopeCache? }
 *   onDelta   stream model text to the caller as it is produced
 *   pool      () => pg Pool | null, for BACKGROUND cache refreshes that must
 *             never hold the request's connection or block the reply
 */
async function route(input, db, opts) {
  // How this message relates to the conversation, decided once before
  // anything answers: a new question, a follow-up, a correction, or the answer
  // to a question K.R.1.S asked. A new question closes that question.
  // (Without an open question this waits until the fast lane has passed:
  // "Hi" needs no analysis.)
  if (input.pending && input.pending.kind === 'clarify') {
    input.turn = turns.analyseTurn(input);
    if (input.turn.dropPending) input.pending = null;
  }
  const out = await routeTurn(input, db, opts);
  // A follow-up says what it follows, so the user can see how it was read.
  if (out && out.status === 'answer' && input.turn && input.turn.kind === 'follow_up' && input.turn.about && !out.context) {
    out.context = { kind: 'follow_up', about: input.turn.about };
  }
  return out;
}

async function routeTurn(input, db, opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const getDb = typeof db === 'function' ? db : async function () { return db; };

  const text = String(input.text || '').trim();
  if (!text) return { status: 'unparsed', text: 'Ask me about a vessel, the app, or say hello.', source: 'router' };

  // --- FAST LANE ---------------------------------------------------------------
  // Everything a server can answer exactly and locally is answered here, in
  // well under a millisecond, in EVERY mode — including KRIS_MODE=agent.
  // No database, no model, no network. "Hi" must never wait for either.
  const fast = fastLane(text, input, opts);
  if (fast) return fast;
  if (!input.turn) input.turn = turns.analyseTurn(input);

  // A pending clarification or teach-confirmation is a data conversation in
  // flight — it belongs to the engine, which needs the records.
  if (input.pending) {
    const isTeach = input.pending.kind === 'teach';
    const r = await withDb(getDb, function (client) {
      return engine.ask(input, client, opts).then(function (r) {
        // Vocabulary may just have changed; make the new word count right away.
        if (isTeach && opts.orgId) { learnedCache.delete(opts.orgId); legacyLearned.delete(opts.orgId); }
        return tagSource(r, 'data');
      });
    });
    // The same question coming straight back is a loop, not progress.
    const loop = r.status === 'clarify' && turns.repeatsRecent(r.text, input.history);
    if (r.status !== 'stale_pending' && !loop) return r;
    // The message was not an answer to the open question: drop the question
    // and route the message as the new request it is.
    input.pending = null;
    input.turn = turns.analyseTurn(input);
    if (loop) input.turn.loop = r.text;
    const fresh = fastLane(text, input, opts);
    if (fresh) return fresh;
  }

  // "I'm Alex and I work as a marine emissions analyst." is an introduction,
  // not a question about emissions data. It goes to conversation (the widget
  // offers to remember it); it must not be read as a data request.
  const intro = isIntroduction(text, input.now);

  // --- AI-FIRST MODE (default) --------------------------------------------------
  // The model gets the message with tools. KRIS_MODE=router skips this. Two
  // shortcuts come first because they are strictly better than a model round
  // trip and cannot change an answer's meaning:
  //   - a message the deterministic parser can already answer in full is
  //     answered by the engine directly (the agent would call the very same
  //     engine through a tool, after one or two model turns);
  //   - everything else streams from the model.
  // If the model layer is unreachable, we fall back to the router below
  // (set KRIS_AGENT_FALLBACK=0 to disable).
  if (String(env.KRIS_MODE || 'agent').toLowerCase() === 'agent') {
    if (env.KRIS_AGENT_DIRECT_DATA !== '0' && !intro) {
      const direct = await directData(text, input, getDb, opts);
      if (direct) return direct;
    }
    // The model takes seconds; the connection the direct check may have
    // opened goes back to the pool first (a tool call takes a fresh one).
    if (typeof opts.releaseDb === 'function') opts.releaseDb();
    let agentOut = null;
    try {
      agentOut = await agent.run(input, getDb, Object.assign({}, opts, { fleetNames: fleetNamesFor(input, getDb, opts) }));
    } catch (err) {
      console.error('kris: agent failed', err);
      agentOut = { status: 'error', source: 'agent', reason: 'model_error', text: '' };
    }
    if (agentOut && agentOut.status !== 'error') return agentOut;
    if (agentOut && agentOut.reason === 'cancelled') return agentOut;
    if (env.KRIS_AGENT_FALLBACK === '0') {
      return agentOut && agentOut.text
        ? agentOut
        : { status: 'error', source: 'agent', text: 'I could not reach my reasoning service just now. Nothing was changed.' };
    }
    if (opts.onDelta && agentOut && agentOut.partial) opts.onDelta({ t: 'replace', text: '' });
    // fall through to the deterministic router below
  }

  const userName = input.context && input.context.userName ? String(input.context.userName).slice(0, 60) : null;

  // --- 1. classify without the database ---------------------------------------
  // A question ABOUT a subject ("how is fuel consumption calculated?") is
  // conversation even though it names a metric.
  const kind = intro || input.turn.concept ? 'other' : parser.classify(text, [], input.now);

  if (kind === 'data' || kind === 'teach') {
    return withDb(getDb, function (client) { return engine.ask(input, client, opts).then(function (r) { return tagSource(r, 'data'); }); });
  }

  if (isBriefingRequest(text)) {
    return withDb(getDb, async function (client) {
      const scope = opts.scopeCache
        ? await scopeCache.load(scopeKey(input.session), function () { return rbac.resolveScope(input.session, client); })
        : await rbac.resolveScope(input.session, client);
      if (!scope.authenticated) return { status: 'unauthenticated', text: 'Sign in and I can check your vessels.', source: 'router' };
      if (!scope.vessels.length) return { status: 'no_scope', text: 'Your account is not linked to any vessel, so there is nothing to brief.', source: 'router' };
      const briefing = await buildBriefing(scope.vesselIds, scope.vessels.map(function (v) { return v.name; }), client);
      return { status: 'answer', text: briefing.text, findings: briefing.findings, source: 'briefing' };
    });
  }

  // --- 1.5 follow-ups: "and last week?" inherits the previous data question ------
  // A bare time range (with an optional cue like "and" / "what about") after a
  // data question means the same metric and vessel over the new period. The
  // rewrite is deterministic — previous question with its old range swapped
  // for the new one — and the rewritten text is returned in `interpreted` so
  // the user can see exactly what was answered.
  const followUp = followUpRewrite(text, input.history, input.now, opts.dateOrder);
  if (followUp) {
    return withDb(getDb, function (client) {
      return engine.ask(Object.assign({}, input, { text: followUp }), client, opts).then(function (r) {
        r.interpreted = followUp;
        return tagSource(r, 'data');
      });
    });
  }

  // Small talk the fast lane did not claim because KRIS_SMALLTALK_MODEL=1.
  if (isSmallTalk(text)) {
    if (env.KRIS_ENABLE_LLM === '0') return { status: 'answer', source: 'router', text: smallTalkReply(text, userName, input), instant: true };
    return companionReply(text, input, opts, env);
  }

  // --- 4. learned vocabulary: an org's own word for a metric is still data ---------
  // NEVER blocks: the cached vocabulary is used if present; if it is cold or
  // stale, a background refresh is started on the pool and this message goes
  // on without it. A conversational message must not pay for a database
  // round-trip it almost never needs.
  const learned = await learnedFor(getDb, opts);
  if (learned.length && !intro && !input.turn.concept && parser.classify(text, learned, input.now) === 'data') {
    return withDb(getDb, function (client) { return engine.ask(input, client, opts).then(function (r) { return tagSource(r, 'data'); }); });
  }

  // --- 5. companion (no database access) ------------------------------------------
  if (intro && env.KRIS_ENABLE_LLM === '0') {
    return { status: 'answer', source: 'router', instant: true, text: introReply(userName) };
  }
  if (env.KRIS_ENABLE_LLM === '0') {
    const parsed = parser.parse(text, { now: input.now, vessels: [], learned: learned });
    const suggestions = (parsed.suggestions || METRICS.filter(function (m) { return !m.finerVersionOf; }).slice(0, 6).map(function (m) { return m.label; }));
    return {
      status: 'unparsed',
      source: 'data',
      text: (parsed.message || 'I could not tell which measurement you mean.') + ' I can read: ' + suggestions.join(', ') + '. Ask me "help" for the full list.',
    };
  }

  const reply = await companionReply(text, input, opts, env);
  // An introduction deserves a reply even when the model is down.
  if (intro && reply && reply.status === 'error' && reply.reason === 'model_unavailable') {
    return { status: 'answer', source: 'router', instant: true, text: introReply(userName) };
  }
  return reply;
}

/**
 * The fast lane: exact, local answers. Returns a reply or null.
 * Order matters and mirrors the old router's precedence.
 */
function fastLane(text, input, opts) {
  const env = opts.env || process.env;
  const userName = input.context && input.context.userName ? String(input.context.userName).slice(0, 60) : null;
  const vesselName = input.context && input.context.vesselName ? String(input.context.vesselName) : null;

  // The previous turn asked for the user's name. A bare "Nav" here is the
  // answer, not a data question — but the user is free to ignore the question
  // and ask about fuel instead, in which case this resolves to null and the
  // message routes normally.
  if (input.pending && input.pending.kind === 'name') {
    const reply = parser.classify(text, [], input.now) === 'other'
      ? identity.resolveNameReply(text, { vesselName: vesselName })
      : null;
    input.pending = null; // answered or dropped: either way it is not a data clarification
    if (reply) return { status: 'answer', source: 'identity', instant: true, text: reply.text, remember: reply.remember || undefined };
  }
  if (input.pending) return null; // a data conversation in flight

  // Date, time, arithmetic.
  const tz = input.context && input.context.tz ? String(input.context.tz) : null;
  const instant = answerInstant(text, { now: input.now, tz: tz });
  if (instant) return { status: 'answer', source: 'instant', kind: instant.kind, text: instant.text, chart: instant.chart || undefined, instant: true };

  // Names, in both directions.
  const whoAmI = identity.answerIdentity(text, { userName: userName, vesselName: vesselName, profile: input.context && input.context.profile ? input.context.profile : null });
  if (whoAmI) {
    return {
      status: 'answer', source: 'identity', instant: true, text: whoAmI.text,
      remember: whoAmI.remember || undefined,
      pending: whoAmI.pending || undefined,
      actions: whoAmI.actions || undefined,
    };
  }

  // "what?", "huh?" right after an answer: the last reply missed. Say so and
  // ask again, instead of sending one word to a model.
  if (CONFUSED_RE.test(text)) {
    return { status: 'answer', source: 'router', instant: true, text: 'Sorry — I didn’t get that right. Could you ask it another way?' };
  }

  // "What can you do" and every malformed variant: a warm overview with next
  // steps. (The bare word "help" still gets the full measurement catalogue.)
  if (identity.CAPABILITY_RE.test(text)) {
    return {
      status: 'answer', source: 'guide', instant: true, text: identity.capabilityAnswer(),
      guide: { id: 'what-is-kris', title: 'What K.R.1.S can do' },
      suggestions: ['Anything I should know?', 'Fuel consumption last month', 'How do I export a report?', 'Show me what you can read'],
    };
  }

  const kind = parser.classify(text, [], input.now);
  if (kind === 'help' || /^\s*show me what you can read\s*$/i.test(text)) {
    return {
      status: 'help',
      source: 'router',
      instant: true,
      text: 'I answer from your vessel records only. Here is what I can read.',
      metrics: METRICS.filter(function (m) { return !m.finerVersionOf; }).map(function (m) { return { key: m.key, label: m.label, unit: m.unit, aliases: (m.aliases || []).slice(0, 4) }; }),
    };
  }
  if (kind !== 'other') return null; // data-shaped: never answered by the fast lane

  // Greetings, thanks, goodbyes: fixed replies, never a model round trip.
  if (isSmallTalk(text) && env.KRIS_SMALLTALK_MODEL !== '1') {
    return { status: 'answer', source: 'router', text: smallTalkReply(text, userName, input), instant: true };
  }

  // App guide. A learned term inside an app question would be data, not
  // guidance: if the org's vocabulary is cached we honour it without a query.
  if (!isBriefingRequest(text) && !followUpRewrite(text, input.history, input.now, opts.dateOrder)) {
    const cachedLearned = opts.orgId ? (learnedCache.peek(opts.orgId) || peekLegacy(opts.orgId) || []) : [];
    const guideHit = matchGuide(text);
    if (guideHit && !namesAThing(text, input) && !(cachedLearned.length && parser.classify(text, cachedLearned, input.now) === 'data')) {
      return { status: 'answer', text: guideHit.answer, guide: { id: guideHit.id, title: guideHit.title }, source: 'guide', instant: true };
    }
  }
  return null;
}

/**
 * "What is the FuelEU compliance balance for Suddha Star?" is about a vessel,
 * not a help article, however many of its words the article shares. A name
 * after for/of/on (a capitalised word, an IMO number) or one of the user's
 * vessel names from the scope cache means a specific thing is being asked about.
 */
const NAMED_RE = /\b(?:for|of|on|at|about)\s+(?:the\s+|my\s+|our\s+)?(?:[A-Z][a-z]|[A-Z]{2,}|\d{7}\b)/;
function namesAThing(text, input) {
  if (NAMED_RE.test(text)) return true;
  const cached = input && input.session ? scopeCache.peek(scopeKey(input.session)) : null;
  const lower = String(text).toLowerCase();
  return !!(cached && (cached.vessels || []).some(function (v) { return v.name && v.name.length >= 3 && lower.includes(String(v.name).toLowerCase()); }));
}

/**
 * Agent mode: when the deterministic engine can already answer a data-shaped
 * question in full (a figure, a table, a series), return that — the agent
 * would otherwise spend one or two model turns calling the same engine.
 * Anything short of a full answer goes to the model, including the engine's
 * clarifying questions: with the records and the engine as tools, the model
 * can usually answer the likely reading instead of asking ("How much CO2 did
 * TEST VESSEL 01 emit?" gets the annual figures, not "over what period?").
 */
async function directData(text, input, getDb, opts) {
  // Only a request to READ the records. A metric word inside a question about
  // steps, meaning or method is the model's to answer, not the parser's to
  // turn into "which measurement do you mean?".
  const turn = input.turn || turns.analyseTurn(input);
  if (!turn.lookup) return null;
  let client;
  try { client = await getDb(); } catch (_) { return null; } // the agent will explain the outage
  if (!client) return null;
  try {
    const r = await engine.ask(input, client, opts);
    // The same clarifying question again is a loop: the model is told not to repeat it.
    if (r && r.status === 'clarify' && turns.repeatsRecent(r.text, input.history)) turn.loop = r.text;
    if (r && (r.status === 'answer' || r.status === 'no_scope' || r.status === 'help')) {
      return tagSource(r, 'data');
    }
  } catch (err) {
    console.error('kris: direct data path failed, handing to agent', err && err.message);
  }
  return null;
}

/** The user's vessel names for the fabrication guard, cache-first, never on the request's connection. */
function fleetNamesFor(input, getDb, opts) {
  return async function () {
    const key = scopeKey(input.session);
    const cached = scopeCache.peek(key);
    if (cached) return (cached.vessels || []).map(function (v) { return v.name; });
    const pool = typeof opts.pool === 'function' ? opts.pool() : null;
    const runner = pool || (await getDb().catch(function () { return null; }));
    if (!runner) return [];
    const scope = await scopeCache.load(key, function () { return rbac.resolveScope(input.session, runner); });
    return (scope.vessels || []).map(function (v) { return v.name; });
  };
}

async function companionReply(text, input, opts, env) {
  const guideSnippets = searchGuide(text, 3).map(function (g) { return { title: g.title, answer: g.answer }; });
  const tz = input.context && input.context.tz ? String(input.context.tz) : null;
  let convo;
  try {
    convo = await converseSafe(text, input, opts, env, guideSnippets, tz);
  } catch (err) {
    // The companion must NEVER take the whole request down. Whatever the
    // model layer throws, the user gets a plain honest sentence, not a 500.
    console.error('kris: companion failed', err);
    convo = {
      text: 'I hit a snag answering that one — nothing was changed. I can still read your vessel data and help with the app.',
      blocked: false,
      error: String((err && err.message) || err),
    };
  }
  // The model could not be reached (or answered nothing). That is a failure,
  // and it should look like one: an error card with "Try again", and — for
  // whoever runs the server — the cause, by name only, never a URL or a key.
  if (convo.error && !convo.streamed && !convo.blocked && /couldn.t reach|hit a snag/i.test(convo.text || '')) {
    const why = modelFailure(env, convo.error);
    return {
      status: 'error',
      source: 'companion',
      reason: 'model_unavailable',
      text: convo.text,
      code: why.code,
      detail: why.detail,
      error: 'companion: ' + String(convo.error).slice(0, 200),
    };
  }
  return {
    status: 'answer',
    text: convo.text,
    source: 'companion',
    chart: convo.chart || undefined,
    blocked: convo.blocked || undefined,
    options: convo.blocked ? examplePrompts() : undefined,
    // Provider failure detail (HTTP status, timeout). The HTTP layer logs it,
    // records it for /api/kris diagnostics, and strips it before replying.
    error: convo.error ? 'companion: ' + String(convo.error).slice(0, 200) : undefined,
  };
}

/** Why the conversation model failed, in words the person running the server can act on. */
function modelFailure(env, error) {
  const e = String(error || '');
  if (!llmConfigured(env)) {
    return { code: 'LLM_NOT_CONFIGURED', detail: 'Server: no conversation model is configured - set KRIS_LLM_API_KEY (OpenRouter) for GLM-5.3-Flash.' };
  }
  const m = e.match(/HTTP (\d{3})/);
  if (m) {
    const hint = { 401: 'check KRIS_LLM_API_KEY', 403: 'check KRIS_LLM_API_KEY', 402: 'the model account is out of credit', 404: 'check KRIS_LLM_MODEL', 429: 'rate limited - try again shortly' }[m[1]] || 'see the server log';
    return { code: 'LLM_HTTP_' + m[1], detail: 'Model server answered HTTP ' + m[1] + ' (' + hint + ').' };
  }
  if (/timed out/i.test(e)) return { code: 'LLM_TIMEOUT', detail: 'The model server went silent for longer than KRIS_LLM_TIMEOUT_MS.' };
  if (/empty reply/i.test(e)) return { code: 'LLM_EMPTY', detail: 'The model returned an empty reply (it may have spent its whole token budget reasoning; try KRIS_LLM_REASONING_EFFORT=medium).' };
  return { code: 'LLM_UNREACHABLE', detail: 'Cannot connect to the model server (check KRIS_LLM_URL and that the server is running).' };
}

async function converseSafe(text, input, opts, env, guideSnippets, tz) {
  return converse(text, {
    env: env,
    light: isLightMessage(text),
    nowLabel: formatNow(input.now ? new Date(input.now) : new Date(), tz).label,
    guideSnippets: guideSnippets,
    history: input.history,
    turn: input.turn,
    userName: input.context && input.context.userName ? String(input.context.userName).slice(0, 60) : null,
    // What the user has allowed K.R.1.S to remember. Shapes the reply's
    // tone and relevance; never a source of figures (see src/profile.js).
    profile: input.context && input.context.profile ? input.context.profile : null,
    context: input.context && input.context.vesselName ? { vesselName: String(input.context.vesselName).slice(0, 80) } : null,
    fetchImpl: opts.fetchImpl,
    // Stream the reply a sentence at a time (each sentence already
    // guard-checked) and stop model work when the user presses stop.
    onDelta: opts.onDelta,
    signal: opts.signal,
  });
}

/**
 * Run `fn` with a database client, converting a failed connection into a
 * plain answer instead of an exception. The failure text names the cause
 * the user can act on (not configured vs. unreachable) and nothing else.
 */
async function withDb(getDb, fn) {
  let client;
  try {
    client = await getDb();
  } catch (err) {
    const notConfigured = err && err.code === 'DB_NOT_CONFIGURED';
    return {
      status: 'error', source: 'router',
      reason: notConfigured ? 'db_not_configured' : 'db_unreachable',
      text: notConfigured ? DB_NOT_CONFIGURED : DB_UNREACHABLE,
      // Cause classification from the HTTP layer (never the raw message).
      code: notConfigured ? undefined : (err && err.krisCode) || undefined,
      detail: notConfigured ? undefined : (err && err.krisHint) || undefined,
    };
  }
  if (!client) {
    return { status: 'error', source: 'router', reason: 'db_not_configured', text: DB_NOT_CONFIGURED };
  }
  // A successful CONNECTION does not mean the QUERY will succeed - a missing
  // view, a renamed column, a statement timeout, or a genuine Postgres error
  // all throw from here. Previously this was unguarded and escaped all the way
  // to httpHandler's generic 500, which is exactly the failure this catches.
  try {
    return await fn(client);
  } catch (err) {
    console.error('kris: query failed', err);
    const missing = err && err.code === '42P01' ? String(err.message || '').match(/relation "([^"]+)" does not exist/) : null;
    return {
      status: 'error', source: 'router', reason: 'query_failed', text: QUERY_FAILED,
      code: err && err.code ? 'PG_' + err.code : undefined,
      detail: missing ? 'Table or view "' + missing[1] + '" does not exist - run the matching db/*.sql migration.' : undefined,
      error: String((err && err.message) || err).slice(0, 300),
    };
  }
}

/**
 * Learned vocabulary.
 *   HTTP path (opts.pool given): NEVER waits on the database. Uses the cached
 *   vocabulary if present; if it is cold or stale, refreshes it in the
 *   background on the pool, and this message goes on without it.
 *   Direct callers (tests, scripts passing a client): loads through the
 *   client, cached for a minute, as before.
 */
async function learnedFor(getDb, opts) {
  const orgId = opts.orgId;
  if (!orgId) return [];
  if (opts.pool) {
    const hit = learnedCache.peek(orgId);
    if (!learnedCache.get(orgId)) {
      const pool = typeof opts.pool === 'function' ? opts.pool() : null;
      if (pool) learnedCache.refresh(orgId, function () { return terms.loadMappings(pool, orgId); });
    }
    return hit || [];
  }
  const hit = peekLegacy(orgId);
  if (hit) return hit;
  let client;
  try { client = await getDb(); } catch (_) { return []; }
  if (!client) return [];
  try {
    const rows = await terms.loadMappings(client, orgId);
    legacyLearned.set(orgId, { rows: rows, at: Date.now() });
    return rows;
  } catch (_) {
    return [];
  }
}

// Cache for the direct-caller path.
const legacyLearned = new Map();
const LEARNED_TTL_MS = 60000;
function peekLegacy(orgId) {
  const hit = orgId ? legacyLearned.get(orgId) : null;
  return hit && Date.now() - hit.at < LEARNED_TTL_MS ? hit.rows : null;
}

/**
 * Rewrite a follow-up like "and last week?" into a full data question by
 * inheriting the most recent data question from the conversation history.
 * Returns the rewritten question, or null when this isn't a follow-up.
 *
 * Deliberately strict: the new message must resolve to a time range, must not
 * itself name a metric, and once the range and cue words are removed there
 * must be nothing substantive left — "how did last week compare to the
 * forecast" is NOT a follow-up and goes to the companion as before.
 */
const FOLLOWUP_CUE_RE = /^\s*(?:and|what about|how about|what abt|same(?:\s+(?:for|thing|period|again))?|also|now|then|ok(?:ay)?)\b/i;

function followUpRewrite(text, history, now, dateOrder) {
  if (!Array.isArray(history) || !history.length) return null;
  const raw = String(text || '').trim();
  if (!raw || raw.length > 80) return null;
  if (parser.classify(raw, [], now) !== 'other') return null;

  const newRange = dates.resolveTimeRange(raw, now ? new Date(now) : new Date(), { dateOrder: dateOrder });
  if (!newRange || newRange.needsDate || !newRange.matched) return null;

  // What is left once the range and the cue are gone? Only filler and time
  // vocabulary may remain. (The stripped `matched` value is a canonical form
  // — "year to date" for "this year" — so the surface words of a period must
  // be tolerated on their own.)
  const leftover = raw.toLowerCase()
    .replace(new RegExp(escapeRe(newRange.matched), 'i'), ' ')
    .replace(FOLLOWUP_CUE_RE, ' ')
    .replace(/[?.!,]/g, ' ');
  const leftoverWords = leftover.split(/\s+/).filter(function (w) {
    return w && FOLLOWUP_FILLER.indexOf(w) < 0 && !TIME_WORD_RE.test(w) && !/^\d/.test(w);
  });
  if (leftoverWords.length > 0) return null;

  // The previous user message, and only if it was a data question: "and last
  // week?" follows what was just asked, never a data question from ten turns
  // and two topics ago.
  let prior = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (!h || h.role === 'assistant') continue;
    const t = String(h.text || '').trim();
    if (t && parser.classify(t, [], now) === 'data') prior = t;
    break;
  }
  if (!prior) return null;

  const priorRange = dates.resolveTimeRange(prior, now ? new Date(now) : new Date(), { dateOrder: dateOrder });
  let base = priorRange && priorRange.matched
    ? prior.replace(new RegExp(escapeRe(priorRange.matched), 'i'), ' ')
    : prior;
  // Some resolutions carry no `matched` text ("yesterday", "today"); strip
  // those literal words too, or the rewrite would carry two periods.
  base = base.replace(/\b(?:day before yesterday|yesterday|today|tonight|right now|now)\b/gi, ' ');
  return (base + ' ' + newRange.matched).replace(/[?.!]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const FOLLOWUP_FILLER = ['for', 'in', 'the', 'over', 'during', 'of', 'it', 'that', 'show', 'me', 'and', 'to', 'so', 'far'];
const TIME_WORD_RE = /^(?:this|last|previous|prior|current|past|yesterday|today|ytd|mtd|day|days|hour|hours|week|weeks|month|months|year|years|quarter|quarters|q[1-4]|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|date|since|until|till|from|between)$/;

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

const SMALL_TALK = new Set(['hi', 'hello', 'hey', 'hiya', 'yo', 'sup', 'thanks', 'thank', 'you', 'thx', 'ty', 'ok', 'okay',
  'good', 'morning', 'afternoon', 'evening', 'night', 'bye', 'goodbye', 'cheers', 'please', 'cool', 'great', 'nice',
  'kris', 'krishna', 'namaste', 'namaskar', 'radhe', 'hare', 'jai', 'shri', 'shree', 'there', 'how', 'are', 'doing', 'whats', 'up', 'yes', 'no', 'yep', 'nope', 'lol', 'haha',
  'today', 'mate', 'sir', 'again', 'all', 'fine', 'well', 'hows', 'it', 'going', 'things', 'buddy', 'much', 'lot',
  'so', 'very', 'awesome', 'perfect', 'noted', 'alright', 'sure', 'gotcha', 'yeah', 'hmm', 'wow', 'welcome', 'appreciated', 'cya', 'later', 'see']);

/** True when every word is conversational filler — nothing that could name a metric. */
const CONFUSED_RE = /^\s*(?:(?:what|wat|huh|eh|pardon|come again|what do you mean|i don'?t (?:get it|understand)|that'?s not what i (?:asked|meant))\s*[?!.]*|sorry\s*\?+)\s*$/i;

/**
 * A first-person introduction: a name, a role, an employer, a base — with no
 * request in it and no period to read. "I'm checking shaft power" and "I am
 * looking for fuel consumption last month" are requests, not introductions.
 */
const INTRO_RE = new RegExp('^\\s*(?:(?:hi|hello|hey|namaste|good (?:morning|afternoon|evening))[,!.\\s]+)?(?:'
  + "my name(?:'s| is)\\b"
  + "|i(?:'m|\u2019m| am) [a-z][a-z'\u2019-]+(?: [a-z][a-z'\u2019-]+)?\\s*(?:,|\\band\\b|\\.|!|$)"
  + '|i (?:work|am working) (?:as|at|for|in)\\b'
  + '|my (?:role|job title|title|position|designation) is\\b'
  + "|i(?:'m|\u2019m| am) (?:an?|the) (?:[a-z&/-]+ ){0,4}(?:analyst|engineer|manager|officer|superintendent|captain|master|chief|director|lead|head|specialist|consultant|coordinator|planner|operator|technician|auditor|inspector|trader|charterer|broker|surveyor|accountant|student|intern)\\b"
  + "|i(?:'m|\u2019m| am) based in\\b"
  + ')', 'i');
const REQUEST_RE = /\?|\b(?:show|give|get|tell|what|which|how|when|where|why|check|checking|look|looking|need|want|find|compare|trend|total|average|sum|pull|fetch|list|can you|could you|please|help)\b/i;

function isIntroduction(text, now) {
  const t = String(text || '').trim();
  if (!t || t.length > 240 || !INTRO_RE.test(t) || REQUEST_RE.test(t)) return false;
  const r = dates.resolveTimeRange(t, now ? new Date(now) : new Date());
  return !(r && !r.needsDate);
}

function introReply(name) {
  return (name ? 'Good to meet you, ' + String(name).replace(/[^\w'\u2019. -]/g, '').slice(0, 40) + '. ' : 'Good to know. ')
    + 'Ask me about a vessel, the app, or anything else you need.';
}

function isSmallTalk(text) {
  const words = String(text).toLowerCase().replace(/[’']/g, '').replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  if (words.length > 8) return false;
  return words.every(function (w) { return SMALL_TALK.has(w) || w.length <= 2; });
}

// A few variants per intent so repeated greetings don't feel like a recording.
// Fixed text, so nothing here can be invented or wrong.
const SMALL_TALK_REPLIES = {
  thanks: [
    "You're welcome. Ask whenever you need a figure from the records.",
    "Any time. I'm here when you need the numbers.",
    'Happy to help.',
  ],
  bye: [
    "Go well. I'm here whenever you need me.",
    'Until next time. The records will keep.',
  ],
  howareyou: [
    'Calm and content, thank you. What shall we look into?',
    'All is well here. What do you need?',
    'Peaceful as ever, thanks for asking. What are we looking at today?',
  ],
  affirm: [
    'Very well. What next?',
    'Understood.',
  ],
  greet: [
    '{hello}. Ask me about a vessel, the app, or anything else you need.',
    '{hello}. What can I look up for you?',
    '{hello}. What do you need from the records?',
  ],
};

// A greeting the user chose is returned in kind: "Namaste" gets "Namaste",
// "Radhe Radhe" gets "Radhe Radhe". Only ever an echo of their own words.
const KIND_GREETINGS = [
  [/\bjai (?:shri|shree|sri) krishna\b/, 'Jai Shri Krishna'],
  [/\bhare krishna\b/, 'Hare Krishna'],
  [/\bradhe radhe\b/, 'Radhe Radhe'],
  [/\bnamaskar\b/, 'Namaskar'],
  [/\bnamaste\b/, 'Namaste'],
];

function pick(list, seed) {
  return list[Math.abs(seed) % list.length];
}

// Building an Intl formatter costs ~1 ms; build each one once.
const HOUR_FMT = new Map();
function hourFormatter(tz) {
  let f = HOUR_FMT.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false });
    if (HOUR_FMT.size > 200) HOUR_FMT.clear();
    HOUR_FMT.set(tz, f);
  }
  return f;
}

/** "Good morning" / "Good afternoon" / "Good evening" in the user's own time zone. */
function timeOfDayHello(input) {
  const tz = input && input.context && input.context.tz ? String(input.context.tz) : null;
  let hour = null;
  try {
    const f = hourFormatter(tz || 'UTC');
    hour = parseInt(f.format(input && input.now ? new Date(input.now) : new Date()), 10) % 24;
  } catch (_) { hour = null; }
  if (hour == null || !tz) return 'Hello';
  if (hour < 5) return 'Hello';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function smallTalkReply(text, name, input) {
  const t = String(text).toLowerCase();
  // Seeded from the message so the same input is stable within a minute but
  // different greetings vary.
  const seed = t.length * 31 + (t.charCodeAt(0) || 0) + Date.now() / 60000 | 0;
  if (/thank|thx|\bty\b|cheers|appreciate/.test(t)) return personalize(pick(SMALL_TALK_REPLIES.thanks, seed), name);
  if (/\bbye\b|goodbye|good night|\bnight\b|see you|see ya|\bcya\b|later/.test(t)) return personalize(pick(SMALL_TALK_REPLIES.bye, seed), name);
  if (/how are you|how.?s it going|how are things|you doing|what.?s up|\bsup\b|how.?s things/.test(t)) return pick(SMALL_TALK_REPLIES.howareyou, seed);
  if (/^\s*(ok|okay|yes|yep|yeah|no|nope|cool|great|nice|sure|got it|gotcha|alright|noted|perfect|awesome)\b/.test(t)) return pick(SMALL_TALK_REPLIES.affirm, seed);
  // Echo the greeting the user chose (a time of day, or a namaste); otherwise use theirs.
  const kind = KIND_GREETINGS.find((g) => g[0].test(t));
  const m = t.match(/good (morning|afternoon|evening)/);
  const hello = kind ? kind[1] : m ? 'Good ' + m[1] : timeOfDayHello(input);
  return personalize(pick(SMALL_TALK_REPLIES.greet, seed).replace('{hello}', hello), name);
}

/** "Hello." becomes "Hello, Nav." when the widget has remembered a name. */
function personalize(reply, name) {
  if (!name) return reply;
  const safe = String(name).replace(/[^\w'’. -]/g, '').trim().slice(0, 40);
  if (!safe) return reply;
  return reply.replace(/^([A-Za-z][\w' ]*?)([.!])/, '$1, ' + safe + '$2');
}

function examplePrompts() {
  return ['Fuel consumption last month', 'Compliance balance this quarter', 'Off hire hours this year'];
}

function tagSource(result, source) {
  result.source = result.source || source;
  return result;
}

/**
 * Run the fast lane once on representative messages so the first real
 * greeting after a (re)start does not pay for regex compilation, Intl
 * formatter construction and JIT warm-up (~20 ms cold, <1 ms warm).
 */
function prewarm() {
  const env = { KRIS_MODE: 'router' };
  const samples = ['hi', 'how are you?', 'what can you do', 'what is the date today', 'how do i export a report', 'thanks', 'my name is Nav', 'fuel consumption last month'];
  for (const text of samples) {
    try { fastLane(text, { text, now: new Date(), context: { tz: 'Asia/Calcutta' } }, { env }); } catch (_) { /* warm-up only */ }
  }
}

/** Exposed so the learned-term cache can be cleared when vocabulary changes or in tests. */
function clearLearnedCache() { learnedCache.clear(); legacyLearned.clear(); scopeCache.clear(); }

module.exports = { route: route, prewarm: prewarm, fastLane: fastLane, agent: agent, ROUTER_BUILD: ROUTER_BUILD, clearLearnedCache: clearLearnedCache, isSmallTalk: isSmallTalk, smallTalkReply: smallTalkReply, isLightMessage: isLightMessage, followUpRewrite: followUpRewrite, isIntroduction: isIntroduction };