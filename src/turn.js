'use strict';

/**
 * Conversation state for ONE incoming message.
 *
 * Before anything answers, this works out how the message relates to the
 * conversation so far. No database, no model, well under a millisecond.
 *
 *   kind
 *     answer      it answers the clarifying question K.R.1.S just asked
 *     follow_up   it leans on the previous exchange ("explain step 3", "why?")
 *     correction  it says the previous reply missed ("that's not what I asked")
 *     new         anything else: a new question, same topic or a new one
 *
 *   concept     it asks ABOUT something (steps, how it works, what it means)
 *               rather than for a figure from the records
 *   lookup      it asks to READ the user's records
 *
 * A metric word alone never makes a lookup. "What are the steps to verify and
 * report emissions?" names emissions but asks for a process: it goes to the
 * model, not to the metric parser that would ask which emission.
 *
 * Downstream, this decides three things:
 *   - whether an open clarification stays open             (router)
 *   - whether the deterministic engine may answer first    (router)
 *   - what the model is shown: a compacted history plus one line saying what
 *     the latest message is                                (agent, companion)
 */

const parser = require('./parser');
const dates = require('./dates');

// "that's not what I asked", "ignore that", "never mind": whatever was in
// flight is dropped, pending question included.
const RESET_RE = /\b(?:not what i(?:'m| am)? (?:asked|asking|meant|mean|want(?:ed)?|said)|that'?s not (?:it|right|what)|that is not (?:it|right|what)|ignore (?:that|this|it|the (?:last|previous|above)|my (?:last|previous))|forget (?:that|it|about (?:that|it))|never ?mind|scratch that|you misunderstood|misunderstood me|something else|(?:a )?different question|start (?:over|again)|new question|(?:that'?s|that is|you'?re|you are) (?:wrong|incorrect))\b/i;
// "I meant …", "actually …": a rephrase. With a question open it is the
// answer to it; with none it corrects the previous reply.
const REPHRASE_RE = /^\W*(?:no+|nope|nah)?[\s,.!]*(?:i (?:meant|mean)\b|i'?m (?:asking|talking) about|i was (?:asking|talking) about|let me rephrase|actually\b)/i;

// Question shapes that ask about a subject, not for a reading. Present tense
// only: "how did Aurora do last month" is about the records.
const CONCEPT_RE = new RegExp('^\\W*(?:(?:can|could|would) you\\s+|please\\s+|pls\\s+|so\\s+|and\\s+|ok(?:ay)?,?\\s+)?(?:'
  + 'how (?:do|does|is|are|can|could|should|would|will|to|come)\\b(?!\\s+(?:much|many)\\b)'
  + '|why\\b|explain\\b|describe\\b|define\\b|elaborate\\b|outline\\b|teach me\\b|help me understand\\b'
  + '|tell me (?:about|more|how|why|what)\\b|walk me through\\b|give me an? (?:overview|example|summary|explanation)\\b'
  + '|i(?:\'d| would)? (?:want|like|need) to (?:know|understand|learn) (?:about|how|why|what)\\b'
  + '|what (?:is|are|\'s) the (?:steps?|process|procedure|workflow|difference|differences|meaning|purpose|definition|requirements?|rules?|role|method(?:ology)?|formula|scope|deadlines?|penalt(?:y|ies)|benefits?|impact|stages?)\\b'
  + '|what does\\b[^?]*\\bmean\\b|what do (?:you|they|we) mean\\b|(?:list|show me|give me) (?:the )?(?:steps|process|procedure)\\b'
  + ')', 'i');
const CONCEPT_ANYWHERE_RE = /\b(?:steps? (?:to|for|in)|difference between|meaning of|how (?:it|this|that) works|process (?:of|for)|procedure (?:of|for))\b/i;
// "What is CO2 emitted?" is a definition; "what is the CO2 of Aurora last
// week" is a reading. The definitional form counts only with no anchor.
const DEFINE_RE = /^\W*what(?:'s| is| are)\s+(?!the\s+(?:total|sum|average|value|latest|current|reading|figure|highest|lowest|max|min)\b)/i;
const ANCHOR_RE = /\b(?:for|of|on|in|at|from|during|my|our|your|this|that|vessels?|ships?|fleet|imo)\b/i;

// Words that only make sense against what was just said.
const FOLLOW_CUE_RE = /^\W*(?:and|also|so|then|but|what about|how about|what else|anything else|why|how so|really|go on|continue|more|same|ok(?:ay)?,? (?:and|so|what|how|why))\b/i;
const BACKREF_RE = /\b(?:(?:step|point|item|option|number|part|section|stage|phase|no\.?)\s*#?\d+|(?:the )?(?:first|second|third|fourth|fifth|sixth|seventh|last|previous|next|above|former|latter|same) (?:one|step|point|item|option|part|stage|answer|question)|elaborate|expand on|explain (?:more|further|that|this|it|again)|more detail|in detail|an example|for example|simpler|simplify|summari[sz]e (?:that|this|it)|tl;?dr|after that|before that|what happens (?:next|after|then)|that one|this one|those|these|them)\b|^\W*(?:why|how|really|example|examples|more|go on|continue|and\??|so\??)\W*$/i;

function words(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function norm(text) {
  return String(text || '').toLowerCase().replace(/[“”"'‘’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function hasPeriod(text, now) {
  const r = dates.resolveTimeRange(String(text || ''), now ? new Date(now) : new Date());
  return !!(r && !r.needsDate);
}

/** A question about a subject rather than a request for one of their readings. */
function isConcept(text, now) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (CONCEPT_ANYWHERE_RE.test(t)) return true;
  // Any sentence: "Ignore that. How is CII calculated?" asks in the second.
  if (t.split(/(?<=[.!?])\s+|\n+/).some(function (s) { return CONCEPT_RE.test(s); })) return true;
  if (DEFINE_RE.test(t) && words(t) <= 8) {
    const rest = t.replace(DEFINE_RE, '');
    return !ANCHOR_RE.test(rest) && !hasPeriod(t, now);
  }
  return false;
}

function lastOf(history, role) {
  for (let i = (history || []).length - 1; i >= 0; i--) {
    const h = history[i];
    if (h && h.role === role && h.text) return String(h.text);
  }
  return null;
}

/** The last N assistant replies, newest first. */
function recentReplies(history, n) {
  const out = [];
  for (let i = (history || []).length - 1; i >= 0 && out.length < n; i--) {
    const h = history[i];
    if (h && h.role === 'assistant' && h.text) out.push(String(h.text));
  }
  return out;
}

/**
 * True when `text` repeats one of the last two replies: a clarification asked
 * again, or an answer given twice. Either way it is a loop, not progress.
 */
function repeatsRecent(text, history) {
  const n = norm(text);
  if (n.length < 8) return false;
  return recentReplies(history, 2).some(function (r) {
    const m = norm(r);
    return m === n || (m.length >= 24 && n.length >= 24 && (m.indexOf(n) === 0 || n.indexOf(m) === 0));
  });
}

/**
 * @param {object} input { text, history, pending, now }
 * @returns {{ kind: string, concept: boolean, lookup: boolean, dropPending: boolean,
 *             about: string|null, asked: string|null }}
 *   dropPending  the open clarification no longer stands
 *   about        the previous user question, for a follow-up
 *   asked        the question K.R.1.S asked, for an answer to it
 */
function analyseTurn(input) {
  const text = String((input && input.text) || '').trim();
  const history = Array.isArray(input && input.history) ? input.history : [];
  const pending = input && input.pending && input.pending.kind === 'clarify' ? input.pending : null;
  const now = input && input.now;

  const concept = isConcept(text, now);
  const lookup = !concept && parser.classify(text, [], now) === 'data';
  const reset = RESET_RE.test(text);
  const rephrase = REPHRASE_RE.test(text);
  const prevAssistant = lastOf(history, 'assistant');
  const prevUser = lastOf(history, 'user');

  const out = { kind: 'new', concept: concept, lookup: lookup, dropPending: false, about: null, asked: null, hadHistory: history.length > 0 };

  if (pending) {
    // Only a short, one-line, non-conceptual reply can be an answer; the
    // engine then checks it actually makes progress on the question.
    if (reset || concept || words(text) > 12 || /\n/.test(text)) {
      out.dropPending = true;
    } else {
      out.kind = 'answer';
      out.asked = prevAssistant;
      return out;
    }
  }

  if (!history.length) return out;
  if (reset || rephrase) {
    out.kind = 'correction';
    return out;
  }
  if (prevAssistant && words(text) <= 12 && (FOLLOW_CUE_RE.test(text) || BACKREF_RE.test(text))) {
    out.kind = 'follow_up';
    out.about = prevUser ? prevUser.slice(0, 80) : null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// What the model is shown
// ---------------------------------------------------------------------------

const OLD_REPLY_CHARS = 700;   // background replies are clipped...
const OLD_USER_CHARS = 400;
const ANSWERED = '(Answered.)';

function clip(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + ' …' : s;
}

/**
 * The history as model messages. Relevance by position: the last exchange
 * (what the latest message can refer to) is kept whole; everything older is
 * background and is clipped, so one long old answer cannot outweigh the
 * question being asked now. Two user turns in a row mean a reply was not
 * recorded (an older client); a placeholder keeps the earlier one from
 * looking unanswered, which is what pulls a model back to an old topic.
 */
function modelHistory(history, maxTurns, maxChars) {
  const h = (history || []).filter(function (x) { return x && x.text; }).slice(-maxTurns);
  const out = [];
  h.forEach(function (x, i) {
    const role = x.role === 'assistant' ? 'assistant' : 'user';
    const recent = i >= h.length - 2;
    const cap = recent ? maxChars : role === 'assistant' ? OLD_REPLY_CHARS : OLD_USER_CHARS;
    if (role === 'user' && out.length && out[out.length - 1].role === 'user') out.push({ role: 'assistant', content: ANSWERED });
    out.push({ role: role, content: clip(x.text, cap) });
  });
  if (out.length && out[out.length - 1].role === 'user') out.push({ role: 'assistant', content: ANSWERED });
  return out;
}

/** Standing instruction for every conversation, in both model paths. */
const LATEST_RULE = 'CONVERSATION: answer the user\'s LATEST message. Earlier turns are background: use them to '
  + 'understand references in it ("that", "step 3", "the same vessel"), never to re-answer an earlier question or to '
  + 'resume a clarifying question the user has moved on from. A new question gets a fresh answer on its own terms, '
  + 'even when it shares words with an earlier topic. Never repeat a clarifying question you have already asked.';

/** One line telling the model what the latest message is. Null when there is nothing to say. */
function frameLine(turn) {
  if (!turn) return null;
  const q = function (s) { return '"' + clip(String(s).replace(/\s+/g, ' '), 160) + '"'; };
  if (turn.loop) {
    return 'THIS TURN: you already asked ' + q(turn.loop) + ' and the user did not take it up. Do not ask it again. '
      + 'Answer the latest message with the most reasonable reading, say in a few words which reading you took, '
      + 'and offer the alternative.';
  }
  switch (turn.kind) {
    case 'correction':
      return 'THIS TURN: the user is correcting you; your previous reply missed what they wanted. Drop that line '
        + 'entirely and do not repeat it. If this message says what they want, answer exactly that; if not, ask one '
        + 'short question about what they meant.';
    case 'follow_up':
      return 'THIS TURN: the latest message follows up on the previous exchange' + (turn.about ? ' (' + q(turn.about) + ')' : '')
        + '. Resolve words like "that", "it" or "step 3" against that exchange.';
    case 'answer':
      return turn.asked ? 'THIS TURN: the latest message answers your question ' + q(turn.asked) + '. Continue the original request with it.' : null;
    default:
      return turn.hadHistory
        ? 'THIS TURN: the latest message is a new question. Answer it on its own; bring in earlier turns only if it refers to them.'
        : null;
  }
}

// ---------------------------------------------------------------------------
// Figures already in the conversation
// ---------------------------------------------------------------------------

const NUM_RE = /(?<![\w.])\d[\d,]*(?:\.\d+)?/g;

/**
 * Every number already said in this conversation. A figure K.R.1.S read from
 * the records two turns ago (or one the user typed) may be restated in a
 * follow-up; the output guard is there to stop invented figures, not these.
 */
function knownFigures(history, text) {
  const set = new Set();
  const add = function (s) { (String(s || '').match(NUM_RE) || []).forEach(function (n) { set.add(n.replace(/,/g, '')); }); };
  (history || []).forEach(function (h) { if (h) add(h.text); });
  add(text);
  return set;
}

module.exports = { analyseTurn, isConcept, repeatsRecent, modelHistory, frameLine, knownFigures, LATEST_RULE, norm };
