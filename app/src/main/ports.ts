// ports.ts — never hard-code a port (§3.3).
//
// Sunshine's own ports are *derived* from its base port and then *confirmed* by
// probing what is actually listening; the tunnel's own ports are picked fresh
// from the OS every run.  A conflict is retried, not fatal.

import { execFile } from 'node:child_process';
import dgram from 'node:dgram';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { currentPlat, type Plat } from './platform.js';

export const DEFAULT_BASE = 47989;

/** Sunshine's offsets from the base port (`network.cpp map_port()`). */
export const TCP_OFFSETS = [-5, 0, 1, 21]; // HTTPS, HTTP/discovery, WebUI, RTSP
export const UDP_OFFSETS = [9, 10, 11]; // video, control/ENet, audio
export const MIC_OFFSET = 12; // microphone — off by default, only bridged if listening

export interface SunshinePorts {
  base: number;
  tcp: number[];
  udp: number[];
  source: 'conf' | 'probe' | 'default';
}

export interface PortsOpts {
  confPath: string;
  log: (l: string) => void;
  probe?: boolean; // set false in tests to skip network probing
}

export function sunshineConfPath(plat: Plat = currentPlat(), env: NodeJS.ProcessEnv = process.env): string {
  if (env.SUNSHINE_CONF) return env.SUNSHINE_CONF;
  const home = env.HOME || env.USERPROFILE || homedir();
  if (plat === 'win32') return path.join(env.PROGRAMFILES ?? 'C:\\Program Files', 'Sunshine', 'config', 'sunshine.conf');
  if (plat === 'darwin') return path.join(home, 'Library', 'Application Support', 'Sunshine', 'sunshine.conf');
  // An empty XDG_CONFIG_HOME means "unset" (the spec says use ~/.config), and
  // gluing it on blindly yields a relative path that points nowhere.
  const xdg = (env.XDG_CONFIG_HOME ?? '').trim();
  return path.join(xdg || path.join(home, '.config'), 'sunshine', 'sunshine.conf');
}

/** `port = 47989` (Sunshine's conf is `key = value`, one per line). */
export function parseSunshineConfPort(text: string): number | undefined {
  for (const raw of text.split('\n')) {
    const line = raw.replace(/[#;].*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^port\s*=\s*(\d+)\s*$/);
    if (m) {
      const p = Number(m[1]);
      if (p >= 1024 && p <= 65535 - MIC_OFFSET) return p;
    }
  }
  return undefined;
}

export function portsForBase(base: number, source: SunshinePorts['source'], includeMic = false): SunshinePorts {
  const tcp = TCP_OFFSETS.map((o) => base + o);
  const udp = UDP_OFFSETS.map((o) => base + o);
  if (includeMic) udp.push(base + MIC_OFFSET);
  return { base, tcp, udp, source };
}

function probeTcpBind(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    let done = false;
    const finish = (v: number | null) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    srv.once('error', () => finish(null));
    srv.listen(port, '127.0.0.1', () => {
      const addr = srv.address();
      const got = typeof addr === 'object' && addr ? addr.port : null;
      srv.close(() => finish(got));
    });
  });
}

function probeUdpBind(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = (v: number | null) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    sock.once('error', () => {
      try {
        sock.close();
      } catch {
        /* ignore */
      }
      finish(null);
    });
    sock.bind(port, '127.0.0.1', () => {
      const addr = sock.address();
      const got = typeof addr === 'object' && addr ? addr.port : null;
      try {
        sock.close();
      } catch {
        /* ignore */
      }
      finish(got);
    });
  });
}

function randomIn([lo, hi]: [number, number]): number {
  const span = Math.max(1, hi - lo + 1);
  return lo + Math.floor(Math.random() * span);
}

/**
 * A TCP port nobody is using.  With no range we let the OS choose (listen(0)),
 * release it, and hand it over — the caller then binds it immediately (and
 * retries on conflict, which is the only way to close the window completely).
 */
export async function pickFreeTcpPort(used: Set<number> = new Set(), range?: [number, number]): Promise<number> {
  const tried = new Set<number>();
  for (let attempt = 0; attempt < 64; attempt++) {
    let want = 0;
    if (range) {
      want = randomIn(range);
      if (used.has(want) || tried.has(want)) continue;
      tried.add(want);
    }
    const got = await probeTcpBind(want);
    if (got === null) continue;
    if (used.has(got)) continue;
    if (range && (got < range[0] || got > range[1])) continue;
    return got;
  }
  throw new Error('ports: could not find a free TCP port');
}

export async function pickFreeUdpPort(used: Set<number> = new Set()): Promise<number> {
  for (let attempt = 0; attempt < 64; attempt++) {
    const got = await probeUdpBind(0);
    if (got === null) continue;
    if (used.has(got)) continue;
    return got;
  }
  throw new Error('ports: could not find a free UDP port');
}

/* ── what the far side of the cable already has bound (§3.3) ────────────────
 *
 * Every port the tunnel hands out is bound twice: here and on the tablet (the
 * `adb reverse` listener, and the tablet-side relay's own socket).  A port that
 * is free on this machine can therefore still be taken on the device, where
 * `udp2tcp` just dies inside `bind()` — which surfaces as a channel that "did
 * not start" for no visible reason.  Android is Linux, so the same /proc/net
 * format answers the question: four small files, one `adb shell` round trip.
 */

export interface BusyPorts {
  tcp: Set<number>;
  udp: Set<number>;
}

/**
 * `up()` asks once per channel plus once for the probe, and nothing meaningfully
 * changes in between; a stale answer only ever costs one wasted attempt.
 */
export const BUSY_PORTS_TTL_MS = 2000;

