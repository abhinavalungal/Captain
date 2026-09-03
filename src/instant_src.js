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

// --- main -------------------------------------------------------------------------

/**
 * @param {string} text
 * @param {object} ctx  { now, tz }
 * @returns {{ text, kind } | null}
 */
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

  const arith = tryArithmetic(raw);
  if (arith) return arith;

  return null;
}

module.exports = { answerInstant, formatNow, tryArithmetic, evaluate, validTz };
