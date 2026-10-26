// platform.ts — the ONLY place where the three platforms differ.
//
// Everything above this module (tunnel, reap, UI) is written once.  If you find
// yourself typing `process.platform === ...` anywhere else, the difference
// belongs here instead.

import { execFile, execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
// The rule's own path is declared where the op that writes it is: this module prints it,
// it does not decide it (see the note on `udevHint`).  `elevate.ts` imports from here
// only as a type, so this is not a cycle at run time.
import { rulePath } from './elevate.js';

export type Plat = 'linux' | 'darwin' | 'win32';

export function currentPlat(): Plat {
  const p = process.platform;
  if (p === 'linux' || p === 'darwin' || p === 'win32') return p;
  return 'linux';
}

export function adbExeName(plat: Plat): string {
  return plat === 'win32' ? 'adb.exe' : 'adb';
}

function uniq(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (!x) continue;
    const key = path.normalize(x);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * adb lookup order (§3.2).  Never installs anything into the
 * system: the caller uses the first candidate that actually exists, and only
 * falls back to a download into the app's own data dir when none do.
 *
 *   1. $ADB (a file path or a directory containing adb)
 *   2. every directory on $PATH
 *   3. ~/Android/Sdk/platform-tools
 *   4. ~/Library/Android/sdk/platform-tools
 *   5. %LOCALAPPDATA%\Android\Sdk\platform-tools
 *   6. /usr/lib/android-sdk/platform-tools
 *   7. our own copy, shipped with the app (`<resources>/platform-tools/<payload>/`)
 *
 * What the user already has is still asked first: a machine with a working setup keeps
 * its own adb server and version, and two clients of one server is the state the app
 * wants to stay in.  Step 7 is what the app owes *itself* — it is why a machine with no
 * Android SDK never has to be told to install anything, and why the first launch after a
 * login needs no network.  The download (step 8, in `Adb.ensure`) is the last resort it
 * always was.
 */
export function adbCandidates(
  env: NodeJS.ProcessEnv,
  plat: Plat,
  resourcesDir?: string,
  arch: string = process.arch,
): string[] {
  const exe = adbExeName(plat);
  const out: string[] = [];

  const adbEnv = env.ADB;
  if (adbEnv) {
    out.push(adbEnv); // may be the executable itself
    out.push(path.join(adbEnv, exe)); // ...or the platform-tools directory
  }

  const pathVar = env.PATH ?? '';
  for (const dir of pathVar.split(path.delimiter)) {
    if (dir) out.push(path.join(dir, exe));
  }

  const home = env.HOME || env.USERPROFILE || homedir();
  out.push(path.join(home, 'Android', 'Sdk', 'platform-tools', exe));
  out.push(path.join(home, 'Library', 'Android', 'sdk', 'platform-tools', exe));

  const localAppData =
    env.LOCALAPPDATA ?? (plat === 'win32' ? path.join(home, 'AppData', 'Local') : undefined);
  if (localAppData) out.push(path.join(localAppData, 'Android', 'Sdk', 'platform-tools', exe));

  out.push(path.join('/usr', 'lib', 'android-sdk', 'platform-tools', exe));

  if (resourcesDir) out.push(bundledAdbPath(resourcesDir, plat, arch));

  return uniq(out);
}

/**
 * The directory name of the payload a package carries: `<resources>/platform-tools/<this>`.
 *
 * Google publishes one archive per platform — darwin's is universal, and Windows on ARM
 * runs the x64 one — so the platform *is* the whole story, with one exception: Linux on
 * arm64 carries a distribution-built adb with its own `lib/` next to it
 * (`src/main/adb-arm64.ts`), and the two payloads must be able to sit side by side in a
 * source tree that builds for both.
 */
export function bundledPlatformToolsDir(plat: Plat, arch: string = process.arch): string {
  return plat === 'linux' && arch === 'arm64' ? 'linux-arm64' : plat;
}

/**
 * Where our own copy of platform-tools lives: one directory per payload, so a package
 * carries only the adb it can run, and the path is the same in a source tree
 * (`app/resources/…`) and in a package (electron-builder copies `resources/` there).
 */
export function bundledAdbDir(resourcesDir: string, plat: Plat, arch: string = process.arch): string {
  return path.join(resourcesDir, 'platform-tools', bundledPlatformToolsDir(plat, arch));
}

export function bundledAdbPath(resourcesDir: string, plat: Plat, arch: string = process.arch): string {
  return path.join(bundledAdbDir(resourcesDir, plat, arch), adbExeName(plat));
}

/**
 * The shared libraries a bundled adb carries next to itself, if any: the aarch64 payload
 * needs them (`LD_LIBRARY_PATH`), every other one is a single file Google links against
 * nothing but the system libc.  `undefined` when there is no such directory, which is what
 * tells a caller it has nothing to add to the environment.
 */
export function bundledAdbLibDir(resourcesDir: string, plat: Plat, arch: string = process.arch): string | undefined {
  const dir = path.join(bundledAdbDir(resourcesDir, plat, arch), 'lib');
  try {
    if (!statSync(dir).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  return dir;
}

/**
 * First candidate that exists and is executable; undefined => caller must download.
 *
 * The copy we ship is the one candidate whose provenance is known, so it is also the one
 * that is checked against this machine: a source tree keeps whatever a package built on
 * *another* architecture left in `resources/platform-tools/<plat>/`, and handing an
 * x86_64 `adb` to `execFile` on an arm64 machine is ENOEXEC with no explanation.  An adb
 * the *user* installed is never second-guessed — if it is broken, the version probe says
 * so, and it is not ours to judge.
 */
export function findAdb(
  env: NodeJS.ProcessEnv,
  plat: Plat,
  resourcesDir?: string,
): string | undefined {
  const shipped = resourcesDir ? path.normalize(bundledAdbPath(resourcesDir, plat)) : undefined;
  for (const c of adbCandidates(env, plat, resourcesDir)) {
    try {
      const st = statSync(c);
      if (!st.isFile()) continue;
      if (plat === 'win32') return c;
      // eslint-disable-next-line no-bitwise
      if ((st.mode & 0o111) === 0) continue;
      if (shipped !== undefined && path.normalize(c) === shipped) {
        const head = elfHeadFromFile(c);
        if (head && !elfFitsHost(head, plat, process.arch)) continue;
      }
      return c;
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

/** The first 20 bytes of a file — an ELF header — or nothing when it cannot be read. */
export function elfHeadFromFile(p: string): Uint8Array | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(p, 'r');
    const buf = Buffer.alloc(20);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// ── can this machine run the platform-tools we would ship? ────────────────────
//
// Two different questions, and mixing them up is how an arm64 package ends up carrying an
// `adb` nobody can execute:
//
//   * `hostCanRunPlatformTools` — is there an adb we can *ship* for this host?  Linux x64
//     carries Google's archive; Linux arm64 carries a distribution-built one
//     (`src/main/adb-arm64.ts`, needs glibc 2.35 or newer, and the app probes it before it
//     trusts it); Windows on ARM emulates x64, and the darwin archive is universal.
//   * `googleShipsPlatformTools` — does `dl.google.com` have an archive for this host?  For
//     Linux that is x86_64 only, so the *download* is still the x64 path alone.  On arm64
//     a missing or unusable bundled copy cannot be repaired over the network, which is why
//     that case ends in `messages.adbNeedsDistro` instead of a minute of downloading.

/** ELF `e_machine` for a Node architecture, for the three hosts this project can meet. */
export function elfMachineForArch(arch: string): number | undefined {
  switch (arch) {
    case 'x64':
      return 0x3e; // EM_X86_64
    case 'arm64':
      return 0xb7; // EM_AARCH64
    case 'arm':
      return 0x28; // EM_ARM
    default:
      return undefined;
  }
}

/**
 * `e_machine` out of an ELF header, or `undefined` when these bytes are not one.  Twenty
 * bytes are enough — magic, `EI_DATA`, and the 16-bit field at offset 18 — which is what
 * lets a caller answer from a 20-byte read instead of loading a 10 MiB binary to look at
 * its second half.
 */
export function elfMachine(head: Uint8Array): number | undefined {
  if (head.length < 20) return undefined;
  if (head[0] !== 0x7f || head[1] !== 0x45 || head[2] !== 0x4c || head[3] !== 0x46) return undefined; // "\x7fELF"
  const lo = head[18]!;
  const hi = head[19]!;
  return head[5] === 2 ? (lo << 8) | hi : (hi << 8) | lo; // EI_DATA 2 = big endian
}

/** Is there an adb this project can ship for a host of `plat`/`arch`? */
export function hostCanRunPlatformTools(plat: Plat, arch: string): boolean {
  if (plat !== 'linux') return true;
  return arch === 'x64' || arch === 'arm64';
}

/** Does dl.google.com publish an archive for a host of `plat`/`arch`? (Linux: x86_64 only.) */
export function googleShipsPlatformTools(plat: Plat, arch: string): boolean {
  if (plat !== 'linux') return true;
  return arch === 'x64';
}

/**
 * Does this executable head belong to the machine that is about to run it?
 *
 * Three answers are deliberately `true`: another platform (not this machine's question),
 * an architecture we cannot name, and bytes that are not an ELF at all (a wrapper script,
 * or `adb.exe`).  What is refused is what can be *proved* foreign — because the
 * alternative is `execFile` failing with ENOEXEC and no explanation of where that file
 * came from.
 */
export function elfFitsHost(head: Uint8Array, plat: Plat, arch: string): boolean {
  if (plat !== 'linux') return true;
  const got = elfMachine(head);
  if (got !== undefined) {
    const want = elfMachineForArch(arch);
    if (want !== undefined && got !== want) return false;
  }
  return hostCanRunPlatformTools(plat, arch);
}

export function fileExists(p: string): boolean {
  return existsSync(p);
}

/** App data dir (logs, pid files, the downloaded adb). CLI mode can override it. */
export function userDataDir(name = 'ether'): string {
  const override = process.env.ETHER_DATA_DIR;
  if (override) return override;

  const plat = currentPlat();
  const home = homedir();
  if (plat === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    return path.join(appData, name);
  }
  if (plat === 'darwin') return path.join(home, 'Library', 'Application Support', name);
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  return path.join(xdg, name);
}

/**
 * Android OEM vendor ids — only ever a *last-resort guess* when the device behind
 * an adb serial cannot be found in sysfs.  A wrong guess yields a rule that
 * silently does nothing, so an ambiguous `lsusb` dump yields `undefined` instead
 * of the first hit: no hint is better than a wrong one.
 */
export const ANDROID_VENDOR_IDS: readonly string[] = [
  '17ef', '18d1', '2717', '12d1', '2a70', '04e8', '22b8', '1004', '0fce', '0bb4',
  '05c6', '2916', '19d2', '0b05', '2207', '2b0b', '22d9', '0e8d',
];

/** Where a distro keeps udev rules.  This file only ever *reads* them: writing one is
 * privileged work, so it belongs to `elevate.ts` (which is the only module that declares
 * what this app does as an administrator). */
export const RULE_DIRS: readonly string[] = [
  '/etc/udev/rules.d',
  '/run/udev/rules.d',
  '/lib/udev/rules.d',
  '/usr/lib/udev/rules.d',
];

const HEX4 = /^[0-9a-f]{4}$/;

function normalizeVid(s: string): string | undefined {
  const v = s.trim().toLowerCase();
  return HEX4.test(v) ? v : undefined;
}

/**
 * The two commands a user would paste if they would rather not let the app do it.  The
 * sentence that introduces them is `t('noPermissions')`, so this stays language-neutral
 * and `controller.ts` puts it straight into `hint`.
 *
 * The vendor id is a parameter on purpose: `<VENDOR_ID>` was a placeholder, and a hint
 * the user has to edit is not a hint (§3.4).  A caller that cannot determine the
 * vendor id must show no hint at all rather than this one with a hole in it.
 *
 * `MODE="0666"` alone is deliberate — a `GROUP=` clause would point at a group
 * that does not exist on every distro, while the mode bit is what adb needs.
 *
 * These are a *fallback*: the app installs the same rule itself, through the desktop's
 * own consent prompt (`elevate.ts`, op `grantDeviceAccess`), so no user is ever asked to
 * open a terminal.  What this function exists for is the machine where that prompt
 * cannot be raised at all (no `pkexec`, no desktop session) or where the user dismissed
 * it — there, one command to paste beats a dead end.  The path comes from `rulePath` in
 * the module that declares the op, so the file the app writes and the file it prints are
 * one answer rather than two that have to be kept in step.
 */
export function udevHint(vendorId: string): string {
  const vid = normalizeVid(vendorId);
  if (!vid) throw new Error(`udevHint: vendor id must be 4 hex digits, got '${vendorId}'`);
  const lines = [
    `echo 'SUBSYSTEM=="usb", ATTR{idVendor}=="${vid}", MODE="0666"' | sudo tee ${rulePath(vid)}`,
    'sudo udevadm control --reload-rules && sudo udevadm trigger',
  ];
  return lines.join('\n');
}

/**
 * Vendor id of the USB device that carries this adb serial, read from sysfs.
 * Reading `serial`/`idVendor` needs no device permissions — which is exactly the
 * situation we are in when adb says `no permissions`.
 */
export function vendorIdFromSysfs(sysRoot: string, serial: string): string | undefined {
  if (!serial.trim()) return undefined;
  let entries: string[];
  try {
    entries = readdirSync(sysRoot);
  } catch {
    return undefined;
  }
  const want = serial.trim().toLowerCase();
  for (const entry of entries.sort()) {
    const dir = path.join(sysRoot, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const got = readFileSync(path.join(dir, 'serial'), 'utf8').trim().toLowerCase();
      if (got !== want) continue;
      return normalizeVid(readFileSync(path.join(dir, 'idVendor'), 'utf8'));
    } catch {
      /* not a device node, or no serial — keep looking */
    }
  }
  return undefined;
}

/** Vendor of the one Android device in an `lsusb` dump; undefined if none or several. */
export function vendorIdFromLsusb(dump: string, known: readonly string[] = ANDROID_VENDOR_IDS): string | undefined {
  const hits = new Set<string>();
  for (const line of dump.split('\n')) {
    const m = line.match(/\bID\s+([0-9a-fA-F]{4}):[0-9a-fA-F]{4}\b/);
    if (!m) continue;
    const vid = (m[1] as string).toLowerCase();
    if (known.includes(vid)) hits.add(vid);
  }
  return hits.size === 1 ? [...hits][0] : undefined;
}

/** Is some rule file already granting this vendor? */
export function udevRuleInstalled(vendorId: string, dirs: readonly string[] = RULE_DIRS): boolean {
  const vid = normalizeVid(vendorId);
  if (!vid) return false;
  const re = new RegExp(`ATTRS?\\s*\\{\\s*idVendor\\s*\\}\\s*==\\s*"${vid}"`, 'i');
  for (const dir of dirs) {
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.rules')).sort();
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        if (re.test(readFileSync(path.join(dir, f), 'utf8'))) return true;
      } catch {
        /* unreadable rule file: ignore it */
      }
    }
  }
  return false;
}

function lsusbDump(): string {
  try {
    return execFileSync('lsusb', [], { encoding: 'utf8', timeout: 2000 });
  } catch {
    return '';
  }
}

export interface UdevAction {
  key: 'noPermissions' | 'noPermissionsAfterRule';
  /** The paste-able commands, or nothing at all (never a placeholder). */
  hint?: string;
}

export interface UdevProbe {
  serial?: string;
  env: NodeJS.ProcessEnv;
  sysRoot?: string;
  lsusb?: () => string;
}

/**
 * The USB vendor id behind `serial`, or `undefined` when it cannot be determined.  Both
 * the printed command and the elevated rule are built from this one answer, so "which
 * device is it" is never worked out twice.  `ETHER_UDEV_VID` (`<vid>` | `unknown`) pins
 * it for tests.
 */
export function udevVendorId(o: UdevProbe): string | undefined {
  const forced = o.env.ETHER_UDEV_VID?.trim().toLowerCase();
  if (forced === 'unknown') return undefined;
  if (forced) return normalizeVid(forced);
  return (
    vendorIdFromSysfs(o.sysRoot ?? '/sys/bus/usb/devices', o.serial ?? '') ??
    vendorIdFromLsusb((o.lsusb ?? lsusbDump)())
  );
}

/**
 * What to tell the user when the OS refuses the device (Linux, §3.4 row 3).
 *
 *   1. a rule for this vendor is already installed → the remaining step is a
 *      replug/relogin, and no privileged command is ever shown again;
 *   2. vendor known, not ruled → the fix the app runs itself (`elevate.ts`, op
 *      `grantDeviceAccess`), with these two commands as the fallback text for the
 *      machine that cannot raise a consent prompt at all;
 *   3. vendor undeterminable → the sentence alone.  Guessing would hand the user a
 *      rule for the wrong device, i.e. a fix that silently does nothing.
 *
 * `ETHER_UDEV_RULE` (`present` | `missing`) pins the probe for tests: the real answer
 * depends on the machine (this one already has `17ef` in `/etc/udev/rules.d`), and a
 * test that changes meaning when a tablet is plugged in is worse than no test.
 */
export function udevAction(o: UdevProbe & { ruleDirs?: readonly string[] }): UdevAction {
  const vid = udevVendorId(o);
  if (!vid) return { key: 'noPermissions' };

  const forcedRule = o.env.ETHER_UDEV_RULE?.trim().toLowerCase();
  const installed =
    forcedRule === 'present' ? true : forcedRule === 'missing' ? false : udevRuleInstalled(vid, o.ruleDirs ?? RULE_DIRS);

  return installed ? { key: 'noPermissionsAfterRule' } : { key: 'noPermissions', hint: udevHint(vid) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function descendants(pid: number): Promise<number[]> {
  const ps = await new Promise<string>((resolve) => {
    execFile('ps', ['-Ao', 'pid=,ppid='], (_e, stdout) => resolve(stdout ?? ''));
  });
  const kids = new Map<number, number[]>();
  for (const line of ps.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const p = Number(m[1]);
    const pp = Number(m[2]);
    const arr = kids.get(pp) ?? [];
    arr.push(p);
    kids.set(pp, arr);
  }
  const out: number[] = [];
  const walk = (p: number) => {
    for (const k of kids.get(p) ?? []) {
      walk(k);
      out.push(k);
    }
  };
  walk(pid);
  return out;
}

function killPid(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    /* already gone */
  }
}

/**
 * Terminate a process we own, children first.  Deliberately narrow: it only ever
 * touches the pid it was handed and that pid's descendants, never a name match
 * (§5.1: an accidental pkill is how you kill the wrong thing).
 */
export async function killTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 1) return;
  if (currentPlat() === 'win32') {
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve());
    });
    return;
  }
  const kids = await descendants(pid);
  for (const k of kids) killPid(k, 'SIGTERM');
  killPid(pid, 'SIGTERM');
  await sleep(150);
  for (const k of kids) killPid(k, 'SIGKILL');
  killPid(pid, 'SIGKILL');
}

/** Is this pid alive? (signal 0 probe) */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
