'use strict';
/**
 * Conversation-context benchmark: does K.R.1.S answer the question being
 * asked NOW, in short, long and tangled conversations?
 *
 *   node test/context_test.js                 offline: scripted model, fake DB
 *   KRIS_EVAL_LIVE=1 node test/context_test.js
 *                                             also run the conversations
 *                                             against the configured model
 *                                             (KRIS_LLM_API_KEY etc.) and
 *                                             score what it actually says
 *
 * Offline, the model is a recorder: it answers "ANSWER <latest message>" and
 * keeps every request, so each scenario can check what reached the model (the
 * latest message last, the right one-line frame, a bounded history) and what
 * came back (no stale clarification, no repeat, no open question left over).
 */
const assert = require('assert');
const router = require('../src/router');
const { analyseTurn, repeatsRecent, modelHistory, knownFigures } = require('../src/turn');
const { containsStatedFigure } = require('../src/companion_src');

const NOW = new Date('2026-09-03T06:30:00Z');
const session = { userId: 'u', orgId: 'o', vesselIds: ['v1', 'v2'] };
const ENV = { KRIS_MODE: 'agent', KRIS_LLM_URL: 'https://openrouter.ai/api', KRIS_LLM_MODEL: 'test/model', KRIS_LLM_API_KEY: 'sk-test', KRIS_APP_NAME: 'Shuddha now' };

let passed = 0; const fails = [];
const ta = async (n, f) => { try { await f(); passed++; } catch (e) { fails.push(n + ': ' + e.message); } };

// Two vessels, so a figure without a vessel genuinely needs "which vessel?".
function fakeDb() {
  return {
    query: async (sql) => {
      if (/\bAS id\b[\s\S]*\bAS name\b/i.test(sql)) return { rows: [{ id: 'v1', name: 'Aurora Trader' }, { id: 'v2', name: 'Blue Star' }] };
      return { rows: [{ bucket: null, value: 12.5, n: 7 }] };
    },
  };
}

/** A model that answers the latest message, or follows a script; records every request. */
function recorder(script) {
  const seen = [];
  const impl = async function (url, init) {
    const body = JSON.parse(init.body);
    seen.push(body);
    const scripted = script && script[Math.min(seen.length - 1, script.length - 1)];
    const users = body.messages.filter((m) => m.role === 'user');
    const msg = scripted || { role: 'assistant', content: 'ANSWER ' + users[users.length - 1].content };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: msg }] }), text: async () => '' };
  };
  impl.seen = seen;
  return impl;
}

const say = (content) => ({ role: 'assistant', content });
const tool = (name, args, id) => ({ role: 'assistant', content: '', tool_calls: [{ id: id || 'c1', type: 'function', function: { name, arguments: JSON.stringify(args || {}) } }] });

async function ask(text, extra, script) {
  const fetchImpl = recorder(script);
  const out = await router.route(
    Object.assign({ text, session, now: NOW, history: [], context: {} }, extra || {}),
    async () => fakeDb(),
    { orgId: 'o', env: ENV, fetchImpl, disableLog: true }
  );
  const req = fetchImpl.seen[0] || null;
  const system = req ? req.messages[0].content : '';
  const last = req ? req.messages[req.messages.length - 1] : null;
  return { out, req, seen: fetchImpl.seen, system, last };
}

const U = (text) => ({ role: 'user', text });
const A = (text) => ({ role: 'assistant', text });
const CO2_Q = 'Which measurement do you mean by "co2"?';
const CO2_PENDING = { kind: 'clarify', originalText: 'What was the CO2 for Aurora Trader last week?', field: 'metricKey' };
const STEPS = '1. Collect fuel and activity data. 2. Validate source documents (BDNs, logs). 3. Calculate emissions with the emission factors. 4. Cross-check against voyage data. 5. Review exceptions. 6. Finalise the report. 7. Submit the verified figures.';

// ---------------------------------------------------------------------------
// 1. Labelled turns: transition + intent, no model, no database
// ---------------------------------------------------------------------------

const STEPS_H = [U('What are the steps to verify emissions?'), A(STEPS)];
const POOL_H = [U('Tell me about FuelEU pooling.'), A('FuelEU pooling lets ships combine their compliance balances...')];
const CLAR_H = [U('What was the CO2 for Aurora Trader last week?'), A(CO2_Q)];

