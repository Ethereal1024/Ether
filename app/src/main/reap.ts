// reap.ts — never leave anything behind.
//
// The prototype's worst failure mode was a survivor: an interrupted run left a
// `nohup`'d relay alive, the next run deleted its pid file, and from then on
// nobody owned it (§5).  So cleanup does not depend on one
// bookkeeping mechanism; it checks three, cheapest first:
//
//   1. the record we wrote (pid files / state.json)      — survives most crashes
//   2. who is actually listening on our ports            — survives a lost record
//   3. `adb reverse --remove` for every port we recorded — survives everything
//
// The tablet side gets the same treatment: the recorded pid AND a cmdline match,
// so a recycled pid can never make us kill an innocent process.

import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isAlive, killTree, type Plat } from './platform.js';
import type { Adb } from './adb.js';

export interface DeviceRelayRecord {
  /** Sunshine's UDP port, i.e. what the tablet-side relay listens on. */
  sunshine: number;
  /** The tunnel TCP port carrying it. */
  tunnel: number;
  pid?: number;
}

export interface StateFile {
  pid: number;
  startedAt: string;
  serial?: string;
  /** Native `adb reverse tcp:P tcp:P` channels (HTTPS/HTTP/WebUI/RTSP). */
  tcpPorts: number[];
  udpTunnels: DeviceRelayRecord[];
  /** Host-side helper processes we spawned (option B / CLI mode). */
  hostPids: number[];
  elfRemote: string;
}

export const STATE_NAME = 'state.json';

export function statePath(dataDir: string): string {
  return path.join(dataDir, STATE_NAME);
}

// The state file is a hint about what *we* left behind, so it is re-validated
// rather than trusted: a truncated or hand-edited file must never hand `NaN` or
// a stray string to `kill()` or `adb reverse` (§13.2, §13.9).

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function isPort(n: number): boolean {
  return Number.isInteger(n) && n > 0 && n <= 65535;
}

function isPid(n: number): boolean {
  return Number.isInteger(n) && n > 0;
}

function portList(v: unknown): number[] {
  return Array.isArray(v) ? v.map((x) => num(x, 0)).filter(isPort) : [];
}

function pidList(v: unknown): number[] {
  return Array.isArray(v) ? v.map((x) => num(x, 0)).filter(isPid) : [];
}

/** One device-side relay record; `pid` is present only when we actually know it. */
function relayRecord(v: unknown): DeviceRelayRecord | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Partial<DeviceRelayRecord>;
  const sunshine = num(r.sunshine, 0);
  const tunnel = num(r.tunnel, 0);
  if (!isPort(sunshine) || !isPort(tunnel)) return undefined;
  const pid = num(r.pid, 0);
  return isPid(pid) ? { sunshine, tunnel, pid } : { sunshine, tunnel };
}

export async function readState(dataDir: string): Promise<StateFile | undefined> {
  try {
    const text = await readFile(statePath(dataDir), 'utf8');
    const parsed = JSON.parse(text) as Partial<StateFile>;
    return {
      pid: num(parsed.pid, 0),
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
      serial: typeof parsed.serial === 'string' ? parsed.serial : undefined,
      tcpPorts: portList(parsed.tcpPorts),
      udpTunnels: Array.isArray(parsed.udpTunnels)
        ? parsed.udpTunnels.map(relayRecord).filter((t): t is DeviceRelayRecord => t !== undefined)
        : [],
      hostPids: pidList(parsed.hostPids),
      elfRemote: typeof parsed.elfRemote === 'string' ? parsed.elfRemote : '',
    };
  } catch {
    return undefined;
  }
}

export async function writeState(dataDir: string, s: StateFile): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(statePath(dataDir), JSON.stringify(s, null, 2));
}

export async function clearState(dataDir: string): Promise<void> {
  await rm(statePath(dataDir), { force: true });
}

function runCmd(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 4000, maxBuffer: 8 << 20 }, (err, stdout) =>
      resolve(err ? null : String(stdout)),
    );
  });
}

/**
 * Layer 2: who is listening on our ports, and is it actually ours?
 * Only a process literally named `udp2tcp` is ever signalled — an unidentified
 * holder is reported, never killed.  Silently unavailable off Linux, which the
 * caller records rather than guesses.
 */
