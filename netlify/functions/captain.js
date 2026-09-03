'use strict';

/**
 * OPTIONAL Netlify adapter. Captain no longer requires Netlify — server.js
 * at the repo root is the primary way to run this now. This file is kept
 * only for anyone who still wants to deploy on Netlify; it does nothing but
 * translate Netlify's event shape to and from src/httpHandler.js, which is
 * where all the real logic lives.
 */
const { handleCaptain, verifyToken, corsHeaders, health } = require('../../src/httpHandler');

exports.handler = async function handler(event) {
  return handleCaptain({
    method: event.httpMethod,
    headers: event.headers || {},
    body: event.body,
    env: process.env,
  });
};

// re-exported for anything that still imports this file directly
exports._verifyToken = (token) => verifyToken(token, process.env);
exports._corsHeaders = (event) => corsHeaders((event.headers && (event.headers.origin || event.headers.Origin)) || '', process.env);
exports._health = () => health(process.env);
