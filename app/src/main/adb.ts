// adb.ts — find adb, or fetch our own copy; then parse what it says.
//
// Rules that shape this file (§3.2):
//   * the app ships its own copy of platform-tools (`resources/platform-tools/<payload>/`,
//     placed there by `bin/cli.mjs --fetch-adb` while packaging; on Linux arm64 that is a
//     distribution-built adb plus the libraries it loads, see `adb-arm64.ts`) and hands it
//     to every child process — so no machine has to be told to install anything, and the
//     first launch after a login needs no network;
//   * whatever the user already has still wins over it: that keeps the user's own adb
//     server and version in charge when there is one;
//   * failing both, the download goes into the app's own data dir and is used only by our
//     child processes, so deleting the app dir leaves the machine exactly as it was.
//     Nothing is ever installed system-wide, PATH is never touched, never sudo;
//   * never `kill-server` on our own initiative — a running adb server may belong
//     to someone else's debugging session.

import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { downloadToFile } from './download.js';
import {
  adbExeName,
  bundledAdbDir,
  bundledAdbLibDir,
  bundledAdbPath,
  currentPlat,
  elfFitsHost,
  elfHeadFromFile,
  findAdb,
  googleShipsPlatformTools,
  type Plat,
} from './platform.js';
import { extractZip } from './zip.js';

export type DevState = 'device' | 'unauthorized' | 'offline' | 'no permissions' | 'unknown';

export interface Device {
  serial: string;
  state: DevState;
  model?: string;
}

export interface AdbOpts {
  plat: Plat;
  env: NodeJS.ProcessEnv;
  dataDir: string;
  log: (l: string) => void;
  /** Where our own `platform-tools/<plat>/adb` lives.  Omitted by the headless tests
   * that only care about the user's own copies. */
  resourcesDir?: string;
  /** Restrict every command to one device. */
  serial?: string;
}

export interface ReverseEntry {
  remote: string;
  local: string;
}

interface RunResult {
  stdout: string;
  stderr: string;
}

export class AdbError extends Error {
  constructor(
    message: string,
    readonly code: string,
    /**
     * What the command actually printed, kept because `execFile` drops stdout
     * from the message it builds.  Without it a caller cannot tell "the program
     * ran and failed its self-test" from "the program could not execute at all":
     * the device's phase results are the only evidence (§13.13).
     */
    readonly stdout = '',
    readonly stderr = '',
  ) {
    super(message);
    this.name = 'AdbError';
  }
}

export function parseDevices(out: string): Device[] {
  const devices: Device[] = [];
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const t = line.trim();
    if (!t || t.startsWith('List of devices') || t.startsWith('*')) continue;
    const serial = t.split(/\s+/)[0];
    if (!serial) continue;
    let state: DevState = 'unknown';
    if (t.includes('no permissions')) state = 'no permissions';
    else {
      const second = t.split(/\s+/)[1];
      if (second === 'device') state = 'device';
      else if (second === 'unauthorized') state = 'unauthorized';
      else if (second === 'offline') state = 'offline';
    }
    const m = t.match(/\bmodel:(\S+)/);
    devices.push({ serial, state, ...(m ? { model: m[1]! } : {}) });
  }
  return devices;
}

export function parseAdbVersion(out: string): string {
  const bridge = out.match(/Android Debug Bridge version\s+(\S+)/);
  const ver = out.match(/^Version\s+(\S+)/m);
  if (bridge && ver) return `${bridge[1]} (${ver[1]})`;
  if (bridge) return bridge[1]!;
  return out.trim().split('\n')[0] ?? 'unknown';
}

export function parseReverseList(out: string): ReverseEntry[] {
  const entries: ReverseEntry[] = [];
  for (const raw of out.split('\n')) {
    const t = raw.trim();
    if (!t) continue;
    const m = t.match(/^(?:(\S+)\s+)?(tcp:\d+)\s+(tcp:\d+)\s*$/);
    if (m) entries.push({ remote: m[2]!, local: m[3]! });
  }
  return entries;
}

function platformToolsUrl(plat: Plat): string {
  const tag = plat === 'win32' ? 'windows' : plat === 'darwin' ? 'darwin' : 'linux';
  return `https://dl.google.com/android/repository/platform-tools-latest-${tag}.zip`;
}

/**
 * Why there is nothing to download for this machine, in one sentence for the two places
 * that have to say it (`ensure` before it downloads, `fetchInto` before it packs): Google
 * ships Linux platform-tools for x86_64 only, and the archive is the one thing a package
 * cannot carry for another architecture.
 */
function noPlatformToolsFor(plat: Plat, arch: string): string {
  return `no platform-tools archive exists for ${plat} on ${arch}: Google publishes Linux platform-tools for x86_64 only, and an arm64 package carries a distribution-built adb instead`;
}

