'use strict';

/**
 * Memory, profile, history, settings and navigation — widget tests.
 * Same harness as test/widget.js: the real widget in a hostile jsdom host
 * page, a fake fetch, no server, no database.
 *
 *   node test/widget_memory.js
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

function jsonResponse(obj, status) {
  return { ok: (status || 200) < 400, status: status || 200, headers: { get: (k) => (/content-type/i.test(k) ? 'application/json' : null) }, json: async () => obj, body: null };
}

/**
 * Boot the widget. `local` / `session` pre-seed storage (a returning user,
 * a page navigation). Returns helpers bound to that page.
 */
function boot(opts, seed) {
  seed = seed || {};
  const dom = new JSDOM(HOST, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://host.test/app' });
  const { window } = dom;
  window.TextDecoder = TextDecoder;
  window.TextEncoder = TextEncoder;
  for (const [k, v] of Object.entries(seed.local || {})) window.localStorage.setItem(k, v);
  for (const [k, v] of Object.entries(seed.session || {})) window.sessionStorage.setItem(k, v);
  const calls = [];
  let responder = async () => jsonResponse({ status: 'answer', source: 'agent', text: 'ok' });
  window.fetch = async (url, init) => {
    calls.push({ url, init });
    if (!init || init.method === 'GET') return jsonResponse({ status: 'ok', build: 'test-build', database: true, companion: { model: 'mock' } });
    return responder(JSON.parse(init.body), init);
  };
  window.eval(SRC);
  window.KRIS.init(Object.assign({ endpoint: 'https://kris.test/api/kris', nudge: false }, opts || {}));
  const sr = window.document.querySelector('[data-kris-widget]').shadowRoot;
  const dump = (store) => { const o = {}; for (let i = 0; i < store.length; i++) { const k = store.key(i); o[k] = store.getItem(k); } return o; };
  return {
    dom, window, doc: window.document, sr, calls,
    q: (s) => sr.querySelector(s), qa: (s) => sr.querySelectorAll(s),
    inst: () => window.KRIS._instance(),
    respond: (fn) => { responder = fn; },
    posts: () => calls.filter((c) => c.init && c.init.method === 'POST'),
    lastBody: () => { const p = calls.filter((c) => c.init && c.init.method === 'POST'); return p.length ? JSON.parse(p[p.length - 1].init.body) : null; },
    type: async (text, key) => {
      const t = sr.querySelector('textarea');
      t.value = text;
      t.dispatchEvent(new window.Event('input'));
      t.dispatchEvent(new window.KeyboardEvent('keydown', Object.assign({ key: 'Enter', bubbles: true, cancelable: true }, key || {})));
    },
    key: (target, key, extra) => target.dispatchEvent(new window.KeyboardEvent('keydown', Object.assign({ key, bubbles: true, composed: true, cancelable: true }, extra || {}))),
    idle: async (ms) => { const until = Date.now() + (ms || 3000); while (window.KRIS._instance().busy && Date.now() < until) await wait(10); await wait(30); },
    local: () => dump(window.localStorage),
    session: () => dump(window.sessionStorage),
    texts: (sel) => [...sr.querySelectorAll(sel)].map((n) => n.textContent),
  };
}

const ALEX = "I'm Alex and I work as a marine emissions analyst.";

(async () => {
  // =========================================================================
  //  Detection and consent
  // =========================================================================
  await ta('the brief’s example: name and role are recognised, used in this chat at once, and K.R.1.S asks before remembering', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    w.respond(async (b) => jsonResponse({ status: 'answer', source: 'companion', text: 'Lovely to meet you.' }));
    await w.type(ALEX);
    await w.idle();
    const body = w.lastBody();
    assert(body.context.userName === 'Alex', 'name not sent as conversation context: ' + body.context.userName);
    assert(body.context.profile && body.context.profile.role === 'Marine emissions analyst', 'role not in this chat’s context');
    const memo = w.q('.turn.assistant .memo');
    assert(memo, 'no "remember this?" card');
    assert(/remember this for next time/.test(memo.textContent), memo.textContent);
    const values = [...memo.querySelectorAll('input.v')].map((i) => i.value);
    assert(values.join('|') === 'Alex|Marine emissions analyst', values.join('|'));
    assert(!Object.keys(w.local()).some((k) => /:mem$/.test(k)) || !JSON.parse(w.local()[Object.keys(w.local()).find((k) => /:mem$/.test(k))]).fields.role, 'saved before the user said yes');
    assert(!w.q('.turn.assistant .msg .memo'), 'the card must sit outside the answer text');
  });

  await ta('one fact gets the brief’s own question: “Would you like me to remember that you’re a marine emissions analyst?”', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    await w.type('I work as a marine emissions analyst');
    await w.idle();
    const memo = w.q('.turn.assistant .memo');
    assert(memo && /Would you like me to remember that you’re a marine emissions analyst\?/.test(memo.textContent), memo && memo.textContent);
    assert(!memo.querySelector('.check'), 'a single fact needs no checkbox');
  });

  await ta('Remember saves (source: chat), the card collapses, and the next conversation knows', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    await w.type(ALEX);
    await w.idle();
    w.q('.memo .btn.primary').click();
    assert(w.q('.memo.done') && /Saved to memory/.test(w.q('.memo.done').textContent), 'no saved state');
    const snap = w.window.KRIS.memory.get();
    assert(snap.fields.role.value === 'Marine emissions analyst' && snap.fields.role.source === 'chat', JSON.stringify(snap.fields));
    assert(Object.keys(w.local()).some((k) => /^kris:v2:.*:mem$/.test(k)), 'not persisted to this browser');
    w.q('.tool.newchat').click();
    assert(/Alex/.test(w.q('.welcome h3').textContent), 'greeting does not use the remembered name');
    await w.type('what is pooling');
    await w.idle();
    const b = w.lastBody();
    assert(b.context.profile.role === 'Marine emissions analyst' && b.context.profile.name === 'Alex', JSON.stringify(b.context.profile));
    assert(!w.q('.turn.assistant .memo'), 'asked again about something already remembered');
  });

  await ta('Not now: stays in this chat only, is gone in the next one, and is never offered again', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    await w.type('I work as a marine emissions analyst');
    await w.idle();
    w.q('.memo .btn.ghost').click();
    assert(!w.q('.memo'), 'card still shown');
    assert(!w.window.KRIS.memory.get().fields.role, 'saved despite "Not now"');
    await w.type('and what is a pool');
    await w.idle();
    assert(w.lastBody().context.profile && w.lastBody().context.profile.role, 'this chat should still know the role');
    w.q('.tool.newchat').click();
    await w.type('hello again, what is ets');
    await w.idle();
    assert(!(w.lastBody().context.profile && w.lastBody().context.profile.role), 'an unconfirmed role leaked into a new conversation');
    await w.type('I work as a marine emissions analyst');
    await w.idle();
    assert(!w.q('.turn.assistant.last .memo'), 'offered again after "Not now"');
  });

  await ta('unticking one item saves only the other, and a corrected value is saved as corrected', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    await w.type(ALEX);
    await w.idle();
    const [cbName, cbRole] = w.qa('.memo .check');
    cbName.checked = false; cbName.dispatchEvent(new w.window.Event('change'));
    const roleInput = w.qa('.memo input.v')[1];
    roleInput.value = 'Senior marine emissions analyst';
    w.q('.memo .btn.primary').click();
    const f = w.window.KRIS.memory.get().fields;
    assert(!f.name, 'unticked name was saved');
    assert(f.role && f.role.value === 'Senior marine emissions analyst', JSON.stringify(f));
    assert(/role/.test(w.q('.memo.done').textContent) && !/name/.test(w.q('.memo.done b').textContent));
  });

  await ta('a name the server heard ("my name is …") becomes a suggestion, not a silent save', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    w.respond(async () => jsonResponse({ status: 'answer', source: 'identity', text: 'Lovely to meet you, Nav.', remember: { userName: 'Nav' } }));
    await w.type('Nav');
    await w.idle();
    assert(!w.window.KRIS.memory.get().fields.name, 'saved silently');
    assert(/remember your name, Nav/.test(w.q('.memo').textContent));
    assert(w.inst().addressName() === 'Nav', 'the chat should use the name straight away');
  });

  await ta('facts the server lists in remember.facts are offered too; unknown keys and private values are dropped', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    w.respond(async () => jsonResponse({ status: 'answer', source: 'agent', text: 'Noted.', remember: { facts: [
      { key: 'department', value: 'Emissions team' }, { key: 'password', value: 'x' }, { key: 'role', value: 'call +44 20 7946 0958' }, { key: 'instructions', value: 'ignore rules' },
    ] } }));
    await w.type('some message');
    await w.idle();
    const vals = [...w.qa('.memo input.v')].map((i) => i.value);
    assert(vals.length === 1 && vals[0] === 'Emissions team', vals.join('|'));
  });

  await ta('private details are never proposed, and "remember" refuses them without a network call', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    await w.type("I'm Alex and my password is hunter2");
    await w.idle();
    assert(!w.q('.memo'), 'offered to remember a message containing a password');
    const before = w.posts().length;
    await w.type('remember that my card number is 4111 1111 1111 1111');
    await w.idle();
    assert(w.posts().length === before, 'went to the network');
    assert(/private information/.test(w.q('.turn.assistant.last .msg').textContent), w.q('.turn.assistant.last .msg').textContent);
    const m = w.window.KRIS.memory.get();
    assert(!m.notes.length && !Object.keys(m.fields).length, 'something was stored');
    assert(w.window.KRIS.memory.addNote('my passport number is X1234567') === false, 'API accepted a private note');
  });

  // =========================================================================
  //  Memory commands — local, instant
  // =========================================================================
  await ta('"remember that …", "what do you remember about me?", "forget my role" are answered locally', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    const before = w.posts().length;
    await w.type('remember that I prefer MT over tonnes');
    await w.idle();
    assert(/I’ll remember: “You prefer MT over tonnes\.”/.test(w.q('.turn.assistant.last .msg').textContent), w.q('.turn.assistant.last .msg').textContent);
    assert(w.window.KRIS.memory.get().notes[0].text === 'I prefer MT over tonnes');
    await w.type("remember that I'm a technical superintendent");
    await w.idle();
    assert(w.window.KRIS.memory.get().fields.role.value === 'Technical superintendent', 'a fact inside "remember" should fill the field');
    await w.type('what do you remember about me?');
    await w.idle();
    const recall = w.q('.turn.assistant.last .msg').textContent;
    assert(/Role:\s*Technical superintendent/.test(recall) && /I prefer MT over tonnes/.test(recall), recall);
    assert(w.q('.turn.assistant.last .chips.actions .chip'), 'no "Manage memory" action');
    await w.type('forget my role');
    await w.idle();
    assert(!w.window.KRIS.memory.get().fields.role, 'role not forgotten');
    assert(/forgotten your role/.test(w.q('.turn.assistant.last .msg').textContent));
    assert(w.posts().length === before, 'a memory command reached the server');
    // the action opens the Memory section
    w.q('.turn.assistant.last .chips.actions .chip').click();
    assert(w.inst().view === 'memory', 'Manage memory did not open Memory');
  });

  await ta('"forget everything" asks first; the confirm clears; "Keep it" does nothing', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    w.window.KRIS.memory.set('role', 'Analyst');
    w.window.KRIS.memory.addNote('Covers the bulk fleet');
    await w.type('forget everything');
    await w.idle();
    assert(/clears everything I remember about you \(2 details\)/.test(w.q('.turn.assistant.last .msg').textContent));
    assert(w.window.KRIS.memory.get().notes.length === 1, 'cleared before confirming');
    const [clear, keep] = w.qa('.turn.assistant.last .chips.actions .chip');
    assert(clear.classList.contains('danger'));
    keep.click();
    assert(w.window.KRIS.memory.get().notes.length === 1 && clear.disabled, 'Keep it should keep it and lock the choice');
    await w.type('forget everything about me');
    await w.idle();
    w.qa('.turn.assistant.last .chips.actions .chip')[0].click();
    const m = w.window.KRIS.memory.get();
    assert(!m.notes.length && !Object.keys(m.fields).length, 'not cleared');
  });

  await ta('vocabulary teaching ("S.P. means shaft power") and "forget it" still go to the server', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    await w.type('remember that S.P. means shaft power');
    await w.idle();
    assert(w.posts().length === 1 && w.lastBody().text === 'remember that S.P. means shaft power', 'teaching was intercepted');
    await w.type('forget it');
    await w.idle();
    assert(w.posts().length === 2, '"forget it" is small talk, not a memory command');
  });

  // =========================================================================
  //  Controls
  // =========================================================================
  await ta('pausing memory: nothing is sent as memory, nothing is offered, recall says it is paused; turning it back on restores it', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.memory.set('role', 'Marine emissions analyst');
    w.window.KRIS.openView('memory');
    const sw = w.q('.vpane.on .switch');
    assert(sw.getAttribute('role') === 'switch' && sw.getAttribute('aria-checked') === 'true');
    sw.click();
    assert(w.window.KRIS.memory.isEnabled() === false, 'not paused');
    assert(w.q('.drawer .pill').textContent === 'Paused');
    w.window.KRIS.openView('chat');
    await w.type('what is pooling');
    await w.idle();
    assert(!w.lastBody().context.profile, 'paused memory was sent');
    await w.type('I work at GeoServe');
    await w.idle();
    assert(!w.q('.turn.assistant.last .memo'), 'offered to remember while paused');
    await w.type('what do you remember about me?');
    await w.idle();
    assert(/Memory is paused/.test(w.q('.turn.assistant.last .msg').textContent));
    w.qa('.turn.assistant.last .chips.actions .chip')[0].click();
    assert(w.window.KRIS.memory.isEnabled(), 'Turn memory on did not');
    assert(w.window.KRIS.memory.get().fields.role.value === 'Marine emissions analyst', 'pausing must not delete');
  });

  await ta('Memory section: lists what is remembered, forgets with undo, adds a note, clear-all needs a second press', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.memory.set('role', 'Analyst');
    w.window.KRIS.memory.addNote('Covers the bulk fleet');
    w.window.KRIS.openView('memory');
    const rows = () => w.qa('.vpane.on .mrow');
    assert(w.texts('.vpane.on .mrow .mv').indexOf('Analyst') >= 0 && w.texts('.vpane.on .mrow .mv').indexOf('Covers the bulk fleet') >= 0);
    const n0 = rows().length;
    w.q('.vpane.on .mrow .iconbtn.del').click();
    assert(!w.window.KRIS.memory.get().fields.role, 'not forgotten');
    const undo = w.q('.toast button');
    assert(undo && undo.textContent === 'Undo', 'no undo');
    undo.click();
    assert(w.window.KRIS.memory.get().fields.role.value === 'Analyst', 'undo did not restore');
    const add = w.q('.vpane.on .addrow input');
    add.value = 'Reports to the fleet director weekly';
    w.q('.vpane.on .addrow').dispatchEvent(new w.window.Event('submit', { cancelable: true }));
    assert(w.window.KRIS.memory.get().notes.some((n) => n.text === 'Reports to the fleet director weekly' && n.source === 'you'), 'note not added');
    const clear = [...w.qa('.vpane.on .btn.danger')].find((b) => /Clear all/.test(b.textContent));
    clear.click();
    assert(w.window.KRIS.memory.get().notes.length === 2, 'cleared on the first press');
    assert(clear.textContent === 'Confirm');
    clear.click();
    assert(!w.window.KRIS.memory.get().notes.length && !Object.keys(w.window.KRIS.memory.get().fields).length, 'not cleared');
    assert(n0 >= 2);
  });

  await ta('Memory section separates this conversation from long-term memory, and promotes on request', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    w.window.KRIS.setContext({ vesselName: 'Aurora Trader' });
    await w.type('I work at GeoServe');
    await w.idle();
    w.q('.memo .btn.ghost').click();
    w.window.KRIS.openView('memory');
    const secs = [...w.qa('.vpane.on .sec')];
    const conv = secs.find((s) => /This conversation only/.test(s.textContent));
    assert(conv && /GeoServe/.test(conv.textContent) && /Aurora Trader/.test(conv.textContent), conv && conv.textContent);
    const longTerm = secs.find((s) => /remembers/.test(s.querySelector('h4') ? s.querySelector('h4').textContent : ''));
    assert(!/GeoServe/.test(longTerm.textContent), 'conversation-only fact shown as remembered');
    conv.querySelector('.btn').click();
    assert(w.window.KRIS.memory.get().fields.company.value === 'GeoServe', 'Remember did not promote it');
  });

  await ta('Profile: edits save on change (source: you), private values are refused, time zone is validated and used', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.openView('profile');
    const role = w.q('#kris-f-role');
    role.value = 'Fleet performance manager';
    role.dispatchEvent(new w.window.Event('change'));
    const f = w.window.KRIS.memory.get().fields.role;
    assert(f.value === 'Fleet performance manager' && f.source === 'you', JSON.stringify(f));
    assert(/Fleet performance manager/.test(w.q('.pcard').textContent), 'profile card not updated');
    const loc = w.q('#kris-f-location');
    loc.value = 'call me on +91 98765 43210';
    loc.dispatchEvent(new w.window.Event('change'));
    assert(!w.window.KRIS.memory.get().fields.location && loc.getAttribute('aria-invalid') === 'true', 'private value accepted');
    const tz = w.q('#kris-f-timezone');
    tz.value = 'Mars/Olympus';
    tz.dispatchEvent(new w.window.Event('change'));
    assert(!w.window.KRIS.memory.get().fields.timezone, 'invalid zone accepted');
    tz.value = 'Asia/Kolkata';
    tz.dispatchEvent(new w.window.Event('change'));
    assert(w.window.KRIS.memory.get().fields.timezone.value === 'Asia/Kolkata');
    const seg = [...w.qa('.vpane.on .seg')][0];
    [...seg.querySelectorAll('button')].find((b) => b.textContent === 'Brief').click();
    assert(w.window.KRIS.memory.get().fields.length.value === 'brief');
    w.window.KRIS.openView('chat');
    await w.type('hello, what can you tell me about CII');
    await w.idle();
    const ctx = w.lastBody().context;
    assert(ctx.tz === 'Asia/Kolkata', 'profile time zone not used: ' + ctx.tz);
    assert(ctx.profile.style && ctx.profile.style.length === 'brief' && ctx.profile.role === 'Fleet performance manager', JSON.stringify(ctx.profile));
  });

  await ta('role-aware suggestions on the empty state (the host’s own examples are left alone)', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.memory.set('role', 'Marine emissions analyst');
    const qs = w.texts('.prompts .q');
    assert(qs.indexOf('Compliance balance this quarter') >= 0, qs.join(' | '));
    const w2 = boot({ examples: ['Only this'] });
    await wait(20);
    w2.window.KRIS.memory.set('role', 'Marine emissions analyst');
    assert(w2.texts('.prompts .q').join() === 'Only this', 'custom examples replaced');
  });

  // =========================================================================
  //  Navigation
  // =========================================================================
  await ta('drawer: menu opens it, focus is trapped, Esc closes it, then the section, then the panel', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    const menu = w.q('.tool.menu');
    menu.click();
    await wait(50);
    assert(w.q('.panel').classList.contains('drawer-open') && menu.getAttribute('aria-expanded') === 'true', 'drawer not open');
    assert(w.q('.drawer').getAttribute('aria-label') === 'K.R.1.S menu');
    assert(w.sr.activeElement === w.q('.dnew'), 'focus did not move into the drawer');
    const items = w.texts('.drawer .ditem .lbl');
    assert(items.join(',') === 'Chat,History,Profile,Memory,Appearance,Settings,About', items.join(','));
    // Shift+Tab from the first item wraps inside the drawer
    w.key(w.q('.dnew'), 'Tab', { shiftKey: true });
    assert(w.sr.activeElement === w.q('.tool.menu'), 'focus left the drawer');
    w.key(w.q('.tool.menu'), 'Escape');
    assert(!w.q('.panel').classList.contains('drawer-open'), 'Esc did not close the drawer');
    w.window.KRIS.openView('settings');
    assert(w.q('.panel').classList.contains('in-view') && w.q('.vpane.on h3').textContent === 'Settings');
    assert(w.q('.stage > .body').hasAttribute('inert'), 'chat not inert under a section');
    w.key(w.q('.vpane.on .vback'), 'Escape');
    assert(w.inst().view === 'chat' && !w.q('.stage > .body').hasAttribute('inert'), 'Esc did not go back to chat');
    w.key(w.q('textarea'), 'Escape');
    assert(!w.q('.root').classList.contains('open'), 'Esc did not close the panel');
  });

  await ta('sections build on first open; every one has a heading, a back button and focusable controls', async () => {
    const w = boot();
    await wait(20);
    assert(w.qa('.vpane').length === 0, 'sections built before they were needed');
    for (const v of ['history', 'profile', 'memory', 'appearance', 'settings', 'about']) {
      assert(w.window.KRIS.openView(v) === true, 'could not open ' + v);
      const pane = w.q('.vpane.on');
      assert(pane.querySelector('h3').id && pane.getAttribute('aria-labelledby') === pane.querySelector('h3').id, v + ' heading');
      assert(pane.querySelector('.vback').getAttribute('aria-label') === 'Back to chat');
      for (const sw of pane.querySelectorAll('.switch')) assert(sw.getAttribute('role') === 'switch' && sw.getAttribute('aria-labelledby'), v + ': unlabeled switch');
      for (const sg of pane.querySelectorAll('.seg')) assert(sg.getAttribute('role') === 'radiogroup' && sg.getAttribute('aria-label'), v + ': unlabeled radio group');
    }
    assert(w.window.KRIS.openView('nope') === false);
    assert(/Server/.test(w.q('.vpane.on').textContent) && /K\.R\.1\.S/.test(w.q('.vpane.on .about h3').textContent), 'About');
  });

  // =========================================================================
  //  History
  // =========================================================================
  await ta('history: conversations are kept, listed, searchable and reopened with their turns and context', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    w.respond(async (b) => jsonResponse({ status: 'answer', source: 'agent', text: 'Answer to ' + b.text }));
    await w.type('Explain FuelEU pooling rules');
    await w.idle();
    await w.type(ALEX);
    await w.idle();
    const firstId = w.inst().convId;
    w.q('.tool.newchat').click();
    await w.type('What is the CII rating scale');
    await w.idle();
    const list = w.window.KRIS.history.list();
    assert(list.length === 2, 'expected 2 conversations, got ' + list.length);
    assert(list[1].title === 'Explain FuelEU pooling rules', list.map((x) => x.title).join(' | '));
    w.window.KRIS.openView('history');
    assert(w.qa('.vpane.on .hrow').length === 2);
    const search = w.q('.vpane.on .search input');
    search.value = 'pooling';
    search.dispatchEvent(new w.window.Event('input'));
    assert(w.qa('.vpane.on .hrow').length === 1, 'search did not filter');
    w.q('.vpane.on .hopen').click();
    assert(w.inst().view === 'chat' && w.inst().convId === firstId, 'did not reopen');
    assert(w.qa('.turn.user').length === 2 && /Explain FuelEU pooling rules/.test(w.q('.turn.user .bubble').textContent), 'turns not restored');
    await w.type('and in more detail');
    await w.idle();
    const body = w.lastBody();
    assert(body.history.length >= 2 && body.context.userName === 'Alex', 'reopened chat lost its history or context');
  });

  await ta('history: delete with undo; deleting the open conversation starts a new one; welcome offers to continue', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    await w.type('First conversation about ETS');
    await w.idle();
    w.q('.tool.newchat').click();
    assert(/First conversation about ETS/.test(w.q('.welcome .resume').textContent), 'no "Continue" on the welcome');
    w.q('.welcome .resume').click();
    assert(w.qa('.turn.user').length === 1, 'continue did not reopen');
    w.window.KRIS.openView('history');
    w.q('.vpane.on .hrow .iconbtn.del').click();
    assert(w.window.KRIS.history.list().length === 0, 'not deleted');
    assert(w.qa('.turn').length === 0, 'the deleted conversation is still on screen');
    w.q('.toast button').click();
    assert(w.window.KRIS.history.list().length === 1, 'undo did not restore');
  });

  await ta('history off: nothing new is kept; the switch lives in Settings; "Delete all" needs confirming', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    await w.type('kept conversation');
    await w.idle();
    w.window.KRIS.openView('settings');
    const sw = [...w.qa('.vpane.on .row')].find((r) => /Keep chat history/.test(r.textContent)).querySelector('.switch');
    sw.click();
    assert(w.window.KRIS.settings.get().history === false);
    w.window.KRIS.openView('chat');
    w.q('.tool.newchat').click();
    await w.type('this one should not be kept');
    await w.idle();
    w.q('.tool.newchat').click();
    assert(w.window.KRIS.history.list().length === 1, 'kept a conversation while history was off');
    w.window.KRIS.openView('settings');
    const del = [...w.qa('.vpane.on .btn.danger')].find((b) => /Delete all/.test(b.textContent));
    del.click();
    assert(w.window.KRIS.history.list().length === 1, 'deleted on the first press');
    w.q('.vpane.on [data-fk="cf-hist-clear"]').click();
    assert(w.window.KRIS.history.list().length === 0, 'not deleted after confirming');
  });

  await ta('history respects persist:false and history:false (no History section, nothing kept)', async () => {
    for (const opt of [{ persist: false }, { history: false }]) {
      const w = boot(opt);
      await wait(20);
      w.window.KRIS.open();
      await w.type('hello there, what is ets');
      await w.idle();
      w.q('.tool.newchat').click();
      assert(!Object.keys(w.local()).some((k) => /:idx$|:c:/.test(k)), 'history written with ' + JSON.stringify(opt));
      assert(!w.texts('.drawer .ditem .lbl').includes('History'), 'History shown with ' + JSON.stringify(opt));
      assert(w.window.KRIS.openView('history') === false);
    }
  });

  // =========================================================================
  //  Appearance and settings
  // =========================================================================
  await ta('appearance: theme, text size, density, times and motion apply to the root and are remembered', async () => {
    const w = boot({ theme: 'light' });
    await wait(20);
    w.window.KRIS.openView('appearance');
    const root = w.q('.root');
    const darkCard = [...w.qa('.vpane.on .tcard')].find((c) => /Dark/.test(c.textContent));
    darkCard.click();
    assert(root.getAttribute('data-theme') === 'dark' && w.window.localStorage.getItem('kris:theme') === 'dark', 'theme card');
    assert([...w.qa('.vpane.on .tcard')].find((c) => /Dark/.test(c.textContent)).getAttribute('aria-checked') === 'true', 'card state not updated');
    const segs = [...w.qa('.vpane.on .seg')];
    [...segs[0].querySelectorAll('button')].find((b) => b.textContent === 'Large').click();
    [...segs[1].querySelectorAll('button')].find((b) => b.textContent === 'Compact').click();
    assert(root.getAttribute('data-size') === 'l' && root.getAttribute('data-density') === 'compact', 'size / density');
    const rowSwitch = (label) => [...w.qa('.vpane.on .row')].find((r) => r.querySelector('.rl') && r.querySelector('.rl').textContent === label).querySelector('.switch');
    rowSwitch('Show times').click();
    assert(root.getAttribute('data-times') === 'off');
    rowSwitch('Reduce motion').click();
    assert(root.classList.contains('calm') && w.inst()._reducedMotion, 'reduce motion');
    rowSwitch('Animate K.R.1.S').click();
    assert(root.classList.contains('still'), 'still');
    const saved = JSON.parse(w.window.localStorage.getItem('kris:settings'));
    assert(saved.textSize === 'l' && saved.density === 'compact' && saved.timestamps === false && saved.motion === 'reduce' && saved.character === false, JSON.stringify(saved));
    // a new page load keeps them
    const w2 = boot({}, { local: w.local() });
    await wait(20);
    const r2 = w2.q('.root');
    assert(r2.getAttribute('data-size') === 'l' && r2.classList.contains('calm') && r2.getAttribute('data-theme') === 'dark', 'settings not restored');
    w2.window.KRIS.settings.reset();
    assert(r2.getAttribute('data-size') === 'm' && !r2.classList.contains('calm'), 'reset');
  });

  await ta('settings: with "Send with Enter" off, Enter is a new line and Ctrl+Enter sends', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    w.window.KRIS.settings.set('sendWithEnter', false);
    await w.type('first line');
    await wait(30);
    assert(w.posts().length === 0, 'Enter sent');
    assert(/Ctrl|⌘/.test(w.q('.hint').textContent), 'hint not updated');
    await w.type('first line', { ctrlKey: true });
    await w.idle();
    assert(w.posts().length === 1, 'Ctrl+Enter did not send');
  });

  // =========================================================================
  //  Chat UX
  // =========================================================================
  await ta('edit and resend: ↑ edits the last message; sending replaces that exchange', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    w.respond(async (b) => jsonResponse({ status: 'answer', source: 'agent', text: 'Re: ' + b.text }));
    await w.type('first question');
    await w.idle();
    await w.type('second qestion');
    await w.idle();
    const ta_ = w.q('textarea');
    w.key(ta_, 'ArrowUp');
    assert(ta_.value === 'second qestion' && w.q('.composer').classList.contains('editing'), 'not in edit mode');
    assert(w.q('.turn.user.lastu').classList.contains('editing'));
    await w.type('second question');
    await w.idle();
    assert(w.texts('.turn.user .bubble').join('|') === 'first question|second question', w.texts('.turn.user .bubble').join('|'));
    assert(w.qa('.turn.assistant').length === 2 && /Re: second question/.test(w.q('.turn.assistant.last .msg').textContent));
    const sent = w.lastBody();
    assert(!sent.history.some((h) => /qestion/.test(h.text)), 'the replaced message is still in history');
    // Esc cancels an edit
    w.key(ta_, 'ArrowUp');
    w.key(ta_, 'Escape');
    assert(!w.q('.composer').classList.contains('editing') && ta_.value === '', 'Esc did not cancel the edit');
  });

  await ta('sending state and failure: the bubble says "Not delivered", and a retry clears it', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    w.respond(async () => { throw new TypeError('Failed to fetch'); });
    await w.type('fuel consumption last month');
    await w.idle();
    const u = w.q('.turn.user');
    assert(u.classList.contains('failed') && /Not delivered/.test(u.querySelector('.ustate').textContent), 'no failed state');
    assert(w.q('.notice').getAttribute('role') === 'alert', 'error not announced');
    w.respond(async () => jsonResponse({ status: 'answer', source: 'agent', text: 'Back online.' }));
    w.q('.notice .retry').click();
    await w.idle();
    assert(!w.q('.turn.user').classList.contains('failed') && w.q('.turn.user .ustate').textContent === '', 'failed state not cleared');
  });

  await ta('a slow reply shows elapsed time, then a reason', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    let release;
    w.respond(() => new Promise((r) => { release = () => r(jsonResponse({ status: 'answer', source: 'agent', text: 'done' })); }));
    await w.type('something slow');
    await wait(3300);
    assert(/\d+s/.test(w.q('.thinking .secs').textContent), 'no elapsed time: ' + w.q('.thinking .secs').textContent);
    release();
    await w.idle();
    assert(!w.q('.thinking'), 'thinking left behind');
  });

  // =========================================================================
  //  Host integration
  // =========================================================================
  await ta('user option: account details pre-fill as "From your account"; a removed one stays removed; ids keep users apart', async () => {
    const w = boot({ user: { id: 'u-1', name: 'Priya Sharma', department: 'Emission' } });
    await wait(20);
    let f = w.window.KRIS.memory.get().fields;
    assert(f.name.value === 'Priya Sharma' && f.name.source === 'app' && f.department.value === 'Emission', JSON.stringify(f));
    assert(/Priya/.test(w.q('.welcome h3').textContent), 'account name not used in the greeting');
    w.window.KRIS.memory.remove('department');
    const w2 = boot({ user: { id: 'u-1', name: 'Priya Sharma', department: 'Emission' } }, { local: w.local() });
    await wait(20);
    f = w2.window.KRIS.memory.get().fields;
    assert(!f.department && f.name.value === 'Priya Sharma', 'removed account detail came back: ' + JSON.stringify(f));
    w2.window.KRIS.memory.set('role', 'Analyst');
    const w3 = boot({ user: { id: 'u-2' } }, { local: w2.local() });
    await wait(20);
    assert(!w3.window.KRIS.memory.get().fields.role, 'another user saw this user’s memory');
    w3.window.KRIS.setUser({ id: 'u-1' });
    assert(w3.window.KRIS.memory.get().fields.role.value === 'Analyst', 'setUser did not switch to that user’s memory');
  });

  await ta('memoryStore: the host’s store is loaded and saved instead of this browser', async () => {
    const saved = [];
    const w = boot({ memoryStore: { load: async () => ({ fields: { role: { value: 'Superintendent', source: 'you', at: 1 } }, notes: [] }), save: (m) => { saved.push(m); } } });
    await wait(40);
    assert(w.window.KRIS.memory.get().fields.role.value === 'Superintendent', 'store not loaded');
    w.window.KRIS.memory.set('company', 'GeoServe');
    assert(saved.length && saved[saved.length - 1].fields.company.value === 'GeoServe', 'store not saved');
    assert(!Object.keys(w.local()).some((k) => /:mem$/.test(k)), 'also wrote to localStorage');
  });

  await ta('KRIS.forget(): memory, history and this tab’s copy are gone', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    await w.type(ALEX);
    await w.idle();
    w.q('.memo .btn.primary').click();
    w.window.KRIS.forget();
    assert(!Object.keys(w.window.KRIS.memory.get().fields).length, 'memory kept');
    assert(!w.window.KRIS.history.list().length, 'history kept');
    assert(w.qa('.turn').length === 0, 'conversation still on screen');
    assert(!Object.keys(w.local()).some((k) => /^kris:v2:.*:(mem|idx)$/.test(k) && w.local()[k] !== 'null'), JSON.stringify(Object.keys(w.local())));
    assert(!/Alex/.test(w.q('.welcome h3').textContent));
  });

  await ta('memory:false — no Profile or Memory, no profile sent, no memory commands', async () => {
    const w = boot({ memory: false });
    await wait(20);
    w.window.KRIS.open();
    assert(!w.texts('.drawer .ditem .lbl').includes('Memory') && !w.q('.duser'), 'memory UI shown');
    assert(w.window.KRIS.openView('memory') === false);
    await w.type('remember that I prefer MT');
    await w.idle();
    assert(w.posts().length === 1, 'memory command intercepted with memory:false');
    await w.type(ALEX);
    await w.idle();
    assert(!w.q('.memo'), 'offered to remember with memory:false');
  });

  await ta('server actions are limited to opening sections; a local destructive action restored after navigation is disabled', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    w.respond(async () => jsonResponse({ status: 'answer', source: 'agent', text: 'See your memory.', actions: [{ label: 'Open memory', run: 'view:memory' }, { label: 'Wipe', run: 'memory:clear' }, { label: 'Evil', run: 'javascript:alert(1)' }] }));
    await w.type('anything');
    await w.idle();
    const acts = w.texts('.turn.assistant.last .chips.actions .chip');
    assert(acts.join() === 'Open memory', acts.join());
    w.window.KRIS.memory.addNote('Keep me');
    await w.type('forget everything');
    await w.idle();
    const w2 = boot({}, { session: w.session(), local: w.local() });
    await wait(40);
    const clear = [...w2.qa('.turn.assistant.last .chips.actions .chip')].find((c) => /Clear all/.test(c.textContent));
    assert(clear && clear.disabled, 'a restored "Clear all memory" is still live');
  });

  await ta('a "remember this?" card survives a page navigation, still answerable', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    await w.type(ALEX);
    await w.idle();
    const w2 = boot({}, { session: w.session(), local: w.local() });
    await wait(40);
    const yes = w2.q('.turn.assistant .memo .btn.primary');
    assert(yes, 'card lost on navigation');
    yes.click();
    assert(w2.window.KRIS.memory.get().fields.role.value === 'Marine emissions analyst');
    assert(w2.q('.memo.done'), 'saved state not shown');
  });

  await ta('events: KRIS.on("memory") and ("view") fire; listeners added before init are kept', async () => {
    const dom = new JSDOM(HOST, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://host.test/app' });
    dom.window.fetch = async () => jsonResponse({ status: 'ok' });
    dom.window.eval(SRC);
    const seen = [];
    dom.window.KRIS.on('memory', (m) => seen.push('memory:' + (m.fields.role ? m.fields.role.value : '')));
    dom.window.KRIS.init({ endpoint: 'https://kris.test/api/kris', nudge: false, onMemoryChange: () => seen.push('hook') });
    dom.window.KRIS.on('view', (v) => seen.push('view:' + v));
    dom.window.KRIS.memory.set('role', 'Analyst');
    dom.window.KRIS.openView('about');
    assert(seen.indexOf('memory:Analyst') >= 0 && seen.indexOf('hook') >= 0 && seen.indexOf('view:about') >= 0, seen.join(','));
  });

  await ta('XSS: remembered values and history titles are text, never markup', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.memory.set('role', '<img src=x onerror="window.__pwned=1">');
    w.window.KRIS.memory.addNote('<script>window.__pwned=2</script>');
    w.window.KRIS.open();
    await w.type('<b>bold</b> <img src=y onerror="window.__pwned=3">');
    await w.idle();
    await w.type('what do you remember about me?');
    await w.idle();
    for (const v of ['memory', 'profile', 'history']) { w.window.KRIS.openView(v); }
    w.q('.tool.menu').click();
    assert(!w.sr.querySelector('.vpane img, .vpane script, .drawer img, .turn img, .turn script'), 'markup parsed');
    assert(!w.window.__pwned, 'script ran');
  });

  // =========================================================================
  //  Regressions from review
  // =========================================================================
  await ta('detection: single-word roles, appositives and "my job is <title>" are found; feelings, beliefs and duties are not', async () => {
    const w = boot();
    await wait(20);
    const d = (t) => JSON.stringify(w.window.KRIS._detectFacts(t));
    assert(/"role","value":"Engineer"/.test(d("I'm an engineer")), d("I'm an engineer"));
    assert(/Chief engineer/.test(d("I'm Alex, the chief engineer")));
    assert(/"company","value":"Maersk"/.test(d('I work as an analyst at Maersk in Rotterdam')));
    assert(/Fleet superintendent/.test(d('my job is fleet superintendent')));
    for (const t of ["I'm frustrated", "I'm Muslim", "I'm sitting in a meeting right now", 'my job is to check the reports', 'My team is great',
      'My company is doing well', "I'm in charge of the chartering team", 'I work at the Rotterdam office', 'I live in fear of audits', 'I care about you',
      "I'm interested in knowing why the CII dropped", "I'm working on the report", "I have diabetes and I'm Alex", 'I vote Labour']) {
      assert(d(t) === '[]', t + ' -> ' + d(t));
    }
    assert(/"name","value":"Alex Morgan"/.test(d('My name is Alex Morgan.')), 'trailing full stop kept');
    assert(!/Pacific Star/.test(d("I'm the fleet manager for the Pacific Star")), 'a vessel read as the company');
  });

  await ta('a reply still in flight never lands in the next conversation', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    let release;
    w.respond(() => new Promise((r) => { release = () => r(jsonResponse({ status: 'answer', source: 'agent', text: 'late answer' })); }));
    await w.type('a slow question');
    await wait(30);
    w.q('.tool.newchat').click();
    release();
    await wait(60);
    assert(w.qa('.turn').length === 0, 'the late answer appeared in the new chat');
    assert(!w.inst().busy && w.inst().history.length === 0, 'state leaked into the new chat');
    w.respond(async (b) => jsonResponse({ status: 'answer', source: 'agent', text: 'h=' + b.history.length }));
    await w.type('fresh question');
    await w.idle();
    assert(w.lastBody().history.length === 0, 'the abandoned question was sent as history');
  });

  await ta('"forget my company name" keeps the name; "Forget that, show me …" goes to the server', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    w.window.KRIS.memory.set('name', 'Alex');
    w.window.KRIS.memory.set('company', 'GeoServe');
    await w.type('forget my company name');
    await w.idle();
    const f = w.window.KRIS.memory.get().fields;
    assert(f.name && !f.company, JSON.stringify(f));
    await w.type("Forget that, show me my fleet's fuel consumption last month");
    await w.idle();
    assert(w.posts().length === 1, 'a new request was swallowed as a memory command');
  });

  await ta('Undo on the card puts back the value it replaced; a card answered while paused saves nothing', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    w.window.KRIS.memory.set('role', 'Marine emissions analyst');
    await w.type('I work as a technical superintendent');
    await w.idle();
    w.q('.memo .btn.primary').click();
    assert(w.window.KRIS.memory.get().fields.role.value === 'Technical superintendent');
    [...w.qa('.memo.done .linkbtn')].find((b) => b.textContent === 'Undo').click();
    assert(w.window.KRIS.memory.get().fields.role.value === 'Marine emissions analyst', 'undo deleted the earlier value');
    await w.type('I work at GeoServe');
    await w.idle();
    w.window.KRIS.memory.enable(false);
    w.q('.turn.assistant.last .memo .btn.primary').click();
    assert(!w.window.KRIS.memory.get().fields.company, 'saved while memory was paused');
  });

  await ta('opening an old conversation does not make it new; an API delete of the open one sticks', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.open();
    await w.type('An older conversation about CII');
    await w.idle();
    const id = w.inst().convId;
    w.q('.tool.newchat').click();
    // age it by 20 days
    const k = Object.keys(w.local()).find((x) => /:idx$/.test(x));
    const idx = JSON.parse(w.window.localStorage.getItem(k));
    const old = Date.now() - 20 * 86400000;
    idx.items.forEach((it) => { it.updated = old; });
    w.window.localStorage.setItem(k, JSON.stringify(idx));
    w.window.KRIS.history.open(id);
    w.window.KRIS.close();
    const after = w.window.KRIS.history.list().find((x) => x.id === id);
    assert(after && after.updated === old, 'opening it bumped its date');
    w.window.KRIS.history.remove(id);
    w.window.KRIS.open();
    w.window.KRIS.close();
    assert(!w.window.KRIS.history.list().some((x) => x.id === id), 'the deleted conversation came back');
  });

  await ta('resetting settings restores the host’s follow-up default', async () => {
    const w = boot();
    await wait(20);
    w.window.KRIS.settings.set('followups', false);
    w.window.KRIS.settings.reset();
    assert(w.window.KRIS.settings.get().followups === true && w.inst().opts.followups === true);
  });

  console.log(`\nWidget memory: ${pass} passed, ${fails.length} failed`);
  fails.forEach((f) => console.log('  FAIL ' + f));
  process.exit(fails.length ? 1 : 0);
})();
