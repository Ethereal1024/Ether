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
  AutoConnectAttempt,
  DEFAULT_SETTINGS,
  SETTINGS_NAME,
  autoConnectDecision,
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ON: Settings = { autoConnect: true, keepRunning: true };
const OFF: Settings = { autoConnect: false, keepRunning: true };

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

test('the armed attempt waits through the launch order and gives up only on a link that is already there', () => {
  const idle: AutoConnectStatus = { state: 'idle', device: { state: 'device' } };

  // The one that dials.
  assert.equal(autoConnectDecision(ON, idle), 'dial');

  // Nothing found yet is not an answer.  At login the bus is often empty for a while —
  // the tablet is still booting, the cable is still in the drawer, the device has been
  // seen but not authorized.  All of those are what the switch is for, so the attempt
  // stays armed and keeps looking rather than deciding "no" once and for all.
  for (const s of [
    { state: 'checking' },
    {},
    { state: 'idle' },
    { state: 'idle', device: { state: 'unauthorized' } },
    { state: 'idle', device: { state: 'offline' } },
    // An error is the same boot order wearing a worse word (no streaming service yet, a
    // device the user has not allowed yet).  Every one of them can turn into a device.
    { state: 'error' },
    { state: 'error', device: { state: 'device' } },
  ] as AutoConnectStatus[]) {
    assert.equal(autoConnectDecision(ON, s), 'wait', JSON.stringify(s));
  }

  // A link that is running, or on its way up, *is* the answer: a second dial could not
  // be what the user meant.
  for (const state of ['starting', 'up', 'degraded']) {
    assert.equal(autoConnectDecision(ON, { ...idle, state }), 'give-up', state);
  }

  // And the switch itself overrides everything: off is off, waiting included.
  assert.equal(autoConnectDecision(OFF, { state: 'idle' }), 'give-up');
  assert.equal(autoConnectDecision(OFF, idle), 'give-up');
  assert.equal(autoConnectDecision(OFF, { state: 'up' }), 'give-up');
});

test('an armed attempt survives a launch with no device and dials the moment one appears', async () => {
  // The bug this file exists for, as one test: the app is up before the tablet, so the
  // statuses it sees are "nothing yet" — and the link still comes up on its own, with no
  // press, as soon as the bus answers.
  const log: string[] = [];
  let dials = 0;
  let refreshes = 0;
  const attempt = new AutoConnectAttempt({
    settings: () => ON,
    refresh: async () => {
      refreshes += 1;
    },
    dial: async () => {
      dials += 1;
    },
    log: (l) => log.push(l),
    intervalMs: 2,
    provisionEveryMs: 60_000, // this test is about the statuses, not the adb retry
  });

  attempt.arm();
  assert.equal(attempt.pending, true, 'the switch was on, so the attempt is armed');

  // The launch order, worst case first: the app is up, the machine has not been asked
  // anything useful yet.
  attempt.step({ state: 'checking' });
  assert.equal(attempt.pending, true, 'a `checking` push must not end the attempt');
  attempt.step({ state: 'idle' });
  assert.equal(attempt.pending, true, 'no device is not an answer');

  // Waiting means asking again: nothing else would ever wake an idle app.
  await sleep(30);
  assert.ok(refreshes > 1, `the bus must be polled while waiting, saw ${refreshes}`);
  assert.equal(dials, 0, 'nothing to dial at yet');

  // An unauthorized device is the same "not yet" — the user has not tapped Allow.
  attempt.step({ state: 'idle', device: { state: 'unauthorized' } });
  assert.equal(attempt.pending, true);

  // Now the tablet is booted and allowed.  One status is all it takes.
  attempt.step({ state: 'idle', device: { state: 'device' } });
  assert.equal(attempt.pending, false, 'dialling ends the attempt');
  assert.equal(dials, 1, 'exactly once');
  assert.deepEqual(log, ['[app] auto-connect: the device is ready, starting the wired link']);

  // And the polling really stopped: `unref`'d or not, a timer that outlived its attempt
  // would spend the rest of the session asking the bus about a link that is up.
  const settled = refreshes;
  await sleep(30);
  assert.equal(refreshes, settled, 'the poll must stop once it dialled');
  assert.equal(dials, 1, 'and it must not dial again');
});