/**
 * Why the copy we ship is not the one that runs, in one sentence.  It is a different
 * failure from "there is no copy": the file is there, it is the right architecture, and it
 * still cannot start — on arm64 that means a glibc older than the payload's floor, and the
 * fix is the distribution's adb, which was built for that system.
 */
function bundledAdbDead(plat: Plat, arch: string): string {
  return `the adb this build ships for ${plat} on ${arch} did not start on this machine (it needs glibc 2.35 or newer), so install your distribution's adb`;
}

/**
 * The environment a bundled adb needs: one that points `LD_LIBRARY_PATH` at the libraries
 * next to it, and nothing else.
 *
 * `undefined` for every other copy — Google's archives are a single file linked against
 * nothing but the system libc, and an adb the *user* installed is never second-guessed,
 * including its library search path.  The child and everything it forks (the adb *server*,
 * which adb starts by exec'ing itself) inherit it, which is the whole reason it is set on
 * the process rather than patched into the binary: no `patchelf`, no rewritten RUNPATH, and
 * the file stays the byte-for-byte artifact whose SHA-256 is pinned.
 */
function payloadEnv(exe: string, o: { plat: Plat; resourcesDir?: string }): NodeJS.ProcessEnv | undefined {
  if (o.plat !== 'linux' || !o.resourcesDir) return undefined;
  const bundled = path.normalize(bundledAdbDir(o.resourcesDir, o.plat));
  if (path.normalize(path.dirname(exe)) !== bundled) return undefined;
  const lib = bundledAdbLibDir(o.resourcesDir, o.plat);
  if (!lib) return undefined;
  const prev = process.env.LD_LIBRARY_PATH;
  return { ...process.env, LD_LIBRARY_PATH: prev ? `${lib}${path.delimiter}${prev}` : lib };
}

export class Adb {
  readonly exe: string;
  readonly version: string;
  /** True once a command's stderr admitted a mismatched adb server version. */
  conflict = false;
  private readonly opts: AdbOpts;
  /** `LD_LIBRARY_PATH` for a bundled adb that carries its own libraries; else undefined. */
  private readonly env: NodeJS.ProcessEnv | undefined;

  private constructor(opts: AdbOpts, exe: string, version: string) {
    this.opts = opts;
    this.exe = exe;
    this.version = version;
    this.env = payloadEnv(exe, opts);
  }

  /** Five-step discovery; the last step downloads platform-tools into `dataDir`. */
  static async ensure(o: AdbOpts): Promise<Adb> {
    const found = findAdb(o.env, o.plat, o.resourcesDir) ?? (await Adb.bundled(o));
    let shippedDead = false;
    if (found) {
      const version = await Adb.readVersion(found, payloadEnv(found, o)).catch(() => undefined);
      if (version !== undefined) {
        o.log(`[adb] using ${found} (version ${version})`);
        return new Adb(o, found, version);
      }
      // A copy that cannot even print its version is not one we can drive.  An adb the
      // *user* has is still theirs to keep — a broken one is their setup to fix, and the
      // version probe already reported it.  Ours is ours to judge: it is either the wrong
      // architecture (already filtered by `findAdb`) or a payload this system is too old
      // to load, and the answer to both is "not this one".
      if (!Adb.isBundled(o, found)) {
        o.log(`[adb] using ${found} (version unknown)`);
        return new Adb(o, found, 'unknown');
      }
      shippedDead = true;
      o.log(`[adb] ${found} did not start on this machine; looking for one that will`);
    }

    // Nothing on this machine works, and no archive exists to fetch: on Linux arm64 the
    // answer is the distribution's adb — a minute of downloading would only fail at the
    // last step.  Refuse with a reason the caller can turn into a sentence.
    if (!googleShipsPlatformTools(o.plat, process.arch)) {
      throw new AdbError(
        shippedDead ? bundledAdbDead(o.plat, process.arch) : noPlatformToolsFor(o.plat, process.arch),
        'arch',
      );
    }

    o.log(`[adb] not found on this machine; downloading platform-tools into ${o.dataDir}`);
    const version = await Adb.downloadAndInstall(o);
    const exe = path.join(o.dataDir, 'platform-tools', adbExeName(o.plat));
    return new Adb(o, exe, version);
  }

  /** Is this executable the copy inside our own resources? */
  private static isBundled(o: AdbOpts, exe: string): boolean {
    if (!o.resourcesDir) return false;
    return path.normalize(exe) === path.normalize(bundledAdbPath(o.resourcesDir, o.plat));
  }

