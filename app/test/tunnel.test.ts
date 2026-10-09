// tunnel.test.ts — the UDP probe with no tablet attached (§3.3, §13.3).
//
// `measure()` is the one piece of `up()` that can be driven end to end without a
// device: the echo pair, the host relay and the port picking are all local, and
// the tablet is only ever reached through adb — which the fixture stands in for.
// Throughput cannot be faked and this file does not pretend to: the number in the
// assertion comes from the stub.  What *can* be proved is the contract around the
// measurement: the tablet is asked which ports it already holds before one is
// handed out, the question is charged to adb once, the borrowed reverse is always
// given back, and a tablet that will not answer costs a measurement nothing.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Adb } from '../src/main/adb.js';
import { currentPlat } from '../src/main/platform.js';
import { writeState } from '../src/main/reap.js';
import { Tunnel, parseRelayProbe, tabletRelayProbe } from '../src/main/tunnel.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const stub = path.join(appRoot, 'test', 'fixtures', 'fake-adb.sh');
const posixOnly = process.platform === 'win32' ? 'needs the POSIX sh adb stub' : false;

/** Exactly what `udp2tcp --bench` prints (udp2tcp.c, the `[bench]` line). */
const BENCH = '[bench] round-trip goodput: 4 x 1024 B in 3.00s -> 103.1 Mbps (0.01 MB/s) payload, 0 odd-sized';

const KNOBS = ['ADB', 'FAKE_ADB_LOG', 'FAKE_ADB_SWEEP', 'FAKE_ADB_BENCH', 'FAKE_ADB_PID', 'FAKE_ADB_PS', 'FAKE_ADB_FULL'] as const;

interface Harness {
  dir: string;
  tunnel: Tunnel;
  logs: string[];
  /** Every command the app handed to adb, in order. */
  calls: () => string[];
  sweeps: () => string[];
  cleanup: () => void;
}

async function harness(o: { sweep?: string; bench?: string; pid?: string; ps?: string; full?: boolean } = {}): Promise<Harness> {
  if (process.platform !== 'win32' && existsSync(stub)) chmodSync(stub, 0o755);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ether-tunnel-'));
  const logFile = path.join(dir, 'adb-calls.log');
  writeFileSync(logFile, '');

  // Adb hands the ambient environment to the stub, so the knobs are set here
  // rather than through AdbOpts — and put back at the end, because the suite runs
  // its files in order rather than in isolated workers.
  const saved = new Map(KNOBS.map((k) => [k, process.env[k]]));
  process.env.ADB = stub;
  process.env.FAKE_ADB_LOG = logFile;
  process.env.FAKE_ADB_SWEEP = o.sweep ?? 'empty';
  process.env.FAKE_ADB_BENCH = o.bench ?? BENCH;
  process.env.FAKE_ADB_PID = o.pid ?? '4242';
  if (o.ps === undefined) delete process.env.FAKE_ADB_PS;
  else process.env.FAKE_ADB_PS = o.ps;
  if (o.full) process.env.FAKE_ADB_FULL = '1';
  else delete process.env.FAKE_ADB_FULL;

  const done = () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  };

  const logs: string[] = [];
  let adb: Adb;
  try {
    adb = await Adb.ensure({ plat: currentPlat(), env: process.env, dataDir: dir, log: (l) => logs.push(l) });
  } catch (e) {
    done();
    throw e;
  }
  const calls = () => readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
  return {
    dir,
    tunnel: new Tunnel({ adb, elfFor: () => '/nonexistent/udp2tcp', dataDir: dir, log: (l) => logs.push(l) }),
    logs,
    calls,
    sweeps: () => calls().filter((c) => c.includes('/proc/net/')),
    cleanup: done,
  };
}

test('measure() asks the tablet what it holds, once, and gives the reverse back', { skip: posixOnly }, async () => {
  const h = await harness({ sweep: 'busy' });
  try {
    const probe = await h.tunnel.measure({ seconds: 1, window: 1024 });

    assert.equal(probe.ok, true, probe.view);
    assert.equal(probe.back, 4);
    assert.equal(probe.frame, 1024);
    assert.equal(probe.odd, 0);
    assert.ok(Math.abs(probe.mbps - 103.1) < 0.05, `mbps ${probe.mbps}`);

    assert.equal(h.sweeps().length, 1, 'one adb round trip covers both port picks (§3.3)');
    assert.ok(
      h.logs.some((l) => l.includes('tablet holds 2 tcp / 3 udp ports')),
      `the tablet's own ports must be reported: ${h.logs.join('\n')}`,
    );

    const added = h.calls().filter((c) => c.startsWith('reverse tcp:'));
    assert.equal(added.length, 1, 'the probe borrows exactly one reverse');
    const port = (added[0] ?? '').split(' ')[1] ?? '';
    assert.ok(h.calls().includes(`reverse --remove ${port}`), `the borrowed reverse must be given back: ${port}`);
  } finally {
    h.cleanup();
  }
});

test('a tablet that refuses /proc/net still gets a measurement (§3.3 fallback)', { skip: posixOnly }, async () => {
  const h = await harness({ sweep: 'fail' });
  try {
    const probe = await h.tunnel.measure({ seconds: 1, window: 1024 });
    assert.equal(probe.ok, true, probe.view);
    assert.equal(h.sweeps().length, 1, 'a failed sweep is not retried by every port pick');
    assert.ok(
      h.logs.some((l) => l.includes('tablet port sweep failed')),
      `the fallback has to be visible in the log: ${h.logs.join('\n')}`,
    );
    assert.equal(h.calls().filter((c) => c.startsWith('reverse tcp:')).length, 1);
  } finally {
    h.cleanup();
  }
});

