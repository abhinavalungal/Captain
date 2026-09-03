'use strict';

/**
 * Deterministic time-range resolution.
 *
 * Everything is computed in UTC and returned as an explicit, inclusive
 * calendar range plus a half-open instant range, so downstream SQL never has
 * to guess about boundaries.
 *
 * Why this is hand-written rather than handed to a date library: the common
 * libraries resolve a bare "1 January" asked in September to *next* January,
 * and return a single instant for "last month" rather than the month. Both
 * produce confidently wrong answers about vessel history. Here, a bare
 * month/day always resolves to the most recent occurrence at or before today,
 * and every period phrase expands to its full span.
 */

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const DEFAULTS = { dateOrder: 'DMY', weekStartsOn: 1 }; // 1 = Monday

// --- small UTC helpers ------------------------------------------------------

const utc = (y, m, d, h = 0, mi = 0, s = 0) => new Date(Date.UTC(y, m - 1, d, h, mi, s));
const addDays = (dt, n) => new Date(dt.getTime() + n * 86400000);
const startOfDay = (dt) => utc(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function addMonths(dt, n) {
  const y = dt.getUTCFullYear();
  const m = dt.getUTCMonth() + 1 + n;
  const targetY = y + Math.floor((m - 1) / 12);
  const targetM = ((m - 1) % 12 + 12) % 12 + 1;
  const d = Math.min(dt.getUTCDate(), daysInMonth(targetY, targetM));
  return utc(targetY, targetM, d);
}

function ymd(dt) {
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

function humanDate(dt) {
  return `${dt.getUTCDate()} ${MONTH_NAMES[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
}

/**
 * Build the canonical range object.
 * start/endInclusive are day-resolution anchors; endExclusive is the instant
 * boundary used for timestamp columns.
 */
function makeRange(start, endInclusive, opts = {}) {
  const grain = opts.grain || 'day';
  const endExclusive = opts.endExclusive
    || (grain === 'day' ? addDays(startOfDay(endInclusive), 1) : endInclusive);
  return {
    grain,
    start,
    endInclusive,
    endExclusive,
    startDate: ymd(start),
    endDate: ymd(endInclusive),
    startISO: start.toISOString(),
    endExclusiveISO: endExclusive.toISOString(),
    label: opts.label || (ymd(start) === ymd(endInclusive)
      ? humanDate(start)
      : `${humanDate(start)} to ${humanDate(endInclusive)}`),
    days: Math.max(1, Math.round((startOfDay(endInclusive) - startOfDay(start)) / 86400000) + 1),
    assumed: opts.assumed || null,
    matched: opts.matched || null,
  };
}

const wholeDay = (dt, label) => makeRange(startOfDay(dt), startOfDay(dt), { label: label || humanDate(dt) });

function wholeMonth(y, m, label) {
  return makeRange(utc(y, m, 1), utc(y, m, daysInMonth(y, m)), {
    label: label || `${MONTH_NAMES[m - 1]} ${y}`,
  });
}

function startOfWeek(dt, weekStartsOn) {
  const d = startOfDay(dt);
  const shift = (d.getUTCDay() - weekStartsOn + 7) % 7;
  return addDays(d, -shift);
}

// --- single date parsing ----------------------------------------------------

const ORD = '(?:st|nd|rd|th)?';
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

/**
 * Parse one date expression. Returns { y, m, d, hasYear } or null.
 * `y` is omitted when the text carried no year; the caller anchors it.
 */
function parseSingleDate(text, opts) {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ');

  // 2026-08-15  /  2026/08/15
  let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return { y: +m[1], m: +m[2], d: +m[3], hasYear: true };

  // 15 August 2026 / 15th Aug 2026 / 15-Aug-2026
  m = t.match(new RegExp(`^(\\d{1,2})${ORD}[ \\-/]?(${MONTH_RE})\\b[ \\-,/]*(\\d{2,4})?$`));
  if (m) return { d: +m[1], m: MONTHS[m[2]], y: m[3] ? normYear(+m[3]) : undefined, hasYear: !!m[3] };

  // August 15 2026 / Aug 15th, 2026
  m = t.match(new RegExp(`^(${MONTH_RE})\\b[ \\-/]?(\\d{1,2})${ORD}[ \\-,/]*(\\d{2,4})?$`));
  if (m) return { m: MONTHS[m[1]], d: +m[2], y: m[3] ? normYear(+m[3]) : undefined, hasYear: !!m[3] };

  // 15/08/2026 or 08/15/2026, honouring configured order, with auto-correction
  m = t.match(/^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2,4}))?$/);
  if (m) {
    const a = +m[1], b = +m[2];
    let day, mon;
    if (a > 12 && b <= 12) { day = a; mon = b; }
    else if (b > 12 && a <= 12) { day = b; mon = a; }
    else if ((opts.dateOrder || 'DMY') === 'DMY') { day = a; mon = b; }
    else { day = b; mon = a; }
    if (mon < 1 || mon > 12) return null;
    return { d: day, m: mon, y: m[3] ? normYear(+m[3]) : undefined, hasYear: !!m[3] };
  }

  return null;
}

function normYear(y) {
  if (y >= 1000) return y;
  return y < 70 ? 2000 + y : 1900 + y;
}

function isValidDate(y, m, d) {
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

/**
 * Anchor a possibly year-less date. Without a year, choose the most recent
 * occurrence at or before the reference date — historical questions look
 * backwards, never forwards.
 */
function anchorDate(parts, ref) {
  if (parts.hasYear) {
    if (!isValidDate(parts.y, parts.m, parts.d)) return null;
    return utc(parts.y, parts.m, parts.d);
  }
  let y = ref.getUTCFullYear();
  if (!isValidDate(y, parts.m, parts.d)) {
    if (parts.m === 2 && parts.d === 29) y -= 1;
    else return null;
  }
  let dt = utc(y, parts.m, parts.d);
  if (dt > startOfDay(ref)) {
    y -= 1;
    while (!isValidDate(y, parts.m, parts.d)) y -= 1;
    dt = utc(y, parts.m, parts.d);
  }
  return dt;
}

// --- clock-time parsing -----------------------------------------------------

/** "1 PM", "13:00", "1:30pm", "0930" -> minutes since midnight, or null. */
function parseClock(text) {
  const t = text.trim().toLowerCase().replace(/\s+/g, '');
  let m = t.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/);
  if (m) {
    let h = +m[1];
    if (h < 1 || h > 12) return null;
    if (m[3] === 'pm' && h !== 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
    return h * 60 + (m[2] ? +m[2] : 0);
  }
  m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (m && +m[1] <= 23 && +m[2] <= 59) return +m[1] * 60 + +m[2];
  m = t.match(/^(\d{2})(\d{2})(?:hrs?|h)?$/);
  if (m && +m[1] <= 23 && +m[2] <= 59) return +m[1] * 60 + +m[2];
  m = t.match(/^(\d{1,2})(?:00)?(?:hrs?|h)$/);
  if (m && +m[1] <= 23) return +m[1] * 60;
  return null;
}

const CLOCK_TOKEN = '(?:\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)|\\d{1,2}:\\d{2}|\\d{3,4}\\s*(?:hrs?|h)\\b)';

/**
 * Detect an hour-of-day window. Returns { fromMin, toMin, matched } or null.
 * Deliberately does not invent a date — the caller must supply or ask for one.
 */
function findClockWindow(text) {
  const t = text.toLowerCase();
  const re = new RegExp(`(?:between|from)\\s+(${CLOCK_TOKEN})\\s*(?:and|to|until|till|-|–)\\s*(${CLOCK_TOKEN})`, 'i');
  const m = t.match(re);
  if (m) {
    const a = parseClock(m[1]);
    const b = parseClock(m[2]);
    if (a != null && b != null) return { fromMin: a, toMin: b, matched: m[0] };
  }
  const re2 = new RegExp(`\\bat\\s+(${CLOCK_TOKEN})`, 'i');
  const m2 = t.match(re2);
  if (m2) {
    const a = parseClock(m2[1]);
    if (a != null) return { fromMin: a, toMin: a + 60, matched: m2[0], point: true };
  }
  return null;
}

function applyClockWindow(dayStart, win) {
  const from = new Date(dayStart.getTime() + win.fromMin * 60000);
  let to = new Date(dayStart.getTime() + win.toMin * 60000);
  if (to <= from) to = new Date(to.getTime() + 86400000); // window crosses midnight
  const fmt = (mins) => `${String(Math.floor(mins / 60) % 24).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  return makeRange(from, new Date(to.getTime() - 1), {
    grain: 'hour',
    endExclusive: to,
    label: `${humanDate(dayStart)}, ${fmt(win.fromMin)}–${fmt(win.toMin)}`,
    matched: win.matched,
  });
}

// --- main resolver ----------------------------------------------------------

/**
 * Resolve a time range from free text.
 *
 * @returns {null | Range | { needsDate: true, clock: {...} }}
 */
function resolveTimeRange(text, refDate, options = {}) {
  const opts = Object.assign({}, DEFAULTS, options);
  const ref = refDate ? new Date(refDate) : new Date();
  const today = startOfDay(ref);
  const t = ` ${String(text).toLowerCase().replace(/\s+/g, ' ')} `;

  const clock = findClockWindow(t);
  const textNoClock = clock ? t.replace(clock.matched, ' ') : t;

  const base = resolveDatePart(textNoClock, ref, today, opts);

  if (clock) {
    if (base) {
      if (base.days > 1) {
        // "between 1pm and 5pm last week" spans many days — the clock window is
        // not expressible as one contiguous range; treat as a daily range and
        // let the caller flag the dropped detail.
        return Object.assign({}, base, { droppedClock: clock.matched });
      }
      return applyClockWindow(base.start, clock);
    }
    return { needsDate: true, clock, matched: clock.matched };
  }

  return base;
}

function resolveDatePart(t, ref, today, opts) {
  let m;

  // --- explicit two-ended ranges -------------------------------------------
  // The (?!\d) guards stop "August 2026" being read as day 20 of year '26.
  const DATEISH = `(?:\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}`
    + `|\\d{1,2}[-/.]\\d{1,2}(?:[-/.]\\d{2,4})?(?!\\d)`
    + `|\\d{1,2}${ORD}\\s*(?:${MONTH_RE})\\b(?:\\s+\\d{2,4}(?!\\d))?`
    + `|(?:${MONTH_RE})\\s+\\d{1,2}${ORD}(?!\\d)(?:\\s*,\\s*|\\s+)?(?:\\d{4}(?!\\d))?`
    + `|today|now|yesterday)`;

  m = t.match(new RegExp(`(?:from|between)\\s+(${DATEISH})\\s+(?:and|to|until|till|through|thru|-|–)\\s+(${DATEISH})`, 'i'));
  if (!m) m = t.match(new RegExp(`\\b(${DATEISH})\\s+(?:to|until|till|through|thru|–)\\s+(${DATEISH})`, 'i'));
  if (m) {
    const a = resolveEndpoint(m[1], ref, today, opts);
    const b = resolveEndpoint(m[2], ref, today, opts);
    if (a && b) {
      const [s, e] = a <= b ? [a, b] : [b, a];
      return makeRange(s, e, { matched: m[0].trim() });
    }
  }

  // --- since / from X (open ended) -----------------------------------------
  m = t.match(new RegExp(`\\b(?:since|from|starting)\\s+(${DATEISH})\\b`, 'i'));
  if (m) {
    const a = resolveEndpoint(m[1], ref, today, opts);
    if (a) return makeRange(a, today, { matched: m[0].trim(), label: `${humanDate(a)} to ${humanDate(today)}` });
  }

  // --- relative day words ---------------------------------------------------
  if (/\b(today|so far today)\b/.test(t)) return wholeDay(today, 'Today');
  if (/\byesterday\b/.test(t)) return wholeDay(addDays(today, -1), 'Yesterday');
  if (/\bday before yesterday\b/.test(t)) return wholeDay(addDays(today, -2));
  if (/\btomorrow\b/.test(t)) return wholeDay(addDays(today, 1), 'Tomorrow');

  // --- rolling windows: last / past N units ---------------------------------
  m = t.match(/\b(?:last|past|previous|preceding|prior)\s+(\d{1,4})\s*(day|days|week|weeks|month|months|year|years|hour|hours)\b/);
  if (!m) {
    const words = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
    const wm = t.match(new RegExp(`\\b(?:last|past|previous)\\s+(${Object.keys(words).join('|')})\\s*(day|days|week|weeks|month|months|year|years)\\b`));
    if (wm) m = [wm[0], String(words[wm[1]]), wm[2]];
  }
  if (m) {
    const n = +m[1];
    const unit = m[2].replace(/s$/, '');
    if (n > 0) {
      if (unit === 'hour') {
        const end = new Date(ref);
        const start = new Date(end.getTime() - n * 3600000);
        return makeRange(start, new Date(end.getTime() - 1), {
          grain: 'hour', endExclusive: end, label: `Last ${n} hour${n === 1 ? '' : 's'}`, matched: m[0].trim(),
        });
      }
      let start;
      if (unit === 'day') start = addDays(today, -(n - 1));
      else if (unit === 'week') start = addDays(today, -(n * 7 - 1));
      else if (unit === 'month') start = addDays(addMonths(today, -n), 1);
      else start = addDays(addMonths(today, -n * 12), 1);
      return makeRange(start, today, {
        label: `Last ${n} ${unit}${n === 1 ? '' : 's'} (${humanDate(start)} to ${humanDate(today)})`,
        matched: m[0].trim(),
      });
    }
  }

  // --- calendar periods -----------------------------------------------------
  if (/\bthis week\b|\bcurrent week\b/.test(t)) {
    const s = startOfWeek(today, opts.weekStartsOn);
    return makeRange(s, today, { label: 'This week so far', matched: 'this week' });
  }
  if (/\b(last|previous|prior) week\b/.test(t)) {
    const s = addDays(startOfWeek(today, opts.weekStartsOn), -7);
    return makeRange(s, addDays(s, 6), { label: 'Last week', matched: 'last week' });
  }
  if (/\bthis month\b|\bcurrent month\b|\bmonth to date\b|\bmtd\b/.test(t)) {
    const s = utc(today.getUTCFullYear(), today.getUTCMonth() + 1, 1);
    return makeRange(s, today, { label: `${MONTH_NAMES[today.getUTCMonth()]} ${today.getUTCFullYear()} to date`, matched: 'this month' });
  }
  if (/\b(last|previous|prior) month\b/.test(t)) {
    const p = addMonths(utc(today.getUTCFullYear(), today.getUTCMonth() + 1, 1), -1);
    return Object.assign(wholeMonth(p.getUTCFullYear(), p.getUTCMonth() + 1), { matched: 'last month' });
  }
  if (/\bthis year\b|\bcurrent year\b|\byear to date\b|\bytd\b/.test(t)) {
    const s = utc(today.getUTCFullYear(), 1, 1);
    return makeRange(s, today, { label: `${today.getUTCFullYear()} to date`, matched: 'year to date' });
  }
  if (/\b(last|previous|prior) year\b/.test(t)) {
    const y = today.getUTCFullYear() - 1;
    return makeRange(utc(y, 1, 1), utc(y, 12, 31), { label: String(y), matched: 'last year' });
  }
  if (/\bthis quarter\b/.test(t)) {
    const q = Math.floor(today.getUTCMonth() / 3);
    const s = utc(today.getUTCFullYear(), q * 3 + 1, 1);
    return makeRange(s, today, { label: `Q${q + 1} ${today.getUTCFullYear()} to date`, matched: 'this quarter' });
  }
  if (/\b(last|previous|prior) quarter\b/.test(t)) {
    const q = Math.floor(today.getUTCMonth() / 3) - 1;
    const y = q < 0 ? today.getUTCFullYear() - 1 : today.getUTCFullYear();
    const qq = (q + 4) % 4;
    return quarterRange(y, qq + 1);
  }
  m = t.match(/\bq([1-4])\s*(?:of\s*)?(\d{4})?\b/);
  if (m) return quarterRange(m[2] ? +m[2] : today.getUTCFullYear(), +m[1]);

  // --- single explicit date -------------------------------------------------
  // Must be tried before the bare-year and month-name branches, otherwise
  // "on 15 August 2026" collapses to the whole of August and "15/08/2026"
  // collapses to the whole of 2026.
  m = t.match(new RegExp(`\\b(?:on|for|at|dated)?\\s*(${DATEISH})\\b`, 'i'));
  if (m) {
    const d = resolveEndpoint(m[1], ref, today, opts);
    if (d) return Object.assign(wholeDay(d), { matched: m[1].trim() });
    // The text clearly named a specific day and that day does not exist
    // (31 February). Falling through would silently widen the question to the
    // whole month, so fail instead and let the caller ask.
    if (/\d/.test(m[1])) return null;
  }

  // --- bare year ------------------------------------------------------------
  m = t.match(/\b(?:in|for|during)\s+(20\d{2})\b/) || t.match(/\b(20\d{2})\b(?!\s*[-/.])/);
  if (m && !new RegExp(`[-/.]\\s*${m[1]}`).test(t) && !new RegExp(`${m[1]}\\s*[-/.]`).test(t)) {
    const bareYearOnly = !new RegExp(`(?:${MONTH_RE})\\s+${m[1]}`).test(t) && !new RegExp(`\\d{1,2}\\s*(?:${MONTH_RE})[ ,]*${m[1]}`).test(t);
    if (bareYearOnly) {
      const y = +m[1];
      const end = y === today.getUTCFullYear() ? today : utc(y, 12, 31);
      return makeRange(utc(y, 1, 1), end, { label: String(y), matched: m[1] });
    }
  }

  // --- whole month by name --------------------------------------------------
  m = t.match(new RegExp(`\\b(?:in|for|during|of)?\\s*(${MONTH_RE})\\b(?!\\s*\\d{1,2}(?:${ORD})?\\b)\\s*(\\d{4})?`, 'i'));
  if (m) {
    const mon = MONTHS[m[1]];
    let y = m[2] ? +m[2] : today.getUTCFullYear();
    if (!m[2] && utc(y, mon, 1) > today) y -= 1;
    return Object.assign(wholeMonth(y, mon), { matched: m[0].trim() });
  }

  return null;
}

function quarterRange(y, q) {
  const startM = (q - 1) * 3 + 1;
  const endM = startM + 2;
  return makeRange(utc(y, startM, 1), utc(y, endM, daysInMonth(y, endM)), {
    label: `Q${q} ${y}`, matched: `q${q} ${y}`,
  });
}

function resolveEndpoint(text, ref, today, opts) {
  const s = text.trim().toLowerCase();
  if (s === 'today' || s === 'now') return today;
  if (s === 'yesterday') return addDays(today, -1);
  const parts = parseSingleDate(s, opts);
  return parts ? anchorDate(parts, ref) : null;
}

module.exports = {
  resolveTimeRange,
  parseSingleDate,
  anchorDate,
  parseClock,
  findClockWindow,
  makeRange,
  wholeDay,
  wholeMonth,
  quarterRange,
  humanDate,
  ymd,
  startOfDay,
  addDays,
  addMonths,
  MONTH_NAMES,
  DEFAULTS,
};
