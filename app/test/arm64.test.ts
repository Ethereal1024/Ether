// arm64.test.ts — the aarch64 adb an arm64 package carries, and the rules around it.
//
// Google publishes Linux platform-tools for x86_64 only, so arm64 used to be the one
// platform where the app needed the machine to install its own adb.  That is over: the
// arm64 package carries a distribution-built aarch64 `adb` plus the libraries the loader
// asks for (`src/main/adb-arm64.ts`), and the rules this file defends are the ones that
// make that safe:
//
//   * the payload is only trusted on a machine it can run — `findAdb` skips a copy built
//     for another architecture, and `Adb.ensure` *probes* the copy before using it, because
//     an aarch64 ELF can still need a newer glibc than the host has;
//   * when it cannot run, the failure is the one sentence that names a package
//     (`messages.adbNeedsDistro`, code `arch`) and never a privileged command;
//   * the packaging step for arm64 fetches that payload (`--fetch-adb --arch arm64`), so
//     the machine is never asked to install anything;
//   * and the pin table the payload is assembled from is verifiable: https URLs, a SHA-256
//     per package, and every library the payload claims accounted for by a pin.
//
// Two halves: the logic in `platform.ts` / `adb-arm64.ts` (with synthetic ELF bytes, so the
// answers do not depend on this machine), and the packaging claims read off disk
// (`electron-builder.arm64.yml`, `package.json`, `release.yml`) — because a promise about a
// package nobody builds locally is a promise that rots.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ADB_ARM64_GLIBC,
  ADB_ARM64_LIBS,
  ADB_ARM64_PINS,
  elfNeeded,
  hasArm64Payload,
  verifyPayload,
} from '../src/main/adb-arm64.js';
import { Adb, AdbError } from '../src/main/adb.js';
import {
  bundledAdbDir,
  bundledAdbLibDir,
  bundledPlatformToolsDir,
  elfFitsHost,
  elfMachine,
  elfMachineForArch,
  findAdb,
  googleShipsPlatformTools,
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

/** A resources tree holding one bundled payload, built for `machine`. */
function resources(dir: string, subdir: string, machine: number): string {
  const bundled = path.join(dir, 'platform-tools', subdir);
  mkdirSync(bundled, { recursive: true });
  const exe = path.join(bundled, 'adb');
  writeFileSync(exe, elfHead(machine));
  chmodSync(exe, 0o755);
  return exe;
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

// ── two different questions about a host ────────────────────────────────────

test('hostCanRunPlatformTools: Linux x64 and arm64 both ship an adb, the other two carry their own', () => {
  assert.equal(hostCanRunPlatformTools('linux', 'x64'), true);
  assert.equal(hostCanRunPlatformTools('linux', 'arm64'), true, 'the arm64 package carries an aarch64 adb');
  // 32-bit ARM has no Electron build and no archive: nothing can be shipped there.
  assert.equal(hostCanRunPlatformTools('linux', 'arm'), false);
  // Windows on ARM emulates x64, and Google's darwin archive is universal: on both, the
  // copy we ship is the one that runs, so neither may be refused.
  assert.equal(hostCanRunPlatformTools('win32', 'arm64'), true);
  assert.equal(hostCanRunPlatformTools('darwin', 'arm64'), true);
});

test('googleShipsPlatformTools: the download is still x86_64 Linux only', () => {
  // This is the question `Adb.ensure` asks before it downloads: an arm64 machine has a
  // payload, but no archive — a minute of downloading would only fail at the last step.
  assert.equal(googleShipsPlatformTools('linux', 'x64'), true);
  assert.equal(googleShipsPlatformTools('linux', 'arm64'), false, 'dl.google.com has no aarch64 Linux archive');
  assert.equal(googleShipsPlatformTools('darwin', 'arm64'), true);
  assert.equal(googleShipsPlatformTools('win32', 'x64'), true);
});

test('hasArm64Payload is Linux arm64 and nothing else', () => {
  assert.equal(hasArm64Payload('linux', 'arm64'), true);
  assert.equal(hasArm64Payload('linux', 'x64'), false, 'x86_64 uses Google\u2019s archive');
  assert.equal(hasArm64Payload('darwin', 'arm64'), false, 'darwin carries Google\u2019s universal adb');
  assert.equal(hasArm64Payload('win32', 'arm64'), false);
});

test('bundledPlatformToolsDir gives each payload its own directory', () => {
  // Side by side, because a source tree that builds both must not have one build overwrite
  // the other's payload.
  assert.equal(bundledPlatformToolsDir('linux', 'arm64'), 'linux-arm64');
  assert.equal(bundledPlatformToolsDir('linux', 'x64'), 'linux');
  assert.equal(bundledPlatformToolsDir('darwin', 'arm64'), 'darwin');
  assert.equal(bundledPlatformToolsDir('win32', 'arm64'), 'win32');
  assert.equal(bundledPlatformToolsDir('linux'), bundledPlatformToolsDir('linux', process.arch), 'the default is this machine');
});

test('bundledAdbLibDir exists only where the payload carries libraries', () => {
  const dir = tmpDir();
  try {
    const lib = path.join(bundledAdbDir(dir, 'linux', 'arm64'), 'lib');
    mkdirSync(lib, { recursive: true });
    assert.equal(bundledAdbLibDir(dir, 'linux', 'arm64'), lib);
    // x86_64 Linux is one file Google linked against nothing but the system libc; there is
    // no `lib/` to point `LD_LIBRARY_PATH` at, and `payloadEnv` must return undefined.
    assert.equal(bundledAdbLibDir(dir, 'linux', 'x64'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('elfFitsHost refuses only what it can prove is foreign', () => {
  assert.equal(elfFitsHost(elfHead(EM_X86_64), 'linux', 'x64'), true);
  // The arm64 payload is an aarch64 program, and on arm64 that is the answer — this is the
  // line that used to be `false` when the package carried no adb at all.
  assert.equal(elfFitsHost(elfHead(EM_AARCH64), 'linux', 'arm64'), true);
  assert.equal(elfFitsHost(elfHead(EM_X86_64), 'linux', 'arm64'), false, 'an x86_64 adb cannot execute here');
  assert.equal(elfFitsHost(elfHead(0x28), 'linux', 'arm64'), false, 'a 32-bit ARM adb is not an arm64 one');
  // Nothing can run on 32-bit ARM, whatever the header says.
  assert.equal(elfFitsHost(elfHead(0x28), 'linux', 'arm'), false);

  // Not an ELF (a wrapper script, adb.exe) and not Linux (not this machine's question) are
  // both left alone: this function exists to catch a foreign binary, not to gate-keep.
  assert.equal(elfFitsHost(Buffer.from('#!/bin/sh\n'), 'linux', 'arm64'), true);
  assert.equal(elfFitsHost(Buffer.alloc(0), 'linux', 'x64'), true);
  assert.equal(elfFitsHost(elfHead(EM_X86_64), 'win32', 'arm64'), true);
  assert.equal(elfFitsHost(elfHead(EM_X86_64), 'darwin', 'arm64'), true);
});

// ── what the app does with such a copy ───────────────────────────────────────

test('findAdb takes the arm64 payload on arm64 and skips the x86_64 one', async () => {
  const dir = tmpDir();
  try {
    const arm = resources(dir, 'linux-arm64', EM_AARCH64);
    const env = { PATH: '', HOME: path.join(dir, 'nobody') };
    assert.equal(await asArch('arm64', async () => findAdb(env, 'linux', dir)), arm);

    // A source tree that also built for x64 leaves `platform-tools/linux/adb` behind; on
    // arm64 that file is a foreign ELF and must not even be offered as a candidate.
    const dir2 = tmpDir();
    try {
      resources(dir2, 'linux', EM_X86_64);
      assert.equal(await asArch('arm64', async () => findAdb(env, 'linux', dir2)), undefined);
      assert.equal(await asArch('x64', async () => findAdb(env, 'linux', dir2)), path.join(dir2, 'platform-tools', 'linux', 'adb'));
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a bundled adb that will not start is named, and the fallback is the distribution\u2019s', async () => {
  const dir = tmpDir();
  try {
    // A well-formed aarch64 header and nothing behind it: exactly what a payload built for a
    // newer glibc looks like to an older machine — the right architecture, and it does not
    // run.  `findAdb` accepts it; the version probe is what rejects it.
    resources(dir, 'linux-arm64', EM_AARCH64);
    const o = {
      plat: 'linux' as const,
      env: { PATH: '', HOME: path.join(dir, 'nobody') },
      dataDir: path.join(dir, 'data'),
      log: () => {},
      resourcesDir: dir,
    };
    const err = await asArch('arm64', () => Adb.ensure(o).then(
      () => undefined,
      (e: unknown) => e,
    ));
    assert.ok(err instanceof AdbError, 'an adb that cannot print its version is not one we can drive');
    // Code `arch` is what `controller.ts` turns into `t('adbNeedsDistro')` rather than
    // `adbMissing`: the fix is a package, not a retry and not a download.
    assert.equal(err.code, 'arch');
    assert.match(err.message, /glibc 2\.35/);
    assert.match(err.message, /install your distribution's adb/);
    assert.equal(existsSync(path.join(dir, 'data', 'platform-tools')), false, 'nothing was downloaded');
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

test('--fetch-adb --arch arm64 assembles the payload instead of downloading platform-tools', () => {
  // The dispatch, without the network: `fetchArm64Adb` reports an existing payload and
  // returns, so a run against a tree that already has one touches nothing.  A build that
  // silently downloaded Google's x86_64 archive into `linux-arm64/` would print that
  // instead, and the package would carry an adb that cannot run.
  const dir = tmpDir();
  try {
    const into = path.join(dir, 'platform-tools', 'linux-arm64');
    mkdirSync(into, { recursive: true });
    const exe = path.join(into, 'adb');
    writeFileSync(exe, elfHead(EM_AARCH64));
    // What a build for x86_64 on the same machine left behind: `resources/` goes into the
    // package wholesale, so it would ship an 11 MiB adb for the wrong machine.
    resources(dir, 'linux', EM_X86_64);

    const r = spawnSync(process.execPath, ['bin/cli.mjs', '--fetch-adb', '--plat', 'linux', '--arch', 'arm64'], {
      cwd: appRoot,
      env: { ...process.env, ETHER_RESOURCES: dir },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `--fetch-adb --arch arm64 failed:\n${r.stderr}`);
    assert.match(r.stderr, /linux-arm64/, 'the payload directory is the arm64 one');
    assert.match(r.stderr, /already there/, 'the arm64 branch ran; the Google branch would have downloaded');
    assert.match(r.stderr, /removed platform-tools\/linux\b/, 'the other architecture\u2019s payload is removed');
    assert.match(r.stdout, /^linux arm64\s+: /m);
    assert.equal(existsSync(path.join(dir, 'platform-tools', 'linux')), false);
    assert.equal(existsSync(exe), true);
    // The notice is generated from the pin table on every run, even when the binaries are
    // kept, so a package never ships a notice that describes an older pin set.
    const notice = readFileSync(path.join(into, 'NOTICE.txt'), 'utf8');
    assert.match(notice, /android-platform-tools/);
    assert.match(notice, /34\.0\.5/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--fetch-adb refuses an architecture it has no payload for', () => {
  const dir = tmpDir();
  try {
    const r = spawnSync(process.execPath, ['bin/cli.mjs', '--fetch-adb', '--plat', 'linux', '--arch', 'armhf'], {
      cwd: appRoot,
      env: { ...process.env, ETHER_RESOURCES: dir },
      encoding: 'utf8',
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--arch must be x64 or arm64/);
    assert.equal(existsSync(path.join(dir, 'platform-tools')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the payload and the table it is assembled from ──────────────────────────

test('elfNeeded answers, or says nothing, but never guesses', () => {
  assert.deepEqual(elfNeeded(Buffer.alloc(0)), []);
  assert.deepEqual(elfNeeded(Buffer.from('#!/bin/sh\nexec adb "$@"\n')), []);
  assert.deepEqual(elfNeeded(elfHead(EM_AARCH64)), [], 'a 20-byte header carries no program headers');
  // A real dynamically linked executable is the parser's one honest test.  On macOS and
  // Windows `/bin/sh` is a Mach-O or a PE, and "no opinion" is the right answer there.
  const sh = readFileSync('/bin/sh');
  const machine = elfMachine(sh.subarray(0, 20));
  if (machine === EM_X86_64 || machine === EM_AARCH64) {
    assert.ok(elfNeeded(sh).includes('libc.so.6'), 'a glibc executable names libc.so.6');
  } else {
    assert.deepEqual(elfNeeded(sh), [], 'not ELF64 little-endian: no opinion');
  }
});

test('verifyPayload refuses anything that is not the pinned aarch64 payload', async () => {
  const dir = tmpDir();
  try {
    const empty = path.join(dir, 'empty');
    mkdirSync(empty, { recursive: true });
    await assert.rejects(verifyPayload(empty), (e: unknown) => {
      assert.ok(e instanceof AdbError);
      assert.equal(e.code, 'payload');
      assert.match(e.message, /has no adb/);
      return true;
    });

    // The right architecture is not enough: the library set has to be exactly the pinned
    // one, because that set *is* the claim that the payload is complete.
    const x64 = path.join(dir, 'x64');
    mkdirSync(path.join(x64, 'lib'), { recursive: true });
    writeFileSync(path.join(x64, 'adb'), elfHead(EM_X86_64));
    await assert.rejects(verifyPayload(x64), (e: unknown) => {
      assert.ok(e instanceof AdbError);
      assert.equal(e.code, 'payload');
      assert.match(e.message, /not an aarch64 ELF/);
      return true;
    });

    const short = path.join(dir, 'short');
    mkdirSync(path.join(short, 'lib'), { recursive: true });
    writeFileSync(path.join(short, 'adb'), elfHead(EM_AARCH64));
    await assert.rejects(verifyPayload(short), (e: unknown) => {
      assert.ok(e instanceof AdbError);
      assert.equal(e.code, 'payload');
      assert.match(e.message, /do not match the pin table/);
      assert.match(e.message, /missing: .*libprotobuf\.so\.32/, 'the sentence names what is missing');
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the aarch64 pin table is complete and every entry is verifiable', () => {
  assert.equal(ADB_ARM64_GLIBC, '2.35', 'the claim `adbNeedsDistro` and the README make');

  const provided = new Map<string, string>();
  for (const pin of ADB_ARM64_PINS) {
    assert.match(pin.sha256, /^[0-9a-f]{64}$/, `${pin.pkg}: a sha256 the fetch can check`);
    assert.ok(pin.url.startsWith('https://'), `${pin.pkg}: https only`);
    assert.ok(pin.url.endsWith('_arm64.deb'), `${pin.pkg}: the URL has to be the arm64 package`);
    assert.ok(pin.url.includes(`/${pin.pkg}_`), `${pin.pkg}: the URL has to be this package`);
    assert.ok(pin.provides.length > 0, `${pin.pkg}: provides nothing`);
    for (const name of pin.provides) {
      // Two packages owning one file means one silently overwrites the other, and the
      // sha256 of the pair says nothing about which one shipped.
      assert.equal(provided.has(name), false, `${name} is provided by both ${provided.get(name)} and ${pin.pkg}`);
      provided.set(name, pin.pkg);
    }
  }

  assert.ok(provided.has('adb'), 'a payload with no adb is a payload of libraries');
  // The table and the payload's own library list have to be the same set: one is what the
  // fetch copies, the other is what `verifyPayload` insists on finding.
  assert.deepEqual(
    [...provided.keys()].filter((n) => n !== 'adb').sort(),
    [...ADB_ARM64_LIBS].sort(),
  );
});

// ── the package that is actually built ───────────────────────────────────────

test('the arm64 build is the base config plus the one difference', () => {
  const arm = read('electron-builder.arm64.yml');
  assert.match(arm, /^extends:\s*\.\/electron-builder\.yml$/m, 'the arm64 config must not fork the app definition');
  assert.match(arm, /^deb:\s*$/m);
  assert.match(arm, /^\s*-\s*adb\s*$/m, 'the package still Recommends the distribution\u2019s adb, for a machine too old for the payload');
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

test('the arm64 script fetches the aarch64 payload', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const script = pkg.scripts['dist:linux:arm64'];
  assert.ok(script, 'npm run dist:linux:arm64 is what CI calls');
  assert.match(script, /electron-builder\b/);
  assert.match(script, /--arm64\b/);
  assert.match(script, /--linux deb\b/, 'the target is chosen here, because the child config may not list one');
  assert.match(script, /--config electron-builder\.arm64\.yml\b/);
  assert.match(script, /--publish never\b/, 'a packaging run must not try to publish');
  // The payload is fetched for arm64 explicitly, and *before* electron-builder copies
  // `resources/`: the machine is never asked to install an adb of its own.
  assert.match(script, /--fetch-adb --plat linux --arch arm64/, 'the arm64 package carries its own adb');
  // The others keep the bundled copy too — there is no package without one.
  for (const name of ['dist', 'dist:linux', 'dist:mac', 'dist:win']) {
    assert.match(pkg.scripts[name]!, /fetch-adb/, `${name} ships its own adb`);
  }
});

test('release.yml builds the arm64 deb and checks the payload inside it', () => {
  const yml = readFileSync(path.join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(yml, /^\s{2}linux-arm64:\s*$/m, 'the release has no arm64 Linux job');
  // It attaches to the release the linux job creates, so it must wait for it.
  const job = yml.slice(yml.indexOf('\n  linux-arm64:'));
  const head = job.slice(0, job.indexOf('\n  mac:') === -1 ? job.length : job.indexOf('\n  mac:'));
  assert.match(head, /needs:\s*linux/, 'the release already exists by the time this job attaches');
  assert.match(head, /runs-on:\s*ubuntu-latest/);
  assert.match(head, /npm run dist:linux:arm64/);
  assert.match(head, /_arm64\.deb/, 'the artifact has to be the arm64 one');

  // The claims a deb makes as text, read without running it: the architecture, the
  // recommendation, and the payload — the aarch64 adb and its libraries.
  assert.match(head, /dpkg-deb -f "\$deb" Architecture/);
  assert.match(head, /arm64/);
  assert.match(head, /Recommends/);
  assert.match(head, /payload="platform-tools\/linux-arm64"/, 'the job has to name the payload directory');
  assert.match(head, /\$payload\/adb/, 'the job has to assert the payload is inside');
  assert.match(head, /aarch64/, 'and that the adb in it is an aarch64 program');
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
