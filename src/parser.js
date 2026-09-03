'use strict';

const {
  METRICS, METRICS_BY_KEY, METRIC_GROUPS, SOURCES, LIMITS,
  allowedAggregations, sourceSupports, finerMetricFor,
} = require('./config');
const { normalizeTerm, foldTokens, buildAliasIndex, findAliasMatches } = require('./normalize');
const dates = require('./dates');

/**
 * Turns a user's sentence into a query plan, a clarification request, or an
 * honest failure. It never returns a number and never touches the database.
 *
 * Every outcome is one of:
 *   { status: 'plan',    plan }
 *   { status: 'clarify', question, options, pending }
 *   { status: 'teach',   term, metricKey, question }
 *   { status: 'unsupported', message, reason }
 *   { status: 'unparsed',    message, missing }
 */

// --- aggregation vocabulary -------------------------------------------------

const AGG_PATTERNS = [
  { agg: 'summary', re: /\b(analyse|analyze|analysing|analyzing|analysis|analytics|summary|summarise|summarize|overview|breakdown|report on|tell me about|how (?:is|was) .* (?:doing|performing)|performance)\b/ },
  { agg: 'compare', re: /\b(compare|comparison|versus|vs\b|difference between|change from|change between|percentage change|percent change|pct change|delta between)\b/ },
  { agg: 'trend', re: /\b(trend|over time|day by day|daily breakdown|month by month|monthly breakdown|week by week|weekly breakdown|per day|per month|per week|each day|each month|each week|chart|graph|plot|history|progression)\b/ },
  { agg: 'sum', re: /\b(total|sum|altogether|combined|cumulative|aggregate|in total|overall total)\b/ },
  { agg: 'avg', re: /\b(average|avg|mean|typical|on average)\b/ },
  { agg: 'max', re: /\b(max|maximum|highest|peak|largest|greatest|worst|best|top)\b/ },
  { agg: 'min', re: /\b(min|minimum|lowest|smallest|least)\b/ },
  { agg: 'count', re: /\b(how many (?:reports|records|entries|rows|days)|number of (?:reports|records|entries|rows|days)|record count|report count)\b/ },
  { agg: 'value', re: /\b(list|show me the values|raw|each record|all records|readings)\b/ },
];

/** Group-by granularity requested inside a trend. */
const GROUP_PATTERNS = [
  { group: 'hour', re: /\b(hourly|per hour|each hour|by hour|hour by hour)\b/ },
  { group: 'day', re: /\b(daily|per day|each day|by day|day by day)\b/ },
  { group: 'week', re: /\b(weekly|per week|each week|by week|week by week)\b/ },
  { group: 'month', re: /\b(monthly|per month|each month|by month|month by month)\b/ },
  { group: 'year', re: /\b(yearly|annually|per year|each year|by year)\b/ },
];

const TEACH_PATTERNS = [
  /^\s*["“']?([^"”'=]{1,40}?)["”']?\s*(?:means|stands for|is short for|refers to|is the same as|=)\s*["“']?([^"”'?.]{2,60}?)["”']?\s*[?.!]?\s*$/i,
  /^\s*(?:when i say|by)\s+["“']?([^"”']{1,40}?)["”']?\s*(?:,)?\s*i mean\s+["“']?([^"”'?.]{2,60}?)["”']?\s*[?.!]?\s*$/i,
];

const HELP_RE = /^\s*(help|what can you do|what do you know|commands|capabilities|list metrics|what metrics|which metrics|\?)\s*[?.!]*\s*$/i;

// --- alias index ------------------------------------------------------------

/**
 * Build the metric alias index. Learned mappings are merged in on top of the
 * config aliases, so user vocabulary extends the index without ever changing
 * what the underlying column contains.
 */
/**
 * Build the metric alias index.
 *
 * Three layers, in order of increasing authority:
 *   1. config aliases      — one term, one metric
 *   2. config groups       — one term, several metrics, so Captain asks
 *   3. learned mappings    — an organisation's own vocabulary, which REPLACES
 *                            layers 1 and 2 for that exact term
 *
 * The replacement in layer 3 is what makes teaching useful. If an org tells
 * Captain that "consumption" means fuel consumption, the built-in ambiguity
 * for that word is resolved for them and they stop being asked. It still only
 * changes which column is read — never what the column contains.
 */
