// autoconnect.test.ts — the launch this fix is about, driven for real.
//
// The unit tests in startup.test.ts prove the decision and the state machine in the
// abstract; what they cannot prove is that the machine is *wired* to anything: that
// `Controller.refresh()` publishes the status the attempt reads, that a device which
// appears later shows up in it, and that the dial reaches `Controller.up()`.  This file
// wires the two exactly as `index.ts` does — the controller's status callback *is* the
// attempt's input — and stages the boot order the user hit: the app is up, the bus is
// empty, and the tablet answers a moment later.
//
// Nothing here is Electron: the controller, the fixture adb and the decision are all
// plain Node, which is why a bug that only ever appeared after a login can be rehearsed
// in CI at all.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Controller, type Status } from '../src/main/controller.js';
import { currentPlat } from '../src/main/platform.js';
import { detectSunshinePorts, sunshineConfPath, sunshineRunning } from '../src/main/ports.js';
import { AutoConnectAttempt, type Settings } from '../src/main/startup.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const stub = path.join(appRoot, 'test', 'fixtures', 'fake-adb.sh');
const relay = process.env.ETHER_C_BIN ?? path.join(appRoot, '..', 'c-relay', 'udp2tcp');
const posixOnly = process.platform === 'win32' ? 'needs the POSIX sh adb stub' : false;

/**
 * Can *this* machine carry a link all the way up?  Two of the tunnel's own
 * preconditions are facts about the host rather than about the fixture — the host relay
 * binary has to have been built (`c-relay/build.sh`), and Sunshine has to be listening —
 * so the test asks exactly the questions the tunnel asks and keeps its strongest
 * assertion for the machine that can answer them.  The dial itself needs neither.
 */
async function linkIsRaisableHere(): Promise<boolean> {
  if (!existsSync(relay)) return false;
  const ports = await detectSunshinePorts({ confPath: sunshineConfPath(currentPlat(), process.env), log: () => undefined });
  return (await sunshineRunning(ports)).tcp;
}

const ON: Settings = { autoConnect: true, keepRunning: true };
/** The one bench line the stub prints (`udp2tcp.c`). */
const BENCH = '[bench] round-trip goodput: 4 x 1024 B in 3.00s -> 103.1 Mbps (0.01 MB/s) payload, 0 odd-sized';

/**
 * The stub is handed the *ambient* environment (`Adb.run` spawns without an `env`, the
 * same way the tunnel suite drives it), so these are patched in `process.env` and put
 * back afterwards — the suite runs its files in order rather than in isolated workers.
 */
const KNOBS = ['ADB', 'FAKE_ADB_MODE', 'FAKE_ADB_FULL', 'FAKE_ADB_STATE', 'FAKE_ADB_BENCH', 'SUNSHINE_CONF'] as const;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(fn: () => boolean, ms = 8000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return true;
    await sleep(50);
  }
  return false;
}

/**
 * Sunshine, as far as the app can tell.
 *
 * Every test below ends in a dial, and a dial is only ever taken from an `idle` status:
 * while nothing answers the streaming service's HTTP port the controller reports
 * `error`/`noSunshine`, and auto-connect deliberately waits through that — the state is a
 * fact about the PC rather than about the cable, and it turns into `idle` by itself the
 * moment the service comes up.  A CI runner has no Sunshine installed, so a test that
 * wants the dial must answer that one question itself: a listener on a port we own,
 * named by the conf file the app reads anyway (`SUNSHINE_CONF`, the same knob a user's
 * own Sunshine config pulls through, and the only way to say "the service is on this
 * port" without one installed).  Nothing else is faked, because nothing else is asked —
 * the listener speaks no protocol, it only answers the port probe.
 *
 * Returns the way to give the port back; `SUNSHINE_CONF` is restored with the knobs
 * above, which is why it is one of them.
 */
async function fakeSunshine(dir: string): Promise<() => Promise<void>> {
  const srv = net.createServer((s) => s.end());
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as net.AddressInfo).port;
  writeFileSync(path.join(dir, 'sunshine.conf'), `port = ${port}\n`);
  process.env.SUNSHINE_CONF = path.join(dir, 'sunshine.conf');
  return () =>
    new Promise<void>((r) => {
      srv.close(() => r());
    });
}

