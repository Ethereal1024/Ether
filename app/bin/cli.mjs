#!/usr/bin/env node
// cli.mjs — the whole app, without a window.
//
// This is not a debugging afterthought: it is how the project is accepted in
// environments that have no GUI (§13.8).  Every command below
// drives the very same Controller the Electron window drives, so a green CLI run
// and a green button press mean the same thing.
//
//   node bin/cli.mjs --state --json
//   node bin/cli.mjs --up
//   node bin/cli.mjs --down
//   node bin/cli.mjs --selftest
//   node bin/cli.mjs --bench --seconds 30 --window 4096

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, openSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const distDir = path.join(appRoot, 'dist', 'src', 'main');
const C_BIN = process.env.ETHER_C_BIN ?? path.resolve(appRoot, '..', 'c-relay', 'udp2tcp');

const USAGE = `Ether — a wired Moonlight channel (one USB cable, one click)

Usage:
  node bin/cli.mjs --state [--json] [--logs N]     show status (exit 1 when not up)
  node bin/cli.mjs --up [--json] [--fast]          raise the channel (25 s timeout)
  node bin/cli.mjs --down [--json]                 restore everything (idempotent)
  node bin/cli.mjs --bench [--seconds N] [--window N] [--json]
  node bin/cli.mjs --selftest                      unit + loopback interop (no device)
  node bin/cli.mjs --reap [--json]                 clear leftovers (reverses / orphans / pid files)
  node bin/cli.mjs --serve                         internal: resident service (--up starts it; do not run by hand)

Options:
  --json            print Status as JSON (fixed key order, see §13.8)
  --data-dir PATH   state directory (default: platform userData)
  --elf PATH        device-side udp2tcp (overrides the ABI lookup)
  --timeout SEC     wall-clock limit for --up (default 25)
  --fast            --up skips the device self-check and the post-up verification
  --keep            --bench leaves the channel up afterwards
  --help
`;

function die(msg, code = 2) {
  process.stderr.write(`Ether: ${msg}\n`);
  process.exit(code);
}

const argv = process.argv.slice(2);
const opt = {
  state: false, up: false, down: false, bench: false, selftest: false, reap: false, serve: false,
  json: false, dataDir: undefined, elf: undefined,
  timeout: 25, seconds: 10, window: 1024, frame: 1200,
  fast: false, keep: false, logs: 0, help: false,
};

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => {
    const v = argv[++i];
    if (v === undefined) die(`${a} needs a value`);
    return v;
  };
  if (a === '--state') opt.state = true;
  else if (a === '--up') opt.up = true;
  else if (a === '--down') opt.down = true;
  else if (a === '--bench') opt.bench = true;
  else if (a === '--selftest') opt.selftest = true;
  else if (a === '--reap') opt.reap = true;
  else if (a === '--serve') opt.serve = true;
  else if (a === '--json') opt.json = true;
  else if (a === '--fast') opt.fast = true;
  else if (a === '--keep') opt.keep = true;
  else if (a === '--help' || a === '-h') opt.help = true;
  else if (a === '--data-dir') opt.dataDir = next();
  else if (a === '--elf') opt.elf = next();
  else if (a === '--timeout') opt.timeout = Number(next());
  else if (a === '--seconds') opt.seconds = Number(next());
  else if (a === '--window') opt.window = Number(next());
  else if (a === '--frame') opt.frame = Number(next());
  else if (a === '--logs') opt.logs = Number(next());
  else die(`unknown option ${a}\n\n${USAGE}`);
}

if (opt.help || argv.length === 0) {
  process.stdout.write(USAGE);
  process.exit(0);
}

async function load(name) {
  const p = path.join(distDir, name);
  if (!existsSync(p)) die(`missing ${p}\nrun \`npm run build\` in ${appRoot} first`, 1);
  return import(pathToFileURL(p).href);
}

