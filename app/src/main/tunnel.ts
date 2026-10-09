// tunnel.ts — the whole job, in the order the reference script does it.
//
// Up:
//   push ELF (by ABI) -> chmod 755 -> device smoke -> 4x adb reverse (TCP)
//   -> for each UDP channel: host relay listening FIRST, then adb reverse,
//      then the device relay (§13.12 — the order is not
//      cosmetic: `adb reverse` has no target until the host relay listens).
//   -> verify: TCP with a plain HTTP GET from the tablet, UDP with a dedicated
//      echo pair (Sunshine never answers an unsolicited datagram, so the only
//      honest UDP proof is a round trip through the bridge itself).
//
// Down: remove reverses, kill the tablet-side relays, close the host relays.
// Everything is idempotent; a half-built tunnel is always dismantled by `down()`
// before a new one is built.

import { existsSync } from 'node:fs';
import { Adb, AdbError, type Device, type ReverseEntry } from './adb.js';
import { t, type MsgKey, uiLabels } from './messages.js';
import {
  BUSY_PORTS_TTL_MS,
  DEFAULT_BASE,
  MIC_OFFSET,
  PROC_NET_SWEEP,
  detectSunshinePorts,
  parseProcNetPorts,
  pickAvoidingBusy,
  pickFreeTcpPort,
  pickFreeUdpPort,
  sunshineConfPath,
  sunshineRunning,
  tcpListening,
  type BusyPorts,
  type SunshinePorts,
} from './ports.js';
import { startHostRelay, startUdpEcho, type Relay, type RelayStats } from './relay.js';
import { clearState, killDeviceRelays, readState, removeReverses, writeState } from './reap.js';

export type TunnelState = 'idle' | 'checking' | 'starting' | 'up' | 'degraded' | 'error';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface TunnelStatus {
  state: TunnelState;
  device?: Device;
  message: string;
  /** Which §3.4 sentence `message` is. Set here, never guessed by the caller. */
  messageKey?: MsgKey;
  hint?: string;
  /** The verified UDP round trip, in Mbps, cleared by `down()`.
   *
   * The window draws this as its own figure ("UDP round trip 119 Mbps") instead of
   * reading it out of `message`'s prose: `message` stays the sentence the CLI
   * prints, and the UI stops parsing a sentence to find a number.  Not part of the
   * §13.8 JSON (`bin/cli.mjs` picks its keys), so the frozen interface is untouched. */
  mbps?: number;
  tcpMap: Array<[number, number]>;
  udpMap: Array<[number, number]>;
  stats: RelayStats;
  logs: string[];
}

export interface TunnelDeps {
  adb: Adb;
  elfFor: (abi: string) => string;
  dataDir: string;
  log: (l: string) => void;
  /** Skip the on-device `--test` smoke run (it costs a few seconds). */
  smoke?: boolean;
  /** Skip the post-build TCP/UDP verification. */
  verify?: boolean;
}

export interface UpOpts {
  smoke?: boolean;
  verify?: boolean;
  signal?: AbortSignal;
}

/** One UDP round-trip measurement through the live bridge. */
export interface UdpProbe {
  ok: boolean;
  mbps: number;
  back: number;
  frame: number;
  /** Actual measured duration, in seconds. */
  seconds: number;
  odd: number;
  /** Human-readable one-liner for the details panel. */
  view: string;
}

const EMPTY_PROBE: UdpProbe = { ok: false, mbps: 0, back: 0, frame: 0, seconds: 0, odd: 0, view: '' };

const ELF_REMOTE = '/data/local/tmp/udp2tcp';
const EMPTY_STATS: RelayStats = { datagrams: 0, bytes: 0, dropped: 0, peers: 0 };
const LOG_LIMIT = 400;
/** Tablet-side client packages we recognise (Moonlight and its Artemis fork). */
const CLIENT_PACKAGES = ['com.limelight', 'com.limelight.noir'];
/** Watchdog rounds between two tablet-relay liveness checks (2 s each → ~30 s). */
const TABLET_TICKS = 15;

/**
 * One `adb shell` that reports every relay that is *not* there: each pid answers
 * with its own number, or with the negated one when it is gone.  Batched because
 * the round trip is what costs, not the `kill -0` (§13.9 M1: `--up` has 25 s).
 */
export function tabletRelayProbe(pids: number[]): string {
  return pids.map((p) => `kill -0 ${p} 2>/dev/null && echo ${p} || echo -${p}`).join('; ');
}

/** The dead pids out of a `tabletRelayProbe()` answer; anything else is ignored. */
export function parseRelayProbe(out: string): number[] {
  const dead: number[] = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^-(\d+)$/);
    if (m) dead.push(Number(m[1]));
  }
  return dead;
}

