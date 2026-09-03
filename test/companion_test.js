'use strict';

/**
 * Companion-layer tests: app guide matching, the LLM numeric-figure guard,
 * router precedence (data > guide > briefing > companion), and briefing SQL.
 *
 *   CAPTAIN_TEST_URL='postgres://...' node test/companion_test.js
 *
 * No real model is called. The router and companion tests use an injected
 * fetchImpl shaped exactly like Ollama's /api/chat response (and, in one
 * test, an OpenAI-compatible /v1/chat/completions response), so the suite
 * runs with no model installed and no network.
 */
const assert = require('assert');
const { Client } = require('pg');

const { matchGuide, searchGuide } = require('../src/guide');
const { isBriefingRequest, buildBriefing } = require('../src/alerts');
const { converse, containsStatedFigure, extractChart, systemPrompt, buildRequest, readEnv } = require('../src/companion_src');
const router = require('../src/router');

let passed = 0; const fails = [];
const t = (n, f) => { try { f(); passed++; } catch (e) { fails.push(n + ': ' + e.message); } };
const ta = async (n, f) => { try { await f(); passed++; } catch (e) { fails.push(n + ': ' + e.message); } };

const NOW = new Date('2026-09-02T10:00:00Z');
// Shaped like Ollama's non-streaming /api/chat reply.
const ollamaStub = (replyText) => async (url, init) => {
  assert.ok(/\/api\/chat$/.test(url), 'expected the Ollama chat endpoint, got ' + url);
  const body = JSON.parse(init.body);
  assert.ok(!body.tools && !body.functions, 'companion call must never include tools — that is the structural guarantee');
  assert.ok(body.stream === false);
  const system = body.messages.find((m) => m.role === 'system');
  assert.ok(system && /Never state, estimate or guess a figure as if it were one of their vessels/.test(system.content), 'system prompt must carry the one rule');
  return { ok: true, status: 200, json: async () => ({ model: body.model, message: { role: 'assistant', content: replyText }, done: true }) };
};
const LLM_ENV = { CAPTAIN_ENABLE_LLM: '1', CAPTAIN_LLM_URL: 'http://llm.test:11434', CAPTAIN_LLM_MODEL: 'llama3.1:8b', CAPTAIN_APP_NAME: 'Geo Monitor' };

// --- guide -------------------------------------------------------------------
t('guide: exact phrasing matches', () => {
  assert.strictEqual(matchGuide('how do I export a report').id, 'export-report');
  assert.strictEqual(matchGuide('add a vessel').id, 'add-vessel');
});
t('guide: near-miss typo still matches, wild guess does not', () => {
  assert.strictEqual(matchGuide('export reprot').id, 'export-report');
  assert.strictEqual(matchGuide('tell me about quantum physics'), null);
});
t('guide: search returns ranked candidates for LLM context', () => {
  const hits = searchGuide('who can see my vessels and why');
  assert.ok(hits.some((h) => h.id === 'departments'));
});
t('guide: totally unrelated text returns nothing', () => {
  assert.deepStrictEqual(searchGuide('purple elephants dancing'), []);
});

