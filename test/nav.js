'use strict';
/**
 * Captain Nav tests — identity, name memory, unit conversion, follow-up
 * inheritance and their routing. Entirely offline: no database, no model.
 *
 *   node test/nav_test.js
 */
const assert = require('assert');
const identity = require('../src/identity');
const { tryConversion, answerInstant } = require('../src/instant_src');
const router = require('../src/router');
const { systemPrompt } = require('../src/companion_src');

let passed = 0; const fails = [];
const t = (n, f) => { try { f(); passed++; } catch (e) { fails.push(n + ': ' + e.message); } };
const ta = async (n, f) => { try { await f(); passed++; } catch (e) { fails.push(n + ': ' + e.message); } };

const NOW = new Date('2026-09-02T10:00:00Z');
const NO_DB = async () => { throw new Error('no db should be needed'); };
const NO_MODEL = async () => { throw new Error('no model should be called'); };
const LLM_ENV = { CAPTAIN_ENABLE_LLM: '1', CAPTAIN_LLM_URL: 'http://llm.test:11434', CAPTAIN_LLM_MODEL: 'llama3.1:8b', CAPTAIN_APP_NAME: 'Geo Monitor' };
const session = { userId: 'u', orgId: 'o', vesselIds: [] };
const route = (text, extra, opts) => router.route(
  Object.assign({ text, session, now: NOW }, extra || {}),
  NO_DB,
  Object.assign({ orgId: 'o', env: LLM_ENV, fetchImpl: NO_MODEL }, opts || {})
);