export class Tunnel {
  private readonly deps: TunnelDeps;
  /** The state is `st` because `status()` is the public name (plan §13.8). */
  private st: TunnelStatus = {
    state: 'idle',
    message: '',
    tcpMap: [],
    udpMap: [],
    stats: { ...EMPTY_STATS },
    logs: [],
  };
  private hostRelays = new Map<number, Relay>();
  private deviceRelayPids: number[] = [];
  private listeners: Array<(s: TunnelStatus) => void> = [];
  private watchdog?: NodeJS.Timeout;
  private busy = false;
  /** Watchdog rounds; the tablet relay check runs on every TABLET_TICKS-th one. */
  private ticks = 0;
  /** Bumped by every teardown: a round that was already in flight must not put a
   * reverse back into a table `down()` has just cleared ("never leave anything
   * behind" — reap.ts — is the one rule the whole house is built on). */
  private epoch = 0;
  private sunshineBase = DEFAULT_BASE;
  /** Last tablet port sweep; see `deviceBusyPorts()`. */
  private tabletBusy: BusyPorts | null = null;
  private tabletBusyAt = 0;

  constructor(deps: TunnelDeps) {
    this.deps = deps;
    this.st.message = '';
  }

  /** adb discovery finishes inside the Controller, which installs it here. */
  setAdb(adb: Adb): void {
    this.deps.adb = adb;
  }

  /** After a full reap: forget the tunnel without touching the tablet again. */
  reset(): void {
    this.stopWatchdog();
    this.hostRelays.clear();
    this.deviceRelayPids = [];
    this.epoch++;
    if (this.st.state !== 'up') this.st.state = 'idle';
    this.st.tcpMap = [];
    this.st.udpMap = [];
    this.st.hint = undefined;
    this.st.messageKey = undefined;
    this.forgetTabletPorts();
  }

  onChange(cb: (s: TunnelStatus) => void): void {
    this.listeners.push(cb);
  }

  /** A copy, never the live object: a caller must not be able to poke the tunnel. */
  status(): TunnelStatus {
    return this.snapshot();
  }

  private snapshot(): TunnelStatus {
    const stats: RelayStats = { ...EMPTY_STATS };
    for (const relay of this.hostRelays.values()) {
      const s = relay.stats();
      stats.datagrams += s.datagrams;
      stats.bytes += s.bytes;
      stats.dropped += s.dropped;
      stats.peers += s.peers;
    }
    return { ...this.st, stats, logs: [...this.st.logs] };
  }

  private log(line: string): void {
    const stamped = `${new Date().toISOString().slice(11, 19)} ${line}`;
    this.deps.log(stamped);
    this.st.logs.push(stamped);
    if (this.st.logs.length > LOG_LIMIT) this.st.logs.splice(0, this.st.logs.length - LOG_LIMIT);
  }

  /** One place to move the state and tell everyone, so the two watchdog checks agree. */
  private emit(): void {
    const s = this.snapshot();
    for (const cb of this.listeners) {
      try {
        cb(s);
      } catch {
        /* a bad listener must not break the tunnel */
      }
    }
  }

  /**
   * One place to move the state and tell everyone.  With a `key`, the message
   * moves with it, so the two watchdog checks cannot drift apart.
   */
  private setState(state: TunnelState, key?: MsgKey): void {
    this.st.state = state;
    if (key !== undefined) {
      this.st.messageKey = key;
      this.st.message = t(key);
    }
    this.emit();
  }

  private fail(key: MsgKey, vars?: Record<string, string | number>): TunnelStatus {
    this.st.state = 'error';
    this.st.messageKey = key;
    this.st.message = t(key, vars);
    if (key === 'noSunshine') this.st.message = `${t('noSunshine')} (${this.sunshineBase})`;
    this.emit();
    return this.snapshot();
  }

  // ------------------------------------------------------------------- up

