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

const KNOBS = ['ADB', 'FAKE_ADB_LOG', 'FAKE_ADB_SWEEP', 'FAKE_ADB_BENCH', 'FAKE_ADB_PID', 'FAKE_ADB_PS', 'FAKE_ADB_FULL', 'FAKE_ADB_STATE'] as const;

interface Harness {
  dir: string;
  tunnel: Tunnel;
  logs: string[];
  /** Every command the app handed to adb, in order. */
  calls: () => string[];
  sweeps: () => string[];
  cleanup: () => void;
}

async function harness(
  o: { sweep?: string; bench?: string; pid?: string; ps?: string; full?: boolean; reverses?: number[]; onLog?: (l: string) => void } = {},
): Promise<Harness> {
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
  // FAKE_ADB_STATE seeds the stub's reverse ledger (the stub keeps `adb reverse`
  // in a file when it is set), which is how a watchdog round can be driven
  // against a table that is intact, or one the adb server has forgotten.
  if (o.reverses === undefined) delete process.env.FAKE_ADB_STATE;
  else {
    const ledger = path.join(dir, 'adb-reverses');
    writeFileSync(ledger, o.reverses.map((p) => `${p}\n`).join(''));
    process.env.FAKE_ADB_STATE = ledger;
  }

  const done = () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  };

  const logs: string[] = [];
  const log = (l: string) => {
    logs.push(l);
    o.onLog?.(l);
  };
  let adb: Adb;
  try {
    adb = await Adb.ensure({ plat: currentPlat(), env: process.env, dataDir: dir, log });
  } catch (e) {
    done();
    throw e;
  }
  const calls = () => readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
  return {
    dir,
    tunnel: new Tunnel({ adb, elfFor: () => '/nonexistent/udp2tcp', dataDir: dir, log }),
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

/** One watchdog round, driven at the point the two liveness checks cannot see. */
type Round = { st: { state: string; tcpMap: Array<[number, number]>; udpMap: Array<[number, number]> }; tick: () => Promise<void> };

/**
 * The reverse table is the one leg of the bridge with nothing behind it: the
 * entries live in the adb *server*, `up()` writes each of them once, and a
 * server restart (the case `Adb.conflict` warns about) or a USB re-enumeration
 * empties the table while `adb devices` goes on reporting the device as
 * `device`.  Everything else the watchdog looked at survived that — the host
 * relay keeps its listen socket, the tablet relay keeps running (its peer is
 * freed, `udp2tcp.c`'s loop is not), and the three TCP channels never had a
 * process at all — so the window said `up` over a bridge that could not carry a
 * packet.  That is the 2026-10-10 report: the stream dies with no error, and
 * only a reconnect (which runs `up()` again) brings it back.
 *
 * One `adb reverse --list` per round is a call to the local adb server, not to
 * the device, so unlike the tablet probe it can afford to run every 2 s.
 */
test('a reverse the adb server forgot is re-added, and the round says so', { skip: posixOnly }, async () => {
  const h = await harness({ reverses: [47989] });
  try {
    const inner = h.tunnel as unknown as Round;
    let pushes = 0;
    h.tunnel.onChange(() => pushes++);
    inner.st.state = 'up';
    inner.st.tcpMap = [
      [47984, 47984],
      [47989, 47989],
    ];

    await inner.tick();

    assert.ok(
      h.calls().includes('reverse tcp:47984 tcp:47984'),
      `the lost reverse was not re-added: ${h.calls().join(' | ')}`,
    );
    assert.ok(
      !h.calls().includes('reverse tcp:47989 tcp:47989'),
      `a reverse that is still in the table must be left alone: ${h.calls().join(' | ')}`,
    );
    assert.equal(h.tunnel.status().state, 'degraded', 'a bridge missing a reverse cannot still read "up"');
    assert.ok(h.logs.some((l) => l.includes('adb reverse(s) gone: 47984')), h.logs.join('\n'));
    assert.equal(pushes, 2, 'the downgrade goes out on its own push, and the round still beats once');
  } finally {
    h.cleanup();
  }
});

test('a reverse table that is intact is only read, never written', { skip: posixOnly }, async () => {
  const h = await harness({ reverses: [47984, 47989] });
  try {
    const inner = h.tunnel as unknown as Round;
    inner.st.state = 'up';
    inner.st.tcpMap = [
      [47984, 47984],
      [47989, 47989],
    ];

    await inner.tick();

    assert.deepEqual(
      h.calls().filter((c) => c.startsWith('reverse')),
      ['reverse --list'],
      'a healthy round must not touch the table',
    );
    assert.equal(h.tunnel.status().state, 'up', 'nothing was wrong: the state must not move');
    assert.ok(!h.logs.some((l) => l.includes('re-adding')), h.logs.join('\n'));
  } finally {
    h.cleanup();
  }
});

test('a table that will not confirm the re-add never downgrades the link', { skip: posixOnly }, async () => {
  // The one rule every check in this watchdog obeys: no answer is not an answer.
  // Here the server answers, but with a table that none of the re-added entries
  // ever show up in (the stub without a ledger behaves exactly like that, and so
  // does an adb whose `--list` this parser does not know).  That is not evidence
  // of a lost reverse: re-adding is a no-op and the round must end where it
  // started rather than put "needs attention" on a link that may be fine.
  const h = await harness();
  try {
    const inner = h.tunnel as unknown as Round;
    let pushes = 0;
    h.tunnel.onChange(() => pushes++);
    inner.st.state = 'up';
    inner.st.tcpMap = [
      [47984, 47984],
      [47989, 47989],
    ];

    await inner.tick();

    assert.equal(
      h.calls().filter((c) => c === 'reverse --list').length,
      2,
      `the round must read the table again before believing it: ${h.calls().join(' | ')}`,
    );
    assert.ok(
      h.calls().includes('reverse tcp:47984 tcp:47984') && h.calls().includes('reverse tcp:47989 tcp:47989'),
      `a port the table does not list is re-added anyway (it rebinds harmlessly): ${h.calls().join(' | ')}`,
    );
    assert.equal(h.tunnel.status().state, 'up', 'an unconfirmed read is not proof that the table was lost');
    assert.ok(!h.logs.some((l) => l.includes('could not be re-added')), h.logs.join('\n'));
    // The beat still happens (the counters need it), but nothing was announced.
    assert.equal(pushes, 1, 'the round is still exactly one push');
  } finally {
    h.cleanup();
  }
});

/**
 * "Never leave anything behind" is the rule the whole house is built on
 * (reap.ts), and the reverse table is where a watchdog round could break it: the
 * round asks the server, and if the user pressed Stop in between, the answer
 * describes a table `down()` has already cleared.  Putting that answer back
 * would leave a stray reverse pointing at a closed port — exactly the residue
 * §13.9 M2 counts.  The round therefore carries the epoch it started in and
 * stops the moment a teardown moves it.
 */
test('a teardown mid-round is not re-armed by the round that was in flight', { skip: posixOnly }, async () => {
  let teardown: Promise<unknown> | undefined;
  let tunnel: Tunnel | undefined;
  const h = await harness({
    reverses: [47989],
    onLog: (l) => {
      // The round has just decided the table lost a port; the user presses Stop.
      if (l.includes('re-adding')) teardown = tunnel?.down();
    },
  });
  tunnel = h.tunnel;
  try {
    const inner = h.tunnel as unknown as Round;
    inner.st.state = 'up';
    inner.st.tcpMap = [
      [47984, 47984],
      [47989, 47989],
    ];

    await inner.tick();
    assert.ok(teardown, 'the round never noticed the lost reverse at all');
    await teardown;

    assert.ok(
      !h.calls().some((c) => c.startsWith('reverse tcp:')),
      `a reverse was re-added after the teardown had cleared the table: ${h.calls().join(' | ')}`,
    );
    assert.ok(h.logs.some((l) => l.includes('adb reverse(s) gone: 47984')), h.logs.join('\n'));
    assert.equal(h.tunnel.status().state, 'idle', 'the teardown owns the state it asked for');
  } finally {
    h.cleanup();
  }
});
