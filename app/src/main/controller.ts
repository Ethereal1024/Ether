// controller.ts — everything the app can do, with no UI and no Electron in it.
//
// Both front ends are thin shells over this class: `src/main/index.ts` exposes it
// to the renderer over IPC, and `bin/cli.mjs` drives it from argv.  Keeping the
// logic here is what makes the headless acceptance path (`--state --json`) the
// same code as the button, rather than a second implementation that drifts.

import { mkdir } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { Adb, AdbError, type Device } from './adb.js';
import type { FixKind, FixResult } from './elevate.js';
import { t, type MsgKey } from './messages.js';
import { currentPlat, udevAction, userDataDir, type Plat } from './platform.js';
import {
  detectSunshinePorts,
  sunshineConfPath,
  sunshineRunning,
  type SunshinePorts,
} from './ports.js';
import { reapAll, type ReapReport } from './reap.js';
import { Tunnel, channelNames, type TunnelState, type TunnelStatus, type UdpProbe } from './tunnel.js';

/**
 * What this PC's streaming service is doing.  `up`/`down` are measured by probing the
 * port it listens on; `unknown` means the probe itself failed, which is *not* the same
 * sentence as "no service" and must not be printed as one.
 */
export type SunshineState = 'up' | 'down' | 'unknown';

/** The fixed JSON keys (§13.8) plus a few additive ones the UI needs. */
export interface Status {
  state: TunnelState;
  device?: { serial: string; state: Device['state']; model?: string };
  adb?: { path: string; version: string; conflict: boolean };
  ports?: SunshinePorts;
  channels?: string[];
  /** Whether the service on this PC is actually there — see `SunshineState`. */
  sunshine: SunshineState;
  tcpMap: Array<[number, number]>;
  udpMap: Array<[number, number]>;
  stats: { datagrams: number; bytes: number; dropped: number; peers: number };
  message: string;
  /** Which sentence `message` is (lets a test assert on the catalogue, not the prose). */
  messageKey?: MsgKey;
  hint?: string;
  /**
   * The raised-rights remedy this state has, if any.  Only the Electron payload carries
   * it: `bin/cli.mjs` prints a frozen key set that must not grow one (§13.8), and the
   * headless path has nobody to press a button.  `controller.ts` fills it for the one
   * state it owns (a device the OS denies); the shell adds the remedies it probes for
   * itself (a missing USB driver, a desktop with no tray).
   */
  fix?: FixKind;
  /** What the last press of that remedy ended in.  Electron-only, like `fix`, and
   * cleared by the next verb rather than by the next status push. */
  fixResult?: FixResult;
  /** Whether this desktop has anywhere to *put* the tray icon, and whether the app can
   * install one.  Electron-only, like `fix`: it is a fact about the session. */
  tray?: { ok: boolean; fixable: boolean };
  /** The verified UDP round trip in Mbps, if one was taken. The window draws it as a
   * figure of its own; the §13.8 JSON (`bin/cli.mjs`) does not print it. */
  mbps?: number;
  logs: string[];
}

export interface ControllerOpts {
  dataDir?: string;
  plat?: Plat;
  env?: NodeJS.ProcessEnv;
  /** Directory containing `android/<abi>/udp2tcp`. Defaults to `<app>/resources`. */
  resourcesDir?: string;
  /** Extra log sink (a file, stdout, an IPC channel). */
  log?: (l: string) => void;
  onStatus?: (s: Status) => void;
  /** Skip the residual sweep on start (tests). */
  skipReap?: boolean;
}

const LOG_LIMIT = 500;
const EMPTY_STATS = { datagrams: 0, bytes: 0, dropped: 0, peers: 0 };
/** ABIs we ship a relay for; the directory name *is* the ABI string. */
const SUPPORTED_ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86'];