// --- identity ----------------------------------------------------------------
t('identity: "what is your name" introduces Captain Nav and asks back', () => {
  const a = identity.answerIdentity("what's your name?", {});
  assert.ok(/Captain Nav/.test(a.text));
  assert.ok(/What's your name\?/.test(a.text));
  assert.deepStrictEqual(a.pending, { kind: 'name' });
});
t('identity: with a known user, it does not ask again', () => {
  const a = identity.answerIdentity('who are you', { userName: 'Priya' });
  assert.ok(/Captain Nav/.test(a.text));
  assert.ok(/Priya/.test(a.text));
  assert.strictEqual(a.pending, undefined);
});
t('identity: "my name is X" is captured and remembered', () => {
  const a = identity.answerIdentity('my name is nav', {});
  assert.deepStrictEqual(a.remember, { userName: 'Nav' });
  assert.ok(/Nav/.test(a.text));
});
t('identity: "hi, I\'m Priya Sharma" is captured with both words title-cased', () => {
  const a = identity.answerIdentity("hi, I'm priya sharma", {});
  assert.deepStrictEqual(a.remember, { userName: 'Priya Sharma' });
});
t('identity: "i\'m tired" / "i am looking for fuel data" are NOT names', () => {
  assert.strictEqual(identity.answerIdentity("i'm tired", {}), null);
  assert.strictEqual(identity.answerIdentity('i am looking for fuel data', {}), null);
  assert.strictEqual(identity.answerIdentity("i'm not sure", {}), null);
});
t('identity: "what\'s my name" answers from memory, or asks', () => {
  assert.ok(/You're Nav/.test(identity.answerIdentity("what's my name?", { userName: 'Nav' }).text));
  const unknown = identity.answerIdentity('do you remember my name', {});
  assert.ok(/haven't told me/.test(unknown.text));
  assert.deepStrictEqual(unknown.pending, { kind: 'name' });
});
t('identity: a bare name answers the pending question; a decline is respected', () => {
  const a = identity.resolveNameReply('Nav', {});
  assert.deepStrictEqual(a.remember, { userName: 'Nav' });
  const d = identity.resolveNameReply('rather not say', {});
  assert.ok(!d.remember);
  assert.ok(/No trouble/.test(d.text));
});
t('identity: a pending name does not swallow an unrelated question', () => {
  assert.strictEqual(identity.resolveNameReply('what time is it?', {}), null);
  assert.strictEqual(identity.resolveNameReply('fuel consumption last month please', {}), null);
});

// --- conversions ---------------------------------------------------------------
t('convert: maritime units, exact factors', () => {
  assert.strictEqual(tryConversion('10 knots to km/h').text, '10 knots = 18.52 km/h (1 kn = 1.852 km/h)');
  assert.ok(/15,556\.8 km/.test(tryConversion('8400 nm in km').text));
  assert.ok(/12 MW/.test(tryConversion('convert 12000 kw to mw').text));
  assert.ok(/1,102,311/.test(tryConversion('500 mt to lbs').text));
  assert.strictEqual(tryConversion('25 c to f').text, '25 °C = 77 °F');
});
t('convert: mismatched dimensions are refused, not guessed', () => {
  assert.ok(/can't convert/.test(tryConversion('10 knots to kg').text));
});
t('convert: a data question that merely mentions a unit is untouched', () => {
  assert.strictEqual(tryConversion('fuel consumption in mt last week'), null);
  assert.strictEqual(tryConversion('total fuel in mt for Aurora Trader'), null);
});
t('convert: reachable through answerInstant with question phrasing', () => {
  assert.ok(/18\.52/.test(answerInstant('what is 10 knots in kmh', { now: NOW }).text));
});

// --- router integration ----------------------------------------------------------
(async () => {
  await ta('router: name question is instant — no DB, no model', async () => {
    const out = await route("what's your name?");
    assert.strictEqual(out.source, 'identity');
    assert.strictEqual(out.instant, true);
    assert.ok(/Captain Nav/.test(out.text));
    assert.deepStrictEqual(out.pending, { kind: 'name' });
  });
  await ta('router: bare name answers the pending name question and is remembered', async () => {
    const out = await route('Nav', { pending: { kind: 'name' } });
    assert.strictEqual(out.source, 'identity');
    assert.deepStrictEqual(out.remember, { userName: 'Nav' });
  });
  await ta('router: with a pending name, a data question still routes as data (DB error path)', async () => {
    const out = await route('shaft power yesterday', { pending: { kind: 'name' } });
    assert.strictEqual(out.source, 'router');
    assert.strictEqual(out.reason, 'db_unreachable');
  });
  await ta('router: greeting is personalised once the widget knows the name', async () => {
    const out = await route('hello', { context: { userName: 'Nav' } });
    assert.strictEqual(out.instant, true);
    assert.ok(/,\sNav[.!]/.test(out.text), out.text);
  });
  await ta('router: a conversion is instant', async () => {
    const out = await route('convert 10 knots to km/h');
    assert.strictEqual(out.source, 'instant');
    assert.strictEqual(out.kind, 'conversion');
  });
  await ta('router: "who are you" never reaches the guide or the model', async () => {
    const out = await route('who are you?');
    assert.strictEqual(out.source, 'identity');
  });
  await ta('router: "introduce yourself" goes to the guide, which now says Captain Nav', async () => {
    const out = await route('introduce yourself');
    assert.strictEqual(out.source, 'guide');
    assert.ok(/Captain Nav/.test(out.text));
  });

  // --- follow-up inheritance -----------------------------------------------------
  await ta('follow-up: "and last week?" inherits the previous data question', async () => {
    const rewritten = router.followUpRewrite('and last week?', [
      { role: 'user', text: 'hi' },
      { role: 'user', text: 'fuel consumption for Aurora Trader last month' },
    ], NOW);
    assert.strictEqual(rewritten, 'fuel consumption for Aurora Trader last week');
  });
  await ta('follow-up: "what about this year" works too', async () => {
    const rewritten = router.followUpRewrite('what about this year', [
      { role: 'user', text: 'shaft power yesterday' },
    ], NOW);
    assert.strictEqual(rewritten, 'shaft power year to date');
  });
  await ta('follow-up: a substantive new question is NOT hijacked', async () => {
    assert.strictEqual(router.followUpRewrite('how did last week compare to the forecast', [
      { role: 'user', text: 'fuel consumption last month' },
    ], NOW), null);
    assert.strictEqual(router.followUpRewrite('and last week?', [
      { role: 'user', text: 'tell me a joke' },
    ], NOW), null, 'no prior data question, no rewrite');
    assert.strictEqual(router.followUpRewrite('and last week?', [], NOW), null);
  });
  await ta('follow-up: routed answers carry the rewritten question in `interpreted`', async () => {
    let asked = null;
    const fakeDb = { query: async () => ({ rows: [] }) };
    const engine = require('../src/engine');
    const origAsk = engine.ask;
    engine.ask = async (input) => { asked = input.text; return { status: 'answer', text: 'ok' }; };
    try {
      const out = await router.route(
        { text: 'and last week?', session, now: NOW, history: [{ role: 'user', text: 'fuel consumption last month' }] },
        async () => fakeDb, { orgId: 'o', env: LLM_ENV, fetchImpl: NO_MODEL }
      );
      assert.strictEqual(asked, 'fuel consumption last week');
      assert.strictEqual(out.interpreted, 'fuel consumption last week');
      assert.strictEqual(out.source, 'data');
    } finally { engine.ask = origAsk; }
  });

  // --- companion grounding ----------------------------------------------------------
  t('companion: system prompt names Captain Nav and, when known, the user', () => {
    const p = systemPrompt({ appName: 'Geo Monitor', guideSnippets: [], userName: 'Nav' });
    assert.ok(/You are Captain Nav/.test(p));
    assert.ok(/user's name is Nav/.test(p));
    const anon = systemPrompt({ appName: 'Geo Monitor', guideSnippets: [] });
    assert.ok(!/user's name/.test(anon));
  });
  await ta('companion: the model is told the user\'s name via context.userName', async () => {
    let systemSeen = '';
    const spy = async (url, init) => {
      const b = JSON.parse(init.body);
      systemSeen = b.messages.find((m) => m.role === 'system').content;
      assert.strictEqual(b.keep_alive, '30m', 'Ollama keep_alive must be set so the model stays resident');
      return { ok: true, status: 200, json: async () => ({ message: { role: 'assistant', content: 'Aye.' } }) };
    };
    await router.route(
      { text: 'is friday a good day to sail', session, now: NOW, context: { userName: 'Nav', tz: 'Asia/Kolkata' } },
      NO_DB, { orgId: 'o', env: LLM_ENV, fetchImpl: spy }
    );
    assert.ok(/name is Nav/.test(systemSeen));
  });

  // --- httpHandler pass-through ------------------------------------------------------
  await ta('http: context.userName survives the handler whitelist end to end', async () => {
    const handler = require('../src/httpHandler');
    const env = { CAPTAIN_DEV_SESSION: '1', CAPTAIN_ENABLE_LLM: '0' };
    const token = Buffer.from(JSON.stringify({ sub: 'x', departments: ['Emission'] })).toString('base64');
    const r = await handler.handleCaptain({
      method: 'POST',
      headers: { authorization: 'Bearer ' + token },
      body: JSON.stringify({ text: 'hello', context: { userName: 'Nav' } }),
      env,
    });
    assert.strictEqual(r.statusCode, 200);
    const b = JSON.parse(r.body);
    assert.ok(/,\sNav[.!]/.test(b.text), 'greeting should be personalised: ' + b.text);
  });
  await ta('http: "what\'s your name" over HTTP shape is 200, instant, no database needed', async () => {
    const handler = require('../src/httpHandler');
    const env = { CAPTAIN_DEV_SESSION: '1', CAPTAIN_ENABLE_LLM: '0' };
    const token = Buffer.from(JSON.stringify({ sub: 'x', departments: ['Emission'] })).toString('base64');
    const r = await handler.handleCaptain({
      method: 'POST', headers: { authorization: 'Bearer ' + token },
      body: JSON.stringify({ text: "what's your name?" }), env,
    });
    assert.strictEqual(r.statusCode, 200);
    const b = JSON.parse(r.body);
    assert.ok(/Captain Nav/.test(b.text));
    assert.deepStrictEqual(b.pending, { kind: 'name' });
  });

  // --- intent robustness: the screenshot cases -------------------------------
  // Every one of these previously fell through to the model (and in the
  // deployment, to a 500). All must be answered locally: NO_DB throws if the
  // database is touched, NO_MODEL throws if the model is called.
  await ta('typo "whats you name >?" is identity, never the model', async () => {
    const r = await route('whats you name >?');
    assert.strictEqual(r.source, 'identity');
    assert.ok(/Captain Nav/.test(r.text));
  });
  await ta('"wat is ur name" and "who r u??" are identity', async () => {
    for (const q of ['wat is ur name', 'who r u??']) {
      const r = await route(q);
      assert.strictEqual(r.source, 'identity', q + ' -> ' + r.source);
    }
  });
  await ta('"what you can do ?" gets the capability answer locally, instant', async () => {
    const r = await route('what you can do ?');
    assert.strictEqual(r.source, 'guide');
    assert.strictEqual(r.instant, true);
    assert.ok(/Captain Nav/.test(r.text));
  });
  await ta('"what can you do" still returns the metric list (help), unchanged', async () => {
    const r = await route('what can you do');
    assert.strictEqual(r.status, 'help');
    assert.ok(Array.isArray(r.metrics) && r.metrics.length);
  });
  await ta('number comparison with visualization is instant and carries a bar chart', async () => {
    const r = await route('Can you visualize a comparison of which number is bigger, 2 or 19?');
    assert.strictEqual(r.source, 'instant');
    assert.ok(/19 is bigger than 2/.test(r.text), r.text);
    assert.ok(r.chart && r.chart.type === 'bar', 'chart missing');
    assert.deepStrictEqual(r.chart.values, [2, 19]);
  });
  await ta('"which is smaller, 7 or 3?" answered instantly, no chart when none asked', async () => {
    const r = await route('which is smaller, 7 or 3?');
    assert.strictEqual(r.source, 'instant');
    assert.ok(/3 is smaller than 7/.test(r.text), r.text);
    assert.strictEqual(r.chart, undefined);
  });
  t('"compare fuel consumption 2024 vs 2025" is NOT claimed as a number comparison', () => {
    assert.strictEqual(answerInstant('compare fuel consumption 2024 vs 2025'), null);
    assert.strictEqual(answerInstant('compare speed of 2 vessels'), null);
    assert.strictEqual(answerInstant('which vessel is bigger'), null);
  });
  t('http: 500 fallback text no longer blames vessel data', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'httpHandler.js'), 'utf8');
    assert.ok(!/Something went wrong reading the vessel data/.test(src));
    assert.ok(/Something went wrong on my side/.test(src));
  });

  console.log(`\nCaptain Nav: ${passed} passed, ${fails.length} failed`);
  fails.forEach((f) => console.log('  FAIL ' + f));
  process.exit(fails.length ? 1 : 0);
})();