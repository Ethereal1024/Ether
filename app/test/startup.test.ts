// startup.test.ts — the switches in Details → Startup, tested where they can be tested
// honestly: the settings file, the wording of the per-user entry, the one decision that
// turns "connect on launch" into a dial, and the one that keeps the link up when the
// window is closed.
//
// Everything here is Electron-free on purpose.  The half that is *not* here is the
// platform call the shell makes on macOS and Windows (`app.setLoginItemSettings` /
// `getLoginItemSettings`) and the Linux branch that picks the entry up: those need a
// running Electron, and are covered by the probes in tools/.

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_SETTINGS,
  SETTINGS_NAME,
  installStartup,
  normalizeSettings,
  quoteExecArg,
  readSettings,
  removeStartup,
  settingsPath,
  shouldAutoConnect,
  startupDir,
  startupEntry,
  startupEntryPath,
  startupInstalled,
  windowCloseAction,
  writeSettings,
  type AutoConnectStatus,
  type Settings,
} from '../src/main/startup.js';

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'ether-startup-'));
}

// ── the settings file ───────────────────────────────────────────────────────

test('settings round-trip through the data dir, and only the booleans are a yes', async () => {
  const dir = tmpDir();
  try {
    assert.equal(settingsPath(dir), path.join(dir, SETTINGS_NAME));
    assert.equal(SETTINGS_NAME, 'settings.json');

    // Nothing written yet: the default, not a crash.  Connect-on-launch is off until
    // asked for; keeping the link up when the window closes is on, because a link the
    // user started is not a window's to drop.
    assert.deepEqual(await readSettings(dir), DEFAULT_SETTINGS);
    assert.deepEqual(DEFAULT_SETTINGS, { autoConnect: false, keepRunning: true });

    await writeSettings(dir, { autoConnect: true, keepRunning: true });
    assert.deepEqual(await readSettings(dir), { autoConnect: true, keepRunning: true });
    assert.deepEqual(JSON.parse(readFileSync(settingsPath(dir), 'utf8')), { autoConnect: true, keepRunning: true });

    await writeSettings(dir, { autoConnect: false, keepRunning: false });
    assert.deepEqual(await readSettings(dir), { autoConnect: false, keepRunning: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the two settings are read one by one, so one missing key cannot drag the other with it', async () => {
  const dir = tmpDir();
  try {
    // A file that only mentions `keepRunning` must not read as "connect on launch".
    writeFileSync(settingsPath(dir), '{"keepRunning":true}');
    assert.deepEqual(await readSettings(dir), { autoConnect: false, keepRunning: true });
    writeFileSync(settingsPath(dir), '{"autoConnect":true}');
    assert.deepEqual(await readSettings(dir), { autoConnect: true, keepRunning: true }, 'keepRunning defaults on');

    // Only an explicit `false` turns keeping-the-link-up off; anything else is the
    // default, because the wrong answer here drops a link the user is using.
    writeFileSync(settingsPath(dir), '{"keepRunning":false}');
    assert.equal((await readSettings(dir)).keepRunning, false);
    for (const text of ['{"keepRunning":0}', '{"keepRunning":""}', '{"keepRunning":"no"}']) {
      writeFileSync(settingsPath(dir), text);
      assert.equal((await readSettings(dir)).keepRunning, true, text);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a hand-edited or half-written settings file falls back to the defaults, never on', async () => {
  const dir = tmpDir();
  try {
    // A truncated write is indistinguishable from "the user turned it off" — so the
    // safe reading of anything unparseable is the default.
    writeFileSync(settingsPath(dir), '{"autoConnect": tru');
    assert.deepEqual(await readSettings(dir), DEFAULT_SETTINGS);

    writeFileSync(settingsPath(dir), '');
    assert.deepEqual(await readSettings(dir), DEFAULT_SETTINGS);

    // A string is not a yes, and neither is a truthy number or a missing key.
    for (const text of ['{"autoConnect":"yes"}', '{"autoConnect":1}', '{}', '[]', 'null', '"on"']) {
      assert.deepEqual(await readSettings(dir), DEFAULT_SETTINGS, text);
    }

    assert.deepEqual(normalizeSettings({ autoConnect: true, junk: 1 }), { autoConnect: true, keepRunning: true });
    assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writing settings creates the data dir and leaves no temporary behind', async () => {
  // The file is read while the app starts and written from the window, so the writer
  // may well be the first thing to touch the data dir.
  const dir = path.join(tmpDir(), 'not', 'created', 'yet');
  try {
    await writeSettings(dir, { autoConnect: true, keepRunning: true });
    assert.deepEqual(await readSettings(dir), { autoConnect: true, keepRunning: true });
    // The temporary the writer used is renamed away, not left next to the real file.
    assert.deepEqual(readdirSync(dir), [SETTINGS_NAME]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── the per-user entry (Linux) ──────────────────────────────────────────────

test('the startup dir is the user-s own, and a test run can pin it', () => {
  const env = { ETHER_AUTOSTART_DIR: '/tmp/x/autostart', XDG_CONFIG_HOME: '/tmp/xdg', HOME: '/tmp/home' };
  assert.equal(startupDir(env), '/tmp/x/autostart', 'the override wins');
  assert.equal(startupDir({ XDG_CONFIG_HOME: '/tmp/xdg', HOME: '/tmp/home' }), path.join('/tmp/xdg', 'autostart'));
  assert.equal(startupDir({ HOME: '/tmp/home' }), path.join('/tmp/home', '.config', 'autostart'));
  // Never a system-wide directory, whatever the environment says.
  for (const value of [startupDir(env), startupDir({}), startupDir({ HOME: '/home/me' })]) {
    assert.ok(!value.startsWith('/etc/'), value);
    assert.ok(!value.startsWith('/usr/'), value);
  }
});

test('an Exec argument is quoted the way the desktop-entry spec reads it', () => {
  assert.equal(quoteExecArg('/usr/bin/ether'), '/usr/bin/ether');
  assert.equal(quoteExecArg('/home/me/App.AppImage'), '/home/me/App.AppImage');
  assert.equal(quoteExecArg('/home/me/My Apps/ether'), '"/home/me/My Apps/ether"');
  assert.equal(quoteExecArg('/home/me/$APPS/ether'), '"/home/me/\\$APPS/ether"');
  assert.equal(quoteExecArg('a"b'), '"a\\"b"');
  assert.equal(quoteExecArg('a\\b'), '"a\\\\b"');
  assert.equal(quoteExecArg('back`tick`'), '"back\\`tick\\`"');
  assert.equal(quoteExecArg(''), '""');
});

test('the entry says application, on this user-s session, with no terminal', () => {
  const entry = startupEntry({ exec: '/opt/Ether/ether', comment: 'opened by the wired link' });
  const lines = entry.split('\n');
  assert.equal(lines[0], '[Desktop Entry]');
  assert.match(entry, /^Type=Application$/m);
  assert.match(entry, /^Name=Ether$/m);
  assert.match(entry, /^Comment=opened by the wired link$/m);
  assert.match(entry, /^Exec=\/opt\/Ether\/ether$/m);
  assert.match(entry, /^Terminal=false$/m, 'a login that opens a terminal window looks like a bug');
  assert.match(entry, /^X-GNOME-Autostart-enabled=true$/m);
  assert.ok(entry.endsWith('\n'), 'a file with no final newline is a file some desktops skip');

  // In development the program is Electron and the app path is an argument.
  const dev = startupEntry({ exec: '/opt/Electron/electron', args: ['/home/me/My App'], comment: 'c' });
  assert.match(dev, /^Exec=\/opt\/Electron\/electron "\/home\/me\/My App"$/m);
});

test('install, read back, and remove the entry idempotently', async () => {
  const dir = tmpDir();
  try {
    assert.equal(startupInstalled(dir), false, 'nothing installed yet');
    assert.equal(startupEntryPath(dir), path.join(dir, 'ether.desktop'));

    await installStartup(dir, startupEntry({ exec: '/opt/Ether/ether', comment: 'c' }));
    assert.equal(startupInstalled(dir), true);

    // Turning the switch off twice is not an error.
    await removeStartup(dir);
    await removeStartup(dir);
    assert.equal(startupInstalled(dir), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a disabled entry reads as off, because a desktop disables rather than deletes', async () => {
  // GNOME-s own startup panel flips a key in the file; a switch that only asked "does
  // the file exist" would claim the app opens at login while the session ignores it.
  const dir = tmpDir();
  try {
    await installStartup(dir, '[Desktop Entry]\nType=Application\nHidden=true\n');
    assert.equal(startupInstalled(dir), false);

    await installStartup(dir, '[Desktop Entry]\nX-GNOME-Autostart-enabled=false\n');
    assert.equal(startupInstalled(dir), false);

    await installStartup(dir, '[Desktop Entry]\nX-GNOME-Autostart-enabled=true\n');
    assert.equal(startupInstalled(dir), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── the decision ────────────────────────────────────────────────────────────

test('auto-connect dials once, and only into an idle link with a usable device', () => {
  const on: Settings = { autoConnect: true, keepRunning: true };
  const off: Settings = { autoConnect: false, keepRunning: true };
  const idle: AutoConnectStatus = { state: 'idle', device: { state: 'device' } };

  assert.equal(shouldAutoConnect(on, idle), true);
  // Off is off, whatever the link looks like.
  assert.equal(shouldAutoConnect(off, idle), false);

  // Something is already running (or starting): the user-s own action, or an earlier
  // auto-connect that is still working.  Either way, do not dial again.
  for (const state of ['connecting', 'connected', 'streaming', 'error', 'stopping', undefined]) {
    assert.equal(shouldAutoConnect(on, { ...idle, state }), false, String(state));
  }

  // A cable with nothing usable behind it: no device, an unauthorized one, or a
  // status without a device at all.  Starting would either fail or surprise.
  for (const state of ['unauthorized', 'offline', 'unknown', undefined]) {
    assert.equal(shouldAutoConnect(on, { state: 'idle', device: { state } }), false, String(state));
  }
  assert.equal(shouldAutoConnect(on, { state: 'idle' }), false);
  assert.equal(shouldAutoConnect(on, {}), false);
});

// ── what closing the window means ───────────────────────────────────────────

test('closing the window keeps the link up: to the tray when there is one, to the taskbar when there is not', () => {
  // The default: a link the user started survives the close button.
  assert.equal(windowCloseAction({ keepRunning: true, tray: true }), 'hide');
  assert.equal(windowCloseAction({ keepRunning: true, tray: false }), 'minimize');

  // A real quit always goes through, whatever the switch says: `before-quit` teardown
  // is what leaves the machine as it was found.
  assert.equal(windowCloseAction({ keepRunning: true, quitting: true, tray: true }), 'close');
  assert.equal(windowCloseAction({ keepRunning: false, quitting: true }), 'close');

  // The user turned the switch off, so the close button means what it says again.
  assert.equal(windowCloseAction({ keepRunning: false, tray: true }), 'close');
  assert.equal(windowCloseAction({}), 'close', 'settings not read yet is not a reason to hide a window');
});

test('a tray-less desktop minimises rather than hides, so the app is never out of reach', () => {
  // Hiding into nothing would leave a running app with no door at all: the user could
  // neither see the link they are keeping nor stop it.  Minimising keeps the link up
  // *and* keeps the window reachable, which is why it is the honest fallback.
  for (const tray of [false, undefined]) {
    const action = windowCloseAction({ keepRunning: true, tray });
    assert.equal(action, 'minimize', String(tray));
    assert.notEqual(action, 'hide');
  }
  // And the tray, when the desktop has one, is the quieter of the two.
  assert.equal(windowCloseAction({ keepRunning: true, tray: true }), 'hide');
});