/** POSIX sh on purpose: the tablet side is toybox sh, which has no fancy ideas. */
export const PROC_NET_SWEEP =
  'for f in udp udp6 tcp tcp6; do echo "@@$f"; cat /proc/net/$f 2>/dev/null; done';

/**
 * Reads the *local* port column of the four kernel tables.  Any socket at all
 * counts as busy, whatever its state or local address: being conservative costs
 * one extra attempt at most, while being clever about addresses would save
 * nothing and could miss a genuine collision.
 *
 * `null` means "this output is not the table we asked for" — the caller then
 * keeps its old behaviour instead of guessing that nothing is bound.
 */
export function parseProcNetPorts(text: string): BusyPorts | null {
  const tcp = new Set<number>();
  const udp = new Set<number>();
  let kind: 'tcp' | 'udp' | null = null;
  let sections = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const head = line.match(/^@@(udp|tcp)6?$/);
    if (head) {
      // The loop echoes all four names whether or not each file is readable, so
      // four markers is what "the sweep really ran" looks like.
      kind = head[1] === 'udp' ? 'udp' : 'tcp';
      sections++;
      continue;
    }
    if (!kind) continue;
    // `  0: 0100007F:1F90 00000000:0000 0A …` — column 1 is local_address
    // (IPv4: 8 hex chars, IPv6: 32), and the port is the part after the colon.
    const addr = line.split(/\s+/)[1] ?? '';
    const port = addr.slice(addr.lastIndexOf(':') + 1);
    if (!/^[0-9A-Fa-f]{1,4}$/.test(port)) continue;
    const n = parseInt(port, 16);
    if (n > 0) (kind === 'udp' ? udp : tcp).add(n);
  }
  return sections >= 4 ? { tcp, udp } : null;
}

/**
 * Asks the picker again while the far side says the port is taken.  `busy` is a
 * snapshot and `null`/absent means "could not ask": then the very first pick
 * stands, which is exactly the behaviour from before we could ask — a device
 * that will not answer can never make things worse.
 */
export async function pickAvoidingBusy(
  pick: (used: Set<number>) => Promise<number>,
  used: Set<number>,
  busy: Set<number> | null | undefined,
  tries = 5,
): Promise<number> {
  let got = 0;
  const attempts = Math.max(1, tries);
  for (let i = 0; i < attempts; i++) {
    got = await pick(used);
    if (!busy || !busy.has(got)) return got;
    // Remember the collision, or the next pick can hand the same port back.
    used.add(got);
  }
  return got;
}

export function tcpListening(port: number, host = '127.0.0.1', timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(v);
    };
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    sock.setTimeout(timeoutMs, () => finish(false));
  });
}

/**
 * Best-effort UDP listener scan.  Sunshine never answers an unsolicited probe
 * (§1), so the only honest way to know whether the microphone channel exists is to
 * ask the OS.  Returns null when we cannot tell — the caller then keeps the
 * default (mic off), which is Sunshine's own default.
 */
export async function udpListenerPorts(plat: Plat = currentPlat()): Promise<Set<number> | null> {
  const run = (cmd: string, args: string[]): Promise<string | null> =>
    new Promise((resolve) => {
      execFile(cmd, args, { maxBuffer: 4 << 20 }, (err, stdout) => resolve(err ? null : stdout));
    });

  const grab = (text: string): Set<number> => {
    const out = new Set<number>();
    for (const line of text.split('\n')) {
      const m = line.match(/:(\d{2,5})\b/);
      if (m) out.add(Number(m[1]));
    }
    return out;
  };

  if (plat === 'linux') {
    const out = await run('ss', ['-lunH']);
    return out === null ? null : grab(out);
  }
  if (plat === 'darwin') {
    const out = await run('netstat', ['-an', '-p', 'udp']);
    return out === null ? null : grab(out);
  }
  const out = await run('netstat', ['-ano', '-p', 'UDP']);
  return out === null ? null : grab(out);
}

/**
 * Sunshine's real ports: read the config, then trust what is actually listening
 * over what the config claims (§3.3 — when the two disagree, the port that is
 * actually listening wins).
 */
export async function detectSunshinePorts(o: PortsOpts): Promise<SunshinePorts> {
  let confBase: number | undefined;
  try {
    const text = await readFile(o.confPath, 'utf8');
    confBase = parseSunshineConfPort(text);
    o.log(
      confBase !== undefined
        ? `sunshine.conf: port = ${confBase} (${o.confPath})`
        : `sunshine.conf: no port override (${o.confPath})`,
    );
  } catch {
    o.log(`sunshine.conf not readable (${o.confPath}); using defaults`);
  }

  const candidates: Array<{ base: number; source: SunshinePorts['source'] }> = [];
  if (confBase !== undefined) candidates.push({ base: confBase, source: 'conf' });
  if (confBase !== DEFAULT_BASE) candidates.push({ base: DEFAULT_BASE, source: 'default' });

  if (o.probe !== false) {
    for (const c of candidates) {
      if (await tcpListening(c.base)) {
        o.log(`sunshine: HTTP port ${c.base} is listening (config said ${c.source})`);
        const mic = await micListening(c.base);
        return portsForBase(c.base, 'probe', mic);
      }
    }
  }

  if (confBase !== undefined) {
    o.log(`sunshine: nothing listening; going with the configured base ${confBase}`);
    return portsForBase(confBase, 'conf');
  }
  o.log(`sunshine: nothing listening; assuming the default base ${DEFAULT_BASE}`);
  return portsForBase(DEFAULT_BASE, 'default');
}

async function micListening(base: number): Promise<boolean> {
  const set = await udpListenerPorts();
  if (set === null) return false;
  return set.has(base + MIC_OFFSET);
}

export async function sunshineRunning(p: SunshinePorts): Promise<{ tcp: boolean }> {
  return { tcp: await tcpListening(p.base) };
}