const LABELLED = [
  // [text, history, pending, kind, intent]   intent: concept | lookup | other
  ['What are the steps to verify and report emissions?', [], null, 'new', 'concept'],
  ['What are the steps to verify and report emissions?', CLAR_H, CO2_PENDING, 'new', 'concept'],
  ['CO2 emitted.', CLAR_H, CO2_PENDING, 'answer', 'lookup'],
  ['co2', CLAR_H, CO2_PENDING, 'answer', 'lookup'],
  ['Leg CO2 please', CLAR_H, CO2_PENDING, 'answer', 'lookup'],
  ['What are the steps?', CLAR_H, CO2_PENDING, 'new', 'concept'],
  ['never mind', CLAR_H, CO2_PENDING, 'correction', 'other'],
  ['Explain step 3.', STEPS_H, null, 'follow_up', 'concept'],
  ['What about the second step?', STEPS_H, null, 'follow_up', 'other'],
  ['Why?', STEPS_H, null, 'follow_up', 'concept'],
  ['What happens after that?', STEPS_H, null, 'follow_up', 'other'],
  ['Can you give me an example?', STEPS_H, null, 'follow_up', 'concept'],
  ['Explain that more.', STEPS_H, null, 'follow_up', 'concept'],
  ['How does EU MRV reporting work?', POOL_H, null, 'new', 'concept'],
  ['What is FuelEU pooling?', STEPS_H, null, 'new', 'concept'],
  ['No, that\'s not what I\'m asking.\n\nI want to know how BDN validation works.', STEPS_H, null, 'correction', 'concept'],
  ['Ignore that. How is CII calculated?', STEPS_H, null, 'correction', 'concept'],
  ['I meant the leg emissions for Blue Star', POOL_H, null, 'correction', 'lookup'],
  ['What is CO2 emitted?', [], null, 'new', 'concept'],
  ['how is fuel consumption calculated?', [], null, 'new', 'concept'],
  ['What is the difference between CO2 and GHG intensity?', [], null, 'new', 'concept'],
  ['What does speed over ground mean?', [], null, 'new', 'concept'],
  ['shaft power yesterday', [], null, 'new', 'lookup'],
  ['fuel consumption for Aurora Trader last month', POOL_H, null, 'new', 'lookup'],
  ['what is the co2 of aurora trader last week', [], null, 'new', 'lookup'],
  ['how did fuel consumption change last month', [], null, 'new', 'lookup'],
  ['compare shaft power this month vs last month for Blue Star', STEPS_H, null, 'new', 'lookup'],
  ['and last week?', [U('fuel consumption for Aurora Trader last month'), A('Aurora Trader used 412 MT.')], null, 'follow_up', 'other'],
  ['name = "Nav"\nage = 25\n\nprint(name)\nprint(age)', CLAR_H, CO2_PENDING, 'new', 'other'],
  ['Please answer my question.', [U('What are the steps?'), A(CO2_Q)], null, 'new', 'other'],
  ['tell me a joke about tankers', STEPS_H, null, 'new', 'other'],
];

function intentOf(t) { return t.concept ? 'concept' : t.lookup ? 'lookup' : 'other'; }

const metrics = { transition: [0, 0], intent: [0, 0], context: [0, 0], clarify: [0, 0], repetition: [0, 0], topic: [0, 0], guard: [0, 0] };
const score = (k, ok) => { metrics[k][0] += ok ? 1 : 0; metrics[k][1] += 1; return ok; };

for (const [text, history, pending, kind, intent] of LABELLED) {
  const t = analyseTurn({ text, history, pending, now: NOW });
  const okKind = score('transition', t.kind === kind);
  const okIntent = score('intent', intentOf(t) === intent);
  if (!okKind || !okIntent) fails.push('labelled: ' + JSON.stringify(text.slice(0, 60)) + ' -> ' + t.kind + '/' + intentOf(t) + ', expected ' + kind + '/' + intent);
  else passed++;
}

// ---------------------------------------------------------------------------
// 2. Conversations end to end (router -> engine / agent)
// ---------------------------------------------------------------------------

