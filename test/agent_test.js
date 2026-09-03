'use strict';
/**
 * Agent-mode tests. Entirely offline: the model is a scripted fake, so every
 * assertion is about OUR behaviour (tool wiring, safety guard, error handling,
 * request shape), never about a live model's whims.
 *
 *   node test/agent_test.js
 */
const assert = require('assert');
const agent = require('../src/agent');
const router = require('../src/router');

let passed = 0; const fails = [];
const ta = async (n, f) => { try { await f(); passed++; } catch (e) { fails.push(n + ': ' + e.message); } };
const t = (n, f) => { try { f(); passed++; } catch (e) { fails.push(n + ': ' + e.message); } };

const NOW = new Date('2026-09-03T06:30:00Z');
// A session with an explicit vessel allow-list, so rbac.resolveScope returns a
// real scope against the fake database below.
const session = { userId: 'u', orgId: 'o', vesselIds: ['v1'] };
const ENV = {
  CAPTAIN_MODE: 'agent',
  CAPTAIN_LLM_URL: 'https://openrouter.ai/api',
  CAPTAIN_LLM_MODEL: 'test/model',
  CAPTAIN_LLM_API_KEY: 'sk-test',
  CAPTAIN_APP_NAME: 'Geo Monitor',
};

/**
 * A fake OpenAI-compatible endpoint. `script` is an array of assistant
 * messages returned in order; every request is recorded for inspection.
 */
function fakeModel(script) {
  const seen = [];
  const impl = async function (url, init) {
    const body = JSON.parse(init.body);
    seen.push({ url: url, headers: init.headers, body: body });
    const msg = script[Math.min(seen.length - 1, script.length - 1)];
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: msg }] }),
      text: async () => '',
    };
  };
  impl.seen = seen;
  return impl;
}

const say = (content) => ({ role: 'assistant', content: content });
const callTool = (name, args, id) => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id: id || 'c1', type: 'function', function: { name: name, arguments: JSON.stringify(args || {}) } }],
});

const NO_DB = async () => { throw Object.assign(new Error('not configured'), { code: 'DB_NOT_CONFIGURED' }); };

// A minimal fake pg client good enough for engine.ask + rbac in these tests.
function fakeDb(rows) {
  return {
    query: async (sql) => {
      // rbac.buildVesselList selects id + name (+ alt name columns).
      if (/\bfrom\s+\w*vessels?\b/i.test(sql) || /\bid\b[\s\S]*\bname\b[\s\S]*\bfrom\b/i.test(sql)) {
        return { rows: [{ id: 'v1', name: 'Aurora Trader' }] };
      }
      return { rows: rows || [] };
    },
  };
}

const run = (text, script, extra, opts) => agent.run(
  Object.assign({ text: text, session: session, now: NOW, history: [], context: { tz: 'Asia/Kolkata' } }, extra || {}),
  (opts && opts.getDb) || NO_DB,
  Object.assign({ orgId: 'o', env: ENV, fetchImpl: fakeModel(script) }, opts || {})
);

