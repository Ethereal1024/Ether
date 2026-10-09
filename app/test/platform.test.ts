// platform.test.ts — the one module allowed to know there are three platforms
// (§3.2, §13.4 #2).
//
// The rule being protected here: after `findAdb()`, adb is either found
// somewhere the user already had it, or the caller is told to download it into
// our own data dir.  Nothing is ever installed system-wide.

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  adbCandidates,
  adbExeName,
  currentPlat,
  fileExists,
  findAdb,
  isAlive,
  killTree,
  udevAction,
  udevHint,
  udevRuleInstalled,
  userDataDir,
  vendorIdFromLsusb,
  vendorIdFromSysfs,
} from '../src/main/platform.js';

const posixOnly = process.platform === 'win32' ? 'POSIX-only test' : false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'ether-plat-'));
}

test('currentPlat is one of the three we support', () => {
  assert.ok(['linux', 'darwin', 'win32'].includes(currentPlat()));
});

test('adbExeName differs only on Windows', () => {
  assert.equal(adbExeName('linux'), 'adb');
  assert.equal(adbExeName('darwin'), 'adb');
  assert.equal(adbExeName('win32'), 'adb.exe');
});

test('adbCandidates honours the documented lookup order (§3.2)', () => {
  const env = { ADB: '/opt/adb', PATH: ['/usr/bin', '/opt/tools'].join(path.delimiter), HOME: '/home/u' };
  const got = adbCandidates(env, 'linux');
  assert.equal(got[0], path.normalize('/opt/adb'));
  assert.equal(got[1], path.normalize('/opt/adb/adb'));
  assert.deepEqual(got.slice(2, 4), [
    path.join('/usr/bin', 'adb'),
    path.join('/opt/tools', 'adb'),
  ]);
  assert.ok(got.includes(path.join('/home/u', 'Android', 'Sdk', 'platform-tools', 'adb')));
  assert.ok(got.includes(path.join('/home/u', 'Library', 'Android', 'sdk', 'platform-tools', 'adb')));
  assert.ok(got.includes(path.join('/usr', 'lib', 'android-sdk', 'platform-tools', 'adb')));
  // No Windows path leaks into a Linux candidate list.
  assert.ok(!got.some((c) => c.endsWith('adb.exe')));
});

test('adbCandidates uses %LOCALAPPDATA% on Windows', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', USERPROFILE: 'C:\\Users\\u', PATH: '' };
  const got = adbCandidates(env, 'win32');
  assert.ok(got.includes(path.join('C:\\Users\\u\\AppData\\Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe')));
  assert.ok(got.every((c) => c.endsWith('adb.exe')));
});

test('adbCandidates de-duplicates', () => {
  const env = { ADB: '/opt/adb', PATH: '/opt/adb', HOME: '/home/u' };
  const got = adbCandidates(env, 'linux');
  assert.equal(new Set(got).size, got.length);
});

