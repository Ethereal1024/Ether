// cli.test.ts — the headless acceptance path (§13.8, §13.9 "M0 negative").
//
// This is the test that proves the CLI is a real front end and not a stub: it
// spawns `bin/cli.mjs` exactly as the acceptance command does, with a fake adb on
// $ADB, and checks the frozen JSON keys and the §3.4 sentences.  No tablet, no
// Sunshine, no Electron.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { t } from '../src/main/messages.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = path.join(appRoot, 'bin', 'cli.mjs');
const stub = path.join(appRoot, 'test', 'fixtures', 'fake-adb.sh');
const posixOnly = process.platform === 'win32' ? 'needs a POSIX sh stub for adb' : false;

/** The §13.8 key order. Extra keys are additive and allowed; missing ones are not. */
const FROZEN = ['state', 'device', 'adb', 'tcpMap', 'udpMap', 'stats', 'message', 'messageKey', 'hint', 'ports', 'channels', 'logs'];

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: NodeJS.ProcessEnv = {}): Run {
  const r = spawnSync(process.execPath, [cli, ...args], {
    cwd: appRoot,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'ether-cli-'));
}

function makeStubExecutable(): void {
  if (process.platform !== 'win32' && existsSync(stub)) chmodSync(stub, 0o755);
}

test('--help prints the usage and exits 0', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /node bin\/cli\.mjs --state \[--json\]/);
  assert.match(r.stdout, /--selftest/);
});

test('an unknown option is refused with the usage, exit code 2', () => {
  const r = run(['--frobnicate']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown option --frobnicate/);
  assert.match(r.stderr, /Usage:/);
});