export async function portOwners(
  tcpPorts: number[],
  udpPorts: number[],
  plat: Plat,
): Promise<Array<{ port: number; proto: 'tcp' | 'udp'; pid: number; name: string }>> {
  if (plat !== 'linux') return [];
  const found: Array<{ port: number; proto: 'tcp' | 'udp'; pid: number; name: string }> = [];
  const scan = async (port: number, proto: 'tcp' | 'udp') => {
    const flag = proto === 'tcp' ? '-lptnH' : '-lpunH';
    const out = await runCmd('ss', [flag, `sport = :${port}`]);
    if (!out) return;
    for (const m of out.matchAll(/\(\("([^"]+)",pid=(\d+)/g)) {
      found.push({ port, proto, pid: Number(m[2]), name: m[1]! });
    }
  };
  for (const p of tcpPorts) await scan(p, 'tcp');
  for (const p of udpPorts) await scan(p, 'udp');
  return found;
}

export interface ReapOpts {
  adb?: Adb;
  dataDir: string;
  plat: Plat;
  log: (l: string) => void;
  /** Also remove reverses for these ports even if they are not in state.json. */
  extraReversePorts?: number[];
  /** Set false to leave the tablet side alone (no device, or a dry run). */
  touchDevice?: boolean;
  /** Sweep the tablet even with no recorded state (explicit user cleanup). */
  forceDeviceSweep?: boolean;
  /**
   * Keep state.json instead of clearing it.  The pre-adb pass runs before we can
   * reach the tablet, so it can neither remove the reverses nor kill the device
   * relays — clearing the record there would throw away the only thing that says
   * what still needs undoing.
   */
  keepState?: boolean;
}

export interface ReapReport {
  hostPidsKilled: number[];
  foreignPorts: Array<{ port: number; proto: string; pid: number; name: string }>;
  reversesRemoved: number[];
  devicePidsKilled: number[];
  notes: string[];
}

/**
 * Full residual sweep.  Idempotent and safe to run on every start, which is the
 * point: a crash that loses the record is the case we are defending against.
 */
export async function reapAll(o: ReapOpts): Promise<ReapReport> {
  const report: ReapReport = {
    hostPidsKilled: [],
    foreignPorts: [],
    reversesRemoved: [],
    devicePidsKilled: [],
    notes: [],
  };
  const state = await readState(o.dataDir);

  // ── layer 1: whatever we wrote down ────────────────────────────────────────
  const recordedPids = new Set<number>(state?.hostPids ?? []);
  if (state?.pid) recordedPids.add(state.pid);
  recordedPids.delete(process.pid); // never kill ourselves
  for (const pid of recordedPids) {
    if (!isAlive(pid)) continue;
    o.log(`[reap] killing recorded host pid ${pid}`);
    await killTree(pid);
    report.hostPidsKilled.push(pid);
  }

  const recordedTcp = state?.tcpPorts ?? [];
  const recordedUdp = state?.udpTunnels ?? [];

  // ── layer 2: port ownership ───────────────────────────────────────────────
  const tcpToScan = [...recordedTcp, ...recordedUdp.map((t) => t.tunnel), ...(o.extraReversePorts ?? [])];
  const udpToScan = recordedUdp.map((t) => t.sunshine);
  const owners = await portOwners(tcpToScan, udpToScan, o.plat);
  for (const owner of owners) {
    if (owner.name === 'udp2tcp') {
      o.log(`[reap] port ${owner.port}/${owner.proto} held by stray udp2tcp pid ${owner.pid}; killing`);
      await killTree(owner.pid);
      report.hostPidsKilled.push(owner.pid);
    } else {
      report.foreignPorts.push(owner);
      o.log(`[reap] port ${owner.port}/${owner.proto} held by ${owner.name} (pid ${owner.pid}); leaving it alone`);
    }
  }
  if (o.plat !== 'linux') report.notes.push('port ownership scan is Linux-only (ss)');

  // ── layer 3: the reverses themselves ──────────────────────────────────────
  if (o.adb) {
    const ports = new Set<number>([
      ...recordedTcp,
      ...recordedUdp.map((t) => t.tunnel),
      ...(o.extraReversePorts ?? []),
    ]);
    if (ports.size > 0) {
      const before = await o.adb.reverseList().catch(() => []);
      for (const entry of before) {
        const remote = Number(entry.remote.replace('tcp:', ''));
        // Remove anything we recorded, plus anything pointing at a port we know
        // is ours — a stale mapping is worse than an extra --remove.
        if (ports.has(remote) || ports.has(Number(entry.local.replace('tcp:', '')))) {
          await o.adb.reverseRemove(remote);
          report.reversesRemoved.push(remote);
          o.log(`[reap] adb reverse --remove tcp:${remote}`);
        }
      }
    }
    if (o.touchDevice !== false && (state !== undefined || o.forceDeviceSweep === true)) {
      // The tablet sweep walks every /proc entry, which costs seconds on a real
      // phone.  It is only worth that when there is a reason to think a previous
      // run died: a recorded state, or a user who explicitly asked for cleanup.
      report.devicePidsKilled = await killDeviceRelays(
        o.adb,
        recordedUdp.map((t) => t.pid).filter(Boolean) as number[],
        o.log,
      );
    } else if (o.touchDevice !== false) {
      report.notes.push('tablet sweep skipped: no recorded state from a previous run');
    }
  }

  if (o.keepState) {
    // The pre-adb pass cannot remove a reverse or kill a tablet relay, so it must
    // not consume the record that says those things still need doing.
    if (state !== undefined) report.notes.push('kept state.json: the reverse/tablet layers need adb');
  } else {
    await clearState(o.dataDir);
  }
  return report;
}
/**
 * Tablet side: kill the pids we recorded, then sweep for `--device` processes
 * whose cmdline still says udp2tcp.
 *
 * The sweep asks `ps` for the process table once instead of spawning a `tr` per
 * /proc entry: on the reference tablet the old loop took ~8 s, which is most of
 * `--up`'s 25 s budget (§13.9 M1).  Nothing that looks like our relay name is on
 * the device command line, so `ps` cannot match itself.
 *
 * `sweep: false` kills the recorded pids and *nothing else*.  The sweep cannot
 * tell a stray from a healthy relay — every tunnel relay has exactly the same
 * cmdline shape — so a caller that is tearing down one transient relay (the UDP
 * probe in tunnel.ts) must not sweep: on the reference tablet (2026-10-07) the
 * probe's teardown ran after `up()` had started the three channel relays and
 * silently killed all three, leaving `--state` saying "up" with a dead tablet
 * side.  The sweep stays for `down()` and the residual pass, where killing every
 * relay is exactly the goal.
 */
export async function killDeviceRelays(
  adb: Adb,
  pids: number[],
  log: (l: string) => void,
  o: { sweep?: boolean } = {},
): Promise<number[]> {
  const killed: number[] = [];
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 1) continue;
    try {
      const cmd = (await adb.shell(`cat /proc/${pid}/cmdline 2>/dev/null | tr '\\0' ' '`, { timeoutMs: 4000 })).trim();
      if (cmd.includes('udp2tcp') && cmd.includes('--device')) {
        await adb.shell(`kill ${pid} 2>/dev/null`, { timeoutMs: 4000 });
        killed.push(pid);
        log(`[reap] tablet: killed recorded pid ${pid}`);
      } else {
        log(`[reap] tablet: pid ${pid} is not our relay (${cmd.slice(0, 60)}); leaving it alone`);
      }
    } catch {
      /* device gone: nothing to clean */
    }
  }

  if (o.sweep === false) return killed;

  try {
    const out = await adb.shell('ps -A -o PID,ARGS 2>/dev/null', { timeoutMs: 8000 });
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const args = m[2]!;
      if (!Number.isInteger(pid) || pid <= 1) continue;
      if (!/\budp2tcp\b/.test(args) || !/--device\b/.test(args)) continue;
      await adb.shell(`kill ${pid} 2>/dev/null`, { timeoutMs: 4000 }).catch(() => undefined);
      if (!killed.includes(pid)) killed.push(pid);
      log(`[reap] tablet: swept stray pid ${pid}`);
    }
  } catch {
    /* device gone */
  }
  return killed;
}

/** Idempotent teardown used by Tunnel.down() and by the app on quit. */
export async function removeReverses(adb: Adb, ports: number[], log: (l: string) => void): Promise<void> {
  for (const p of ports) {
    await adb.reverseRemove(p);
    log(`[reap] adb reverse --remove tcp:${p}`);
  }
}