export class Controller {
  readonly dataDir: string;
  readonly plat: Plat;
  /** adb discovery failure, if any: `adbMissing` / `adbConflict`. */
  adbError?: MsgKey;
  adb?: Adb;
  ports?: SunshinePorts;
  /** See `SunshineState`: it is a fact about this machine, so it is probed every refresh. */
  sunshine: SunshineState = 'unknown';

  private readonly opts: ControllerOpts;
  private readonly resourcesDir: string;
  private readonly tunnel: Tunnel;
  private logs: string[] = [];
  private listeners: Array<(s: Status) => void> = [];

  /** Last device/message we derived without a tunnel running. */
  private last: Pick<Status, 'state' | 'device' | 'message' | 'messageKey' | 'hint' | 'fix'> = {
    state: 'idle',
    message: '',
  };

  private constructor(o: ControllerOpts) {
    this.opts = o;
    this.dataDir = o.dataDir ?? userDataDir();
    this.plat = o.plat ?? currentPlat();
    this.resourcesDir = o.resourcesDir ?? path.join(process.cwd(), 'resources');
    this.tunnel = new Tunnel({
      adb: undefined as unknown as Adb, // replaced in create()
      elfFor: (abi) => this.elfFor(abi),
      dataDir: this.dataDir,
      log: (l) => this.pushLog(l),
    });
    this.tunnel.onChange((s) => {
      this.emit(this.merge(s));
    });
  }

  static async create(o: ControllerOpts = {}): Promise<Controller> {
    const c = new Controller(o);
    await c.init();
    return c;
  }

  // ------------------------------------------------------------- lifecycle