async function loadAll() {
  const [controller, tunnelMod, adbMod, relayMod, benchMod, messagesMod, portsMod, platformMod] =
    await Promise.all([
      load('controller.js'),
      load('tunnel.js'),
      load('adb.js'),
      load('relay.js'),
      load('bench.js'),
      load('messages.js'),
      load('ports.js'),
      load('platform.js'),
    ]);
  return { controller, tunnelMod, adbMod, relayMod, benchMod, messagesMod, portsMod, platformMod };
}

/** The fixed key order of §13.8, so the JSON reads the same every time. */
export function statusJson(s) {
  return {
    state: s.state,
    device: s.device,
    adb: s.adb,
    tcpMap: s.tcpMap,
    udpMap: s.udpMap,
    stats: s.stats,
    message: s.message,
    messageKey: s.messageKey,
    hint: s.hint,
    ports: s.ports,
    channels: s.channels,
    logs: s.logs,
  };
}

function printStatus(s) {
  if (opt.json) {
    process.stdout.write(`${JSON.stringify(statusJson(s), null, 2)}\n`);
    return;
  }
  const line = (k, v) => {
    if (v !== undefined && v !== null && v !== '') process.stdout.write(`${k.padEnd(12)}: ${v}\n`);
  };
  line('state', s.state);
  if (s.device) line('device', `${s.device.serial} (${s.device.model ?? 'unknown'}) [${s.device.state}]`);
  if (s.adb) line('adb', `${s.adb.path} (${s.adb.version})${s.adb.conflict ? ' [conflict]' : ''}`);
  if (s.tcpMap?.length) line('tcp', s.tcpMap.map(([a, b]) => `${a}->${b}`).join(' '));
  if (s.udpMap?.length) line('udp', s.udpMap.map(([a, b]) => `${a}->${b}`).join(' '));
  if (s.stats) line('stats', `datagrams=${s.stats.datagrams} bytes=${s.stats.bytes} dropped=${s.stats.dropped} peers=${s.stats.peers}`);
  if (s.message) line('message', s.message);
  if (s.hint) line('hint', s.hint);
  const logs = s.logs ?? [];
  if (opt.logs > 0) {
    process.stdout.write('--- logs ---\n');
    for (const l of logs.slice(-opt.logs)) process.stdout.write(`${l}\n`);
  }
}

async function makeController(mods, extra = {}) {
  if (opt.elf) process.env.ETHER_ELF = opt.elf;
  if (opt.dataDir) process.env.ETHER_DATA_DIR = opt.dataDir;
  const { Controller } = mods.controller;
  const c = await Controller.create({
    dataDir: opt.dataDir,
    resourcesDir: process.env.ETHER_RESOURCES ?? path.join(appRoot, 'resources'),
    // Diagnostics go to stderr, always: stdout carries data only, so
    // `--state --json | jq` is a valid acceptance command (§13.8).
    log: (l) => process.stderr.write(`${l}\n`),
    ...extra,
  });
  ctrl = c;
  return c;
}

