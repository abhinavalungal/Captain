'use strict';

/**
 * Identity — who Captain is, and who the user is.
 *
 * All of this is deterministic string work: no model, no database,
 * microseconds. It sits in the router ABOVE the companion, so "what's your
 * name" is answered in under a millisecond instead of a model round-trip.
 *
 * The user's name is remembered by the WIDGET, not the server. The server is
 * stateless: when a name is captured here, the reply carries
 * `remember: { userName }`; the widget stores it in memory for the page's
 * lifetime and sends it back inside `context.userName` on every message.
 * Nothing is written to disk or localStorage, matching the widget's
 * no-storage design.
 */

const CAPTAIN_NAME = 'Captain Nav';

// --- what is YOUR name / who are you ---------------------------------------

// Matched against a cleaned string (trailing punctuation stripped, spaces
// collapsed), and deliberately loose about typos: "whats you name", "wats ur
// name", "who r u" are all someone asking who Captain is, and none of them
// should ever fall through to a model or, worse, an error.
const CAPTAIN_NAME_RE = new RegExp(
  "\\b(?:wh?[ao]t(?:'?s| is| was| are)?|may i know|tell me|say)\\s+(?:your|you|ur|yr|yor|thy)\\s+names?\\b"
  + "|\\bwho\\s+(?:are|r)\\s+(?:you|u)\\b"
  + '|\\bwhat are you called\\b|\\bdo you have a name\\b|\\bwhat should i call you\\b'
  + "|^(?:your|ur) name$"
  + '|\\bwho am i (?:talking|speaking|chatting) (?:to|with)\\b', 'i');

// --- what can you do (malformed variants) ------------------------------------
// The exact phrases "help" / "what can you do" are claimed earlier by the
// parser's help matcher and get the metric list. This catches everything a
// human actually types around them — "what you can do", "wat can u do",
// "how can you help me" — which previously fell through to the model.
const CAPABILITY_RE = new RegExp(
  "\\b(?:wh?[ao]t|which)\\s+(?:(?:things|stuff|else)\\s+)?(?:can|could|do|does)?\\s*(?:you|u)\\s*(?:can|could)?\\s*(?:do|help(?:\\s+(?:me\\s+)?with)?)\\b"
  + "|\\bhow (?:can|could|do) (?:you|u) help\\b"
  + "|\\bwhat (?:are you|r u) (?:able to do|good at|for)\\b"
  + "|\\bwhat do (?:you|u) (?:know|offer)\\b", 'i');

/** Text answered for capability questions; single source is the guide entry. */
function capabilityAnswer() {
  const { GUIDE } = require('./guide');
  const g = GUIDE.find((e) => e.id === 'what-is-captain');
  return g ? g.answer : `I'm ${CAPTAIN_NAME}. I answer questions about your vessel data, help with the app, and chat. Ask "help" for the full list of measurements I can read.`;
}

/** Trailing decoration people type — ">?", "??!", stray punctuation. */
function scrub(text) {
  return String(text || '').replace(/[\s>\/\\|~^*_=+.,;:!?-]+$/g, '').replace(/\s+/g, ' ').trim();
}

// --- what is MY name --------------------------------------------------------

