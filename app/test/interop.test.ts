// interop.test.ts — the M0 acceptance hard metrics (§13.4 #5, §13.8):
// the Node relay and the C relay must speak the *same* wire format, in both
// directions, with zero drops.  A loopback chain is enough to prove it and needs
// no tablet, which is why it can run in CI.
//
// The chain is: sender -> device relay -> host relay -> echo, and back.
// Swapping either role for the C binary is what makes this an interop test
// rather than a unit test — a private wire format would fail immediately.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runBench, startLoopbackChain } from '../src/main/bench.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = path.resolve(appRoot, '..');
const cBin = process.env.ETHER_C_BIN ?? path.join(repoRoot, 'c-relay', 'udp2tcp');
const haveC = existsSync(cBin);
const skip = haveC ? false : `C relay not built at ${cBin} (run c-relay/build.sh)`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('node host <- node device: the chain itself carries datagrams intact', async () => {
  const chain = await startLoopbackChain({ hostImpl: 'node', deviceImpl: 'node', echoImpl: 'node' });
  try {
    const r = await runBench({ host: '127.0.0.1', port: chain.udpPort, seconds: 1, window: 256 });
    await sleep(50);
    assert.ok(r.back > 0, 'nothing came back through the chain');
    assert.equal(r.odd, 0, 'datagram boundaries were not preserved');
    assert.equal(r.silence, false);
    assert.equal(chain.hostStats().dropped, 0);
    assert.equal(chain.deviceStats().dropped, 0);
  } finally {
    await chain.close();
  }
});

test('node host <- C device: the frozen wire format, C -> Node', { skip }, async () => {
  const chain = await startLoopbackChain({
    hostImpl: 'node',
    deviceImpl: 'c',
    echoImpl: 'c',
    cBin,
  });
  try {
    const r = await runBench({ host: '127.0.0.1', port: chain.udpPort, seconds: 2, window: 512 });
    await sleep(50);
    assert.ok(r.back > 0, 'C device relay produced no round trip through the Node host relay');
    assert.equal(r.odd, 0);
    assert.equal(chain.hostStats().dropped, 0, 'Node host relay dropped frames that came from C');
  } finally {
    await chain.close();
  }
});

test('C host <- node device: the frozen wire format, Node -> C', { skip }, async () => {
  const chain = await startLoopbackChain({
    hostImpl: 'c',
    deviceImpl: 'node',
    echoImpl: 'node',
    cBin,
  });
  try {
    const r = await runBench({ host: '127.0.0.1', port: chain.udpPort, seconds: 2, window: 512 });
    await sleep(50);
    assert.ok(r.back > 0, 'Node device relay produced no round trip through the C host relay');
    assert.equal(r.odd, 0);
    assert.equal(chain.deviceStats().dropped, 0, 'Node device relay dropped frames that came from C');
  } finally {
    await chain.close();
  }
});

test('the C self-test still passes with its dynamic ports (§13.4 #5 prerequisite)', { skip }, async () => {
  // The four phase lines and TEST PASS go to stdout (§13.4 #5); the
  // "[test] ports …" line is the §3.3 dynamic-port announcement, and the C code
  // writes every diagnostic to stderr, so both streams are read here.
  const r = spawnSync(cBin, ['--test'], { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 << 20 });
  const out = r.stdout ?? '';
  const err = r.stderr ?? '';
  assert.equal(r.status, 0, `C self-test exited ${r.status} (signal ${r.signal})\n${err}`);
  assert.match(out, /TEST PASS/);
  assert.match(err, /\[test\] ports host=\d+ device=\d+ echo=\d+/);
  const ports = (err.match(/\[test\] ports host=(\d+) device=(\d+) echo=(\d+)/) ?? []).slice(1).map(Number);
  assert.equal(new Set(ports).size, 3, 'the three self-test ports must be distinct');
});
