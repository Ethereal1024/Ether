// adb-arm64.ts — the aarch64 adb an arm64 package carries, and where it comes from.
//
// Google publishes Linux platform-tools for x86_64 only: `repository2-3.xml` has one
// linux archive and no `host-arch` field, and the aarch64 file names are 404.  So an arm64
// package has nothing to download and nothing of Google's to bundle — which is why arm64
// used to ship no adb and ask the machine to install its distribution's.  That is the one
// platform where the app did not work out of the box, and the fix is the adb Debian builds
// from the same AOSP source: `android-platform-tools` 34.0.5 plus the shared libraries the
// loader opens, pinned to the exact versions below and checked by SHA-256 — a packaging
// step that takes "whatever the mirror has today" is not a packaging step anyone can
// reproduce.
//
// Two things decide the shape of the table.
//
//   * It has to run on the oldest aarch64 system worth supporting.  Every file was read
//     with `readelf --dyn-syms` for the glibc it needs, and the C++ runtime comes from
//     Ubuntu 22.04 rather than from bookworm: both export `GLIBCXX_3.4.30` (GCC 12), but
//     jammy's `libstdc++.so.6` needs glibc 2.34 where bookworm's needs 2.36.  With that
//     one substitution the whole payload sits at **GLIBC ≤ 2.35** — Debian 12, Ubuntu
//     22.04 (Jetson, Armbian, the Raspberry Pi images) and anything newer.  On something
//     older the copy is not used at all: `Adb.ensure` probes what it is about to run and
//     falls back to the distribution's adb with a sentence saying so.
//   * It is `adb` and exactly the libraries the loader asks for, transitively — never the
//     20 MiB a distribution installs (`fastboot`, the man page, the udev rules, the
//     boot-image scripts).  `verifyPayload` re-reads every `DT_NEEDED` entry after
//     staging, so a table that lost a library fails the packaging step instead of a
//     user's first launch.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AdbError } from './adb.js';
import { downloadToFile } from './download.js';
import { elfMachine, type Plat } from './platform.js';

/** The oldest glibc this payload starts on, as a claim a user (and a test) can read. */
export const ADB_ARM64_GLIBC = '2.35';

/** The executable's name inside the payload directory. */
const EXE = 'adb';

/**
 * Everything the payload carries in `lib/`.  This is `adb`'s `DT_NEEDED` closure — not
 * the closure of the Debian packages it comes from, which also drags in `libbsd`,
 * `libmd` and a udev-rules data package nothing here opens.
 */
export const ADB_ARM64_LIBS: readonly string[] = [
  'libbase.so.0', // android-libbase: logging, strings, the AOSP C++ base
  'libbrotlicommon.so.1', // libbrotli1: adb's compression for `push`
  'libbrotlidec.so.1',
  'libbrotlienc.so.1',
  'libcap.so.2', // libcap2: libcutils' capability helpers
  'libcrypto.so.0', // android-libboringssl: adb's own TLS for wireless pairing
  'libcutils.so.0', // android-libcutils
  'libgcc_s.so.1', // the C++ runtime, from jammy — see the header
  'liblog.so.0', // android-liblog
  'liblz4.so.1', // liblz4-1: `adb pull` of an lz4-compressed sink
  'libprotobuf.so.32', // libprotobuf32: the ADB protocol's protobuf messages
  'libssl.so.0',
  'libstdc++.so.6',
  'libudev.so.1', // libudev1: libcutils' device enumeration
  'libusb-1.0.so.0', // libusb-1.0-0: the USB transport
  'libz.so.1', // zlib1g: libziparchive
  'libziparchive.so.0', // android-libziparchive
  'libzstd.so.1', // libzstd1
];

/**
 * One `.deb` and what we take out of it.  `provides` is deliberately explicit: it is the
 * map from "a Debian package" to "a file this app loads", and a pin whose files cannot be
 * found is an error rather than a silently smaller payload.
 */
export interface AdbArm64Pin {
  pkg: string;
  version: string;
  /** Full URL of the `.deb`. */
  url: string;
  sha256: string;
  /** File names inside the package: `adb` goes to the payload root, the rest to `lib/`. */
  provides: readonly string[];
}

