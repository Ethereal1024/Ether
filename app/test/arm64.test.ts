// arm64.test.ts — the arm64 deb: what can run there, and what must never be inside it.
//
// The constraint this file defends is not a preference: Google publishes Linux
// platform-tools for x86_64 only.  There is no aarch64 `adb` to bundle and none to
// download, so the arm64 package must ship *no* adb and must recommend the
// distribution's instead — and the app must refuse a copy that cannot run here rather
// than hand it to `execFile` and report ENOEXEC with no explanation.
//
// Two halves: the header/capability logic in `platform.ts` (with synthetic ELF bytes, so
// the answer does not depend on this machine's architecture), and the packaging claims
// read off disk (`electron-builder.arm64.yml`, `package.json`, `release.yml`) — because a
// promise about a package nobody builds locally is a promise that rots.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Adb, AdbError } from '../src/main/adb.js';
import {
  elfFitsHost,
  elfMachine,
  elfMachineForArch,
  findAdb,
  hostCanRunPlatformTools,
} from '../src/main/platform.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = path.resolve(appRoot, '..');
/** A file of this app, read the way a test reads a claim: whole, with CRLF normalised
 *  (these files are asserted on with `^…$` anchors, and Windows checkout ends with \r). */
const read = (rel: string): string =>
  readFileSync(path.join(appRoot, rel), 'utf8').replace(/\r\n/g, '\n');

/** A 20-byte ELF header carrying `machine`, laid out the way a linker would. */
function elfHead(machine: number, endian: 'le' | 'be' = 'le'): Buffer {
  const b = Buffer.alloc(20);
  b.set([0x7f, 0x45, 0x4c, 0x46], 0); // "\x7fELF"
  b[4] = 2; // EI_CLASS = ELFCLASS64
  b[5] = endian === 'le' ? 1 : 2; // EI_DATA
  b[6] = 1; // EI_VERSION
  if (endian === 'le') b.writeUInt16LE(machine, 18);
  else b.writeUInt16BE(machine, 18);
  return b;
}

const EM_X86_64 = 0x3e;
const EM_AARCH64 = 0xb7;

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'ether-arm64-'));
}

/** Run `fn` with `process.arch` pretending to be another machine, and put it back. */
async function asArch<T>(arch: string, fn: () => Promise<T>): Promise<T> {
  const real = process.arch;
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'arch', { value: real, configurable: true });
  }
}

// ── the header a file carries ────────────────────────────────────────────────

test('elfMachineForArch names the three machines adb is ever built for', () => {
  assert.equal(elfMachineForArch('x64'), EM_X86_64);
  assert.equal(elfMachineForArch('arm64'), EM_AARCH64);
  assert.equal(elfMachineForArch('arm'), 0x28);
  // Anything else is "no opinion", never a guess: guessing here would make the caller
  // refuse the one binary it has.
  assert.equal(elfMachineForArch('ia32'), undefined);
  assert.equal(elfMachineForArch('s390x'), undefined);
});

test('elfMachine reads e_machine in both byte orders and refuses what is not an ELF', () => {
  assert.equal(elfMachine(elfHead(EM_AARCH64)), EM_AARCH64);
  assert.equal(elfMachine(elfHead(EM_X86_64)), EM_X86_64);
  // A big-endian header on the wire is still the same number: the field is read the way
  // EI_DATA says, not the way the host happens to be laid out.
  assert.equal(elfMachine(elfHead(EM_AARCH64, 'be')), EM_AARCH64);

  assert.equal(elfMachine(Buffer.from('#!/bin/sh\nexec adb "$@"\n')), undefined, 'a wrapper script is not an ELF');
  assert.equal(elfMachine(Buffer.from('MZ\x90\x00')), undefined, 'a PE executable is not an ELF');
  assert.equal(elfMachine(Buffer.alloc(0)), undefined, 'an empty read is not an ELF');
  assert.equal(elfMachine(elfHead(EM_X86_64).subarray(0, 19)), undefined, 'e_machine needs the 20th byte');
});

// ── which machines can run the archive Google publishes ──────────────────────

test('hostCanRunPlatformTools: Linux is x86_64 only, and the other two carry their own', () => {
  assert.equal(hostCanRunPlatformTools('linux', 'x64'), true);
  assert.equal(hostCanRunPlatformTools('linux', 'arm64'), false, 'no aarch64 platform-tools exist');
  assert.equal(hostCanRunPlatformTools('linux', 'arm'), false);
  // Windows on ARM emulates x64, and Google's darwin archive is universal: on both, the
  // copy we ship is the one that runs, so neither may be refused.
  assert.equal(hostCanRunPlatformTools('win32', 'arm64'), true);
  assert.equal(hostCanRunPlatformTools('darwin', 'arm64'), true);
});