  async up(o: UpOpts = {}): Promise<TunnelStatus> {
    if (this.busy) return this.snapshot();
    this.busy = true;
    this.st.logs = [];
    this.st.tcpMap = [];
    this.st.udpMap = [];
    this.st.hint = undefined;
    this.setState('checking');

    try {
      // A previous run may have died holding ports and reverses.
      await this.down({ silent: true });

      /* ── 1. is there a device we can actually talk to? ─────────────────── */
      const device = await this.resolveDevice();
      if ('key' in device) return this.fail(device.key, device.vars);
      this.st.device = device.device;
      this.log(`[tunnel] device ${device.device.serial} (${device.device.model ?? 'unknown model'})`);

      /* ── 2. Sunshine ───────────────────────────────────────────────────── */
      const ports = await detectSunshinePorts({ confPath: sunshineConfPath(), log: (l) => this.log(l) });
      this.sunshineBase = ports.base;
      const running = await sunshineRunning(ports);
      if (!running.tcp) return this.fail('noSunshine');
      this.log(
        `[tunnel] sunshine base ${ports.base} (source: ${ports.source}); tcp ${ports.tcp.join(',')}; udp ${ports.udp.join(',')}`,
      );

      /* ── 3. a client to receive the stream ─────────────────────────────── */
      const hasClient = (await Promise.all(CLIENT_PACKAGES.map((p) => this.deps.adb.hasPackage(p)))).some(Boolean);
      if (!hasClient) return this.fail('noMoonlight');

      /* ── 4. which tablet binary? ───────────────────────────────────────── */
      const abi = (await this.deps.adb.getprop('ro.product.cpu.abi')) || 'unknown';
      const elf = this.deps.elfFor(abi);
      this.log(`[tunnel] tablet ABI ${abi} -> ${elf || '(no build for this ABI)'}`);
      if (!elf || !existsSync(elf)) return this.fail('abiUnsupported', { abi });

      this.setState('starting');

      /* ── 5. push + smoke ───────────────────────────────────────────────── */
      this.log(`[tunnel] adb push ${elf} ${ELF_REMOTE}`);
      await this.deps.adb.push(elf, ELF_REMOTE);
      await this.deps.adb.shell(`chmod 755 ${ELF_REMOTE}`);

      const smoke = o.smoke ?? this.deps.smoke ?? true;
      if (smoke) {
        if (!(await this.smokeDevice())) return this.fail('elfNoExec');
      }

      /* ── 6. TCP channels: native adb reverse, no process at all ────────── */
      for (const p of ports.tcp) {
        await this.deps.adb.reverseAdd(p);
        this.st.tcpMap.push([p, p]);
        this.log(`[tunnel] ${p} -> adb reverse tcp:${p} -> host tcp:${p}`);
      }

      /* ── 7. UDP channels: relay pair per port ──────────────────────────── */
      // The tunnel's own ports are picked here, but the reverse listener and the
      // tablet-side relay bind them *there*, so ask the tablet what it holds.
      const tabletBusy = await this.deviceBusyPorts();
      for (const p of ports.udp) {
        const built = await this.buildUdpChannel(p, tabletBusy?.tcp);
        if (!built) {
          await this.down();
          return this.fail('udpFail');
        }
      }

      /* ── 8. persist before verifying, so a crash here is still reapable ── */
      await writeState(this.deps.dataDir, {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        serial: this.st.device?.serial,
        tcpPorts: this.st.tcpMap.map(([a]) => a),
        udpTunnels: this.st.udpMap.map(([sunshine, tunnel], i) => ({
          sunshine,
          tunnel,
          pid: this.deviceRelayPids[i],
        })),
        hostPids: [],
        elfRemote: ELF_REMOTE,
      });

      /* ── 9. prove it, or say plainly that it is not up ─────────────────── */
      const verify = o.verify ?? this.deps.verify ?? true;
      let mbps = 0;
      if (verify) {
        if (!(await this.verifyTcp(ports.base))) {
          await this.down();
          return this.fail('udpFail');
        }
        const udp = await this.measure();
        mbps = udp.mbps;
        if (!udp.ok) {
          await this.down();
          return this.fail('udpFail');
        }
      }

      this.st.state = 'up';
      this.st.messageKey = 'ready';
      this.st.message = t('ready') + (verify ? ` · ${uiLabels().rtt} ${mbps.toFixed(0)} Mbps` : '');
      this.st.mbps = verify ? Math.round(mbps) : undefined;
      this.st.hint = t('hintTapHost');
      this.emit();
      this.startWatchdog();
      return this.snapshot();
    } catch (e) {
      const msg = (e as Error).message;
      this.log(`[tunnel] failed: ${msg}`);
      await this.down({ silent: true }).catch(() => undefined);
      this.st.state = 'error';
      this.st.messageKey = 'udpFail';
      this.st.message = msg;
      this.emit();
      return this.snapshot();
    } finally {
      this.busy = false;
    }
  }

  private async resolveDevice(): Promise<
    { device: Device } | { key: MsgKey; vars?: Record<string, string | number> }
  > {
    let list: Device[];
    try {
      list = await this.deps.adb.devices();
    } catch {
      return { key: 'noDevice' };
    }
    if (list.length === 0) return { key: 'noDevice' };
    const device = list[0]!;
    switch (device.state) {
      case 'device':
        return { device };
      case 'unauthorized':
        return { key: 'unauthorized' };
      case 'no permissions':
        return { key: 'noPermissions' };
      case 'offline':
        return { key: 'offline' };
      default:
        return { key: 'noDevice' };
    }
  }