const DEBIAN = 'https://deb.debian.org/debian';
const UBUNTU = 'https://ports.ubuntu.com/ubuntu-ports';

/**
 * The pinned set.  Debian bookworm-backports is where `adb` 34.0.5 comes from (bookworm
 * itself has 29.0.6, which is old enough to have given up on some devices); its libraries
 * are the bookworm ones it was built against; the C++ runtime is Ubuntu 22.04's, for the
 * reason in the header.  A new pin means re-running the closure analysis, not just
 * bumping a version: `verifyPayload` says whether the result is complete.
 */
export const ADB_ARM64_PINS: readonly AdbArm64Pin[] = [
  {
    pkg: 'adb',
    version: '1:34.0.5-12~bpo12+1',
    url: `${DEBIAN}/pool/main/a/android-platform-tools/adb_34.0.5-12~bpo12+1_arm64.deb`,
    sha256: '16caa735f48a68298c5db7144ffb1d5a61141198227a701dbbe29e7cec101ade',
    provides: [EXE],
  },
  {
    pkg: 'android-libbase',
    version: '1:34.0.5-12~bpo12+1',
    url: `${DEBIAN}/pool/main/a/android-platform-tools/android-libbase_34.0.5-12~bpo12+1_arm64.deb`,
    sha256: 'f95ea126b1ef742fdbd468e31c57456fcd01415abf1ae4f14cf3f2280a10d6ce',
    provides: ['libbase.so.0'],
  },
  {
    pkg: 'android-libboringssl',
    version: '14.0.0+r45-2~bpo12+1',
    url: `${DEBIAN}/pool/main/a/android-platform-external-boringssl/android-libboringssl_14.0.0+r45-2~bpo12+1_arm64.deb`,
    sha256: '291ee3ba39778275d44ee6e30a094802ae1fa837bd4571c00de809c9e983aabe',
    provides: ['libcrypto.so.0', 'libssl.so.0'],
  },
  {
    pkg: 'android-libcutils',
    version: '1:34.0.5-12~bpo12+1',
    url: `${DEBIAN}/pool/main/a/android-platform-tools/android-libcutils_34.0.5-12~bpo12+1_arm64.deb`,
    sha256: 'fd6785bd0c24e255c9af690f9cd47f3857f2e393977c59431de63ed2698d6e57',
    provides: ['libcutils.so.0'],
  },
  {
    pkg: 'android-liblog',
    version: '1:34.0.5-12~bpo12+1',
    url: `${DEBIAN}/pool/main/a/android-platform-tools/android-liblog_34.0.5-12~bpo12+1_arm64.deb`,
    sha256: '18884bc1345776835c210b2b65e30826fb76e11241df7e3dbd7224293f9f789f',
    provides: ['liblog.so.0'],
  },
  {
    pkg: 'android-libziparchive',
    version: '1:34.0.5-12~bpo12+1',
    url: `${DEBIAN}/pool/main/a/android-platform-tools/android-libziparchive_34.0.5-12~bpo12+1_arm64.deb`,
    sha256: '7b284caea17f904e5d7acae0830cdea7c910c4664fa0ecc9bd80a79884925223',
    provides: ['libziparchive.so.0'],
  },
  {
    pkg: 'libbrotli1',
    version: '1.0.9-2+b6',
    url: `${DEBIAN}/pool/main/b/brotli/libbrotli1_1.0.9-2+b6_arm64.deb`,
    sha256: '3137de7f71952e710ee9f0df05026b3c6f463be9369a502d57c7696732f1ed22',
    provides: ['libbrotlicommon.so.1', 'libbrotlidec.so.1', 'libbrotlienc.so.1'],
  },
  {
    pkg: 'libcap2',
    version: '1:2.66-4+deb12u3+b1',
    url: `${DEBIAN}/pool/main/libc/libcap2/libcap2_2.66-4+deb12u3+b1_arm64.deb`,
    sha256: 'b3a21ae1cef9c2f3fa340007100fb0aa934ab6a4d8aed131660de9713db2bb6e',
    provides: ['libcap.so.2'],
  },
  {
    pkg: 'liblz4-1',
    version: '1.9.4-1',
    url: `${DEBIAN}/pool/main/l/lz4/liblz4-1_1.9.4-1_arm64.deb`,
    sha256: 'f061216ce11aabba8f032dfd6c75c181e782fef7493033b9621a8c3b2953b87e',
    provides: ['liblz4.so.1'],
  },
  {
    pkg: 'libprotobuf32',
    version: '3.21.12-3+deb12u1',
    url: `${DEBIAN}/pool/main/p/protobuf/libprotobuf32_3.21.12-3+deb12u1_arm64.deb`,
    sha256: '1b0ee5895cda518b5ca1b9c38f33c5d303869f861c42a749f94d4c177d867954',
    provides: ['libprotobuf.so.32'],
  },
  {
    pkg: 'libudev1',
    version: '254.26-1~bpo12+1',
    url: `${DEBIAN}/pool/main/s/systemd/libudev1_254.26-1~bpo12+1_arm64.deb`,
    sha256: '92bc41859480ded4e61f77ad760d10e3bc979a317460a3d467b56f6557185ac4',
    provides: ['libudev.so.1'],
  },
  {
    pkg: 'libusb-1.0-0',
    version: '2:1.0.26-1',
    url: `${DEBIAN}/pool/main/libu/libusb-1.0/libusb-1.0-0_1.0.26-1_arm64.deb`,
    sha256: 'e0648086b231c9204514d31480d517cb1b51e301ac39e69335a67d01ec785608',
    provides: ['libusb-1.0.so.0'],
  },
  {
    pkg: 'libzstd1',
    version: '1.5.4+dfsg2-5',
    url: `${DEBIAN}/pool/main/libz/libzstd/libzstd1_1.5.4+dfsg2-5_arm64.deb`,
    sha256: '95e173c9538f96ede4fc275ec7863f395a97dd0ea62454be9bc914efa1b9be93',
    provides: ['libzstd.so.1'],
  },
  {
    pkg: 'zlib1g',
    version: '1:1.2.13.dfsg-1',
    url: `${DEBIAN}/pool/main/z/zlib/zlib1g_1.2.13.dfsg-1_arm64.deb`,
    sha256: '52b8b8a145bbe1956bba82034f77022cbef0c3d0885c9e32d9817a7932fe1913',
    provides: ['libz.so.1'],
  },
  {
    pkg: 'libstdc++6',
    version: '12.3.0-1ubuntu1~22.04.3',
    url: `${UBUNTU}/pool/main/g/gcc-12/libstdc++6_12.3.0-1ubuntu1~22.04.3_arm64.deb`,
    sha256: '59d244119e6129c7e9c0897491c0e210e925d15881b2dedcf8965ceb4fbf1aa3',
    provides: ['libstdc++.so.6'],
  },
  {
    pkg: 'libgcc-s1',
    version: '12.3.0-1ubuntu1~22.04.3',
    url: `${UBUNTU}/pool/main/g/gcc-12/libgcc-s1_12.3.0-1ubuntu1~22.04.3_arm64.deb`,
    sha256: '46626e1af6b159061e055f843654ee1f0f1e65fa280331ed47ee76ba1b1f6045',
    provides: ['libgcc_s.so.1'],
  },
];

