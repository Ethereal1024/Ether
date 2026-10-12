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
const KNOBS = ['ADB', 'FAKE_ADB_MODE', 'FAKE_ADB_FULL', 'FAKE_ADB_STATE', 'FAKE_ADB_BENCH'] as const;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(fn: () => boolean, ms = 8000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return true;
    await sleep(50);
  }
  return false;
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
    assert.equal(attempt.pending, false, 'the attempt is over once it dialled');
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
