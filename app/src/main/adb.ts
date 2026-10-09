// adb.ts — find adb, or fetch our own copy; then parse what it says.
//
// Rules that shape this file (§3.2):
//   * always prefer what the user already has — never install anything system-wide,
//     never touch PATH, never sudo;
//   * the download goes into the app's own data dir and is used only by our child
//     processes, so deleting the app dir leaves the machine exactly as it was;
//   * never `kill-server` on our own initiative — a running adb server may belong
//     to someone else's debugging session.

import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { adbExeName, findAdb, type Plat } from './platform.js';
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

function download(url: string, dest: string, log: (l: string) => void, redirects = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new AdbError('too many redirects while downloading platform-tools', 'download'));
      return;
    }
    https
      .get(url, (res) => {
        const code = res.statusCode ?? 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          resolve(download(new URL(res.headers.location, url).toString(), dest, log, redirects + 1));
          return;
        }
        if (code !== 200) {
          res.resume();
          reject(new AdbError(`platform-tools download failed: HTTP ${code}`, 'download'));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (c: Buffer) => {
          chunks.push(c);
          total += c.length;
          if (total % (4 << 20) < c.length) log(`[adb] downloading platform-tools… ${(total >> 20)} MiB`);
        });
        res.on('error', reject);
        res.on('end', async () => {
          try {
            await writeFile(dest, Buffer.concat(chunks));
            log(`[adb] downloaded ${(total >> 20)} MiB -> ${dest}`);
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', (e) => reject(new AdbError(`platform-tools download failed: ${e.message}`, 'download')));
  });
}

export class Adb {
  readonly exe: string;
  readonly version: string;
  /** True once a command's stderr admitted a mismatched adb server version. */
  conflict = false;
  private readonly opts: AdbOpts;

  private constructor(opts: AdbOpts, exe: string, version: string) {
    this.opts = opts;
    this.exe = exe;
    this.version = version;
  }

  /** Four-step discovery; step four downloads platform-tools into `dataDir`. */
  static async ensure(o: AdbOpts): Promise<Adb> {
    const found = findAdb(o.env, o.plat);
    if (found) {
      const version = await Adb.readVersion(found, o).catch(() => 'unknown');
      o.log(`[adb] using ${found} (version ${version})`);
      return new Adb(o, found, version);
    }

    o.log(`[adb] not found on this machine; downloading platform-tools into ${o.dataDir}`);
    const version = await Adb.downloadAndInstall(o);
    const exe = path.join(o.dataDir, 'platform-tools', adbExeName(o.plat));
    return new Adb(o, exe, version);
  }

  private static readVersion(exe: string, o: AdbOpts): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(exe, ['version'], { timeout: 10_000 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(parseAdbVersion(String(stdout)));
      });
    });
  }

  private static async downloadAndInstall(o: AdbOpts): Promise<string> {
    await mkdir(o.dataDir, { recursive: true });
    const zipPath = path.join(o.dataDir, `platform-tools-latest-${o.plat}.zip`);
    await download(platformToolsUrl(o.plat), zipPath, o.log);

    const buf = await readFile(zipPath);
    const staging = path.join(o.dataDir, 'platform-tools.staging');
    const target = path.join(o.dataDir, 'platform-tools');
    await extractZip(buf, staging, o.log);
    await rm_rf(target);
    await rename(staging, target);

    const exe = path.join(target, adbExeName(o.plat));
    if (o.plat !== 'win32') await chmod(exe, 0o755);
    const st = await stat(exe);
    if (!st.isFile()) throw new AdbError('platform-tools extracted without an adb binary', 'download');
    const version = await Adb.readVersion(exe, o);
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
        { timeout: timeoutMs, maxBuffer: 8 << 20, encoding: 'utf8' },
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

async function rm_rf(p: string): Promise<void> {
  const { rm } = await import('node:fs/promises');
  await rm(p, { recursive: true, force: true });
}
