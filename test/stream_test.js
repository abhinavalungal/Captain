'use strict';

/**
 * Streaming + fast-lane tests, against the local mock model (test/mock_llm.js).
 * No database, no network, no key.
 *
 *   node test/stream_test.js
 */
const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const { startMockLLM } = require('./mock_llm');
const router = require('../src/router');
const { SentenceGate } = require('../src/stream');
const { containsStatedFigure, SAFE_REDIRECT } = require('../src/companion_src');

let passed = 0; const fails = [];
const ta = async (n, f) => { try { await f(); passed++; } catch (e) { fails.push(n + ': ' + (e && e.message)); } };

const NOW = new Date('2026-09-02T10:00:00Z');
const session = { userId: 'u', orgId: 'o', vesselIds: ['9851701'] };
const NO_DB = async () => { const e = new Error('KRIS_READ_URL is not set'); e.code = 'DB_NOT_CONFIGURED'; throw e; };

(async () => {
  const mock = await startMockLLM({ firstTokenMs: 30, tokenMs: 2 });
  const AGENT = { KRIS_MODE: 'agent', KRIS_ENABLE_LLM: '1', KRIS_LLM_PROVIDER: 'openai_compat', KRIS_LLM_URL: mock.url, KRIS_LLM_MODEL: 'mock' };
  const COMPANION = { KRIS_MODE: 'router', KRIS_ENABLE_LLM: '1', KRIS_LLM_PROVIDER: 'openai_compat', KRIS_LLM_URL: mock.url, KRIS_LLM_MODEL: 'mock' };

  // --- the gate --------------------------------------------------------------
  await ta('gate: releases whole sentences only, and every released piece passes the guard', async () => {
    const out = [];
    const g = new SentenceGate({ check: (t) => containsStatedFigure(t, []), emit: (t) => out.push(t) });
    'One. Two is here! Three?'.split('').forEach((c) => g.push(c));
    assert.deepStrictEqual(out, ['One. ', 'Two is here! ']);
    g.end();
    assert.deepStrictEqual(out, ['One. ', 'Two is here! ', 'Three?']);
  });
  await ta('gate: a failing sentence is never released and blocks the rest', async () => {
    const out = [];
    const g = new SentenceGate({ check: (t) => containsStatedFigure(t, ['Aurora Trader']), emit: (t) => out.push(t) });
    ['Sure. ', 'Aurora Trader burned 41.2 MT', ' yesterday. ', 'Anything else?'].forEach((c) => g.push(c));
    g.end();
    assert.ok(g.blocked);
    assert.ok(out.join('').indexOf('41.2') < 0, 'a guarded figure leaked: ' + out.join(''));
  });
  await ta('gate: the guard judges exactly the sentences the non-streamed guard judges', async () => {
    const texts = [
      'e.g. your vessel burns 30 MT a day.',
      'A Panamax might burn 30 tonnes a day. Your fleet is fine.',
      'Here is a thought.\nThe ship did 14 kn on average.',
      'The vessel "Sea Star." burned 12 MT.',
    ];
    for (const t of texts) {
      const g = new SentenceGate({ check: (p) => containsStatedFigure(p, []), emit: () => {} });
      for (const ch of t) g.push(ch);
      g.end();
      assert.strictEqual(g.blocked, containsStatedFigure(t, []), 'disagreement on: ' + t);
    }
  });

  // --- fast lane: zero model calls in every mode -----------------------------
  await ta('fast lane: greetings, capability, date, app help never reach the model in agent mode', async () => {
    const before = mock.requests.length;
    router.prewarm();
    for (const text of ['Hi', 'Hello', 'How are you?', 'What can you do?', 'thanks!', 'what is the date today', 'How do I export a report?', 'good evening kris']) {
      const t0 = process.hrtime.bigint();
      const out = await router.route({ text, session, now: NOW, context: { tz: 'Asia/Calcutta' } }, NO_DB, { orgId: 'o', env: AGENT });
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      assert.ok(out.instant, text + ' was not instant: ' + out.source);
      assert.ok(ms < 25, text + ' took ' + ms.toFixed(1) + 'ms');
    }
    assert.strictEqual(mock.requests.length, before, 'the model was called');
  });

  // --- agent streaming -------------------------------------------------------
  await ta('agent: an open question streams deltas whose concatenation is the final text', async () => {
    const evts = [];
    const out = await router.route({ text: 'Tell me a joke', session, now: NOW }, NO_DB, { orgId: 'o', env: AGENT, onDelta: (e) => evts.push(e) });
    assert.strictEqual(out.source, 'agent');
    assert.ok(out.streamed);
    const deltas = evts.filter((e) => e.t === 'delta').map((e) => e.text);
    assert.ok(deltas.length >= 2, 'expected several sentence deltas, got ' + deltas.length);
    assert.strictEqual(deltas.join('').trim(), out.text);
    assert.strictEqual(mock.requests[mock.requests.length - 1].body.stream, true);
  });

  await ta('agent: a fabricated figure mid-stream is replaced, and never streamed', async () => {
    const m2 = await startMockLLM({ firstTokenMs: 5, tokenMs: 1, reply: () => 'Sure thing. Your vessel burned 42.5 MT last week. Want more?' });
    const evts = [];
    const out = await router.route({ text: 'what did we burn, roughly', session, now: NOW }, NO_DB,
      { orgId: 'o', env: Object.assign({}, AGENT, { KRIS_LLM_URL: m2.url }), onDelta: (e) => evts.push(e) });
    await m2.close();
    assert.ok(out.blocked, 'not blocked');
    const streamed = evts.filter((e) => e.t === 'delta').map((e) => e.text).join('');
    assert.ok(streamed.indexOf('42.5') < 0, 'figure leaked into the stream');
    assert.ok(evts.some((e) => e.t === 'replace'), 'no replace event');
  });

  await ta('agent: without onDelta the answer is identical, just not streamed', async () => {
    const out = await router.route({ text: 'Tell me a joke', session, now: NOW }, NO_DB, { orgId: 'o', env: AGENT });
    assert.strictEqual(out.source, 'agent');
    assert.ok(!out.streamed);
    assert.ok(/flute/.test(out.text));
  });

  await ta('agent: a tool call emits a status event and the tool failure is relayed honestly', async () => {
    const evts = [];
    const out = await router.route({ text: 'roughly how is our fuel looking', session, now: NOW }, NO_DB, { orgId: 'o', env: AGENT, onDelta: (e) => evts.push(e) });
    assert.ok(evts.some((e) => e.t === 'status' && /records/i.test(e.text)), 'no status event');
    assert.ok(out.toolsUsed && out.toolsUsed.indexOf('get_vessel_data') >= 0);
    assert.ok(!/\d+(\.\d+)?\s*MT/.test(out.text), 'a figure appeared without data: ' + out.text);
  });

  await ta('agent: the client going away cancels the model request', async () => {
    const m3 = await startMockLLM({ firstTokenMs: 400, tokenMs: 50 });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 80);
    const t0 = Date.now();
    const out = await router.route({ text: 'Tell me a joke', session, now: NOW }, NO_DB,
      { orgId: 'o', env: Object.assign({}, AGENT, { KRIS_LLM_URL: m3.url }), signal: ctrl.signal, onDelta: () => {} });
    await m3.close();
    assert.ok(Date.now() - t0 < 400, 'did not stop promptly');
    assert.strictEqual(out.reason, 'cancelled');
  });

  await ta('agent: while the model reasons the widget hears "Thinking", and never the reasoning itself', async () => {
    const m5 = await startMockLLM({ firstTokenMs: 5, tokenMs: 1, reasoningMs: 300 });
    const evts = [];
    const out = await router.route({ text: 'Tell me a joke', session, now: NOW }, NO_DB,
      { orgId: 'o', env: Object.assign({}, AGENT, { KRIS_LLM_URL: m5.url }), onDelta: (e) => evts.push(e) });
    await m5.close();
    assert.strictEqual(out.source, 'agent');
    assert.ok(evts.some((e) => e.t === 'status' && e.text === 'Thinking'), 'no Thinking status');
    assert.ok(!/SECRET-REASONING/.test(JSON.stringify(evts) + out.text), 'reasoning leaked to the user');
    assert.ok(/flute/.test(out.text), out.text);
  });

  // --- companion streaming ---------------------------------------------------
  await ta('companion: streams, and a trailing CHART line is held back and parsed', async () => {
    const m4 = await startMockLLM({ firstTokenMs: 5, tokenMs: 1, reply: () => '150 is 25% more than 120.\nCHART {"type":"bar","title":"A vs B","labels":["A","B"],"values":[120,150]}' });
    const evts = [];
    const out = await router.route({ text: 'chart 120 against 150 for me', session, now: NOW }, NO_DB,
      { orgId: 'o', env: Object.assign({}, COMPANION, { KRIS_LLM_URL: m4.url }), onDelta: (e) => evts.push(e) });
    await m4.close();
    assert.strictEqual(out.source, 'companion');
    const streamed = evts.filter((e) => e.t === 'delta').map((e) => e.text).join('');
    assert.ok(streamed.indexOf('CHART') < 0, 'CHART line was streamed');
    assert.deepStrictEqual(out.chart.values, [120, 150]);
  });

  await ta('companion: a blocked reply is replaced with the fixed redirect', async () => {
    const m5 = await startMockLLM({ firstTokenMs: 5, tokenMs: 1, reply: () => 'Your fleet averaged 13.2 knots. Nice.' });
    const evts = [];
    const out = await router.route({ text: 'chat with me for a bit', session, now: NOW }, NO_DB,
      { orgId: 'o', env: Object.assign({}, COMPANION, { KRIS_LLM_URL: m5.url }), onDelta: (e) => evts.push(e) });
    await m5.close();
    assert.ok(out.blocked);
    assert.strictEqual(out.text, SAFE_REDIRECT);
    assert.ok(evts.filter((e) => e.t === 'delta').every((e) => e.text.indexOf('13.2') < 0));
  });

  // --- over HTTP: server.js ----------------------------------------------------
  const port = 19900 + Math.floor(Math.random() * 90);
  const env = Object.assign({}, process.env, AGENT, { PORT: String(port), KRIS_DEV_SESSION: '1', KRIS_ALLOW_ORIGIN: '*', KRIS_READ_URL: '' });
  for (const k of Object.keys(env)) if (/^KRIS_TEST/.test(k)) delete env[k];
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});
  await new Promise((r) => child.stdout.on('data', (d) => { if (/listening/i.test(String(d))) r(); }));
  const base = 'http://127.0.0.1:' + port;
  const token = Buffer.from(JSON.stringify({ sub: 't', org: 'o', vessel_ids: ['1'] })).toString('base64');
  const post = (body, headers) => fetch(base + '/api/kris', { method: 'POST', headers: Object.assign({ 'Content-Type': 'text/plain;charset=UTF-8', Origin: 'https://perform.geoserves.com' }, headers || {}), body: JSON.stringify(body) });

  await ta('http: text/plain body with the token inside is accepted (no preflight needed)', async () => {
    const r = await post({ text: 'hi', token, stream: true });
    assert.strictEqual(r.status, 200);
    assert.ok(/application\/json/.test(r.headers.get('content-type')), 'a greeting should come back as plain JSON');
    assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
    const d = await r.json();
    assert.strictEqual(d.source, 'router');
    assert.ok(d.ms != null && d.ms < 20, 'server time ' + d.ms);
    assert.ok(/kris;.*dur=/.test(r.headers.get('server-timing') || ''), 'no Server-Timing');
  });

  await ta('http: no token is still a 401', async () => {
    const r = await post({ text: 'hi' });
    assert.strictEqual(r.status, 401);
  });

  await ta('http: a model answer streams as NDJSON ending in a final event', async () => {
    const r = await post({ text: 'Tell me a joke', token, stream: true });
    assert.ok(/ndjson/.test(r.headers.get('content-type')), r.headers.get('content-type'));
    const lines = (await r.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(lines.some((l) => l.t === 'delta'));
    const fin = lines[lines.length - 1];
    assert.strictEqual(fin.t, 'final');
    assert.strictEqual(fin.data.source, 'agent');
  });

  await ta('http: the widget is served compressed and revalidated on every load, so a deploy is live at once', async () => {
    const r = await fetch(base + '/kris-widget.js', { headers: { 'Accept-Encoding': 'br' } });
    assert.strictEqual(r.headers.get('content-encoding'), 'br');
    assert.strictEqual(r.headers.get('cache-control'), 'no-cache');
    const etag = r.headers.get('etag');
    await r.arrayBuffer();
    const r2 = await fetch(base + '/kris-widget.js', { headers: { 'If-None-Match': etag } });
    assert.strictEqual(r2.status, 304);
  });

  await ta('http: GET health reports streaming support', async () => {
    const h = await (await fetch(base + '/api/kris')).json();
    assert.ok(h.features && h.features.stream);
  });

  child.kill();
  await mock.close();
  console.log(`\nStreaming: ${passed} passed, ${fails.length} failed`);
  fails.forEach((f) => console.log('  FAIL ' + f));
  process.exit(fails.length ? 1 : 0);
})();