(async () => {
  // --- Test 1: new question after a clarification -------------------------
  await ta('T1 new question after a clarification is answered, not re-asked', async () => {
    const r = await ask('What are the steps to verify and report emissions?', { history: CLAR_H, pending: CO2_PENDING });
    score('clarify', r.out.status !== 'clarify');
    score('context', !!r.last && r.last.content === 'What are the steps to verify and report emissions?');
    assert.strictEqual(r.out.source, 'agent', r.out.text);
    assert.ok(!/which measurement/i.test(r.out.text), r.out.text);
    assert.ok(/is a new question/.test(r.system), 'frame should say new question');
    assert.strictEqual(r.out.pending, undefined, 'the old question must not stay open');
  });

  await ta('T1b the same question with no history goes to the model, not "which measurement"', async () => {
    const r = await ask('What are the steps to verify and report emissions?');
    score('clarify', r.out.status !== 'clarify');
    assert.strictEqual(r.out.source, 'agent', r.out.text);
  });

  // --- Test 2: clarification answer ----------------------------------------
  await ta('T2 "CO2 emitted." answers the clarification and continues the original request', async () => {
    const r = await ask('CO2 emitted.', { history: CLAR_H, pending: CO2_PENDING });
    score('clarify', r.out.status !== 'clarify');
    score('context', r.out.source === 'data');
    assert.strictEqual(r.out.source, 'data', r.out.text);
    assert.ok(/co2 emitted/i.test(r.out.text) && /last week/i.test(r.out.text), r.out.text);
    assert.strictEqual(r.seen.length, 0, 'no model call needed');
  });

  await ta('T2b the option chip (value "co2") resolves instead of re-asking', async () => {
    const r = await ask('co2', { history: CLAR_H, pending: CO2_PENDING });
    score('clarify', r.out.status !== 'clarify');
    assert.ok(/co2 emitted/i.test(r.out.text), r.out.text);
  });

  // --- Test 3: follow-up ----------------------------------------------------
  await ta('T3 "Explain step 3." is read against the previous answer', async () => {
    const r = await ask('Explain step 3.', { history: STEPS_H });
    score('context', r.last.content === 'Explain step 3.' && r.req.messages.some((m) => m.role === 'assistant' && m.content === STEPS));
    assert.ok(/follows up on the previous exchange/.test(r.system), 'frame should say follow-up');
    assert.ok(r.req.messages.some((m) => m.content === STEPS), 'the answer with step 3 must reach the model whole');
    assert.deepStrictEqual(r.out.context, { kind: 'follow_up', about: 'What are the steps to verify emissions?' });
  });

  // --- Test 4: topic change -------------------------------------------------
  await ta('T4 a new topic starts fresh', async () => {
    const r = await ask('How does EU MRV reporting work?', { history: POOL_H });
    score('topic', /is a new question/.test(r.system) && r.last.content === 'How does EU MRV reporting work?');
    assert.ok(/is a new question/.test(r.system));
    assert.strictEqual(r.out.context, undefined, 'a new question is not labelled a follow-up');
  });

  // --- Test 5: explicit reset -----------------------------------------------
  await ta('T5 "No, that\'s not what I\'m asking" resets, even with a question open', async () => {
    const text = 'No, that\'s not what I\'m asking.\n\nI want to know how BDN validation works.';
    const r = await ask(text, { history: CLAR_H, pending: CO2_PENDING });
    score('topic', /correcting you/.test(r.system));
    score('clarify', r.out.status !== 'clarify');
    assert.strictEqual(r.out.source, 'agent', r.out.text);
    assert.ok(/correcting you/.test(r.system), 'frame should say correction');
    assert.strictEqual(r.last.content, text);
    assert.strictEqual(r.out.pending, undefined);
  });

  // --- Test 6: long conversation ----------------------------------------------
  await ta('T6 a 96-message conversation: the latest question wins, history stays bounded', async () => {
    const topics = [
      ['What is CO2 emitted?', CO2_Q],
      ['fuel consumption for Aurora Trader last month', 'Aurora Trader used 412.5 MT of fuel last month.'],
      ['Tell me about FuelEU pooling.', 'Pooling lets ships combine compliance balances. '.repeat(40)],
      ['How is CII calculated?', 'CII is annual CO2 per capacity-mile. '.repeat(40)],
      ['What does a BDN contain?', 'A bunker delivery note records the fuel supplied. '.repeat(40)],
      ['explain EU ETS surrender deadlines', 'Allowances are surrendered by 30 September. '.repeat(40)],
      ['shaft power yesterday', 'Which vessel?'],
      ['Blue Star', 'Blue Star averaged 8,200 kW yesterday.'],
    ];
    const history = [];
    for (let i = 0; history.length < 96; i++) { const [q, a] = topics[i % topics.length]; history.push(U(q), A(a)); }
    const r = await ask('What is FuelEU pooling?', { history, pending: null });
    score('context', r.last.content === 'What is FuelEU pooling?');
    score('topic', /is a new question/.test(r.system));
    assert.strictEqual(r.out.source, 'agent');
    const convo = r.req.messages.slice(1, -1);
    assert.ok(convo.length <= 21, 'history turns: ' + convo.length);
    const chars = convo.reduce((n, m) => n + m.content.length, 0);
    assert.ok(chars < 12000, 'old answers should be clipped, got ' + chars + ' chars');
  });

  // --- clarification loop ---------------------------------------------------------
  await ta('loop: the engine never asks the same clarifying question twice', async () => {
    const history = [U('shaft power yesterday'), A('Which vessel?')];
    const r = await ask('shaft power yesterday', { history });
    score('repetition', r.out.text !== 'Which vessel?');
    assert.strictEqual(r.out.source, 'agent', 'second time round the model answers: ' + r.out.text);
    assert.ok(/you already asked "Which vessel\?"/.test(r.system), 'frame should forbid the repeat');
  });

  await ta('loop: "Please answer my question." with the question open reaches the model', async () => {
    const r = await ask('Please answer my question.', { history: CLAR_H, pending: CO2_PENDING });
    score('repetition', !/which measurement/i.test(r.out.text));
    assert.strictEqual(r.out.source, 'agent', r.out.text);
  });

  await ta('clarify only through the model: an incomplete figure question is not bounced back as "Which vessel?"', async () => {
    // Two vessels, no name: the engine alone would ask. The model has the same
    // engine as a tool, plus the records, and can answer both vessels or ask.
    const r = await ask('shaft power yesterday', {}, [
      tool('get_vessel_data', { question: 'shaft power yesterday' }),
      say('Which vessel do you mean: Aurora Trader or Blue Star?'),
    ]);
    score('clarify', r.out.source === 'agent');
    assert.strictEqual(r.out.source, 'agent');
    assert.ok(r.out.pending && r.out.pending.kind === 'clarify', 'the question the model relays stays open');
    assert.deepStrictEqual((r.out.options || []).map((o) => o.label).slice(0, 2), ['Aurora Trader', 'Blue Star']);
  });
  await ta('a complete figure question is still answered by the engine without the model', async () => {
    const r = await ask('shaft power for Aurora Trader yesterday');
    assert.strictEqual(r.out.status, 'answer', r.out.text);
    assert.strictEqual(r.seen.length, 0, 'no model call for a question the engine answers in full');
  });

  // --- answer validation: a repeated reply is regenerated once ----------------------
  await ta('validation: a model reply that repeats the previous one is regenerated', async () => {
    const history = [U('What is FuelEU pooling?'), A('Pooling lets several ships combine their FuelEU compliance balances.')];
    const r = await ask('How does EU MRV reporting work?', { history }, [
      say('Pooling lets several ships combine their FuelEU compliance balances.'),
      say('EU MRV: monitor per voyage, report annually, get the report verified.'),
    ]);
    score('repetition', /EU MRV/.test(r.out.text));
    assert.strictEqual(r.seen.length, 2, 'one retry');
    assert.ok(/EU MRV/.test(r.out.text), r.out.text);
    assert.ok(/repeated your previous reply/.test(r.seen[1].messages[r.seen[1].messages.length - 1].content));
  });

  // --- stale agent state ---------------------------------------------------------------
  await ta('state: a clarification the model already resolved does not stay open', async () => {
    const r = await ask('why did Aurora Trader emit so much CO2 last week?', { history: [] }, [
      tool('get_vessel_data', { question: 'co2 Aurora Trader last week' }, 'c1'),
      tool('get_vessel_data', { question: 'co2 emitted for Aurora Trader last week' }, 'c2'),
      say('Aurora Trader emitted 12.5 MT of CO2 last week.'),
    ]);
    assert.strictEqual(r.out.source, 'agent');
    assert.strictEqual(r.out.pending, undefined, 'pending leaked: ' + JSON.stringify(r.out.pending));
  });

  await ta('state: a model that relays the engine question keeps it open, with the choices', async () => {
    const r = await ask('why were emissions on Aurora Trader so high last week?', { history: [] }, [
      tool('get_vessel_data', { question: 'emissions for Aurora Trader last week' }),
      say('Do you mean CO2 emitted from the daily reports, or leg CO2 from the voyages?'),
    ]);
    assert.strictEqual(r.out.source, 'agent');
    assert.ok(r.out.pending && r.out.pending.kind === 'clarify', 'question not kept open');
    assert.ok(Array.isArray(r.out.options) && r.out.options.length === 2, 'no choices');
  });

  // --- hallucination guard with a real conversation ---------------------------------------
  await ta('guard: a figure already read from the records may be restated; a new one may not', () => {
    const history = [U('fuel consumption for Aurora Trader last month'), A('Aurora Trader used 412.5 MT of fuel last month.')];
    const known = knownFigures(history, 'explain that');
    const restated = !containsStatedFigure('Aurora Trader used 412.5 MT, which is typical for its size.', ['Aurora Trader'], known);
    const invented = containsStatedFigure('Aurora Trader will burn 530 MT next month.', ['Aurora Trader'], known);
    score('guard', restated); score('guard', invented);
    assert.ok(restated, 'a known figure was blocked');
    assert.ok(invented, 'an invented figure got through');
  });

  await ta('follow-up rewrite: "and last week?" only inherits the question just asked', () => {
    assert.strictEqual(router.followUpRewrite('and last week?', [U('fuel consumption for Aurora Trader last month'), A('412 MT'), U('Tell me about FuelEU pooling.'), A('Pooling...')], NOW), null);
    assert.strictEqual(router.followUpRewrite('and last week?', [U('fuel consumption for Aurora Trader last month'), A('412 MT')], NOW), 'fuel consumption for Aurora Trader last week');
  });

  await ta('history: gaps from older clients are filled so an old question does not look open', () => {
    const m = modelHistory([U('fuel consumption last month'), U('What is FuelEU pooling?'), A('Pooling...')], 20, 6000);
    assert.deepStrictEqual(m.map((x) => x.role), ['user', 'assistant', 'user', 'assistant']);
    assert.ok(repeatsRecent('Which vessel?', [A('Which vessel?')]));
    assert.ok(!repeatsRecent('Which vessel?', [A('Blue Star averaged 8,200 kW.')]));
  });

  // ---------------------------------------------------------------------------
  // 3. Live: the same conversations against the real model (opt-in)
  // ---------------------------------------------------------------------------
  if (process.env.KRIS_EVAL_LIVE === '1') await live();

  const pct = (k) => metrics[k][1] ? (100 * metrics[k][0] / metrics[k][1]).toFixed(0) + '% (' + metrics[k][0] + '/' + metrics[k][1] + ')' : 'n/a';
  console.log('\nContext benchmark (offline)');
  console.log('  intent accuracy        ' + pct('intent'));
  console.log('  transition accuracy    ' + pct('transition'));
  console.log('  context accuracy       ' + pct('context'));
  console.log('  clarification accuracy ' + pct('clarify'));
  console.log('  loops avoided          ' + pct('repetition'));
  console.log('  topic switching        ' + pct('topic'));
  console.log('  figure guard           ' + pct('guard'));
  console.log(`\nContext: ${passed} passed, ${fails.length} failed`);
  fails.forEach((f) => console.log('  FAIL ' + f));
  process.exit(fails.length ? 1 : 0);
})();

