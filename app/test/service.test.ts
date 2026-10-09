// service.test.ts — the `--up` / `--serve` / `--state` / `--down` service layer,
// with no tablet attached.
//
// The tunnel itself is device work that only a real tablet can do.  What can be
// proved here is the machinery around it (§13.9 M1, §13.13): that `--up` spawns a
// detached service, publishes <dataDir>/status.json, comes back as soon as the
// service reports and leaves no orphan when it fails; that `--state` believes a
// live service — and only a live service — instead of asking the tablet twice; and
// that `--down` signals that service and clears the record.  The fake adb of
// §13.9 "M0 negative case" makes the service fail fast and deterministically.

import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { t } from '../src/main/messages.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = path.join(appRoot, 'bin', 'cli.mjs');
const stub = path.join(appRoot, 'test', 'fixtures', 'fake-adb.sh');
const posixOnly = process.platform === 'win32' ? 'needs the POSIX sh adb stub' : false;
// The pid-reuse guard reads /proc/<pid>/cmdline (cli.mjs); without /proc there is
// nothing extra to test — the CLI falls back to the pid alone.
const linuxOnly = !existsSync('/proc/self/cmdline') ? 'needs /proc/<pid>/cmdline' : false;

/**
 * Three tests in this file drive `--up` all the way to the tablet (the elfNoExec
 * pair and the heartbeat one), and `--up` asks about Sunshine *before* it asks
 * about the device: with nothing listening on the base port it stops at
 * `noSunshine` and never reaches the stub adb at all.  On a developer's machine
 * Sunshine is listening there; on a clean CI runner nothing is, which is how those
 * three came to pass here and fail there.
 *
 * So own the port — the same move ports.test.ts makes for its own probes ("a port
 * we own, so this holds whether or not Sunshine is running right now").  A real
 * Sunshine that already holds it is left alone: to the tunnel the two are the same
 * thing, a socket that accepts a connection on the base port.
 */
const SUNSHINE_BASE = 47989;
let sunshineStub: net.Server | undefined;

before(async () => {
  sunshineStub = await new Promise<net.Server | undefined>((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(undefined)); // a real Sunshine has it
    srv.listen(SUNSHINE_BASE, '127.0.0.1', () => resolve(srv));
  });
});

after(async () => {
  if (sunshineStub) await new Promise<void>((resolve) => sunshineStub?.close(() => resolve()));
});

/** The §13.8 key order; `status.json` adds its own three keys after it. */
const FROZEN = ['state', 'device', 'adb', 'tcpMap', 'udpMap', 'stats', 'message', 'messageKey', 'hint', 'ports', 'channels', 'logs'];
const SERVICE_KEYS = ['pid', 'ready', 'updatedAt'];

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

function run(args: string[], env: Record<string, string> = {}): Run {
  const started = Date.now();
  const r = spawnSync(process.execPath, [cli, ...args], {
    cwd: appRoot,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ms: Date.now() - started };
}

/**
 * `run`, but without blocking this process's event loop.  Needed wherever the CLI
 * has to stop a child *we* spawned: a killed child of a blocked parent lingers as a
 * zombie, `kill(pid, 0)` still succeeds on it, so the CLI would wait out its whole
 * 8 s teardown grace for a process that is already gone.  (A real service is
 * detached and the `--up` that spawned it exits at once, so init reaps it — this
 * zombie is an artifact of testing it from inside one long-lived process.)
 */
async function runAsync(args: string[], env: Record<string, string> = {}): Promise<Run> {
  const started = Date.now();
  const child = spawn(process.execPath, [cli, ...args], { cwd: appRoot, env: { ...process.env, ...env } });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d: string) => {
    stdout += d;
  });
  child.stderr.on('data', (d: string) => {
    stderr += d;
  });
  const status = await new Promise<number | null>((res) => child.on('close', (c) => res(c)));
  return { status, stdout, stderr, ms: Date.now() - started };
}

function tmp(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'ether-svc-'));
}

