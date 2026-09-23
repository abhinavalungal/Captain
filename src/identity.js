'use strict';

/**
 * Identity — who K.R.1.S is, and who the user is.
 *
 * All of this is deterministic string work: no model, no database,
 * microseconds. It sits in the router ABOVE the companion, so "what's your
 * name" is answered in under a millisecond instead of a model round-trip.
 *
 * The user's name is remembered by the WIDGET, not the server. The server is
 * stateless: when a name is captured here, the reply carries
 * `remember: { userName }`; the widget keeps it with the conversation (in
 * memory, and in this tab's sessionStorage unless persist: false) and sends
 * it back inside `context.userName` on every message. Nothing is stored
 * server-side.
 */

const KRIS_NAME = 'K.R.1.S';
// The model's name wherever a person can see it. Whatever the server actually
// runs (KRIS_LLM_MODEL) stays in the configuration and the logs.
const MODEL_LABEL = 'N.A.V 3.8b';

// "which model are you", "what llm powers you", "are you chatgpt / llama?"
// The cheap hint keeps "hi" from paying for the big pattern's first compile.
const MODEL_HINT_RE = /model|llm|\bai\b|gpt|llama|meta|claude|gemini|mistral|qwen|deepseek|copilot|openai|ollama|engine|version|powers|runs|built|based|running|trained/i;
const MODEL_RE = new RegExp(
  '\\b(?:wh?[ao]t|which)(?:\'?s| is)?\\s+(?:(?:ai|llm|language|large language)\\s+)?(?:model|llm|ai|engine|version)\\b.*\\b(?:you|u|kris|k\\.?r\\.?1\\.?s|this|powers?|running|use|using|based)\\b'
  + '|\\b(?:your|ur)\\s+(?:ai\\s+|language\\s+)?(?:model|llm)\\b'
  + '|\\bwhat (?:powers|runs) (?:you|u|kris)\\b|\\bwhat are (?:you|u) (?:built|based|running|trained) on\\b'
  + '|\\b(?:based on|built on|running on|powered by) (?:llama|meta|chat ?gpt|gpt|openai|claude|gemini|mistral|qwen|ollama)\\b'
  + '|\\bare (?:you|u) (?:an? )?(?:chat ?gpt|gpt[- ]?\\d*\\w*|llama|meta ai|claude|gemini|mistral|qwen|deepseek|copilot|llm|large language model|language model)\\b', 'i');

// --- what is YOUR name / who are you ---------------------------------------

// Matched against a cleaned string (trailing punctuation stripped, spaces
// collapsed), and deliberately loose about typos: "whats you name", "wats ur
// name", "who r u" are all someone asking who K.R.1.S is, and none of them
// should ever fall through to a model or, worse, an error.
const KRIS_NAME_RE = new RegExp(
  "\\b(?:wh?[ao]t(?:'?s| is| was| are)?|may i know|tell me|say)\\s+(?:your|you|ur|yr|yor|thy)\\s+names?\\b"
  + "|\\bwho\\s+(?:are|r)\\s+(?:you|u)\\b"
  + '|\\bwhat are you called\\b|\\bdo you have a name\\b|\\bwhat should i call you\\b'
  + "|^(?:your|ur) name$"
  + '|\\bwho am i (?:talking|speaking|chatting) (?:to|with)\\b', 'i');

// --- what does K.R.1.S mean ---------------------------------------------------
// "what does K.R.1.S stand for", "why are you called kris", "are you krishna".
// Answered here, deterministically, so the explanation of the codename is
// always the same respectful sentence and never a model's improvisation.
const KRIS_SPELL = '(?:k\\.?\\s?r\\.?\\s?[1i]\\.?\\s?s\\.?|kris)';
const NAME_MEANING_RE = new RegExp(
  '\\bwhat (?:does|do|is) (?:the name )?(?:' + KRIS_SPELL + '|your name) (?:stand for|mean|short for)\\b'
  + '|\\bwhy (?:are you|r u|is it) (?:called|named) ' + KRIS_SPELL + '\\b'
  + '|\\bwhy (?:the name )?' + KRIS_SPELL + '$'
  + '|\\bmeaning (?:of|behind) (?:your name|the name|' + KRIS_SPELL + ')\\b'
  + '|\\bare (?:you|u) (?:lord |shri |sri )?krishna\\b', 'i');

