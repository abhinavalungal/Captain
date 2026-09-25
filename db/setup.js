#!/usr/bin/env node
'use strict';

/**
 * Set up, or check, the K.R.1.S database.
 *
 *   node db/setup.js               schema + roles + test data + checks
 *   node db/setup.js --no-seed     schema + roles + checks, no test data
 *   node db/setup.js --check       checks only; changes nothing
 *   node db/setup.js --print-seed > seed.sql
 *                                  the test data as SQL, for the Supabase SQL editor
 *   --env <file>                   env file to read and update (default .env)
 *
 * Needs DATABASE_URL: the Supabase `postgres` connection (Project → Connect).
 * It is used here only; the server never gets it. No password is ever
 * printed. On the first run the two server roles get random passwords and
 * KRIS_READ_URL / KRIS_WRITE_URL are written into the env file; later runs
 * keep the passwords already there.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA = path.join(__dirname, '001_schema.sql');
const TEST_IDS = ['1000019', '1000021'];

const TABLES = ['companies', 'ports', 'fuel_types', 'cii_ship_types', 'cii_reduction_factors', 'fueleu_targets', 'ets_years',
  'vessels', 'vessel_fuel_types', 'voyages', 'port_calls', 'geoform_reports', 'veson_legs', 'veson_offhire', 'kris_sync_log',
  'bunker_deliveries', 'fuel_consumption', 'cii_adjustments', 'fueleu_pools', 'fueleu_flexibility', 'compliance_filings',
  'allowance_surrenders', 'carbon_prices', 'carbon_trades', 'carbon_allocations', 'invoices', 'communications',
  'kris_term_mappings', 'kris_query_log', 'route_distances'];
const VIEWS = ['fuel_factors', 'vessel_particulars', 'fuel_emissions', 'port_call_log', 'bunker_log', 'voyage_summary', 'voyage_fuel',
  'annual_operations', 'cii_annual', 'fueleu_period', 'ets_obligations', 'carbon_exposure', 'vessel_carbon_trades',
  'invoice_status', 'compliance_overview', 'communication_log', 'report_log', 'vessel_positions', 'fuel_on_board'];

// ---------------------------------------------------------------------------
// Steps (exported for the test suite, which runs them on an in-memory Postgres)
// ---------------------------------------------------------------------------

// A multi-statement script: node-pg runs it through query(), PGlite through exec().
const script = (db, sql) => (typeof db.exec === 'function' ? db.exec(sql) : db.query(sql));

async function applySchema(db) {
  await script(db, fs.readFileSync(SCHEMA, 'utf8'));
}

async function seedTestData(db, until) {
  const { buildSql } = require('./test_data');
  await script(db, buildSql({ until: until || new Date() }));
}

/** Structural, security and consistency checks. Every check reads; none writes. */
async function verify(db) {
  const results = [];
  const check = async (name, fn) => {
    try { const [ok, detail] = await fn(); results.push({ name, ok: !!ok, detail }); }
    catch (e) { results.push({ name, ok: false, detail: String(e.message || e).slice(0, 200) }); }
  };
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const n = (v) => Number(v);

  await check('connection', async () => {
    const r = await one("SELECT current_user AS u, current_database() AS d, current_setting('server_version') AS v");
    return [true, `${r.u} on ${r.d}, Postgres ${r.v}`];
  });
  await check('tables', async () => {
    const have = (await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'kris' AND table_type = 'BASE TABLE'")).rows.map((r) => r.table_name);
    const missing = TABLES.filter((t) => !have.includes(t));
    return [!missing.length, `${have.length} tables in kris` + (missing.length ? `; missing ${missing.join(', ')}` : '')];
  });
  await check('views', async () => {
    const have = (await db.query("SELECT table_name FROM information_schema.views WHERE table_schema = 'kris'")).rows.map((r) => r.table_name);
    const missing = VIEWS.filter((t) => !have.includes(t));
    return [!missing.length, `${have.length} views` + (missing.length ? `; missing ${missing.join(', ')}` : '')];
  });
  await check('relationships, indexes, constraints', async () => {
    const r = await one(`SELECT count(*) FILTER (WHERE c.contype = 'f') AS fk, count(*) FILTER (WHERE c.contype = 'c') AS ck,
                                count(*) FILTER (WHERE c.contype = 'u') AS uq, count(*) FILTER (WHERE c.contype = 'p') AS pk,
                                (SELECT count(*) FROM pg_indexes WHERE schemaname = 'kris') AS ix
                           FROM pg_constraint c JOIN pg_namespace ns ON ns.oid = c.connamespace WHERE ns.nspname = 'kris'`);
    return [n(r.fk) >= 30 && n(r.pk) === TABLES.length, `${r.pk} primary keys, ${r.fk} foreign keys, ${r.uq} unique, ${r.ck} checks, ${r.ix} indexes`];
  });
  await check('row-level security on every table', async () => {
    const r = await one(`SELECT count(*) FILTER (WHERE NOT c.relrowsecurity) AS off, count(*) AS total
                           FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = 'kris' AND c.relkind = 'r'`);
    return [n(r.off) === 0, `${n(r.total) - n(r.off)} of ${r.total} tables`];
  });
  await check('not reachable with the publishable key', async () => {
    const rows = (await db.query(`SELECT rolname, has_schema_privilege(rolname, 'kris', 'USAGE') AS usage
                                    FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`)).rows;
    if (!rows.length) return [true, 'no Supabase API roles in this database'];
    const open = rows.filter((r) => r.usage).map((r) => r.rolname);
    return [!open.length, open.length ? `schema kris is usable by ${open.join(', ')}` : 'anon and authenticated have no access to schema kris'];
  });
  await check('server roles', async () => {
    const rows = (await db.query("SELECT rolname, rolcanlogin, array_to_string(rolconfig, ' ') AS cfg FROM pg_roles WHERE rolname IN ('kris_reader', 'kris_writer')")).rows;
    const reader = rows.find((r) => r.rolname === 'kris_reader');
    const ok = rows.length === 2 && reader && /default_transaction_read_only=on/.test(reader.cfg || '');
    return [ok, ok ? 'kris_reader (read-only sessions) and kris_writer exist' : 'kris_reader / kris_writer missing or reader not read-only'];
  });

  // --- test data ------------------------------------------------------------
  const test = await one('SELECT count(*) AS n FROM kris.vessels WHERE is_test');
  if (!n(test.n)) {
    results.push({ name: 'test data', ok: true, detail: 'not loaded (run without --no-seed to load it)' });
    return results;
  }
  await check('test data', async () => {
    const r = await one(`SELECT
        (SELECT count(*) FROM kris.vessels WHERE is_test) AS vessels,
        (SELECT count(*) FROM kris.voyages WHERE vessel_id = ANY($1)) AS voyages,
        (SELECT count(*) FROM kris.port_calls pc JOIN kris.voyages v ON v.id = pc.voyage_id WHERE v.vessel_id = ANY($1)) AS port_calls,
        (SELECT count(*) FROM kris.geoform_reports WHERE imo = ANY($1)) AS reports,
        (SELECT count(*) FROM kris.fuel_consumption f JOIN kris.geoform_reports r ON r.id = f.report_id WHERE r.imo = ANY($1)) AS fuel_rows,
        (SELECT count(*) FROM kris.bunker_deliveries WHERE vessel_id = ANY($1)) AS bdns,
        (SELECT count(*) FROM kris.compliance_filings WHERE vessel_id = ANY($1)) AS filings,
        (SELECT count(*) FROM kris.carbon_allocations WHERE vessel_id = ANY($1)) AS allocations,
        (SELECT count(*) FROM kris.invoices WHERE vessel_id = ANY($1)) AS invoices,
        (SELECT count(*) FROM kris.communications WHERE vessel_id = ANY($1)) AS emails`, [TEST_IDS]);
    const ok = n(r.vessels) === 2 && ['voyages', 'port_calls', 'reports', 'fuel_rows', 'bdns', 'filings', 'allocations', 'invoices', 'emails'].every((k) => n(r[k]) > 0);
    return [ok, Object.entries(r).map(([k, v]) => `${v} ${k.replace('_', ' ')}`).join(', ')];
  });

  const zero = (name, sql, what) => check(name, async () => {
    const r = await one(sql, [TEST_IDS]);
    return [n(r.bad) === 0, n(r.bad) === 0 ? what : `${r.bad} ${r.detail || 'rows'} disagree`];
  });
  await zero('report fuel = fuel ledger',
    `SELECT count(*) AS bad FROM kris.geoform_reports r
       LEFT JOIN (SELECT report_id, SUM(total_t) AS t FROM kris.fuel_consumption GROUP BY 1) f ON f.report_id = r.id
      WHERE r.imo = ANY($1) AND abs(r.fuel_consumed_mt - COALESCE(f.t, 0)) > 0.002`,
    'every report total equals its fuel-by-type rows');
  await zero('report CO2 = fuel x emission factor',
    `SELECT count(*) AS bad FROM kris.geoform_reports r
       LEFT JOIN (SELECT report_id, SUM(co2_t) AS t FROM kris.fuel_emissions GROUP BY 1) e ON e.report_id = r.id
      WHERE r.imo = ANY($1) AND abs(r.co2_mt - COALESCE(e.t, 0)) > 0.01`,
    'every report CO2 equals its fuel times Cf');
  await zero('voyages chain',
    `SELECT count(*) AS bad FROM (
       SELECT v.departure_at, LAG(pc.departure_at) OVER (PARTITION BY v.vessel_id ORDER BY v.departure_at) AS prev_left
         FROM kris.voyages v LEFT JOIN kris.port_calls pc ON pc.voyage_id = v.id AND pc.locode = v.to_port
        WHERE v.vessel_id = ANY($1)) x
      WHERE x.prev_left IS NOT NULL AND x.prev_left <> x.departure_at`,
    'each voyage starts when the previous one left port');
  await zero('reports inside their voyage',
    `SELECT count(*) AS bad FROM kris.geoform_reports r JOIN kris.voyages v ON v.id = r.voyage_id
       LEFT JOIN kris.port_calls pc ON pc.voyage_id = v.id AND pc.locode = v.to_port
      WHERE r.imo = ANY($1) AND (r.report_time <= v.departure_at OR r.report_time > COALESCE(pc.departure_at, 'infinity'))`,
    'every report falls within its voyage');
  await zero('FuelEU pools balance',
    `SELECT count(*) AS bad FROM (SELECT pool_id FROM kris.fueleu_flexibility
                                   WHERE pool_id IN (SELECT pool_id FROM kris.fueleu_flexibility WHERE vessel_id = ANY($1))
                                   GROUP BY 1 HAVING abs(SUM(pool_transfer_g)) > 0.5) x`,
    'pool transfers sum to zero');
  await zero('allocations fit their trades',
    `SELECT count(*) AS bad FROM (
       SELECT t.id FROM kris.carbon_trades t JOIN kris.carbon_allocations a ON a.trade_id = t.id
        WHERE t.id IN (SELECT trade_id FROM kris.carbon_allocations WHERE vessel_id = ANY($1))
        GROUP BY t.id HAVING SUM(a.quantity) > t.quantity OR bool_or((t.instrument = 'EUA') <> (a.scheme = 'EU_ETS'))) x`,
    'no trade is over-allocated; EUAs go to EU ETS, UKAs to UK ETS');
  await zero('recharge invoices = quantity x price',
    `SELECT count(*) AS bad FROM kris.invoices i JOIN kris.carbon_allocations a ON a.id = i.allocation_id JOIN kris.carbon_trades t ON t.id = a.trade_id
      WHERE i.vessel_id = ANY($1) AND i.invoice_type = 'carbon_recharge' AND abs(i.amount - round(a.quantity * t.price, 2)) > 0.005`,
    'every recharge invoice equals its allocation at the trade price');
  await zero('emails link to the right vessel',
    `SELECT count(*) AS bad FROM kris.communications c
       LEFT JOIN kris.carbon_allocations a ON a.id = c.allocation_id
       LEFT JOIN kris.bunker_deliveries b ON b.id = c.bdn_id
       LEFT JOIN kris.invoices i ON i.id = c.invoice_id
      WHERE c.vessel_id = ANY($1)
        AND ((a.id IS NOT NULL AND a.vessel_id <> c.vessel_id) OR (b.id IS NOT NULL AND b.vessel_id <> c.vessel_id)
          OR (i.id IS NOT NULL AND i.vessel_id <> c.vessel_id))`,
    'linked allocations, BDNs and invoices belong to the email\'s vessel');
  await check('bunkers cover consumption', async () => {
    const rows = (await db.query(`SELECT b.vessel_id, b.fuel_code, b.q AS delivered, f.q AS burned
                                    FROM (SELECT vessel_id, fuel_code, SUM(quantity_t) AS q FROM kris.bunker_deliveries WHERE vessel_id = ANY($1) GROUP BY 1, 2) b
                                    JOIN (SELECT vessel_id, fuel_code, SUM(total_t) AS q FROM kris.fuel_emissions WHERE vessel_id = ANY($1) GROUP BY 1, 2) f
                                      USING (vessel_id, fuel_code)`, [TEST_IDS])).rows;
    const off = rows.filter((r) => n(r.delivered) < 0.8 * n(r.burned) || n(r.delivered) > 1.05 * n(r.burned));
    return [!off.length, off.length ? off.map((r) => `${r.vessel_id} ${r.fuel_code}: ${r.delivered} delivered vs ${r.burned} burned`).join('; ')
                                    : `${rows.length} vessel/fuel pairs within 80-105% of consumption`];
  });
  await check('derived figures', async () => {
    const r = await one(`SELECT
        (SELECT string_agg(vessel_name || ' ' || year || ' ' || rating, ', ' ORDER BY vessel_name, year) FROM kris.cii_annual WHERE vessel_id = ANY($1)) AS cii,
        (SELECT string_agg(vessel_name || ' ' || year || ' ' || final_balance_t || ' t', ', ' ORDER BY vessel_name, year) FROM kris.fueleu_period WHERE vessel_id = ANY($1) AND period = 'YEAR') AS fueleu`, [TEST_IDS]);
    return [!!(r.cii && r.fueleu), `CII ${r.cii}; FuelEU final balance ${r.fueleu}`];
  });
  return results;
}

/** What the SERVER will see: connect as kris_reader and ask through K.R.1.S's own code. */
async function verifyReader(url) {
  const { Client } = require('pg');
  const rbac = require('../src/rbac');
  const records = require('../src/records');
  const engine = require('../src/engine');
  const db = new Client({ connectionString: url, ssl: sslFor(url) });
  const results = [];
  const check = async (name, fn) => {
    try { const [ok, detail] = await fn(); results.push({ name, ok: !!ok, detail }); }
    catch (e) { results.push({ name, ok: false, detail: String(e.message || e).slice(0, 200) }); }
  };
  await db.connect();
  try {
    await check('reader: read-only session', async () => {
      const r = (await db.query("SELECT current_user AS u, current_setting('default_transaction_read_only') AS ro")).rows[0];
      return [r.u.startsWith('kris_reader') && r.ro === 'on', `${r.u}, read-only ${r.ro}`];
    });
    await check('reader: cannot write', async () => {
      try { await db.query("INSERT INTO kris.kris_query_log (question, outcome) VALUES ('probe', 'probe')"); return [false, 'an INSERT succeeded']; }
      catch (e) { return [true, `refused (${e.code || 'error'})`]; }
    });
    const session = { userId: 'setup-check', orgId: 'setup', vesselIds: TEST_IDS };
    const scope = await rbac.resolveScope(session, db);
    await check('KRIS: vessels in scope', async () => [scope.vessels.length === 2, scope.vessels.map((v) => v.name).join(', ')]);
    for (const topic of records.TOPICS) {
      await check(`KRIS records: ${topic}`, async () => {
        const out = await records.lookup(db, scope, { topic, limit: 3 });
        return [!out.error && (out.row_count > 0 || topic === 'offhire'), out.error || `${out.row_count} rows`];
      });
    }
    for (const text of ['fuel consumption for TEST VESSEL 01 last month', 'CO2 emitted by TEST VESSEL 02 this year', 'VLSFO consumption for TEST VESSEL 01 in 2025']) {
      await check(`KRIS engine: "${text}"`, async () => {
        const out = await engine.ask({ text, session, now: new Date() }, db, { orgId: 'setup', disableLog: true });
        return [out.status === 'answer', String(out.text || out.status).slice(0, 140)];
      });
    }
  } finally {
    await db.end().catch(() => {});
  }
  return results;
}

// ---------------------------------------------------------------------------
// Connection strings and passwords
// ---------------------------------------------------------------------------

function sslFor(url) {
  return /localhost|127\.0\.0\.1/.test(String(url)) ? false : { rejectUnauthorized: false };
}

const PLACEHOLDER = /^(\[?your-password\]?|password|change_me.*|)$/i;

/** The admin URL with the role and password swapped in (pooler users carry the project ref). */
function roleUrl(adminUrl, role, password) {
  const u = new URL(adminUrl);
  const ref = decodeURIComponent(u.username).split('.')[1];
  u.username = ref ? `${role}.${ref}` : role;
  u.password = encodeURIComponent(password);
  u.searchParams.delete('sslmode');
  return u.toString();
}

function existingPassword(url, role, adminUrl) {
  try {
    const u = new URL(url); const a = new URL(adminUrl);
    const user = decodeURIComponent(u.username).split('.')[0];
    const pw = decodeURIComponent(u.password);
    if (user !== role || u.hostname !== a.hostname || PLACEHOLDER.test(pw)) return null;
    return pw;
  } catch (_) { return null; }
}

async function setRolePasswords(db, adminUrl, env) {
  const out = {};
  for (const [role, key] of [['kris_reader', 'KRIS_READ_URL'], ['kris_writer', 'KRIS_WRITE_URL']]) {
    const keep = existingPassword(env[key], role, adminUrl);
    const password = keep || crypto.randomBytes(24).toString('base64url');
    const { rows } = await db.query('SELECT format($3, $1::text, $2::text) AS sql', [role, password, 'ALTER ROLE %I WITH LOGIN PASSWORD %L']);
    await db.query(rows[0].sql);
    out[key] = { url: roleUrl(adminUrl, role, password), kept: !!keep };
  }
  return out;
}

function writeEnv(file, values) {
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, line) : text.replace(/\n?$/, '\n') + line + '\n';
  }
  fs.writeFileSync(file, text);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function report(results) {
  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  }
  return failed;
}