test('a missing adb is looked for again while waiting, but not on every tick', async () => {
  // A first run at login can race the network: the download of platform-tools fails, adb
  // is never found, and the device that is connected would sit there forever.  The retry
  // has to exist — and it has to be spaced out, because each one can mean a download.
  let provisions = 0;
  let refreshes = 0;
  const attempt = new AutoConnectAttempt({
    settings: () => ON,
    refresh: async () => {
      refreshes += 1;
    },
    dial: async () => undefined,
    provision: async () => {
      provisions += 1;
    },
    log: () => undefined,
    intervalMs: 10,
    provisionEveryMs: 50,
  });

  attempt.arm();
  attempt.step({ state: 'idle' }); // no device, so the attempt waits
  await sleep(300);
  attempt.disarm();

  assert.ok(refreshes > 5, `the tick must keep asking, saw ${refreshes}`);
  assert.ok(provisions >= 1, 'a link with no adb must look for one again');
  assert.ok(provisions < refreshes, `retries are spaced out, not one per tick (${provisions} of ${refreshes})`);
});

test('a slower adb must not stack polls, and a failed one must not end the attempt', async () => {
  let refreshes = 0;
  let inFlight = 0;
  let mostAtOnce = 0;
  const attempt = new AutoConnectAttempt({
    settings: () => ON,
    refresh: async () => {
      refreshes += 1;
      inFlight += 1;
      mostAtOnce = Math.max(mostAtOnce, inFlight);
      await sleep(50); // far longer than the tick
      inFlight -= 1;
      throw new Error('adb: device not found');
    },
    dial: async () => {
      throw new Error('must not dial');
    },
    log: () => undefined,
    intervalMs: 5,
    provisionEveryMs: 60_000,
  });

  attempt.arm();
  attempt.step({ state: 'idle' });
  await sleep(160);
  attempt.disarm();

  assert.ok(refreshes >= 2, `a slow refresh must still be retried, saw ${refreshes}`);
  assert.ok(refreshes < 30, `overlapping ticks must be dropped, saw ${refreshes} in 160ms at 5ms`);
  assert.equal(mostAtOnce, 1, 'ticks never overlap');
});

test('the user taking over — the button, the switch, a quit — ends the attempt before it dials', async () => {
  // Half of the safety of this machine is in what it *stops* doing: an attempt that
  // survived the user pressing Stop would dial a link they just refused.
  let dials = 0;
  const attempt = new AutoConnectAttempt({
    settings: () => ({ autoConnect: true, keepRunning: true }),
    refresh: async () => undefined,
    dial: async () => {
      dials += 1;
    },
    log: () => undefined,
    intervalMs: 2,
    provisionEveryMs: 60_000,
  });

  attempt.arm();
  attempt.step({ state: 'idle' });
  await sleep(20);
  attempt.disarm();
  assert.equal(attempt.pending, false);

  // The cable arrives after the user gave up waiting: nothing dials.
  attempt.step({ state: 'idle', device: { state: 'device' } });
  await sleep(20);
  assert.equal(dials, 0, 'a disarmed attempt must not dial');
});

test('turning the switch off while the attempt waits disarms it on the next status', async () => {
  let settings: Settings = ON;
  let dials = 0;
  let log: string[] = [];
  const attempt = new AutoConnectAttempt({
    settings: () => settings,
    refresh: async () => undefined,
    dial: async () => {
      dials += 1;
    },
    log: (l) => log.push(l),
    intervalMs: 2,
    provisionEveryMs: 60_000,
  });

  attempt.arm();
  attempt.step({ state: 'idle' });
  assert.equal(attempt.pending, true);

  // The switch is read at every step, not remembered from arming: the user's latest word
  // wins, even mid-wait.
  settings = OFF;
  attempt.step({ state: 'idle', device: { state: 'device' } });
  assert.equal(attempt.pending, false);
  assert.deepEqual(log, [], 'no ready line for a link the user just turned off');

  await sleep(20);
  assert.equal(dials, 0);
});

test('the switch off at launch arms nothing at all', () => {
  let dials = 0;
  const attempt = new AutoConnectAttempt({
    settings: () => OFF,
    refresh: async () => undefined,
    dial: async () => {
      dials += 1;
    },
    log: () => undefined,
  });

  attempt.arm();
  assert.equal(attempt.pending, false, 'nothing was asked for, so nothing is waiting');

  attempt.step({ state: 'idle', device: { state: 'device' } });
  assert.equal(dials, 0);
});

