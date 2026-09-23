'use strict';

const { LIMITS } = require('./config');

/**
 * Proactive findings — "anything I should know" — computed entirely by SQL
 * against the synced tables. No model touches this file. Each rule below is
 * a query plus a threshold; the number in the sentence is the number the
 * query returned, nothing is generated or phrased by a language model.
 *
 * Triggered by phrases like "anything I should know" or "briefing" (see
 * router.js), and always available on request even if the LLM is disabled.
 */

const TRIGGER_RE = /\b(briefing|any (?:alerts|issues|flags)|anything i should know|status update|what should i know|catch me up|daily brief)\b/i;

function isBriefingRequest(text) {
  return TRIGGER_RE.test(String(text || '').toLowerCase());
}

async function buildBriefing(vesselIds, vesselNames, db) {
  if (!vesselIds.length) return { text: 'You are not scoped to any vessel, so there is nothing to brief.', findings: [] };

  const findings = [];
  // Set when a rule's query fails (e.g. its source table is not present in the
  // database yet). We degrade to a partial briefing rather than failing the whole
  // request, and we never claim "all clear" on a check we could not actually run.
  let degraded = false;

  // 1) Compliance balance trend: latest leg vs the one before it, per vessel.
  try {
    const { rows } = await db.query(
      `SELECT imo, vessel_name, compliance_balance, leg_date,
              LAG(compliance_balance) OVER (PARTITION BY imo ORDER BY leg_date) AS prev_balance
         FROM veson_legs
        WHERE imo = ANY($1) AND compliance_balance IS NOT NULL
        ORDER BY imo, leg_date`,
      [vesselIds]
    );
    const latestByImo = new Map();
    for (const r of rows) latestByImo.set(r.imo, r); // last row per imo after ORDER BY
    for (const r of latestByImo.values()) {
      if (r.compliance_balance < 0) {
        findings.push({
          kind: 'compliance_deficit',
          severity: 'warning',
          vessel: r.vessel_name || r.imo,
          text: `${r.vessel_name || r.imo} has a FuelEU compliance deficit of ${fmt(Math.abs(r.compliance_balance))} gCO2e as of ${ymd(r.leg_date)}.`,
        });
      } else if (r.prev_balance != null && r.compliance_balance < r.prev_balance) {
        findings.push({
          kind: 'compliance_declining',
          severity: 'info',
          vessel: r.vessel_name || r.imo,
          text: `${r.vessel_name || r.imo}'s compliance balance moved down to ${fmt(r.compliance_balance)} gCO2e as of ${ymd(r.leg_date)}.`,
        });
      }
    }
  } catch (err) {
    degraded = true;
    console.error('kris briefing: compliance-balance rule skipped —', err && err.message);
  }

  // 2) Off-hire in the last 30 days above a threshold.
  try {
    const { rows } = await db.query(
      `SELECT imo, vessel_name, SUM(offhire_hours)::double precision AS hours, COUNT(*) AS events
         FROM veson_offhire
        WHERE imo = ANY($1) AND start_date >= (CURRENT_DATE - INTERVAL '30 days')
        GROUP BY imo, vessel_name
        HAVING SUM(offhire_hours) > 24`,
      [vesselIds]
    );
    for (const r of rows) {
      findings.push({
        kind: 'offhire_high',
        severity: 'info',
        vessel: r.vessel_name || r.imo,
        text: `${r.vessel_name || r.imo} logged ${fmt(r.hours)} off-hire hours over ${r.events} event${r.events === 1 ? '' : 's'} in the last 30 days.`,
      });
    }
  } catch (err) {
    degraded = true;
    console.error('kris briefing: off-hire rule skipped —', err && err.message);
  }

  // 3) Reporting gap: no Geoform report in the last 3 days for a vessel that
  //    has reported before (so a brand-new vessel doesn't trigger a false alarm).
  try {
    const { rows } = await db.query(
      `SELECT v.id AS imo, v.name,
              (SELECT MAX(report_date) FROM geoform_reports g WHERE g.imo = v.id) AS last_report
         FROM vessels v
        WHERE v.id = ANY($1)`,
      [vesselIds]
    );
    for (const r of rows) {
      if (!r.last_report) continue;
      const days = Math.floor((Date.now() - new Date(r.last_report).getTime()) / 86400000);
      if (days >= 3) {
        findings.push({
          kind: 'reporting_gap',
          severity: 'warning',
          vessel: r.name,
          text: `${r.name} has not filed a report in ${days} days (last: ${ymd(r.last_report)}).`,
        });
      }
    }
  } catch (err) {
    degraded = true;
    console.error('kris briefing: reporting-gap rule skipped —', err && err.message);
  }

  findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'warning' ? -1 : 1));

  if (!findings.length) {
    const text = degraded
      ? `Nothing actionable surfaced for ${vesselNames.join(', ')} from the checks I could run — I could not complete all of them just now, so treat this as partial.`
      : `Nothing flagged for ${vesselNames.join(', ')}. Reports are current and compliance balances are positive.`;
    return { text, findings: [], degraded };
  }
  const head = findings.length === 1 ? '1 thing worth a look:' : `${findings.length} things worth a look:`;
  const tail = degraded ? ['', '(Some checks could not run, so this may be incomplete.)'] : [];
  return { text: [head, ...findings.slice(0, 6).map((f) => '\u2022 ' + f.text), ...tail].join('\n'), findings, degraded };
}

function fmt(n) { return Number(n).toLocaleString('en-GB', { maximumFractionDigits: 1 }); }
function ymd(d) { return new Date(d).toISOString().slice(0, 10); }

module.exports = { isBriefingRequest, buildBriefing };