  /**
   * Our own copy, with the executable bit put back when packaging dropped it.  This is a
   * file we own in our own resources — repairing its mode is not "installing" anything —
   * and it is the difference between adb working and the user being told to go and
   * install platform-tools themselves.
   */
  private static async bundled(o: AdbOpts): Promise<string | undefined> {
    if (!o.resourcesDir) return undefined;
    const p = bundledAdbPath(o.resourcesDir, o.plat);
    try {
      const st = await stat(p);
      if (!st.isFile()) return undefined;
      // A source tree keeps the copy a package built on *this* machine left behind, and a
      // package for another architecture must never carry one.  Handing a foreign ELF to
      // `execFile` is ENOEXEC and no explanation, so the header is read first and the file
      // is skipped exactly as if it were not there — the distro's adb is then what runs.
      const head = o.plat === 'linux' ? elfHeadFromFile(p) : undefined;
      if (head && !elfFitsHost(head, o.plat, process.arch)) {
        o.log(`[adb] ${p} is built for another machine; ignoring it`);
        return undefined;
      }
      if (o.plat !== 'win32' && (st.mode & 0o111) === 0) await chmod(p, 0o755);
      return p;
    } catch {
      return undefined;
    }
  }

  /**
   * Put a copy of adb *next to the app* rather than in the user's data dir.  This is the
   * packaging step's half (`bin/cli.mjs --fetch-adb`), never a run-time path: a built
   * package ships the one dependency it cannot work without, so a machine with no Android
   * SDK is never asked to install anything, and the first launch after a login — where the
   * network is usually not up yet — needs no download at all.
   *
   * It copies `adb` plus the DLLs the Windows build loads (AdbWinApi, AdbWinUsbApi,
   * libwinpthread — whatever the archive carries at its top level), and Google's own
   * `NOTICE.txt` next to them so the attribution travels with the binary.  fastboot,
   * sqlite3 and the rest of platform-tools are not copied: this app never runs them, and
   * carrying them would multiply the size of every package for nothing.
   */
  static async fetchInto(o: { plat: Plat; arch?: string; dir: string; log: (l: string) => void; force?: boolean }): Promise<string> {
    // Packing for the machine we are on: refuse before the download, not after it.  The
    // arm64 deb is built by a different call (`fetchArm64Adb`, from Debian's packages), so
    // what this guards is the `--plat all` that would otherwise fetch x86_64 Linux
    // binaries into an arm64 package and report success.
    const arch = o.arch ?? process.arch;
    if (!googleShipsPlatformTools(o.plat, arch)) throw new AdbError(noPlatformToolsFor(o.plat, arch), 'arch');
    const exe = adbExeName(o.plat);
    const target = path.join(o.dir, exe);
    if (!o.force) {
      const there = await stat(target).catch(() => undefined);
      if (there?.isFile() && there.size > 0) {
        o.log(`[adb] ${target} is already there (${there.size >> 20} MiB); nothing to fetch`);
        return target;
      }
    }

    await mkdir(o.dir, { recursive: true });
    const zipPath = path.join(o.dir, `platform-tools-latest-${o.plat}.zip`);
    try {
      await downloadToFile(platformToolsUrl(o.plat), zipPath, (l) => o.log(`[adb] ${l}`), 'platform-tools');
    } catch (e) {
      throw new AdbError(`platform-tools download failed: ${(e as Error).message}`, 'download');
    }

    const staging = path.join(o.dir, 'platform-tools.staging');
    await rm(staging, { recursive: true, force: true });
    try {
      await extractZip(await readFile(zipPath), staging, o.log);
      const from = path.join(staging, 'platform-tools');
      const entries = await readdir(from);
      // The executable, plus every top-level DLL the archive carries: on Windows adb.exe
      // loads its AdbWinApi/AdbWinUsbApi next to itself, and a copy without them is a
      // file that exists and cannot run.
      const names = [exe, ...entries.filter((n) => n.toLowerCase().endsWith('.dll'))];
      for (const n of names) {
        const dest = path.join(o.dir, n);
        await copyFile(path.join(from, n), dest);
        if (o.plat !== 'win32') await chmod(dest, 0o755);
      }
      // Google's own attribution travels with Google's binary: the SDK terms ask for the
      // notice to be kept, and a package that ships adb while dropping the text is a
      // package that quietly loses it.  Copied verbatim, and *not* made executable.
      if (entries.includes('NOTICE.txt')) await copyFile(path.join(from, 'NOTICE.txt'), path.join(o.dir, 'NOTICE.txt'));
    } finally {
      await rm(staging, { recursive: true, force: true });
      await rm(zipPath, { force: true });
    }

    const st = await stat(target).catch(() => undefined);
    if (!st?.isFile()) throw new AdbError('platform-tools extracted without an adb binary', 'download');

    if (o.plat === currentPlat() && arch === process.arch) {
      // Proof that what we just put there runs — only on the machine that can run it; a
      // cross-fetched binary is for another machine, and this one cannot vouch for it.
      const version = await Adb.readVersion(target);
      o.log(`[adb] ${target} (${st.size >> 20} MiB, version ${version})`);
    } else {
      o.log(`[adb] ${target} (${st.size >> 20} MiB, for ${o.plat} ${arch})`);
    }
    return target;
  }

