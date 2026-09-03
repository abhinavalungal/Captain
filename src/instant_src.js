'use strict';

const dates = require('./dates');

/**
 * Instant answers. Questions a server can answer exactly, in microseconds,
 * with no model and no database:
 *
 *   - today's date, the time, the year, the day of the week
 *   - "how many days until 31 December", "what date is 30 days from now"
 *   - arithmetic: "22/7", "15% of 200", "divide 22 by 7", "(3+4)*2"
 *
 * A language model has no clock and rounds numbers; the server has both a
 * clock and exact arithmetic. So these never go to the model. The user's time
 * zone comes from the widget (the browser knows it); without one we answer in
 * UTC and say so, rather than guessing.
 */

const DEFAULT_LOCALE = 'en-GB';

// --- time zone handling --------------------------------------------------------

function validTz(tz) {
  if (!tz || typeof tz !== 'string' || tz.length > 64) return null;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return tz; } catch (_) { return null; }
}

function fmt(now, tz, opts) {
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, Object.assign({ timeZone: tz || 'UTC' }, opts)).format(now);
}

/** Calendar parts of `now` as seen in `tz` (for day arithmetic). */
function localParts(now, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return {
    y: +parts.year, m: +parts.month, d: +parts.day,
    weekday: parts.weekday, hour: +parts.hour === 24 ? 0 : +parts.hour, minute: +parts.minute,
  };
}

/** Midnight UTC of the local calendar day — lets us count whole days in the user's zone. */
function localDayUTC(now, tz) {
  const p = localParts(now, tz);
  return Date.UTC(p.y, p.m - 1, p.d);
}

function tzLabel(tz) {
  return tz ? ` (${tz.replace(/_/g, ' ')})` : ' (UTC — tell me your time zone for local time)';
}

