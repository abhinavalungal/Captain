'use strict';

/**
 * Widget tests. Mounts public/kris-widget.js into a hostile host page in
 * jsdom and drives it end to end — no database, no server, no network. The
 * transport is a fake fetch that can answer with plain JSON or with the
 * streamed NDJSON protocol server.js speaks.
 *
 *   node test/widget.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0; const fails = [];
const ta = async (n, f) => { try { await f(); pass++; } catch (e) { fails.push(n + ': ' + (e && e.message)); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'kris-widget.js'), 'utf8');
const HOST = fs.readFileSync(path.join(__dirname, 'fixtures', 'host-page.html'), 'utf8')
  .replace('<script src="../../public/kris-widget.js"></script>', '');

// --- a fake fetch ------------------------------------------------------------
function jsonResponse(obj, status) {
  return { ok: (status || 200) < 400, status: status || 200, headers: { get: (k) => (/content-type/i.test(k) ? 'application/json' : null) }, json: async () => obj, body: null };
}
function ndjsonResponse(events, gapMs) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    ok: true, status: 200,
    headers: { get: (k) => (/content-type/i.test(k) ? 'application/x-ndjson; charset=utf-8' : null) },
    json: async () => { throw new Error('not json'); },
    body: {
      getReader: () => ({
        read: async () => {
          if (i >= events.length) return { done: true };
          const gap = typeof gapMs === 'function' ? gapMs(i) : gapMs;   // a number, or per event
          if (gap) await wait(gap);
          return { done: false, value: enc.encode(JSON.stringify(events[i++]) + '\n') };
        },
      }),
    },
  };
}

function boot(opts, storage) {
  const dom = new JSDOM(HOST, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://host.test/app' });
  const { window } = dom;
  window.TextDecoder = TextDecoder;
  window.TextEncoder = TextEncoder;
  if (storage) {
    // carry sessionStorage across "page loads"
    for (const [k, v] of Object.entries(storage)) window.sessionStorage.setItem(k, v);
  }
  const calls = [];
  let responder = async () => jsonResponse({ status: 'answer', source: 'agent', text: 'ok' });
  window.fetch = async (url, init) => {
    calls.push({ url, init });
    if (!init || init.method === 'GET') return jsonResponse({ status: 'ok' });
    return responder(JSON.parse(init.body), init);
  };
  window.eval(SRC);
  window.KRIS.init(Object.assign({ endpoint: 'https://kris.test/api/kris', nudge: false }, opts || {}));
  const sr = window.document.querySelector('[data-kris-widget]').shadowRoot;
  return {
    dom, window, doc: window.document, sr, calls,
    q: (s) => sr.querySelector(s), qa: (s) => sr.querySelectorAll(s),
    inst: () => window.KRIS._instance(),
    respond: (fn) => { responder = fn; },
    posts: () => calls.filter((c) => c.init && c.init.method === 'POST'),
    type: async (text) => {
      const t = sr.querySelector('textarea');
      t.value = text;
      t.dispatchEvent(new window.Event('input'));
      t.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    },
    idle: async (ms) => { const until = Date.now() + (ms || 3000); while (window.KRIS._instance().busy && Date.now() < until) await wait(10); await wait(30); },
    snapshotStorage: () => { const o = {}; for (let i = 0; i < window.sessionStorage.length; i++) { const k = window.sessionStorage.key(i); o[k] = window.sessionStorage.getItem(k); } return o; },
  };
}

(async () => {
  // =========================================================================
  await ta('mounts once, in a shadow root, and never touches the host styles', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.init({});
    assert(w.doc.querySelectorAll('[data-kris-widget]').length === 1, 'mounted twice');
    assert(w.sr.querySelector('style') || (w.sr.adoptedStyleSheets && w.sr.adoptedStyleSheets.length), 'no stylesheet in shadow root');
    assert(!w.doc.head.querySelector('style[data-kris]'), 'styles injected into host head');
    assert(!w.q('.root').classList.contains('open'), 'open on load');
  });

  await ta('opens, closes, and the badge reflects state for assistive tech', async () => {
    const w = boot();
    await wait(20);
    w.q('.badge').click();
    assert(w.q('.root').classList.contains('open'), 'did not open');
    assert(w.q('.badge').getAttribute('aria-expanded') === 'true');
    w.q('.tool.close').click();
    assert(!w.q('.root').classList.contains('open'), 'did not close');
    assert(w.q('.badge').getAttribute('aria-expanded') === 'false');
  });

  await ta('empty state: greeting, suggestions, trust line; a suggestion sends itself', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    assert(/^(Hello|Good (morning|afternoon|evening))/.test(w.q('.welcome h3').textContent), w.q('.welcome h3').textContent);
    const prompts = w.qa('.prompts button');
    assert(prompts.length === 4, 'prompts ' + prompts.length);
    w.respond(async () => jsonResponse({ status: 'answer', source: 'briefing', text: 'Nothing flagged.' }));
    prompts[0].click();
    await w.idle();
    assert(!w.q('.welcome'), 'welcome should be gone once the conversation starts');
    assert(w.posts().length === 1 && JSON.parse(w.posts()[0].init.body).text === 'Anything I should know today?');
  });

  await ta('"Hi" is answered locally: zero network requests, sub-frame latency', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    const before = w.posts().length;
    // Warm the path once: the first reply in a fresh page pays for compiling it.
    await w.type('hello');
    await w.idle();
    const t0 = Date.now();
    await w.type('Hi');
    await w.idle();
    assert(w.posts().length === before, 'a greeting must not hit the network');
    const msg = w.q('.turn.assistant .msg').textContent;
    assert(/(Hello|Good (morning|afternoon|evening))/.test(msg), msg);
    assert(Date.now() - t0 < 200, 'took ' + (Date.now() - t0) + 'ms');
    for (const t of ['thanks!', 'good morning kris', 'bye', 'how are you?', 'hello there 👋']) {
      assert(w.window.KRIS._localReply(t, null), 'not local: ' + t);
    }
    for (const t of ['hi what is my fuel consumption', 'hello, compare these', 'thanks, now show off-hire']) {
      assert(!w.window.KRIS._localReply(t, null), 'wrongly local: ' + t);
    }
  });

  await ta('transport: text/plain body with the token inside (no CORS preflight), context carries tz and name', async () => {
    const w = boot({ getToken: () => 'tok-123' });
    await wait(20);
    w.window.KRIS.open();
    w.respond(async () => jsonResponse({ status: 'answer', source: 'identity', text: 'Pleasure to meet you, Nav.', remember: { userName: 'Nav' } }));
    await w.type('my name is Nav');
    await w.idle();
    const p = w.posts()[0];
    assert(/^text\/plain/.test(p.init.headers['Content-Type']), 'content type ' + p.init.headers['Content-Type']);
    assert(!p.init.headers.Authorization, 'Authorization header forces a preflight');
    const body = JSON.parse(p.init.body);
    assert(body.token === 'tok-123', 'token not in body');
    assert(body.stream === true, 'stream not requested');
    assert(body.context && 'tz' in body.context, 'tz missing');
    w.respond(async (b) => jsonResponse({ status: 'answer', source: 'agent', text: 'Name is ' + b.context.userName }));
    await w.type('who am i talking to right now');
    await w.idle();
    assert(JSON.parse(w.posts()[1].init.body).context.userName === 'Nav', 'remembered name not sent back');
    assert(JSON.parse(w.posts()[1].init.body).history.length >= 2, 'history missing');
  });

  await ta('streaming: deltas render progressively with a caret, final payload wins, caret removed', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    w.respond(async () => ndjsonResponse([
      { t: 'delta', text: 'FuelEU sets a **limit**. ' },
      { t: 'delta', text: 'It applies to ships over 5,000 GT.\n\n- scope\n- metric' },
      { t: 'final', status: 200, data: { status: 'answer', source: 'agent', text: 'FuelEU sets a **limit**. It applies to ships over 5,000 GT.\n\n- scope\n- metric', streamed: true } },
    ], 60));
    await w.type('explain fueleu');
    await wait(160);
    assert(w.q('.turn.assistant.streaming .caret'), 'no caret while streaming');
    assert(/FuelEU/.test(w.q('.turn.assistant .msg').textContent), 'first delta not shown');
    await w.idle();
    assert(!w.q('.caret'), 'caret left behind');
    assert(w.q('.turn.assistant .msg strong').textContent === 'limit');
    assert(w.qa('.turn.assistant .msg ul li').length === 2, 'list not rendered');
    assert(w.q('.turn.assistant .meta .act.copy'), 'no actions after the answer');
  });

  await ta('streaming: a guard "replace" swaps out everything shown', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    const redirect = "I don't want to guess at a number in conversation.";
    w.respond(async () => ndjsonResponse([
      { t: 'delta', text: 'Sure thing. ' },
      { t: 'replace', text: redirect },
      { t: 'final', status: 200, data: { status: 'answer', source: 'companion', text: redirect, blocked: true } },
    ], 20));
    await w.type('what did my ship burn');
    await w.idle();
    const t = w.q('.turn.assistant .msg').textContent;
    assert(t.indexOf('Sure thing') < 0 && t.indexOf("guess at a number") >= 0, t);
  });

  await ta('streaming: finished blocks are drawn once, and the streamed DOM is exactly the final render', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    const parts = ['Intro paragraph.\n\n', '```js\nconst a = 1;\n\nconst b = 2;\n```\n\n', '| Item | Qty |\n|---|---|\n| Compliance | 1 |\n\n', '- one\n- two'];
    const full = parts.join('');
    // Deltas 60 ms apart; the final payload waits until the reveal has caught up.
    w.respond(async () => ndjsonResponse(parts.map((p) => ({ t: 'delta', text: p }))
      .concat([{ t: 'final', status: 200, data: { status: 'answer', source: 'agent', text: full, streamed: true } }]), (i) => (i < parts.length ? 60 : 900)));
    await w.type('show me everything');
    await wait(250);
    const msg = () => w.q('.turn.assistant .msg');
    const p0 = msg().querySelector('p');
    assert(p0 && p0.textContent === 'Intro paragraph.', 'first block not shown');
    // Wait for the reveal to show every delta (the final payload is held back until 1.1 s).
    for (let t = Date.now(); Date.now() - t < 800 && !/two$/.test(msg().textContent); ) await wait(15);
    assert(msg().querySelector('p') === p0, 'a finished block was rebuilt');
    assert(msg().querySelectorAll('.codeblock').length === 1 && /const b = 2/.test(msg().querySelector('.codeblock pre').textContent), 'a blank line split the code block');
    const streamed = msg().innerHTML.replace(/<span class="caret"><\/span>/g, '');
    await w.idle();
    assert(msg().innerHTML === streamed, 'streamed DOM differs from the final render:\nS ' + streamed + '\nF ' + msg().innerHTML);
  });

  await ta('rate limited (429): a calm error card with the wait and "Try again", not a failed delivery', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    w.respond(async () => jsonResponse({ status: 'error', reason: 'rate_limited', code: 'RATE_LIMITED', retryAfter: 4, text: 'You’re sending messages faster than I can answer them well. Give me 4 seconds and ask again.' }, 429));
    await w.type('another question');
    await w.idle();
    const card = w.q('.turn.assistant.last .notice');
    assert(card && /Give me 4 seconds/.test(card.textContent) && card.querySelector('.retry'), card && card.textContent);
    assert(!w.q('.turn.user.failed'), 'the message was marked as not delivered');
  });

  const VIS = (spec) => '```visual\n' + (typeof spec === 'string' ? spec : JSON.stringify(spec)) + '\n```';

  await ta('visuals: every type renders as a component, never as code; a malformed one renders nothing', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    const text = [
      'Here is the overview.',
      VIS({ type: 'stats', title: 'Key figures', items: [{ label: 'Limit 2025', value: 89.34, unit: 'gCO2e/MJ', tone: 'good' }, { label: 'Penalty', value: 2400, unit: 'EUR/t' }] }),
      VIS({ type: 'bar', title: 'By fuel', unit: 'MJ', labels: ['HFO', 'MGO', 'LNG'], values: [120, 80, -20], highlight: 'LNG' }),
      VIS({ type: 'line', title: 'Trend', labels: ['2024', '2025', '2026'], series: [{ name: 'A', values: [1, 2, 3] }, { name: 'B', values: [3, 2, 1] }] }),
      VIS({ type: 'breakdown', title: 'Mix', unit: '%', items: [{ label: 'HFO', value: 60 }, { label: 'MGO', value: 30 }, { label: 'LNG', value: 10 }] }),
      VIS({ type: 'meter', title: 'CII', value: 3.6, min: 0, max: 10, better: 'lower', bands: [{ label: 'A', to: 2 }, { label: 'B', to: 4 }, { label: 'C', to: 6 }, { label: 'D', to: 8 }, { label: 'E', to: 10 }] }),
      VIS({ type: 'compare', items: [{ name: 'EU ETS', points: ['Prices CO2'] }, { name: 'FuelEU', points: ['Limits intensity'] }], highlight: 'FuelEU' }),
      VIS({ type: 'steps', steps: [{ title: 'Collect', detail: 'Noon reports' }, { title: 'Verify' }, 'Submit'] }),
      VIS({ type: 'timeline', events: [{ when: '2024', title: '40%' }, { when: '2026', title: '100%' }] }),
      VIS({ type: 'dashboard', title: 'Fleet', blocks: [{ type: 'stats', items: [{ label: 'Ships', value: 12 }] }, { type: 'dashboard', blocks: [] }, { type: 'bar', labels: ['a', 'b'], values: [1, 2] }] }),
      VIS('{"type":"bar","labels":["only one"],"values":[1'),
      'And that is the picture.',
    ].join('\n\n');
    w.respond(async () => jsonResponse({ status: 'answer', source: 'agent', text: text }));
    await w.type('show me everything about fueleu');
    await w.idle();
    const m = w.q('.turn.assistant.last .msg');
    const n = (s) => m.querySelectorAll(s).length;
    assert(n(':scope > .vz-stats .vz-stat') === 2 && m.querySelector(':scope > .vz-stats .vz-tone.t-good'), 'stats');
    assert(n(':scope > .vz-bar .vz-row') === 3 && m.querySelector(':scope > .vz-bar .vz-row.hi') && m.querySelector(':scope > .vz-bar .vz-track i.neg'), 'bars (highlight, negative)');
    assert(m.querySelector('.vz-line .vz-plot') && n('.vz-line path.ln') === 2 && m.querySelector('.vz-line .vz-lg'), 'line with a legend');
    assert(n('.vz-breakdown .vz-stack span') === 3 && /60%/.test(m.querySelector('.vz-legend').textContent), 'breakdown');
    assert(n('.vz-meter .vz-mseg') === 5 && m.querySelector('.vz-mseg.on').classList.contains('t-good') && /B/.test(m.querySelector('.vz-mh .vz-tone').textContent), 'meter: rating B, a good band');
    assert(n('.vz-compare .vz-card') === 2 && m.querySelector('.vz-card.hi .vz-best'), 'compare');
    assert(n('.vz-flow li') === 3 && n('.vz-tl li') === 2, 'steps and timeline');
    assert(n('.vz-dashboard .vz-dash > .vz') === 2, 'dashboard: two valid blocks, no nested dashboard');
    assert(!m.querySelector('.codeblock') && !/"type"/.test(m.textContent), 'JSON leaked as code or text');
    // A figure's own class must not be reused inside it (it once stripped the steps card of its padding).
    for (const fig of m.querySelectorAll('figure.vz')) {
      const own = [...fig.classList].find((c) => /^vz-/.test(c));
      assert(!fig.querySelector('.' + own), own + ' is also used inside its own figure');
    }
    assert(/And that is the picture\./.test(m.textContent), 'prose after a malformed visual was lost');
  });

  await ta('visuals: a map pins positions from its numbers; tiles come only from the widget option', async () => {
    const w = boot({ mapTiles: 'https://tiles.test/{z}/{x}/{y}.png' });
    await wait(20);
    w.window.KRIS.open();
    w.respond(async () => jsonResponse({
      status: 'answer', source: 'agent', text: 'Suddha Star is at sea; Suddha Sky is at anchor.',
      visuals: [{ type: 'map', title: 'Where your vessels are', points: [
        { name: 'Suddha Star', lat: -21.68, lon: -40.25, note: 'at sea, to Rotterdam' },
        { name: 'Suddha Sky', lat: 53.62, lon: 8.11, note: 'at anchor off Wilhelmshaven' },
        { name: 'Nowhere', lat: 123, lon: 0 }, { name: '<img src=x onerror=alert(1)>', lat: 'x', lon: 1 }] }],
    }));
    await w.type('Where are my vessels?');
    await w.idle();
    const map = w.q('.turn.assistant .vz-map svg');
    assert(map, 'no map rendered');
    assert(map.querySelectorAll('circle.pin').length === 2, 'invalid points must be dropped');
    const tiles = Array.from(map.querySelectorAll('image')).map((i) => i.getAttribute('href'));
    assert(tiles.length > 0 && tiles.every((h) => /^https:\/\/tiles\.test\/\d+\/\d+\/\d+\.png$/.test(h)), tiles.join(' '));
    assert(/Suddha Star 21°41′S 40°15′W/.test(w.q('.turn.assistant .vz-map-l').textContent), 'no readable position list');
    assert(!w.q('.turn.assistant img'), 'a label became markup');
    const off = boot({ mapTiles: false });
    await wait(20);
    off.window.KRIS.open();
    off.respond(async () => jsonResponse({ status: 'answer', source: 'agent', text: 'Here.', visuals: [{ type: 'map', points: [{ name: 'A', lat: 1, lon: 1 }] }] }));
    await off.type('where?');
    await off.idle();
    assert(off.q('.turn.assistant .vz-map circle.pin') && !off.q('.turn.assistant .vz-map image'), 'mapTiles:false still loads tiles');
  });

  await ta('visuals: spec text is text — markup in a label never becomes an element', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    w.respond(async () => jsonResponse({ status: 'answer', source: 'agent', text: VIS({ type: 'bar', title: '<img src=x onerror=alert(1)>', labels: ['<b>a</b>', 'b'], values: [1, 2] }) }));
    await w.type('chart it');
    await w.idle();
    const m = w.q('.turn.assistant.last .msg');
    assert(m.querySelector('.vz-bar') && !m.querySelector('img') && !m.querySelector('.vz-bl b'), m.innerHTML.slice(0, 300));
    assert(/<img/.test(m.querySelector('.vz-t').textContent), 'the title should read as literal text');
  });

  await ta('visuals: copying an answer gives words, not JSON', async () => {
    const w = boot();
    await wait(20);
    const plain = w.window.KRIS._visualPlain('Figures:\n\n' + VIS({ type: 'stats', title: 'Key figures', items: [{ label: 'Limit', value: 89.34, unit: 'gCO2e/MJ' }] }) + '\n\nDone.');
    assert(/Limit: 89\.34 gCO2e\/MJ/.test(plain) && !/"type"/.test(plain) && /Done\./.test(plain), plain);
  });

  await ta('visuals: while the server holds one, a placeholder shows where it will land; then the component replaces it', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    const vis = VIS({ type: 'timeline', events: [{ when: '2024', title: '40%' }, { when: '2026', title: '100%' }] });
    const events = [
      { t: 'delta', text: 'The phase-in:\n\n' },
      { t: 'status', text: 'Preparing a visual', phase: 'visual' },
      { t: 'delta', text: vis + '\n' },
      { t: 'final', status: 200, data: { status: 'answer', source: 'agent', text: 'The phase-in:\n\n' + vis, streamed: true } },
    ];
    w.respond(async () => ndjsonResponse(events, (i) => (i === 2 ? 400 : 60)));
    await w.type('show the phase-in');
    await wait(330);
    assert(w.q('.turn.assistant .vz-skel'), 'no placeholder while the visual is held');
    await w.idle();
    const m = w.q('.turn.assistant.last .msg');
    assert(!m.querySelector('.vz-skel') && m.querySelector('.vz-timeline'), 'the component did not replace the placeholder');
  });

  await ta('streaming: a slow but steady answer is never cut off by the client timeout', async () => {
    const w = boot({ timeoutMs: 150 });
    await wait(20);
    w.window.KRIS.open();
    const words = ['Pooling ', 'lets ', 'ships ', 'share ', 'a ', 'balance.'];
    w.respond(async () => ndjsonResponse([{ t: 'status', text: 'Thinking' }].concat(words.map((x) => ({ t: 'delta', text: x })))
      .concat([{ t: 'final', status: 200, data: { status: 'answer', source: 'agent', text: words.join(''), streamed: true } }]), 90));
    await w.type('explain pooling');
    await w.idle(3000);
    assert(!w.q('.turn.assistant .notice'), 'timed out: ' + w.q('.turn.assistant .msg').textContent);
    assert(w.q('.turn.assistant .msg').textContent === 'Pooling lets ships share a balance.', w.q('.turn.assistant .msg').textContent);
  });

  await ta('data answer: figure, unit, eyebrow, sources; follow-up chips send full questions', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    w.respond(async () => jsonResponse({
      status: 'answer', source: 'data', text: 'Average shaft power for Aurora Trader, August 2026: 9,351.8 kW', value: 9351.8, unit: 'kW', rowsUsed: 31,
      provenance: { vessels: ['Aurora Trader'], period: 'August 2026', metric: 'Shaft power', source: 'Geoform vessel reports' },
    }));
    await w.type('average shaft power for Aurora Trader last month');
    await w.idle();
    const card = w.q('.turn.assistant .card');
    assert(card, 'no card');
    assert(card.querySelector('.figure').firstChild.textContent === '9,351.8', card.querySelector('.figure').textContent);
    assert(card.querySelector('.figure .unit').textContent === 'kW');
    assert(/Shaft power · Aurora Trader/.test(card.querySelector('.eyebrow').textContent));
    assert(/Reports\s*31/.test(card.querySelector('.sources').textContent));
    const chips = w.qa('.turn.assistant .followups .chip');
    assert(chips.length === 3, 'chips ' + chips.length);
    w.respond(async (b) => jsonResponse({ status: 'answer', source: 'data', text: 'asked: ' + b.text }));
    chips[0].click();
    await w.idle();
    assert(/shaft power trend for Aurora Trader last 30 days/.test(JSON.parse(w.posts()[1].init.body).text));
  });

  await ta('nothing from the server is ever parsed as HTML', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    w.respond(async () => jsonResponse({
      status: 'answer', text: '<img src=x onerror="window.__pwned=1"> [x](javascript:alert(1)) **<b>b</b>**', value: 1, unit: '', rowsUsed: 1,
      note: '<script>window.__pwned=2<\/script>',
      provenance: { vessels: ['<img src=y onerror="window.__pwned=3">'], period: 'today', source: 'test' },
    }));
    await w.type('xss please');
    await w.idle();
    const turn = w.q('.turn.assistant');
    assert(!turn.querySelector('img, script, strong b'), 'markup parsed');
    assert(turn.querySelector('strong') && turn.querySelector('strong').textContent === '<b>b</b>', 'bold content should be literal text');
    assert(!turn.querySelector('a[href^="javascript"]'), 'javascript: link created');
    assert(!w.window.__pwned, 'script ran');
  });

  await ta('clarification choices send their value and lock after use', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    w.respond(async () => jsonResponse({ status: 'clarify', text: 'Which consumption?', options: [{ label: 'Fuel', value: 'fuel consumption' }, { label: 'ME', value: 'me consumption' }], pending: { kind: 'clarify', x: 1 } }));
    await w.type('consumption');
    await w.idle();
    const btns = w.qa('.turn.assistant .choices .chip');
    assert(btns.length === 2);
    w.respond(async (b) => jsonResponse({ status: 'answer', source: 'data', text: 'got ' + b.text + ' with pending ' + JSON.stringify(b.pending) }));
    btns[1].click();
    await w.idle();
    const body = JSON.parse(w.posts()[1].init.body);
    assert(body.text === 'me consumption', body.text);
    assert(body.pending && body.pending.kind === 'clarify', 'pending not carried');
    assert(btns[0].disabled && btns[1].disabled, 'choices still active');
    assert(w.qa('.turn.user .bubble')[1].textContent === 'ME', 'label not shown as the user turn');
  });

  await ta('context: data replies and clarifying questions join the history; old choices go stale', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    w.respond(async () => jsonResponse({ status: 'clarify', source: 'data', text: 'Which measurement do you mean by "co2"?', options: [{ label: 'CO2 emitted (MT)', value: 'co2' }, { label: 'Leg CO2 (MT)', value: 'leg_co2' }], pending: { kind: 'clarify', field: 'metricKey' } }));
    await w.type('What is CO2 emitted?');
    await w.idle();
    const btns = w.qa('.turn.assistant .choices .chip');
    w.respond(async () => jsonResponse({ status: 'answer', source: 'agent', text: 'Verification runs in seven steps.', context: { kind: 'follow_up', about: 'What is CO2 emitted?' } }));
    await w.type('What are the steps to verify and report emissions?');
    await w.idle();
    const body = JSON.parse(w.posts()[1].init.body);
    assert(body.history.some((h) => h.role === 'assistant' && /Which measurement/.test(h.text)), 'the clarifying question is missing from history: ' + JSON.stringify(body.history));
    assert(btns[0].disabled && btns[1].disabled, 'choices for an abandoned question are still clickable');
    const ctx = w.qa('.turn.assistant .ctxline');
    assert(ctx.length === 1 && /Following up on “What is CO2 emitted\?”/.test(ctx[0].textContent), 'no follow-up line');
  });

  await ta('network failure: error card with "Try again" that resubmits the same question', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    w.respond(async () => { throw new TypeError('Failed to fetch'); });
    await w.type('fuel consumption last month');
    await w.idle();
    const notice = w.q('.turn.assistant .notice');
    assert(notice, 'no error notice');
    assert(!/\d{3,}/.test(notice.querySelector('.txt').firstChild.textContent), 'an error must never show a figure');
    assert(w.q('.root').getAttribute('data-conn') === 'offline', 'connection state not updated');
    w.respond(async () => jsonResponse({ status: 'answer', source: 'agent', text: 'Back online.' }));
    notice.querySelector('.retry').click();
    await w.idle();
    assert(w.qa('.turn.assistant').length === 1, 'retry should replace the failed answer');
    assert(w.qa('.turn.user').length === 1, 'retry must not duplicate the question');
    assert(/Back online/.test(w.q('.turn.assistant .msg').textContent));
    assert(JSON.parse(w.posts()[1].init.body).text === 'fuel consumption last month');
  });

  await ta('stop: aborting mid-stream keeps what was written and says "Stopped."', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    w.respond(async (b, init) => {
      return new Promise((resolve, reject) => {
        const enc = new TextEncoder(); let sent = false;
        resolve({
          ok: true, status: 200, headers: { get: () => 'application/x-ndjson' },
          body: { getReader: () => ({ read: () => new Promise((res, rej) => {
            if (!sent) { sent = true; return res({ done: false, value: enc.encode(JSON.stringify({ t: 'delta', text: 'Partial answer. ' }) + '\n') }); }
            init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
          }) }) },
        });
      });
    });
    await w.type('tell me a long story');
    await wait(80);
    assert(w.inst().busy, 'should be busy');
    assert(w.q('.send').getAttribute('aria-label') === 'Stop', 'send button did not become stop');
    w.q('.send').click();
    await w.idle();
    assert(!w.inst().busy, 'still busy');
    assert(/Partial answer/.test(w.q('.turn.assistant .msg').textContent));
    assert(/Stopped/.test(w.q('.turn.assistant .msg').textContent));
    assert(w.q('.send').getAttribute('aria-label') === 'Send message');
  });

  await ta('keyboard: Enter sends, Shift+Enter does not, IME composition does not, ArrowUp recalls', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    w.respond(async () => jsonResponse({ status: 'answer', source: 'agent', text: 'ok' }));
    const t = w.q('textarea');
    t.value = 'line one'; t.dispatchEvent(new w.window.Event('input'));
    t.dispatchEvent(new w.window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
    t.dispatchEvent(new w.window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
    await wait(30);
    assert(w.posts().length === 0, 'sent on Shift+Enter or during composition');
    t.dispatchEvent(new w.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await w.idle();
    assert(w.posts().length === 1, 'Enter did not send');
    assert(t.value === '', 'input not cleared');
    t.dispatchEvent(new w.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    assert(t.value === 'line one', 'ArrowUp did not recall: ' + t.value);
  });

  await ta('composer: send disabled when empty or over the limit; counter appears near the limit', async () => {
    const w = boot({ maxLength: 50 });
    await wait(20);
    w.window.KRIS.open();
    const t = w.q('textarea');
    assert(w.q('.send').disabled, 'enabled when empty');
    t.value = 'x'.repeat(45); t.dispatchEvent(new w.window.Event('input'));
    assert(!w.q('.send').disabled && /45 \/ 50/.test(w.q('.count').textContent));
    t.value = 'x'.repeat(55); t.dispatchEvent(new w.window.Event('input'));
    assert(w.q('.send').disabled && w.q('.count').classList.contains('over'));
  });

  await ta('persistence: the conversation survives a page navigation in the same tab', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    w.respond(async () => jsonResponse({ status: 'answer', source: 'data', text: 'Total: 12 MT', value: 12, unit: 'MT', provenance: { vessels: ['Aurora Trader'], period: 'August 2026', metric: 'Fuel consumption' } }));
    await w.type('fuel consumption last month');
    await w.idle();
    const saved = w.snapshotStorage();
    assert(Object.keys(saved).some((k) => /^kris:v1:/.test(k)), 'nothing saved');
    const w2 = boot({}, saved);
    await wait(60);
    assert(w2.q('.root').classList.contains('open'), 'panel should reopen where it was');
    assert(w2.qa('.turn.user').length === 1 && w2.qa('.turn.assistant').length === 1, 'turns not restored');
    assert(w2.q('.turn.assistant .figure'), 'data card not restored');
    assert(!w2.q('.welcome'), 'welcome shown over a restored conversation');
    w2.respond(async (b) => jsonResponse({ status: 'answer', source: 'agent', text: 'h=' + b.history.length }));
    await w2.type('and what about the one before');
    await w2.idle();
    assert(JSON.parse(w2.posts()[0].init.body).history.length >= 1, 'history not restored');
    const w3 = boot({ persist: false }, saved);
    await wait(40);
    assert(w3.qa('.turn').length === 0, 'persist:false must ignore storage');
  });

  await ta('new conversation clears turns, history, pending and this chat’s context; a name carries over only once remembered', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    w.respond(async () => jsonResponse({ status: 'answer', source: 'identity', text: 'Hi Nav', remember: { userName: 'Nav' } }));
    await w.type('my name is Nav');
    await w.idle();
    const memo = w.q('.turn.assistant .memo');
    assert(memo && /remember your name, Nav/.test(memo.textContent), 'no consent card for the name');
    w.q('.tool.newchat').click();
    assert(w.qa('.turn').length === 0 && w.q('.welcome'), 'not reset');
    assert(w.inst().history.length === 0 && w.inst().pending === null);
    assert(!/Nav/.test(w.q('.welcome h3').textContent), 'an unconfirmed name must not outlive its conversation');
    await w.type('my name is Nav');
    await w.idle();
    w.q('.turn.assistant .memo .btn.primary').click();
    w.q('.tool.newchat').click();
    assert(/Nav/.test(w.q('.welcome h3').textContent), 'remembered name dropped from greeting');
  });

  await ta('page context shows as a chip and tailors the suggested prompts (picker off)', async () => {
    const w = boot({ vesselPicker: false });
    await wait(20);
    w.window.KRIS.setContext({ vesselId: '9851701', vesselName: 'Aurora Trader' });
    assert(w.q('.box .ctx').classList.contains('on') && /Aurora Trader/.test(w.q('.box .ctx').textContent));
    assert([...w.qa('.prompts .q')].some((q) => /for Aurora Trader/.test(q.textContent)), 'prompts not tailored');
    w.window.KRIS.clearContext();
    assert(!w.q('.box .ctx').classList.contains('on'));
  });

  const VESSELS = [{ id: '1000019', name: 'SN Star' }, { id: '1000021', name: 'SN Sky' }];
  const lastContext = (w) => JSON.parse(w.posts().filter((c) => !JSON.parse(c.init.body).action).pop().init.body).context;
  const pickItem = (w, label) => [...w.qa('.ctxmenu [role=menuitemradio]')].find((b) => b.textContent === label);

  await ta('picker: lists the server’s vessels once; a pick is the context sent with questions; × clears it', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    w.respond(async (body) => (body.action === 'vessels' ? jsonResponse({ vessels: VESSELS }) : jsonResponse({ status: 'answer', source: 'agent', text: 'ok' })));
    const chip = w.q('.box .ctx');
    assert(chip.classList.contains('on') && chip.classList.contains('empty') && /Choose vessel or fleet/.test(chip.textContent), chip.textContent);
    chip.click(); await wait(20);
    const labels = [...w.qa('.ctxmenu [role=menuitemradio]')].map((b) => b.textContent);
    assert(JSON.stringify(labels) === JSON.stringify(['Entire fleet', 'SN Star', 'SN Sky']), JSON.stringify(labels));
    pickItem(w, 'SN Star').click();
    assert(w.q('.ctxmenu').hidden, 'menu stayed open');
    assert(/SN Star/.test(chip.textContent) && !chip.classList.contains('empty') && !w.q('.ctx-clear').hidden, chip.textContent);
    await w.type('fuel last month'); await w.idle();
    let c = lastContext(w);
    assert(c.vesselId === '1000019' && c.vesselName === 'SN Star' && !c.fleet, JSON.stringify(c));
    chip.click(); await wait(20);
    pickItem(w, 'Entire fleet').click();
    assert(/Entire fleet/.test(chip.textContent) && /whole fleet/.test(chip.title), chip.title);
    await w.type('co2 this year'); await w.idle();
    c = lastContext(w);
    assert(c.fleet === true && !c.vesselId && !c.vesselName, JSON.stringify(c));
    w.q('.ctx-clear').click();
    assert(chip.classList.contains('empty') && w.q('.ctx-clear').hidden);
    await w.type('co2 this year'); await w.idle();
    c = lastContext(w);
    assert(!c.fleet && !c.vesselId, JSON.stringify(c));
    assert(w.posts().filter((p) => JSON.parse(p.init.body).action === 'vessels').length === 1, 'vessel list fetched more than once');
  });

  await ta('picker: the pick beats the page’s vessel, stays for new chats and page loads, Esc closes it, clearing falls back to the page', async () => {
    const w = boot({ vessels: VESSELS });
    await wait(20);
    w.window.KRIS.open();
    w.window.KRIS.setContext({ vesselId: '1000021', vesselName: 'SN Sky' });
    const chip = w.q('.box .ctx');
    assert(/SN Sky/.test(chip.textContent) && w.q('.ctx-clear').hidden, 'page vessel not shown');
    chip.click(); await wait(20);
    assert(!w.posts().some((p) => JSON.parse(p.init.body).action === 'vessels'), 'asked the server although the host gave the list');
    pickItem(w, 'SN Star').click();
    w.window.KRIS.setContext({ vesselId: '1000021', vesselName: 'SN Sky' });   // the host page navigates
    assert(/SN Star/.test(chip.textContent), 'the page overrode the pick');
    await w.type('hello'); await w.idle();
    w.window.KRIS.newChat();
    assert(/SN Star/.test(chip.textContent), 'a new chat dropped the pick');
    const w2 = boot({ vessels: VESSELS }, w.snapshotStorage());
    await wait(20);
    assert(/SN Star/.test(w2.q('.box .ctx').textContent), 'the pick was lost on a page load: ' + w2.q('.box .ctx').textContent);
    chip.click(); await wait(20);
    assert(!w.q('.ctxmenu').hidden && chip.getAttribute('aria-expanded') === 'true');
    w.doc.dispatchEvent(new w.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert(w.q('.ctxmenu').hidden, 'Esc left the menu open');
    assert(w.inst().open, 'Esc closed the panel instead of just the menu');
    w.q('.ctx-clear').click();
    assert(/SN Sky/.test(chip.textContent), 'clearing did not fall back to the page vessel');
  });

  await ta('picker: a server error is shown in the menu, not a silent empty list', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    w.respond(async (body) => (body.action === 'vessels' ? jsonResponse({ status: 'error', vessels: [], detail: 'db.<ref>.supabase.co has only an IPv6 address' }, 503) : jsonResponse({ status: 'answer', text: 'ok' })));
    w.q('.box .ctx').click(); await wait(20);
    assert(/could not be loaded: db\.<ref>\.supabase\.co has only an IPv6 address/.test(w.q('.ctxmenu').textContent), w.q('.ctxmenu').textContent);
    assert(pickItem(w, 'Entire fleet'), 'fleet choice missing when the list fails');
  });

  await ta('markdown: code block with copy, table, heading, italic, safe links', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    w.respond(async () => jsonResponse({ status: 'answer', source: 'agent', text: '## Steps\nUse *care* and `ids`.\n\n```sql\nselect 1;\n```\n\n| A | B |\n|---|---|\n| x | 2 |\n\nSee [docs](https://example.com).' }));
    await w.type('format test');
    await w.idle();
    const m = w.q('.turn.assistant .msg');
    assert(m.querySelector('h4').textContent === 'Steps');
    assert(m.querySelector('em').textContent === 'care');
    assert(m.querySelector('.codeblock pre code').textContent === 'select 1;');
    assert(m.querySelector('.codeblock .bar button'), 'no copy on code');
    assert(m.querySelectorAll('table.grid tr').length === 2);
    const a = m.querySelector('a');
    assert(a && a.getAttribute('href') === 'https://example.com' && a.rel.indexOf('noopener') >= 0);
  });

  await ta('reactions: single-select, reported to the host hook, and they move the face', async () => {
    const seen = [];
    const w = boot({ onReaction: (r) => seen.push(r) });
    await wait(20);
    w.window.KRIS.open();
    w.respond(async () => jsonResponse({ status: 'answer', source: 'agent', text: 'ok' }));
    await w.type('something');
    await w.idle();
    const up = w.q('.turn.assistant .act.up');
    up.click();
    assert(up.classList.contains('on') && seen.length === 1 && seen[0].reaction === 'up' && seen[0].question === 'something');
    assert(w.q('.badge svg').getAttribute('data-mood') === 'happy');
    w.q('.turn.assistant .act.down').click();
    assert(!up.classList.contains('on') && seen[1].reaction === 'down');
  });

  await ta('personality: outgoing text picks the waiting expression', async () => {
    const w = boot();
    await wait(20);
    const c = (t) => w.inst().classifyOutgoing.call({ isFatigued: () => false, _lastNorm: null }, t);
    assert(c("you're so smart, great job!") === 'blush');
    assert(c('haha that is funny') === 'laughing');
    assert(c('thank you') === 'happy');
    assert(c("that's wrong, try again") === 'sad');
    assert(c('fuel consumption last month') === 'thinking');
  });

  await ta('inline mode renders the panel in place, without badge or close', async () => {
    const dom = new JSDOM('<!doctype html><body><div id="slot" style="height:500px"></div></body>', { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://host.test/' });
    dom.window.fetch = async () => jsonResponse({ status: 'ok' });
    dom.window.eval(SRC);
    dom.window.KRIS.init({ mount: '#slot' });
    await wait(20);
    const sr = dom.window.document.querySelector('#slot [data-kris-widget]').shadowRoot;
    assert(sr.querySelector('.root').classList.contains('inline') && sr.querySelector('.root').classList.contains('open'));
  });

  await ta('character: every copy is the K.R.1.S portrait, with its own ids', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    const svgs = w.qa('svg.k-char');
    assert(svgs.length === 3, 'expected badge, header and welcome portraits, got ' + svgs.length);
    for (const svg of svgs) {
      for (const part of ['.k-plume', '.k-flute', '.k-eye-l', '.k-eye-r', '.k-brow-l', '.k-cheek', '.m-idle', '.m-happy', '.k-eyes-shut']) {
        assert(svg.querySelector(part), 'missing ' + part);
      }
    }
    const ids = [...w.qa('svg.k-char [id]')].map((n) => n.id);
    assert(new Set(ids).size === ids.length, 'gradient / clip ids collide between copies');
    for (const svg of svgs) {
      for (const ref of svg.innerHTML.match(/url\(#([^)]+)\)/g) || []) {
        const id = ref.slice(5, -1);
        assert(svg.querySelector('[id="' + id + '"]'), 'dangling reference ' + id);
      }
    }
    assert(w.q('.badge .aura') && w.q('.badge .notes') && w.qa('.badge .notes i').length === 3, 'launcher ornaments missing');
    assert(w.q('.head h2').firstChild.textContent === 'K.R.1.S');
    assert(w.q('textarea').getAttribute('aria-label') === 'Message K.R.1.S');
    assert(w.q('.badge').getAttribute('aria-label') === 'Close K.R.1.S', 'badge label ' + w.q('.badge').getAttribute('aria-label'));
    assert(w.q('.welcome .kicker').textContent === 'Namaste');
  });

  await ta('character: busy state plays the flute, and the mood is mirrored on the root', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    let release;
    w.respond(() => new Promise((r) => { release = () => r(jsonResponse({ status: 'answer', source: 'data', text: 'Total: 12 MT', value: 12, unit: 'MT', provenance: { vessels: ['Aurora Trader'], period: 'August 2026', metric: 'Fuel consumption' } })); }));
    await w.type('fuel consumption last month');
    await wait(40);
    assert(w.q('.root').classList.contains('busy'), 'root not marked busy while answering');
    assert(w.q('.root').getAttribute('data-mood') === 'thinking', 'root mood ' + w.q('.root').getAttribute('data-mood'));
    release();
    await w.idle();
    assert(!w.q('.root').classList.contains('busy'), 'still busy after the answer');
    assert(w.q('.badge svg').getAttribute('data-mood') === 'happy', 'a found figure should make K.R.1.S smile');
    assert(w.q('.root').getAttribute('data-mood') === 'happy');
  });

  await ta('greetings in kind are answered locally with the same words', async () => {
    const w = boot();
    await wait(20);
    const r = (t, n) => w.window.KRIS._localReply(t, n || null);
    assert(/^Namaste, Nav\./.test(r('Namaste', 'Nav')), r('Namaste', 'Nav'));
    assert(/^Radhe Radhe\./.test(r('radhe radhe 🙏')), r('radhe radhe 🙏'));
    assert(/^Hare Krishna\./.test(r('Hare Krishna!')));
    assert(/^Jai Shri Krishna\./.test(r('jai sri krishna')), r('jai sri krishna'));
    for (const t of ['hi kris', 'thank you kris', 'bye K.R.1.S', 'how are you krishna?', 'dhanyavaad', 'hello there']) assert(r(t), 'not local: ' + t);
    assert(!r('namaste, fuel consumption last month'), 'a data question must still go to the server');
    const how = r('how are you?');
    assert(!/bridge|shipshape|steady as she goes/i.test(how), how);
  });

  await ta('401: the server\'s own explanation is shown, never a made-up "session expired"', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    w.respond(async () => jsonResponse({ status: 'unauthenticated', reason: 'auth_not_configured', text: 'I can’t confirm who you are yet — sign-in isn’t set up on this server.', detail: 'Server settings not renamed: OLDAPP_DEV_SESSION → KRIS_DEV_SESSION' }, 401));
    await w.type('fuel consumption last month');
    await w.idle();
    const n = w.q('.turn.assistant .notice');
    assert(n, 'no notice');
    assert(/sign-in isn’t set up on this server/.test(n.textContent), n.textContent);
    assert(!/expired/i.test(n.textContent), 'still says expired');
    assert(/OLDAPP_DEV_SESSION/.test(n.querySelector('.sub').textContent), 'hint not shown');
    assert(!n.querySelector('.retry'), 'retrying cannot fix a sign-in refusal');
    w.respond(async () => ({ ok: false, status: 401, headers: { get: () => 'application/json' }, json: async () => ({}), body: null }));
    await w.type('and last week');
    await w.idle();
    const last = w.qa('.turn.assistant .notice');
    assert(/couldn’t confirm your sign-in/.test(last[last.length - 1].textContent), 'fallback text');
  });

  await ta('theme: the header switch flips light and dark, labels itself, and is remembered for this browser', async () => {
    const w = boot({ theme: 'light' });
    await wait(20);
    w.window.KRIS.open();
    const root = w.q('.root');
    const btn = w.q('.tool.theme');
    assert(btn, 'no theme switch in the header');
    assert(root.getAttribute('data-theme') === 'light', 'start ' + root.getAttribute('data-theme'));
    assert(btn.getAttribute('aria-label') === 'Switch to dark theme', btn.getAttribute('aria-label'));
    btn.click();
    assert(root.getAttribute('data-theme') === 'dark', 'did not switch to dark');
    assert(btn.getAttribute('aria-label') === 'Switch to light theme', btn.getAttribute('aria-label'));
    assert(w.window.KRIS.getTheme() === 'dark');
    assert(w.window.localStorage.getItem('kris:theme') === 'dark', 'pick not remembered');
    await wait(450);
    assert(!root.classList.contains('theming'), 'transition class left behind');
    btn.click();
    assert(root.getAttribute('data-theme') === 'light' && w.window.localStorage.getItem('kris:theme') === 'light');
  });

  await ta('theme: a remembered pick beats the host default; host calls apply but are not remembered', async () => {
    const seen = [];
    const dom = new JSDOM(HOST, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://host.test/app' });
    dom.window.fetch = async () => jsonResponse({ status: 'ok' });
    dom.window.localStorage.setItem('kris:theme', 'dark');
    dom.window.eval(SRC);
    dom.window.KRIS.init({ endpoint: 'https://kris.test/api/kris', nudge: false, theme: 'light', onThemeChange: (t, pref) => seen.push(t + '/' + pref) });
    await wait(20);
    const root = dom.window.document.querySelector('[data-kris-widget]').shadowRoot.querySelector('.root');
    assert(root.getAttribute('data-theme') === 'dark', 'remembered pick ignored');
    assert(seen[0] === 'dark/dark', 'hook not told the starting theme: ' + seen.join());
    assert(dom.window.KRIS.setTheme('light') === true && root.getAttribute('data-theme') === 'light');
    assert(dom.window.localStorage.getItem('kris:theme') === 'dark', 'a host call must not overwrite the user pick');
    assert(dom.window.KRIS.setTheme('sepia') === false && root.getAttribute('data-theme') === 'light', 'unknown theme accepted');
    dom.window.KRIS.setTheme('auto');
    assert(root.getAttribute('data-theme') === 'light' && root.getAttribute('data-theme-pref') === 'auto', 'auto should resolve to light without an OS preference');
    assert(seen[seen.length - 1] === 'light/light', 'hook missed a change: ' + seen.join());
  });

  await ta('theme: auto follows the OS colour scheme, live, until the user picks', async () => {
    const dom = new JSDOM(HOST, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://host.test/app' });
    dom.window.fetch = async () => jsonResponse({ status: 'ok' });
    const listeners = [];
    const mq = { matches: true, addEventListener: (_, f) => listeners.push(f), removeEventListener: () => {} };
    dom.window.matchMedia = (q) => (/prefers-color-scheme: dark/.test(q) ? mq : { matches: false, addEventListener() {}, removeEventListener() {} });
    dom.window.eval(SRC);
    dom.window.KRIS.init({ endpoint: 'https://kris.test/api/kris', nudge: false });
    await wait(20);
    const sr = dom.window.document.querySelector('[data-kris-widget]').shadowRoot;
    const root = sr.querySelector('.root');
    assert(root.getAttribute('data-theme') === 'dark', 'default auto should follow a dark OS');
    mq.matches = false; listeners.forEach((f) => f());
    assert(root.getAttribute('data-theme') === 'light', 'did not follow the OS change');
    dom.window.KRIS.open();
    sr.querySelector('.tool.theme').click();
    assert(root.getAttribute('data-theme') === 'dark');
    mq.matches = false; listeners.forEach((f) => f());
    assert(root.getAttribute('data-theme') === 'dark', 'an OS change must not override the user pick');
  });

  await ta('theme: themeToggle:false hides the switch; tables align figure columns to the right', async () => {
    const w = boot({ themeToggle: false });
    await wait(20);
    assert(!w.q('.tool.theme'), 'switch shown despite themeToggle:false');
    w.window.KRIS.open();
    w.respond(async () => jsonResponse({ status: 'answer', source: 'agent', text: '| Year | Reduction | Note |\n|---|---|---|\n| 2025 | 2% | start |\n| 2030 | 6% | |' }));
    await w.type('table please');
    await w.idle();
    const ths = w.qa('.turn.assistant table.grid th');
    assert(!ths[0].classList.contains('num'), 'label column must stay left');
    assert(ths[1].classList.contains('num'), 'figure column header should align with its figures');
    assert(!ths[2].classList.contains('num'), 'text column marked numeric');
    assert(w.q('.turn.assistant table.grid tr:nth-child(2) td:nth-child(2)').classList.contains('num'));
  });

  await ta('composer foot appears only for the context chip or the counter (picker off)', async () => {
    const w = boot({ maxLength: 50, vesselPicker: false });
    await wait(20);
    const foot = w.q('.box .foot');
    assert(foot && !foot.classList.contains('on'), 'foot visible with nothing to show');
    w.window.KRIS.setContext({ vesselName: 'Aurora Trader' });
    assert(foot.classList.contains('on'), 'foot hidden with a context chip');
    w.window.KRIS.clearContext();
    assert(!foot.classList.contains('on'));
    const t = w.q('textarea');
    t.value = 'x'.repeat(45); t.dispatchEvent(new w.window.Event('input'));
    assert(foot.classList.contains('on'), 'foot hidden with the counter showing');
  });

  await ta('destroy removes the widget and its listeners', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.destroy();
    assert(!w.doc.querySelector('[data-kris-widget]'), 'still mounted');
  });

  console.log(`\nWidget: ${pass} passed, ${fails.length} failed`);
  fails.forEach((f) => console.log('  FAIL ' + f));
  process.exit(fails.length ? 1 : 0);
})();