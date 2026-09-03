'use strict';

const { METRICS_BY_KEY, METRIC_GROUPS } = require('./config');
const { normalizeTerm, foldTokens } = require('./normalize');

/**
 * Learned vocabulary.
 *
 * Learning changes what words Captain recognises. It never changes, adds to,
 * or overrides a value read from your operational tables. The only table
 * touched here is captain_term_mappings, and the database role Captain uses
 * has INSERT/UPDATE granted on that table and nothing else.
 */

const TABLE = 'captain_term_mappings';

async function loadMappings(db, orgId) {
  const { rows } = await db.query(
    `SELECT term, metric_key, hit_count
       FROM ${TABLE}
      WHERE org_id = $1 AND active
      ORDER BY hit_count DESC
      LIMIT 2000`,
    [orgId]
  );
  return rows;
}

/**
 * Save a mapping. Rejects anything that does not point at a registered
 * metric, and refuses to shadow a term that already resolves elsewhere in
 * the config — silently redefining "consumption" would make every past
 * answer inconsistent with every future one.
 */
async function saveMapping(db, { orgId, term, metricKey, userId }) {
  if (!METRICS_BY_KEY[metricKey]) {
    return { ok: false, reason: 'unknown_metric' };
  }
  const normalized = foldTokens(normalizeTerm(term));
  if (!normalized || normalized.length > 60) {
    return { ok: false, reason: 'bad_term' };
  }

  // Resolving a built-in ambiguity ("consumption means fuel consumption") is
  // allowed and is the point of the feature. Pointing an ambiguous term at a
  // metric outside its own group is not — that would quietly redefine a word
  // every other answer already depends on.
  const group = METRIC_GROUPS.find((g) => foldTokens(normalizeTerm(g.term)) === normalized);
  if (group && !group.metrics.includes(metricKey)) {
    return { ok: false, reason: 'outside_group', collidesWith: group.metrics.map((k) => METRICS_BY_KEY[k].label).join(', ') };
  }

  const collision = Object.values(METRICS_BY_KEY).find(
    (m) => m.key !== metricKey
      && [m.label, ...(m.aliases || [])].some((a) => foldTokens(normalizeTerm(a)) === normalized)
  );
  if (collision) {
    return { ok: false, reason: 'collides_with_config', collidesWith: collision.label };
  }

  await db.query(
    `INSERT INTO ${TABLE} (org_id, term, term_normalized, metric_key, created_by, active)
     VALUES ($1, $2, $3, $4, $5, TRUE)
     ON CONFLICT (org_id, term_normalized)
     DO UPDATE SET metric_key = EXCLUDED.metric_key,
                   active     = TRUE,
                   updated_at = now()`,
    [orgId, term, normalized, metricKey, userId || null]
  );
  return { ok: true, term, metricKey };
}

async function forgetMapping(db, { orgId, term }) {
  const normalized = foldTokens(normalizeTerm(term));
  const { rowCount } = await db.query(
    `UPDATE ${TABLE} SET active = FALSE, updated_at = now()
      WHERE org_id = $1 AND term_normalized = $2 AND active`,
    [orgId, normalized]
  );
  return { ok: rowCount > 0 };
}

async function noteUsage(db, { orgId, terms }) {
  if (!terms || !terms.length) return;
  await db.query(
    `UPDATE ${TABLE} SET hit_count = hit_count + 1, last_used_at = now()
      WHERE org_id = $1 AND term_normalized = ANY($2)`,
    [orgId, terms.map((t) => foldTokens(normalizeTerm(t)))]
  );
}

module.exports = { loadMappings, saveMapping, forgetMapping, noteUsage, TABLE };