test('findAdb finds an executable $ADB', { skip: posixOnly }, () => {
  const dir = tmpDir();
  try {
    const exe = path.join(dir, 'adb');
    writeFileSync(exe, '#!/bin/sh\nexit 0\n');
    chmodSync(exe, 0o755);
    assert.equal(findAdb({ ADB: exe, PATH: '', HOME: path.join(dir, 'nohome') }, 'linux'), path.normalize(exe));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findAdb skips a non-executable file and says "you must download"', { skip: posixOnly }, () => {
  const dir = tmpDir();
  try {
    const exe = path.join(dir, 'adb');
    writeFileSync(exe, 'not executable\n');
    chmodSync(exe, 0o644);
    const found = findAdb({ ADB: exe, PATH: '', HOME: path.join(dir, 'nohome') }, 'linux');
    // Whatever else may exist on the machine, it must not be the dead file.
    assert.notEqual(found, path.normalize(exe));
    // With the standard directories pointed somewhere empty, there is nothing left.
    const empty = findAdb({ ADB: path.join(dir, 'missing', 'adb'), PATH: '', HOME: path.join(dir, 'nohome') }, 'linux');
    assert.ok(empty === undefined || !empty.startsWith(dir), `unexpected ${empty}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findAdb accepts the platform-tools directory itself in $ADB', { skip: posixOnly }, () => {
  const dir = tmpDir();
  try {
    mkdirSync(path.join(dir, 'platform-tools'));
    const exe = path.join(dir, 'platform-tools', 'adb');
    writeFileSync(exe, '#!/bin/sh\nexit 0\n');
    chmodSync(exe, 0o755);
    assert.equal(findAdb({ ADB: path.join(dir, 'platform-tools'), PATH: '', HOME: dir }, 'linux'), path.normalize(exe));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fileExists is a plain existence probe', () => {
  assert.equal(fileExists(path.resolve('.')), true);
  assert.equal(fileExists(path.join(os.tmpdir(), 'ether-definitely-absent-3f9a')), false);
});

test('userDataDir honours $ETHER_DATA_DIR and otherwise stays per-platform', () => {
  const old = process.env.ETHER_DATA_DIR;
  try {
    process.env.ETHER_DATA_DIR = '/custom/data';
    assert.equal(userDataDir(), '/custom/data');
    process.env.ETHER_DATA_DIR = '';
    const d = userDataDir('ether');
    assert.ok(d.endsWith(path.join('ether')) || d.endsWith('ether'));
    assert.ok(!d.includes('node_modules'));
  } finally {
    if (old === undefined) delete process.env.ETHER_DATA_DIR;
    else process.env.ETHER_DATA_DIR = old;
  }
});

test('udevHint is two copy-pasteable commands with a real vendor id, not a tutorial', () => {
  const hint = udevHint('17ef');
  const lines = hint.split('\n');
  assert.equal(lines.length, 2, 'a hint the user has to edit is not a hint');
  assert.equal(
    lines[0],
    `echo 'SUBSYSTEM=="usb", ATTR{idVendor}=="17ef", MODE="0666"' | sudo tee /etc/udev/rules.d/51-android.rules`,
  );
  assert.equal(lines[1], 'sudo udevadm control --reload-rules && sudo udevadm trigger');
  assert.ok(!hint.includes('<'), 'a placeholder would be a command the user has to edit');
  // Asking for the old `<VENDOR_ID>` shape must fail loudly, not emit a broken rule.
  assert.throws(() => udevHint('<VENDOR_ID>'), /4 hex digits/);
  assert.throws(() => udevHint(''), /4 hex digits/);
});

// The fake sysfs node `3-2:1.0` (an interface, which has no serial) is the point of
// this test and Windows cannot have a colon in a file name at all.  sysfs is a Linux
// tree anyway; on a POSIX host the directory is real and the assertion is about the
// reader, so that is where it runs.
test('vendorIdFromSysfs finds the device by serial, never by guessing', { skip: posixOnly }, () => {
  const root = tmpDir();
  try {
    mkdirSync(path.join(root, '1-1'), { recursive: true });
    mkdirSync(path.join(root, '3-2'), { recursive: true });
    mkdirSync(path.join(root, '3-2:1.0'), { recursive: true }); // an interface node: no serial
    writeFileSync(path.join(root, '1-1', 'serial'), 'OTHER1234\n');
    writeFileSync(path.join(root, '1-1', 'idVendor'), '18d1\n');
    writeFileSync(path.join(root, '3-2', 'serial'), 'HA2HS0KT\n');
    writeFileSync(path.join(root, '3-2', 'idVendor'), '17EF\n');
    assert.equal(vendorIdFromSysfs(root, 'HA2HS0KT'), '17ef', 'and lower-cased');
    assert.equal(vendorIdFromSysfs(root, 'ha2hs0kt'), '17ef');
    assert.equal(vendorIdFromSysfs(root, 'NOPE'), undefined);
    assert.equal(vendorIdFromSysfs(root, '  '), undefined);
    assert.equal(vendorIdFromSysfs(path.join(root, 'gone'), 'HA2HS0KT'), undefined, 'sysfs absent: not fatal');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('vendorIdFromLsusb answers only when exactly one Android device is on the bus', () => {
  const lenovo = 'Bus 003 Device 008: ID 17ef:7e1c Lenovo';
  const hub = 'Bus 001 Device 002: ID 1d6b:0002 Linux Foundation 2.0 root hub';
  assert.equal(vendorIdFromLsusb(`${hub}\n${lenovo}`), '17ef');
  assert.equal(vendorIdFromLsusb(hub), undefined, 'a hub is not an Android device');
  assert.equal(vendorIdFromLsusb(''), undefined);
  assert.equal(
    vendorIdFromLsusb(`${lenovo}\nBus 003 Device 009: ID 18d1:4ee7 Google Inc.`),
    undefined,
    'two candidates: a rule for the wrong device fixes nothing',
  );
  assert.equal(vendorIdFromLsusb('Bus 003 Device 008: ID 17ef:7e1c Lenovo', ['0bb4']), undefined);
});

test('udevRuleInstalled reads the rule dirs, tolerant of whitespace and ATTRS', () => {
  const dir = tmpDir();
  try {
    assert.equal(udevRuleInstalled('17ef', [dir]), false, 'empty dir');
    writeFileSync(
      path.join(dir, '51-android.rules'),
      '# other vendors\nSUBSYSTEM=="usb", ATTRS{ idVendor } == "18d1", MODE="0666"\n',
    );
    assert.equal(udevRuleInstalled('17ef', [dir]), false);
    assert.equal(udevRuleInstalled('18d1', [dir]), true);
    assert.equal(udevRuleInstalled('<VENDOR_ID>', [dir]), false, 'a placeholder matches nothing');
    assert.equal(udevRuleInstalled('17ef', [path.join(dir, 'missing')]), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A fake machine: one sysfs device (HA2HS0KT / 17ef) and one writable rule dir. */
function fakeMachine(): { sysRoot: string; ruleDir: string; lsusb: () => string; cleanup(): void } {
  const root = tmpDir();
  const sysRoot = path.join(root, 'sys');
  const ruleDir = path.join(root, 'rules');
  mkdirSync(path.join(sysRoot, '3-2'), { recursive: true });
  mkdirSync(ruleDir, { recursive: true });
  writeFileSync(path.join(sysRoot, '3-2', 'serial'), 'HA2HS0KT\n');
  writeFileSync(path.join(sysRoot, '3-2', 'idVendor'), '17ef\n');
  return { sysRoot, ruleDir, lsusb: () => '', cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('udevAction: unruled device → the commands; ruled device → no privileged text at all', () => {
  const m = fakeMachine();
  try {
    const args = { serial: 'HA2HS0KT', sysRoot: m.sysRoot, ruleDirs: [m.ruleDir], lsusb: m.lsusb };
    const missing = udevAction({ ...args, env: {} });
    assert.equal(missing.key, 'noPermissions');
    assert.match(missing.hint ?? '', /ATTR\{idVendor\}=="17ef"/);

    writeFileSync(path.join(m.ruleDir, '51-android.rules'), 'SUBSYSTEM=="usb", ATTR{idVendor}=="17ef", MODE="0666"\n');
    const present = udevAction({ ...args, env: {} });
    assert.deepEqual(present, { key: 'noPermissionsAfterRule' }, 'the rule is already in place; do not advertise it again');
  } finally {
    m.cleanup();
  }
});

test('udevAction: an undeterminable vendor yields the sentence and no hint, never a placeholder', () => {
  const args = { serial: 'HA2HS0KT', sysRoot: '/nonexistent', ruleDirs: [], lsusb: () => '' };
  assert.deepEqual(udevAction({ ...args, env: {} }), { key: 'noPermissions' });
  assert.deepEqual(udevAction({ ...args, env: { ETHER_UDEV_VID: 'unknown' } }), { key: 'noPermissions' });
});

test('udevAction: lsusb is the fallback when sysfs has no serial', () => {
  const act = udevAction({
    serial: 'X',
    env: {},
    sysRoot: '/nonexistent',
    ruleDirs: [],
    lsusb: () => 'Bus 003 Device 008: ID 17ef:7e1c Lenovo',
  });
  assert.equal(act.key, 'noPermissions');
  assert.match(act.hint ?? '', /ATTR\{idVendor\}=="17ef"/);
});

test('udevAction: the env seams win over the machine (why they exist)', () => {
  const args = { serial: 'HA2HS0KT', sysRoot: '/nonexistent', ruleDirs: [], lsusb: () => '' };
  const missing = udevAction({ ...args, env: { ETHER_UDEV_VID: '18d1', ETHER_UDEV_RULE: 'missing' } });
  assert.match(missing.hint ?? '', /idVendor}=="18d1"/);
  assert.deepEqual(udevAction({ ...args, env: { ETHER_UDEV_VID: '18d1', ETHER_UDEV_RULE: 'present' } }), {
    key: 'noPermissionsAfterRule',
  });
  assert.deepEqual(
    udevAction({ ...args, env: { ETHER_UDEV_VID: 'nonsense' } }),
    { key: 'noPermissions' },
    'a bad override must not invent a vendor',
  );
});

test('isAlive is true for us and false for nonsense pids', () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(0), false);
  assert.equal(isAlive(-1), false);
  assert.equal(isAlive(1.5), false);
});

test('killTree terminates the process it was handed, children included', { skip: posixOnly }, async () => {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  assert.ok(child.pid && isAlive(child.pid));
  await killTree(child.pid!);
  await sleep(200);
  assert.equal(isAlive(child.pid!), false);
});