function buildMetricIndex(learnedMappings = []) {
  const learnedTerms = new Set(
    learnedMappings
      .filter((lm) => METRICS_BY_KEY[lm.metric_key])
      .map((lm) => foldTokens(normalizeTerm(lm.term)))
  );

  const entries = [];
  const add = (term, value, source) => {
    if (learnedTerms.has(foldTokens(normalizeTerm(term)))) return;
    entries.push({ term, value, source });
  };

  for (const m of METRICS) {
    add(m.label, m.key, 'config');
    for (const a of m.aliases || []) add(a, m.key, 'config');
  }
  for (const g of METRIC_GROUPS) {
    for (const k of g.metrics) add(g.term, k, 'group');
  }
  for (const lm of learnedMappings) {
    if (METRICS_BY_KEY[lm.metric_key]) {
      entries.push({ term: lm.term, value: lm.metric_key, source: 'learned' });
    }
  }
  return buildAliasIndex(entries);
}

// --- helpers ----------------------------------------------------------------

function detectAggregation(text) {
  for (const p of AGG_PATTERNS) if (p.re.test(text)) return p.agg;
  return null;
}

function detectGroup(text) {
  for (const p of GROUP_PATTERNS) if (p.re.test(text)) return p.group;
  return null;
}

function autoGroup(range) {
  if (range.grain === 'hour') return 'hour';
  if (range.days <= 62) return 'day';
  if (range.days <= 400) return 'week';
  return 'month';
}

/** Default aggregation when the user did not name one. Always disclosed. */
function defaultAggregation(metric, range) {
  if (range.days === 1 && range.grain === 'day') return 'value';
  if (metric.kind === 'quantity') return 'sum';
  if (metric.kind === 'counter') return 'delta';
  return 'avg';
}

function metricLabel(key) {
  const m = METRICS_BY_KEY[key];
  return m ? `${m.label} (${m.unit})` : key;
}

function detectVesselMention(text, vessels) {
  const norm = foldTokens(normalizeTerm(text));
  const hits = [];
  for (const v of vessels) {
    for (const name of [v.name, ...(v.altNames || [])]) {
      if (!name) continue;
      const n = foldTokens(normalizeTerm(name));
      if (n && n.length >= 3 && norm.includes(n)) {
        hits.push({ id: v.id, name: v.name, matched: name });
        break;
      }
    }
  }
  return hits;
}

// --- main -------------------------------------------------------------------

/**
 * @param {string} text        the user's message
 * @param {object} ctx
 *   ctx.now            reference date
 *   ctx.vessels        [{ id, name, altNames }] — ALREADY scoped to what this
 *                      user may see. The parser never learns of other vessels.
 *   ctx.learned        learned term mappings for this org
 *   ctx.pending        a clarification this message is answering
 *   ctx.dateOrder      'DMY' | 'MDY'
 *   ctx.defaultVesselId vessel the user is currently viewing, if any
 */