function withTimeout(p, ms) {
  let timer;
  const t = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`timed out after ${ms} ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------- tunnel service
//
// `--up` has to *return* inside §13.9's 25 s budget, yet the channel has to stay
// up afterwards (`--up && --state --json` is one acceptance line).  So the tunnel
// lives in a detached copy of this very program, `--serve`, which publishes its
// status to <dataDir>/status.json once a second and dismantles the tunnel when it
// gets SIGTERM.  `--state` reads that file, `--down` signals that process.  The
// Electron window keeps the tunnel in-process instead — same Controller, no file.

const SERVICE_TTL_MS = 15_000;
/** What we write between "spawned" and "the Controller said something". */
const STARTING_STATUS = {
  state: 'starting',
  message: '',
  tcpMap: [],
  udpMap: [],
  stats: { datagrams: 0, bytes: 0, dropped: 0, peers: 0 },
  logs: [],
};

const service = { dir: '', statusFile: '', log: '' };
let logOffset = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM'; // someone else's process is still a live pid
  }
}

/**
 * A live pid is not proof that it is *our* service: a recycled pid would make us
 * signal an innocent process.  Linux lets us read the cmdline for free; anywhere
 * else we fall back to the pid alone.
 */
function isOurService(pid) {
  if (!alive(pid)) return false;
  try {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return cmd.includes('cli.mjs') && cmd.includes('--serve');
  } catch {
    return true;
  }
}

function serviceInit(mods) {
  service.dir = opt.dataDir ?? mods.platformMod.userDataDir();
  service.statusFile = path.join(service.dir, 'status.json');
  service.log = path.join(service.dir, 'service.log');
}

async function readServiceRaw() {
  try {
    const j = JSON.parse(await readFile(service.statusFile, 'utf8'));
    return j && typeof j.pid === 'number' ? j : undefined;
  } catch {
    return undefined;
  }
}

/** A service that is both alive and still beating; anything else is a corpse. */
async function readService() {
  const raw = await readServiceRaw();
  if (!raw) return undefined;
  if (!isOurService(raw.pid)) return undefined;
  if (!Number.isFinite(raw.updatedAt) || Date.now() - raw.updatedAt > SERVICE_TTL_MS) return undefined;
  return raw;
}

async function writeService(s, pid, ready) {
  const body = { ...statusJson(s), pid, ready: Boolean(ready), updatedAt: Date.now() };
  await mkdir(service.dir, { recursive: true }).catch(() => undefined);
  await writeFile(service.statusFile, `${JSON.stringify(body)}\n`, 'utf8');
}

async function clearService() {
  await rm(service.statusFile, { force: true }).catch(() => undefined);
}

/** SIGTERM (wait `grace`) → SIGKILL. Returns the pid it stopped, or 0. */
async function stopService(o = {}) {
  const grace = o.grace ?? 8000;
  const raw = await readServiceRaw();
  if (!raw) return 0;
  const pid = raw.pid;
  if (!isOurService(pid)) {
    // Not our process (or already gone): drop the record, signal nothing.
    await clearService();
    return 0;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    await clearService();
    return 0;
  }
  const until = Date.now() + grace;
  while (Date.now() < until) {
    await sleep(200);
    if (!alive(pid)) {
      await clearService();
      return pid;
    }
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* raced with its own exit */
  }
  await sleep(200);
  await clearService();
  return pid;
}

function serviceArgs() {
  const args = [path.join(here, 'cli.mjs'), '--serve', '--data-dir', service.dir];
  if (opt.elf) args.push('--elf', opt.elf);
  if (opt.fast) args.push('--fast');
  return args;
}

/** Copy whatever the service logged since the last call to our own stderr. */
async function tailServiceLog() {
  let txt;
  try {
    txt = await readFile(service.log, 'utf8');
  } catch {
    return;
  }
  if (txt.length < logOffset) logOffset = 0; // a new --up truncated it
  if (txt.length === logOffset) return;
  process.stderr.write(txt.slice(logOffset));
  logOffset = txt.length;
}

// ------------------------------------------------------------------ commands

async function cmdState(mods) {
  // A live service owns the truth: asking it costs one file read, and building a
  // second Controller here would reap the relays it is using.
  const svc = await readService();
  if (svc) {
    printStatus(svc);
    return svc.state === 'up' ? 0 : 1;
  }
  // Otherwise Controller.create() already refreshed once; asking twice just
  // repeats the on-device round trips for the same answer.
  const c = await makeController(mods, { skipReap: false });
  const s = c.status();
  printStatus(s);
  return s.state === 'up' ? 0 : 1;
}

async function cmdUp(mods) {
  // One tunnel per machine: whatever was serving before is stale by definition.
  // `stopService` gives it the full grace period, because a service that gets
  // SIGKILLed mid-teardown leaves reverses behind for the next reap to find.
  const old = await stopService();
  if (old) process.stderr.write(`Ether: replaced the previous service (pid ${old})\n`);
  await clearService();
  logOffset = 0;
  // A fresh machine has no data dir yet, and the redirect below needs it to exist.
  await mkdir(service.dir, { recursive: true }).catch(() => undefined);

  const fd = openSync(service.log, 'w');
  const child = spawn(process.execPath, serviceArgs(), { detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  const pid = child.pid ?? 0;
  await writeService(STARTING_STATUS, pid, false).catch(() => undefined);

  let exited = false;
  child.on('exit', () => {
    exited = true;
  });

  // Leave a couple of seconds for the teardown below, or the 25 s wall clock in
  // §13.9 would be spent waiting instead of returning.
  const deadline = Date.now() + Math.max(5, opt.timeout - 4) * 1000;
  let status;
  while (Date.now() < deadline) {
    await sleep(200);
    await tailServiceLog();
    const raw = await readServiceRaw();
    if (raw && raw.pid === pid) {
      status = raw; // the last thing it said, ready or not
      if (raw.ready === true) break;
    }
    if (exited) break;
  }
  await tailServiceLog();

  if (!status || status.ready !== true) {
    process.stderr.write(
      `Ether: the tunnel service did not finish within ${Math.max(5, opt.timeout - 4)}s` +
        (exited ? ' (it exited)\n' : '\n'),
    );
    await stopService({ grace: 2000 });
    if (status) printStatus(status);
    return 1;
  }
  printStatus(status);
  if (!opt.json && status.state === 'up') {
    process.stdout.write(`${'service'.padEnd(12)}: running as pid ${pid} — stop with \`node bin/cli.mjs --down\`\n`);
  }
  return status.state === 'up' ? 0 : 1;
}