/** Is there a distro-built payload for this target?  Today: Linux on arm64, and nothing else. */
export function hasArm64Payload(plat: Plat, arch: string): boolean {
  return plat === 'linux' && arch === 'arm64';
}

/**
 * The libraries the host itself is expected to provide: glibc, and the loader.  Every
 * other `DT_NEEDED` entry has to be in the payload, which is the whole point of shipping
 * one — the distribution's own `libprotobuf.so.32` may not be the one adb was built against.
 */
const HOST_LIBS: readonly string[] = [
  'ld-linux-aarch64.so.1',
  'libanl.so.1',
  'libc.so.6',
  'libdl.so.2',
  'libm.so.6',
  'libnsl.so.1',
  'libpthread.so.0',
  'libresolv.so.2',
  'librt.so.1',
  'libutil.so.1',
];

const EM_AARCH64 = 0xb7;

/**
 * The `DT_NEEDED` entries of a little-endian ELF64 — what the loader will go looking for.
 * Enough of `readelf -d` for one question, and no dependency to answer it: the dynamic
 * section is located through the program headers, and the names are read out of
 * `DT_STRTAB` by mapping its virtual address onto the `PT_LOAD` segment that contains it.
 */
export function elfNeeded(buf: Buffer): string[] {
  if (buf.length < 64) return [];
  if (buf.readUInt32BE(0) !== 0x7f454c46) return []; // "\x7fELF"
  if (buf[4] !== 2 || buf[5] !== 1) return []; // ELFCLASS64, little-endian only: aarch64
  const phoff = Number(buf.readBigUInt64LE(0x20));
  const phentsize = buf.readUInt16LE(0x36);
  const phnum = buf.readUInt16LE(0x38);
  if (phentsize === 0) return [];

  let dyn: { off: number; size: number } | undefined;
  const loads: Array<{ off: number; vaddr: number; size: number }> = [];
  for (let i = 0; i < phnum; i++) {
    const p = phoff + i * phentsize;
    if (p + 56 > buf.length) break;
    const type = buf.readUInt32LE(p);
    const off = Number(buf.readBigUInt64LE(p + 8));
    const vaddr = Number(buf.readBigUInt64LE(p + 16));
    const filesz = Number(buf.readBigUInt64LE(p + 32));
    if (type === 2) dyn = { off, size: filesz }; // PT_DYNAMIC
    else if (type === 1) loads.push({ off, vaddr, size: filesz }); // PT_LOAD
  }
  if (!dyn) return [];

  let strtab = 0;
  const wanted: number[] = [];
  for (let o = dyn.off; o + 16 <= dyn.off + dyn.size && o + 16 <= buf.length; o += 16) {
    const tag = Number(buf.readBigInt64LE(o));
    if (tag === 0) break; // DT_NULL
    if (tag === 1) wanted.push(Number(buf.readBigUInt64LE(o + 8))); // DT_NEEDED
    else if (tag === 5) strtab = Number(buf.readBigUInt64LE(o + 8)); // DT_STRTAB
  }
  const seg = loads.find((s) => strtab >= s.vaddr && strtab < s.vaddr + s.size);
  if (!seg) return [];
  const base = seg.off + (strtab - seg.vaddr);

  const out: string[] = [];
  for (const off of wanted) {
    const at = base + off;
    if (at < 0 || at >= buf.length) continue;
    const end = buf.indexOf(0, at);
    if (end === -1) continue;
    out.push(buf.toString('utf8', at, end));
  }
  return out;
}

