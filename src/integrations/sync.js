'use strict';

const { vesonClient, geoformClient } = require('./clients');
const { resolveMapping, mapRecord, deriveFuelTotal, loadOverrides } = require('./mapping');

/**
 * Pull upstream data into Postgres.
 *
 * Captain answers questions from these tables and never calls Veson or
 * Geoform during a conversation. That is deliberate: report APIs are slow,
 * return whole reports rather than one figure, and would put a third party
 * between a user and a yes/no about their own vessel. Sync hourly; answer
 * from the copy.
 *
 * Idempotent: every table has a natural key and every write is an upsert, so
 * re-running is safe and a partial failure leaves earlier data intact.
 */

const ymd = (d) => d.toISOString().slice(0, 10);

async function sync({ db, env = process.env, fetchImpl, log = () => {}, now = new Date() } = {}) {
  if (!db) throw new Error('sync needs a db client bound to the writer role');
  const overrides = loadOverrides(env);
  const stats = { started: now.toISOString(), legs: 0, offhire: 0, geoform: 0, vessels: 0, warnings: [], mappings: {} };
  const veson = vesonClient(env, fetchImpl);
  const geoform = geoformClient(env, fetchImpl);
  const imos = new Map(); // imo -> vessel_name

  // --- Veson leg-wise -----------------------------------------------------
  {
    const { rows, url } = await veson.legWise();
    log(`Veson leg-wise: ${rows.length} rows from ${url}`);
    if (rows.length) {
      const res = resolveMapping('veson_legs', rows[0], overrides.veson_legs || {});
      stats.mappings.veson_legs = res;
      warnMissing(stats, 'veson_legs', res, ['imo', 'dep_time', 'arr_time']);
      for (const r of rows) {
        const row = mapRecord('veson_legs', r, res);
        if (row.fuel_mt == null) {
          const derived = deriveFuelTotal(r);
          if (derived) { row.fuel_mt = derived.value; row.fuel_derived = true; }
        }
        if (!row.imo || !row.dep_time || !row.arr_time) continue;
        if (row.vessel_name) imos.set(row.imo, row.vessel_name); else if (!imos.has(row.imo)) imos.set(row.imo, null);
        await upsertLeg(db, row);
        stats.legs++;
      }
    }
  }

  // --- Veson off-hire -----------------------------------------------------
  {
    const { rows, url } = await veson.offHire();
    log(`Veson off-hire: ${rows.length} rows from ${url}`);
    if (rows.length) {
      const res = resolveMapping('veson_offhire', rows[0], overrides.veson_offhire || {});
      stats.mappings.veson_offhire = res;
      warnMissing(stats, 'veson_offhire', res, ['imo', 'start_time']);
      for (const r of rows) {
        const row = mapRecord('veson_offhire', r, res);
        if (!row.imo || !row.start_time) continue;
        if (row.offhire_hours == null && row.start_time && row.end_time) {
          row.offhire_hours = (row.end_time - row.start_time) / 3600000;
        }
        if (row.offhire_days == null && row.offhire_hours != null) row.offhire_days = row.offhire_hours / 24;
        if (row.vessel_name) imos.set(row.imo, row.vessel_name); else if (!imos.has(row.imo)) imos.set(row.imo, null);
        await upsertOffhire(db, row);
        stats.offhire++;
      }
    }
  }

  // --- Geoform, per IMO, over a rolling window in 30-day pages -------------
  {
    const days = Math.max(1, parseInt(env.CAPTAIN_SYNC_DAYS || '120', 10));
    const explicit = (env.CAPTAIN_IMOS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const targets = explicit.length ? explicit : Array.from(imos.keys());
    if (!targets.length) stats.warnings.push('Geoform: no IMOs to pull — set CAPTAIN_IMOS or ensure Veson data contains IMO numbers');

    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const start = new Date(end.getTime() - days * 86400000);
    let mappingDone = false;

    for (const imo of targets) {
      for (let a = new Date(start); a < end; a = new Date(a.getTime() + 30 * 86400000)) {
        const b = new Date(Math.min(a.getTime() + 29 * 86400000, end.getTime()));
        let rows;
        try {
          ({ rows } = await geoform.forms(imo, ymd(a), ymd(b)));
        } catch (e) {
          stats.warnings.push(`Geoform ${imo} ${ymd(a)}..${ymd(b)}: ${e.message}`);
          continue;
        }
        if (!rows.length) continue;
        const res = resolveMapping('geoform_reports', rows[0], overrides.geoform_reports || {});
        if (!mappingDone) { stats.mappings.geoform_reports = res; warnMissing(stats, 'geoform_reports', res, ['report_time']); mappingDone = true; }
        for (const r of rows) {
          const row = mapRecord('geoform_reports', r, res);
          if (!row.imo) row.imo = imo;
          if (!row.report_time) continue;
          if (!row.form_type) row.form_type = 'form';
          if (row.vessel_name) imos.set(row.imo, row.vessel_name); else if (!imos.has(row.imo)) imos.set(row.imo, null);
          await upsertGeoform(db, row);
          stats.geoform++;
        }
      }
      log(`Geoform ${imo}: done`);
    }
  }

  // --- vessels ---------------------------------------------------------------
  for (const [imo, name] of imos) {
    await db.query(
      `INSERT INTO vessels (id, imo, name, department)
       VALUES ($1, $1, COALESCE($2, $1), 'Unassigned')
       ON CONFLICT (id) DO UPDATE SET name = COALESCE(EXCLUDED.name, vessels.name)`,
      [imo, name]
    );
    stats.vessels++;
  }

  stats.finished = new Date().toISOString();
  await db.query(
    `INSERT INTO captain_sync_log (started_at, finished_at, legs, offhire, geoform, vessels, warnings)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [stats.started, stats.finished, stats.legs, stats.offhire, stats.geoform, stats.vessels, JSON.stringify(stats.warnings)]
  ).catch((e) => stats.warnings.push('sync log: ' + e.message));

  return stats;
}

function warnMissing(stats, schema, res, required) {
  for (const col of required) {
    if (res.unmatchedTargets.includes(col)) {
      stats.warnings.push(`${schema}: required column "${col}" matched no upstream field. Run npm run discover and set CAPTAIN_FIELD_MAP.`);
    }
  }
  if (res.unmatchedTargets.length) {
    stats.warnings.push(`${schema}: no upstream field for ${res.unmatchedTargets.join(', ')} — those metrics will be empty`);
  }
}

// --- upserts --------------------------------------------------------------------

async function upsertLeg(db, r) {
  await db.query(
    `INSERT INTO veson_legs (imo, vessel_name, voyage_no, leg_no, dep_port, arr_port, dep_time, arr_time, leg_date,
                             distance_nm, fuel_mt, fuel_derived, co2_mt, ghg_intensity, eu_scope_pct, compliance_balance, raw, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,($8::timestamptz)::date,$9,$10,$11,$12,$13,$14,$15,$16, now())
     ON CONFLICT (imo, dep_time, arr_time, leg_no) DO UPDATE SET
       vessel_name=EXCLUDED.vessel_name, voyage_no=EXCLUDED.voyage_no, dep_port=EXCLUDED.dep_port, arr_port=EXCLUDED.arr_port,
       leg_date=EXCLUDED.leg_date, distance_nm=EXCLUDED.distance_nm, fuel_mt=EXCLUDED.fuel_mt, fuel_derived=EXCLUDED.fuel_derived,
       co2_mt=EXCLUDED.co2_mt, ghg_intensity=EXCLUDED.ghg_intensity, eu_scope_pct=EXCLUDED.eu_scope_pct,
       compliance_balance=EXCLUDED.compliance_balance, raw=EXCLUDED.raw, synced_at=now()`,
    [r.imo, r.vessel_name, r.voyage_no, r.leg_no || '', r.dep_port, r.arr_port, r.dep_time, r.arr_time,
     r.distance_nm, r.fuel_mt, !!r.fuel_derived, r.co2_mt, r.ghg_intensity, r.eu_scope_pct, r.compliance_balance, JSON.stringify(r.raw)]
  );
}

async function upsertOffhire(db, r) {
  await db.query(
    `INSERT INTO veson_offhire (imo, vessel_name, voyage_no, start_time, end_time, start_date, offhire_hours, offhire_days, reason, raw, synced_at)
     VALUES ($1,$2,$3,$4,$5,($4::timestamptz)::date,$6,$7,$8,$9, now())
     ON CONFLICT (imo, start_time) DO UPDATE SET
       vessel_name=EXCLUDED.vessel_name, voyage_no=EXCLUDED.voyage_no, end_time=EXCLUDED.end_time, start_date=EXCLUDED.start_date,
       offhire_hours=EXCLUDED.offhire_hours, offhire_days=EXCLUDED.offhire_days, reason=EXCLUDED.reason, raw=EXCLUDED.raw, synced_at=now()`,
    [r.imo, r.vessel_name, r.voyage_no, r.start_time, r.end_time, r.offhire_hours, r.offhire_days, r.reason, JSON.stringify(r.raw)]
  );
}

async function upsertGeoform(db, r) {
  await db.query(
    `INSERT INTO geoform_reports (imo, vessel_name, form_type, report_time, report_date, shaft_power_kw, fuel_consumed_mt, me_fuel_mt, ae_fuel_mt,
                                  distance_nm, speed_kn, me_rpm, co2_mt, raw, synced_at)
     VALUES ($1,$2,$3,$4,($4::timestamptz)::date,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
     ON CONFLICT (imo, report_time, form_type) DO UPDATE SET
       vessel_name=EXCLUDED.vessel_name, report_date=EXCLUDED.report_date, shaft_power_kw=EXCLUDED.shaft_power_kw,
       fuel_consumed_mt=EXCLUDED.fuel_consumed_mt, me_fuel_mt=EXCLUDED.me_fuel_mt, ae_fuel_mt=EXCLUDED.ae_fuel_mt,
       distance_nm=EXCLUDED.distance_nm, speed_kn=EXCLUDED.speed_kn, me_rpm=EXCLUDED.me_rpm, co2_mt=EXCLUDED.co2_mt,
       raw=EXCLUDED.raw, synced_at=now()`,
    [r.imo, r.vessel_name, r.form_type, r.report_time, r.shaft_power_kw, r.fuel_consumed_mt, r.me_fuel_mt, r.ae_fuel_mt,
     r.distance_nm, r.speed_kn, r.me_rpm, r.co2_mt, JSON.stringify(r.raw)]
  );
}

module.exports = { sync };