async function cmdDown(mods) {
  const pid = await stopService();
  await clearService();
  const c = await makeController(mods, { skipReap: true });
  const s = await c.down();
  const report = await c.reapNow();
  if (!opt.json) {
    if (pid) process.stdout.write(`service      : stopped (pid ${pid})\n`);
    process.stdout.write(
      `reaped: host pids ${report.hostPidsKilled.length}, device pids ${report.devicePidsKilled.length}, ` +
        `reverses ${report.reversesRemoved.length}\n`,
    );
  }
  printStatus(s);
  return 0;
}

/**
 * `--serve`: the resident half of `--up`. Runs the tunnel in this process, keeps
 * status.json beating, and restores everything on SIGTERM/SIGINT.
 */
async function cmdServe(mods) {
  let c;
  let beat;
  let torn = false;
  let signalled = false;
  let wake;
  const stopped = new Promise((res) => {
    wake = res;
  });

  const teardown = async (code) => {
    if (torn) return;
    torn = true;
    if (beat) clearInterval(beat);
    process.stderr.write('Ether: service stopping, restoring\n');
    const guard = setTimeout(() => process.exit(code), 6000);
    guard.unref?.();
    await c?.down().catch(() => undefined);
    await clearService();
    process.exit(code);
  };

  const onSignal = () => {
    signalled = true;
    wake();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  await writeService(STARTING_STATUS, process.pid, false).catch(() => undefined);

  let status;
  // Latched so the heartbeat below keeps publishing the same answer.  `--up`
  // polls this file for `ready:true` and returns the moment it sees it; a beat
  // that carried `false` again (it did) meant every later `--up` had to win a race
  // against a 1 s timer — lose, and a tunnel that was up cost 21 s and exit 1.
  let ready = false;
  try {
    c = await makeController(mods);
    // Keep the heartbeat fresh through the (tens of seconds) up(): `--state` run
    // concurrently then sees "starting" instead of a cold corpse.
    beat = setInterval(() => {
      if (!torn && c) void writeService(c.status(), process.pid, ready).catch(() => undefined);
    }, 1000);
    await writeService(c.status(), process.pid, ready).catch(() => undefined);
    status = await c.up({ smoke: !opt.fast, verify: !opt.fast });
  } catch (e) {
    process.stderr.write(`Ether: ${e?.stack ?? e}\n`);
    status = c?.status();
  }
  ready = true;
  if (status) await writeService(status, process.pid, ready).catch(() => undefined);

  if (!status || status.state !== 'up') {
    process.stderr.write(`Ether: service could not raise the tunnel (${status?.state ?? 'no status'})\n`);
    if (beat) clearInterval(beat);
    torn = true;
    await c?.down().catch(() => undefined);
    // Leave the "ready but failed" status where the parent can read it: clearing
    // it here would race the `--up` that is polling for exactly this answer.  A
    // dead pid makes it invisible to `--state`, and the next `--up` overwrites it.
    return 1;
  }
  process.stderr.write(`Ether: service up, pid ${process.pid}\n`);
  if (signalled) {
    await teardown(0); // a signal arrived while up() was running
    return 0;
  }

  // Stay resident. The ref'd timer keeps the loop alive even if a relay is idle;
  // the promise is resolved by the signal handlers above, so there is no poll
  // loop burning CPU while the channel is up.
  const keep = setInterval(() => {}, 60_000);
  await stopped;
  clearInterval(keep);
  await teardown(0);
  return 0;
}

async function cmdReap(mods) {
  // An explicit cleanup must not race a service that is still serving: stop it
  // the way `--down` does, then sweep whatever it left behind.
  const pid = await stopService();
  await clearService();
  const c = await makeController(mods, { skipReap: true });
  const report = await c.reapNow();
  if (opt.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    if (pid) process.stdout.write(`service          : stopped (pid ${pid})\n`);
    process.stdout.write(
      `host pids killed : ${report.hostPidsKilled.join(', ') || '(none)'}\n` +
        `device pids killed: ${report.devicePidsKilled.join(', ') || '(none)'}\n` +
        `reverses removed : ${report.reversesRemoved.join(', ') || '(none)'}\n` +
        `foreign ports    : ${report.foreignPorts.map((f) => `${f.port}/${f.proto}:${f.pid}:${f.name}`).join(', ') || '(none)'}\n` +
        `notes            : ${report.notes.join('; ') || '(none)'}\n`,
    );
  }
  return 0;
}

async function cmdBench(mods) {
  const { startLoopbackChain, runBench } = mods.benchMod;
  const svc = await readService();
  // The service owns the tunnel: creating a second Controller that reaps would
  // tear down the very channels we are measuring, and bringing up a second
  // tunnel would fight over the same ports.
  const c = await makeController(mods, { skipReap: Boolean(svc) });
  let s = svc ?? c.status();
  let topology = 'device';
  let started = false;

  if (!s.device) {
    topology = 'loopback';
  } else if (s.state !== 'up') {
    if (svc) {
      printStatus(s);
      process.stderr.write('Ether: the service is running but the tunnel is not up; nothing to bench\n');
      return 1;
    }
    s = await withTimeout(c.up({ smoke: !opt.fast, verify: !opt.fast }), Math.max(opt.timeout, 60) * 1000);
    started = true;
    if (s.state !== 'up') {
      printStatus(s);
      process.stderr.write('Ether: tunnel is not up; nothing to bench\n');
      return 1;
    }
  }

  let result;
  if (topology === 'device') {
    // The probe needs its own ports next to whatever the tunnel already holds —
    // including another process's channels, hence the explicit avoid list.
    const avoid = [
      ...(s.tcpMap ?? []).flat(),
      ...(s.udpMap ?? []).flat(),
      ...(s.ports?.tcp ?? []),
      ...(s.ports?.udp ?? []),
    ];
    const probe = await c.measure({ seconds: opt.seconds, window: opt.window, avoid });
    result = {
      ok: probe.ok,
      topology,
      mbps: probe.mbps,
      back: probe.back,
      frame: probe.frame,
      seconds: probe.seconds,
      odd: probe.odd,
      view: probe.view,
    };
    // Only restore what this invocation raised; a service keeps serving.
    if (started && !opt.keep) await c.down();
  } else {
    if (!existsSync(C_BIN)) {
      process.stderr.write(`Ether: no device, and the host C relay ${C_BIN} is not built (c-relay/build.sh)\n`);
      await c.down().catch(() => undefined);
      return 1;
    }
    const chain = await startLoopbackChain({
      hostImpl: 'node',
      deviceImpl: 'node',
      echoImpl: 'node',
      cBin: C_BIN,
      log: (l) => process.stderr.write(`${l}\n`),
    });
    try {
      const b = await runBench({
        host: '127.0.0.1',
        port: chain.udpPort,
        seconds: opt.seconds,
        window: opt.window,
        frame: opt.frame,
      });
      result = { ok: b.back > 0 && b.odd === 0, topology, ...b, view: '' };
    } finally {
      await chain.close();
    }
    await c.down().catch(() => undefined);
  }

  if (opt.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `topology     : ${result.topology}\n` +
        `round-trip   : ${result.back} x ${result.frame} B in ${Number(result.seconds).toFixed(2)}s\n` +
        `goodput      : ${result.mbps.toFixed(1)} Mbps (${(result.mbps / 8).toFixed(1)} MB/s payload)\n` +
        `odd-sized    : ${result.odd}\n` +
        `threshold    : 75 Mbps -> ${result.mbps >= 75 ? 'PASS' : 'BELOW'}\n`,
    );
  }
  return result.ok ? 0 : 1;
}