/** What a staged payload directory contains and whether it can run: run before it ships. */
export interface PayloadReport {
  adb: string;
  libs: string[];
  size: number;
}

/**
 * Everything a payload directory has to be, checked after staging: the libraries are
 * exactly the pinned set, every file is an aarch64 ELF, and nothing `adb` asks the loader
 * for is missing.  The last one is the claim the table makes, so it is the one to verify.
 */
export async function verifyPayload(dir: string): Promise<PayloadReport> {
  const adb = path.join(dir, EXE);
  const head = await readFile(adb).catch(() => undefined);
  if (!head) throw new AdbError(`the staged payload has no ${EXE}`, 'payload');
  if (elfMachine(head) !== EM_AARCH64) throw new AdbError(`${adb} is not an aarch64 ELF`, 'payload');

  const libdir = path.join(dir, 'lib');
  const libs = (await readdir(libdir).catch(() => [] as string[])).sort();
  const want = [...ADB_ARM64_LIBS].sort();
  if (libs.join(' ') !== want.join(' ')) {
    const missing = want.filter((l) => !libs.includes(l));
    const extra = libs.filter((l) => !want.includes(l));
    throw new AdbError(
      `payload libraries do not match the pin table (missing: ${missing.join(', ') || 'none'}; unexpected: ${extra.join(', ') || 'none'})`,
      'payload',
    );
  }

  const have = new Set(libs);
  const missing: string[] = [];
  const check = async (file: string, what: string): Promise<number> => {
    const buf = await readFile(file);
    if (elfMachine(buf) !== EM_AARCH64) throw new AdbError(`${file} is not an aarch64 ELF`, 'payload');
    for (const so of elfNeeded(buf)) {
      if (HOST_LIBS.includes(so) || have.has(so)) continue;
      missing.push(`${what} needs ${so}`);
    }
    return buf.length;
  };

  let size = await check(adb, EXE);
  for (const so of libs) size += await check(path.join(libdir, so), so);
  if (missing.length > 0) {
    throw new AdbError(`payload is incomplete: ${missing.join('; ')}`, 'payload');
  }
  return { adb, libs, size };
}

