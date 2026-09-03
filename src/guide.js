'use strict';

const { normalizeTerm, foldTokens } = require('./normalize');

/**
 * App guidance — answers to "how do I..." questions about the application
 * itself, as opposed to questions about vessel data.
 *
 * Same shape as the metric registry on purpose: a title, an answer, and a
 * list of phrasings a user might type. Matching reuses normalize.js, so
 * "export report" and "how do I export a report" resolve the same way.
 *
 * THIS IS THE FILE TO EDIT for your app's features. Nothing here touches the
 * database — it is static text about the product, maintained the same way
 * you'd maintain a help center.
 */
const GUIDE = [
  {
    id: 'export-report',
    title: 'Exporting a report',
    answer: 'Open the vessel or fleet view you want, then use the Export button in the top-right of that screen. Reports export as PDF or Excel.',
    aliases: ['export report', 'export data', 'download report', 'export to excel', 'export pdf', 'how do i export', 'save a report', 'download data'],
  },
  {
    id: 'add-vessel',
    title: 'Adding a vessel to your fleet',
    answer: 'Go to Fleet Settings → Add Vessel, and enter the IMO number. It appears in your fleet once the next sync completes.',
    aliases: ['add vessel', 'add a ship', 'new vessel', 'register vessel', 'how do i add a vessel'],
  },
  {
    id: 'invite-user',
    title: 'Inviting a teammate',
    answer: 'Go to Settings → Users → Invite, enter their email and choose a department. They will receive an email to set a password.',
    aliases: ['invite user', 'add teammate', 'add colleague', 'invite someone', 'add user', 'new user account'],
  },
  {
    id: 'departments',
    title: 'How departments and access work',
    answer: 'Each vessel belongs to a department (Emission, Performance, etc). Users only see vessels in their own department. An admin can change a vessel\u2019s department in Fleet Settings.',
    aliases: ['departments', 'access control', 'who can see what', 'permissions', 'why cant i see a vessel', 'vessel access'],
  },
  {
    id: 'fueleu-compliance',
    title: 'Reading your FuelEU compliance balance',
    answer: 'A positive compliance balance means you are ahead of the FuelEU target for the period; negative means a deficit that carries forward. Ask me "compliance balance for <vessel>" for the current figure.',
    aliases: ['what is compliance balance', 'fueleu balance meaning', 'understand compliance balance', 'what does deficit mean', 'fueleu explained'],
  },
  {
    id: 'sync-schedule',
    title: 'How often data updates',
    answer: 'Vessel reports and voyage data sync automatically once an hour. If a figure looks stale, check the "Reports read" line under any answer for the last report date.',
    aliases: ['how often does data update', 'when does data refresh', 'data is out of date', 'stale data', 'last sync', 'refresh data'],
  },
  {
    id: 'off-hire-log',
    title: 'Logging or reviewing off-hire',
    answer: 'Off-hire periods come from Veson and appear automatically once synced. To review them for a vessel, ask me "off hire hours for <vessel> this month" or open the vessel\u2019s Voyage tab.',
    aliases: ['log off hire', 'record off hire', 'where is off hire', 'off hire tab', 'review off hire'],
  },
  {
    id: 'password-reset',
    title: 'Resetting your password',
    answer: 'Use "Forgot password" on the sign-in screen. If you are already signed in, go to Settings → Account → Change password.',
    aliases: ['reset password', 'forgot password', 'change password', 'cant log in', 'cannot sign in'],
  },
  {
    id: 'what-is-captain',
    title: 'What Captain Nav can do',
    answer: 'I\u2019m Captain Nav. I answer questions about your vessel data straight from the records, help you find things in the app, and give you a quick briefing on request. I never make up a figure \u2014 if the data does not have it, I say so.',
    aliases: ['what can you do', 'what are you', 'help', 'what is captain', 'what is captain nav', 'captain nav', 'introduce yourself'],
  },
];

const { levenshtein } = require('./normalize');

const BY_ID = Object.fromEntries(GUIDE.map((g) => [g.id, g]));

// App-guide questions arrive as full sentences ("how do I export a report"),
// not the short controlled phrases metric aliases use, so matching here is
// bag-of-words with typo tolerance rather than the metric parser's strict
// contiguous n-gram match. Lower stakes than a vessel figure — the worst
// outcome of a wrong guess is a mismatched help article, never a fabricated
// number — so a looser bar is the right trade-off.
const STOPWORDS = new Set(['how', 'do', 'does', 'did', 'i', 'a', 'an', 'the', 'is', 'are', 'to', 'of',
  'my', 'me', 'can', 'you', 'please', 'for', 'in', 'on', 'and', 'or', 'it', 'this', 'that', 'so',
  // Question words carry no topic. Without this, 'what' alone could pull a
  // random help article for a sentence that has nothing to do with the app.
  'what', 'whats', 'which', 'when', 'where', 'why', 'who', 'was', 'now']);

function tokenize(text) {
  return foldTokens(normalizeTerm(text)).split(' ').filter((w) => w && !STOPWORDS.has(w));
}

function guideTokenSet(g) {
  return new Set(tokenize([g.title, ...g.aliases].join(' ')));
}
const TOKEN_CACHE = new Map(GUIDE.map((g) => [g.id, guideTokenSet(g)]));

/** Credit for one input token against one guide's token set: 1 exact, partial for a near typo. */
function tokenScore(word, tokenSet) {
  if (tokenSet.has(word)) return 1;
  if (word.length < 4) return 0;
  let best = 0;
  for (const t of tokenSet) {
    if (Math.abs(t.length - word.length) > 2) continue;
    const budget = word.length <= 5 ? 1 : 2;
    if (levenshtein(word, t) <= budget) best = Math.max(best, 0.6);
  }
  return best;
}

function scoreAll(text) {
  const words = tokenize(text);
  if (!words.length) return [];
  return GUIDE.map((g) => {
    const tokens = TOKEN_CACHE.get(g.id);
    const score = words.reduce((n, w) => n + tokenScore(w, tokens), 0);
    return { g, score };
  }).sort((a, b) => b.score - a.score);
}

/**
 * A confident single match, for answering directly. Requires a real score
 * and a clear margin over the runner-up — an ambiguous question (score tied
 * across entries) returns null rather than guessing which help article to show.
 */
function matchGuide(text) {
  const ranked = scoreAll(text);
  if (!ranked.length) return null;
  // A short question can match on one solid word ("export report"). A long
  // one needs more than one overlapping word, or a single generic word like
  // "last" would claim sentences that have nothing to do with the app.
  const contentWords = tokenize(text).length;
  const need = contentWords >= 4 ? 2 : 1;
  const [top, second] = ranked;
  if (top.score < need) return null;
  if (second && second.score >= top.score - 0.4) return null;
  return top.g;
}

/** Loose ranked candidates for LLM context — no confidence bar, just relevance. */
function searchGuide(text, limit = 3) {
  return scoreAll(text).filter((x) => x.score > 0).slice(0, limit).map((x) => x.g);
}

module.exports = { GUIDE, matchGuide, searchGuide };