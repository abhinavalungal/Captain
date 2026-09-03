'use strict';
require('./env');
const { Client } = require('pg');
const { sync } = require('../src/integrations/sync');

// npm run sync — one full pull into the database named by CAPTAIN_WRITE_URL.
(async () => {
  if (!process.env.CAPTAIN_WRITE_URL) throw new Error('CAPTAIN_WRITE_URL is not set');
  const db = new Client({ connectionString: process.env.CAPTAIN_WRITE_URL,
    ssl: process.env.CAPTAIN_PG_SSL === 'false' ? false : { rejectUnauthorized: false } });
  await db.connect();
  try {
    const stats = await sync({ db, log: console.log });
    console.log(JSON.stringify(stats, null, 2));
  } finally { await db.end(); }
})().catch((e) => { console.error('sync failed:', e.message); process.exit(1); });
