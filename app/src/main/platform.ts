// platform.ts — the ONLY place where the three platforms differ.
//
// Everything above this module (tunnel, reap, UI) is written once.  If you find
// yourself typing `process.platform === ...` anywhere else, the difference
// belongs here instead.

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

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
 */
export function adbCandidates(env: NodeJS.ProcessEnv, plat: Plat): string[] {
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

  return uniq(out);
}

/** First candidate that exists and is executable; undefined => caller must download. */
export function findAdb(env: NodeJS.ProcessEnv, plat: Plat): string | undefined {
  for (const c of adbCandidates(env, plat)) {
    try {
      const st = statSync(c);
      if (!st.isFile()) continue;
      if (plat === 'win32') return c;
      // eslint-disable-next-line no-bitwise
      if ((st.mode & 0o111) !== 0) return c;
    } catch {
      /* keep looking */
    }
  }
  return undefined;
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
 * it — there, one command to paste beats a dead end.  `/etc/udev/rules.d` appears here
 * and in `elevate.ts` and nowhere else, so the file the app writes and the file it prints
 * can never drift apart.
 */
export function udevHint(vendorId: string): string {
  const vid = normalizeVid(vendorId);
  if (!vid) throw new Error(`udevHint: vendor id must be 4 hex digits, got '${vendorId}'`);
  const lines = [
    `echo 'SUBSYSTEM=="usb", ATTR{idVendor}=="${vid}", MODE="0666"' | sudo tee /etc/udev/rules.d/51-android.rules`,
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
