'use strict';

/**
 * Text normalisation and fuzzy matching.
 *
 * The job here is to turn anything a user types — "S.P.", "sp", "Shaft-Power",
 * "shaft powr" — into one canonical string that can be looked up in the alias
 * index. No model, no network, fully deterministic, fully testable.
 */

/**
 * Normalise a term for indexing and lookup.
 *
 *   "S.P."          -> "sp"
 *   "Shaft Power"   -> "shaft power"
 *   "M/E  F.O.C."   -> "me foc"
 *   "CO₂"           -> "co2"
 *
 * Rule that matters: runs of single letters separated by punctuation are
 * glued back together, so dotted abbreviations survive.
 */
function normalizeTerm(input) {
  if (input == null) return '';
  let s = String(input).toLowerCase();

  s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  s = s.replace(/[₀-₉]/g, (d) => String('₀₁₂₃₄₅₆₇₈₉'.indexOf(d)));
  // Stage 1: within each whitespace-separated chunk, punctuation joins single
  // letters ("m/e" -> "me", "f.o.c." -> "foc") but separates real words
  // ("shaft-power" -> "shaft power").
  const chunks = s.split(/\s+/).filter(Boolean).map((chunk) => {
    const segs = chunk.split(/[^a-z0-9]+/).filter(Boolean);
    if (!segs.length) return '';
    return segs.every((x) => x.length === 1) ? segs.join('') : segs.join(' ');
  }).filter(Boolean);

  s = chunks.join(' ');
  if (!s) return '';

  // Stage 2: glue runs of single-character tokens, so "s. p." -> "sp".
  const tokens = s.split(' ');
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length === 1) out.push(run[0]);
    else if (run.length > 1) out.push(run.join(''));
    run = [];
  };
  for (const t of tokens) {
    if (t.length === 1) run.push(t);
    else { flush(); out.push(t); }
  }
  flush();

  return out.join(' ');
}

/** Plural/spelling folding applied per token before comparison. */
const TOKEN_SYNONYMS = {
  consumptions: 'consumption',
  consumed: 'consumption',
  analyse: 'analyze',
  analysing: 'analyze',
  analyzing: 'analyze',
  analysis: 'analyze',
  avg: 'average',
  mean: 'average',
  maximum: 'max',
  highest: 'max',
  peak: 'max',
  minimum: 'min',
  lowest: 'min',
  vs: 'versus',
  mi: 'miles',
  nm: 'nm',
};

function foldTokens(normalized) {
  return normalized
    .split(' ')
    .filter(Boolean)
    .map((t) => TOKEN_SYNONYMS[t] || t.replace(/s$/, (m, i, str) => (str.length > 3 ? '' : m)))
    .join(' ');
}

/** Levenshtein distance, iterative, O(n*m) with a single row buffer. */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    const t = prev; prev = curr; curr = t;
  }
  return prev[b.length];
}

/**
 * Typo tolerance scaled to word length. Short strings get none — "sp" and "ap"
 * are different metrics, not a typo, and guessing between them is exactly the
 * failure mode Captain exists to avoid.
 */
function fuzzyThreshold(len) {
  if (len <= 4) return 0;
  if (len <= 7) return 1;
  if (len <= 12) return 2;
  return 3;
}

/**
 * Build a lookup index from an alias list.
 * entries: [{ term, value, source }]
 */
function buildAliasIndex(entries) {
  const exact = new Map();      // normalized alias -> Set(values)
  const meta = new Map();       // normalized alias -> { term, source }
  let maxWords = 1;

  for (const e of entries) {
    const norm = foldTokens(normalizeTerm(e.term));
    if (!norm) continue;
    if (!exact.has(norm)) exact.set(norm, new Set());
    exact.get(norm).add(e.value);
    if (!meta.has(norm)) meta.set(norm, { term: e.term, source: e.source || 'config' });
    maxWords = Math.max(maxWords, norm.split(' ').length);
  }

  return { exact, meta, maxWords, aliases: Array.from(exact.keys()) };
}

/**
 * Find every metric referenced in a phrase.
 *
 * Returns matches sorted by span length descending, so "main engine
 * consumption" wins over the bare "consumption" contained inside it. Ties on
 * span (genuinely ambiguous words) are all returned so the caller can ask.
 */
function findAliasMatches(text, index) {
  const words = foldTokens(normalizeTerm(text)).split(' ').filter(Boolean);
  const found = [];
  const claimed = new Array(words.length).fill(false);

  for (let n = Math.min(index.maxWords, words.length); n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      if (claimed.slice(i, i + n).some(Boolean)) continue;
      const gram = words.slice(i, i + n).join(' ');
      const hit = index.exact.get(gram);
      if (hit) {
        found.push({
          values: Array.from(hit),
          matched: gram,
          start: i,
          words: n,
          exact: true,
          source: (index.meta.get(gram) || {}).source || 'config',
        });
        for (let k = i; k < i + n; k++) claimed[k] = true;
      }
    }
  }

  if (found.length) return found.sort((a, b) => b.words - a.words || a.start - b.start);

  // Nothing matched exactly — try one fuzzy pass over unclaimed n-grams.
  let best = null;
  for (let n = Math.min(index.maxWords, words.length); n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const gram = words.slice(i, i + n).join(' ');
      const budget = fuzzyThreshold(gram.length);
      if (!budget) continue;
      for (const alias of index.aliases) {
        if (Math.abs(alias.length - gram.length) > budget) continue;
        const d = levenshtein(gram, alias);
        if (d <= budget && (!best || d < best.distance || (d === best.distance && n > best.words))) {
          best = {
            values: Array.from(index.exact.get(alias)),
            matched: gram,
            corrected: alias,
            start: i,
            words: n,
            exact: false,
            distance: d,
            source: (index.meta.get(alias) || {}).source || 'config',
          };
        }
      }
    }
  }

  return best ? [best] : [];
}

module.exports = {
  normalizeTerm,
  foldTokens,
  levenshtein,
  fuzzyThreshold,
  buildAliasIndex,
  findAliasMatches,
};