function parse(text, ctx = {}) {
  const raw = String(text || '').trim();
  const lower = ` ${raw.toLowerCase().replace(/\s+/g, ' ')} `;
  const now = ctx.now ? new Date(ctx.now) : new Date();
  const vessels = ctx.vessels || [];
  const index = buildMetricIndex(ctx.learned || []);

  if (!raw) return { status: 'unparsed', message: 'Ask about a vessel metric and a date, for example "shaft power yesterday".', missing: ['everything'] };

  if (HELP_RE.test(raw)) {
    return {
      status: 'help',
      metrics: METRICS.filter((m) => !m.finerVersionOf).map((m) => ({ key: m.key, label: m.label, unit: m.unit, aliases: m.aliases.slice(0, 4) })),
      vessels: vessels.map((v) => v.name),
    };
  }

  // --- teaching a term ------------------------------------------------------
  for (const re of TEACH_PATTERNS) {
    const m = raw.match(re);
    if (m) {
      const term = m[1].trim();
      const target = m[2].trim();
      const matches = findAliasMatches(target, index);
      if (matches.length === 1 && matches[0].values.length === 1) {
        const key = matches[0].values[0];
        if (foldTokens(normalizeTerm(term)) === foldTokens(normalizeTerm(target))) break;
        return {
          status: 'teach',
          term,
          metricKey: key,
          question: `Save "${term}" as another name for ${metricLabel(key)}?`,
          options: ['Yes, save it', 'No'],
        };
      }
      return {
        status: 'unsupported',
        reason: 'unknown_teach_target',
        message: `I do not have a metric called "${target}", so I cannot map "${term}" onto it. Ask me for the metric list to see what I can read.`,
      };
    }
  }

  // --- merge a pending clarification ---------------------------------------
  const pending = ctx.pending || null;
  let effectiveText = raw;
  if (pending && pending.originalText) {
    effectiveText = `${pending.originalText} ${raw}`;
  }
  const effLower = ` ${effectiveText.toLowerCase().replace(/\s+/g, ' ')} `;

  // --- metric ---------------------------------------------------------------
  let metricKey = pending && pending.metricKey ? pending.metricKey : null;
  if (!metricKey) {
    const matches = findAliasMatches(effectiveText, index);

    // "Analyse the data of my vessel for the last 6 months" names a period and
    // an intent but no measurement. That is a request for an overview of
    // everything recorded, not an unanswerable question.
    if (!matches.length && detectAggregation(effLower) === 'summary') {
      const overviewRange = dates.resolveTimeRange(effectiveText, now, { dateOrder: ctx.dateOrder });
      if (overviewRange && !overviewRange.needsDate && !overviewRange.droppedClock) {
        const ids = resolveVesselIds(effectiveText, effLower, vessels, pending, { raw: raw, defaultVesselId: ctx.defaultVesselId });
        if (ids.clarify) return ids.clarify;
        return {
          status: 'plan',
          plan: {
            intent: 'overview',
            metricKeys: METRICS.filter((m) => !m.finerVersionOf).map((m) => m.key),
            vesselIds: ids.vesselIds,
            range: overviewRange,
            aggregation: 'overview',
            originalText: raw,
          },
        };
      }
    }

    if (!matches.length) {
      return {
        status: 'unparsed',
        missing: ['metric'],
        message: 'I could not tell which measurement you mean.',
        suggestions: METRICS.filter((m) => !m.finerVersionOf).slice(0, 6).map((m) => m.label),
      };
    }
    const top = matches[0];
    const sameSpan = matches.filter((x) => x.words === top.words);
    const candidateKeys = Array.from(new Set(sameSpan.flatMap((x) => x.values)));

    if (candidateKeys.length > 1) {
      return {
        status: 'clarify',
        reason: 'ambiguous_metric',
        question: `Which measurement do you mean by "${top.matched}"?`,
        options: candidateKeys.map((k) => ({ value: k, label: metricLabel(k) })),
        pending: { originalText: raw, field: 'metricKey' },
      };
    }
    metricKey = candidateKeys[0];
    if (!top.exact) {
      // A fuzzy hit is confirmed, never silently accepted.
      return {
        status: 'clarify',
        reason: 'fuzzy_metric',
        question: `Did you mean ${metricLabel(metricKey)}?`,
        options: [{ value: metricKey, label: `Yes — ${metricLabel(metricKey)}` }, { value: '__no__', label: 'No' }],
        pending: { originalText: raw, field: 'metricKey' },
      };
    }
  }

  let metric = METRICS_BY_KEY[metricKey];
  if (!metric) {
    return { status: 'unparsed', missing: ['metric'], message: 'I could not tell which measurement you mean.' };
  }

  // --- vessel ---------------------------------------------------------------
  const resolvedVessels = resolveVesselIds(effectiveText, effLower, vessels, pending, { raw, metricKey, defaultVesselId: ctx.defaultVesselId });
  if (resolvedVessels.clarify) return resolvedVessels.clarify;
  const vesselIds = resolvedVessels.vesselIds;

  // --- comparison: two ranges ----------------------------------------------
  let aggregation = detectAggregation(effLower);

  if (aggregation === 'compare') {
    const pair = extractComparisonRanges(effectiveText, now, ctx.dateOrder);
    if (!pair) {
      return {
        status: 'clarify',
        reason: 'compare_needs_two_ranges',
        question: 'Which two periods should I compare?',
        options: [
          { value: 'this month vs last month', label: 'This month vs last month' },
          { value: 'last month vs the month before', label: 'Last month vs the month before' },
          { value: 'this year vs last year', label: 'This year vs last year' },
        ],
        pending: { originalText: raw, field: 'compareRanges', metricKey, vesselIds },
      };
    }
    const guard = guardRanges([pair.a, pair.b], metric);
    if (guard) return guard;
    return {
      status: 'plan',
      plan: {
        intent: 'compare',
        metricKey: metric.key,
        vesselIds,
        ranges: [pair.a, pair.b],
        aggregation: metric.kind === 'quantity' ? 'sum' : 'avg',
        aggregationWasAssumed: true,
        originalText: raw,
      },
    };
  }

  // --- time range -----------------------------------------------------------
  let range = pending && pending.range ? pending.range : null;
  if (!range) {
    const resolved = dates.resolveTimeRange(effectiveText, now, { dateOrder: ctx.dateOrder });
    if (resolved && resolved.needsDate) {
      return {
        status: 'clarify',
        reason: 'clock_without_date',
        question: `Which date do you mean for ${resolved.clock.matched.trim()}?`,
        options: [
          { value: 'today', label: 'Today' },
          { value: 'yesterday', label: 'Yesterday' },
        ],
        pending: { originalText: raw, field: 'range', metricKey, vesselIds },
      };
    }
    if (!resolved) {
      return {
        status: 'clarify',
        reason: 'missing_range',
        question: `Over what period do you want ${metric.label}?`,
        options: [
          { value: 'today', label: 'Today' },
          { value: 'yesterday', label: 'Yesterday' },
          { value: 'last 7 days', label: 'Last 7 days' },
          { value: 'last month', label: 'Last month' },
        ],
        pending: { originalText: raw, field: 'range', metricKey, vesselIds },
      };
    }
    range = resolved;
  }

  // --- resolution check: does a source exist at the requested grain? --------
  if (range.grain === 'hour') {
    const finer = finerMetricFor(metric.key, 'hourly');
    if (!finer) {
      return {
        status: 'unsupported',
        reason: 'granularity',
        message: `${metric.label} is only recorded once per day (${SOURCES[metric.source].description}), so I cannot break it down by hour. Ask me for a whole day instead.`,
      };
    }
    metric = finer;
  }
  if (range.droppedClock) {
    return {
      status: 'unsupported',
      reason: 'clock_over_multiple_days',
      message: `I cannot apply the time window "${range.droppedClock.trim()}" across a multi-day period. Ask for a single date, or drop the time window.`,
    };
  }

  const guard = guardRanges([range], metric);
  if (guard) return guard;

  // --- aggregation ----------------------------------------------------------
  let assumed = false;
  if (metric.countOnly) { aggregation = 'count'; }
  if (!aggregation) {
    aggregation = defaultAggregation(metric, range);
    assumed = true;
  }
  if (aggregation === 'value' && range.days > 1 && !/\b(list|show|raw|each|all records|readings)\b/.test(effLower)) {
    aggregation = defaultAggregation(metric, range);
    assumed = true;
  }

  const allowed = allowedAggregations(metric);
  if (!allowed.includes(aggregation)) {
    const alt = metric.kind === 'rate' ? 'average' : 'total';
    return {
      status: 'unsupported',
      reason: 'aggregation_not_meaningful',
      message: `Adding up ${metric.label.toLowerCase()} across reports does not produce a meaningful number — it is ${metric.kind === 'rate' ? 'an instantaneous reading' : 'a meter value'}, not an amount that accumulates. I can give you the ${alt}, minimum or maximum instead.`,
      options: [
        { value: `average ${metric.label} ${range.matched || ''}`.trim(), label: `Average ${metric.label.toLowerCase()}` },
        { value: `max ${metric.label} ${range.matched || ''}`.trim(), label: `Highest ${metric.label.toLowerCase()}` },
      ],
    };
  }

  const group = aggregation === 'trend' || aggregation === 'summary'
    ? (detectGroup(effLower) || autoGroup(range))
    : null;

  return {
    status: 'plan',
    plan: {
      intent: aggregation,
      metricKey: metric.key,
      vesselIds,
      range,
      aggregation,
      aggregationWasAssumed: assumed,
      group,
      originalText: raw,
    },
  };
}

