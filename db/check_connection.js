'use strict';
/**
 * One-off check: confirms the connection string works, and reports whether
 * a `vessels` table exists (and its columns) so we don't have to guess.
 *
 * Usage:
 *   npm install pg --no-save        (if not already installed)
 *   node db/check_connection.js "postgresql://postgres.xxx:PASSWORD@aws-0-...pooler.supabase.com:5432/postgres"
 *
 * Never commit the connection string anywhere — pass it on the command line
 * or via an env var you don't check in.
 */
const { Client } = require('pg');

const url = process.argv[2] || process.env.CAPTAIN_READ_URL;
if (!url) {
  console.error('Usage: node db/check_connection.js "<connection string>"');
  process.exit(1);
}

(async () => {
  // Supabase's pooler presents a certificate chain from its own CA, which is
  // not in every OS trust store (Windows especially). Captain's server accepts
  // it the same way (see sslFor() in src/httpHandler.js).
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    const now = await client.query('select now()');
    console.log('✅ Connected. Server time:', now.rows[0].now);

    const tables = await client.query(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_name in ('vessels', 'fueleu_final', 'dnv')`
    );
    const found = tables.rows.map((r) => r.table_name);
    console.log('Tables found in public schema:', found.length ? found.join(', ') : '(none of the three)');

    if (found.includes('vessels')) {
      const cols = await client.query(
        `select column_name, data_type from information_schema.columns
         where table_schema = 'public' and table_name = 'vessels'
         order by ordinal_position`
      );
      console.log('\nvessels table columns:');
      cols.rows.forEach((r) => console.log('  ', r.column_name, '—', r.data_type));
    } else {
      console.log('\nNo `vessels` table in public schema — Captain has nothing to scope RBAC against yet.');
    }

    const views = await client.query(
      `select table_name from information_schema.views
       where table_schema = 'public' and table_name in ('captain_fueleu_final', 'captain_dnv')`
    );
    console.log('\ncaptain_* views present:', views.rows.length ? views.rows.map((r) => r.table_name).join(', ') : '(none yet — run db/003_captain_fueleu_dnv_views.sql)');
  } catch (err) {
    console.error('❌ Connection or query failed:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
})();