test('an app that starts before the tablet waits, then dials by itself', { skip: posixOnly }, async () => {
  if (existsSync(stub)) chmodSync(stub, 0o755);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ether-autoconnect-'));
  const ledger = path.join(dir, 'adb-reverses');
  writeFileSync(ledger, '');

  const saved = new Map(KNOBS.map((k) => [k, process.env[k]]));
  process.env.ADB = stub;
  process.env.FAKE_ADB_MODE = 'none'; // the start of the story: no device on the bus
  process.env.FAKE_ADB_STATE = ledger;
  process.env.FAKE_ADB_BENCH = BENCH;
  delete process.env.FAKE_ADB_FULL;

  const log: string[] = [];
  let pushes = 0;
  let dials = 0;
  let atDial: Status | undefined;
  let c: Controller | undefined;
  const raisable = await linkIsRaisableHere();
  // Measured against the real machine just above, so the strongest assertion below still
  // only runs where a link can genuinely come up.  Sunshine itself is answered for, so
  // that the dial — the thing this file is about — happens on every machine.
  const giveSunshineBack = await fakeSunshine(dir);
  try {
    c = await Controller.create({
      dataDir: dir,
      resourcesDir: path.join(appRoot, 'resources'),
      skipReap: true,
      log: (l) => log.push(l),
    });

    // The launch: the app is up, the cable is not answering yet.
    assert.equal(c.status().state, 'idle', log.join('\n'));
    assert.equal(c.status().device, undefined, 'no device at this point in the story');

    const attempt = new AutoConnectAttempt({
      settings: () => ON,
      // Exactly what `index.ts` passes: the poll asks the controller, and the status it
      // publishes comes back through the callback below.
      refresh: async () => {
        await c?.refresh();
      },
      dial: async () => {
        dials += 1;
        atDial = c?.status();
        await c?.up();
      },
      provision: async () => {
        await c?.ensureAdb();
      },
      log: (l) => log.push(l),
      intervalMs: 25,
      provisionEveryMs: 60_000,
    });
    // `index.ts`'s `push()`: every status the controller emits is fed to the attempt.
    c.onChange((s) => {
      pushes += 1;
      attempt.step(s);
    });

    attempt.arm();
    attempt.step(c.status()); // the push at the end of the launch block

    // Waiting, and *asking again*: nothing else would ever wake an idle app, and this is
    // the bug the user hit — the attempt stayed armed and was never spoken to again.
    await sleep(250);
    assert.equal(attempt.pending, true, 'no device yet is not an answer');
    assert.equal(dials, 0, 'nothing to dial yet');
    assert.ok(pushes > 1, `the bus must be re-read while waiting, saw ${pushes} status${pushes === 1 ? '' : 'es'}`);

    // The tablet finishes booting and the user taps Allow.  Nothing else happens.
    process.env.FAKE_ADB_MODE = 'ok';
    process.env.FAKE_ADB_FULL = '1';

    assert.ok(await waitFor(() => dials > 0), `no dial without a press: ${log.join('\n')}`);
    assert.equal(dials, 1, 'exactly one dial');
    assert.equal(atDial?.device?.state, 'device', 'the dial must be the one with a usable device behind it');
    // Over when the dial *answered*, not the moment it was taken: the wait holds while the
    // link is being raised (that is what the button reads as "working…"), so `dials` going
    // up is the dial starting, and `pending` is what says it came back.
    assert.ok(await waitFor(() => !attempt.pending), `the attempt is over once its dial answered: ${log.join('\n')}`);
    assert.ok(
      log.includes('[app] auto-connect: the device is ready, starting the wired link'),
      `the ready line must be logged: ${log.join('\n')}`,
    );

    // The dial reached the tunnel: `up()` says `checking` the moment it is called, so
    // this is the link being raised, not a call that went nowhere.
    assert.ok(await waitFor(() => c?.status().state !== 'idle'), 'the dial must reach the tunnel');

    if (raisable) {
      // And on a machine that can carry it the whole way (the host relay built, Sunshine
      // listening — the tunnel's own preconditions, not this test's), the link is *up*:
      // the app connected itself.  On a machine without them the tunnel stops at its own
      // refusal, which is not what this file is testing.
      const up = await waitFor(() => c?.status().state === 'up', 10_000);
      assert.ok(up, `the link must come up on its own: ${log.slice(-5).join('\n')}`);
    }
  } finally {
    await giveSunshineBack();
    await c?.down().catch(() => undefined);
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the adb server pushing the device list is what dials, with no tick in sight', { skip: posixOnly }, async () => {
  // The same launch as the first test, except that the machine has an event source and
  // the tick is set an hour away.  Anything that happens below therefore happens because
  // the bus spoke and for no other reason: this is the answer to "does waiting have to
  // cost a subprocess every two seconds?" — it does not, when the adb server will push.
  if (existsSync(stub)) chmodSync(stub, 0o755);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ether-autoconnect-watch-'));
  const ledger = path.join(dir, 'adb-reverses');
  writeFileSync(ledger, '');

  const saved = new Map(KNOBS.map((k) => [k, process.env[k]]));
  process.env.ADB = stub;
  process.env.FAKE_ADB_MODE = 'none'; // the app is up, the tablet is not
  process.env.FAKE_ADB_STATE = ledger;
  process.env.FAKE_ADB_BENCH = BENCH;
  delete process.env.FAKE_ADB_FULL;

  const log: string[] = [];
  let pushes = 0;
  let dials = 0;
  let attaches = 0;
  let detaches = 0;
  /** What `index.ts` holds: the one live watch, and the way the attempt talks to it. */
  let speaker: ((live: boolean) => void) | undefined;
  let c: Controller | undefined;
  // Sunshine answered for, so that the pushed event lands on an `idle` status and the
  // dial below is a dial and not a `noSunshine` wait — the same reason the first test has it.
  const giveSunshineBack = await fakeSunshine(dir);
  try {
    c = await Controller.create({
      dataDir: dir,
      resourcesDir: path.join(appRoot, 'resources'),
      skipReap: true,
      log: (l) => log.push(l),
    });

    const attempt = new AutoConnectAttempt({
      settings: () => ON,
      refresh: async () => {
        await c?.refresh();
      },
      dial: async () => {
        dials += 1;
        await c?.up();
      },
      // `index.ts`'s watch: attached once, and the callback is kept so the test can be
      // the adb server.
      watch: (cb) => {
        attaches += 1;
        speaker = cb;
        return () => {
          detaches += 1;
          speaker = undefined;
        };
      },
      log: (l) => log.push(l),
      intervalMs: 3_600_000, // a tick that will not fire: the stream has to do the work
      safetyMs: 3_600_000,
      provisionEveryMs: 60_000,
    });
    c.onChange((s) => {
      pushes += 1;
      attempt.step(s);
    });

    attempt.arm();
    attempt.step(c.status()); // the push at the end of the launch block
    assert.equal(attaches, 1, 'waiting attaches to the bus exactly once');

    // The bus says it is live — its device list is being pushed to us — and nothing else
    // is coming.  Waiting on a stream is not asking the machine anything.
    speaker?.(true);
    await sleep(200);
    assert.equal(pushes, 1, `no tick, no question: ${pushes} status${pushes === 1 ? '' : 'es'}`);
    assert.equal(dials, 0, log.join('\n'));

    // The tablet finishes booting and the user taps Allow.  The adb server's list changes,
    // the socket carries it to us *without anyone asking*, and that is the whole wake-up.
    process.env.FAKE_ADB_MODE = 'ok';
    process.env.FAKE_ADB_FULL = '1';
    speaker?.(true);

    assert.ok(await waitFor(() => dials > 0), `the push must dial without a poll: ${log.join('\n')}`);
    assert.equal(dials, 1, 'exactly one dial, from an event and not from a timer');
    assert.ok(
      log.includes('[app] auto-connect: the device is ready, starting the wired link'),
      `the ready line must be logged: ${log.join('\n')}`,
    );

    // Over means detached: the attempt does not hold a socket to the adb server open for
    // the rest of the session.  When the dial answers and not when it is taken — the very
    // same timing the first test asserts on `pending`.
    assert.ok(await waitFor(() => detaches === 1), `the stream is given back when there is nothing left to wait for: ${log.join('\n')}`);
  } finally {
    await giveSunshineBack();
    await c?.down().catch(() => undefined);
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a press that could not dial leaves the wait standing, and the tablet still gets dialled for', { skip: posixOnly }, async () => {
  // The user's own order of events, and the reason a ticked switch looked dead.  They
  // opened the app with the cable still in the drawer and pressed the one button on the
  // card — "Start wired link" — before the tablet was there.  The press fails honestly
  // ("no USB device"); what it must *not* be is a change of mind, and it used to be: the
  // verb cancelled the launch's request outright, so an app whose user pressed the button
  // once waited for nothing for the rest of the session.  Worse, the refusal outlived its
  // cause: the tunnel keeps `error` until something resets it, `shouldAutoConnect` only
  // dials from `idle`, and the card went on saying "No USB device" while the device row
  // already showed the tablet.
  //
  // So this test is the shell's press sequence verbatim, twice over: `index.ts`'s
  // `onUserVerb('start')` (only `stop` withdraws, see `withdrawsAutoConnect`) and its
  // `startLink()` — `ensureAdb()`, `up()`, `resync()`.  The assertions are the two things
  // the user's report was about: the card is the bus again after the failed press, and the
  // armed attempt still dials when the tablet finally answers.
  if (existsSync(stub)) chmodSync(stub, 0o755);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ether-autoconnect-press-'));
  writeFileSync(path.join(dir, 'adb-reverses'), '');

  const saved = new Map(KNOBS.map((k) => [k, process.env[k]]));
  process.env.ADB = stub;
  process.env.FAKE_ADB_MODE = 'none'; // the press below is the user's, not the machine's
  process.env.FAKE_ADB_STATE = path.join(dir, 'adb-reverses');
  process.env.FAKE_ADB_BENCH = BENCH;
  delete process.env.FAKE_ADB_FULL;

  const log: string[] = [];
  let dials = 0;
  let c: Controller | undefined;
  const giveSunshineBack = await fakeSunshine(dir);
  try {
    c = await Controller.create({
      dataDir: dir,
      resourcesDir: path.join(appRoot, 'resources'),
      skipReap: true,
      log: (l) => log.push(l),
    });

    /** What the dial's own `up()` answered, before `resync()` was allowed to look away. */
    let refused: Status | undefined;
    /** `index.ts`'s `startLink()`: what both the button and the auto-connect dial run. */
    const startLink = async (): Promise<Status> => {
      await c?.ensureAdb().catch(() => undefined);
      refused = await c?.up();
      return (await c?.resync()) as Status;
    };

    const attempt = new AutoConnectAttempt({
      settings: () => ON,
      refresh: async () => {
        await c?.refresh();
      },
      dial: async () => {
        dials += 1;
        await startLink();
      },
      provision: async () => {
        await c?.ensureAdb();
      },
      log: (l) => log.push(l),
      intervalMs: 25,
      provisionEveryMs: 60_000,
    });
    c.onChange((s) => attempt.step(s));

    attempt.arm();
    attempt.step(c.status()); // the push at the end of the launch block

    // The press, with no tablet on the bus.  The refusal is the honest answer and stays
    // the answer to the dial itself — this is the same call `--up --json` makes, and its
    // `error`/`noDevice` is pinned by service.test.ts.
    const pressed = await startLink();
    assert.equal(refused?.state, 'error', log.join('\n'));
    assert.equal(refused?.messageKey, 'noDevice');

    // ...but it is not what the card goes on saying.  `resync()` hands the question back
    // to the bus, so the window is where the launch started: idle, with the same sentence
    // the probe derives.  This is the state the dial below needs, and before the fix it
    // could not be reached again without raising a link or pressing something else.
    assert.equal(pressed.state, 'idle', `the press must not stick: ${pressed.message}`);
    assert.equal(pressed.messageKey, 'noDevice');

    // And the request is untouched: one failed press is not a withdrawal.
    await sleep(250);
    assert.equal(attempt.pending, true, 'a press that could not dial must not end the wait');
    assert.equal(dials, 0, 'and must not burn the one dial on a bus with nothing on it');

    // The tablet finishes booting and the user taps Allow.  The wait is what dials.
    process.env.FAKE_ADB_MODE = 'ok';
    process.env.FAKE_ADB_FULL = '1';

    assert.ok(await waitFor(() => dials > 0), `the wait must survive the press: ${log.join('\n')}`);
    assert.equal(dials, 1, 'exactly one dial, and it is the launch\u2019s own');
    assert.ok(await waitFor(() => !attempt.pending), `the attempt is over once its dial answered: ${log.join('\n')}`);
    assert.ok(
      log.includes('[app] auto-connect: the device is ready, starting the wired link'),
      `the ready line must be logged: ${log.join('\n')}`,
    );
  } finally {
    await giveSunshineBack();
    await c?.down().catch(() => undefined);
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the app\u2019s own dial that raised nothing keeps the wait, and the tablet is dialled for again', { skip: posixOnly }, async () => {
  // The launch this switch actually promises, with the one thing that used to kill it: the
  // machine was ready *for a moment*.  The probe saw a usable device, the launch's dial
  // went out on its own — and by the time it asked the bus again, the device was not on the
  // list (a cable that blinked, a tablet that rebooted, adb answering a fresh list).  The
  // refusal is `noDevice`: a sentence about a moment, not about the switch.
  //
  // Before this fix the launch's one automatic dial was spent right there: the tunnel kept
  // `error`, so the card showed an error nobody had pressed anything for, `shouldAutoConnect`
  // (which dials from `idle` only) could never fire again, and the button went back to
  // inviting a press the switch was supposed to make unnecessary.  So what is asserted here
  // is the whole of the user's expectation: the card is the bus's own answer, the wait is
  // still standing, and the app dials by itself the moment the device is back.
  if (existsSync(stub)) chmodSync(stub, 0o755);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ether-autoconnect-owndial-'));
  writeFileSync(path.join(dir, 'adb-reverses'), '');

  const saved = new Map(KNOBS.map((k) => [k, process.env[k]]));
  process.env.ADB = stub;
  process.env.FAKE_ADB_MODE = 'ok'; // the tablet is there and allowed: the launch dials
  process.env.FAKE_ADB_STATE = path.join(dir, 'adb-reverses');
  process.env.FAKE_ADB_BENCH = BENCH;
  delete process.env.FAKE_ADB_FULL;

  const log: string[] = [];
  let dials = 0;
  let c: Controller | undefined;
  const giveSunshineBack = await fakeSunshine(dir);
  try {
    c = await Controller.create({
      dataDir: dir,
      resourcesDir: path.join(appRoot, 'resources'),
      skipReap: true,
      log: (l) => log.push(l),
    });

    /** `index.ts`'s `startLink()`: exactly what its `dial` now runs. */
    const startLink = async (): Promise<Status> => {
      await c?.ensureAdb().catch(() => undefined);
      await c?.up();
      return (await c?.resync()) as Status;
    };

    const attempt = new AutoConnectAttempt({
      settings: () => ON,
      refresh: async () => {
        await c?.refresh();
      },
      dial: async () => {
        dials += 1;
        // The device disappears between the probe and the dial: the dial is taken, and it
        // is the bus that refuses it.  Second time round the cable is back.
        if (dials === 1) process.env.FAKE_ADB_MODE = 'none';
        return startLink();
      },
      provision: async () => {
        await c?.ensureAdb();
      },
      log: (l) => log.push(l),
      intervalMs: 25,
      provisionEveryMs: 60_000,
      redialMs: 150,
    });
    c.onChange((s) => attempt.step(s));

    attempt.arm();
    attempt.step(c.status()); // the push at the end of the launch block

    // The launch's own dial, with no press anywhere.
    assert.ok(await waitFor(() => dials === 1), `the launch must dial by itself: ${log.join('\n')}`);
    await sleep(150);
    assert.equal(attempt.pending, true, 'a refusal the bus says again is not an answer');

    // The card is the bus, not a memory of the failed dial: the sentence is the same one
    // the probe derives, in the state `shouldAutoConnect` can dial from again.
    const card = c.status();
    assert.equal(card.state, 'idle', `the failed dial must not stick: ${card.message}`);
    assert.equal(card.messageKey, 'noDevice');
    assert.equal(card.device, undefined, 'and the row is the bus\u2019s answer too, not the lost device');

    // The tablet answers again.  Nothing is pressed.
    process.env.FAKE_ADB_MODE = 'ok';
    process.env.FAKE_ADB_FULL = '1';
    assert.ok(await waitFor(() => dials === 2), `the wait must dial again: ${log.join('\n')}`);
    await sleep(150);
    assert.equal(attempt.pending, false, 'the second dial is the answer, however it ends');
    assert.equal(
      log.filter((l) => l === '[app] auto-connect: the device is ready, starting the wired link').length,
      2,
      `one ready line per dial: ${log.join('\n')}`,
    );
  } finally {
    await giveSunshineBack();
    await c?.down().catch(() => undefined);
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the switch off at launch leaves the app quiet, however long the tablet takes', { skip: posixOnly }, async () => {
  // The other half of "it works now": a switch the user left off must not dial because a
  // tablet showed up.  Same wiring, one setting different.
  if (existsSync(stub)) chmodSync(stub, 0o755);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ether-autoconnect-off-'));

  const saved = new Map(KNOBS.map((k) => [k, process.env[k]]));
  process.env.ADB = stub;
  process.env.FAKE_ADB_MODE = 'ok'; // the tablet is already there, and allowed
  process.env.FAKE_ADB_FULL = '1';

  let dials = 0;
  let c: Controller | undefined;
  try {
    c = await Controller.create({
      dataDir: dir,
      resourcesDir: path.join(appRoot, 'resources'),
      skipReap: true,
      log: () => undefined,
    });

    const attempt = new AutoConnectAttempt({
      settings: () => ({ autoConnect: false, keepRunning: true }),
      refresh: async () => {
        await c?.refresh();
      },
      dial: async () => {
        dials += 1;
      },
      log: () => undefined,
      intervalMs: 25,
      provisionEveryMs: 60_000,
    });
    c.onChange((s) => attempt.step(s));

    attempt.arm();
    attempt.step(c.status());
    await sleep(200);

    assert.equal(attempt.pending, false);
    assert.equal(dials, 0, 'a switch that is off is not a reason to connect');
  } finally {
    await c?.down().catch(() => undefined);
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