/**
 * Decide which vessels a question is about, using only vessels already inside
 * the caller's scope. Returns { vesselIds } or { clarify }.
 */
function resolveVesselIds(text, lower, vessels, pending, extra = {}) {
  let vesselIds = pending && pending.vesselIds ? pending.vesselIds : null;

  if (!vesselIds) {
    const mentioned = detectVesselMention(text, vessels);
    const fleetWide = /\b(fleet|all vessels|all ships|every vessel|whole fleet|across the fleet)\b/.test(lower);

    if (mentioned.length === 1) {
      vesselIds = [mentioned[0].id];
    } else if (mentioned.length === 0 && extra.defaultVesselId
               && vessels.some(function (v) { return String(v.id) === String(extra.defaultVesselId); })
               && !fleetWide) {
      // The user is looking at a vessel's page and didn't name another one:
      // that vessel is what "my vessel" / an unqualified question means. Only
      // an in-scope id can get here — the check above drops anything else.
      vesselIds = [extra.defaultVesselId];
    } else if (mentioned.length > 1) {
      return {
        clarify: {
          status: 'clarify',
          reason: 'ambiguous_vessel',
          question: 'Which vessel?',
          options: mentioned.map((v) => ({ value: v.id, label: v.name })),
          pending: { originalText: extra.raw, field: 'vesselIds', metricKey: extra.metricKey },
        },
      };
    } else if (fleetWide) {
      vesselIds = vessels.map((v) => v.id);
    } else if (vessels.length === 1) {
      vesselIds = [vessels[0].id];
    } else if (vessels.length === 0) {
      return {
        clarify: {
          status: 'unsupported',
          reason: 'no_vessels',
          message: 'Your account is not linked to any vessel, so there is nothing for me to read.',
        },
      };
    } else {
      return {
        clarify: {
          status: 'clarify',
          reason: 'missing_vessel',
          question: 'Which vessel?',
          options: vessels.slice(0, 25).map((v) => ({ value: v.id, label: v.name }))
            .concat(vessels.length <= 25 ? [{ value: '__all__', label: 'All my vessels' }] : []),
          pending: { originalText: extra.raw, field: 'vesselIds', metricKey: extra.metricKey },
        },
      };
    }
  }

  if (vesselIds.includes('__all__')) vesselIds = vessels.map((v) => v.id);
  return { vesselIds };
}

