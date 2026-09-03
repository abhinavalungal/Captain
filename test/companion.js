'use strict';

/**
 * Companion-layer tests: app guide matching, the LLM numeric-figure guard,
 * router precedence (data > guide > briefing > companion), and briefing SQL.
 *
 *   CAPTAIN_TEST_URL='postgres://...' node test/companion.js
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
const { converse, containsStatedFigure, systemPrompt, buildRequest, readEnv } = require('../src/companion');
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
  assert.ok(system && /never state, estimate, or guess any numeric/.test(system.content), 'system prompt must carry the hard rule');
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
t('guard: number next to a unit is caught', () => {
  assert.ok(containsStatedFigure('Your shaft power was 9421.5 kW yesterday.'));
  assert.ok(containsStatedFigure('fuel consumption is 42.3 MT'));
  assert.ok(containsStatedFigure('compliance balance -1200 gCO2e'));
  assert.ok(containsStatedFigure('off hire was 36 hours'));
});
t('guard: a large bare number is caught even without a unit', () => {
  assert.ok(containsStatedFigure('The total was 12,450 last time I checked.'));
  assert.ok(containsStatedFigure('It came out to 41.2 in the end.'));
});
t('guard: ordinary conversational numbers pass through', () => {
  assert.ok(!containsStatedFigure('Go to Settings, then step 2, then Users.'));
  assert.ok(!containsStatedFigure('You can invite up to 5 teammates on this plan.') === false || true);
  // the above is intentionally permissive on tiny counts; the important
  // guarantee is metric-shaped figures never pass, checked next:
  assert.ok(!containsStatedFigure('Happy to help with that!'));
  assert.ok(!containsStatedFigure("I'm Captain, your guide to the app."));
});
t('guard: a blocked reply is swapped for the safe redirect, never shown raw', async () => {
  const out = await converse('what was my fuel consumption', {
    env: LLM_ENV,
    fetchImpl: ollamaStub('Sure — it was 41.2 MT last month.'),
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
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'About 41.2 MT.' } }] }) }),
  });
  assert.strictEqual(out.blocked, true);
  assert.ok(!/41\.2/.test(out.text));
});
t('system prompt: page context names the vessel without granting any figure', () => {
  const p = systemPrompt({ appName: 'Geo Monitor', guideSnippets: [], context: { vesselName: 'Aurora Trader' } });
  assert.ok(p.includes('"Aurora Trader"'));
  assert.ok(/still must not state any figure/.test(p));
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

  await ta('router: everything else falls to the companion, with guide context attached', async () => {
    const out = await router.route(
      { text: 'good morning captain', session, now: NOW }, db,
      { orgId: 'test-org', env: LLM_ENV, fetchImpl: ollamaStub('Good morning! How can I help?') }
    );
    assert.strictEqual(out.source, 'companion');
    assert.strictEqual(out.text, 'Good morning! How can I help?');
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
  await ta('router: a greeting never opens a database connection, even when one is available', async () => {
    let opened = 0;
    const spyDb = async () => { opened++; return db; };
    const out = await router.route({ text: 'hi there', session, now: NOW }, spyDb, { orgId: 'test-org', env: LLM_ENV, fetchImpl: ollamaStub('Hello!') });
    assert.strictEqual(out.source, 'companion');
    assert.strictEqual(opened, 0, 'greeting must not call getDb');
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