test('an unparsable bench still tears the probe down and says so', { skip: posixOnly }, async () => {
  const h = await harness({ bench: '' });
  try {
    const probe = await h.tunnel.measure({ seconds: 1, window: 1024 });
    assert.equal(probe.ok, false);
    assert.ok(h.logs.some((l) => l.includes('UDP probe unparsable')), h.logs.join('\n'));
    // The teardown is a `finally`: a measurement that produced no number must not
    // leave the borrowed reverse behind, which is exactly the residue §13.9 M2
    // looks for after a kill.
    const added = h.calls().filter((c) => c.startsWith('reverse tcp:'));
    assert.equal(added.length, 1);
    const port = (added[0] ?? '').split(' ')[1] ?? '';
    assert.ok(h.calls().includes(`reverse --remove ${port}`), `reverse left behind: ${port}`);
  } finally {
    h.cleanup();
  }
});

/**
 * A live tunnel relay and a stray one are indistinguishable on the command line
 * — both are `udp2tcp --device --udp-listen … --tcp-connect …`.  The probe's
 * teardown therefore may not sweep: on the reference tablet (2026-10-07) the
 * sweep took the three channel relays with it, and `--state` went on saying `up`
 * over a dead tablet side.  `down()` still sweeps on purpose (next test).
 */
const LIVE_RELAY = '9999 udp2tcp --device --udp-listen 127.0.0.1:47998 --tcp-connect 127.0.0.1:33749';

test('the probe kills its own relay and leaves the tunnel’s alone', { skip: posixOnly }, async () => {
  const h = await harness({ full: true, ps: LIVE_RELAY });
  try {
    const probe = await h.tunnel.measure({ seconds: 1, window: 1024 });
    assert.equal(probe.ok, true, probe.view);

    // Its own relay is still reaped: `FAKE_ADB_FULL` is what makes the stub
    // answer the cmdline question, so the pid path is the one under test.
    assert.ok(
      h.calls().some((c) => c.includes('kill 4242 2>/dev/null')),
      `probe relay left behind: ${h.calls().join(' | ')}`,
    );
    assert.ok(!h.calls().some((c) => c.includes('kill 9999')), `the tunnel relay was killed: ${h.calls().join(' | ')}`);
    assert.ok(
      !h.calls().some((c) => c.includes('ps -A')),
      'the probe queried the process table: that is the sweep that killed the tunnel (use sweep: false)',
    );
  } finally {
    h.cleanup();
  }
});

test('down() still sweeps a stray relay the record never named', { skip: posixOnly }, async () => {
  const h = await harness({ ps: LIVE_RELAY });
  try {
    // A recorded port is what a `kill -9`ed app leaves behind; it is also the
    // reason `down()` runs the sweep at all (§13.9 M2 idempotency).
    await writeState(h.dir, {
      pid: 0,
      startedAt: new Date(0).toISOString(),
      serial: 'HA2HS0KT',
      tcpPorts: [47984],
      udpTunnels: [],
      hostPids: [],
      elfRemote: '/data/local/tmp/udp2tcp',
    });
    await h.tunnel.down();
    assert.ok(h.calls().some((c) => c.includes('kill 9999')), `stray survived down(): ${h.calls().join(' | ')}`);
  } finally {
    h.cleanup();
  }
});

/**
 * The watchdog's tablet check, end to end minus the wait: the probe is one `adb
 * shell` for every relay, and only a negated pid counts as evidence of a dead
 * one.  A silent device, an error line or a stray word must not be read as "the
 * relay is gone" — that would turn a healthy tunnel "degraded" on a hiccup.
 */
test('the tablet relay probe asks about every pid in one round trip', () => {
  assert.equal(
    tabletRelayProbe([13860, 13865]),
    'kill -0 13860 2>/dev/null && echo 13860 || echo -13860; ' +
      'kill -0 13865 2>/dev/null && echo 13865 || echo -13865',
  );
  assert.equal(tabletRelayProbe([]), '');
});

test('only a negated pid is read back as a dead relay', () => {
  assert.deepEqual(parseRelayProbe('13860\n-13865\n'), [13865]);
  assert.deepEqual(parseRelayProbe('13860\n13865\n'), [], 'both alive: nothing to report');
  assert.deepEqual(parseRelayProbe(''), [], 'no answer is not an answer');
  assert.deepEqual(parseRelayProbe('yes\n'), [], 'a word is not a pid');
});

/**
 * A watchdog round with nothing to report must still push a status.
 *
 * The window is push-only (`onState` plus one `state()` at boot) and the tunnel
 * otherwise speaks only on transitions, so the relay counters under Details →
 * Counters stayed at the zeros `up()` sent: at that instant no client has
 * streamed, and `measure()` cannot fill them in — it counts through a relay of
 * its own.  The 2 s beat is therefore part of the contract, not an optimisation.
 * The second half is the other edge: an idle tunnel runs no watchdog at all, and
 * a round that happens anyway must stay silent.
 */
test('a healthy watchdog round still pushes a status', { skip: posixOnly }, async () => {
  const h = await harness();
  try {
    const inner = h.tunnel as unknown as { st: { state: string }; tick: () => Promise<void> };
    let pushes = 0;
    h.tunnel.onChange(() => pushes++);

    inner.st.state = 'up';
    await inner.tick();
    assert.equal(pushes, 1, 'a quiet round is exactly the one the counters need to hear about');

    inner.st.state = 'idle';
    await inner.tick();
    assert.equal(pushes, 1, 'the beat is for a live link only; it must not start polling the tablet');
  } finally {
    h.cleanup();
  }
});