// ── waiting for the event, instead of asking 30 times a minute ──────────────

/** The attempt with an event source it can be fired by hand, so these tests are about the
 *  wiring and not about a real socket (`devwatch.test.ts` drives the socket itself). */
function withWatch(opts: { intervalMs: number; safetyMs: number }) {
  const log: string[] = [];
  let refreshes = 0;
  let dials = 0;
  let detaches = 0;
  let fire: ((live: boolean) => void) | undefined;
  const attempt = new AutoConnectAttempt({
    settings: () => ON,
    refresh: async () => {
      refreshes += 1;
    },
    dial: async () => {
      dials += 1;
    },
    watch: (cb) => {
      fire = cb;
      return () => {
        detaches += 1;
      };
    },
    log: (l) => log.push(l),
    provisionEveryMs: 60_000,
    ...opts,
  });
  return {
    attempt,
    log,
    fire: (live: boolean) => fire?.(live),
    armed: () => fire !== undefined,
    counts: () => ({ refreshes, dials, detaches }),
  };
}

test('a live event source is what the attempt waits on: the fast tick stands down', async () => {
  // The point of the whole exercise.  While the adb server is pushing device changes there
  // is nothing left to poll *for*, so the two-second tick has to stop — and it has to come
  // back the moment the push does not.
  const t = withWatch({ intervalMs: 2, safetyMs: 60_000 });

  t.attempt.arm();
  t.attempt.step({ state: 'idle' });
  assert.equal(t.armed(), true, 'waiting must attach to the bus');
  await sleep(30);
  assert.ok(t.counts().refreshes > 1, `with no push, the tick asks: saw ${t.counts().refreshes}`);

  // The server attaches and pushes the list: from here the tick is a safety net, not a poll.
  t.fire(true);
  await sleep(20);
  const settled = t.counts().refreshes;
  await sleep(30);
  assert.equal(t.counts().refreshes, settled, 'a live stream must stop the fast tick');

  // …and a dead stream puts it back, or a tablet that arrived during the outage would wait
  // for the rare tick instead of being noticed.
  t.fire(false);
  await sleep(30);
  assert.ok(t.counts().refreshes > settled + 1, `the fast tick must come back: ${t.counts().refreshes}`);
  t.attempt.disarm();
});

test('the bus speaking is a reason to ask, and the answer is still the only reason to dial', async () => {
  // No timer can fire in this test: an hour apart.  Everything that happens, happens
  // because the adb server said something.
  const t = withWatch({ intervalMs: 3_600_000, safetyMs: 3_600_000 });

  t.attempt.arm();
  t.attempt.step({ state: 'idle', device: { state: 'unauthorized' } });
  await sleep(20);
  assert.equal(t.counts().refreshes, 0, 'nothing is asked while nothing is pushed');
  assert.equal(t.counts().dials, 0);

  // A frame that says "the list changed" — the app re-reads and finds the same refusal.
  t.fire(true);
  await sleep(10);
  assert.equal(t.counts().refreshes, 1, 'an event asks the machine once');
  assert.equal(t.counts().dials, 0, 'and an unauthorized device is still not an answer');

  // The user taps Allow: another frame, another read — and this one is usable.
  t.attempt.step({ state: 'idle', device: { state: 'device' } });
  assert.equal(t.counts().dials, 1);
  assert.equal(t.attempt.pending, false);
  assert.deepEqual(t.log, ['[app] auto-connect: the device is ready, starting the wired link']);

  // Over means detached: the socket to the adb server is not ours to keep open.
  assert.equal(t.counts().detaches, 1);
  t.fire(true);
  await sleep(10);
  assert.equal(t.counts().refreshes, 1, 'a disarmed attempt does not answer the bus any more');
});

test('a machine with no event source waits exactly as it did before there was one', async () => {
  // "No watch" and "a watch that says it is not live" are the same machine to the attempt:
  // the tick is the whole mechanism, at the speed it always had.
  const t = withWatch({ intervalMs: 2, safetyMs: 60_000 });
  t.attempt.arm();
  t.attempt.step({ state: 'idle' });
  t.fire(false); // what a watch reports when it cannot attach at all
  await sleep(30);
  assert.ok(t.counts().refreshes > 1, `the tick is the answer without a stream: ${t.counts().refreshes}`);
  t.attempt.disarm();
  assert.equal(t.counts().detaches, 1);
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
