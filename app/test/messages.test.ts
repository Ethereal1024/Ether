// messages.test.ts — the sentence catalogue is frozen at 14 keys (§3.4, §13.8).
//
// Ether is an English-language program: the catalogue is one language, held here,
// and the UI never invents prose.  Every message a user can see is one line, shaped
// as an action ("check the cable", "allow USB debugging"), never as a tutorial.
// What this file freezes is therefore not a translation pair but the *rules* those
// sentences have to keep: no guessed hardware, no peer program's name in the app's own
// voice — and no sentence that sends the user off to be the administrator themselves.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allKeys, t, uiLabels } from '../src/main/messages.js';

const CJK = /[\u3400-\u9fff]/;

test('the catalogue is exactly the 14 frozen keys', () => {
  assert.deepEqual(allKeys().sort(), [
    'abiUnsupported',
    'adbConflict',
    'adbMissing',
    'elfNoExec',
    'hintTapHost',
    'noDevice',
    'noMoonlight',
    'noPermissions',
    'noPermissionsAfterRule',
    'noSunshine',
    'offline',
    'ready',
    'udpFail',
    'unauthorized',
  ]);
  assert.equal(allKeys().length, 14);
});

test('every sentence is English: no Chinese survives in the app the user reads', () => {
  for (const k of allKeys()) {
    const s = t(k);
    assert.ok(s.length > 0, `${k} is empty`);
    assert.doesNotMatch(s, CJK, `${k} still contains Chinese`);
  }
  for (const [name, value] of Object.entries(uiLabels())) {
    assert.doesNotMatch(value, CJK, `${name} still contains Chinese`);
  }
});

test('no sentence sends the user off to be the administrator (guard in escalation.test.ts)', () => {
  // The app may ask the OS for raised rights itself; what it must never do is *make the
  // user* become root.  So the access sentence offers the in-app grant first, and keeps
  // the paste-able command only as the fallback for a desktop that cannot prompt.
  assert.match(t('noPermissions'), /grant it in the app/);
  assert.match(t('noPermissions'), /run the command yourself/);
  assert.equal(/\badmin(istrator)?\b/i.test(t('noPermissions')), false, 'the sentence is about the rule, not about rights');
  assert.equal(t('noPermissionsAfterRule').includes('sudo'), false, 'a rule already installed needs no command');
  for (const k of allKeys()) {
    // "the app itself needs no admin" is the point; "the app needs administrator
    // rights" would be the bug, so the negation is excluded explicitly rather than
    // by hoping over the wording.
    assert.doesNotMatch(t(k), /app[^.;]{0,12}(requires|needs) (?!no\b)admin/i, k);
  }
});

test('no message is a tutorial (one line, no screenshots, no menu paths)', () => {
  for (const k of allKeys()) {
    const s = t(k);
    assert.equal(s.split('\n').length, 1, `${k} wraps onto several lines`);
    // "set the ADB environment variable" is fine; walking the user through an
    // Android menu is not.  Only menu paths and screenshots are forbidden.
    assert.doesNotMatch(s, /Settings\s*→|About phone|Build number|tap .{0,10} times|screenshot/i, `${k} explains Android UI`);
  }
});

test('the three negative cases say what to do next (§3.4 rows 1-3)', () => {
  assert.match(t('noDevice'), /USB/);
  assert.match(t('unauthorized'), /Allow USB debugging/);
  assert.match(t('offline'), /unplug and replug/);
});

test('variables are substituted, not printed raw', () => {
  const s = t('abiUnsupported', { abi: 'armeabi-v7a' });
  assert.equal(s, 'Device ABI armeabi-v7a is not supported');
  assert.ok(!s.includes('{'));
  assert.ok(!t('abiUnsupported', { abi: 'x86' }).includes('{'));
});

test('an unknown key degrades to the key itself instead of throwing', () => {
  assert.equal(t('notAKnownKey' as never), 'notAKnownKey');
});

test('uiLabels has no empty field, and no field is a sentence where a word belongs', () => {
  for (const [name, value] of Object.entries(uiLabels())) {
    assert.equal(typeof value, 'string', `${name} is not a string`);
    assert.ok(value.length > 0, `${name} is empty`);
  }
  assert.equal(uiLabels().start, 'Start wired link');
  assert.equal(uiLabels().details, 'Details');
});

// ── the two copy rules of this round (§4.1): no guess, and no other program ──

/** What the thing on the end of the cable is.  A tablet is one of them; the code
 * cannot know which, so it may never say. */
const TABLET = /\btablets?\b/i;
/** A peer program: Moonlight on the device, Sunshine on this PC.  Both may be
 * named in Details → Related software, and nowhere else. */
const PEER = /moonlight|sunshine/i;

test('no sentence guesses that the device is a tablet', () => {
  for (const k of allKeys()) {
    assert.doesNotMatch(t(k), TABLET, `${k} guesses what the device is`);
  }
  for (const [name, value] of Object.entries(uiLabels())) {
    assert.doesNotMatch(value, TABLET, `${name} guesses what the device is`);
  }
  assert.equal(uiLabels().device, 'Device');
});

test('the main window never names another program (Related software is the only block that may)', () => {
  // Every sentence the app says in its own voice.
  for (const k of allKeys()) {
    assert.doesNotMatch(t(k), PEER, `${k} names a program in the app's own voice`);
  }
  // Every piece of window chrome, except the two rows of Details → Related
  // software: those are information *about* the link (which peer is there and
  // whether it is installed), not the app talking about itself.
  const allowed = new Set(['clientName', 'hostName']);
  for (const [name, value] of Object.entries(uiLabels())) {
    if (allowed.has(name)) {
      assert.match(value, PEER, `${name} no longer names the program it describes`);
    } else {
      assert.doesNotMatch(value, PEER, `${name} names a program outside Related software`);
    }
  }
});
