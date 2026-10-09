// reap.test.ts — the record we leave behind, and the sweep that survives losing
// it (§5.3, §13.4 #7).
//
// Only the portable half lives here (state.json round trip + the "nothing to do"
// path).  The tablet side and the port-ownership layer need a real device, and
// are covered by the M2 regression in §13.9.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  STATE_NAME,
  clearState,
  portOwners,
  readState,
  reapAll,
  statePath,
  writeState,
  type StateFile,
} from '../src/main/reap.js';

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'ether-reap-'));
}

const SAMPLE: StateFile = {
  pid: 12345,
  startedAt: '2024-01-01T00:00:00.000Z',
  serial: 'HA2HS0KT',
  tcpPorts: [47984, 47989, 47990, 48010],
  udpTunnels: [
    { sunshine: 47998, tunnel: 51001, pid: 4321 },
    { sunshine: 47999, tunnel: 51002 },
    { sunshine: 48000, tunnel: 51003, pid: 4322 },
  ],
  hostPids: [12345, 12346],
  elfRemote: '/data/local/tmp/udp2tcp',
};

test('state.json lives in the data dir under a fixed name', () => {
  assert.equal(STATE_NAME, 'state.json');
  assert.equal(statePath('/data'), path.join('/data', 'state.json'));
});

test('readState on a fresh data dir is undefined, not an exception', async () => {
  const dir = tmpDir();
  try {
    assert.equal(await readState(dir), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeState/readState round-trips every field the reap layers rely on', async () => {
  const dir = tmpDir();
  try {
    await writeState(dir, SAMPLE);
    assert.ok(existsSync(statePath(dir)));
    assert.deepEqual(await readState(dir), SAMPLE);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readState repairs a truncated or hostile state file instead of trusting it', async () => {
  const dir = tmpDir();
  try {
    await writeState(dir, { ...SAMPLE, udpTunnels: [], tcpPorts: [], hostPids: [] });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(statePath(dir), '{"pid":"not-a-number","tcpPorts":"nope"}');
    const s = await readState(dir);
    assert.equal(s?.pid, 0);
    assert.deepEqual(s?.tcpPorts, []);
    await writeFile(statePath(dir), 'not json at all');
    assert.equal(await readState(dir), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('clearState removes the record and is idempotent', async () => {
  const dir = tmpDir();
  try {
    await writeState(dir, SAMPLE);
    await clearState(dir);
    assert.ok(!existsSync(statePath(dir)));
    await clearState(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reapAll on a clean machine does nothing at all (every start is a no-op)', async () => {
  const dir = tmpDir();
  const logs: string[] = [];
  try {
    const report = await reapAll({ dataDir: dir, plat: 'linux', log: (l) => logs.push(l) });
    assert.deepEqual(report.hostPidsKilled, []);
    assert.deepEqual(report.reversesRemoved, []);
    assert.deepEqual(report.devicePidsKilled, []);
    assert.deepEqual(report.foreignPorts, []);
    assert.ok(!existsSync(statePath(dir)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reapAll never signals a pid it did not record, and records the platform limits', async () => {
  const dir = tmpDir();
  const logs: string[] = [];
  try {
    // A recorded pid that is not alive: nothing to kill, nothing to guess.
    await writeState(dir, { ...SAMPLE, pid: 0x7ffffff0, hostPids: [0x7ffffff0, 0x7ffffffe] });
    const report = await reapAll({ dataDir: dir, plat: 'darwin', log: (l) => logs.push(l) });
    assert.deepEqual(report.hostPidsKilled, []);
    assert.ok(report.notes.some((n) => n.includes('Linux-only')));
    assert.ok(!existsSync(statePath(dir)), 'the record must be cleared even when nothing was reaped');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('portOwners is Linux-only and says so by returning nothing elsewhere', async () => {
  assert.deepEqual(await portOwners([47989], [47998], 'darwin'), []);
  assert.deepEqual(await portOwners([47989], [47998], 'win32'), []);
  const linux = await portOwners([], [], 'linux');
  assert.deepEqual(linux, []);
});
