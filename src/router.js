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
const { converse } = require('./companion');
const { METRICS } = require('./config');

const DB_NOT_CONFIGURED = 'My database connection is not configured yet, so I cannot read vessel records. I can still help with the app, or just chat.';
const DB_UNREACHABLE = 'I cannot reach the vessel database right now, so I cannot look that up. Nothing was changed \u2014 try again in a moment. I can still help with the app in the meantime.';

// Learned vocabulary per organisation, cached briefly so that classifying a
// greeting does not cost a query every time. One indexed SELECT per org per
// minute at most; nothing else here reads the database for non-data messages.
const learnedCache = new Map();
const LEARNED_TTL_MS = 60000;

/**
 * @param {object} input   { text, session, pending, now, history, context }
 * @param {object|Function} db
 *   Either a connected pg client (tests) or an async function that returns
 *   one on first call — and throws if it cannot. The function form is what
 *   the HTTP layer passes, so no connection is opened until it's needed.
 * @param {object} opts    { orgId, writeDb, dateOrder, env, fetchImpl }
 */
async function route(input, db, opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const getDb = typeof db === 'function' ? db : async function () { return db; };

  const text = String(input.text || '').trim();
  if (!text) return { status: 'unparsed', text: 'Ask me about a vessel, the app, or say hello.', source: 'router' };

  // A pending clarification or teach-confirmation is a data conversation in
  // flight — it belongs to the engine, which needs the records.
  if (input.pending) {
    const isTeach = input.pending.kind === 'teach';
    return withDb(getDb, function (client) {
      return engine.ask(input, client, opts).then(function (r) {
        // Vocabulary may just have changed; make the new word count right away.
        if (isTeach && opts.orgId) learnedCache.delete(opts.orgId);
        return tagSource(r, 'data');
      });
    });
  }

  // --- 1. classify without the database ---------------------------------------
  let kind = parser.classify(text, [], input.now);

  if (kind === 'help') {
    return {
      status: 'help',
      source: 'router',
      text: 'I answer from your vessel records only. Here is what I can read.',
      metrics: METRICS.filter(function (m) { return !m.finerVersionOf; }).map(function (m) { return { key: m.key, label: m.label, unit: m.unit, aliases: (m.aliases || []).slice(0, 4) }; }),
    };
  }

  if (kind === 'data' || kind === 'teach') {
    return withDb(getDb, function (client) { return engine.ask(input, client, opts).then(function (r) { return tagSource(r, 'data'); }); });
  }

  if (isBriefingRequest(text)) {
    return withDb(getDb, async function (client) {
      const scope = await rbac.resolveScope(input.session, client);
      if (!scope.authenticated) return { status: 'unauthenticated', text: 'Sign in and I can check your vessels.', source: 'router' };
      if (!scope.vessels.length) return { status: 'no_scope', text: 'Your account is not linked to any vessel, so there is nothing to brief.', source: 'router' };
      const briefing = await buildBriefing(scope.vesselIds, scope.vessels.map(function (v) { return v.name; }), client);
      return { status: 'answer', text: briefing.text, findings: briefing.findings, source: 'briefing' };
    });
  }

  // --- 2. small talk (no database) ----------------------------------------------------
  // A greeting or thank-you goes straight to conversation: the companion when a
  // model is configured, a fixed friendly line when it isn't. It never goes to
  // the guide (where the word "captain" would match the help entry) and never
  // triggers the learned-term lookup.
  if (isSmallTalk(text)) {
    if (env.CAPTAIN_ENABLE_LLM === '0') return { status: 'answer', source: 'router', text: smallTalkReply(text) };
    return companionReply(text, input, opts, env);
  }

  // --- 3. app guide (no database) ------------------------------------------------------
  // A learned term inside an app question would be data, not guidance. If the
  // org's vocabulary is already cached we honour that without a query; if the
  // cache is cold we take the guide match — an app question must not cost a
  // database round-trip.
  const cachedLearned = peekLearned(opts.orgId);
  const guideHit = matchGuide(text);
  if (guideHit && !(cachedLearned.length && parser.classify(text, cachedLearned, input.now) === 'data')) {
    return { status: 'answer', text: guideHit.answer, guide: { id: guideHit.id, title: guideHit.title }, source: 'guide' };
  }

  // --- 4. learned vocabulary: an org's own word for a metric is still data ---------
  // Reached only for text the guide did not claim. Consulted when the database
  // is reachable (cached for a minute); if it isn't, the message simply goes on
  // to the companion, which cannot state a figure anyway.
  const learned = await loadLearnedIfAvailable(getDb, opts.orgId);
  if (learned.length && parser.classify(text, learned, input.now) === 'data') {
    return withDb(getDb, function (client) { return engine.ask(input, client, opts).then(function (r) { return tagSource(r, 'data'); }); });
  }

  // --- 5. companion (no database access) ------------------------------------------
  if (env.CAPTAIN_ENABLE_LLM === '0') {
    const parsed = parser.parse(text, { now: input.now, vessels: [], learned: learned });
    const suggestions = (parsed.suggestions || METRICS.filter(function (m) { return !m.finerVersionOf; }).slice(0, 6).map(function (m) { return m.label; }));
    return {
      status: 'unparsed',
      source: 'data',
      text: (parsed.message || 'I could not tell which measurement you mean.') + ' I can read: ' + suggestions.join(', ') + '. Ask me "help" for the full list.',
    };
  }

  return companionReply(text, input, opts, env);
}

