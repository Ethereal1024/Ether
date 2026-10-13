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
const ALPINE = 'NAME="Alpine Linux"\nID=alpine\n';
const OPEN_SUSE = 'NAME="openSUSE Tumbleweed"\nID=opensuse-tumbleweed\nID_LIKE="opensuse suse"\n';
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
  // A derivative arrives through the base it says it is built on, so every respin does
  // not need a line here.
  assert.equal(distroFamily('arch'), 'arch');
  assert.equal(distroFamily('manjaro', 'arch'), 'arch');
  assert.equal(distroFamily('endeavouros', 'arch'), 'arch');
  assert.equal(distroFamily('opensuse-tumbleweed', 'opensuse suse'), 'suse');
  assert.equal(distroFamily('sles', 'suse'), 'suse');
  assert.equal(distroFamily('geckolinux', 'opensuse-tumbleweed'), 'suse');
  // The package names below are ones this project has checked against the distro's own
  // repositories; anything else is a sentence rather than a guessed package manager
  // invocation.
  assert.equal(distroFamily('alpine'), undefined);
  assert.equal(distroFamily('void'), undefined);
  // An immutable-root openSUSE does arrive as the suse family — it says so — and its own
  // root is what refuses the install, with the receipt reporting that.  A machine this app
  // cannot drive is not the same thing as a package name it guessed.
  assert.equal(distroFamily('opensuse-microos', 'opensuse suse'), 'suse');
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

test('the fix names the one package that is missing, per family, and nothing where the name is unknown', () => {
  // The press installs the thing the reason says is missing — not a bundle that would
  // also drag a GNOME extension onto a KDE session.
  assert.deepEqual(familyFix('debian', 'appindicator-library'), { manager: 'apt-get', packages: ['libayatana-appindicator3-1'] });
  assert.deepEqual(familyFix('debian', 'sni-host'), { manager: 'apt-get', packages: ['gnome-shell-extension-appindicator'] });
  assert.deepEqual(familyFix('fedora', 'appindicator-library'), { manager: 'dnf', packages: ['libappindicator-gtk3'] });
  assert.deepEqual(familyFix('fedora', 'sni-host'), { manager: 'dnf', packages: ['gnome-shell-extension-appindicator'] });
  // Arch and openSUSE, whose names are checked against their own repositories: Arch keeps
  // both in `extra`, openSUSE ships the library and packages no extension at all.
  assert.deepEqual(familyFix('arch', 'appindicator-library'), { manager: 'pacman', packages: ['libayatana-appindicator'] });
  assert.deepEqual(familyFix('arch', 'sni-host'), { manager: 'pacman', packages: ['gnome-shell-extension-appindicator'] });
  assert.deepEqual(familyFix('suse', 'appindicator-library'), { manager: 'zypper', packages: ['libayatana-appindicator3-1'] });
  assert.equal(familyFix('suse', 'sni-host'), undefined, 'a package that does not exist is not an install');

  assert.equal(familyFix(undefined, 'appindicator-library'), undefined);
  assert.equal(fixPackages(familyFix('arch', 'appindicator-library')!), 'libayatana-appindicator');
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
    fix: { manager: 'apt-get', packages: ['gnome-shell-extension-appindicator'] },
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
  assert.deepEqual(noLib.fix?.packages, ['libayatana-appindicator3-1'], 'the library, and only the library');

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
  const unknown = traySupport(probe({ osRelease: () => ALPINE, extensions: () => 'ubuntu-dock@ubuntu.com\n' }));
  assert.equal(unknown.ok, false);
  assert.equal(unknown.fix, undefined, 'a package name we guessed is worse than a sentence');
  assert.match(unknown.detail ?? '', /extension/);
});

test('Arch and openSUSE get the press their own repositories can honour', () => {
  // Arch: both halves are in `extra`, so a GNOME session missing the extension is fixed
  // with pacman rather than a sentence.
  const arch = traySupport(probe({ osRelease: () => ARCH, extensions: () => 'ubuntu-dock@ubuntu.com\n' }));
  assert.deepEqual(arch.fix, { manager: 'pacman', packages: ['gnome-shell-extension-appindicator'] });
  const archLib = traySupport(probe({ osRelease: () => ARCH, libs: () => '/lib/x86_64-linux-gnu/libgtk-3.so.0\n' }));
  assert.deepEqual(archLib.fix, { manager: 'pacman', packages: ['libayatana-appindicator'] });

  // openSUSE: the library is packaged, the GNOME host extension is not — so the missing
  // library is an install, and the missing extension is the sentence, with no button for a
  // package that does not exist.
  const suseLib = traySupport(probe({ osRelease: () => OPEN_SUSE, libs: () => '/lib/x86_64-linux-gnu/libgtk-3.so.0\n' }));
  assert.deepEqual(suseLib.fix, { manager: 'zypper', packages: ['libayatana-appindicator3-1'] });
  const suseHost = traySupport(probe({ osRelease: () => OPEN_SUSE, extensions: () => 'ubuntu-dock@ubuntu.com\n' }));
  assert.equal(suseHost.ok, false);
  assert.match(suseHost.detail ?? '', /extension/);
  assert.equal(suseHost.fix, undefined);
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