  /**
   * Any failure here is published to the user as `elfNoExec` — "the tablet-side
   * program cannot run (maybe /data/local/tmp is mounted noexec)".  That verdict
   * is a lie when the ELF obviously did run, and the self-test is easy to trip
   * without the ELF being broken at all: it measures a 3 s goodput window and then
   * floods the queue (udp2tcp.c phase 2/3), so a busy tablet — or a leftover
   * device-side `--bench` from a run that was killed — can make it answer
   * TEST FAIL.  A failed first attempt is therefore retried once before that
   * verdict is published.  The retry is cheap in both directions: ≈6 s only when
   * the first attempt already failed, and milliseconds when the ELF really cannot
   * execute (noexec/ENOEXEC returns immediately both times).
   */
  private async smokeDevice(): Promise<boolean> {
    if (await this.smokeDeviceOnce()) return true;
    this.log('[tunnel] smoke retry: one more --test before calling it unrunnable');
    return this.smokeDeviceOnce();
  }

  private async smokeDeviceOnce(): Promise<boolean> {
    this.log('[tunnel] tablet smoke test: udp2tcp --test');
    try {
      const out = await this.deps.adb.shell(`${ELF_REMOTE} --test`, { timeoutMs: 45_000 });
      const passed = /TEST PASS/.test(out);
      this.log(`[tunnel] smoke ${passed ? 'PASS' : 'FAIL'}`);
      if (!passed) this.log(out.trim().slice(-400));
      return passed;
    } catch (e) {
      const err = e as AdbError;
      this.log(`[tunnel] smoke test could not run: ${err.message}`);
      // `execFile` keeps stdout out of `message`, so the device's own words have to
      // be read back off the error.  A non-zero exit that still printed phase
      // results means the ELF ran and only its self-test failed — the case that
      // used to be reported as "the tablet-side program cannot run".
      const device = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.trim();
      if (/TEST FAIL|\[test\]|phase \d/.test(device || err.message)) {
        if (device) this.log(device.slice(-400));
        this.log('[tunnel] smoke: the ELF did run (its output is above); the self-test failed');
      }
      return false;
    }
  }

  /** host relay up first, then the reverse, then the tablet-side relay. */
  private async buildUdpChannel(sunshinePort: number, tabletBusyTcp?: Set<number>): Promise<boolean> {
    const used = new Set<number>([...this.st.tcpMap.map(([a]) => a), ...this.st.udpMap.map(([, b]) => b)]);
    for (let attempt = 0; attempt < 5; attempt++) {
      const tunnelPort = await pickAvoidingBusy(
        (u) => pickFreeTcpPort(u),
        used,
        tabletBusyTcp,
      );
      used.add(tunnelPort);

      let relay: Relay;
      try {
        relay = await startHostRelay({
          tcpListen: tunnelPort,
          udpConnect: { host: '127.0.0.1', port: sunshinePort },
          onLog: (l) => this.log(l),
        });
      } catch {
        this.log(`[tunnel] host relay could not bind ${tunnelPort}; trying another port`);
        continue;
      }
      this.hostRelays.set(tunnelPort, relay);

      try {
        await this.deps.adb.reverseAdd(tunnelPort);
      } catch (e) {
        this.log(`[tunnel] adb reverse tcp:${tunnelPort} refused (${(e as Error).message}); retrying`);
        await relay.close();
        this.hostRelays.delete(tunnelPort);
        continue;
      }

      const pid = await this.startDeviceRelay(sunshinePort, tunnelPort);
      if (pid === undefined) {
        this.log(`[tunnel] tablet relay for udp ${sunshinePort} did not start`);
        await this.deps.adb.reverseRemove(tunnelPort);
        await relay.close();
        this.hostRelays.delete(tunnelPort);
        return false;
      }
      this.deviceRelayPids.push(pid);
      this.st.udpMap.push([sunshinePort, tunnelPort]);
      this.log(
        `[tunnel] udp ${sunshinePort} (tablet) <-> adb reverse tcp:${tunnelPort} -> host tcp:${tunnelPort} <-> udp ${sunshinePort} (Sunshine)`,
      );
      return true;
    }
    return false;
  }

