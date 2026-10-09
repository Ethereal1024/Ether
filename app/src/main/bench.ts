// bench.ts — round-trip goodput measurement, ported from udp2tcp.c 675-736.
//
// Two pieces:
//   runBench()            the windowed sender (C: `--bench ADDR --seconds N`)
//   startLoopbackChain()  echo + host relay + device relay wired on 127.0.0.1
//
// The chain is how the Node relay is proven against the C implementation with
// no tablet in sight (§13.4 #5, #10): the same four phases the C self-test uses
// run through a Node host relay on one side and the C device relay on the other.

import { spawn, type ChildProcess } from 'node:child_process';
import dgram from 'node:dgram';
import { UDP_BENCH_RCVBUF, isRetryableUdpError, startDeviceRelay, startHostRelay, startUdpEcho, type Relay, type RelayStats } from './relay.js';
import { pickFreeTcpPort, pickFreeUdpPort } from './ports.js';

export interface BenchResult {
  back: number;
  frame: number;
  seconds: number;
  mbps: number;
  odd: number;
  silence: boolean;
}

export interface BenchOpts {
  host: string;
  port: number;
  seconds?: number;
  frame?: number;
  window?: number;
}

/**
 * A windowed sender, so the bounded queues never tail-drop on purpose: the
 * number it reports is what a real Moonlight stream can actually fit through.
 */
export function runBench(o: BenchOpts): Promise<BenchResult> {
  const frame = o.frame ?? 1200;
  const win = o.window ?? 1024;
  const seconds = o.seconds ?? 10;

  return new Promise<BenchResult>((resolve) => {
    const sock = dgram.createSocket('udp4');

    let back = 0;
    let odd = 0;
    let silence = false;
    let done = false;
    let last = Date.now();
    let t0 = Date.now();

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(dur);
      clearInterval(watch);
      try {
        sock.close();
      } catch {
        /* ignore */
      }
      const dt = Math.max(0.001, (Date.now() - t0) / 1000);
      resolve({
        back,
        frame,
        seconds: dt,
        mbps: (back * frame * 8) / dt / 1e6,
        odd,
        silence,
      });
    };

    const dur = setTimeout(finish, seconds * 1000);
    const watch = setInterval(() => {
      if (Date.now() - last > 2000) {
        silence = true;
        finish();
      }
    }, 250);

    sock.on('error', (err) => {
      if (isRetryableUdpError(err)) return;
      finish();
    });

    sock.on('message', (msg) => {
      last = Date.now();
      if (msg.length === frame) {
        back++;
        sock.send(msg, o.port, o.host, () => {});
      } else {
        odd++;
      }
      if (Date.now() - t0 >= seconds * 1000) finish();
    });

    sock.bind(0, () => {
      // After bind: an unbound dgram socket has no fd, so a buffer call before this
      // point throws EBADF and the window of §13.9 would be measured with a stock
      // (small) receive buffer, i.e. the number would be the kernel's, not the link's.
      try {
        sock.setRecvBufferSize(UDP_BENCH_RCVBUF);
      } catch {
        /* not fatal: the OS may cap it */
      }
      t0 = Date.now();
      last = t0;
      const seed = Buffer.allocUnsafe(frame);
      for (let i = 0; i < win; i++) {
        seed.writeUInt32LE(i >>> 0, 0);
        sock.send(seed, o.port, o.host, () => {});
      }
    });
  });
}

// ----------------------------------------------------------- loopback chain

export type Impl = 'node' | 'c';

export interface ChainOpts {
  hostImpl?: Impl;
  deviceImpl?: Impl;
  echoImpl?: Impl;
  cBin?: string;
  log?: (l: string) => void;
}

export interface Chain {
  /** The port the client sends to (where the device-side relay listens). */
  udpPort: number;
  hostStats(): RelayStats;
  deviceStats(): RelayStats;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Spawn the C relay and wait until it announces itself on stderr. */
async function spawnC(
  bin: string,
  args: string[],
  ready: RegExp,
  log: (l: string) => void,
  timeoutMs = 4000,
): Promise<{ child: ChildProcess; stop: () => void }> {
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  const readyPromise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${bin} ${args.join(' ')}`)), timeoutMs);
    child.stderr.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      log(`[c] ${chunk.toString('utf8').trim()}`);
      if (ready.test(buf)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${bin} exited early (${code})`));
    });
  });
  await readyPromise;
  return {
    child,
    stop: () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      // A C relay that ignores SIGTERM would keep this process's event loop alive
      // (its stdio pipes stay open), so the test runner would never print its
      // summary.  Escalate, unref'd so the timer itself can never hold us up.
      const t = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 500);
      t.unref();
      child.once('exit', () => clearTimeout(t));
    },
  };
}