  private async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true }).catch(() => undefined);
    this.pushLog(`[app] data dir ${this.dataDir}`);

    if (!this.opts.skipReap) {
      // Layer 0: whatever a crashed run left on this machine. Done before adb is
      // even looked for, because an orphaned host relay holds a port we need.
      const early = await reapAll({
        dataDir: this.dataDir,
        plat: this.plat,
        log: (l) => this.pushLog(l),
        touchDevice: false,
        keepState: true, // adb is not up yet: layer 1 has to finish this job
      }).catch(() => undefined);
      if (early && early.hostPidsKilled.length > 0) {
        this.pushLog(`[app] reaped ${early.hostPidsKilled.length} leftover host process(es)`);
      }
    }

    try {
      this.adb = await Adb.ensure({
        plat: this.plat,
        env: this.opts.env ?? process.env,
        dataDir: this.dataDir,
        log: (l) => this.pushLog(l),
      });
      this.tunnel.setAdb(this.adb);
    } catch (e) {
      this.adbError = e instanceof AdbError && e.code === 'conflict' ? 'adbConflict' : 'adbMissing';
      this.pushLog(`[app] ${(e as Error).message}`);
      this.last = { state: 'error', message: t(this.adbError), messageKey: this.adbError };
      return;
    }

    // Layer 1 (+ device): the record we wrote, now that we can reach a tablet.
    if (!this.opts.skipReap) {
      await reapAll({
        adb: this.adb,
        dataDir: this.dataDir,
        plat: this.plat,
        log: (l) => this.pushLog(l),
        touchDevice: true,
      }).catch(() => undefined);
    }

    await this.refresh();
  }

  // ---------------------------------------------------------------- status

  onChange(cb: (s: Status) => void): void {
    this.listeners.push(cb);
  }

  status(): Status {
    return this.merge(this.tunnel.status());
  }

  private merge(s: TunnelStatus): Status {
    const adb = this.adb
      ? { path: this.adb.exe, version: this.adb.version, conflict: this.adb.conflict }
      : undefined;
    const base: Status = {
      state: s.state,
      device: s.device ?? this.last.device,
      adb,
      ports: this.ports,
      channels: this.ports ? channelNames(this.ports) : undefined,
      sunshine: this.sunshine,
      tcpMap: s.tcpMap,
      udpMap: s.udpMap,
      stats: s.stats,
      message: s.message,
      hint: s.hint,
      // The remedy is a fact about the last scan, not about the tunnel, so it travels
      // with `hint` (see the `idle` branch): the tunnel has no idea what a udev rule is.
      fix: this.last.fix,
      mbps: s.mbps,
      logs: [...s.logs, ...this.logs].slice(-LOG_LIMIT),
    };
    if (s.state === 'idle') {
      // No tunnel: report what we know about the device instead of an empty shell.
      base.state = this.adbError ? 'error' : this.last.state;
      base.message = this.last.message;
      base.messageKey = this.last.messageKey;
      base.hint = this.last.hint;
      base.stats = { ...EMPTY_STATS };
    } else if (this.adbError) {
      base.messageKey = this.adbError;
    } else if (s.messageKey) {
      // The tunnel produced the sentence itself, so it knows which one it is.
      // Deriving the key from the state instead reported `udpFail` for a missing
      // cable (§3.4), i.e. the UI offered the wrong action for the right words.
      base.messageKey = s.messageKey;
    } else if (s.state === 'error') {
      base.messageKey = 'udpFail';
    } else if (s.state === 'up') {
      base.messageKey = 'ready';
    }
    return base;
  }

  /**
   * Ask the tablet and Sunshine what they think, without touching the tunnel.
   * This is what `--state --json` prints when nothing is running, and it is the
   * only place the §3.4 sentence table is applied.
   */
  async refresh(): Promise<Status> {
    if (this.adb && !this.adbError) {
      try {
        const list = await this.adb.devices();
        if (this.adb.conflict) {
          // A different adb server version owns 5037: every other sentence would
          // be a lie until the user restarts it (§3.4). One line, one button.
          const dev = list[0];
          this.last = {
            state: 'error',
            device: dev ? { serial: dev.serial, state: dev.state, model: dev.model } : undefined,
            message: t('adbConflict'),
            messageKey: 'adbConflict',
          };
          const s = this.status();
          this.emit(s);
          return s;
        }
        const dev = list[0];
        if (!dev) {
          this.last = { state: 'idle', message: t('noDevice'), messageKey: 'noDevice' };
        } else if (dev.state !== 'device') {
          let key: MsgKey =
            dev.state === 'unauthorized' ? 'unauthorized' : dev.state === 'no permissions' ? 'noPermissions' : 'offline';
          let hint: string | undefined;
          let fix: Status['fix'];
          if (dev.state === 'no permissions') {
            // §3.4 row 3 is the only state whose action is privileged, and the only
            // one where the sentence depends on what the machine already has: a rule
            // that is already installed must not be advertised again (platform.ts
            // decides, and it never runs the commands it prints).
            const action = udevAction({ serial: dev.serial, env: this.opts.env ?? process.env });
            key = action.key;
            hint = action.hint;
            // The elevated half of that same fix: the app installs the very rule it
            // would otherwise print, through the desktop's own consent prompt.  No
            // vendor id means there is no rule to write, and a rule already in place
            // means nothing is left to install — both are "no button", never "a button
            // that silently does nothing".
            fix = action.hint ? 'grantDeviceAccess' : undefined;
          }
          this.last = {
            state: 'error',
            device: { serial: dev.serial, state: dev.state, model: dev.model },
            message: t(key),
            messageKey: key,
            // The renderer keys the copyable block off messageKey + hint, and the
            // CLI prints `hint`: no hint means no block, by design.
            hint,
            fix,
          };
        } else {
          // Usable device: the useful next thing to know is whether there is
          // anything at the other end of the cable.
          this.last = {
            state: 'idle',
            device: { serial: dev.serial, state: dev.state, model: dev.model },
            message: '',
          };
          if (!(await this.adb.hasPackage('com.limelight')) && !(await this.adb.hasPackage('com.limelight.noir'))) {
            this.last = { ...this.last, state: 'error', message: t('noMoonlight'), messageKey: 'noMoonlight' };
          }
          if (this.sunshine === 'down') {
            this.last = { ...this.last, state: 'error', message: t('noSunshine'), messageKey: 'noSunshine' };
          }
        }
      } catch (e) {
        this.pushLog(`[app] adb devices failed: ${(e as Error).message}`);
        this.last = { state: 'idle', message: t('noDevice'), messageKey: 'noDevice' };
      }
    }

    // The PC's own service is a fact about *this machine*, not about the cable: it is
    // probed on every refresh, so the card and Related software cannot report "no streaming
    // service" while one is running just because the tablet is missing or unauthorized
    // (a device-independent probe, so it needs no adb).  Only a failed probe leaves
    // `unknown` — and then the UI says the state's own sentence, never this one.
    this.ports = await detectSunshinePorts({
      confPath: sunshineConfPath(this.plat, this.opts.env ?? process.env),
      log: (l) => this.pushLog(l),
    }).catch(() => undefined);
    this.sunshine = this.ports === undefined ? 'unknown' : (await sunshineRunning(this.ports)).tcp ? 'up' : 'down';

    const s = this.status();
    this.emit(s);
    return s;
  }

  // ----------------------------------------------------------------- verbs

  async up(o: { smoke?: boolean; verify?: boolean } = {}): Promise<Status> {
    if (!this.tunnelReady()) return this.status();
    await this.tunnel.up(o);
    return this.refreshAfterTunnel();
  }

  async down(): Promise<Status> {
    if (this.tunnelReady()) await this.tunnel.down();
    this.last = { state: 'idle', message: '', device: this.last.device };
    const s = this.status();
    this.emit(s);
    return s;
  }

  /** One UDP round trip over the live bridge; requires `state === 'up'`. */
  async measure(o: { seconds?: number; window?: number; avoid?: number[] } = {}): Promise<UdpProbe> {
    return this.tunnel.measure(o);
  }

  /** Only ever from an explicit button press: it drops other adb sessions. */
  async restartAdb(): Promise<Status> {
    if (!this.adb) return this.status();
    await this.adb.restartServer();
    this.adbError = undefined;
    return this.refresh();
  }

  async reapNow(): Promise<ReapReport> {
    const report = await reapAll({
      adb: this.adb,
      dataDir: this.dataDir,
      plat: this.plat,
      log: (l) => this.pushLog(l),
      touchDevice: Boolean(this.adb),
      forceDeviceSweep: true,
    });
    this.tunnel.reset();
    return report;
  }

  elfFor(abi: string): string {
    const override = (this.opts.env ?? process.env).ETHER_ELF;
    if (override && fileOk(override)) return override;
    if (!SUPPORTED_ABIS.includes(abi)) return '';
    const p = path.join(this.resourcesDir, 'android', abi, 'udp2tcp');
    return fileOk(p) ? p : '';
  }

  /** Where the aarch64 ELF would live — used by the build/self-test helpers. */
  resourcesFor(abi: string): string {
    return path.join(this.resourcesDir, 'android', abi, 'udp2tcp');
  }

  // ---------------------------------------------------------------- private

  private tunnelReady(): boolean {
    return Boolean(this.adb && !this.adbError);
  }

  private async refreshAfterTunnel(): Promise<Status> {
    const s = this.status();
    this.emit(s);
    return s;
  }

  private pushLog(line: string): void {
    const stamped = /^\d{2}:\d{2}:\d{2} /.test(line) ? line : `${new Date().toISOString().slice(11, 19)} ${line}`;
    this.logs.push(stamped);
    if (this.logs.length > LOG_LIMIT) this.logs.splice(0, this.logs.length - LOG_LIMIT);
    this.opts.log?.(stamped);
  }

  private emit(s: Status): void {
    this.opts.onStatus?.(s);
    for (const cb of this.listeners) {
      try {
        cb(s);
      } catch {
        /* a bad listener must not take the controller down */
      }
    }
  }
}

function fileOk(p: string): boolean {
  try {
    const st = statSync(p);
    return st.isFile() && (process.platform === 'win32' || (st.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}
