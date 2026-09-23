'use strict';
/** Reasoning-model handling on OpenRouter. Offline. */
const assert = require('assert');
const { converse, buildRequest, readEnv, effortFor } = require('../src/companion_src');
const agent = require('../src/agent');
const router = require('../src/router');
let passed = 0; const fails = [];
const t = (n, f) => { try { f(); passed++; } catch (e) { fails.push(n + ': ' + e.message); } };
const ta = async (n, f) => { try { await f(); passed++; } catch (e) { fails.push(n + ': ' + e.message); } };
const ENV = { KRIS_LLM_PROVIDER: 'openai_compat', KRIS_LLM_URL: 'https://openrouter.ai/api', KRIS_LLM_MODEL: 'z-ai/glm-5.3-flash', KRIS_LLM_API_KEY: 'k' };

t('OpenRouter requests carry an effort and stream reasoning back (a heartbeat), never "enabled:false"', () => {
  const req = buildRequest(readEnv(ENV), 'sys', [{ role: 'user', content: 'hi' }], 'low');
  assert.deepStrictEqual(req.body.reasoning, { effort: 'low' });
});
t('effort can be pinned', () => {
  assert.strictEqual(effortFor('explain FuelEU pooling step by step', Object.assign({}, ENV, { KRIS_LLM_REASONING_EFFORT: 'medium' })), 'medium');
});
t('non-OpenRouter endpoints get no reasoning field at all', () => {
  const req = buildRequest(readEnv(Object.assign({}, ENV, { KRIS_LLM_URL: 'http://vllm.local:8000' })), 'sys', [], 'high');
  assert.strictEqual(req.body.reasoning, undefined);
});
t('agent mode sends the same directive, on the same model', () => {
  const cfg = Object.assign(agent.readEnv(ENV), { effort: 'high' });
  const body = agent.buildBody(cfg, [], true);
  assert.deepStrictEqual(body.reasoning, { effort: 'high' });
  assert.strictEqual(body.model, 'z-ai/glm-5.3-flash');
  assert.ok(body.max_tokens >= 8192);
});

ta('a 400 that names "reasoning" is retried once without the field, and succeeds', async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    const b = JSON.parse(init.body); bodies.push(b);
    if (b.reasoning) return { ok: false, status: 400, text: async () => '{"error":{"message":"reasoning is not supported for this model"}}', json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'All is well here.' } }] }), text: async () => '' };
  };
  const out = await converse('how are you', { env: ENV, fetchImpl, guideSnippets: [] });
  assert.strictEqual(bodies.length, 2);
  assert.ok(bodies[0].reasoning && !bodies[1].reasoning);
  assert.strictEqual(out.text, 'All is well here.');
});
ta('any other 400 is NOT retried and the status reaches the error field', async () => {
  let n = 0;
  const fetchImpl = async () => { n++; return { ok: false, status: 400, text: async () => 'bad model slug', json: async () => ({}) }; };
  const out = await converse('how are you', { env: ENV, fetchImpl, guideSnippets: [] });
  assert.strictEqual(n, 1);
  assert.ok(/HTTP 400/.test(out.error));
});
ta('the provider error reaches the router result (for logging), never the user text', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'No auth credentials found', json: async () => ({}) });
  const out = await router.route({ text: 'are you connected to the db?', session: { userId: 'u', orgId: 'o' }, now: new Date(), history: [], context: {} },
    async () => { throw new Error('nodb'); }, { orgId: 'o', env: ENV, fetchImpl });
  assert.strictEqual(out.source, 'companion');
  assert.ok(/companion: HTTP 401/.test(out.error), out.error);
  assert.ok(!/401/.test(out.text));
});

setTimeout(() => { console.log(`\nReasoning: ${passed} passed, ${fails.length} failed`); fails.forEach((f) => console.log('  FAIL ' + f)); process.exit(fails.length ? 1 : 0); }, 300);