async function companionReply(text, input, opts, env) {
  const guideSnippets = searchGuide(text, 3).map(function (g) { return { title: g.title, answer: g.answer }; });
  const convo = await converse(text, {
    env: env,
    guideSnippets: guideSnippets,
    history: input.history,
    context: input.context && input.context.vesselName ? { vesselName: String(input.context.vesselName).slice(0, 80) } : null,
    fetchImpl: opts.fetchImpl,
  });
  return {
    status: 'answer',
    text: convo.text,
    source: 'companion',
    chart: convo.chart || undefined,
    blocked: convo.blocked || undefined,
    options: convo.blocked ? examplePrompts() : undefined,
  };
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
    return { status: 'error', source: 'router', reason: notConfigured ? 'db_not_configured' : 'db_unreachable', text: notConfigured ? DB_NOT_CONFIGURED : DB_UNREACHABLE };
  }
  if (!client) {
    return { status: 'error', source: 'router', reason: 'db_not_configured', text: DB_NOT_CONFIGURED };
  }
  return fn(client);
}

/** Cached learned terms if fresh, without touching the database. */
function peekLearned(orgId) {
  const hit = orgId ? learnedCache.get(orgId) : null;
  return hit && Date.now() - hit.at < LEARNED_TTL_MS ? hit.rows : [];
}

async function loadLearnedIfAvailable(getDb, orgId) {
  if (!orgId) return [];
  const hit = learnedCache.get(orgId);
  if (hit && Date.now() - hit.at < LEARNED_TTL_MS) return hit.rows;
  let client;
  try { client = await getDb(); } catch (_) { return hit ? hit.rows : []; }
  if (!client) return hit ? hit.rows : [];
  try {
    const rows = await terms.loadMappings(client, orgId);
    learnedCache.set(orgId, { rows: rows, at: Date.now() });
    return rows;
  } catch (_) {
    return hit ? hit.rows : [];
  }
}

const SMALL_TALK = new Set(['hi', 'hello', 'hey', 'hiya', 'yo', 'sup', 'thanks', 'thank', 'you', 'thx', 'ty', 'ok', 'okay',
  'good', 'morning', 'afternoon', 'evening', 'night', 'bye', 'goodbye', 'cheers', 'please', 'cool', 'great', 'nice',
  'captain', 'there', 'how', 'are', 'doing', 'whats', 'up', 'yes', 'no', 'yep', 'nope', 'lol', 'haha']);

/** True when every word is conversational filler — nothing that could name a metric. */
function isSmallTalk(text) {
  const words = String(text).toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  return words.every(function (w) { return SMALL_TALK.has(w) || w.length <= 2; });
}

function smallTalkReply(text) {
  const t = String(text).toLowerCase();
  if (/thank|thx|\bty\b|cheers/.test(t)) return "You're welcome. Ask whenever you need a figure from the records.";
  if (/bye|goodbye|night/.test(t)) return 'Fair winds. I\'m here when you need me.';
  if (/how are you|how.?s it going|doing/.test(t)) return 'All well on the bridge. Ask me about a vessel, or how to find something in the app.';
  return 'Hello. I can answer questions about your vessels from the records, help you find your way around the app, or give you a briefing \u2014 just ask.';
}

function examplePrompts() {
  return ['Fuel consumption last month', 'Compliance balance this quarter', 'Off hire hours this year'];
}

function tagSource(result, source) {
  result.source = result.source || source;
  return result;
}

/** Exposed so the learned-term cache can be cleared when vocabulary changes or in tests. */
function clearLearnedCache() { learnedCache.clear(); }

module.exports = { route: route, clearLearnedCache: clearLearnedCache };