function guardRanges(ranges, metric) {
  for (const r of ranges) {
    if (r.days > LIMITS.maxRangeDays) {
      return {
        status: 'unsupported',
        reason: 'range_too_wide',
        message: `That period covers ${r.days} days, which is wider than I will query in one go (${LIMITS.maxRangeDays} days). Narrow it down and I will run it.`,
      };
    }
  }
  return null;
}

/**
 * Pull two comparable ranges out of a comparison question.
 * Handles "X vs Y" explicitly, and the shorthand "compare last month" by
 * pairing the named period with the one immediately before it.
 */
function extractComparisonRanges(text, now, dateOrder) {
  const opts = { dateOrder };
  const split = text.split(/\b(?:versus|vs\.?|compared to|compared with|against)\b|\bto\b(?=\s+(?:last|this|the))/i);
  if (split.length >= 2) {
    const a = dates.resolveTimeRange(split[0], now, opts);
    const b = dates.resolveTimeRange(split[1], now, opts);
    if (a && b && !a.needsDate && !b.needsDate) return { a, b };
  }

  const m = text.match(/\bbetween\s+(.+?)\s+and\s+(.+?)\s*[?.!]?$/i);
  if (m) {
    const a = dates.resolveTimeRange(m[1], now, opts);
    const b = dates.resolveTimeRange(m[2], now, opts);
    if (a && b && !a.needsDate && !b.needsDate && a.days === 1 && b.days === 1) return { a, b };
  }

  const one = dates.resolveTimeRange(text, now, opts);
  if (one && !one.needsDate) {
    const prior = priorPeriod(one);
    if (prior) return { a: prior, b: one };
  }
  return null;
}

/** The equally sized period immediately before the given one. */
function priorPeriod(range) {
  const spanDays = range.days;
  const end = dates.addDays(range.start, -1);
  const start = dates.addDays(end, -(spanDays - 1));
  return dates.makeRange(start, end, { label: `${dates.humanDate(start)} to ${dates.humanDate(end)}` });
}

module.exports = { parse, buildMetricIndex, detectAggregation, defaultAggregation, priorPeriod, extractComparisonRanges };
