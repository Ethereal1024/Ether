// startup.test.ts — the two switches in Details → Startup, tested where they can be
// tested honestly: the settings file, the wording of the per-user entry, and the one
// decision that turns "connect on launch" into a dial (§3.1, §4.6).
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
  writeSettings,
  type AutoConnectStatus,
  type Settings,
} from '../src/main/startup.js';

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'ether-startup-'));
}

// ── the settings file ───────────────────────────────────────────────────────

test('settings round-trip through the data dir, and only the boolean is a yes', async () => {
  const dir = tmpDir();
  try {
    assert.equal(settingsPath(dir), path.join(dir, SETTINGS_NAME));
    assert.equal(SETTINGS_NAME, 'settings.json');

    // Nothing written yet: the default, not a crash.
    assert.deepEqual(await readSettings(dir), DEFAULT_SETTINGS);
    assert.deepEqual(DEFAULT_SETTINGS, { autoConnect: false });

    await writeSettings(dir, { autoConnect: true });
    assert.deepEqual(await readSettings(dir), { autoConnect: true });
    assert.deepEqual(JSON.parse(readFileSync(settingsPath(dir), 'utf8')), { autoConnect: true });

    await writeSettings(dir, { autoConnect: false });
    assert.deepEqual(await readSettings(dir), { autoConnect: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a hand-edited or half-written settings file falls back to off, never to on', async () => {
  const dir = tmpDir();
  try {
    // A truncated write is indistinguishable from "the user turned it off" — so the
    // safe reading of anything unparseable is the default.
    writeFileSync(settingsPath(dir), '{"autoConnect": tru');
    assert.deepEqual(await readSettings(dir), { autoConnect: false });

    writeFileSync(settingsPath(dir), '');
    assert.deepEqual(await readSettings(dir), { autoConnect: false });

    // A string is not a yes, and neither is a truthy number or a missing key.
    for (const text of ['{"autoConnect":"yes"}', '{"autoConnect":1}', '{}', '[]', 'null', '"on"']) {
      writeFileSync(settingsPath(dir), text);
      assert.deepEqual(await readSettings(dir), { autoConnect: false }, text);
    }

    assert.deepEqual(normalizeSettings({ autoConnect: true, junk: 1 }), { autoConnect: true });
    assert.deepEqual(normalizeSettings(undefined), { autoConnect: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writing settings creates the data dir and leaves no temporary behind', async () => {
  // The file is read while the app starts and written from the window, so the writer
  // may well be the first thing to touch the data dir.
  const dir = path.join(tmpDir(), 'not', 'created', 'yet');
  try {
    await writeSettings(dir, { autoConnect: true });
    assert.deepEqual(await readSettings(dir), { autoConnect: true });
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
  const on: Settings = { autoConnect: true };
  const off: Settings = { autoConnect: false };
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
