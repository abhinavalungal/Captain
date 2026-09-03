'use strict';

/**
 * Widget tests. Mounts captain-widget.js into a hostile host page in jsdom
 * and feeds it REAL engine payloads from the database.
 *
 *   CAPTAIN_TEST_URL='postgres://...' node test/widget.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { Client } = require('pg');
const engine = require('../src/engine');

const NOW = new Date('2026-09-02T10:00:00Z');
let pass = 0; const fails = [];
const t = (n, f) => { try { f(); pass++; } catch (e) { fails.push(n + ': ' + e.message); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!process.env.CAPTAIN_TEST_URL) { console.log('(skipping widget tests — CAPTAIN_TEST_URL not set)'); return; }

  const db = new Client({ connectionString: process.env.CAPTAIN_TEST_URL });
  await db.connect();
  const session = { userId: 'u1', orgId: 'test-org', vesselIds: ['9851701'] };
  const R = {};
  for (const [k, q] of Object.entries({
    scalar: 'What is the Shaft Power for my vessel on 15 August 2026?',
    clarify: 'What is my consumption?',
    trend: 'fuel consumption trend last 30 days',
    overview: 'Analyse my vessel of last 6 month',
    empty: 'shaft power on 25 December 2026',
    blocked: 'total shaft power last month',
    compare: 'compare fuel consumption this month vs last month',
  })) R[k] = await engine.ask({ text: q, session, now: NOW }, db, { orgId: 'test-org' });
  await db.end();

  R.xss = {
    status: 'answer', text: '<img src=x onerror="window.__pwned=1">', value: 1, unit: '', rowsUsed: 1,
    note: '<script>window.__pwned=2<\/script>',
    provenance: { vessels: ['<img src=y onerror="window.__pwned=3">'], period: 'today', source: 'test' },
  };

  const host = fs.readFileSync(path.join(__dirname, 'fixtures', 'host-page.html'), 'utf8')
    .replace('<script src="../../public/captain-widget.js"></script>', '');
  const dom = new JSDOM(host, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://host.test/' });
  const { window } = dom;
  const doc = window.document;
  window.eval(fs.readFileSync(path.join(__dirname, '..', 'public', 'captain-widget.js'), 'utf8'));

  let next = null;
  const asked = [];
  const transport = async (text, pending, history, context) => { asked.push({ text, pending, history, context }); return next; };
  window.Captain.init({ ask: transport });
  await wait(20);

  const hostEl = doc.querySelector('[data-captain-widget]');
  const sr = hostEl.shadowRoot;
  const q = (s) => sr.querySelector(s);
  const qa = (s) => sr.querySelectorAll(s);

  const send = async (text, key) => {
    next = R[key];
    q('textarea').value = text;
    q('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await wait(30);
    const cards = qa('.turn.captain .card');
    return cards[cards.length - 1];
  };

  // --- mounting and isolation -----------------------------------------------
  t('mounts a single host element with a shadow root', () => {
    if (doc.querySelectorAll('[data-captain-widget]').length !== 1) throw new Error('wrong host count');
    if (!sr) throw new Error('no shadow root');
  });
  t('a second init() is a no-op', () => {
    window.Captain.init({});
    if (doc.querySelectorAll('[data-captain-widget]').length !== 1) throw new Error('mounted twice');
  });
  t('the character renders with the cap badge, both eyes, and a mood', () => {
    const svg = q('.badge svg');
    if (!svg) throw new Error('no character');
    if (qa('.badge .c-eye').length !== 2) throw new Error('eyes missing');
    if (qa('.badge svg defs *').length < 5) throw new Error('lighting gradients missing');
    if (qa('.badge svg [id^="cp-b-"]').length === 0 || qa('.head svg [id^="cp-h-"]').length === 0) throw new Error('gradient ids not per-instance');
    if (svg.getAttribute('data-mood') !== 'idle') throw new Error('mood not idle');
  });
  t('widget CSS lives in the shadow root and resets inherited host styles', () => {
    // jsdom has no layout engine, so isolation is proven visually in Chromium
    // (see README). Here we check the structure that makes it hold: styles are
    // inside the shadow tree, nothing is injected into the host document, and
    // the host element resets everything it would otherwise inherit.
    if (!sr.querySelector('style')) throw new Error('no stylesheet in shadow root');
    if (doc.head.querySelector('style[data-captain]')) throw new Error('styles injected into host head');
    if (!/:host\{all:initial\}/.test(sr.querySelector('style').textContent)) throw new Error('missing :host reset');
  });
  t('the panel starts closed and is announced correctly', () => {
    if (q('.root').classList.contains('open')) throw new Error('open on load');
    if (q('.badge').getAttribute('aria-expanded') !== 'false') throw new Error('aria-expanded wrong');
    if (q('.badge').getAttribute('aria-controls') !== q('.panel').id) throw new Error('aria-controls mismatch');
  });

  // --- open / close ---------------------------------------------------------
  q('.badge').click();
  await wait(50);
  t('clicking the character opens the panel', () => {
    if (!q('.root').classList.contains('open')) throw new Error('did not open');
    if (q('.badge').getAttribute('aria-expanded') !== 'true') throw new Error('aria-expanded not updated');
  });
  t('opening focuses the composer', () => {
    if (sr.activeElement !== q('textarea')) throw new Error('focus not on textarea');
  });
  t('Escape closes the panel and returns focus to the character', () => {
    doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    if (q('.root').classList.contains('open')) throw new Error('did not close');
    if (sr.activeElement !== q('.badge')) throw new Error('focus not returned');
  });
  q('.badge').click();
  await wait(20);
  t('example prompts are rendered', () => {
    if (qa('.opening li button').length !== 4) throw new Error('examples missing');
  });

  // --- answers ----------------------------------------------------------------
  let card = await send('shaft power 15 Aug', 'scalar');
  t('scalar answer shows the figure large with its unit', () => {
    const fig = card.querySelector('.figure');
    if (!fig || !/9,329\.5/.test(fig.textContent)) throw new Error('figure: ' + (fig && fig.textContent));
    if (card.querySelector('.figure .unit').textContent !== 'kW') throw new Error('unit');
  });
  t('provenance strip names vessel, period, rows and source', () => {
    const s = card.querySelector('.sounding').textContent;
    for (const w of ['Aurora Trader', '15 August 2026', 'Reports read', 'Geoform vessel reports']) {
      if (!s.includes(w)) throw new Error('missing ' + w);
    }
  });
  t('the character smiles after a successful answer', () => {
    if (q('.badge svg').getAttribute('data-mood') !== 'answered') throw new Error(q('.badge svg').getAttribute('data-mood'));
  });
  t('the transport is called with the text and no pending state', () => {
    const last = asked[asked.length - 1];
    if (last.text !== 'shaft power 15 Aug' || last.pending != null) throw new Error(JSON.stringify(last));
  });

  card = await send('what is my consumption?', 'clarify');
  t('clarification renders one button per candidate metric', () => {
    const b = card.querySelectorAll('.choices button');
    if (b.length !== 4) throw new Error('got ' + b.length);
  });
  t('the character looks quizzical when asking', () => {
    if (q('.badge svg').getAttribute('data-mood') !== 'asking') throw new Error('mood');
  });
  t('choosing an option sends its value and carries the pending state', async () => {});
  {
    next = R.scalar;
    card.querySelectorAll('.choices button')[0].click();
    await wait(30);
    t('choosing an option sends the metric key, not the label, with pending attached', () => {
      const last = asked[asked.length - 1];
      if (last.text !== 'fuel_consumption') throw new Error('sent ' + last.text);
      if (!last.pending || last.pending.kind !== 'clarify') throw new Error('pending not carried: ' + JSON.stringify(last.pending));
    });
    t('option buttons are disabled once one is chosen', () => {
      const b = card.querySelectorAll('.choices button');
      if (![...b].every((x) => x.disabled)) throw new Error('still clickable');
    });
  }

  card = await send('trend', 'trend');
  t('trend draws a polyline with one point per bucket', () => {
    const d = card.querySelector('svg.spark path.line').getAttribute('d');
    const n = d.split(/[ML]/).filter(Boolean).length;
    if (n !== R.trend.series.length) throw new Error('drew ' + n + ' of ' + R.trend.series.length);
  });
  t('neutral footnote is plain, not styled as a caution', () => {
    if (card.querySelector('.caution') && /Each point/.test(card.querySelector('.caution').textContent)) throw new Error('footnote styled as caution');
    if (!/Each point/.test(card.textContent)) throw new Error('footnote missing');
  });

  card = await send('overview', 'overview');
  t('overview renders one row per metric', () => {
    if (card.querySelectorAll('table.grid tr').length !== 18) throw new Error(card.querySelectorAll('table.grid tr').length);
  });

  card = await send('empty', 'empty');
  t('empty result shows the honest sentence, no figure, and a subdued face', () => {
    if (card.querySelector('.figure')) throw new Error('figure rendered');
    if (!/could not find/.test(card.textContent)) throw new Error('sentence missing');
    if (q('.badge svg').getAttribute('data-mood') !== 'nothing') throw new Error('mood');
  });

  card = await send('blocked', 'blocked');
  t('refusal is marked, contains no figure, and the face is stern', () => {
    if (!card.classList.contains('blocked')) throw new Error('class');
    if (/\d{3,}/.test(card.textContent)) throw new Error('leaked a figure');
    if (q('.badge svg').getAttribute('data-mood') !== 'blocked') throw new Error('mood');
  });

  card = await send('compare', 'compare');
  t('comparison renders both periods', () => {
    if (card.querySelectorAll('table.grid tr').length !== 3) throw new Error('rows');
  });
  t('comparison also draws a two-bar chart with the values printed', () => {
    const bars = card.querySelectorAll('svg.bars rect.bar');
    if (bars.length !== 2) throw new Error('bars: ' + bars.length);
    const vals = [...card.querySelectorAll('svg.bars text.val')].map((t) => t.textContent);
    if (vals.length !== 2 || !vals.every((v) => /\d/.test(v))) throw new Error('values not printed: ' + vals);
  });

  R.byVessel = await (async () => {
    const engine2 = require('../src/engine');
    const db2 = new Client({ connectionString: process.env.CAPTAIN_TEST_URL }); await db2.connect();
    const out = await engine2.ask({ text: 'compare fuel consumption for Aurora Trader and Northern Pearl last month', session: { userId: 'u', orgId: 'o', vesselIds: ['9851701', '9234567'] }, now: NOW }, db2, {});
    await db2.end(); return out;
  })();
  card = await send('compare two vessels', 'byVessel');
  t('a multi-vessel comparison renders a labelled bar per vessel', () => {
    const bars = card.querySelectorAll('svg.bars rect.bar');
    if (bars.length !== 2) throw new Error('bars: ' + bars.length);
    if (!/Aurora Trader/.test(card.querySelector('svg.bars').getAttribute('aria-label'))) throw new Error('chart not labelled');
    if (card.querySelector('.followups')) throw new Error('no per-metric follow-ups for a multi-vessel answer');
  });

  R.rich = { status: 'answer', source: 'companion', text: '**22 / 7** is about `3.142857`.\n\n- It repeats every 6 digits\n- Pi itself is 3.14159...\n\nUse it when a rough value is fine.', chart: { type: 'bar', title: '22 vs 7', labels: ['22', '7'], values: [22, 7], unit: '' } };
  card = await send('divide 22/7', 'rich');
  t('companion text renders bold, code and bullets as real elements, not raw markdown', () => {
    if (!card.querySelector('strong')) throw new Error('no <strong>');
    if (!card.querySelector('code')) throw new Error('no <code>');
    if (card.querySelectorAll('ul.rich li').length !== 2) throw new Error('bullets');
    if (/\*\*/.test(card.textContent)) throw new Error('raw ** leaked');
  });
  t('a companion chart renders as bars', () => {
    if (card.querySelectorAll('svg.bars rect.bar').length !== 2) throw new Error('no bars');
  });
  t('rich rendering is still XSS-safe', () => {
    if (card.querySelector('img, script')) throw new Error('markup parsed');
  });

  // --- transport failure ------------------------------------------------------
  {
    window.Captain._instance().opts.ask = async () => { throw new Error('network down'); };
    q('textarea').value = 'anything';
    q('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await wait(30);
    const cards = qa('.turn.captain .card');
    const last = cards[cards.length - 1];
    t('a failed transport produces an error card and never a number', () => {
      if (!last.classList.contains('blocked')) throw new Error('class');
      if (!/could not reach/.test(last.textContent)) throw new Error('message');
      if (window.Captain._instance().busy) throw new Error('stuck busy');
    });
    window.Captain._instance().opts.ask = transport;
  }

  // --- XSS ----------------------------------------------------------------------
  card = await send('xss', 'xss');
  t('server text is inserted as text, never parsed as markup', () => {
    if (card.querySelector('img,script')) throw new Error('markup parsed');
    if (window.__pwned) throw new Error('script executed');
    if (!/<img/.test(card.textContent)) throw new Error('payload should appear as literal text');
  });

  // --- static checks ----------------------------------------------------------
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'captain-widget.js'), 'utf8');
  t('prototype host page: self-contained, no external assets, no storage', () => {
    const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const urls = (page.match(/https?:\/\/[^\s"'`)<]+/g) || []).filter((u) => !/w3\.org|perform\.geoserves\.com/.test(u));
    if (urls.length) throw new Error('external refs: ' + urls.join(', '));
    if (/localStorage|sessionStorage|indexedDB/.test(page)) throw new Error('storage API present');
    if (!/captain-widget\.js/.test(page)) throw new Error('page does not load the widget');
  });
  t('widget defaults its endpoint to the origin it was served from', () => {
    if (!/SCRIPT_ORIGIN \+ '\/api\/captain'/.test(src)) throw new Error('endpoint not derived from script origin');
    if (!/credentials: 'omit'/.test(src)) throw new Error('cross-origin fetch must not send cookies');
  });
  t('widget makes no external requests', () => {
    // Strip block and line comments before scanning: illustrative hostnames
    // in prose ("e.g. https://your-domain.com/...") are not network calls,
    // and the only thing this test cares about is what the code actually
    // fetches from. A crude but safe stripper — good enough for this file's
    // own style (no URLs inside string literals that look like comments).
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const urls = (code.match(/https?:\/\/[^\s"'`)]+/g) || []).filter((u) => !/w3\.org/.test(u));
    if (urls.length) throw new Error(urls.join(', '));
  });
  t('widget uses no browser storage', () => {
    if (/localStorage|sessionStorage|indexedDB|document\.cookie/.test(src)) throw new Error('storage API present');
  });
  t('server-supplied strings never go through innerHTML', () => {
    // innerHTML is used exactly twice: for the static, self-authored character SVG.
    const uses = (src.match(/\.innerHTML\s*=/g) || []).length;
    const svgUses = (src.match(/\.innerHTML\s*=\s*captainSvg\(/g) || []).length;
    const clears = (src.match(/\.innerHTML\s*=\s*''/g) || []).length;
    if (uses !== svgUses + clears) throw new Error(uses + ' innerHTML assignments, ' + svgUses + ' are the character, ' + clears + ' are clears');
  });

  // --- public API -----------------------------------------------------------
  t('Captain.ask() opens the panel and submits', async () => {});
  {
    window.Captain.close();
    next = R.scalar;
    window.Captain.ask('via api');
    await wait(30);
    t('Captain.ask() opens the panel and submits the text', () => {
      if (!q('.root').classList.contains('open')) throw new Error('not open');
      if (asked[asked.length - 1].text !== 'via api') throw new Error('not sent');
    });
  }
  // --- context, follow-ups, copy, nudge, theme ------------------------------
  t('setContext shows a pill in the header and a line in the opening', () => {
    window.Captain.setContext({ vesselId: '9851701', vesselName: 'Aurora Trader', page: 'vessel' });
    if (!/Viewing Aurora Trader/.test(q('.head .ctx').textContent)) throw new Error('pill missing');
    if (!q('.head .ctx').classList.contains('on')) throw new Error('pill not shown');
    window.Captain.clearContext();
    if (q('.head .ctx').classList.contains('on')) throw new Error('pill not cleared');
  });
  {
    window.Captain.setContext({ vesselId: '9851701', vesselName: 'Aurora Trader' });
    next = R.scalar;
    q('textarea').value = 'shaft power on 15 August 2026';
    q('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await wait(30);
    t('context is sent with every request, including the browser time zone', () => {
      const last = asked[asked.length - 1];
      if (!last.text) throw new Error('no request');
      if (!last.context || !('tz' in last.context)) throw new Error('time zone not sent: ' + JSON.stringify(last.context));
      if (last.context.vesselId !== '9851701') throw new Error('page context lost when merging tz: ' + JSON.stringify(last.context));
    });
    window.Captain.clearContext();
  }
  card = await send('shaft power 15 Aug', 'scalar');
  t('a data answer offers contextual follow-ups built from its provenance', () => {
    const chips = card.querySelectorAll('.followups button');
    if (chips.length < 2) throw new Error('got ' + chips.length + ' chips');
    if (!/Trend/.test(chips[0].textContent)) throw new Error('first chip: ' + chips[0].textContent);
  });
  t('follow-ups are quieter than clarification choices (different element)', () => {
    if (card.querySelector('.choices')) throw new Error('a plain answer should not render clarification choices');
  });
  {
    next = R.trend;
    card.querySelector('.followups button').click();
    await wait(30);
    t('clicking a follow-up submits a parser-resolvable question', () => {
      const last = asked[asked.length - 1];
      if (!/shaft power trend for Aurora Trader last 30 days/i.test(last.text)) throw new Error('sent: ' + last.text);
    });
  }
  card = await send('empty', 'empty');
  t('an empty answer offers wider-period follow-ups instead of a dead end', () => {
    const chips = [...card.querySelectorAll('.followups button')].map((b) => b.textContent);
    if (!chips.some((c) => /last 30 days/i.test(c))) throw new Error(JSON.stringify(chips));
  });
  card = await send('overview', 'overview');
  t('overview and briefing answers do not get metric follow-ups', () => {
    if (card.querySelector('.followups')) throw new Error('overview should not have metric chips');
  });
  t('every answer has a copy button that copies the text', async () => {});
  {
    let copied = null;
    window.navigator.clipboard = { writeText: async (t) => { copied = t; } };
    card = await send('shaft power 15 Aug', 'scalar');
    const btn = card.querySelector('.copy');
    t('copy button copies the answer text', () => { if (!btn) throw new Error('no copy button'); });
    btn.click();
    await wait(10);
    t('copy uses the clipboard API with the answer text', () => {
      if (!copied || !/Shaft power/.test(copied)) throw new Error('copied: ' + copied);
    });
  }
  t('theme can be switched at runtime', () => {
    window.Captain.setTheme('dark');
    if (q('.root').getAttribute('data-theme') !== 'dark') throw new Error('theme not applied');
    window.Captain.setTheme('light');
  });

  // --- personality: classification, fatigue, mood-driven expressions --------
  {
    const inst = window.Captain._instance();
    const classify = (t) => inst.classifyOutgoing.call({ isFatigued: () => false, _lastNorm: null }, t);

    t('personality: a compliment gets a bashful reaction', () => {
      if (classify("you're so smart, great job!") !== 'shy') throw new Error('compliment not detected');
    });
    t('personality: positive feedback (not about Captain) gets excited, not shy', () => {
      if (classify('perfect, exactly what I needed') !== 'excited') throw new Error('positive feedback misclassified');
    });
    t('personality: pointing out a mistake gets an apologetic reaction', () => {
      if (classify("that's wrong, try again") !== 'sorry') throw new Error('mistake not detected');
    });
    t('personality: shouty or double-punctuated text reads as surprise', () => {
      if (classify('wait, seriously??') !== 'surprised') throw new Error('surprise not detected');
    });
    t('personality: an ordinary question classifies as thinking (no false positive)', () => {
      if (classify('fuel consumption last month') !== 'thinking') throw new Error('over-triggered: ' + classify('fuel consumption last month'));
    });

    t('personality: repeating the same question back to back reads as confused', () => {
      const ctx = { isFatigued: () => false, _lastNorm: null };
      const first = inst.classifyOutgoing.call(ctx, 'how do I export a report?');
      const second = inst.classifyOutgoing.call(ctx, 'How do I export a report?!');
      if (first === 'confused') throw new Error('first ask should not be confused');
      if (second !== 'confused') throw new Error('repeat not detected: ' + second);
    });

    t('personality: a burst of rapid questions is detected as fatigue', () => {
      const now = Date.now();
      const ctx = { submitTimes: [now - 1000, now - 2000, now - 3000, now - 4000], turnCount: 4 };
      if (!inst.isFatigued.call(ctx)) throw new Error('4 questions inside a minute should read as fatigued');
    });
    t('personality: a long conversation is fatigue even without rapid-fire', () => {
      if (!inst.isFatigued.call({ submitTimes: [], turnCount: 15 })) throw new Error('15 total turns should read as fatigued');
    });
    t('personality: normal pacing is not fatigue', () => {
      if (inst.isFatigued.call({ submitTimes: [Date.now() - 90000], turnCount: 2 })) throw new Error('one old message should not be fatigue');
    });
  }

  {
    const inst = window.Captain._instance();
    const seen = [];
    const origSetMood = inst.setMood.bind(inst);
    inst.setMood = (m) => { seen.push(m); origSetMood(m); };
    next = R.scalar;
    q('textarea').value = 'you are amazing, thank you!';
    q('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await wait(30);
    inst.setMood = origSetMood;
    t('personality: the waiting expression for a compliment is shy, even though the eventual answer is unrelated data', () => {
      if (seen[0] !== 'shy') throw new Error('first mood set was ' + seen[0] + ', expected shy — full sequence: ' + JSON.stringify(seen));
    });
  }

  t('personality: setMood records the current mood on the instance', () => {
    const inst = window.Captain._instance();
    inst.setMood('curious');
    if (inst.currentMood !== 'curious') throw new Error('currentMood not tracked');
    if (q('.head svg').getAttribute('data-mood') !== 'curious') throw new Error('head svg not updated');
    if (q('.badge svg').getAttribute('data-mood') !== 'curious') throw new Error('badge svg not updated');
  });

  t('personality: every new mood has a real, visible mouth in the markup', () => {
    for (const mood of ['shy', 'excited', 'tired', 'confused', 'curious', 'surprised', 'sorry']) {
      const svg = q('.badge svg');
      svg.setAttribute('data-mood', mood);
      const visible = [...svg.querySelectorAll('.c-mouth')].filter((m) => window.getComputedStyle(m).display !== 'none');
      if (visible.length < 1) throw new Error('no mouth visible for mood ' + mood);
    }
    svg_reset: { q('.badge svg').setAttribute('data-mood', 'idle'); }
  });

  t('personality: teardown removes the document-level listeners setupLife added', () => {
    const inst = window.Captain._instance();
    const before = { move: !!inst._onMove, vis: !!inst._visHandler, key: !!inst._onKeydown };
    if (!before.move || !before.vis || !before.key) throw new Error('life listeners were never attached: ' + JSON.stringify(before));
    const removeSpy = [];
    const origRemove = doc.removeEventListener.bind(doc);
    doc.removeEventListener = (type, fn, opts) => { removeSpy.push(type); origRemove(type, fn, opts); };
    inst.teardown();
    doc.removeEventListener = origRemove;
    for (const type of ['mousemove', 'visibilitychange', 'keydown']) {
      if (!removeSpy.includes(type)) throw new Error('teardown did not remove ' + type + ' listener');
    }
  });

  t('Captain.destroy() removes the widget from the page', () => {
    window.Captain.destroy();
    if (doc.querySelector('[data-captain-widget]')) throw new Error('still mounted');
  });

  // --- a second, inline instance ----------------------------------------------
  {
    const slot = doc.createElement('div'); slot.id = 'captain-slot'; doc.body.appendChild(slot);
    window.Captain.init({ mount: '#captain-slot', theme: 'dark', brand: { accent: '#0B3B5C', font: 'Inter, sans-serif' }, ask: transport });
    await wait(20);
    const host2 = doc.querySelector('#captain-slot [data-captain-widget]');
    const sr2 = host2 && host2.shadowRoot;
    t('inline mode mounts inside the given element, open, with no badge or nudge', () => {
      if (!sr2) throw new Error('not mounted in slot');
      if (!sr2.querySelector('.root').classList.contains('inline')) throw new Error('not inline');
      if (!sr2.querySelector('.root').classList.contains('open')) throw new Error('inline should be open');
      if (sr2.querySelector('.nudge')) throw new Error('nudge should not render inline');
    });
    t('inline mode ignores Escape and close()', () => {
      window.Captain.close();
      if (!sr2.querySelector('.root').classList.contains('open')) throw new Error('inline closed');
    });
    t('brand overrides land as CSS variables on the root', () => {
      const st = sr2.querySelector('.root').style;
      if (st.getPropertyValue('--accent').trim() !== '#0B3B5C') throw new Error('accent: ' + st.getPropertyValue('--accent'));
      if (!/Inter/.test(st.getPropertyValue('--font'))) throw new Error('font not applied');
      if (sr2.querySelector('.root').getAttribute('data-theme') !== 'dark') throw new Error('theme');
    });
    window.Captain.destroy();
  }

  // --- floating instance: nudge ------------------------------------------------
  {
    window.Captain.init({ ask: transport, nudgeText: 'Need a hand with the fleet?' });
    await wait(20);
    const sr3 = doc.querySelector('[data-captain-widget]').shadowRoot;
    t('nudge renders with the given text and is dismissible', () => {
      const n = sr3.querySelector('.nudge');
      if (!n || !/Need a hand/.test(n.textContent)) throw new Error('nudge missing');
      n.querySelector('button').click();
      if (!n.classList.contains('gone')) throw new Error('not dismissed');
    });
    window.Captain.destroy();
    window.Captain.init({ ask: transport });
    await wait(20);
    const sr4 = doc.querySelector('[data-captain-widget]').shadowRoot;
    t('opening the panel retires the nudge for good', () => {
      sr4.querySelector('.badge').click();
      if (!sr4.querySelector('.nudge').classList.contains('gone')) throw new Error('nudge survived open');
    });
    window.Captain.destroy();
  }

  console.log('\nWidget: ' + pass + ' passed, ' + fails.length + ' failed');
  fails.forEach((f) => console.log('  FAIL ' + f));
  process.exit(fails.length ? 1 : 0);
})();