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
const { converse } = require('./companion_src');
const { answerInstant, formatNow } = require('./instant_src');
const identity = require('./identity');
const agent = require('./agent');

const ROUTER_BUILD = '2026-09-04.3';
const dates = require('./dates');
const { METRICS } = require('./config');

const DB_NOT_CONFIGURED = 'My database connection is not configured yet, so I cannot read vessel records. I can still help with the app, or just chat.';
const DB_UNREACHABLE = 'I cannot reach the vessel database right now, so I cannot look that up. Nothing was changed \u2014 try again in a moment. I can still help with the app in the meantime.';
const QUERY_FAILED = 'That lookup did not go through \u2014 nothing was changed. It might be a schema mismatch on my side rather than your question; try rephrasing, or ask me to check a different vessel or period.';

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

  // --- AI-FIRST MODE ------------------------------------------------------------
  // CAPTAIN_MODE=agent hands the whole message to the model with tools, and none
  // of the matching below runs. The model works out intent for itself; the tools
  // it can reach are the same deterministic engine/RBAC/guide code used here.
  // If the model layer is unreachable, we fall back to this router rather than
  // leaving the user with nothing (set CAPTAIN_AGENT_FALLBACK=0 to disable).
  if (String(env.CAPTAIN_MODE || '').toLowerCase() === 'agent') {
    let agentOut = null;
    try {
      agentOut = await agent.run(input, getDb, opts);
    } catch (err) {
      console.error('captain: agent failed', err);
      agentOut = { status: 'error', source: 'agent', reason: 'model_error', text: '' };
    }
    if (agentOut && agentOut.status !== 'error') return agentOut;
    if (env.CAPTAIN_AGENT_FALLBACK === '0') {
      return agentOut && agentOut.text
        ? agentOut
        : { status: 'error', source: 'agent', text: 'I could not reach my reasoning service just now. Nothing was changed.' };
    }
    // fall through to the deterministic router below
  }

  const userName = input.context && input.context.userName ? String(input.context.userName).slice(0, 60) : null;
  const vesselName = input.context && input.context.vesselName ? String(input.context.vesselName) : null;

  // The previous turn asked for the user's name. A bare "Nav" here is the
  // answer, not a data question — but the user is free to ignore the question
  // and ask about fuel instead, in which case this resolves to null and the
  // message routes normally below.
  if (input.pending && input.pending.kind === 'name') {
    const reply = parser.classify(text, [], input.now) === 'other'
      ? identity.resolveNameReply(text, { vesselName: vesselName })
      : null;
    if (reply) {
      return { status: 'answer', source: 'identity', instant: true, text: reply.text, remember: reply.remember || undefined };
    }
    input = Object.assign({}, input, { pending: null }); // fall through, question dropped
  }

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

  // --- 0. instant facts: date, time, arithmetic — exact, local, microseconds ------
  // The server has a clock and exact arithmetic; a language model has neither.
  // These never go to a model or the database.
  const tz = input.context && input.context.tz ? String(input.context.tz) : null;
  const instant = answerInstant(text, { now: input.now, tz: tz });
  if (instant) return { status: 'answer', source: 'instant', kind: instant.kind, text: instant.text, chart: instant.chart || undefined, instant: true };

  // --- 0.5 identity: names, in both directions — exact, local, no model ---------
  // "What's your name" / "my name is Nav" / "what's my name". Captured names
  // travel back to the widget in `remember` and return on every message in
  // context.userName; the server itself stays stateless.
  const whoAmI = identity.answerIdentity(text, { userName: userName, vesselName: vesselName });
  if (whoAmI) {
    return {
      status: 'answer', source: 'identity', instant: true, text: whoAmI.text,
      remember: whoAmI.remember || undefined,
      pending: whoAmI.pending || undefined,
    };
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

  // --- 1.2 capability, malformed variants --------------------------------------
  // The exact phrases "help" / "what can you do" were claimed above and get the
  // metric list. Everything a human actually types around them - "what you can
  // do", "wat can u do", "how can you help me" - lands here: a fixed local
  // answer instead of a model round-trip (or, previously, a fall-through).
  if (identity.CAPABILITY_RE.test(text)) {
    return { status: 'answer', source: 'guide', instant: true, text: identity.capabilityAnswer(), guide: { id: 'what-is-captain', title: 'What Captain Nav can do' } };
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

  // --- 2. small talk: answered locally, in microseconds -------------------------------
  // A greeting, thanks or goodbye is answered from a fixed set of replies and
  // NEVER sent to a model. Routing "hi" through a frontier reasoning model
  // costs tens of seconds and buys nothing, so it does not happen. Set
  // CAPTAIN_SMALLTALK_MODEL=1 if you would rather a model handle these.
  if (isSmallTalk(text) && env.CAPTAIN_SMALLTALK_MODEL !== '1') {
    return { status: 'answer', source: 'router', text: smallTalkReply(text, userName), instant: true };
  }
  if (isSmallTalk(text)) {
    if (env.CAPTAIN_ENABLE_LLM === '0') return { status: 'answer', source: 'router', text: smallTalkReply(text, userName), instant: true };
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

/**
 * Short, simple messages go to the fast model; substantial ones to the strong
 * model. A frontier reasoning model is the right tool for "explain FuelEU
 * pooling" and the wrong tool for "what does CII stand for" — the difference
 * is tens of seconds.
 */
const HEAVY_RE = /\b(explain|why|how does|how do|compare|analyse|analyze|calculate|work out|difference between|pros and cons|walk me through|step by step|write|draft|summar)/i;

function isLightMessage(text) {
  const t = String(text || '').trim();
  if (t.length > 140) return false;              // long question, treat as substantial
  if (/\n/.test(t)) return false;                 // multi-line, likely detailed
  if (HEAVY_RE.test(t)) return false;             // asks for reasoning or composition
  return t.split(/\s+/).length <= 14;
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
    console.error('captain: companion failed', err);
    convo = {
      text: 'I hit a snag answering that one — nothing was changed. I can still read your vessel data and help with the app.',
      blocked: false,
      error: String((err && err.message) || err),
    };
  }
  return {
    status: 'answer',
    text: convo.text,
    source: 'companion',
    chart: convo.chart || undefined,
    blocked: convo.blocked || undefined,
    options: convo.blocked ? examplePrompts() : undefined,
  };
}

async function converseSafe(text, input, opts, env, guideSnippets, tz) {
  return converse(text, {
    env: env,
    light: isLightMessage(text),
    nowLabel: formatNow(input.now ? new Date(input.now) : new Date(), tz).label,
    guideSnippets: guideSnippets,
    history: input.history,
    userName: input.context && input.context.userName ? String(input.context.userName).slice(0, 60) : null,
    context: input.context && input.context.vesselName ? { vesselName: String(input.context.vesselName).slice(0, 80) } : null,
    fetchImpl: opts.fetchImpl,
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
      code: notConfigured ? undefined : (err && err.captainCode) || undefined,
      detail: notConfigured ? undefined : (err && err.captainHint) || undefined,
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
    console.error('captain: query failed', err);
    const missing = err && err.code === '42P01' ? String(err.message || '').match(/relation "([^"]+)" does not exist/) : null;
    return {
      status: 'error', source: 'router', reason: 'query_failed', text: QUERY_FAILED,
      code: err && err.code ? 'PG_' + err.code : undefined,
      detail: missing ? 'Table or view "' + missing[1] + '" does not exist - run the matching db/*.sql migration.' : undefined,
      error: String((err && err.message) || err).slice(0, 300),
    };
  }
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

  // The most recent user message that was a data question.
  let prior = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (!h || h.role === 'assistant') continue;
    const t = String(h.text || '').trim();
    if (t && parser.classify(t, [], now) === 'data') { prior = t; break; }
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
  'captain', 'there', 'how', 'are', 'doing', 'whats', 'up', 'yes', 'no', 'yep', 'nope', 'lol', 'haha']);

/** True when every word is conversational filler — nothing that could name a metric. */
function isSmallTalk(text) {
  const words = String(text).toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  return words.every(function (w) { return SMALL_TALK.has(w) || w.length <= 2; });
}

// A few variants per intent so repeated greetings don't feel like a recording.
// Fixed text, so nothing here can be invented or wrong.
const SMALL_TALK_REPLIES = {
  thanks: [
    "You're welcome. Ask whenever you need a figure from the records.",
    'Any time. I\'m here when you need the numbers.',
    'Glad to help.',
  ],
  bye: [
    'Fair winds. I\'m here when you need me.',
    'Safe watch. Come find me any time.',
  ],
  howareyou: [
    'All well on the bridge, thanks. What can I get you?',
    'Steady as she goes. What do you need?',
  ],
  affirm: [
    'Right you are. What next?',
    'Understood.',
  ],
  greet: [
    'Hello. Ask me about a vessel, the app, or anything else you need.',
    'Good to see you. What can I look up?',
    'Morning. What do you need from the records?',
  ],
};

function pick(list, seed) {
  return list[Math.abs(seed) % list.length];
}

function smallTalkReply(text, name) {
  const t = String(text).toLowerCase();
  // Seeded from the message so the same input is stable within a session but
  // different greetings vary.
  const seed = t.length * 31 + (t.charCodeAt(0) || 0) + Date.now() / 60000 | 0;
  if (/thank|thx|\bty\b|cheers|appreciate/.test(t)) return personalize(pick(SMALL_TALK_REPLIES.thanks, seed), name);
  if (/\bbye\b|goodbye|good night|\bnight\b|see you|later/.test(t)) return personalize(pick(SMALL_TALK_REPLIES.bye, seed), name);
  if (/how are you|how.?s it going|how are things|you doing|what.?s up|sup\b/.test(t)) return pick(SMALL_TALK_REPLIES.howareyou, seed);
  if (/^\s*(ok|okay|yes|yep|yeah|no|nope|cool|great|nice|sure|got it|alright)\b/.test(t)) return pick(SMALL_TALK_REPLIES.affirm, seed);
  return personalize(pick(SMALL_TALK_REPLIES.greet, seed), name);
}

/** "Hello." becomes "Hello, Nav." when the widget has remembered a name. */
function personalize(reply, name) {
  if (!name) return reply;
  const safe = String(name).replace(/[^\w'\u2019. -]/g, '').trim().slice(0, 40);
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

/** Exposed so the learned-term cache can be cleared when vocabulary changes or in tests. */
function clearLearnedCache() { learnedCache.clear(); }

module.exports = { route: route, agent: agent, ROUTER_BUILD: ROUTER_BUILD, clearLearnedCache: clearLearnedCache, isSmallTalk: isSmallTalk, smallTalkReply: smallTalkReply, isLightMessage: isLightMessage, followUpRewrite: followUpRewrite };