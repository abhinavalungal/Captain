'use strict';

/**
 * End-to-end latency benchmark. Runs server.js as a real HTTP server, with:
 *   - a local mock LLM that behaves like a hosted reasoning "flash" model
 *     (default 1800 ms before the first token, then ~20 ms per token), and
 *   - optionally, Postgres reached through a TCP proxy that adds a round-trip
 *     delay (default 70 ms each way), so a DB connection costs what a
 *     Render -> Supabase (ap-northeast-2) connection costs in practice.
 *
 *   node test/latency_bench.js [appRoot] [--json]
 *
 * Env:
 *   BENCH_PG_URL      postgres://... to include data questions (optional)
 *   BENCH_PG_DELAY_MS one-way delay added by the proxy (default 70)
 *   BENCH_LLM_TTFT_MS mock model time-to-first-token (default 1800)
 *   BENCH_MODE        agent | router (default agent, the current production setting)
 *
 * Reports, per message: time to the first visible text (first streamed
 * sentence, or the whole reply when it is not streamed) and the total time.
 * These are server-side numbers over loopback; add your own network round
 * trip (India -> Render is typically ~200-300 ms) to get what a user feels.
 */
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { startMockLLM } = require('./mock_llm');

const appRoot = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(__dirname, '..'));
const asJson = process.argv.includes('--json');
const PG_URL = process.env.BENCH_PG_URL || '';
const PG_DELAY = parseInt(process.env.BENCH_PG_DELAY_MS || '70', 10);
const TTFT = parseInt(process.env.BENCH_LLM_TTFT_MS || '1800', 10);
const MODE = process.env.BENCH_MODE || 'agent';

const MESSAGES = [
  'Hi',
  'Hello',
  'How are you?',
  'What can you do?',
  'thanks!',
  'What is the date today?',
  'How do I export a report?',
  'Tell me a joke',
];
const DATA_MESSAGES = [
  'fuel consumption for Aurora Trader last month',
  'average shaft power for Aurora Trader last month',
];

function delayProxy(targetHost, targetPort, delayMs) {
  return new Promise((resolve) => {
    const srv = net.createServer((client) => {
      const upstream = net.connect(targetPort, targetHost);
      const pipe = (from, to) => from.on('data', (d) => setTimeout(() => { if (!to.destroyed) to.write(d); }, delayMs));
      pipe(client, upstream); pipe(upstream, client);
      const kill = () => { client.destroy(); upstream.destroy(); };
      client.on('error', kill); upstream.on('error', kill); client.on('close', kill); upstream.on('close', kill);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, close: () => srv.close() }));
  });
}

const token = Buffer.from(JSON.stringify({ sub: 'bench', org: 'test-org', vessel_ids: ['9851701', '9234567'] })).toString('base64');

async function ask(base, text) {
  const t0 = performance.now();
  const res = await fetch(base + '/api/kris', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, Origin: 'https://perform.geoserves.com' },
    body: JSON.stringify({ text, stream: true, context: { tz: 'Asia/Calcutta' } }),
  });
  const ctype = res.headers.get('content-type') || '';
  let first = null; let final = null; let buf = '';
  if (/ndjson/.test(ctype)) {
    const reader = res.body.getReader(); const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const evt = JSON.parse(line);
        if (first == null && (evt.t === 'delta' || evt.t === 'final' || evt.t === 'replace')) first = performance.now() - t0;
        if (evt.t === 'final') final = evt.data;
      }
    }
  } else {
    final = await res.json();
    first = performance.now() - t0;
  }
  return { first, total: performance.now() - t0, source: final && final.source, status: final && final.status, text: final && final.text };
}

(async () => {
  const mock = await startMockLLM({ firstTokenMs: TTFT, tokenMs: 20 });
  let proxy = null; let readUrl = '';
  if (PG_URL) {
    const u = new URL(PG_URL);
    proxy = await delayProxy(u.hostname, parseInt(u.port || '5432', 10), PG_DELAY);
    u.hostname = '127.0.0.1'; u.port = String(proxy.port);
    readUrl = u.toString();
  }
  const port = 19000 + Math.floor(Math.random() * 800);
  const env = Object.assign({}, process.env, {
    PORT: String(port), KRIS_MODE: MODE, KRIS_DEV_SESSION: '1', KRIS_ALLOW_ORIGIN: '*',
    KRIS_ENABLE_LLM: '1', KRIS_LLM_PROVIDER: 'openai_compat', KRIS_LLM_URL: mock.url, KRIS_LLM_MODEL: 'mock/flash',
    KRIS_READ_URL: readUrl, KRIS_PG_SSL: 'false', KRIS_WRITE_URL: '',
  });
  const child = spawn(process.execPath, [path.join(appRoot, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});
  await new Promise((resolve) => child.stdout.on('data', (d) => { if (/listening/i.test(String(d))) resolve(); }));
  const base = 'http://127.0.0.1:' + port;
  await fetch(base + '/api/kris').then((r) => r.text()); // the widget's warm-up GET
  await new Promise((r) => setTimeout(r, 300));

  const rows = [];
  const all = MESSAGES.concat(PG_URL ? DATA_MESSAGES : []);
  for (const m of all) {
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await ask(base, m));
    const med = (k) => runs.map((r) => r[k]).sort((a, b) => a - b)[1];
    rows.push({ message: m, source: runs[0].source, firstMs: Math.round(med('first')), totalMs: Math.round(med('total')), coldTotalMs: Math.round(runs[0].total) });
  }
  child.kill(); await mock.close(); if (proxy) proxy.close();

  if (asJson) { console.log(JSON.stringify(rows)); return; }
  console.log('\nLatency (' + path.basename(appRoot) + ', mode=' + MODE + ', mock TTFT ' + TTFT + ' ms' + (PG_URL ? ', DB +' + (PG_DELAY * 2) + ' ms RTT' : ', no DB') + ')');
  console.log('message'.padEnd(52) + 'source'.padEnd(11) + 'first text'.padStart(11) + 'total'.padStart(9) + 'cold'.padStart(9));
  for (const r of rows) {
    console.log(r.message.slice(0, 50).padEnd(52) + String(r.source || '').padEnd(11) + (r.firstMs + ' ms').padStart(11) + (r.totalMs + ' ms').padStart(9) + (r.coldTotalMs + ' ms').padStart(9));
  }
})().catch((e) => { console.error(e); process.exit(1); });