(async () => {
  // --- the model answers without any tool: the whole point of AI-first --------
  await ta('a plain question is answered directly, no tools, no database', async () => {
    const fetchImpl = fakeModel([say('19 is bigger than 2, by 17.')]);
    const out = await agent.run(
      { text: 'can you visualize a comparison of whoich number is bigger 2 or 19', session, now: NOW, history: [], context: {} },
      NO_DB,
      { orgId: 'o', env: ENV, fetchImpl }
    );
    assert.strictEqual(out.status, 'answer');
    assert.strictEqual(out.source, 'agent');
    assert.ok(/19 is bigger/.test(out.text));
    assert.strictEqual(fetchImpl.seen.length, 1, 'exactly one model call');
  });

  await ta('typos and fragments are the model\'s problem, not a matcher\'s', async () => {
    const out = await run('whats you name >?', [say("I'm Captain Nav. What's yours?")]);
    assert.ok(/Captain Nav/.test(out.text));
  });

  // --- request shape ----------------------------------------------------------
  t('tool definitions cover data, catalogue, briefing, help and charts', () => {
    const names = agent.toolDefs().map((d) => d.function.name).sort();
    assert.deepStrictEqual(names, ['get_fleet_briefing', 'get_vessel_data', 'list_available_data', 'search_app_help', 'show_chart']);
  });

  await ta('every request carries the tools, the key and OpenRouter attribution', async () => {
    const fetchImpl = fakeModel([say('hello')]);
    await agent.run({ text: 'hi', session, now: NOW, history: [], context: {} }, NO_DB,
      { orgId: 'o', env: Object.assign({}, ENV, { CAPTAIN_LLM_REFERER: 'https://perform.geoserves.com' }), fetchImpl });
    const req = fetchImpl.seen[0];
    assert.ok(/\/v1\/chat\/completions$/.test(req.url), req.url);
    assert.strictEqual(req.headers.Authorization, 'Bearer sk-test');
    assert.strictEqual(req.headers['HTTP-Referer'], 'https://perform.geoserves.com');
    assert.strictEqual(req.body.tools.length, 5);
    assert.strictEqual(req.body.tool_choice, 'auto');
    assert.strictEqual(req.body.stream, false);
  });

  await ta('history and context reach the model; nothing else does', async () => {
    const fetchImpl = fakeModel([say('ok')]);
    await agent.run({
      text: 'and last week?', session, now: NOW,
      history: [{ role: 'user', text: 'fuel consumption for Aurora Trader last month' }, { role: 'assistant', text: '42 MT' }],
      context: { userName: 'Nav', vesselName: 'Aurora Trader', tz: 'Asia/Kolkata' },
    }, NO_DB, { orgId: 'o', env: ENV, fetchImpl });
    const msgs = fetchImpl.seen[0].body.messages;
    assert.strictEqual(msgs[0].role, 'system');
    assert.ok(/Captain Nav/.test(msgs[0].content));
    assert.ok(/name is Nav/.test(msgs[0].content));
    assert.ok(/Aurora Trader/.test(msgs[0].content));
    assert.strictEqual(msgs[msgs.length - 1].content, 'and last week?');
    assert.strictEqual(msgs.length, 4, 'system + 2 history + 1 user');
  });

  // --- tool loop --------------------------------------------------------------
  await ta('a data question routes through the engine and comes back as prose', async () => {
    const db = fakeDb([{ bucket: null, value: 41.5, n: 12 }]);
    const fetchImpl = fakeModel([
      callTool('get_vessel_data', { question: 'fuel consumption for Aurora Trader last month' }),
      say('Aurora Trader burned 41.5 MT last month.'),
    ]);
    const out = await agent.run(
      { text: 'how much fuel did aurora use last month', session, now: NOW, history: [], context: {} },
      async () => db,
      { orgId: 'o', env: ENV, fetchImpl, disableLog: true }
    );
    assert.strictEqual(out.status, 'answer');
    assert.deepStrictEqual(out.toolsUsed, ['get_vessel_data']);
    assert.ok(/41.5/.test(out.text));
    // the tool result was fed back in the protocol's shape
    const second = fetchImpl.seen[1].body.messages;
    const toolMsg = second[second.length - 1];
    assert.strictEqual(toolMsg.role, 'tool');
    assert.strictEqual(toolMsg.name, 'get_vessel_data');
    assert.strictEqual(second[second.length - 2].role, 'assistant');
  });

  await ta('show_chart renders a chart and never invents points', async () => {
    const fetchImpl = fakeModel([
      callTool('show_chart', { type: 'bar', title: 'Two numbers', labels: ['2', '19'], values: [2, 19] }),
      say('Here it is — 19 is the bigger of the two.'),
    ]);
    const out = await agent.run({ text: 'chart 2 vs 19', session, now: NOW, history: [], context: {} }, NO_DB,
      { orgId: 'o', env: ENV, fetchImpl });
    assert.ok(out.chart, 'chart missing');
    assert.deepStrictEqual(out.chart.values, [2, 19]);
    assert.strictEqual(out.chart.type, 'bar');
  });

  await ta('a malformed chart call is rejected, not rendered', async () => {
    const fetchImpl = fakeModel([
      callTool('show_chart', { type: 'bar', labels: ['a', 'b', 'c'], values: [1, 2] }),
      say('I could not draw that.'),
    ]);
    const out = await agent.run({ text: 'chart it', session, now: NOW, history: [], context: {} }, NO_DB,
      { orgId: 'o', env: ENV, fetchImpl });
    assert.strictEqual(out.chart, undefined);
    const toolMsg = JSON.parse(fetchImpl.seen[1].body.messages.slice(-1)[0].content);
    assert.ok(/same length/.test(toolMsg.error), toolMsg.error);
  });

  await ta('a database failure becomes a fact for the model, not a crash', async () => {
    const fetchImpl = fakeModel([
      callTool('get_vessel_data', { question: 'fuel for Aurora last week' }),
      say('I could not reach your records just now, so I have no figure for that.'),
    ]);
    const out = await agent.run({ text: 'fuel for aurora', session, now: NOW, history: [], context: {} }, NO_DB,
      { orgId: 'o', env: ENV, fetchImpl });
    assert.strictEqual(out.status, 'answer');
    const toolMsg = JSON.parse(fetchImpl.seen[1].body.messages.slice(-1)[0].content);
    assert.ok(/not configured/.test(toolMsg.error), toolMsg.error);
  });

  await ta('unknown tool names and broken JSON arguments are survivable', async () => {
    const bad = { role: 'assistant', content: '', tool_calls: [
      { id: 'a', type: 'function', function: { name: 'delete_everything', arguments: '{}' } },
      { id: 'b', type: 'function', function: { name: 'search_app_help', arguments: 'not json at all' } },
    ] };
    const fetchImpl = fakeModel([bad, say('Sorry — let me try that differently.')]);
    const out = await agent.run({ text: 'how do i export', session, now: NOW, history: [], context: {} }, NO_DB,
      { orgId: 'o', env: ENV, fetchImpl });
    assert.strictEqual(out.status, 'answer');
    const results = fetchImpl.seen[1].body.messages.slice(-2).map((m) => JSON.parse(m.content));
    assert.ok(/unknown tool/.test(results[0].error));
    assert.ok(/valid JSON/.test(results[1].error));
  });

  await ta('app help comes from the guide, not the model\'s imagination', async () => {
    const fetchImpl = fakeModel([
      callTool('search_app_help', { query: 'export a report' }),
      say('Use the Export button on the view you are on.'),
    ]);
    await agent.run({ text: 'how do i export a report', session, now: NOW, history: [], context: {} }, NO_DB,
      { orgId: 'o', env: ENV, fetchImpl });
    const result = JSON.parse(fetchImpl.seen[1].body.messages.slice(-1)[0].content);
    assert.ok(result.matches.length, 'no help matches');
    assert.ok(/Export button/.test(result.matches[0].answer));
  });

  await ta('the loop stops at max steps and still answers', async () => {
    const fetchImpl = fakeModel([callTool('list_available_data', {})]); // loops forever if unbounded
    const out = await agent.run({ text: 'what can you read', session, now: NOW, history: [], context: {} }, NO_DB,
      { orgId: 'o', env: Object.assign({}, ENV, { CAPTAIN_AGENT_MAX_STEPS: '2' }), fetchImpl });
    assert.strictEqual(out.status, 'answer');
    assert.ok(fetchImpl.seen.length <= 4, 'too many model calls: ' + fetchImpl.seen.length);
    const forced = fetchImpl.seen[fetchImpl.seen.length - 1].body.messages.slice(-1)[0];
    assert.ok(/Do not call any more tools/.test(forced.content));
  });

  // --- the safety property survives AI-first mode ------------------------------
  await ta('a fabricated vessel figure is blocked when no tool returned data', async () => {
    // The model skips the lookup and invents a plausible number. The guard
    // knows the fleet's names, so it catches the claim and replaces it.
    const db = fakeDb([]);
    const fetchImpl = fakeModel([say('Aurora Trader burned about 128.4 MT of fuel last week.')]);
    const out = await agent.run({ text: "what was aurora trader's fuel last week", session, now: NOW, history: [], context: {} },
      async () => db, { orgId: 'o', env: ENV, fetchImpl, disableLog: true });
    assert.strictEqual(out.blocked, true, 'should have been blocked: ' + out.text);
    assert.ok(!/128\.4/.test(out.text));
  });

  await ta('the guard still fires from phrasing alone when the database is down', async () => {
    const out = await run('how much fuel did we burn last week',
      [say('Your fleet burned about 402 MT of fuel last week.')]);
    assert.strictEqual(out.blocked, true, 'should have been blocked: ' + out.text);
  });

  await ta('the same figure is allowed once a tool actually returned it', async () => {
    const db = fakeDb([{ bucket: null, value: 128.4, n: 7 }]);
    const fetchImpl = fakeModel([
      callTool('get_vessel_data', { question: 'fuel consumption for Aurora Trader last week' }),
      say('Aurora Trader burned 128.4 MT of fuel last week.'),
    ]);
    const out = await agent.run({ text: 'fuel for aurora last week', session, now: NOW, history: [], context: {} },
      async () => db, { orgId: 'o', env: ENV, fetchImpl, disableLog: true });
    assert.ok(!out.blocked, 'real data must not be blocked');
    assert.ok(/128\.4/.test(out.text));
  });

  await ta('general maritime knowledge is not mistaken for a fabricated figure', async () => {
    const out = await run('roughly how much does a panamax burn a day',
      [say('A Panamax bulker at service speed typically burns somewhere around 30 tonnes a day, though it varies a lot with speed and loading.')]);
    assert.ok(!out.blocked, 'general knowledge should pass: ' + out.text);
  });

  // --- failure modes -----------------------------------------------------------
  await ta('an HTTP error from the provider is an honest message, never a 500', async () => {
    const fetchImpl = async () => ({ ok: false, status: 429, text: async () => 'rate limited', json: async () => ({}) });
    const out = await agent.run({ text: 'hi', session, now: NOW, history: [], context: {} }, NO_DB,
      { orgId: 'o', env: ENV, fetchImpl });
    assert.strictEqual(out.status, 'error');
    assert.ok(/reduced mode/.test(out.text));
    assert.ok(/429/.test(out.error));
  });

  await ta('a missing model name fails loudly in the log and softly to the user', async () => {
    const out = await agent.run({ text: 'hi', session, now: NOW, history: [], context: {} }, NO_DB,
      { orgId: 'o', env: { CAPTAIN_MODE: 'agent' }, fetchImpl: fakeModel([say('x')]) });
    assert.strictEqual(out.reason, 'no_model');
  });

  await ta('a timeout is reported as a timeout', async () => {
    const fetchImpl = async (u, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    const out = await agent.run({ text: 'hi', session, now: NOW, history: [], context: {} }, NO_DB,
      { orgId: 'o', env: Object.assign({}, ENV, { CAPTAIN_AGENT_TIMEOUT_MS: '3000' }), fetchImpl });
    assert.strictEqual(out.reason, 'timeout');
  });

  // --- router integration -------------------------------------------------------
  await ta('CAPTAIN_MODE=agent bypasses the rule ladder entirely', async () => {
    const fetchImpl = fakeModel([say('Morning, Nav.')]);
    const out = await router.route(
      { text: 'hi', session, now: NOW, history: [], context: { userName: 'Nav' } },
      NO_DB,
      { orgId: 'o', env: ENV, fetchImpl }
    );
    assert.strictEqual(out.source, 'agent', 'small-talk matcher must not claim this in agent mode');
    assert.strictEqual(fetchImpl.seen.length, 1);
  });

  await ta('without CAPTAIN_MODE the deterministic router is unchanged', async () => {
    const out = await router.route(
      { text: 'hi', session, now: NOW, history: [], context: {} },
      NO_DB,
      { orgId: 'o', env: { CAPTAIN_ENABLE_LLM: '0' }, fetchImpl: async () => { throw new Error('no model'); } }
    );
    assert.strictEqual(out.source, 'router');
    assert.strictEqual(out.instant, true);
  });

  await ta('if the model layer is down, agent mode falls back to the router', async () => {
    const out = await router.route(
      { text: 'hi', session, now: NOW, history: [], context: {} },
      NO_DB,
      { orgId: 'o', env: Object.assign({}, ENV, { CAPTAIN_ENABLE_LLM: '0' }), fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); } }
    );
    assert.strictEqual(out.status, 'answer', 'user must still get an answer');
    assert.strictEqual(out.source, 'router');
  });

  await ta('CAPTAIN_AGENT_FALLBACK=0 surfaces the outage instead of falling back', async () => {
    const out = await router.route(
      { text: 'hi', session, now: NOW, history: [], context: {} },
      NO_DB,
      { orgId: 'o', env: Object.assign({}, ENV, { CAPTAIN_AGENT_FALLBACK: '0' }), fetchImpl: async () => { throw new Error('down'); } }
    );
    assert.strictEqual(out.status, 'error');
    assert.strictEqual(out.source, 'agent');
  });

  console.log(`\nAgent: ${passed} passed, ${fails.length} failed`);
  fails.forEach((f) => console.log('  FAIL ' + f));
  process.exit(fails.length ? 1 : 0);
})();