// A live run scores what the model actually says. The checks are deliberately
// blunt (did it answer THIS question, did it loop, did it invent a figure);
// read the printed replies for anything subtler.
async function live() {
  const env = Object.assign({}, process.env, { KRIS_MODE: 'agent' });
  const cases = [
    { name: 'T1 new question after clarification', text: 'What are the steps to verify and report emissions?', history: CLAR_H, pending: CO2_PENDING, must: /verif|report|monitor/i, mustNot: /which measurement/i },
    { name: 'T3 follow-up', text: 'Explain step 3.', history: STEPS_H, must: /emission factor|calculat/i },
    { name: 'T4 topic change', text: 'How does EU MRV reporting work?', history: POOL_H, must: /MRV|monitor/i, mustNot: /^[^.]*pool/i },
    { name: 'T5 explicit reset', text: 'No, that\'s not what I\'m asking.\n\nI want to know how BDN validation works.', history: STEPS_H, must: /BDN|bunker/i },
    { name: 'broad question, no clarification', text: 'What are the steps to verify and report emissions?', history: [], must: /\b(1|first)\b/i, mustNot: /which (measurement|emission)/i },
    { name: 'no invented figures', text: 'How much fuel will Blue Star burn next month?', history: [], mustNot: /\b\d[\d,.]*\s*(mt|tonnes?)\b/i },
  ];
  const rows = [];
  for (const c of cases) {
    const out = await router.route(
      { text: c.text, session, now: new Date(), history: c.history || [], pending: c.pending || null, context: {} },
      async () => fakeDb(), { orgId: 'o', env, disableLog: true }
    ).catch((e) => ({ text: 'ERROR ' + e.message }));
    const text = String(out.text || '');
    const ok = (!c.must || c.must.test(text)) && (!c.mustNot || !c.mustNot.test(text)) && !repeatsRecent(text, c.history || []);
    rows.push([c.name, ok]);
    if (!ok) fails.push('live ' + c.name + ': ' + text.slice(0, 200));
    else passed++;
    console.log('\n[' + (ok ? 'ok' : 'MISS') + '] ' + c.name + '\n  > ' + c.text.replace(/\n+/g, ' ') + '\n  < ' + text.replace(/\n+/g, ' ').slice(0, 400));
  }
  console.log('\nLive: ' + rows.filter((r) => r[1]).length + '/' + rows.length + ' conversations answered the latest question');
}