test('elfFitsHost refuses only what it can prove is foreign', () => {
  // The shipped Linux copy is x86_64; that is right on x64 and wrong on arm64.
  assert.equal(elfFitsHost(elfHead(EM_X86_64), 'linux', 'x64'), true);
  assert.equal(elfFitsHost(elfHead(EM_X86_64), 'linux', 'arm64'), false);
  assert.equal(elfFitsHost(elfHead(0x28), 'linux', 'arm64'), false, 'a 32-bit ARM adb is not an arm64 one');
  // Even a matching aarch64 header is refused: the package we ship never carries one, and
  // "it happens to fit" is not the same answer as "Google publishes it".
  assert.equal(elfFitsHost(elfHead(EM_AARCH64), 'linux', 'arm64'), false);

  // Not an ELF (a wrapper script, adb.exe) and not Linux (not this machine's question) are
  // both left alone: this function exists to catch a foreign binary, not to gate-keep.
  assert.equal(elfFitsHost(Buffer.from('#!/bin/sh\n'), 'linux', 'x64'), true);
  assert.equal(elfFitsHost(elfHead(EM_X86_64), 'darwin', 'arm64'), true);
  assert.equal(elfFitsHost(Buffer.alloc(0), 'linux', 'arm64'), false, 'nothing at all is never runnable');
});

// ── what the app does with such a copy ───────────────────────────────────────

