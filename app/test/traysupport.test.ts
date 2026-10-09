// traysupport.test.ts — "is there a tray to minimise into?", and what to install when
// there is not.
//
// The tray is how the app keeps its promise that closing the window does not drop the
// wired link, so the question "does this desktop have one" is a load-bearing one, and
// the answer has three parts: which desktop this is, whether the app-indicator client
// library Electron dlopen()s is present, and — on GNOME, which has no host of its own —
// whether the shell's own extension list has one enabled.
//
// Every answer here is evidence-based, and each piece of evidence is injected, so this
// suite never runs `ldconfig`, never asks a real GNOME session anything and never
// depends on what is installed on the machine running the tests.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  distroFamily,
  familyFix,
  fixPackages,
  osReleaseIds,
  traySupport,
  type TraySupportDeps,
} from '../src/main/traysupport.js';

const UBUNTU = 'NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\nVERSION_ID="24.04"\n';
const FEDORA = 'NAME="Fedora Linux"\nID=fedora\nVERSION_ID=40\n';
const ARCH = 'NAME="Arch Linux"\nID=arch\n';

/** A desktop that answers every question the way the caller says. */
const probe = (over: Partial<TraySupportDeps> = {}): TraySupportDeps => ({
  plat: 'linux',
  env: { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' },
  libs: () => '/lib/x86_64-linux-gnu/libayatana-appindicator3.so.1 (libc6,x86-64)\n',
  extensions: () => 'ubuntu-appindicators@ubuntu.com\n',
  osRelease: () => UBUNTU,
  ...over,
});

// ── the evidence ────────────────────────────────────────────────────────────

test('a distro says what it is built on, and a family this app has never seen gets no guess', () => {
  assert.equal(distroFamily('ubuntu', 'debian'), 'debian');
  assert.equal(distroFamily('debian'), 'debian');
  assert.equal(distroFamily('linuxmint', 'ubuntu debian'), 'debian');
  assert.equal(distroFamily('pop', 'ubuntu'), 'debian');
  assert.equal(distroFamily('fedora'), 'fedora');
  assert.equal(distroFamily('rocky', 'rhel centos fedora'), 'fedora');
  // The package names below are ones this project has seen work; anything else is a
  // sentence rather than a guessed package manager invocation.
  assert.equal(distroFamily('arch'), undefined);
  assert.equal(distroFamily('alpine'), undefined);
  assert.equal(distroFamily('', ''), undefined);
});

test('the two ids are read out of os-release, quotes and all', () => {
  assert.deepEqual(osReleaseIds(UBUNTU), { id: 'ubuntu', like: 'debian' });
  assert.deepEqual(osReleaseIds(FEDORA), { id: 'fedora', like: '' });
  assert.deepEqual(osReleaseIds('ID = "ubuntu"\nID_LIKE="debian"\n'), { id: 'ubuntu', like: 'debian' });
  assert.deepEqual(osReleaseIds(''), { id: '', like: '' });
  // A file with no ID_LIKE is not a file that says "no relatives": the key is absent.
  assert.deepEqual(osReleaseIds('# a comment\nID=arch\n'), { id: 'arch', like: '' });
});

test('the fix names the packages and the manager of the family it knows', () => {
  assert.deepEqual(familyFix('debian'), { manager: 'apt-get', packages: ['gnome-shell-extension-appindicator', 'libayatana-appindicator3-1'] });
  assert.deepEqual(familyFix('fedora'), { manager: 'dnf', packages: ['gnome-shell-extension-appindicator', 'libappindicator-gtk3'] });
  assert.equal(familyFix(undefined), undefined);
  assert.equal(fixPackages(familyFix('debian')!), 'gnome-shell-extension-appindicator libayatana-appindicator3-1');
});

// ── the question ────────────────────────────────────────────────────────────

test('on the two platforms with a built-in tray the answer needs no evidence at all', () => {
  // No ldconfig, no extension list, no os-release: Windows and macOS have an
  // notification area of their own, and asking would only be a way to be wrong.
  for (const plat of ['win32', 'darwin'] as const) {
    assert.deepEqual(traySupport({ plat, env: {} }), { ok: true });
  }
});

test('a desktop with its own host, the library present, is left alone', () => {
  for (const desktop of ['KDE', 'XFCE', 'X-Cinnamon', 'MATE', 'LXQt']) {
    const support = traySupport(probe({ env: { XDG_CURRENT_DESKTOP: desktop }, libs: () => '', extensions: () => '' }));
    assert.deepEqual(support, { ok: true }, desktop);
  }
});

test('a GNOME session with no host extension is missing, and knows what to install', () => {
  const missingHost = traySupport(probe({ extensions: () => 'ubuntu-dock@ubuntu.com\n' }));
  assert.deepEqual(missingHost, {
    ok: false,
    reason: 'sni-host',
    fix: { manager: 'apt-get', packages: ['gnome-shell-extension-appindicator', 'libayatana-appindicator3-1'] },
    detail: 'this GNOME session has no app-indicator extension enabled',
  });

  // The session is a GNOME one, so the extension *is* the question — a naming check,
  // because the upstream and Ubuntu extensions spell the word differently.
  assert.equal(traySupport(probe({ extensions: () => 'appindicatorsupport@rgcjonas.gmail.com\n' })).ok, true);
});

test('the library Electron needs is asked of the linker, and "no ldconfig" is not "missing"', () => {
  const noLib = traySupport(probe({ libs: () => '/lib/x86_64-linux-gnu/libgtk-3.so.0\n' }));
  assert.equal(noLib.ok, false);
  assert.equal(noLib.reason, 'appindicator-library');
  assert.ok(noLib.fix, 'a library install is what fixes this one');

  // A host without ldconfig cannot be asked, and an app that nags a working desktop is
  // the same defect as one that hides silently: unknown is not missing.
  assert.deepEqual(traySupport(probe({ libs: () => '' })), { ok: true });
  // A GNOME session whose extension list cannot be read is left alone for the same
  // reason: `gnome-extensions` may simply not be installed.
  assert.deepEqual(traySupport(probe({ extensions: () => '' })), { ok: true });
  // ...but the library question is asked first, because no host can use a client
  // library that is not there.
  assert.equal(traySupport(probe({ libs: () => '', extensions: () => '' })).ok, true);
});

test('a machine whose package manager we do not know is told, and is offered nothing to press', () => {
  const arch = traySupport(probe({ osRelease: () => ARCH, extensions: () => 'ubuntu-dock@ubuntu.com\n' }));
  assert.equal(arch.ok, false);
  assert.equal(arch.fix, undefined, 'a package name we guessed is worse than a sentence');
  assert.match(arch.detail ?? '', /extension/);
});

test('the environment can pin the host, so the answer is testable and never guessed', () => {
  // A real GNOME session on this host has the extension enabled, which would make an
  // assertion about "missing" pass on one machine and fail on the next.
  assert.equal(traySupport(probe({ env: { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME', ETHER_TRAY_HOST: 'missing' }, extensions: () => 'ubuntu-appindicators@ubuntu.com\n' })).ok, false);
  assert.equal(traySupport(probe({ env: { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME', ETHER_TRAY_HOST: 'present' }, extensions: () => '' })).ok, true);
  // A session with no XDG_CURRENT_DESKTOP at all is not a GNOME session, so the host is
  // not in question.
  assert.equal(traySupport(probe({ env: {} })).ok, true);
});