  private async startDeviceRelay(sunshinePort: number, tunnelPort: number): Promise<number | undefined> {
    const cmd =
      `nohup ${ELF_REMOTE} --device --udp-listen 127.0.0.1:${sunshinePort} --tcp-connect 127.0.0.1:${tunnelPort} ` +
      `>/dev/null 2>&1 </dev/null & echo $!`;
    try {
      const out = await this.deps.adb.shell(cmd, { timeoutMs: 8000 });
      const pid = Number((out.match(/(\d+)/) ?? [])[1]);
      if (!Number.isInteger(pid) || pid <= 0) return undefined;
      // Confirm it survived: a ROM that forbids exec in /data/local/tmp shows up
      // as a pid that is already gone, not as a mysterious stream failure later.
      await new Promise((r) => setTimeout(r, 150));
      const alive = (await this.deps.adb.shell(`kill -0 ${pid} 2>/dev/null && echo yes || echo no`)).trim();
      if (alive !== 'yes') {
        this.log(`[tunnel] tablet relay pid ${pid} exited immediately`);
        return undefined;
      }
      return pid;
    } catch (e) {
      this.log(`[tunnel] tablet relay start failed: ${(e as Error).message}`);
      return undefined;
    }
  }

  /**
   * Ports the tablet already holds.  One sweep, cached for a moment because
   * `up()` needs the answer once per channel and once more for the probe.
   * `null` = "could not ask" (no adb, an unreadable /proc/net, a slow device):
   * every caller then behaves exactly as it did before this existed.
   */
  private async deviceBusyPorts(): Promise<BusyPorts | null> {
    const now = Date.now();
    if (now - this.tabletBusyAt < BUSY_PORTS_TTL_MS) return this.tabletBusy;
    this.tabletBusyAt = now;
    try {
      const out = await this.deps.adb.shell(PROC_NET_SWEEP, { timeoutMs: 5000 });
      this.tabletBusy = parseProcNetPorts(out);
      this.log(
        this.tabletBusy
          ? `[tunnel] tablet holds ${this.tabletBusy.tcp.size} tcp / ${this.tabletBusy.udp.size} udp ports; avoiding them`
          : '[tunnel] tablet /proc/net unreadable; picking ports on the host alone',
      );
    } catch (e) {
      this.tabletBusy = null;
      this.log(`[tunnel] tablet port sweep failed: ${(e as Error).message}`);
    }
    return this.tabletBusy;
  }

  /** The reverse listener and the tablet relays are gone: the snapshot is stale. */
  private forgetTabletPorts(): void {
    this.tabletBusy = null;
    this.tabletBusyAt = 0;
  }

