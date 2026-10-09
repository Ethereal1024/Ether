// traymenu.test.ts — what the icon says, and what its menu offers.
//
// The tray is the window's second door: it is how "closing the window does not drop the
// link" stays true *and* reachable.  Everything about it that can be decided without
// Electron lives in traymenu.ts, so the wording and the enabled/disabled logic are
// pinned here rather than discovered by opening the menu on a real desktop.
//
// Two rules the table has to keep:
//   * the state is information, never a control — a menu opened to look at the link must
//     not be able to stop it by accident;
//   * the state word is read from the same catalogue the window's chip draws, so the
//     icon's tooltip and the card cannot describe the same tunnel differently.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { uiLabels } from '../src/main/messages.js';
import {
  actionFor,
  trayIconName,
  trayIconPath,
  trayMenu,
  trayTooltip,
  trayToggle,
  trayWord,
  type TrayLabels,
} from '../src/main/traymenu.js';

const labels = uiLabels();
const words: TrayLabels = {
  on: labels.on,
  off: labels.off,
  working: labels.working,
  needsAttention: labels.needsAttention,
  show: labels.showWindow,
  start: labels.start,
  stop: labels.stop,
  quit: labels.quit,
};

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the icon says one word per state, from the window’s own catalogue', () => {
  assert.equal(trayWord('up', words), labels.on);
  assert.equal(trayWord('degraded', words), labels.on);
  assert.equal(trayWord('error', words), labels.needsAttention);
  assert.equal(trayWord('idle', words), labels.off);
  for (const state of ['checking', 'starting']) assert.equal(trayWord(state, words), labels.working);
  // Anything the state machine grows and this table has not been told about reads as
  // off — the icon is a hint, and the window it opens is the truth.
  assert.equal(trayWord('somethingNew', words), labels.off);
  assert.equal(trayTooltip('up', words), `Ether — ${labels.on}`);
});

test('a link that can be stopped or started says which, and nothing during the work', () => {
  assert.deepEqual(trayToggle('up', words), { label: labels.stop, enabled: true });
  assert.deepEqual(trayToggle('degraded', words), { label: labels.stop, enabled: true });
  assert.deepEqual(trayToggle('idle', words), { label: labels.start, enabled: true });
  assert.deepEqual(trayToggle('error', words), { label: labels.start, enabled: true });
  // A second press while the app is starting or stopping a tunnel would be a second
  // tunnel: the item is drawn as the work, and cannot be pressed.
  for (const state of ['checking', 'starting', 'stopping']) {
    assert.deepEqual(trayToggle(state, words), { label: labels.working, enabled: false }, state);
  }
});

test('the menu is the state, the two doors, then quit — and the state is not a control', () => {
  const menu = trayMenu('up', words);
  assert.deepEqual(
    menu.map((i) => i.id),
    ['status', 'show', 'toggle', 'quit'],
  );
  const [status, show, toggle, quit] = menu;
  assert.equal(status?.enabled, false, 'the state line is information, not a button');
  assert.equal(status?.label, trayTooltip('up', words));
  assert.equal(status?.separatorAfter, undefined);
  // Show first: it is the one item a user reaches for when the window is gone, which is
  // the whole reason the icon exists.
  assert.deepEqual([show?.label, show?.enabled], [labels.showWindow, true]);
  assert.deepEqual([toggle?.label, toggle?.enabled], [labels.stop, true]);
  assert.deepEqual([quit?.label, quit?.enabled, quit?.separatorAfter], [labels.quit, true, true]);
  // Only the last one carries a rule, and the state line is always the first.
  assert.equal(menu.filter((i) => i.separatorAfter).length, 1);
  assert.equal(menu.filter((i) => i.id === 'status').length, 1);
});

test('a click is translated back into an app verb, and anything else is a no-op', () => {
  assert.equal(actionFor('show'), 'show');
  assert.equal(actionFor('toggle'), 'toggle');
  assert.equal(actionFor('quit'), 'quit');
  // `status` has no handler at all in tray.ts, and an id from a menu that was built
  // before a change must never be guessed at.
  assert.equal(actionFor('status'), undefined);
  assert.equal(actionFor('restart-adb'), undefined);
});

test('the icon file is the one Electron is handed, per platform', () => {
  assert.equal(trayIconName('darwin'), 'trayTemplate.png', 'macOS only treats a *Template name as a template');
  assert.equal(trayIconName('linux'), 'tray.png');
  assert.equal(trayIconName('win32'), 'tray.png');
  assert.equal(trayIconPath('linux', '/opt/Ether/resources'), path.join('/opt/Ether/resources', 'tray.png'));
});

test('the icons the app ships are really there, at the sizes the toolkits want', () => {
  /** Width and height out of a PNG's IHDR: no dependency, and it reads the real file. */
  const pngSize = (file: string): [number, number] => {
    const buf = readFileSync(file);
    assert.equal(buf.subarray(1, 4).toString('ascii'), 'PNG', `${file} is not a PNG`);
    return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  };
  const res = path.join(appRoot, 'resources');
  assert.deepEqual(pngSize(path.join(res, 'tray.png')), [64, 64], 'the coloured plate for Linux and Windows');
  assert.deepEqual(pngSize(path.join(res, 'trayTemplate.png')), [16, 16]);
  // macOS picks `@2x` up by name, so it has to be exactly twice the 1× image and no
  // other size, or the menu bar draws a blurry or half-size icon.
  assert.deepEqual(pngSize(path.join(res, 'trayTemplate@2x.png')), [32, 32]);
  for (const f of ['tray.png', 'trayTemplate.png', 'trayTemplate@2x.png']) {
    const buf = readFileSync(path.join(res, f));
    // A PNG that is only a header renders as nothing at all, so the pixel data has to be
    // in the file — the size check alone would pass for a blank plate.
    assert.ok(buf.includes(Buffer.from('IDAT')), `${f} has no pixel data`);
  }
});
