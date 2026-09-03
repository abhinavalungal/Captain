'use strict';

/**
 * OPTIONAL Netlify adapter for the sync job. See captain.js — same idea,
 * all logic lives in src/httpHandler.js / src/integrations/sync.js. Prefer
 * running `node scripts/sync.js` on a plain cron job instead; this exists
 * only for Netlify's scheduled-functions feature, for anyone still using it.
 */
const { handleSync } = require('../../src/httpHandler');

exports.handler = async function handler(event) {
  const scheduled = !event.httpMethod || (event.headers && event.headers['x-netlify-event'] === 'schedule');
  return handleSync({
    method: scheduled ? 'POST' : event.httpMethod,
    headers: scheduled ? { 'x-captain-sync-key': process.env.CAPTAIN_SYNC_KEY } : (event.headers || {}),
    env: process.env,
  });
};
