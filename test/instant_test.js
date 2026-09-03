'use strict';
/**
 * Instant-answer layer: dates, times, arithmetic. No database, no model.
 *   node test/instant_test.js
 */
const assert = require('assert');
const { answerInstant, tryArithmetic, evaluate, validTz } = require('../src/instant_src');
let passed = 0; const fails = [];
const t = (n, f) => { try { f(); passed++; } catch (e) { fails.push(n + ': ' + e.message); } };

// 3 Sep 2026 18:45 UTC. Kolkata (+5:30) is already Friday 4 Sep 00:15; New York (-4) is Thursday 14:45.
const NOW = new Date('2026-09-03T18:45:00Z');
const ask = (q, tz) => answerInstant(q, { now: NOW, tz });

t('date: answered in the user\'s time zone, not the server\'s', () => {
  assert.strictEqual(ask('what is todays date ?', 'Asia/Kolkata').text, 'Today is Friday, 4 September 2026.');
  assert.strictEqual(ask('what day is it today', 'America/New_York').text, 'Today is Thursday, 3 September 2026.');
});
t('date: without a time zone, answers in UTC and says so', () => {
  const r = ask('what is the date');
  assert.ok(/Thursday, 3 September 2026/.test(r.text));
  assert.ok(/UTC/.test(r.text));
});
t('time: correct across zones', () => {
  assert.strictEqual(ask('what time is it', 'Asia/Kolkata').text, "It's 00:15 (Asia/Kolkata).");
  assert.strictEqual(ask('what time is it', 'America/New_York').text, "It's 14:45 (America/New York).");
});
t('time zone: an invalid zone falls back to UTC rather than throwing', () => {
  assert.strictEqual(validTz('Mars/Olympus'), null);
  assert.ok(/UTC/.test(ask('what time is it', 'Mars/Olympus').text));
});
t('year / month / weekday', () => {
  assert.strictEqual(ask('what year is it', 'Asia/Kolkata').text, "It's 2026.");
  assert.strictEqual(ask('what month is it', 'Asia/Kolkata').text, "It's September 2026.");
  assert.ok(/Friday, a weekday/.test(ask('is it the weekend?', 'Asia/Kolkata').text));
  assert.ok(/Thursday/.test(ask('what day of the week is it', 'America/New_York').text));
});
t('days until: counts whole days in the user\'s zone and looks forward for bare dates', () => {
  assert.strictEqual(ask('how many days until 31 december', 'Asia/Kolkata').text, '118 days until 31 December 2026.');
  assert.strictEqual(ask('how many days until 1 january', 'Asia/Kolkata').text, '119 days until 1 January 2027.');
  assert.strictEqual(ask('how many days until 31 december', 'America/New_York').text, '119 days until 31 December 2026.');
});
t('from now: date arithmetic', () => {
  assert.strictEqual(ask('what date is 30 days from now', 'Asia/Kolkata').text, '30 days from today is Sunday, 4 October 2026.');
  assert.ok(/18 September 2026/.test(ask('in 2 weeks', 'Asia/Kolkata').text));
});

t('arithmetic: precedence, parentheses, powers', () => {
  assert.strictEqual(evaluate('2+3*4'), 14);
  assert.strictEqual(evaluate('(2+3)*4'), 20);
  assert.strictEqual(evaluate('2^10'), 1024);
  assert.strictEqual(evaluate('-3+5'), 2);
  assert.strictEqual(evaluate('sqrt(144)'), 12);
});
t('arithmetic: word forms and percent', () => {
  assert.ok(/= 3\.142857$/.test(tryArithmetic('what is 22/7').text));
  assert.ok(/= 3\.142857$/.test(tryArithmetic('divide 22 by 7').text));
  assert.ok(/= 3\.142857$/.test(tryArithmetic('22 divided by 7').text));
  assert.strictEqual(tryArithmetic('15% of 200').text, '15% of 200 = 30');
  assert.strictEqual(tryArithmetic('3 times 4 plus 1').text, '3 times 4 plus 1 = 13');
  assert.strictEqual(tryArithmetic('square root of 144').text, 'square root of 144 = 12');
});
t('arithmetic: division by zero is explained, not NaN', () => {
  assert.ok(/divides by zero/.test(tryArithmetic('100 / 0').text));
});
t('arithmetic: a full date is not a division, a bare d/m is', () => {
  assert.strictEqual(tryArithmetic('15/08/2026'), null);
  assert.ok(tryArithmetic('22/7'));
});
t('arithmetic: no eval — letters and functions are rejected outright', () => {
  assert.strictEqual(tryArithmetic('process.exit(1)'), null);
  assert.strictEqual(tryArithmetic('2 + alert(1)'), null);
  assert.strictEqual(tryArithmetic('require("fs")'), null);
});

t('does not steal data questions, greetings or general questions', () => {
  assert.strictEqual(ask('fuel consumption today', 'Asia/Kolkata'), null);
  assert.strictEqual(ask('shaft power on 15/08/2026', 'Asia/Kolkata'), null);
  assert.strictEqual(ask('hi', 'Asia/Kolkata'), null);
  assert.strictEqual(ask('what is the meaning of life', 'Asia/Kolkata'), null);
  assert.strictEqual(ask('how many days did we lose to off hire', 'Asia/Kolkata'), null, 'an off-hire question is data, not date arithmetic');
});

console.log(`\nInstant: ${passed} passed, ${fails.length} failed`);
fails.forEach((f) => console.log('  FAIL ' + f));
process.exit(fails.length ? 1 : 0);