function formatNow(now, tz) {
  const t = validTz(tz);
  const date = fmt(now, t, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const time = fmt(now, t, { hour: '2-digit', minute: '2-digit', hour12: false });
  return { date, time, tz: t, label: `${date}, ${time}${tzLabel(t)}` };
}

// --- patterns ------------------------------------------------------------------

const DATE_RE = /\b(?:what(?:'s| is)(?: the| today'?s)? date|what day is (?:it|today)|today'?s date|which day is it|what is today|date today|what(?:'s| is) the day today|what day (?:are we|is it) today)\b/i;
const TIME_RE = /\b(?:what(?:'s| is) the time|what time is it|current time|time (?:now|is it)|tell me the time|what(?:'s| is) the time now)\b/i;
const YEAR_RE = /\b(?:what year is it|which year (?:is it|are we in)|current year|what(?:'s| is) the year)\b/i;
const MONTH_RE = /\b(?:what month is it|which month (?:is it|are we in)|current month)\b/i;
const WEEKDAY_RE = /\b(?:what day of the week|which day of the week|is it (?:the )?weekend|is today (?:a )?(?:weekend|weekday|saturday|sunday|monday|tuesday|wednesday|thursday|friday))\b/i;
const DAYS_UNTIL_RE = /\b(?:how many days (?:until|till|to|before|left (?:until|till|to))|days (?:until|till|to|left until))\s+(.+?)\s*[?.!]*$/i;
const FROM_NOW_RE = /\b(?:what(?:'s| is| will) (?:the )?(?:date|day)(?: be)?|which date(?: is it| will it be)?)?\s*(?:in\s+)?(\d{1,4})\s*(day|days|week|weeks|month|months)\s*(?:from (?:now|today)|later|ahead|from today|time)?\b/i;

// --- arithmetic ------------------------------------------------------------------

const WORD_OPS = [
  [/\b(\d[\d.,]*)\s*(?:percent|%)\s*of\s*(\d[\d.,]*)/gi, '($1/100)*$2'],
  [/\bdivide\s+(\d[\d.,]*)\s+by\s+(\d[\d.,]*)/gi, '$1/$2'],
  [/\bmultiply\s+(\d[\d.,]*)\s+(?:by|and|with)\s+(\d[\d.,]*)/gi, '$1*$2'],
  [/\b(?:add|sum of)\s+(\d[\d.,]*)\s+(?:and|to|plus)\s+(\d[\d.,]*)/gi, '$1+$2'],
  [/\bsubtract\s+(\d[\d.,]*)\s+from\s+(\d[\d.,]*)/gi, '$2-$1'],
  [/\bsquare root of\s+(\d[\d.,]*)/gi, 'sqrt($1)'],
  [/\b(\d[\d.,]*)\s+squared\b/gi, '($1^2)'],
  [/\b(\d[\d.,]*)\s+cubed\b/gi, '($1^3)'],
  [/\bdivided by\b/gi, '/'], [/\btimes\b|\bmultiplied by\b|×/gi, '*'], [/\bplus\b/gi, '+'], [/\bminus\b/gi, '-'], [/÷/g, '/'],
  [/\bto the power of\b|\bpower\b/gi, '^'],
];
const STRIP_RE = /^(?:what(?:'s| is| does)|calculate|compute|work out|solve|evaluate|how much is|can you (?:calculate|compute|work out|do|divide|multiply|add|solve)|please|equals?|=)\s*/i;
const MATH_CHARS_RE = /^[\d\s+\-*/^().,%]*(?:sqrt\([\d\s+\-*/^().,]*\))?[\d\s+\-*/^().,%]*$/;

/** Tokenise and evaluate with precedence. No eval, no Function. */
function evaluate(expr) {
  const tokens = expr.replace(/,/g, '').match(/\d+(?:\.\d+)?|sqrt|[+\-*/^()]/g);
  if (!tokens) return null;
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  function primary() {
    const t = next();
    if (t === undefined) throw new Error('incomplete');
    if (t === '(') { const v = expr_(); if (next() !== ')') throw new Error('paren'); return v; }
    if (t === '-') return -primary();
    if (t === '+') return primary();
    if (t === 'sqrt') { if (next() !== '(') throw new Error('sqrt'); const v = expr_(); if (next() !== ')') throw new Error('paren'); if (v < 0) throw new Error('domain'); return Math.sqrt(v); }
    if (/^\d/.test(t)) return parseFloat(t);
    throw new Error('token');
  }
  function power() { let b = primary(); while (peek() === '^') { next(); const e = power(); b = Math.pow(b, e); } return b; }
  function term() {
    let v = power();
    while (peek() === '*' || peek() === '/') {
      const op = next(); const r = power();
      if (op === '/') { if (r === 0) throw new Error('divzero'); v = v / r; } else v = v * r;
    }
    return v;
  }
  function expr_() { let v = term(); while (peek() === '+' || peek() === '-') { const op = next(); const r = term(); v = op === '+' ? v + r : v - r; } return v; }
  const result = expr_();
  if (i !== tokens.length) throw new Error('trailing');
  return result;
}

function formatNumber(n) {
  if (!Number.isFinite(n)) return null;
  if (Number.isInteger(n)) return n.toLocaleString(DEFAULT_LOCALE);
  const s = Math.abs(n) >= 1e6 || Math.abs(n) < 1e-4 ? n.toPrecision(7) : n.toFixed(6);
  return parseFloat(s).toLocaleString(DEFAULT_LOCALE, { maximumFractionDigits: 6 });
}

function prettyExpr(expr) {
  return expr.replace(/\*/g, ' × ').replace(/\//g, ' ÷ ').replace(/\s+/g, ' ').replace(/\(\s/g, '(').replace(/\s\)/g, ')').trim();
}

function tryArithmetic(text) {
  const shown = String(text).trim().replace(/[?!.]+$/, '').replace(STRIP_RE, '').trim();
  let e = shown;
  for (const [re, rep] of WORD_OPS) e = e.replace(re, rep);
  e = e.replace(STRIP_RE, '').trim();
  if (!e || !/\d/.test(e) || !/[+\-*/^%]|sqrt/.test(e)) return null;
  if (!MATH_CHARS_RE.test(e)) return null;
  // A full date (day, month AND year) written with slashes is not a division.
  // A bare "22/7" is arithmetic — a date question arrives with words around it
  // and never reaches this path.
  const asDate = dates.parseSingleDate(e, {});
  if (asDate && asDate.hasYear) return null;
  // Only "x% of y" is handled (rewritten above); a stray percent is ambiguous.
  if (/%/.test(e)) return null;
  let value;
  try { value = evaluate(e); } catch (err) {
    if (err.message === 'divzero') return { text: 'That divides by zero, which has no defined result.', kind: 'arithmetic' };
    return null;
  }
  const out = formatNumber(value);
  if (out == null) return null;
  // Show the user's own phrasing when it had words in it, otherwise the tidied expression.
  const label = /[a-z%]/i.test(shown) ? shown : prettyExpr(e);
  return { text: `${label} = ${out}`, kind: 'arithmetic', value };
}

// --- unit conversion ---------------------------------------------------------------
//
// Exact, table-driven conversions for the units this domain actually uses:
// speed, distance, mass, power, volume, energy and temperature. No model —
// a model rounds; these factors are exact (or the defined standard value).

const UNIT_DEFS = [
  // speed — base m/s
  { key: 'kn', dim: 'speed', factor: 0.5144444444444445, label: 'knots', sym: 'kn', names: ['kn', 'kt', 'kts', 'knot', 'knots'] },
  { key: 'kmh', dim: 'speed', factor: 1 / 3.6, label: 'km/h', names: ['km/h', 'kmh', 'kph', 'kmph', 'kilometers per hour', 'kilometres per hour'] },
  { key: 'mph', dim: 'speed', factor: 0.44704, label: 'mph', names: ['mph', 'miles per hour'] },
  { key: 'ms', dim: 'speed', factor: 1, label: 'm/s', names: ['m/s', 'mps', 'meters per second', 'metres per second'] },
  // distance — base metres
  { key: 'nm', dim: 'distance', factor: 1852, label: 'nautical miles', sym: 'nm', names: ['nm', 'nmi', 'nautical mile', 'nautical miles'] },
  { key: 'km', dim: 'distance', factor: 1000, label: 'km', names: ['km', 'kilometer', 'kilometers', 'kilometre', 'kilometres'] },
  { key: 'mi', dim: 'distance', factor: 1609.344, label: 'miles', sym: 'mile', names: ['mi', 'mile', 'miles', 'statute miles'] },
  { key: 'ft', dim: 'distance', factor: 0.3048, label: 'ft', names: ['ft', 'foot', 'feet'] },
  { key: 'm', dim: 'distance', factor: 1, label: 'm', names: ['m', 'meter', 'meters', 'metre', 'metres'] },
  // mass — base kg. "t"/"ton" is read as the metric tonne, the unit of this trade.
  { key: 'mt', dim: 'mass', factor: 1000, label: 'MT', names: ['mt', 't', 'tonne', 'tonnes', 'metric ton', 'metric tons', 'metric tonne', 'metric tonnes', 'ton', 'tons'] },
  { key: 'kg', dim: 'mass', factor: 1, label: 'kg', names: ['kg', 'kilo', 'kilos', 'kilogram', 'kilograms'] },
  { key: 'lb', dim: 'mass', factor: 0.45359237, label: 'lb', names: ['lb', 'lbs', 'pound', 'pounds'] },
  { key: 'g', dim: 'mass', factor: 0.001, label: 'g', names: ['g', 'gram', 'grams'] },
  // power — base W
  { key: 'mw', dim: 'power', factor: 1e6, label: 'MW', names: ['mw', 'megawatt', 'megawatts'] },
  { key: 'kw', dim: 'power', factor: 1000, label: 'kW', names: ['kw', 'kilowatt', 'kilowatts'] },
  { key: 'hp', dim: 'power', factor: 745.699872, label: 'hp', names: ['hp', 'horsepower', 'bhp'] },
  { key: 'w', dim: 'power', factor: 1, label: 'W', names: ['w', 'watt', 'watts'] },
  // volume — base litres
  { key: 'm3', dim: 'volume', factor: 1000, label: 'm³', names: ['m3', 'cbm', 'cubic meter', 'cubic meters', 'cubic metre', 'cubic metres'] },
  { key: 'gal', dim: 'volume', factor: 3.785411784, label: 'US gal', names: ['gal', 'gallon', 'gallons', 'us gal', 'us gallon', 'us gallons'] },
  { key: 'l', dim: 'volume', factor: 1, label: 'L', names: ['l', 'litre', 'litres', 'liter', 'liters'] },
  // energy — base J
  { key: 'gj', dim: 'energy', factor: 1e9, label: 'GJ', names: ['gj', 'gigajoule', 'gigajoules'] },
  { key: 'mj', dim: 'energy', factor: 1e6, label: 'MJ', names: ['mj', 'megajoule', 'megajoules'] },
  { key: 'kwh', dim: 'energy', factor: 3.6e6, label: 'kWh', names: ['kwh', 'kilowatt hour', 'kilowatt hours', 'kilowatt-hour', 'kilowatt-hours'] },
  { key: 'j', dim: 'energy', factor: 1, label: 'J', names: ['j', 'joule', 'joules'] },
  // temperature — handled by formula, factor unused
  { key: 'c', dim: 'temp', factor: 1, label: '°C', names: ['c', '°c', 'celsius', 'centigrade', 'degrees c', 'degrees celsius'] },
  { key: 'f', dim: 'temp', factor: 1, label: '°F', names: ['f', '°f', 'fahrenheit', 'degrees f', 'degrees fahrenheit'] },
  { key: 'k', dim: 'temp', factor: 1, label: 'K', names: ['k', 'kelvin'] },
];

const UNIT_BY_NAME = (() => {
  const map = new Map();
  for (const u of UNIT_DEFS) for (const n of u.names) map.set(n, u);
  return map;
})();
// Longest names first, so "nautical miles" beats "mi", "km/h" beats "k".
const UNIT_NAME_ALT = Array.from(UNIT_BY_NAME.keys())
  .sort((a, b) => b.length - a.length)
  .map((n) => n.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))
  .join('|');

const CONVERT_STRIP_RE = /^(?:please\s+)?(?:convert|what(?:'s| is)|how (?:much|many|far|fast) is|change|turn)\s*/i;
const CONVERT_RE = new RegExp(
  '^(-?\\d[\\d,]*(?:\\.\\d+)?)\\s*(?:degrees\\s+)?(' + UNIT_NAME_ALT + ')\\s+(?:to|into|in|as|equals?|->|=)\\s+(?:degrees\\s+)?(' + UNIT_NAME_ALT + ')\\s*[?.!]*$', 'i');

function toCelsius(v, key) {
  if (key === 'c') return v;
  if (key === 'f') return (v - 32) * 5 / 9;
  return v - 273.15; // kelvin
}
function fromCelsius(v, key) {
  if (key === 'c') return v;
  if (key === 'f') return v * 9 / 5 + 32;
  return v + 273.15;
}

/**
 * "10 knots in km/h", "convert 8400 nm to km", "500 mt to lbs", "25 c to f".
 * The whole message (minus a lead-in like "convert" or "what is") must be the
 * conversion phrase, so a data question that merely mentions a unit —
 * "fuel consumption in mt last week" — can never be claimed by this path.
 */
function tryConversion(text) {
  const cleaned = String(text || '').trim().replace(CONVERT_STRIP_RE, '').trim();
  const m = cleaned.match(CONVERT_RE);
  if (!m) return null;
  const value = parseFloat(m[1].replace(/,/g, ''));
  const from = UNIT_BY_NAME.get(m[2].toLowerCase());
  const to = UNIT_BY_NAME.get(m[3].toLowerCase());
  if (!from || !to || !Number.isFinite(value)) return null;
  if (from.key === to.key) {
    return { text: `${formatNumber(value)} ${from.label} is already in ${to.label}.`, kind: 'conversion', value };
  }
  if (from.dim !== to.dim) {
    return {
      text: `I can't convert ${from.label} to ${to.label} — one measures ${from.dim === 'temp' ? 'temperature' : from.dim}, the other ${to.dim === 'temp' ? 'temperature' : to.dim}.`,
      kind: 'conversion',
    };
  }
  let out;
  if (from.dim === 'temp') out = fromCelsius(toCelsius(value, from.key), to.key);
  else out = (value * from.factor) / to.factor;
  const shown = formatNumber(parseFloat(out.toPrecision(10)));
  if (shown == null) return null;
  const factorNote = from.dim === 'temp' ? '' : ` (1 ${from.sym || from.label} = ${formatNumber(parseFloat((from.factor / to.factor).toPrecision(6)))} ${to.sym || to.label})`;
  return { text: `${formatNumber(value)} ${from.label} = ${shown} ${to.label}${factorNote}`, kind: 'conversion', value: out };
}

// --- main -------------------------------------------------------------------------

/**
 * @param {string} text
 * @param {object} ctx  { now, tz }
 * @returns {{ text, kind } | null}
 */
// --- comparing plain numbers -------------------------------------------------
// "Which is bigger, 2 or 19?"  "Visualize a comparison of 3, 7 and 5."
// Exact, local, and never claims a data question: after removing the numbers
// and comparison/filler vocabulary, NOTHING may be left over. "Compare fuel
// consumption 2024 vs 2025" leaves "fuel consumption" and falls through to
// the metric parser, exactly as before.

const COMPARE_CUE_RE = /\b(compare|comparison|bigger|biggest|larger|largest|greater|greatest|smaller|smallest|higher|highest|lower|lowest|max|maximum|min|minimum)\b/i;
const CHART_CUE_RE = /\b(visuali[sz]e|visuali[sz]ation|chart|graph|plot|draw|comparison)\b/i;
const SMALLER_CUE_RE = /\b(smaller|smallest|lower|lowest|less|least|min|minimum)\b/i;

const COMPARE_FILLER = new Set([
  'can', 'could', 'you', 'u', 'please', 'pls', 'me', 'my', 'a', 'an', 'the', 'of', 'is', 'are', 'was',
  'which', 'what', 'whats', 'wat', 'one', 'number', 'numbers', 'value', 'values', 'figure', 'figures',
  'out', 'these', 'those', 'this', 'that', 'two', 'three', 'following', 'and', 'or', 'vs', 'versus',
  'between', 'than', 'tell', 'show', 'give', 'visualize', 'visualise', 'visualization', 'visualisation',
  'chart', 'graph', 'plot', 'draw', 'as', 'in', 'a', 'bar', 'it', 'to', 'for',
  'compare', 'comparison', 'bigger', 'biggest', 'larger', 'largest', 'greater', 'greatest',
  'smaller', 'smallest', 'higher', 'highest', 'lower', 'lowest', 'less', 'least',
  'big', 'small', 'large', 'max', 'maximum', 'min', 'minimum', 'so', 'hey', 'hi', 'hello',
]);

function fmtNum(n) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1e6) / 1e6);
}

function tryCompare(raw) {
  const lower = String(raw).toLowerCase();
  if (!COMPARE_CUE_RE.test(lower)) return null;

  const numTokens = lower.match(/-?\d+(?:\.\d+)?/g);
  if (!numTokens || numTokens.length < 2 || numTokens.length > 12) return null;
  const nums = numTokens.map(Number);

  // Leftover guard: every remaining word must be comparison vocabulary.
  const scrubbedWords = lower
    .replace(/-?\d+(?:\.\d+)?/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !COMPARE_FILLER.has(w));
  if (scrubbedWords.length) return null;

  const wantSmall = SMALLER_CUE_RE.test(lower);
  const max = Math.max.apply(null, nums);
  const min = Math.min.apply(null, nums);

  let text;
  if (max === min) {
    text = `They're equal — all ${fmtNum(max)}.`;
  } else if (nums.length === 2) {
    const diff = fmtNum(Math.abs(nums[0] - nums[1]));
    text = wantSmall
      ? `${fmtNum(min)} is smaller than ${fmtNum(max)} — by ${diff}.`
      : `${fmtNum(max)} is bigger than ${fmtNum(min)} — by ${diff}.`;
  } else {
    text = `Largest is ${fmtNum(max)}, smallest is ${fmtNum(min)}. In order: ${nums.slice().sort((a, b) => a - b).map(fmtNum).join(', ')}.`;
  }

  const out = { text: text, kind: 'compare' };
  if (CHART_CUE_RE.test(lower)) {
    out.chart = { type: 'bar', labels: nums.map(fmtNum), values: nums };
  }
  return out;
}

function answerInstant(text, ctx = {}) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const now = ctx.now ? new Date(ctx.now) : new Date();
  const tz = validTz(ctx.tz);
  const lower = raw.toLowerCase();

  if (TIME_RE.test(lower)) {
    const n = formatNow(now, tz);
    return { text: `It's ${n.time}${tzLabel(tz)}.`, kind: 'time' };
  }
  if (DATE_RE.test(lower)) {
    const n = formatNow(now, tz);
    return { text: `Today is ${n.date}${tz ? '' : tzLabel(tz)}.`, kind: 'date' };
  }
  if (YEAR_RE.test(lower)) return { text: `It's ${localParts(now, tz).y}.`, kind: 'date' };
  if (MONTH_RE.test(lower)) return { text: `It's ${fmt(now, tz, { month: 'long', year: 'numeric' })}.`, kind: 'date' };
  if (WEEKDAY_RE.test(lower)) {
    const p = localParts(now, tz);
    const weekend = p.weekday === 'Saturday' || p.weekday === 'Sunday';
    return { text: `It's ${p.weekday}${weekend ? ' — the weekend' : ', a weekday'}.`, kind: 'date' };
  }

  let m = lower.match(DAYS_UNTIL_RE);
  if (m) {
    const target = dates.resolveTimeRange(m[1], now);
    if (target && !target.needsDate) {
      const todayUTC = localDayUTC(now, tz);
      // resolveTimeRange looks backwards for bare dates; for "until" we want the next occurrence.
      let t = Date.UTC(target.start.getUTCFullYear(), target.start.getUTCMonth(), target.start.getUTCDate());
      if (t < todayUTC && !/\d{4}/.test(m[1])) t = Date.UTC(target.start.getUTCFullYear() + 1, target.start.getUTCMonth(), target.start.getUTCDate());
      const days = Math.round((t - todayUTC) / 86400000);
      const when = dates.humanDate(new Date(t));
      if (days === 0) return { text: `That's today (${when}).`, kind: 'date' };
      if (days < 0) return { text: `${when} was ${Math.abs(days)} day${days === -1 ? '' : 's'} ago.`, kind: 'date' };
      return { text: `${days} day${days === 1 ? '' : 's'} until ${when}.`, kind: 'date' };
    }
  }

  m = lower.match(FROM_NOW_RE);
  if (m && /\b(from now|from today|later|ahead|in \d)/.test(lower)) {
    const n = parseInt(m[1], 10);
    const unit = m[2].replace(/s$/, '');
    const base = new Date(localDayUTC(now, tz));
    const target = unit === 'day' ? dates.addDays(base, n) : unit === 'week' ? dates.addDays(base, n * 7) : dates.addMonths(base, n);
    const weekday = new Intl.DateTimeFormat(DEFAULT_LOCALE, { weekday: 'long', timeZone: 'UTC' }).format(target);
    return { text: `${n} ${unit}${n === 1 ? '' : 's'} from today is ${weekday}, ${dates.humanDate(target)}.`, kind: 'date' };
  }

  const conv = tryConversion(raw);
  if (conv) return conv;

  const cmp = tryCompare(raw);
  if (cmp) return cmp;

  const arith = tryArithmetic(raw);
  if (arith) return arith;

  return null;
}

module.exports = { answerInstant, formatNow, tryArithmetic, tryConversion, tryCompare, evaluate, validTz };