  private static readVersion(exe: string, env?: NodeJS.ProcessEnv): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(exe, ['version'], { timeout: 10_000, env }, (err, stdout) => {
        if (err) reject(err);
        else resolve(parseAdbVersion(String(stdout)));
      });
    });
  }

  private static async downloadAndInstall(o: AdbOpts): Promise<string> {
    await mkdir(o.dataDir, { recursive: true });
    const zipPath = path.join(o.dataDir, `platform-tools-latest-${o.plat}.zip`);
    // The fetcher is shared with the Windows driver path (download.ts): one place that
    // follows redirects, times out and deletes a partial file, so neither caller can be
    // the one that forgot.  The log line keeps its `[adb]` prefix — the other caller is
    // a different subject, and mixing them is how a log stops being readable.
    try {
      await downloadToFile(platformToolsUrl(o.plat), zipPath, (l) => o.log(`[adb] ${l}`), 'platform-tools');
    } catch (e) {
      throw new AdbError(`platform-tools download failed: ${(e as Error).message}`, 'download');
    }

    const buf = await readFile(zipPath);
    const staging = path.join(o.dataDir, 'platform-tools.staging');
    const target = path.join(o.dataDir, 'platform-tools');
    await extractZip(buf, staging, o.log);
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);

    const exe = path.join(target, adbExeName(o.plat));
    if (o.plat !== 'win32') await chmod(exe, 0o755);
    const st = await stat(exe);
    if (!st.isFile()) throw new AdbError('platform-tools extracted without an adb binary', 'download');
    const version = await Adb.readVersion(exe);
    o.log(`[adb] installed ${exe} (version ${version})`);
    return version;
  }

  private args(extra: string[]): string[] {
    const base = this.opts.serial ? ['-s', this.opts.serial] : [];
    return [...base, ...extra];
  }

  private run(extra: string[], timeoutMs = 15_000): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      execFile(
        this.exe,
        this.args(extra),
        { timeout: timeoutMs, maxBuffer: 8 << 20, encoding: 'utf8', env: this.env },
        (err, stdout, stderr) => {
          const err2 = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
          if (stderr && /doesn't match this client/.test(String(stderr))) {
            this.conflict = true;
            this.opts.log('[adb] a different adb server version is running');
          }
          if (err2) {
            if (err2.killed) {
              reject(
                new AdbError(
                  `adb ${extra[0] ?? ''} timed out after ${timeoutMs} ms`,
                  'timeout',
                  String(stdout),
                  String(stderr),
                ),
              );
              return;
            }
            reject(
              new AdbError(
                `adb ${extra.join(' ')}: ${(String(stderr) || err2.message).trim()}`,
                err2.code ?? 'error',
                String(stdout),
                String(stderr),
              ),
            );
            return;
          }
          resolve({ stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
  }

  async devices(): Promise<Device[]> {
    const r = await this.run(['devices', '-l']);
    return parseDevices(r.stdout);
  }

  /** The one device we will talk to, or undefined when none is usable. */
  async firstDevice(): Promise<Device | undefined> {
    const list = await this.devices();
    return list.find((d) => d.serial === this.opts.serial) ?? list[0];
  }

  async reverseAdd(tcp: number): Promise<void> {
    await this.run(['reverse', `tcp:${tcp}`, `tcp:${tcp}`]);
  }

  async reverseRemove(tcp: number): Promise<void> {
    await this.run(['reverse', '--remove', `tcp:${tcp}`]).catch(() => undefined);
  }

  async reverseList(): Promise<ReverseEntry[]> {
    const r = await this.run(['reverse', '--list']);
    return parseReverseList(r.stdout);
  }

  async push(local: string, remote: string): Promise<void> {
    await this.run(['push', local, remote], 60_000);
  }

  async shell(cmd: string, o: { timeoutMs?: number } = {}): Promise<string> {
    const r = await this.run(['shell', cmd], o.timeoutMs ?? 15_000);
    return r.stdout;
  }

  async getprop(key: string): Promise<string> {
    return (await this.shell(`getprop ${key}`)).trim();
  }

  async hasPackage(pkg: string): Promise<boolean> {
    const out = await this.shell(`pm list packages ${pkg}`);
    return out.split('\n').some((l) => l.trim() === `package:${pkg}`);
  }

  /** Only ever called from a button the user pressed. */
  async restartServer(): Promise<void> {
    await this.run(['kill-server'], 15_000).catch(() => undefined);
    await this.run(['start-server'], 20_000).catch(() => undefined);
    this.conflict = false;
  }
}