/** The env every run in this file uses: the stub adb and a private data dir. */
function env(dir: string, mode: string): Record<string, string> {
  if (process.platform !== 'win32' && existsSync(stub)) chmodSync(stub, 0o755);
  return { ADB: stub, ETHER_DATA_DIR: dir, FAKE_ADB_MODE: mode };
}

function statusFile(dir: string): string {
  return path.join(dir, 'status.json');
}

/**
 * The stub configured as a *working* device — the one combination in which `--up`
 * can reach `state:"up"` with no silicon on the bus (same knobs as
 * `app/_rehearse_m2.sh`).  Everything else in this file drives a failing `--up`.
 */
function fullEnv(dir: string, ledger: string): Record<string, string> {
  if (process.platform !== 'win32' && existsSync(stub)) chmodSync(stub, 0o755);
  return {
    ADB: stub,
    ETHER_DATA_DIR: dir,
    FAKE_ADB_MODE: 'ok',
    FAKE_ADB_FULL: '1',
    FAKE_ADB_STATE: ledger,
    FAKE_ADB_BENCH: '[bench] round-trip goodput: 30987 x 1024 B in 3.00s -> 103.1 Mbps (12.90 MB/s) payload, 0 odd-sized',
  };
}

function readStatus(dir: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(statusFile(dir), 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor(fn: () => boolean | Promise<boolean>, ms = 4000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * A live process whose /proc/<pid>/cmdline looks like our service while doing no
 * work at all: Node ignores the argv after `-e`, so the tail is only a costume.
 * This is how `--state` can be shown believing a service with no tablet plugged in.
 */
function spawnCostumeService(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', 'cli.mjs', '--serve'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child;
}

/** A believable `status.json` in the §13.8 order, plus the service's three keys. */
function plantStatus(dir: string, pid: number, updatedAt: number): void {
  const body = {
    state: 'up',
    device: { serial: 'HA2HS0KT', state: 'device', model: 'TB375FC' },
    adb: { path: stub, version: '1.0.41 (37.0.1-15733141)', conflict: false },
    tcpMap: [
      [47984, 47984],
      [47989, 47989],
    ],
    udpMap: [],
    stats: { datagrams: 0, bytes: 0, dropped: 0, peers: 0 },
    message: t('ready'),
    messageKey: 'ready',
    ports: { base: 47989, tcp: [47984, 47989], udp: [], source: 'config' },
    channels: ['47984 HTTPS', '47989 HTTP/discovery'],
    logs: ['12:00:00 [tunnel] planted by service.test.ts'],
    pid,
    ready: true,
    updatedAt,
  };
  writeFileSync(statusFile(dir), `${JSON.stringify(body)}\n`, 'utf8');
}

/** Every key of a printed status is a §13.8 key, in §13.8's order, and no other. */
function assertFrozenKeys(json: Record<string, unknown>, where: string): void {
  const keys = Object.keys(json);
  assert.deepEqual(keys.filter((k) => !FROZEN.includes(k)), [], `${where}: unexpected key`);
  assert.deepEqual(keys, FROZEN.filter((k) => keys.includes(k)), `${where}: key order drifted from §13.8`);
}

/** Every key of status.json is a §13.8 key (in order) or one of the service's. */
function assertStatusKeys(st: Record<string, unknown>, where: string): void {
  const keys = Object.keys(st);
  const own = keys.filter((k) => !SERVICE_KEYS.includes(k));
  assert.deepEqual(own, FROZEN.filter((k) => own.includes(k)), `${where}: key order drifted from §13.8`);
  assert.deepEqual(keys.slice(-SERVICE_KEYS.length), SERVICE_KEYS, `${where}: service keys missing or out of order`);
  assert.equal(typeof st.pid, 'number', `${where}: pid`);
  assert.equal(st.ready, true, `${where}: ready`);
  assert.equal(typeof st.updatedAt, 'number', `${where}: updatedAt`);
}

test('--up without a tablet names the missing device instead of inventing a udp failure', { skip: posixOnly }, async () => {
  const dir = tmp();
  try {
    const r = run(['--up', '--json'], env(dir, 'none'));
    assert.equal(r.status, 1, `expected exit 1: ${r.stderr}`);
    // §13.9: the whole point of the service is that `--up` comes back inside 25 s.
    assert.ok(r.ms < 15_000, `--up took ${r.ms}ms`);
    const json = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.equal(json.state, 'error');
    assert.equal(json.messageKey, 'noDevice');
    assert.equal(json.message, t('noDevice'));
    // `--up --json` prints the same frozen object as `--state --json` (§13.8).
    assertFrozenKeys(json, '--up --json, no tablet');

    // The failure has to survive in status.json long enough for the parent to read
    // it (§13.13), and the pid must be gone: no orphan service may keep holding the
    // data dir after `--up` gave up.
    const st = readStatus(dir);
    assert.ok(st, '--up left no status.json for the failure');
    assertStatusKeys(st, 'failed --up');
    assert.equal(st.state, 'error');
    assert.equal(st.messageKey, 'noDevice');
    const pid = st.pid as number;
    assert.ok(await waitFor(() => !alive(pid)), `service pid ${pid} outlived the failed --up`);
    await Promise.resolve();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('--up creates a data dir that does not exist yet, instead of dying on the log redirect', { skip: posixOnly }, async () => {
  const base = tmp();
  // A first run on a fresh machine has no data dir at all; the service log is
  // opened with 'w' before anyone else gets a chance to create it.
  const dir = path.join(base, 'fresh', 'nested', 'data');
  try {
    assert.equal(existsSync(dir), false, 'this test needs a data dir that is not there');
    const r = run(['--up', '--json'], env(dir, 'none'));
    assert.equal(r.status, 1, `expected exit 1 (no tablet): ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /ENOENT/, 'the redirect blew up on the missing directory');
    const json = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.equal(json.state, 'error');
    assert.equal(json.messageKey, 'noDevice');
    assert.ok(existsSync(path.join(dir, 'service.log')), 'no service.log in the fresh dir');
    assert.ok(readStatus(dir), 'no status.json in the fresh dir');
    await Promise.resolve();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a tablet that cannot run the ELF fails --up once, cleanly, with no orphan service', { skip: posixOnly }, async () => {
  const dir = tmp();
  try {
    const r = run(['--up', '--json'], env(dir, 'ok'));
    assert.equal(r.status, 1, `expected exit 1: ${r.stderr}`);
    assert.ok(r.ms < 15_000, `--up took ${r.ms}ms`);
    const json = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.equal(json.state, 'error');
    // The stub answers `--test` with nothing, which is exactly what a noexec
    // /data/local/tmp looks like; the sentence and the key must agree.
    assert.equal(json.messageKey, 'elfNoExec');
    assert.equal(json.message, t('elfNoExec'));
    assertFrozenKeys(json, '--up --json, smoke failure');
    // The service log is the only place the device conversation is written down.
    assert.match(r.stderr, /service could not raise the tunnel/);
    assert.match(r.stderr, /smoke FAIL/);

    const st = readStatus(dir);
    assert.ok(st, '--up left no status.json for the failure');
    assertStatusKeys(st, 'failed --up');
    const pid = st.pid as number;
    assert.ok(await waitFor(() => !alive(pid)), `service pid ${pid} outlived the failed --up`);
    // Nothing was recorded: the tunnel never got as far as writing state.json.
    assert.equal(existsSync(path.join(dir, 'state.json')), false, 'a failed up() wrote a reap record');
    await Promise.resolve();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a smoke that fails once is retried before the user is told the ELF cannot run', { skip: posixOnly }, async () => {
  const base = tmp();
  const dir = path.join(base, 'data');
  const ledger = path.join(base, 'reverses');
  const smoke = path.join(base, 'smoke.count');
  try {
    writeFileSync(ledger, '');
    // The first `--test` answers TEST FAIL and exits non-zero, the second answers
    // TEST PASS: the transient the real tablet produced once, while another
    // device-side `--bench` from a killed run was still going.  Without the retry
    // this is exactly the run in which `--up` published `elfNoExec` — "the
    // tablet-side program cannot run (maybe /data/local/tmp is mounted noexec)" —
    // about a program whose own phase results were sitting in the log (§13.13).
    const r = await runAsync(['--up', '--json'], {
      ...fullEnv(dir, ledger),
      FAKE_ADB_SMOKE_FLAKE: '1',
      FAKE_ADB_SMOKE_FILE: smoke,
    });
    assert.equal(r.status, 0, `expected the retry to save this --up: ${r.stderr}`);
    // The stub exits non-zero the way the real ELF does (`udp2tcp.c` returns rc),
    // so the first attempt is heard through the error path — and its own "TEST FAIL"
    // only reaches the log because AdbError carries stdout.
    assert.match(r.stderr, /TEST FAIL/, 'the first attempt has to be heard');
    assert.match(r.stderr, /the ELF did run/);
    assert.match(r.stderr, /smoke retry: one more --test before calling it unrunnable/);
    assert.match(r.stderr, /smoke PASS/, 'the second attempt has to be the one that passed');
    const json = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.equal(json.state, 'up');
    assert.notEqual(json.messageKey, 'elfNoExec', 'it answered twice — it very much can run');
    assertFrozenKeys(json, '--up --json after a smoke retry');
    const st = readStatus(dir);
    assert.ok(st, '--up left no status.json after the retry');
    assertStatusKeys(st, 'status.json after a smoke retry');
    assert.equal(readFileSync(smoke, 'utf8').trim(), '2', 'the smoke was not asked exactly twice');
    await Promise.resolve();
  } finally {
    await runAsync(['--down'], fullEnv(dir, ledger));
    await rm(base, { recursive: true, force: true });
  }
});

test('a service that is up keeps publishing ready:true, not just for one beat', { skip: linuxOnly }, async () => {
  // `--up` returns the instant it reads `ready:true`, while the service keeps
  // rewriting status.json once a second.  When that heartbeat published
  // `ready:false` again (it did), every later `--up` had to win a race against it:
  // lose, and a tunnel that was up cost the user 21 s and exited 1.
  const base = tmp();
  const dir = path.join(base, 'data');
  const ledger = path.join(base, 'reverses');
  try {
    writeFileSync(ledger, '');
    const r = run(['--up', '--json'], fullEnv(dir, ledger));
    assert.equal(r.status, 0, `expected exit 0: ${r.stderr}`);
    const first = readStatus(dir);
    assert.ok(first, '--up left no status.json');
    assertStatusKeys(first, 'live --up');
    assert.equal(first.state, 'up');

    await new Promise((res) => setTimeout(res, 1600));
    const later = readStatus(dir);
    assert.ok(later, 'the service stopped publishing');
    assert.equal(later.ready, true, 'the heartbeat took `ready` back to false');
    assert.equal(later.state, 'up');
    assert.equal(later.pid, first.pid, 'a different service is publishing now');
    assert.ok(Date.now() - (later.updatedAt as number) < 1500, 'the heartbeat stopped beating');
    assertStatusKeys(later, 'status.json of a live service');
    await Promise.resolve();
  } finally {
    run(['--down'], fullEnv(dir, ledger));
    await rm(base, { recursive: true, force: true });
  }
});

test('--state believes a live service, so the tablet is not asked twice', { skip: linuxOnly }, async () => {
  const dir = tmp();
  const svc = spawnCostumeService();
  const pid = svc.pid ?? 0;
  try {
    assert.ok(pid > 0, 'costume service did not start');
    assert.ok(await waitFor(() => alive(pid)), 'costume service died');
    plantStatus(dir, pid, Date.now());

    // FAKE_ADB_MODE=none: there is no tablet at all, yet a fresh service record is
    // the truth — this is the `--up && --state --json` acceptance line, minus the
    // hardware.
    const r = run(['--state', '--json'], env(dir, 'none'));
    assert.equal(r.status, 0, `expected exit 0: ${r.stderr}`);
    const json = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.equal(json.state, 'up');
    assert.deepEqual(json.tcpMap, [
      [47984, 47984],
      [47989, 47989],
    ]);
    assert.equal(json.messageKey, 'ready');
    await Promise.resolve();
  } finally {
    if (pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});

test('--state ignores a service record whose heartbeat has gone stale', { skip: linuxOnly }, async () => {
  const dir = tmp();
  const svc = spawnCostumeService();
  const pid = svc.pid ?? 0;
  try {
    assert.ok(pid > 0, 'costume service did not start');
    assert.ok(await waitFor(() => alive(pid)), 'costume service died');
    // Alive and with a matching cmdline, but the last beat is older than the TTL:
    // a service that stopped talking is not a service (§13.13).
    plantStatus(dir, pid, Date.now() - 60_000);

    const r = run(['--state', '--json'], env(dir, 'none'));
    assert.equal(r.status, 1, `expected exit 1: ${r.stderr}`);
    const json = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.notEqual(json.state, 'up');
    assert.deepEqual(json.tcpMap, []);
    // Reading a record must never signal anything.
    assert.ok(alive(pid), '--state killed a process it was only reading about');
    await Promise.resolve();
  } finally {
    if (pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});

test('--state ignores a record whose pid belongs to somebody else', { skip: posixOnly }, async () => {
  const dir = tmp();
  try {
    // A fresh heartbeat and a live pid — but this process is `node --test`, not
    // `cli.mjs --serve`.  A recycled pid must not be mistaken for our service.
    plantStatus(dir, process.pid, Date.now());
    const r = run(['--state', '--json'], env(dir, 'ok'));
    assert.equal(r.status, 1, `expected exit 1: ${r.stderr}`);
    const json = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.notEqual(json.state, 'up');
    assert.deepEqual(json.tcpMap, []);
    assert.ok(alive(process.pid), 'the test runner was signalled');
    await Promise.resolve();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('--down stops the service holding the tunnel and clears the record', { skip: linuxOnly }, async () => {
  const dir = tmp();
  const svc = spawnCostumeService();
  const pid = svc.pid ?? 0;
  try {
    assert.ok(pid > 0, 'costume service did not start');
    assert.ok(await waitFor(() => alive(pid)), 'costume service died');
    plantStatus(dir, pid, Date.now());

    const r = await runAsync(['--down'], env(dir, 'ok'));
    assert.equal(r.status, 0, `expected exit 0: ${r.stderr}`);
    assert.match(r.stdout, new RegExp(`service\\s+: stopped \\(pid ${pid}\\)`));
    assert.match(r.stdout, /reaped: host pids 0, device pids 0, reverses 0/);
    assert.ok(await waitFor(() => !alive(pid)), `service pid ${pid} was not signalled`);
    assert.equal(readStatus(dir), undefined, '--down left the record behind');
    await Promise.resolve();
  } finally {
    if (pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});

test('--up replaces the service that was already running', { skip: linuxOnly }, async () => {
  const dir = tmp();
  const svc = spawnCostumeService();
  const old = svc.pid ?? 0;
  try {
    assert.ok(old > 0, 'costume service did not start');
    assert.ok(await waitFor(() => alive(old)), 'costume service died');
    plantStatus(dir, old, Date.now());

    // One tunnel per machine: the old service goes first, then this `--up` runs its
    // own (and fails here, because there is no tablet).
    const r = await runAsync(['--up', '--json'], env(dir, 'none'));
    assert.equal(r.status, 1, `expected exit 1: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`replaced the previous service \\(pid ${old}\\)`));
    assert.ok(await waitFor(() => !alive(old)), `the old service ${old} was not stopped`);
    const st = readStatus(dir);
    assert.ok(st, 'the failed replacement left no status.json');
    assert.notEqual(st.pid, old, 'the record still points at the replaced service');
    await Promise.resolve();
  } finally {
    if (old > 0 && alive(old)) process.kill(old, 'SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});