async function cmdSelftest(mods) {
  let failures = 0;
  const say = (name, ok, detail = '') => {
    if (!ok) failures++;
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}\n`);
  };

  // 1) the unit suites (ports, wire codec, zip, messages, platform).
  const testDir = path.join(appRoot, 'dist', 'test');
  if (existsSync(testDir)) {
    const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', path.join(testDir, '*.test.js')], {
      encoding: 'utf8',
      cwd: appRoot,
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    // Node's default reporter prints "ℹ pass 75"; TAP mode prints "# pass 75".
    const count = (label) => (out.match(new RegExp(`^(?:#|ℹ)\\s*${label} (\\d+)`, 'm')) ?? [])[1] ?? '?';
    say('unit suites', r.status === 0, `pass=${count('pass')} fail=${count('fail')}`);
    if (r.status !== 0) process.stdout.write(out.split('\n').filter((l) => /not ok|Error|✖/.test(l)).join('\n') + '\n');
  } else {
    say('unit suites', false, `missing ${testDir} (npm run build)`);
  }

  // 2) loopback interop with the C relay, both directions of the wire.
  const { startLoopbackChain, runBench } = mods.benchMod;
  if (!existsSync(C_BIN)) {
    say('loopback interop', false, `C relay ${C_BIN} not built (c-relay/build.sh)`);
  } else {
    const combos = [
      { name: 'node host  <- C device', hostImpl: 'node', deviceImpl: 'c', echoImpl: 'c' },
      { name: 'C host     <- node device', hostImpl: 'c', deviceImpl: 'node', echoImpl: 'node' },
    ];
    for (const combo of combos) {
      let chain;
      try {
        chain = await startLoopbackChain({ ...combo, cBin: C_BIN, log: () => {} });
        const b = await runBench({ host: '127.0.0.1', port: chain.udpPort, seconds: 2, window: 1024 });
        const ok = b.back > 0 && b.odd === 0;
        say(combo.name, ok, `${b.back} datagrams, ${b.mbps.toFixed(0)} Mbps, ${b.odd} odd-sized`);
      } catch (e) {
        say(combo.name, false, e.message);
      } finally {
        if (chain) await chain.close();
      }
    }
  }

  process.stdout.write(failures === 0 ? 'SELFTEST PASS\n' : `SELFTEST FAIL (${failures})\n`);
  return failures === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------- main

async function main() {
  const mods = await loadAll();
  serviceInit(mods);

  if (opt.serve) return cmdServe(mods);
  if (opt.down) return cmdDown(mods);
  if (opt.reap) return cmdReap(mods);
  if (opt.selftest) return cmdSelftest(mods);
  if (opt.bench) return cmdBench(mods);
  if (opt.up) return cmdUp(mods);
  return cmdState(mods);
}

let ctrl;
process.on('SIGINT', () => {
  if (opt.serve) return; // the service has its own SIGINT handler: it must clean up first
  process.stderr.write('\nEther: interrupted, restoring\n');
  const done = ctrl ? ctrl.down().catch(() => undefined) : Promise.resolve();
  done.finally(() => process.exit(130));
});

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(`Ether: ${e?.stack ?? e}\n`);
    process.exit(1);
  });
