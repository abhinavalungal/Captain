'use strict';

/**
 * Questions about the user, and nothing else, are answered from what K.R.1.S
 * knows about them. One corpus, run through BOTH classifiers — the server's
 * (src/identity.js) and the widget's (public/kris-widget.js) — so the two can
 * never drift apart. Add a phrasing here whenever a real one slips through.
 *
 *   node test/about_me_test.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const identity = require('../src/identity');
const router = require('../src/router');
const { matchGuide } = require('../src/guide');

let passed = 0; const fails = [];
const t = (n, f) => { try { f(); passed++; } catch (e) { fails.push(n + ': ' + e.message); } };
const ta = async (n, f) => { try { await f(); passed++; } catch (e) { fails.push(n + ': ' + e.message); } };
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

const ABOUT = {
  all: [
    'what you know about me?', 'What do you know about me?', 'Who am I?', 'who am i', 'What do you remember about me?',
    'What information do you have about me?', 'tell me about myself', 'tell me about me', 'tell me something about me',
    'what do u know abt me', 'wat u kno abt me', 'do you know me?', 'do you remember me?', 'do you know who i am',
    'what details do you have on me', 'what have you got on me', 'anything you remember of me?', 'kris, what have you learned about me',
    'Hey K.R.1.S, what do you know about me?', 'what info have you stored about me', 'what data do you have on me?',
    'show my profile', 'what is in my profile', 'who do you think i am', 'describe me', 'about me?',
    'What do you actually know about me', 'so what do you know about me now', 'what do you know of me',
  ],
  name: ['What is my name?', 'whats my name again', 'do you know my name', 'what do you call me', 'my name?', 'remember my name?', 'tell me my name', "what's my full name"],
  role: ['what is my role', 'whats my job title', 'what do i do for a living', 'do you know my job', 'what is my designation?'],
  work: ['where do i work', 'whats my comp name', 'who do i work for', 'what is my company name', 'which company am i with', 'where do I work?'],
  department: ['which team am i in', 'what is my department'],
  location: ['where am i based', 'where do i live', 'what is my city'],
  timezone: ['whats my timezone', 'which time zone am i in'],
  interests: ['what am i interested in', 'what are my interests'],
};
const NOT_ABOUT = [
  'what do you know', 'what can you do', 'tell me about FuelEU', 'what do you know about my vessel', 'what is my fuel consumption',
  "what is my team's fuel consumption", "what is my vessel's name", 'who am i talking to', 'I want you to know about me that I am a data engineer',
  'my name is Abhinav', 'remember that I work at GeoServe', 'forget my role', 'how do i reset my password', 'what do you know about meteorology',
  'can you tell me about the EU ETS', 'show me my data', 'what is my compliance balance', 'export my report', 'hi', 'thanks',
  "I'm Abhinav and I work as a data engineer at GeoServe", 'fuel consumption for Aurora Trader last month', 'what is CII',
];

// --- the widget, in jsdom -------------------------------------------------------
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'kris-widget.js'), 'utf8');
const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://host.test/' });
dom.window.eval(SRC);
const widgetTopic = dom.window.KRIS._aboutTopic;

for (const [side, fn] of [['server', identity.aboutTopic], ['widget', widgetTopic]]) {
  t(side + ': every question about the user is recognised, with the right topic', () => {
    const miss = [];
    for (const [topic, qs] of Object.entries(ABOUT)) for (const q of qs) { const got = fn(q); if (got !== topic) miss.push(q + ' -> ' + got + ' (want ' + topic + ')'); }
    assert(!miss.length, miss.join(' | '));
  });
  t(side + ': nothing else is mistaken for one', () => {
    const wrong = NOT_ABOUT.filter((q) => fn(q)).map((q) => q + ' -> ' + fn(q));
    assert(!wrong.length, wrong.join(' | '));
  });
}

t('the app guide never claims "what do you know about me" and its kind', () => {
  // (Field questions like "what is my department" may resemble a help topic;
  // the fast lane asks the identity layer first, which the test below proves.)
  const claimed = ABOUT.all.filter((q) => matchGuide(q)).map((q) => q + ' -> ' + matchGuide(q).id);
  assert(!claimed.length, claimed.join(' | '));
});

// --- end to end through the server's fast lane ----------------------------------------
const NOW = new Date('2026-09-24T10:00:00Z');
const session = { userId: 'u', orgId: 'o', vesselIds: [] };
const NO_DB = async () => { const e = new Error('no db'); e.code = 'DB_NOT_CONFIGURED'; throw e; };
const NO_MODEL = async () => { throw new Error('the model must not be called for this'); };
const ask = (text, profile) => router.route({ text, session, now: NOW, context: profile ? { profile } : {} }, NO_DB, { orgId: 'o', env: { KRIS_LLM_API_KEY: 'k' }, fetchImpl: NO_MODEL });

(async () => {
  await ta('server: "what you know about me?" with nothing known says so, asks, and waits for a name — no model', async () => {
    const out = await ask('what you know about me?');
    assert(out.source === 'identity', out.source + ': ' + out.text);
    assert(/don.t have enough information about you/.test(out.text), out.text);
    assert(out.pending && out.pending.kind === 'name', 'not waiting for the name');
  });
  await ta('server: with a profile, it lists exactly what is known and names what is not', async () => {
    const out = await ask('what do you know about me', { name: 'Abhinav Alungal', company: 'GeoServe' });
    assert(/Abhinav Alungal/.test(out.text) && /GeoServe/.test(out.text), out.text);
    assert(/don.t know your role/.test(out.text), 'unknowns not named: ' + out.text);
    assert(!/Role:/.test(out.text), 'invented a role');
  });
  await ta('server: every phrasing in the corpus is answered from the profile, never the guide or the model', async () => {
    for (const qs of Object.values(ABOUT)) for (const q of qs) {
      const out = await ask(q, { name: 'Abhinav', role: 'Data engineer', company: 'GeoServe', department: 'Emissions team', location: 'Kochi', timezone: 'Asia/Kolkata', interests: ['FuelEU'] });
      assert(out.source === 'identity', q + ' -> ' + out.source);
    }
  });

  console.log(`\nAbout me: ${passed} passed, ${fails.length} failed`);
  fails.forEach((f) => console.log('  FAIL ' + f));
  process.exit(fails.length ? 1 : 0);
})();