async function main(argv) {
  const flag = (f) => argv.includes(f);
  const envFile = argv.includes('--env') ? argv[argv.indexOf('--env') + 1] : path.join(process.cwd(), '.env');
  if (flag('--print-seed')) {
    process.stdout.write(require('./test_data').buildSql({ until: new Date() }) + '\n');
    return 0;
  }
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const renames = require('../src/envcheck').findRenames(process.env);
  if (renames.length) {
    console.log(`Note: ${path.basename(envFile)} still names ${renames.length} setting(s) with an old prefix; the server reads only KRIS_*.`);
    console.log('      Rename: ' + renames.map((r) => `${r.from} -> ${r.to}`).join(', '));
  }
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl || /\[YOUR-PASSWORD\]/i.test(adminUrl)) {
    console.error(`DATABASE_URL is not set${adminUrl ? ' (it still has the [YOUR-PASSWORD] placeholder)' : ''}. Put the Supabase postgres connection string in ${envFile}.`);
    return 2;
  }
  const { Client } = require('pg');
  const db = new Client({ connectionString: adminUrl, ssl: sslFor(adminUrl) });
  const host = (() => { try { return new URL(adminUrl).hostname; } catch (_) { return '?'; } })();
  console.log(`K.R.1.S database setup — ${host}`);
  await db.connect();
  let failed = 0;
  try {
    if (!flag('--check')) {
      process.stdout.write('  …   schema'); await applySchema(db); console.log('\r  done  schema (db/001_schema.sql)');
      const urls = await setRolePasswords(db, adminUrl, process.env);
      const changed = Object.entries(urls).filter(([, v]) => !v.kept);
      if (changed.length) {
        writeEnv(envFile, Object.fromEntries(changed.map(([k, v]) => [k, v.url])));
        for (const [k] of changed) process.env[k] = urls[k].url;
        console.log(`  done  role passwords set; ${changed.map(([k]) => k).join(' and ')} written to ${path.basename(envFile)} (not shown)`);
      } else {
        console.log('  done  role passwords kept from the env file');
      }
      if (!flag('--no-seed')) {
        process.stdout.write('  …   test data'); await seedTestData(db); console.log('\r  done  test data (TEST VESSEL 01, TEST VESSEL 02)');
      }
    }
    console.log('\nChecks as the database owner:');
    failed += report(await verify(db));
  } finally {
    await db.end().catch(() => {});
  }
  const readerUrl = process.env.KRIS_READ_URL;
  if (readerUrl && !/\[YOUR-PASSWORD\]|PASSWORD@/i.test(readerUrl)) {
    console.log('\nChecks as kris_reader, through K.R.1.S:');
    failed += report(await verifyReader(readerUrl));
  }
  console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
  return failed ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    // Never echo a connection string.
    console.error('setup failed:', String(err && err.message || err).replace(/postgres(?:ql)?:\/\/\S+/g, 'postgresql://<redacted>'));
    process.exit(1);
  });
}

module.exports = { applySchema, seedTestData, verify, verifyReader, roleUrl, existingPassword, TABLES, VIEWS, TEST_IDS };