  /** Tablet asks our own HTTP port for a page; a reply means the forward is real. */
  private async verifyTcp(base: number): Promise<boolean> {
    // stdin stays open on purpose: a bare nc closes its write side instantly and
    // adb tears the connection down before Sunshine can answer (§13.12).
    const cmd = `(printf "GET / HTTP/1.0\\r\\n\\r\\n"; sleep 2) | toybox nc -w 4 127.0.0.1 ${base}`;
    try {
      const out = await this.deps.adb.shell(cmd, { timeoutMs: 12_000 });
      const ok = /HTTP\//.test(out);
      this.log(`[tunnel] TCP probe ${ok ? 'OK' : 'FAIL'}: ${out.split('\n')[0] ?? ''}`);
      return ok;
    } catch (e) {
      this.log(`[tunnel] TCP probe failed: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * UDP proof: a dedicated echo pair, because Sunshine does not echo RTP.
   * Both sides of the pair run through the same bridge code the real channels
   * use, and the client is the C binary on the tablet — the same measurement
   * `c-relay/wired-moonlight.sh bench` makes.
   *
   * Public because `--bench` and the details panel want the same number; the
   * post-build verification just calls it with the short defaults.
   */
  async measure(o: { seconds?: number; window?: number; avoid?: number[] } = {}): Promise<UdpProbe> {
    const seconds = Math.max(1, Math.min(120, o.seconds ?? 3));
    const window = Math.max(1, o.window ?? 1024);
    // `avoid` exists because `--bench` may measure next to a tunnel that lives in
    // *another* process: our own maps are empty then, and a port the service is
    // already using would otherwise be handed out again.
    const used = new Set<number>([
      ...this.st.tcpMap.map(([a]) => a),
      ...this.st.udpMap.map(([, b]) => b),
      ...(o.avoid ?? []),
    ]);
    let echo: Awaited<ReturnType<typeof startUdpEcho>> | undefined;
    let relay: Relay | undefined;
    let tunnelPort = 0;
    let devicePid: number | undefined;
    const tabletBusy = await this.deviceBusyPorts();
    const benchPort = await pickAvoidingBusy((u) => pickFreeUdpPort(u), used, tabletBusy?.udp);
    try {
      echo = await startUdpEcho(0);
      tunnelPort = await pickAvoidingBusy((u) => pickFreeTcpPort(u), used, tabletBusy?.tcp);
      this.log(`[tunnel] UDP probe: tablet udp ${benchPort} -> tcp ${tunnelPort} -> echo ${echo.port}`);
      relay = await startHostRelay({
        tcpListen: tunnelPort,
        udpConnect: { host: '127.0.0.1', port: echo.port },
        onLog: (l) => this.log(l),
      });
      await this.noteTransientPort(tunnelPort, true);
      await this.deps.adb.reverseAdd(tunnelPort);
      devicePid = await this.startDeviceRelayWithEcho(benchPort, tunnelPort);
      if (devicePid === undefined) return { ...EMPTY_PROBE, view: 'tablet relay did not start' };
      // Give the tablet relay a moment to bind before the client starts talking:
      // its first datagrams would otherwise be dropped on the floor.
      await sleep(400);

      // The device-side loop is bounded by `seconds` (`bench_mode` in udp2tcp.c
      // stops there and prints its line), but the *channel* is not: this `adb
      // shell` also pays for the remote fork and for streaming the answer back
      // over the same USB link the live tunnel is already saturating.  Five
      // back-to-back 30 s benches took exactly 31 s each, so `seconds + 12` left
      // 11 s of slack — and M3's 30-minute soak used it up once in 50 slices
      // ("adb shell timed out after 42000 ms" while the tunnel was healthy:
      // state=up, dropped=0), which the run then scored as a broken slice.
      // Waiting longer only costs time when the link is genuinely stuck; a
      // tunnel that really stopped carrying traffic is caught earlier by the
      // ELF's own "2s of silence, stopping", which parses as ok=false.
      const out = await this.deps.adb.shell(
        `${ELF_REMOTE} --bench 127.0.0.1:${benchPort} --seconds ${seconds} --window ${window}`,
        { timeoutMs: (seconds + 30) * 1000 },
      );
      const m = out.match(
        /round-trip goodput:\s*(\d+)\s*x\s*(\d+)\s*B\s+in\s+([\d.]+)s\s*->\s*([\d.]+)\s*Mbps.*?(\d+)\s*odd-sized/,
      );
      if (!m) {
        this.log(`[tunnel] UDP probe unparsable: ${out.trim().slice(-200)}`);
        return { ...EMPTY_PROBE, view: out.trim().slice(-200) };
      }
      const back = Number(m[1]);
      const frame = Number(m[2]);
      const dt = Number(m[3]);
      const mbps = Number(m[4]);
      const odd = Number(m[5]);
      const ok = back > 0 && odd === 0;
      const view = `${back} x ${frame} B / ${dt.toFixed(2)}s · ${mbps.toFixed(0)} Mbps · ${odd} odd-sized`;
      this.log(`[tunnel] UDP probe ${ok ? 'OK' : 'FAIL'}: ${view}`);
      return { ok, mbps, back, frame, seconds: dt, odd, view };
    } catch (e) {
      this.log(`[tunnel] UDP probe failed: ${(e as Error).message}`);
      return { ...EMPTY_PROBE, view: (e as Error).message };
    } finally {
      // `sweep: false`: this kills the relay this probe started and nothing else.
      // The sweeping form would take the three channel relays `up()` has already
      // started with it — same cmdline shape, so `ps` cannot tell them apart
      // (found on the reference tablet 2026-10-07: after `--up` the tablet held
      // no relays at all while `--state` reported `up`).
      if (devicePid !== undefined) await killDeviceRelays(this.deps.adb, [devicePid], () => {}, { sweep: false });
      if (tunnelPort) {
        await this.deps.adb.reverseRemove(tunnelPort);
        await this.noteTransientPort(tunnelPort, false);
      }
      await relay?.close();
      await echo?.close();
    }
  }

  /**
   * The probe borrows one reverse for a few seconds.  Writing that port into the
   * on-disk record before it exists means a SIGKILL in the middle of the probe
   * still leaves a trail the next reap can follow; the record is rewritten
   * without it as soon as the reverse is gone.  A recorded-but-absent port costs
   * one idempotent `adb reverse --remove`, so the two steps are ordered that way.
   */
  private async noteTransientPort(port: number, add: boolean): Promise<void> {
    try {
      const state = await readState(this.deps.dataDir);
      if (!state) return; // nothing recorded yet: nothing to keep in step with
      const ports = new Set(state.tcpPorts);
      if (add) ports.add(port);
      else ports.delete(port);
      state.tcpPorts = [...ports];
      await writeState(this.deps.dataDir, state);
    } catch {
      /* the record is a hint, never a contract */
    }
  }

  private async startDeviceRelayWithEcho(listenPort: number, tunnelPort: number): Promise<number | undefined> {
    const cmd =
      `nohup ${ELF_REMOTE} --device --udp-listen 127.0.0.1:${listenPort} --tcp-connect 127.0.0.1:${tunnelPort} ` +
      `>/dev/null 2>&1 </dev/null & echo $!`;
    try {
      const out = await this.deps.adb.shell(cmd, { timeoutMs: 8000 });
      const pid = Number((out.match(/(\d+)/) ?? [])[1]);
      return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    } catch {
      return undefined;
    }
  }

  // ----------------------------------------------------------------- down

  async down(o: { silent?: boolean } = {}): Promise<TunnelStatus> {
    this.stopWatchdog();
    this.forgetTabletPorts();
    this.epoch++;

    // relays first: closing them frees the ports the reverses point at
    for (const [port, relay] of this.hostRelays) {
      try {
        await relay.close();
      } catch {
        /* ignore */
      }
      this.hostRelays.delete(port);
    }

    const ports = this.reversePorts();
    const state = await readState(this.deps.dataDir);
    for (const p of [...(state?.tcpPorts ?? []), ...(state?.udpTunnels ?? []).map((u) => u.tunnel)]) {
      if (!ports.includes(p)) ports.push(p);
    }

    if (ports.length > 0 || this.deviceRelayPids.length > 0) {
      try {
        // An empty pid list still sweeps for stray `udp2tcp --device` processes
        // on the tablet (reap.ts), which is what makes `down` idempotent after
        // the app itself was killed.
        await killDeviceRelays(this.deps.adb, this.deviceRelayPids, (l) => this.log(l));
        await removeReverses(this.deps.adb, ports, (l) => this.log(l));
      } catch (e) {
        if (!o.silent) this.log(`[tunnel] teardown: ${(e as Error).message}`);
      }
    }
    this.deviceRelayPids = [];
    await clearState(this.deps.dataDir).catch(() => undefined);

    this.st.tcpMap = [];
    this.st.udpMap = [];
    this.st.hint = undefined;
    this.st.mbps = undefined;
    this.st.state = 'idle';
    this.st.message = '';
    this.st.messageKey = undefined;
    this.emit();
    return this.snapshot();
  }

  // -------------------------------------------------------------- watchdog

  /** Every port `up()` handed to `adb reverse`: the TCP channels and one per UDP channel. */
  private reversePorts(): number[] {
    return [...new Set([...this.st.tcpMap.map(([a]) => a), ...this.st.udpMap.map(([, b]) => b)])];
  }

  /**
   * The adb reverse table is the one leg of the bridge with no process behind it:
   * `up()` adds each entry once, and the table itself lives inside the adb
   * *server*.  An adb server restart — the very thing `Adb.conflict` warns about
   * (§3.2) — a USB re-enumeration between two rounds, or an adbd hiccup empties
   * it while `adb devices` goes on listing the device as `device`.  Every other
   * check survives that untouched: the host relay keeps its listen socket, the
   * tablet relay keeps running (its peer is freed, `udp2tcp.c`'s loop is not),
   * and the three TCP channels never had a process at all.  The tunnel then says
   * `up` over a bridge that cannot carry a packet, which is the 2026-10-10
   * report: the stream dies, nothing is logged, and only a reconnect (which runs
   * `up()` again) brings it back.
   *
   * One `adb reverse --list` per round: a call to the local server, not to the
   * device, so unlike the tablet probe it may run every 2 s.  A port that is
   * really gone is re-added (`adb reverse` rebinds it) and the round is then
   * reported degraded — the table is whole again, but whatever the client had
   * open through it died with the entries and only the client can open it again.
   */
  private async confirmReverses(): Promise<void> {
    const wanted = this.reversePorts();
    if (wanted.length === 0) return;
    const epoch = this.epoch;

    const missing = await this.missingReverses(wanted);
    if (missing === undefined || missing.length === 0) return;

    this.log(`[tunnel] adb reverse(s) gone: ${missing.join(',')}; re-adding`);
    for (const p of missing) {
      if (epoch !== this.epoch) return; // a teardown started while we were asking
      try {
        await this.deps.adb.reverseAdd(p);
      } catch (e) {
        this.log(`[tunnel] adb reverse tcp:${p} could not be re-added: ${(e as Error).message}`);
      }
    }

    // Read the table once more before saying anything loud.  An entry that comes
    // back is what proves it was really gone; a listing that cannot be read at
    // all (a server mid-restart, an adb whose output this parser does not know)
    // proves nothing, and must not downgrade a link that may well be fine — the
    // re-add is a no-op in that case (adb rebinds), so the round is only a few
    // milliseconds worse off.
    const after = await this.missingReverses(wanted);
    if (after === undefined || after.length > 0 || epoch !== this.epoch) return;

    // The table is whole again, but whatever the client had open through those
    // entries died with them, and only the client can open it again.
    this.setState('degraded', 'udpFail');
  }

  /** The ports `adb reverse --list` does not show; `undefined` = it did not answer. */
  private async missingReverses(wanted: number[]): Promise<number[] | undefined> {
    let live: ReverseEntry[];
    try {
      live = await this.deps.adb.reverseList();
    } catch {
      return undefined; // no answer is not an answer: say nothing this round
    }
    const present = new Set(live.map((e) => Number(e.remote.replace(/^tcp:/, ''))));
    return wanted.filter((p) => !present.has(p));
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    const timer = setInterval(() => {
      void this.tick();
    }, 2000);
    timer.unref?.();
    this.watchdog = timer;
  }

  private stopWatchdog(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = undefined;
    }
  }

