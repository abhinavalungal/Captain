'use strict';
require('./env');

/**
 * npm run discover [imo] [fromDate] [toDate]
 *
 * Calls each upstream API once, prints the real field names, and shows how
 * the mapper resolved them against Captain's columns. Anything under
 * "unmapped" or "no upstream field" is what to fix, either by adding a
 * candidate in src/integrations/mapping.js or via CAPTAIN_FIELD_MAP.
 *
 * Nothing is written anywhere. Tokens are never printed.
 */
const { vesonClient, geoformClient } = require('../src/integrations/clients');
const { resolveMapping, loadOverrides } = require('../src/integrations/mapping');

const [imoArg, fromArg, toArg] = process.argv.slice(2);

function show(title, rows, schema) {
  console.log(`\n=== ${title}: ${rows.length} rows ===`);
  if (!rows.length) { console.log('  (no rows returned)'); return; }
  const sample = rows[0];
  console.log('  fields:', Object.keys(sample).join(', '));
  console.log('  sample:', JSON.stringify(sample).slice(0, 600));
  const res = resolveMapping(schema, sample, (loadOverrides()[schema]) || {});
  console.log('  mapped:');
  for (const [col, src] of Object.entries(res.map)) console.log(`    ${col.padEnd(20)} <- ${src}`);
  if (res.unmatchedTargets.length) console.log('  no upstream field for:', res.unmatchedTargets.join(', '));
  if (res.unmappedSource.length) console.log('  unmapped upstream fields:', res.unmappedSource.join(', '));
}

(async () => {
  const veson = vesonClient();
  const geo = geoformClient();

  const legs = await veson.legWise();
  show('Veson FuelEU leg-wise', legs.rows, 'veson_legs');

  const off = await veson.offHire();
  show('Veson FuelEU off-hire', off.rows, 'veson_offhire');

  const imo = imoArg || (legs.rows[0] && (legs.rows[0].imo || legs.rows[0].imoNumber || legs.rows[0].IMO));
  if (!imo) { console.log('\nGeoform: pass an IMO as the first argument.'); return; }
  const to = toArg || new Date().toISOString().slice(0, 10);
  const from = fromArg || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const forms = await geo.forms(String(imo), from, to);
  show(`Geoform ${imo} ${from}..${to}`, forms.rows, 'geoform_reports');
})().catch((e) => { console.error('\ndiscover failed:', e.message); process.exit(1); });