/**
 * Stage the payload into `dir` — the packaging half (`bin/cli.mjs --fetch-adb --arch
 * arm64`), never a run-time path.  It downloads each pinned `.deb`, refuses one whose
 * SHA-256 differs, unpacks it with `dpkg-deb` (this runs on a Debian-family packaging
 * host, and `dpkg-deb` is the one thing that reads every compression Debian has used),
 * takes the files the table names, and proves the result before it writes it.
 */
export async function fetchArm64Adb(o: {
  dir: string;
  log: (l: string) => void;
}): Promise<string> {
  const target = path.join(o.dir, EXE);
  const there = await stat(target).catch(() => undefined);
  if (there?.isFile() && there.size > 0) {
    o.log(`[adb] ${target} is already there (${(there.size / 1024 / 1024).toFixed(1)} MiB); nothing to fetch`);
    // The notice is generated from the table, so it is rewritten even when the binaries
    // are kept: a stale one would describe the previous pins.
    await writeFile(path.join(o.dir, 'NOTICE.txt'), notice(), 'utf8');
    return target;
  }
  await dpkgDeb();

  const staging = await mkdtemp(path.join(tmpdir(), 'ether-adb-arm64-'));
  try {
    const build = path.join(staging, 'payload');
    await mkdir(path.join(build, 'lib'), { recursive: true });
    for (const pin of ADB_ARM64_PINS) {
      const deb = path.join(staging, `${pin.pkg}.deb`);
      const label = `adb-arm64 ${pin.pkg} ${pin.version}`;
      o.log(`[adb] ${pin.pkg} ${pin.version}`);
      await downloadPin(pin.url, deb, label, o.log);
      const got = createHash('sha256').update(await readFile(deb)).digest('hex');
      if (got !== pin.sha256) {
        throw new AdbError(`${label}: sha256 ${got} does not match the pinned ${pin.sha256}`, 'download');
      }
      const unpacked = path.join(staging, pin.pkg);
      await dpkgDeb(['-x', deb, unpacked]);
      await rm(deb, { force: true });
      for (const name of pin.provides) {
        const from = await findFile(unpacked, name);
        const to = name === EXE ? path.join(build, name) : path.join(build, 'lib', name);
        await copyFile(from, to);
        await chmod(to, 0o755);
      }
      await rm(unpacked, { recursive: true, force: true });
    }

    const report = await verifyPayload(build);
    await mkdir(o.dir, { recursive: true });
    await copyFile(report.adb, target);
    await chmod(target, 0o755);
    const libdir = path.join(o.dir, 'lib');
    await mkdir(libdir, { recursive: true });
    for (const so of report.libs) {
      await copyFile(path.join(build, 'lib', so), path.join(libdir, so));
      await chmod(path.join(libdir, so), 0o644);
    }
    await writeFile(path.join(o.dir, 'NOTICE.txt'), notice(), 'utf8');
    o.log(
      `[adb] ${target} (adb ${adbVersion()}, ${report.libs.length} libraries, ${(report.size / 1024 / 1024).toFixed(1)} MiB, needs glibc ${ADB_ARM64_GLIBC})`,
    );
    return target;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * One pinned file, with three more tries.  These are small files from two mirrors, and a
 * release build that fails because one connection stalled is a release that has to be
 * re-tagged by hand — a mirror that drops three connections in a row inside fifteen
 * seconds did exactly that while this was written.  The SHA-256 check afterwards is what
 * makes a retry safe (a truncated or substituted file does not get past it), and a real
 * failure still ends the build after the fourth attempt, naming the package.
 */
async function downloadPin(url: string, dest: string, label: string, log: (l: string) => void): Promise<void> {
  const attempts = 4;
  for (let attempt = 1; ; attempt++) {
    try {
      await downloadToFile(url, dest, (l) => log(`[adb] ${l}`), label);
      return;
    } catch (e) {
      const msg = (e as Error).message;
      if (attempt >= attempts) throw new AdbError(msg, 'download');
      log(`[adb] ${msg}; retrying (attempt ${attempt + 1} of ${attempts})`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

function adbVersion(): string {
  return ADB_ARM64_PINS.find((p) => p.provides.includes(EXE))?.version.replace(/^1:/, '') ?? 'unknown';
}

/** The attribution Apache-2.0 asks us to carry with the binary. */
function notice(): string {
  const lines = [
    'adb (aarch64) — bundled copy, and what it is built from',
    '=======================================================',
    '',
    '`adb` is Apache-2.0, from the Android Open Source Project',
    '(https://android.googlesource.com/platform/packages/modules/adb).  The binary in this',
    'directory is the aarch64 build that Debian and Ubuntu make from that source; this app',
    'does not modify it.  It is fetched at package time, by `bin/cli.mjs --fetch-adb --arch',
    'arm64`, from the packages below and is never committed to the repository.',
    '',
    '  file                  package / version',
  ];
  for (const pin of ADB_ARM64_PINS) {
    for (const name of pin.provides) {
      lines.push(`  ${name.padEnd(20)}  ${pin.pkg} ${pin.version}`);
    }
  }
  lines.push(
    '',
    'Each file was checked against the SHA-256 recorded in `src/main/adb-arm64.ts`; the',
    'pinned URLs are the originals.  Licences follow the package: adb and the android-lib*',
    'files are Apache-2.0 (AOSP), libstdc++/libgcc are GPL-3.0-or-later with the GCC Runtime',
    'Library Exception, libusb and libudev are LGPL-2.1-or-later, and the rest are',
    'BSD/MIT/Zlib.  The full texts are the copyright files each package ships at',
    '/usr/share/doc/<package>/copyright, inside the .deb named above.  Corresponding source:',
    'the Debian source packages android-platform-tools, brotli, libcap2, lz4, protobuf,',
    'systemd, libusb-1.0, zstd and zlib, and Ubuntu 22.04\'s gcc-12.',
    '',
    'On a machine whose glibc is older than 2.35 this copy does not start, and the app uses',
    "the distribution's own adb instead — see `messages.adbNeedsDistro`.",
    '',
  );
  return lines.join('\n');
}

/** Find one file by name anywhere in an unpacked package. */
async function findFile(dir: string, name: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const found = await findFile(p, name).catch(() => undefined);
      if (found) return found;
    } else if (e.name === name) {
      return p;
    }
  }
  throw new AdbError(`a pinned package does not contain ${name}`, 'payload');
}

/** `dpkg-deb`, or a sentence naming what the packaging step needs. */
async function dpkgDeb(args: string[] = ['--version']): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile('dpkg-deb', args, { timeout: 120_000, maxBuffer: 8 << 20 }, (err, _stdout, stderr) => {
      if (!err) {
        resolve();
        return;
      }
      if (args[0] === '--version') {
        reject(
          new AdbError(
            'packaging the arm64 adb needs `dpkg-deb` (a Debian/Ubuntu packaging host): it unpacks the pinned .deb files',
            'tool',
          ),
        );
        return;
      }
      reject(new AdbError(`dpkg-deb ${args[0] ?? ''} failed: ${String(stderr).trim() || err.message}`, 'payload'));
    });
  });
}