const MY_NAME_RE = /\b(?:wh?[ao]t(?:'?s| is)? my name|do you (?:know|remember) (?:my|the) name|say my name|remember me|who am i)\s*$/i;

// --- "my name is X" ----------------------------------------------------------

const NAME_STMT_RE = /^\s*(?:hi|hello|hey|yo)?[,!.\s]*(?:my name(?:'?s| is)|i am|i'?m|call me|you can call me|you may call me|this is|name'?s|the name is|it'?s)\s+([A-Za-z][A-Za-z'\u2019.-]{0,29}(?:\s+[A-Za-z][A-Za-z'\u2019.-]{0,29}){0,2})\s*(?:here|speaking)?\s*[.!?]*\s*$/i;

/**
 * Words that follow "i'm ..." far more often than a name does. If the first
 * captured word is one of these, the sentence is a state of mind, not an
 * introduction — it falls through to the companion, which handles "i'm tired"
 * far better than a nametag would.
 */
const NOT_A_NAME = new Set([
  'fine', 'good', 'great', 'ok', 'okay', 'well', 'tired', 'bored', 'busy',
  'sorry', 'sure', 'not', 'so', 'very', 'here', 'back', 'done', 'confused',
  'lost', 'hungry', 'happy', 'sad', 'angry', 'new', 'just', 'still', 'also',
  'curious', 'ready', 'looking', 'trying', 'asking', 'wondering', 'thinking',
  'testing', 'going', 'doing', 'working', 'interested', 'glad', 'stuck',
  'a', 'an', 'the', 'all', 'always', 'never', 'really', 'kind', 'kinda',
  'afraid', 'unsure', 'having', 'getting', 'checking', 'waiting', 'unable',
  'no', 'yes', 'yeah', 'nope', 'none', 'nothing', 'nobody', 'anonymous',
  // time and metric vocabulary — a data question must never read as a name
  'yesterday', 'today', 'tomorrow', 'week', 'month', 'year', 'quarter',
  'power', 'fuel', 'speed', 'distance', 'consumption', 'shaft', 'rpm',
  'help', 'hello', 'hi', 'hey', 'thanks', 'thank', 'captain',
]);

const DECLINE_RE = /^\s*(?:no(?:pe)?|nah|rather not|i'?d rather not|prefer not|none of your business|why|skip|never ?mind|doesn'?t matter|not telling|secret|guess|na)\b/i;

function titleCase(name) {
  return String(name).trim().replace(/\s+/g, ' ')
    .split(' ')
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** A plausible personal name captured from a statement, or null. */
function extractName(text) {
  const m = String(text || '').match(NAME_STMT_RE);
  if (!m) return null;
  const candidate = m[1].trim();
  const first = candidate.split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
  if (!first || NOT_A_NAME.has(first)) return null;
  if (candidate.split(/\s+/).some((w) => NOT_A_NAME.has(w.toLowerCase().replace(/[^a-z]/g, '')))) return null;
  return titleCase(candidate);
}

/**
 * The previous turn asked "What's your name?" (pending { kind: 'name' }), and
 * this message is the reply. A bare "Nav" or "Priya Sharma" is accepted; a
 * decline is respected without nagging; anything else falls through (null)
 * and is routed as a normal message — the user is allowed to ignore the
 * question and just ask about fuel.
 */
function resolveNameReply(text, ctx = {}) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  if (DECLINE_RE.test(raw)) {
    return { text: 'No trouble at all. What can I do for you?', kind: 'name_declined' };
  }

  // A full "my name is X" works here too.
  const stated = extractName(raw);
  if (stated) return greetByName(stated, ctx);

  // Bare name: one to three words, letters only, nothing that reads as a
  // question or a request.
  if (/[?]/.test(raw) || raw.length > 40) return null;
  const words = raw.replace(/[.!,]+$/, '').split(/\s+/);
  if (words.length > 2) return null;
  if (!words.every((w) => /^[A-Za-z][A-Za-z'\u2019.-]*$/.test(w))) return null;
  if (words.some((w) => NOT_A_NAME.has(w.toLowerCase().replace(/[^a-z]/g, '')))) return null;
  return greetByName(titleCase(words.join(' ')), ctx);
}

function greetByName(name, ctx = {}) {
  const vessel = ctx.vesselName ? ` I see you're on the ${ctx.vesselName} page — ask away and I'll default to her.` : '';
  return {
    text: `Pleasure to meet you, ${name}. I'll remember that while we talk.${vessel} What can I look up for you?`,
    kind: 'name_captured',
    remember: { userName: name },
  };
}

/**
 * Answer an identity message, or return null if this isn't one.
 *
 * @param {string} text
 * @param {object} ctx  { userName, vesselName }
 * @returns {{ text, kind, remember?, pending? } | null}
 */
function answerIdentity(text, ctx = {}) {
  const raw = scrub(text);
  if (!raw) return null;

  if (CAPTAIN_NAME_RE.test(raw)) {
    if (ctx.userName) {
      return {
        text: `I'm ${CAPTAIN_NAME} — your assistant for the fleet's records and the app. And you're ${ctx.userName}, if I have it right.`,
        kind: 'captain_name',
      };
    }
    return {
      text: `I'm ${CAPTAIN_NAME} — your assistant for the fleet's records and the app. What's your name?`,
      kind: 'captain_name',
      pending: { kind: 'name' },
    };
  }

  if (MY_NAME_RE.test(raw)) {
    if (ctx.userName) return { text: `You're ${ctx.userName}. I haven't forgotten.`, kind: 'my_name' };
    return {
      text: "You haven't told me yet. What's your name?",
      kind: 'my_name',
      pending: { kind: 'name' },
    };
  }

  const stated = extractName(raw);
  if (stated) return greetByName(stated, ctx);

  return null;
}

module.exports = { answerIdentity, resolveNameReply, extractName, titleCase, CAPTAIN_NAME, CAPABILITY_RE, capabilityAnswer };