const NAME_MEANING = `${KRIS_NAME} is a codename inspired by Lord Krishna \u2014 the calm charioteer who guided Arjuna without ever taking the reins from him. That is the idea here: I guide you through your fleet's records and the app, and you stay in charge. Say it "Kris".`;

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
  const g = GUIDE.find((e) => e.id === 'what-is-kris');
  return g ? g.answer : `I'm ${KRIS_NAME}. I answer questions about your vessel data, help with the app, and chat. Ask "help" for the full list of measurements I can read.`;
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
  'help', 'hello', 'hi', 'hey', 'thanks', 'thank', 'kris',
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
    text: `Lovely to meet you, ${name}. I'll remember that while we talk.${vessel} What can I look up for you?`,
    kind: 'name_captured',
    remember: { userName: name },
  };
}

// --- questions about the USER: "where do I work?", "tell me about me" ---------
//
// Answered from what the widget sends in context.profile (what the user has
// allowed K.R.1.S to remember, plus what they said in this chat) — never
// from the app guide, never from a model. Typing is forgiving: "i wask were
// do i work", "whats my comp name" are the same questions.

/** Lower-case, common typos folded, padded with spaces for whole-word tests. */
function normaliseQuestion(text) {
  return ' ' + String(text || '').toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\b(?:were|wher|whre|wehre)\b/g, 'where')
    .replace(/\b(?:wat|wht|whta|waht)\b/g, 'what')
    .replace(/\bwhat'?s\b/g, 'what is')
    .replace(/\bwho'?s\b/g, 'who is')
    .replace(/\b(?:comp|compny|companey|compnay|cmpany|campany|co)\b/g, 'company')
    .replace(/\b(?:ur|yr)\b/g, 'your')
    .replace(/\bu\b/g, 'you')
    .replace(/\b(?:i'?m|im)\b/g, 'i am')
    .replace(/\b(?:wrk|wok|werk)\b/g, 'work')
    .replace(/\b(?:dept)\b/g, 'department')
    .replace(/\s+/g, ' ') + ' ';
}

const ABOUT_TOPICS = [
  ['work', / where (?:do|did) i work | who do i work for | (?:what|which) (?:is|was) (?:my|the) company(?: name)? | (?:what|which) company (?:do|am|did) i | my company(?: name)? $| what is my (?:employer|organi[sz]ation|firm|office) /],
  ['role', / what (?:is|was) my (?:role|job|job title|title|position|designation|work) | what do i do(?: for (?:work|a living))? $/],
  ['department', / (?:which|what) (?:department|team|division) (?:am i|do i)| what is my (?:department|team|division) /],
  ['location', / where am i (?:based|located|working from) | where do i live | what is my (?:location|city|base) /],
  ['timezone', / what is my time ?zone | which time ?zone am i /],
  ['interests', / what (?:am i interested in|are my interests|do i focus on) /],
  ['all', / (?:tell|say|talk|share)(?: me)? (?:something )?about me | who am i $| what (?:do|did) you know about me | (?:said|asked|meant|mean|talking) (?:about )?me $| describe me | about me $| my profile $/],
];

/** Which question about the user this is, or null. */
function aboutTopic(text) {
  const raw = String(text || '');
  if (raw.length > 160 || /\n/.test(raw)) return null;
  // "forget my company name" is a request about memory, not a question.
  if (/^\s*(?:(?:hey |ok )?kris[,:]?\s+)?(?:please\s+)?(?:forget|remember|don'?t forget|stop remembering|erase|keep in mind)\b/i.test(raw)) return null;
  const n = normaliseQuestion(raw);
  if (/ who am i (?:talking|speaking|chatting)/.test(n)) return null;
  for (let i = 0; i < ABOUT_TOPICS.length; i++) if (ABOUT_TOPICS[i][1].test(n)) return ABOUT_TOPICS[i][0];
  return null;
}

function anArticle(s) { return /^[aeiou]/i.test(s) && !/^(?:uni|use|eu)/i.test(s) ? 'an' : 'a'; }
function lowerRole(s) { return /^[A-Z]{2,}/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1); }

/**
 * Answer a question about the user from their profile, or null if this is
 * not one. Never guesses: what it does not know, it says it does not know.
 */
function answerAboutUser(text, ctx = {}) {
  const topic = aboutTopic(text);
  if (!topic) return null;
  const p = Object.assign({}, ctx.profile || {});
  if (!p.name && ctx.userName) p.preferredName = p.preferredName || ctx.userName;
  const role = p.role ? anArticle(p.role) + ' ' + lowerRole(p.role) : null;
  const tell = (what, example) => `You haven't told me ${what} yet. Tell me — for example “${example}” — and I'll keep it in mind.`;
  const out = (t) => ({ text: t, kind: 'about_user', topic: topic, actions: [{ label: 'Open profile', run: 'view:profile', icon: 'user' }] });

  if (topic === 'work') {
    if (p.company) return out(`You work at ${p.company}${p.department ? ', in ' + p.department : ''}${role ? ', as ' + role : ''}.`);
    if (role || p.department) return out(`You haven't told me which company you work for — I do know you're ${role || 'in ' + p.department}.`);
    return out(tell('where you work', 'I work at …'));
  }
  if (topic === 'role') {
    if (role) return out(`You're ${role}${p.company ? ' at ' + p.company : ''}.`);
    return out(tell('your role', 'I work as a marine emissions analyst'));
  }
  if (topic === 'department') {
    if (p.department) return out(`You're in ${p.department}${p.company ? ' at ' + p.company : ''}.`);
    return out(tell('your department', 'I’m in the emissions team'));
  }
  if (topic === 'location') {
    if (p.location) return out(`You're based in ${p.location}.`);
    return out(tell('where you are based', 'I’m based in …'));
  }
  if (topic === 'timezone') {
    if (p.timezone) return out(`Your time zone is ${p.timezone}.`);
    return out(tell('your time zone', 'my time zone is Asia/Kolkata'));
  }
  if (topic === 'interests') {
    if (p.interests && p.interests.length) return out(`You're interested in ${p.interests.join(', ')}.`);
    return out(tell('what you focus on', 'I’m interested in FuelEU Maritime'));
  }
  // everything
  const lines = [];
  const name = p.name || p.preferredName;
  if (name) lines.push('- **Name:** ' + name + (p.preferredName && p.name && p.preferredName !== p.name ? ' (you like to be called ' + p.preferredName + ')' : ''));
  if (p.role) lines.push('- **Role:** ' + p.role);
  if (p.company) lines.push('- **Company:** ' + p.company);
  if (p.department) lines.push('- **Department:** ' + p.department);
  if (p.location) lines.push('- **Based in:** ' + p.location);
  if (p.timezone) lines.push('- **Time zone:** ' + p.timezone);
  if (p.interests && p.interests.length) lines.push('- **Interests:** ' + p.interests.join(', '));
  if (p.notes && p.notes.length) p.notes.forEach((n) => lines.push('- ' + n));
  // Nothing known: fall through to the name question ("who am i" asks for a
  // name and waits for it), or say so plainly.
  if (!lines.length) {
    if (MY_NAME_RE.test(scrub(text))) return null;
    return Object.assign(out("I don't know anything about you yet. What's your name? You can tell me your role or where you work too."), { pending: { kind: 'name' } });
  }
  return out('Here’s what I know about you:\n\n' + lines.join('\n'));
}

/**
 * Answer an identity message, or return null if this isn't one.
 *
 * @param {string} text
 * @param {object} ctx  { userName, vesselName, profile }
 * @returns {{ text, kind, remember?, pending?, actions? } | null}
 */
function answerIdentity(text, ctx = {}) {
  const raw = scrub(text);
  if (!raw) return null;

  if (NAME_MEANING_RE.test(raw)) {
    return { text: NAME_MEANING, kind: 'kris_meaning' };
  }

  if (MODEL_HINT_RE.test(raw) && MODEL_RE.test(raw)) {
    return { text: `I'm ${KRIS_NAME}, an AI assistant running on ${MODEL_LABEL}. Every vessel figure I give you comes from your records, never from the model.`, kind: 'kris_model' };
  }

  if (KRIS_NAME_RE.test(raw)) {
    if (ctx.userName) {
      return {
        text: `I'm ${KRIS_NAME} — say it "Kris". I'm your calm guide to the fleet's records and the app. And you're ${ctx.userName}, if I have it right.`,
        kind: 'kris_name',
      };
    }
    return {
      text: `I'm ${KRIS_NAME} — say it "Kris". I'm your calm guide to the fleet's records and the app. What's your name?`,
      kind: 'kris_name',
      pending: { kind: 'name' },
    };
  }

  // Questions about the user ("where do I work?", "tell me about me").
  const aboutMe = answerAboutUser(text, ctx);
  if (aboutMe) return aboutMe;

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

module.exports = { answerIdentity, answerAboutUser, aboutTopic, normaliseQuestion, resolveNameReply, extractName, titleCase, KRIS_NAME, MODEL_LABEL, NAME_MEANING_RE, CAPABILITY_RE, capabilityAnswer };