for (const [mode, key] of [
  ['none', 'noDevice'],
  ['unauthorized', 'unauthorized'],
  ['offline', 'offline'],
] as const) {
  test(`no-usb case "${mode}" reports ${key} with the §3.4 sentence`, { skip: posixOnly }, async () => {
    makeStubExecutable();
    const dir = tmpDir();
    try {
      const r = run(['--state', '--json'], { ADB: stub, ETHER_DATA_DIR: dir, FAKE_ADB_MODE: mode });
      assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
      // stdout must be pure JSON: logs belong on stderr.
      const json = JSON.parse(r.stdout) as Record<string, unknown>;
      assert.equal(json.messageKey, key);
      assert.equal(json.message, t(key));
      // §13.9 M0 acceptance pins `state:"idle"` for a machine with no tablet attached —
      // a missing cable is not an error, while unauthorized/offline are.
      assert.equal(json.state, mode === 'none' ? 'idle' : 'error');
      // The stub was really the adb we used, so this is not the "db missing" path.
      assert.equal((json.adb as { path: string }).path, stub);
      const keys = Object.keys(json);
      assert.deepEqual(keys.filter((k) => !FROZEN.includes(k)), [], 'unexpected key in the frozen JSON');
      assert.deepEqual(keys, FROZEN.filter((k) => keys.includes(k)), 'key order drifted from §13.8');
      if (mode === 'none') {
        assert.equal(json.device, undefined);
      } else {
        assert.equal((json.device as { serial: string }).serial, 'HA2HS0KT');
        assert.equal((json.device as { state: string }).state, mode === 'offline' ? 'offline' : 'unauthorized');
      }
      assert.deepEqual(json.tcpMap, []);
      assert.deepEqual(json.udpMap, []);
      assert.equal((json.stats as { dropped: number }).dropped, 0);
      await Promise.resolve();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('a connected stub reports serial, model and the adb version', { skip: posixOnly }, async () => {
  makeStubExecutable();
  const dir = tmpDir();
  try {
    const r = run(['--state', '--json'], { ADB: stub, ETHER_DATA_DIR: dir, FAKE_ADB_MODE: 'ok' });
    const json = JSON.parse(r.stdout) as { device?: { serial: string; model?: string }; adb?: { version: string; conflict: boolean } };
    assert.equal(json.device?.serial, 'HA2HS0KT');
    assert.equal(json.device?.model, 'TB375FC');
    assert.equal(json.adb?.version, '1.0.41 (37.0.1-15733141)');
    assert.equal(json.adb?.conflict, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a mismatched adb server version yields the one actionable sentence', { skip: posixOnly }, async () => {
  makeStubExecutable();
  const dir = tmpDir();
  try {
    const r = run(['--state', '--json'], { ADB: stub, ETHER_DATA_DIR: dir, FAKE_ADB_MODE: 'conflict' });
    const json = JSON.parse(r.stdout) as { messageKey?: string; message?: string; state?: string };
    assert.equal(json.messageKey, 'adbConflict');
    assert.equal(json.message, t('adbConflict'));
    assert.equal(json.state, 'error');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a tablet the user cannot reach ships the udev commands in `hint` (§3.4 row 3)', { skip: posixOnly }, async () => {
  // "no permissions" is the one negative state whose action is two commands to
  // paste, so it is the one state that carries `hint`; the renderer draws it as a
  // copyable block and the CLI has to spell it out too.
  //
  // The two probe variables pin the machine-dependent half: this host already has
  // a 17ef rule in /etc/udev/rules.d, and the tablet is (sometimes) on the bus, so
  // without them this test would mean something different on every machine.
  makeStubExecutable();
  const dir = tmpDir();
  try {
    const env = {
      ADB: stub,
      ETHER_DATA_DIR: dir,
      FAKE_ADB_MODE: 'noperm',
      ETHER_UDEV_VID: '17ef',
      ETHER_UDEV_RULE: 'missing',
    };
    const r = run(['--state', '--json'], env);
    assert.equal(r.status, 1);
    const json = JSON.parse(r.stdout) as { messageKey?: string; state?: string; hint?: string };
    assert.equal(json.state, 'error');
    assert.equal(json.messageKey, 'noPermissions');
    assert.ok(json.hint, 'noPermissions without the commands is not actionable');
    assert.match(json.hint, /ATTR\{idVendor\}=="17ef", MODE="0666"'.* \| sudo tee .*udev\/rules\.d\/51-android\.rules/);
    assert.match(json.hint, /udevadm control --reload-rules/);
    assert.ok(!json.hint.includes('<'), 'a placeholder is a hint the user has to edit');
    // Two lines, both commands: a paragraph the user has to edit is not a hint.
    assert.equal(json.hint.split('\n').length, 2);
    assert.deepEqual(Object.keys(json), FROZEN.filter((k) => Object.keys(json).includes(k)));

    const text = run(['--state'], env);
    assert.match(text.stdout, /hint\s+:.*51-android\.rules/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a rule that is already installed is not advertised again, and shows no sudo', { skip: posixOnly }, async () => {
  // The one thing worse than "no hint" is telling a user to install something the
  // machine already has: the remaining step is a replug, not another root command.
  makeStubExecutable();
  const dir = tmpDir();
  try {
    const env = {
      ADB: stub,
      ETHER_DATA_DIR: dir,
      FAKE_ADB_MODE: 'noperm',
      ETHER_UDEV_VID: '17ef',
      ETHER_UDEV_RULE: 'present',
    };
    const r = run(['--state', '--json'], env);
    assert.equal(r.status, 1);
    const json = JSON.parse(r.stdout) as { messageKey?: string; hint?: string; message?: string };
    assert.equal(json.messageKey, 'noPermissionsAfterRule');
    assert.equal(json.hint, undefined);
    assert.equal(json.message, t('noPermissionsAfterRule'));
    assert.match(json.message ?? '', /unplug and replug/);
    const text = run(['--state'], env);
    assert.equal(/sudo/.test(text.stdout), false, 'the app must never print a privileged command it does not need');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an undeterminable vendor id yields the sentence alone — never a `<vendor id>` hole', { skip: posixOnly }, async () => {
  makeStubExecutable();
  const dir = tmpDir();
  try {
    const env = {
      ADB: stub,
      ETHER_DATA_DIR: dir,
      FAKE_ADB_MODE: 'noperm',
      ETHER_UDEV_VID: 'unknown',
      ETHER_UDEV_RULE: 'missing',
    };
    const r = run(['--state', '--json'], env);
    assert.equal(r.status, 1);
    const json = JSON.parse(r.stdout) as { messageKey?: string; hint?: string };
    assert.equal(json.messageKey, 'noPermissions');
    assert.equal(json.hint, undefined);
    assert.equal(r.stdout.includes('<'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('--state without --json prints something a human can read on stdout', { skip: posixOnly }, async () => {
  makeStubExecutable();
  const dir = tmpDir();
  try {
    const r = run(['--state'], { ADB: stub, ETHER_DATA_DIR: dir, FAKE_ADB_MODE: 'unauthorized' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /state\s+: error/);
    assert.match(r.stdout, /device\s+: HA2HS0KT/);
    // The device is whatever is on the far end of the cable, never a tablet: the
    // CLI has no way to know which of them it is looking at (§4.1).
    // The sentence itself is messages.ts's business, so it is read from there: the
    // check is that the CLI printed the catalogue entry and not a stub of its own.
    assert.equal(r.stdout.includes(`message     : ${t('unauthorized')}`), true);
    assert.doesNotMatch(r.stdout, /\btablet/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('with no adb to be found, the CLI still answers with a catalogue sentence', { skip: posixOnly }, async () => {
  // Deliberately not asserting *which* sentence: this machine may or may not have
  // a real adb elsewhere on it.  What must hold is that the app never crashes and
  // always says one of the 13 actionable things.
  const dir = tmpDir();
  try {
    const r = run(['--state', '--json'], {
      ADB: path.join(dir, 'definitely-not-here'),
      PATH: '',
      HOME: dir,
      ETHER_DATA_DIR: path.join(dir, 'data'),
      XDG_CONFIG_HOME: path.join(dir, 'cfg'),
    });
    assert.ok(r.status === 0 || r.status === 1, `unexpected exit ${r.status}: ${r.stderr}`);
    const json = JSON.parse(r.stdout) as { messageKey?: string };
    assert.ok(
      ['adbMissing', 'noDevice', 'noPermissions', 'noSunshine', 'noMoonlight', 'ready'].includes(json.messageKey ?? ''),
      `unexpected messageKey ${json.messageKey}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