/**
 * Wire an echo endpoint, a host relay and a device relay on 127.0.0.1, all
 * through the same wire format the real tunnel uses.  Anything can be the C
 * implementation, which is what makes it an interop test rather than a unit test.
 */
export async function startLoopbackChain(opts: ChainOpts = {}): Promise<Chain> {
  const log = opts.log ?? (() => {});
  const hostImpl = opts.hostImpl ?? 'node';
  const deviceImpl = opts.deviceImpl ?? 'node';
  const echoImpl = opts.echoImpl ?? 'node';
  const cBin = opts.cBin;
  const needC = [hostImpl, deviceImpl, echoImpl].includes('c');
  if (needC && !cBin) throw new Error('startLoopbackChain: cBin is required for the "c" implementation');

  const closers: Array<() => void> = [];
  const relays: Relay[] = [];
  let hostStats: () => RelayStats = () => ({ datagrams: 0, bytes: 0, dropped: 0, peers: 0 });
  let deviceStats: () => RelayStats = hostStats;

  /** Tear down whatever the wiring got as far as starting. */
  const abandon = async (): Promise<void> => {
    for (const r of relays) {
      try {
        await r.close();
      } catch {
        /* ignore */
      }
    }
    for (const c of closers) c();
    await sleep(150);
  };

  try {
    const udpPort = await pickFreeUdpPort();
    const tcpPort = await pickFreeTcpPort();
    // The echo is Sunshine's stand-in and needs a port of its own: udpPort belongs
    // to the device relay and tcpPort is the relay hop — two UDP endpoints cannot
    // share one port, and silently reusing it is what makes the chain mask a wire
    // bug.  Node lets the kernel choose (no release-then-bind race); the C echo
    // needs a concrete number, so it gets a probed one.
    const echoWanted = echoImpl === 'node' ? 0 : await pickFreeUdpPort();

    // 1) echo endpoint (stands in for Sunshine)
    let echoPort: number;
    if (echoImpl === 'node') {
      const echo = await startUdpEcho(echoWanted);
      echoPort = echo.port;
      relays.push(echo);
    } else {
      const h = await spawnC(cBin!, ['--echo', `127.0.0.1:${echoWanted}`], /\[echo\] udp/, log);
      echoPort = echoWanted;
      closers.push(h.stop);
    }

    // 2) host relay: TCP listener -> UDP echo
    if (hostImpl === 'node') {
      const r = await startHostRelay({ tcpListen: tcpPort, udpConnect: { host: '127.0.0.1', port: echoPort }, onLog: log });
      relays.push(r);
      hostStats = () => r.stats();
    } else {
      const h = await spawnC(
        cBin!,
        ['--host', '--tcp-listen', `127.0.0.1:${tcpPort}`, '--udp-connect', `127.0.0.1:${echoPort}`],
        /\[host\] tcp/,
        log,
      );
      closers.push(h.stop);
    }

    // 3) device relay: UDP listener -> TCP into the host relay
    if (deviceImpl === 'node') {
      const r = await startDeviceRelay({ udpListen: udpPort, tcpConnect: tcpPort, onLog: log });
      relays.push(r);
      deviceStats = () => r.stats();
    } else {
      const h = await spawnC(
        cBin!,
        ['--device', '--udp-listen', `127.0.0.1:${udpPort}`, '--tcp-connect', `127.0.0.1:${tcpPort}`],
        /\[device\] udp/,
        log,
      );
      closers.push(h.stop);
    }

    await sleep(80);

    return {
      udpPort,
      hostStats,
      deviceStats,
      close: abandon,
    };
  } catch (e) {
    // A half-wired chain can leave a C relay running, and that orphan would hold
    // this process's event loop (its stdio pipes) open forever — the suite would
    // never print its summary (§13.9).  Clean up before reporting the failure.
    await abandon();
    throw e;
  }
}