test('findAdb skips the copy we ship when it is built for another machine', async () => {
  const dir = tmpDir();
  try {
    const bundled = path.join(dir, 'platform-tools', 'linux');
    mkdirSync(bundled, { recursive: true });
    const exe = path.join(bundled, 'adb');
    writeFileSync(exe, elfHead(EM_X86_64));
    chmodSync(exe, 0o755);
    const env = { PATH: '', HOME: path.join(dir, 'nobody') };

    assert.equal(await asArch('x64', async () => findAdb(env, 'linux', dir)), exe);
    assert.equal(
      await asArch('arm64', async () => findAdb(env, 'linux', dir)),
      undefined,
      'an x86_64 adb in our own resources is not a candidate on arm64',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a foreign bundled adb is skipped, and the missing build is named instead of downloaded', async () => {
  const dir = tmpDir();
  try {
    // A resources tree holding exactly what a package built on this x64 machine leaves
    // behind: resources/platform-tools/linux/adb, an x86_64 ELF.
    const bundled = path.join(dir, 'platform-tools', 'linux');
    mkdirSync(bundled, { recursive: true });
    const exe = path.join(bundled, 'adb');
    writeFileSync(exe, elfHead(EM_X86_64));
    chmodSync(exe, 0o755);

    const o = { plat: 'linux' as const, env: { PATH: '', HOME: path.join(dir, 'nobody') }, dataDir: path.join(dir, 'data'), log: () => {}, resourcesDir: dir };

    // On x86_64 the copy is the answer (no download, no error): the guard must not take
    // away the machine this package is built for.
    const ok = await asArch('x64', () => Adb.ensure(o));
    assert.equal(ok.exe, exe);

    // On arm64 the same file is a dead end, and the failure says why — code `arch`, which
    // `controller.ts` turns into `t('adbNeedsDistro')` rather than `adbMissing`.
    const err = await asArch('arm64', () => Adb.ensure(o).then(
      () => undefined,
      (e: unknown) => e,
    ));
    assert.ok(err instanceof AdbError, 'an unusable adb must not be reported as found');
    assert.equal(err.code, 'arch');
    assert.match(err.message, /x86_64 only/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fetchInto refuses to put x86_64 platform-tools into an arm64 package', async () => {
  const dir = tmpDir();
  try {
    // No network is reached: the refusal comes before the download, which is the point.
    const err = await asArch('arm64', () =>
      Adb.fetchInto({ plat: 'linux', dir, log: () => {} }).then(
        () => undefined,
        (e: unknown) => e,
      ),
    );
    assert.ok(err instanceof AdbError);
    assert.equal(err.code, 'arch');
    assert.equal(existsSync(path.join(dir, 'adb')), false, 'nothing was written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--fetch-adb skips the platform this machine cannot run instead of failing the build', () => {
  // `npm run dist` on an arm64 box runs exactly this command, and it must *succeed*: the
  // package it is about to build carries no adb on purpose.  The architecture is faked for
  // the child (`--import` runs before cli.mjs), because the assertion is about what the
  // packaging step does on that machine, not about this one.
  const dir = tmpDir();
  try {
    const r = spawnSync(
      process.execPath,
      [
        '--import',
        'data:text/javascript,Object.defineProperty(process,"arch",{value:"arm64",configurable:true})',
        'bin/cli.mjs',
        '--fetch-adb',
        '--plat',
        'linux',
      ],
      { cwd: appRoot, env: { ...process.env, ETHER_RESOURCES: dir }, encoding: 'utf8' },
    );
    assert.equal(r.status, 0, `--fetch-adb failed on arm64:\n${r.stderr}`);
    assert.match(r.stderr, /skipped, the package ships no adb/);
    assert.match(r.stdout, /skipped \(no platform-tools for this machine\)/);
    assert.equal(existsSync(path.join(dir, 'platform-tools')), false, 'no adb was put in resources/');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the package that is actually built ───────────────────────────────────────

test('the arm64 build is the base config plus the one difference', () => {
  const arm = read('electron-builder.arm64.yml');
  assert.match(arm, /^extends:\s*\.\/electron-builder\.yml$/m, 'the arm64 config must not fork the app definition');
  assert.match(arm, /^deb:\s*$/m);
  assert.match(arm, /^\s*-\s*adb\s*$/m, "the package has to recommend the distribution's adb");
  assert.match(arm, /^\s*-\s*libappindicator3-1\s*$/m, 'setting the list replaces fpm\u2019s default, so the tray dependency is restated');

  // `extends` merges arrays by *concatenation*, so a target list here would build the
  // parent's AppImage as well.  The target belongs on the command line.
  assert.doesNotMatch(arm, /^\s*target:\s*$/m, 'a target list in the child is added to the parent\u2019s, not instead of it');
  // Recommends, never Depends: `dpkg -i` must still work on a machine that already has an
  // SDK adb, and a dependency the app can do without is not a dependency.
  assert.doesNotMatch(arm, /^\s*depends:/m, 'a hard dependency would refuse to unpack where an SDK adb already exists');
});

test('the x86_64 package keeps its bundled adb: no global Recommends was added to the base', () => {
  const base = read('electron-builder.yml');
  assert.doesNotMatch(base, /^\s*recommends:/m, 'a distro adb in $PATH would then win over the bundled copy on amd64, and its version can conflict');
  assert.doesNotMatch(base, /arm64/, 'the base config must stay architecture-neutral');
  // The base still builds both Linux artifacts; the arm64 config is the only place that
  // narrows to one.
  assert.match(base, /^\s*-\s*AppImage\s*$/m);
  assert.match(base, /^\s*-\s*deb\s*$/m);
});

test('the arm64 script selects the deb and never fetches platform-tools', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const script = pkg.scripts['dist:linux:arm64'];
  assert.ok(script, 'npm run dist:linux:arm64 is what CI calls');
  assert.match(script, /electron-builder\b/);
  assert.match(script, /--arm64\b/);
  assert.match(script, /--linux deb\b/, 'the target is chosen here, because the child config may not list one');
  assert.match(script, /--config electron-builder\.arm64\.yml\b/);
  assert.match(script, /--publish never\b/, 'a packaging run must not try to publish');
  // The one line whose absence is the point: `--fetch-adb` would put x86_64 Linux
  // binaries into an arm64 package (and now refuses to, which would fail the build).
  assert.doesNotMatch(script, /fetch-adb/, 'the arm64 package carries no adb');
  // The other three keep the bundled copy.
  for (const name of ['dist', 'dist:linux', 'dist:mac', 'dist:win']) {
    assert.match(pkg.scripts[name]!, /fetch-adb/, `${name} ships its own adb`);
  }
});

test('release.yml builds the arm64 deb and checks what is inside it', () => {
  const yml = readFileSync(path.join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(yml, /^\s{2}linux-arm64:\s*$/m, 'the release has no arm64 Linux job');
  // It attaches to the release the linux job creates, so it must wait for it.
  const job = yml.slice(yml.indexOf('\n  linux-arm64:'));
  const head = job.slice(0, job.indexOf('\n  mac:') === -1 ? job.length : job.indexOf('\n  mac:'));
  assert.match(head, /needs:\s*linux/, 'the release already exists by the time this job attaches');
  assert.match(head, /runs-on:\s*ubuntu-latest/);
  assert.match(head, /npm run dist:linux:arm64/);
  assert.match(head, /_arm64\.deb/, 'the artifact has to be the arm64 one');

  // The three claims a deb makes as text, read without running it: the architecture, the
  // recommendation, and the absence of a file that could not execute here.
  assert.match(head, /dpkg-deb -f "\$deb" Architecture/);
  assert.match(head, /arm64/);
  assert.match(head, /Recommends/);
  assert.match(head, /platform-tools/, 'the job has to assert the package carries none');
  assert.match(head, /softprops\/action-gh-release/);

  // The listing is read once and matched with herestrings.  `dpkg-deb -c "$deb" | grep -q`
  // is the shape that fails *under `pipefail`*: grep exits on its first match, tar's stdout
  // gets EPIPE, and the pipeline reports failure after the match was already found.  That
  // is how 0.2.7's arm64 job went red with "the icon set is missing" for a package that
  // had every size — the line above it read `tar: stdout: write error`.
  assert.match(head, /listing="\$\(dpkg-deb -c "\$deb"\)"/, 'the file list is read once, not re-streamed');
  assert.doesNotMatch(head, /^\s+dpkg-deb -c "\$deb" \| grep/m, 'grep -q on a pipe fails on EPIPE under pipefail');
});

test('the file header lists every artifact the workflow produces', () => {
  const yml = readFileSync(path.join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
  const header = yml.slice(0, yml.indexOf('\non:'));
  assert.match(header, /arm64/, 'the header still lists three artifacts');
  assert.match(header, /linux-arm64|arm64 deb/i);
});