// --- numeric guard -------------------------------------------------------------
t('guard: a maritime figure attributed to the USER\'S fleet is caught', () => {
  assert.ok(containsStatedFigure('Your shaft power was 9421.5 kW yesterday.'));
  assert.ok(containsStatedFigure('Your vessel burned 42.3 MT last month.'));
  assert.ok(containsStatedFigure('Compliance balance for your ship is -1200 gCO2e.'));
  assert.ok(containsStatedFigure('Your vessel was off hire for 36 hours.'));
  assert.ok(containsStatedFigure('The fleet logged 480 off-hire hours in June.'));
});
t('guard: a named in-scope vessel counts as the user\'s fleet', () => {
  assert.ok(containsStatedFigure('Aurora Trader averaged 9,400 kW in August.', ['Aurora Trader']));
  assert.ok(!containsStatedFigure('Aurora Trader averaged 9,400 kW in August.', []), 'without the name list this is just a sentence about some ship');
});
t('guard: arithmetic, general facts and general maritime facts PASS', () => {
  assert.ok(!containsStatedFigure('22 divided by 7 is 3.142857, a common approximation of pi.'));
  assert.ok(!containsStatedFigure('The Eiffel Tower is 330 m tall and weighs about 10,100 tonnes.'));
  assert.ok(!containsStatedFigure('A Panamax bulk carrier typically burns around 30 tonnes of fuel a day.'));
  assert.ok(!containsStatedFigure('Off-hire typically runs 2-5% for a well-run fleet.'));
  assert.ok(!containsStatedFigure('Cook it for 2 hours, then rest for 20 minutes.'));
  assert.ok(!containsStatedFigure('Go to Settings, then step 2, then Users.'));
  assert.ok(!containsStatedFigure('Happy to help with that!'));
});
t('chart protocol: a valid CHART line is extracted and removed from the text', () => {
  const r = extractChart('Here is the comparison.\nCHART {"type":"bar","title":"A vs B","labels":["A","B"],"values":[22,7],"unit":""}');
  assert.strictEqual(r.text, 'Here is the comparison.');
  assert.deepStrictEqual(r.chart.values, [22, 7]);
  assert.strictEqual(r.chart.type, 'bar');
});
t('chart protocol: malformed or mismatched specs are dropped, prose kept', () => {
  assert.strictEqual(extractChart('Text.\nCHART {not json').chart, null);
  assert.strictEqual(extractChart('Text.\nCHART {"labels":["A"],"values":[1,2]}').chart, null);
  assert.strictEqual(extractChart('Text.\nCHART {"labels":["A","B"],"values":[1,"x"]}').chart, null);
  assert.strictEqual(extractChart('Just text, no chart.').chart, null);
});
t('chart protocol: rejects absurd point counts', () => {
  const many = Array.from({ length: 30 }, (_, i) => i);
  assert.strictEqual(extractChart('T\nCHART ' + JSON.stringify({ labels: many.map(String), values: many })).chart, null);
});
t('guard: a blocked reply is swapped for the safe redirect, never shown raw', async () => {
  const out = await converse('what was my fuel consumption', {
    env: LLM_ENV,
    fetchImpl: ollamaStub('Your vessel burned 41.2 MT last month.'),
  });
  assert.strictEqual(out.blocked, true);
  assert.ok(!/41\.2/.test(out.text), 'the fabricated figure must never reach the user');
  assert.ok(/ask me directly/.test(out.text));
});
t('guard: a clean reply passes through unchanged', async () => {
  const out = await converse('hello', {
    env: LLM_ENV,
    fetchImpl: ollamaStub('Hello! How can I help you today?'),
  });
  assert.strictEqual(out.blocked, false);
  assert.strictEqual(out.text, 'Hello! How can I help you today?');
});
t('guard: with the model disabled, companion answers safely without calling out', async () => {
  const calls = [];
  const out = await converse('hello', { env: { CAPTAIN_ENABLE_LLM: '0' }, fetchImpl: async (...a) => { calls.push(a); throw new Error('should not be called'); } });
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(out.disabled, true);
});
t('guard: an unreachable model server degrades gracefully, never throws', async () => {
  const out = await converse('hello', { env: LLM_ENV, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.ok(/couldn.t reach/.test(out.text));
  assert.ok(!out.blocked);
});
t('provider: ollama request shape', () => {
  const cfg = readEnv(LLM_ENV);
  const req = buildRequest(cfg, 'SYS', [{ role: 'user', content: 'hi' }]);
  assert.strictEqual(req.url, 'http://llm.test:11434/api/chat');
  assert.strictEqual(req.body.messages[0].role, 'system');
  assert.strictEqual(req.body.stream, false);
  assert.strictEqual(req.extract({ message: { content: 'yo' } }), 'yo');
});
t('provider: openai-compatible request shape (vLLM / llama.cpp / LM Studio)', () => {
  const cfg = readEnv(Object.assign({}, LLM_ENV, { CAPTAIN_LLM_PROVIDER: 'openai_compat', CAPTAIN_LLM_URL: 'http://vllm.test:8000/' }));
  const req = buildRequest(cfg, 'SYS', [{ role: 'user', content: 'hi' }]);
  assert.strictEqual(req.url, 'http://vllm.test:8000/v1/chat/completions');
  assert.ok(!req.headers.Authorization, 'no auth header unless a local key is configured');
  assert.strictEqual(req.extract({ choices: [{ message: { content: 'yo' } }] }), 'yo');
});
t('provider: openai-compatible replies are guarded exactly like Ollama ones', async () => {
  const out = await converse('what was my fuel', {
    env: Object.assign({}, LLM_ENV, { CAPTAIN_LLM_PROVIDER: 'openai_compat' }),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Your fleet used about 41.2 MT.' } }] }) }),
  });
  assert.strictEqual(out.blocked, true);
  assert.ok(!/41\.2/.test(out.text));
});
// --- speed: the whole point of this tier ------------------------------------
t('instant: "what is today\'s date" is answered by the server clock, not a model', async () => {
  let modelCalls = 0;
  const out = await router.route(
    { text: "what is todays date ?", session: { userId: 'u', orgId: 'o', vesselIds: [] }, now: new Date('2026-09-03T18:45:00Z'), context: { tz: 'Asia/Kolkata' } },
    async () => { throw new Error('no db'); },
    { orgId: 'o', env: LLM_ENV, fetchImpl: async () => { modelCalls++; throw new Error('no model'); } });
  assert.strictEqual(out.source, 'instant');
  assert.strictEqual(out.text, 'Today is Friday, 4 September 2026.');
  assert.strictEqual(modelCalls, 0);
});
t('instant: arithmetic never reaches the model either', async () => {
  let modelCalls = 0;
  const out = await router.route({ text: 'what is 22/7', session: { userId: 'u', orgId: 'o', vesselIds: [] }, now: NOW },
    async () => { throw new Error('no db'); }, { orgId: 'o', env: LLM_ENV, fetchImpl: async () => { modelCalls++; throw new Error(); } });
  assert.strictEqual(out.source, 'instant');
  assert.ok(/3\.142857/.test(out.text));
  assert.strictEqual(modelCalls, 0);
});
t('grounding: the model is told the current date and time in the user\'s zone', () => {
  const p = systemPrompt({ appName: 'X', guideSnippets: [], nowLabel: 'Friday, 4 September 2026, 00:15 (Asia/Kolkata)' });
  assert.ok(/Current date and time: Friday, 4 September 2026, 00:15 \(Asia\/Kolkata\)/.test(p));
  assert.ok(/Never say you do not know the date or time/.test(p));
});
t('grounding: a companion call carries the current time in its system prompt', async () => {
  let systemSeen = '';
  const spy = async (url, init) => { const b = JSON.parse(init.body); systemSeen = b.messages.find((m) => m.role === 'system').content; return { ok: true, status: 200, json: async () => ({ message: { role: 'assistant', content: 'Sure.' } }) }; };
  await router.route({ text: 'is Friday a good day to sail', session: { userId: 'u', orgId: 'o', vesselIds: [] }, now: new Date('2026-09-03T18:45:00Z'), context: { tz: 'Asia/Kolkata' } },
    async () => { throw new Error('no db'); }, { orgId: 'o', env: LLM_ENV, fetchImpl: spy });
  assert.ok(/Current date and time: Friday, 4 September 2026/.test(systemSeen), 'prompt lacked the date: ' + systemSeen.slice(-300));
});

t('speed: a greeting is answered locally and NEVER sent to a model', async () => {
  let called = 0;
  const spy = async () => { called++; throw new Error('a model must not be called for a greeting'); };
  const out = await router.route({ text: 'hi', session: { userId: 'u', orgId: 'o', vesselIds: [] }, now: NOW },
    async () => { throw new Error('no db needed either'); },
    { orgId: 'o', env: LLM_ENV, fetchImpl: spy });
  assert.strictEqual(called, 0, 'the model was called for "hi"');
  assert.strictEqual(out.instant, true);
  assert.ok(out.text && out.text.length > 5);
});

t('speed: greetings resolve in single-digit milliseconds', async () => {
  const started = Date.now();
  for (const q of ['hi', 'hello', 'thanks', 'good night', 'how are you?', 'ok']) {
    const out = await router.route({ text: q, session: { userId: 'u', orgId: 'o', vesselIds: [] }, now: NOW },
      async () => { throw new Error('no db'); },
      { orgId: 'o', env: LLM_ENV, fetchImpl: async () => { throw new Error('no model'); } });
    assert.strictEqual(out.instant, true, q);
  }
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 100, 'six greetings took ' + elapsed + 'ms; they must be effectively instant');
});

t('speed: CAPTAIN_SMALLTALK_MODEL=1 opts back in to model-handled greetings', async () => {
  let called = 0;
  const env = Object.assign({}, LLM_ENV, { CAPTAIN_SMALLTALK_MODEL: '1' });
  const out = await router.route({ text: 'hi', session: { userId: 'u', orgId: 'o', vesselIds: [] }, now: NOW },
    async () => { throw new Error('no db'); },
    { orgId: 'o', env: env, fetchImpl: (u, i) => { called++; return ollamaStub('Hello there!')(u, i); } });
  assert.strictEqual(called, 1);
  assert.strictEqual(out.text, 'Hello there!');
});

t('speed: short questions use the fast model, substantial ones the strong model', () => {
  assert.ok(router.isLightMessage('what does CII stand for'));
  assert.ok(router.isLightMessage('capital of France'));
  assert.ok(!router.isLightMessage('explain FuelEU pooling and how it affects our fleet'));
  assert.ok(!router.isLightMessage('compare these two options and tell me which is better'));
  assert.ok(!router.isLightMessage('x'.repeat(200)));
});

t('speed: the fast tier swaps model, token budget and timeout together', () => {
  const cfg = readEnv(Object.assign({}, LLM_ENV, { CAPTAIN_LLM_PROVIDER: 'openai_compat', CAPTAIN_LLM_MODEL: 'strong', CAPTAIN_LLM_FAST_MODEL: 'fast' }));
  const lightReq = buildRequest(cfg, 'S', [], true);
  const heavyReq = buildRequest(cfg, 'S', [], false);
  assert.strictEqual(lightReq.body.model, 'fast');
  assert.strictEqual(heavyReq.body.model, 'strong');
  assert.ok(lightReq.body.max_tokens < heavyReq.body.max_tokens);
  assert.ok(cfg.fastTimeoutMs < cfg.timeoutMs);
});

t('speed: with no fast model configured, the light path still works on the main model', () => {
  const cfg = readEnv({ CAPTAIN_LLM_MODEL: 'only' });
  assert.strictEqual(buildRequest(cfg, 'S', [], true).body.model, 'only');
});

t('speed: a light request that hangs is abandoned on the SHORT timeout, not the long one', async () => {
  const env = Object.assign({}, LLM_ENV, { CAPTAIN_LLM_FAST_TIMEOUT_MS: '150', CAPTAIN_LLM_TIMEOUT_MS: '20000' });
  const started = Date.now();
  const out = await converse('what is CII', {
    env: env,
    light: true,
    fetchImpl: (url, init) => new Promise((_, rej) => {
      if (init && init.signal) init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
    }),
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, 'a hanging light request took ' + elapsed + 'ms; the short timeout did not apply');
  assert.ok(/couldn.t reach/.test(out.text));
  assert.ok(/timed out after 150ms/.test(out.error || ''), 'error should name the short budget: ' + out.error);
});

t('speed: light messages are told to answer briefly', () => {
  assert.ok(/answer it directly in one or two sentences/.test(systemPrompt({ appName: 'X', guideSnippets: [], light: true })));
  assert.ok(!/answer it directly in one or two sentences/.test(systemPrompt({ appName: 'X', guideSnippets: [], light: false })));
});

t('speed: OpenRouter is asked for LOW-effort reasoning (not "off", which mandatory-reasoning models reject); other servers are not sent unknown fields', () => {
  const cfgOR = readEnv(Object.assign({}, LLM_ENV, { CAPTAIN_LLM_PROVIDER: 'openai_compat', CAPTAIN_LLM_URL: 'https://openrouter.ai/api' }));
  const reqOR = buildRequest(cfgOR, 'SYS', [{ role: 'user', content: 'hi' }]);
  assert.deepStrictEqual(reqOR.body.reasoning, { effort: 'low', exclude: true });
  const cfgV = readEnv(Object.assign({}, LLM_ENV, { CAPTAIN_LLM_PROVIDER: 'openai_compat', CAPTAIN_LLM_URL: 'http://vllm.test:8000' }));
  assert.strictEqual(buildRequest(cfgV, 'SYS', []).body.reasoning, undefined);
  const cfgOn = readEnv(Object.assign({}, LLM_ENV, { CAPTAIN_LLM_PROVIDER: 'openai_compat', CAPTAIN_LLM_URL: 'https://openrouter.ai/api', CAPTAIN_LLM_REASONING: 'on' }));
  assert.strictEqual(buildRequest(cfgOn, 'SYS', []).body.reasoning, undefined);
});
t('system prompt: tells the model to answer general questions, and to disable thinking when reasoning is off', () => {
  const p = systemPrompt({ appName: 'Geo Monitor', guideSnippets: [], reasoningOff: true });
  assert.ok(/^\/no_think/.test(p));
  assert.ok(/Do not steer unrelated questions back to vessels/.test(p));
  assert.ok(/CHART \{/.test(p));
});
t('general question: a calculation answer with numbers passes the guard end to end', async () => {
  const out = await converse('divide 22 by 7', { env: LLM_ENV, fetchImpl: ollamaStub('22 / 7 = 3.142857 (recurring). It is a common approximation of pi.') });
  assert.strictEqual(out.blocked, false);
  assert.ok(/3\.142857/.test(out.text));
});
t('general question: a chart from user-supplied numbers comes back as data', async () => {
  const out = await converse('compare 120 and 150 as a chart', { env: LLM_ENV, fetchImpl: ollamaStub('150 is 25% more than 120.\nCHART {"type":"bar","title":"120 vs 150","labels":["first","second"],"values":[120,150],"unit":""}') });
  assert.strictEqual(out.blocked, false);
  assert.ok(!/CHART/.test(out.text), 'the CHART line must not leak into the prose');
  assert.deepStrictEqual(out.chart.values, [120, 150]);
});
t('system prompt: page context names the vessel without granting any figure', () => {
  const p = systemPrompt({ appName: 'Geo Monitor', guideSnippets: [], context: { vesselName: 'Aurora Trader' } });
  assert.ok(p.includes('"Aurora Trader"'));
  assert.ok(/you have no data about it/.test(p));
});
t('guard: an upstream failure never throws to the caller', async () => {
  const out = await converse('hello', { env: LLM_ENV, fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'boom' }) });
  assert.ok(/couldn.t reach/.test(out.text));
});
t('system prompt names the app and includes only the passed guide snippets', () => {
  const p = systemPrompt({ appName: 'Geo Monitor', guideSnippets: [{ title: 'Exporting', answer: 'Use the button.' }] });
  assert.ok(p.includes('Geo Monitor'));
  assert.ok(p.includes('Exporting: Use the button.'));
});

// --- router precedence (offline shape only; DB cases below) --------------------
t('briefing trigger phrases are recognised', () => {
  assert.ok(isBriefingRequest('anything I should know?'));
  assert.ok(isBriefingRequest('give me a briefing'));
  assert.ok(!isBriefingRequest('fuel consumption last month'));
});

(async () => {
  if (!process.env.CAPTAIN_TEST_URL) { finish(); return; }
  const db = new Client({ connectionString: process.env.CAPTAIN_TEST_URL });
  await db.connect();
  const session = { userId: 'u1', orgId: 'test-org', vesselIds: ['9851701'] };
  const wideSession = { userId: 'u1', orgId: 'test-org', vesselIds: ['9851701', '9234567'] };

  await ta('router: a data question never reaches the companion, even with an LLM stub wired', async () => {
    const out = await router.route(
      { text: 'shaft power for Aurora Trader on 15 August 2026', session, now: NOW },
      db, { orgId: 'test-org', env: LLM_ENV, fetchImpl: ollamaStub('should never be called') }
    );
    assert.strictEqual(out.source, 'data');
    assert.strictEqual(out.status, 'answer');
  });

  await ta('router: an ambiguous data question still clarifies through the engine, not the LLM', async () => {
    const out = await router.route({ text: 'what is my consumption?', session: { userId: 'u', orgId: 'o', vesselIds: ['9851701'] }, now: NOW }, db, { orgId: 'test-org', env: LLM_ENV });
    assert.strictEqual(out.source, 'data');
    assert.strictEqual(out.status, 'clarify');
  });

  await ta('router: app-navigation question is answered by the guide, not the LLM', async () => {
    const out = await router.route(
      { text: 'how do I export a report', session, now: NOW }, db,
      { orgId: 'test-org', env: LLM_ENV, fetchImpl: ollamaStub('should never be called') }
    );
    assert.strictEqual(out.source, 'guide');
    assert.ok(/Export button/.test(out.text));
  });

  await ta('router: briefing runs real SQL and includes a real vessel name', async () => {
    const out = await router.route({ text: 'anything I should know?', session: wideSession, now: NOW }, db, { orgId: 'test-org', env: {} });
    assert.strictEqual(out.source, 'briefing');
    assert.ok(Array.isArray(out.findings));
  });

  await ta('router: a greeting is answered instantly by the router, not the companion', async () => {
    const out = await router.route(
      { text: 'good morning captain', session, now: NOW }, db,
      { orgId: 'test-org', env: LLM_ENV, fetchImpl: ollamaStub('should never be called') }
    );
    assert.strictEqual(out.source, 'router', 'greetings must not reach a model');
    assert.strictEqual(out.instant, true);
  });

  await ta('router: a real (non-greeting) conversational question DOES reach the companion', async () => {
    const out = await router.route(
      { text: 'what is the capital of France', session, now: NOW }, db,
      { orgId: 'test-org', env: LLM_ENV, fetchImpl: ollamaStub('Paris.') }
    );
    assert.strictEqual(out.source, 'companion');
    assert.strictEqual(out.text, 'Paris.');
  });

  await ta('router: companion path never receives a db handle', async () => {
    let sawDb = false;
    const spyFetch = async (url, init) => {
      const body = JSON.parse(init.body);
      if (JSON.stringify(body).includes('vessel_id') || JSON.stringify(body).includes('SELECT')) sawDb = true;
      return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'Hi there.' }] }) };
    };
    await router.route({ text: 'hey there', session, now: NOW }, db, { orgId: 'test-org', env: LLM_ENV, fetchImpl: spyFetch });
    assert.strictEqual(sawDb, false, 'no SQL text should ever be constructible from the companion call');
  });

  await ta('router: with the LLM disabled, an unparsed question returns the honest data-side message', async () => {
    const out = await router.route({ text: 'zzz nonsense qqq', session, now: NOW }, db, { orgId: 'test-org', env: { CAPTAIN_ENABLE_LLM: '0' } });
    assert.strictEqual(out.source, 'data');
    assert.strictEqual(out.status, 'unparsed');
  });

  await ta('alerts: buildBriefing finds the seeded compliance deficit', async () => {
    const scope = { vesselIds: ['9851701', '9234567'], vessels: [{ name: 'Aurora Trader' }, { name: 'Northern Pearl' }] };
    const b = await buildBriefing(scope.vesselIds, scope.vessels.map((v) => v.name), db);
    assert.ok(b.findings.some((f) => f.kind === 'compliance_deficit' || f.kind === 'compliance_declining'), JSON.stringify(b.findings));
  });

  await ta('alerts: removing off-hire drops the off-hire finding for that vessel', async () => {
    await db.query("DELETE FROM veson_offhire WHERE imo = '9345678'");
    const b = await buildBriefing(['9345678'], ['Kaveri Star'], db);
    assert.ok(!b.findings.some((f) => f.kind === 'offhire_high'));
  });
  await ta('alerts: a vessel with genuinely nothing to flag gets a clean bill', async () => {
    await db.query("DELETE FROM veson_legs WHERE imo='9345678'; DELETE FROM veson_offhire WHERE imo='9345678';");
    const b = await buildBriefing(['9345678'], ['Kaveri Star'], db);
    assert.strictEqual(b.findings.length, 0);
    assert.ok(/Nothing flagged/.test(b.text));
  });

  // --- lazy database: only data-shaped messages may touch it --------------------
  await ta('router: a greeting opens no database connection and calls no model', async () => {
    let opened = 0, modelCalls = 0;
    const spyDb = async () => { opened++; return db; };
    const out = await router.route({ text: 'hi there', session, now: NOW }, spyDb,
      { orgId: 'test-org', env: LLM_ENV, fetchImpl: async () => { modelCalls++; throw new Error('no model for greetings'); } });
    assert.strictEqual(out.source, 'router');
    assert.strictEqual(opened, 0, 'greeting must not call getDb');
    assert.strictEqual(modelCalls, 0, 'greeting must not call a model');
  });
  await ta('router: an app-guide question never opens a database connection', async () => {
    let opened = 0;
    const spyDb = async () => { opened++; return db; };
    const out = await router.route({ text: 'how do I export a report', session, now: NOW }, spyDb, { orgId: 'test-org', env: LLM_ENV });
    assert.strictEqual(out.source, 'guide');
    assert.strictEqual(opened, 0);
  });
  await ta('router: a data question does open the database, exactly once', async () => {
    let opened = 0;
    const spyDb = async () => { opened++; return db; };
    const out = await router.route({ text: 'shaft power for Aurora Trader on 15 August 2026', session, now: NOW }, spyDb, { orgId: 'test-org', env: LLM_ENV });
    assert.strictEqual(out.source, 'data');
    assert.strictEqual(out.status, 'answer');
    assert.strictEqual(opened, 1);
  });
  await ta('router: with the database DOWN, a greeting still gets a normal reply', async () => {
    const downDb = async () => { const e = new Error('connect ECONNREFUSED'); throw e; };
    const out = await router.route({ text: 'hello captain', session, now: NOW }, downDb, { orgId: 'test-org', env: { CAPTAIN_ENABLE_LLM: '0' } });
    assert.strictEqual(out.status, 'answer');
    assert.ok(!/database/.test(out.text));
  });
  await ta('router: with the database DOWN, a data question gets a plain, actionable error', async () => {
    const downDb = async () => { throw new Error('connect ECONNREFUSED'); };
    const out = await router.route({ text: 'fuel consumption for Aurora Trader last month', session, now: NOW }, downDb, { orgId: 'test-org', env: { CAPTAIN_ENABLE_LLM: '0' } });
    assert.strictEqual(out.status, 'error');
    assert.strictEqual(out.reason, 'db_unreachable');
    assert.ok(!/\d{3,}/.test(out.text), 'error text must not contain a figure');
  });
  await ta('router: with the database NOT CONFIGURED, the message says so specifically', async () => {
    const noDb = async () => { const e = new Error('no url'); e.code = 'DB_NOT_CONFIGURED'; throw e; };
    const out = await router.route({ text: 'anything I should know?', session, now: NOW }, noDb, { orgId: 'test-org', env: {} });
    assert.strictEqual(out.reason, 'db_not_configured');
    assert.ok(/not configured/.test(out.text));
  });
  await ta('router: a learned-only term is still routed to data when the DB is reachable', async () => {
    const termsMod = require('../src/terms');
    router.clearLearnedCache();
    await termsMod.saveMapping(db, { orgId: 'test-org', term: 'juice', metricKey: 'fuel_consumption' });
    const out = await router.route({ text: 'juice for Aurora Trader last month', session, now: NOW }, async () => db, { orgId: 'test-org', env: LLM_ENV, fetchImpl: ollamaStub('should not be called') });
    assert.strictEqual(out.source, 'data', 'a taught word must reach the engine, not the companion');
    await termsMod.forgetMapping(db, { orgId: 'test-org', term: 'juice' });
    router.clearLearnedCache();
  });
  await ta('router: "help" is answered from config with no database', async () => {
    let opened = 0;
    const out = await router.route({ text: 'help', session, now: NOW }, async () => { opened++; return db; }, { orgId: 'test-org', env: {} });
    assert.strictEqual(out.status, 'help');
    assert.ok(Array.isArray(out.metrics) && out.metrics.length > 5);
    assert.strictEqual(opened, 0);
  });

  await ta('charts: comparing two named vessels returns one figure each plus bar-chart data from SQL', async () => {
    const out = await router.route({ text: 'compare fuel consumption for Aurora Trader and Northern Pearl last month', session: wideSession, now: NOW }, db, { orgId: 'test-org', env: { CAPTAIN_ENABLE_LLM: '0' } });
    assert.strictEqual(out.source, 'data');
    assert.strictEqual(out.status, 'answer');
    assert.ok(out.chart && out.chart.type === 'bar' && out.chart.values.length === 2, JSON.stringify(out.chart));
    // each bar must equal an independent SQL total for that vessel
    for (let i = 0; i < out.chart.labels.length; i++) {
      const imo = out.chart.labels[i] === 'Aurora Trader' ? '9851701' : '9234567';
      const { rows } = await db.query(`SELECT SUM(fuel_consumed_mt)::double precision s FROM geoform_reports WHERE imo=$1 AND report_date BETWEEN '2026-08-01' AND '2026-08-31'`, [imo]);
      assert.ok(Math.abs(out.chart.values[i] - rows[0].s) < 1e-6, out.chart.labels[i]);
    }
  });
  await ta('charts: a two-period comparison also carries bar-chart data', async () => {
    const out = await router.route({ text: 'compare fuel consumption for Aurora Trader this month vs last month', session: wideSession, now: NOW }, db, { orgId: 'test-org', env: { CAPTAIN_ENABLE_LLM: '0' } });
    assert.ok(out.chart && out.chart.values.length === 2);
    assert.strictEqual(out.chart.values[0], out.comparison.a.value);
  });
  await ta('charts: a companion chart is passed through to the client', async () => {
    const out = await router.route({ text: 'compare 120 and 150', session, now: NOW }, db, { orgId: 'test-org', env: LLM_ENV, fetchImpl: ollamaStub('150 is 25% more.\nCHART {"type":"bar","labels":["a","b"],"values":[120,150]}') });
    assert.strictEqual(out.source, 'companion');
    assert.deepStrictEqual(out.chart.values, [120, 150]);
  });

  await ta('context: an unqualified question defaults to the vessel on screen', async () => {
    const out = await router.route(
      { text: 'shaft power on 15 August 2026', session: wideSession, now: NOW, context: { vesselId: '9234567', vesselName: 'Northern Pearl' } },
      db, { orgId: 'test-org', env: { CAPTAIN_ENABLE_LLM: '0' } }
    );
    assert.strictEqual(out.status, 'answer', out.text);
    assert.deepStrictEqual(out.provenance.vessels, ['Northern Pearl']);
  });
  await ta('context: naming another vessel overrides the page context', async () => {
    const out = await router.route(
      { text: 'shaft power for Aurora Trader on 15 August 2026', session: wideSession, now: NOW, context: { vesselId: '9234567', vesselName: 'Northern Pearl' } },
      db, { orgId: 'test-org', env: { CAPTAIN_ENABLE_LLM: '0' } }
    );
    assert.deepStrictEqual(out.provenance.vessels, ['Aurora Trader']);
  });
  await ta('context: an out-of-scope vessel id in the page context is ignored, never trusted', async () => {
    const out = await router.route(
      { text: 'shaft power on 15 August 2026', session: { userId: 'u', orgId: 'o', vesselIds: ['9851701'] }, now: NOW, context: { vesselId: '9345678', vesselName: 'Kaveri Star' } },
      db, { orgId: 'test-org', env: { CAPTAIN_ENABLE_LLM: '0' } }
    );
    // Single-vessel scope: resolves to the one vessel the user may see, not the one the page claimed.
    assert.strictEqual(out.status, 'answer');
    assert.deepStrictEqual(out.provenance.vessels, ['Aurora Trader']);
  });

  await db.end();
  finish();
})();

function finish() {
  console.log(`\nCompanion: ${passed} passed, ${fails.length} failed`);
  fails.forEach((f) => console.log('  FAIL ' + f));
  process.exit(fails.length ? 1 : 0);
}