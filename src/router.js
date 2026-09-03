'use strict';

/**
 * Entry point for a widget message. Fixed precedence, checked in order:
 *
 *   1. vessel data question  -> engine.ask()      (unchanged, fully deterministic)
 *   2. app navigation match  -> guide.js           (deterministic keyword match)
 *   3. "anything I should know" -> alerts.js       (deterministic SQL)
 *   4. anything else          -> companion.js       (LLM, no DB access, output-guarded)
 *
 * A message only reaches the LLM once the first three have all had a genuine
 * turn at it and found nothing. This means: the LLM is never in the path for
 * a question that has a data-shaped answer, and it is asked to help only
 * with the residue — greetings, navigation, and conversation.
 */

const engine = require('./engine');
const rbac = require('./rbac');
const { matchGuide, searchGuide } = require('./guide');
const { isBriefingRequest, buildBriefing } = require('./alerts');
const { converse } = require('./companion');

/**
 * @param {object} input  { text, session, pending, now, history, context }
 *   context: { vesselId?, vesselName?, page? } — what the user is looking at
 *   in the host app. Makes "fuel consumption last month" mean that vessel.
 *   history: [{ role, text }] — recent turns for LLM continuity only; never
 *   stored, never containing vessel figures (the widget keeps this in memory
 *   for the page's lifetime and nothing more).
 * @param {object} db     read pool/client
 * @param {object} opts   { orgId, writeDb, dateOrder, env }
 */
async function route(input, db, opts) {
  opts = opts || {};
  const env = opts.env || process.env;

  // A pending clarification or a teach-confirmation always belongs to the
  // engine — the companion never originates a pending state, so if one is
  // present it means a data conversation is mid-flight.
  if (input.pending) {
    return tagSource(await engine.ask(input, db, opts), 'data');
  }

  const text = String(input.text || '').trim();
  if (!text) return { status: 'unparsed', text: 'Ask me about a vessel, the app, or say hello.', source: 'router' };

  // --- 1. data question ------------------------------------------------------
  const dataResult = await engine.ask(input, db, opts);
  if (dataResult.status !== 'unparsed') {
    return tagSource(dataResult, 'data');
  }
  // engine.ask() returns 'unparsed' both for "no metric recognised at all"
  // and after logging the miss — that IS the honest signal the question
  // isn't data-shaped, so falling through here is correct, not a guess.

  // --- 2. app guide -----------------------------------------------------------
  const guideHit = matchGuide(text);
  if (guideHit) {
    return { status: 'answer', text: guideHit.answer, guide: { id: guideHit.id, title: guideHit.title }, source: 'guide' };
  }

  // --- 3. proactive briefing ---------------------------------------------------
  if (isBriefingRequest(text)) {
    const scope = await rbac.resolveScope(input.session, db);
    if (!scope.authenticated) return { status: 'unauthenticated', text: 'Sign in and I can check your vessels.', source: 'router' };
    if (!scope.vessels.length) return { status: 'no_scope', text: 'Your account is not linked to any vessel, so there is nothing to brief.', source: 'router' };
    const briefing = await buildBriefing(scope.vesselIds, scope.vessels.map(function (v) { return v.name; }), db);
    return { status: 'answer', text: briefing.text, findings: briefing.findings, source: 'briefing' };
  }

  // --- 4. companion (LLM), only if enabled -------------------------------------
  if (env.CAPTAIN_ENABLE_LLM === '0') {
    return { status: 'unparsed', text: dataResult.text, source: 'data' };
  }

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
    blocked: convo.blocked || undefined,
    // Surface example data questions so a redirected/blocked answer still
    // gives the user somewhere concrete to go.
    options: convo.blocked ? examplePrompts() : undefined,
  };
}

function examplePrompts() {
  return ['Fuel consumption last month', 'Compliance balance this quarter', 'Off hire hours this year'];
}

function tagSource(result, source) {
  result.source = result.source || source;
  return result;
}

module.exports = { route: route };