  private async tick(): Promise<void> {
    if (this.st.state !== 'up' && this.st.state !== 'degraded') return;
    try {
      const list = await this.deps.adb.devices();
      // For the device this tunnel was built for, not whoever `adb devices`
      // happens to list first: `resolveDevice()` picks by serial, and with a
      // second device on the bus `list[0]` can be a machine this tunnel never
      // touches — the watchdog would then watch the wrong one and call a dead
      // link healthy.
      const serial = this.st.device?.serial;
      const dev = list.find((d) => d.serial === serial) ?? list[0];
      if (!dev || dev.state !== 'device') {
        this.log('[tunnel] device went away; dismantling');
        await this.down({ silent: true });
        this.st.state = 'idle';
        this.st.messageKey = 'noDevice';
        this.st.message = t('noDevice');
        this.emit();
        return;
      }

      // The reverses, before the two halves of the bridge: they are the leg a
      // server restart takes away without touching anything else (see the method).
      await this.confirmReverses();

      // A host relay that is no longer listening means the bridge is one-sided;
      // say so instead of showing a cheerful "up" with a dead channel.
      const gone: number[] = [];
      for (const port of this.hostRelays.keys()) {
        if (!(await tcpListening(port))) gone.push(port);
      }
      if (gone.length > 0) {
        this.log(`[tunnel] host relay(s) no longer listening: ${gone.join(',')}`);
        this.setState('degraded', 'udpFail');
      }

      // The other half of the bridge, same reason.  One adb round trip for all
      // of them, and only every TABLET_TICKS ticks: `adb shell` on this link is
      // the expensive call, and a dead tablet relay used to be invisible here —
      // `--state` went on saying "up" over a tablet that had nothing listening
      // on the video port (2026-10-07, see `killDeviceRelays`' `sweep`).
      this.ticks++;
      if (this.deviceRelayPids.length > 0 && this.ticks % TABLET_TICKS === 0) {
        try {
          const out = await this.deps.adb.shell(tabletRelayProbe(this.deviceRelayPids), { timeoutMs: 5000 });
          const dead = parseRelayProbe(out);
          if (dead.length > 0) {
            this.log(`[tunnel] tablet relay(s) gone: ${dead.join(',')} of ${this.deviceRelayPids.join(',')}`);
            this.setState('degraded', 'udpFail');
          }
        } catch {
          /* no answer is not an answer: say nothing this round */
        }
      }

      // A healthy round still has news: the relay counters behind Details →
      // Counters only move while a client streams, and the window is push-only,
      // so without this beat they stayed at the zeros `up()` reported (no client
      // had streamed yet at `up()`, and `measure()` counts through a relay of its
      // own, which `snapshot()` does not see).  Two seconds is the cadence the
      // renderer was written for, and identical text costs nothing there (it
      // skips the write, and a repeated push does not discard the log selection).
      this.emit();
    } catch {
      /* transient: try again next tick */
    }
  }
}

/** The TCP/UDP channels Sunshine defines, for the details panel. */
export function channelNames(ports: SunshinePorts, base = ports.base ?? DEFAULT_BASE): string[] {
  const names: Record<number, string> = {
    [base - 5]: 'HTTPS',
    [base]: 'HTTP/discovery',
    [base + 1]: 'Web UI',
    [base + 21]: 'RTSP',
    [base + 9]: 'Video',
    [base + 10]: 'Control',
    [base + 11]: 'Audio',
    [base + MIC_OFFSET]: 'Microphone',
  };
  return ports.tcp.concat(ports.udp).map((p) => `${p} ${names[p] ?? ''}`.trim());
}

export { tcpListening };
