// devwatch.test.ts — the adb server as an event source, tested against a stand-in server.
//
// `host:track-devices` is a real protocol with a real handshake (`OKAY`, then frames of
// four hex digits of length and that many bytes of text), so this file speaks it over a
// real loopback socket rather than mocking `net`: what the app is trusting here is the
// wire format and the failure shapes, and both are things a mock would get to invent.
//
// The failure half is the half that matters.  A watch that cannot attach must be a
// *reported* state — the caller's fallback tick is only worth having if it is told.
//
// Nothing needs adb, a tablet or a window: the stand-in server is the adb server.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { adbServerTarget, DeviceWatch } from '../src/main/devwatch.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(fn: () => boolean, ms = 2000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return true;
    await sleep(5);
  }
  return false;
}

/** The wire format, in one place: 4 hex digits of length, then the text. */
function frame(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  return Buffer.concat([Buffer.from(body.length.toString(16).padStart(4, '0'), 'latin1'), body]);
}

interface FakeAdbServer {
  port: number;
  /** Every request that arrived, verbatim (the app sends `0018host:track-devices`). */
  requests: string[];
  /** Live connections, newest last. */
  clients: net.Socket[];
  /** Answer a connection like the adb server does: `OKAY`, then the current device list. */
  push(text: string): void;
  close(): Promise<void>;
}

/** A stand-in adb server: it accepts, answers `OKAY` to whatever arrives, and lets the
 *  test write the device lists. */
async function fakeAdbServer(opts: { list?: string; onRequest?: (sock: net.Socket) => void } = {}): Promise<FakeAdbServer> {
  const requests: string[] = [];
  const clients: net.Socket[] = [];
  const server = net.createServer((sock) => {
    clients.push(sock);
    sock.on('data', (d) => {
      requests.push(d.toString('latin1'));
      if (opts.onRequest) return opts.onRequest(sock);
      // The real server's answer to a host service it knows: `OKAY`, then the current
      // list without being asked twice.
      sock.write(Buffer.concat([Buffer.from('OKAY', 'latin1'), frame(opts.list ?? '')]));
    });
    sock.on('error', () => undefined);
    sock.on('close', () => {
      const i = clients.indexOf(sock);
      if (i >= 0) clients.splice(i, 1);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (typeof addr !== 'object' || addr === null) throw new Error('no address');
  return {
    port: addr.port,
    requests,
    clients,
    push: (text) => {
      for (const c of clients) c.write(frame(text));
    },
    close: () =>
      new Promise<void>((r) => {
        for (const c of clients) c.destroy();
        server.close(() => r());
      }),
  };
}

// ── where the server is ─────────────────────────────────────────────────────

test('the adb server is found the way the adb client finds it', () => {
  // The defaults: loopback, 5037.
  assert.deepEqual(adbServerTarget({}, 'linux'), { host: '127.0.0.1', port: 5037 });

  // `ANDROID_ADB_SERVER_PORT` is the client's own variable — it is the same server, so it
  // is the same answer, and a machine that moved adb off 5037 still gets an event source.
  assert.deepEqual(adbServerTarget({ ANDROID_ADB_SERVER_PORT: '5038' }, 'linux'), { host: '127.0.0.1', port: 5038 });
  assert.equal(adbServerTarget({ ANDROID_ADB_SERVER_PORT: 'not a port' }, 'linux'), undefined);
  assert.equal(adbServerTarget({ ANDROID_ADB_SERVER_PORT: '70000' }, 'linux'), undefined);

  // `ADB_SERVER_SOCKET` wins over the port, in each of the forms adb documents.
  assert.deepEqual(
    adbServerTarget({ ADB_SERVER_SOCKET: 'tcp:5137', ANDROID_ADB_SERVER_PORT: '5038' }, 'linux'),
    { host: '127.0.0.1', port: 5137 },
  );
  assert.deepEqual(adbServerTarget({ ADB_SERVER_SOCKET: 'tcp:10.0.0.2:5137' }, 'linux'), { host: '10.0.0.2', port: 5137 });
  assert.deepEqual(adbServerTarget({ ADB_SERVER_SOCKET: 'unix:/tmp/adb.sock' }, 'linux'), { path: '/tmp/adb.sock' });
  assert.deepEqual(adbServerTarget({ ADB_SERVER_SOCKET: 'localabstract:adb-1' }, 'linux'), { path: '\0adb-1' });

  // A Windows named pipe is not something node:net can open, so this is "no event source",
  // which the caller reads as "poll, as before" — never as an error.
  assert.equal(adbServerTarget({ ADB_SERVER_SOCKET: '\\\\.\\pipe\\adb' }, 'win32'), undefined);
  assert.equal(adbServerTarget({ ADB_SERVER_SOCKET: 'localabstract:adb-1' }, 'win32'), undefined);
});

// ── the stream ──────────────────────────────────────────────────────────────

test('the device list arrives as a callback: once on attach, then once per change', async () => {
  const server = await fakeAdbServer({ list: '' });
  const seen: boolean[] = [];
  const log: string[] = [];
  const watch = new DeviceWatch({ env: { ANDROID_ADB_SERVER_PORT: String(server.port) }, log: (l) => log.push(l), retryMs: 5 });
  try {
    watch.start((live) => seen.push(live));

    // The request adb's own client would send: length-prefixed, and nothing else.
    assert.ok(await waitFor(() => server.requests.length > 0), 'the watch must ask the server');
    assert.equal(server.requests[0], '0012host:track-devices');

    // The first frame is the current list, and it arrives without a tick of any kind.
    assert.ok(await waitFor(() => seen.length === 1), `the current list must be pushed: ${log.join('\n')}`);
    assert.deepEqual(seen, [true]);
    assert.equal(watch.connected, true);
    assert.equal(watch.devices, '');

    // A cable, an authorization tap, a device going offline: one frame each, and each one
    // is `true` — "ask again", not "here is the answer".
    server.push('HA2HS0KT\tdevice product:TB375FC model:TB375FC transport_id:2\n');
    assert.ok(await waitFor(() => seen.length === 2));
    assert.equal(watch.devices, 'HA2HS0KT\tdevice product:TB375FC model:TB375FC transport_id:2\n');

    server.push('');
    assert.ok(await waitFor(() => seen.length === 3));
    assert.deepEqual(seen, [true, true, true]);
    assert.equal(watch.devices, '');

    // One line, on the way up: the window's log is for the user, not a heartbeat.
    assert.equal(log.filter((l) => l.includes('attached')).length, 1);
  } finally {
    watch.stop();
    await server.close();
  }
});

test('a stream that dies is reported, and the watch attaches again', async () => {
  // The reported failure is the whole point of the `false`: the caller's tick is the
  // fallback, and it cannot be the fallback if it is never told the fast path is gone.
  const server = await fakeAdbServer({ list: 'HA2HS0KT\tdevice\n' });
  const seen: boolean[] = [];
  const watch = new DeviceWatch({ env: { ANDROID_ADB_SERVER_PORT: String(server.port) }, log: () => undefined, retryMs: 10 });
  try {
    watch.start((live) => seen.push(live));
    assert.ok(await waitFor(() => seen.length === 1));
    assert.equal(watch.connected, true);

    // The server goes away — `kill-server`, a crash, the machine quitting.
    server.clients[0]?.destroy();
    assert.ok(await waitFor(() => seen.length === 2), 'a dead stream must be reported');
    assert.deepEqual(seen, [true, false]);
    assert.equal(watch.connected, false);

    // …and it comes back.  A watch that gave up after one outage would leave the app
    // waiting for a tablet that had already arrived.
    assert.ok(await waitFor(() => server.requests.length >= 2, 2000), 'the watch must attach again');
    assert.ok(await waitFor(() => seen.length === 3), 'and report the list it finds');
    assert.deepEqual(seen, [true, false, true]);
    assert.equal(watch.devices, 'HA2HS0KT\tdevice\n');
  } finally {
    watch.stop();
    await server.close();
  }
});

test('a server that refuses the service is not a device stream, and is not retried in a loop of lies', async () => {
  const server = await fakeAdbServer({
    onRequest: (sock) => {
      const msg = Buffer.from('unknown host service', 'utf8');
      sock.write(Buffer.concat([Buffer.from('FAIL', 'latin1'), Buffer.from(msg.length.toString(16).padStart(4, '0'), 'latin1'), msg]));
    },
  });
  const seen: boolean[] = [];
  const log: string[] = [];
  const watch = new DeviceWatch({ env: { ANDROID_ADB_SERVER_PORT: String(server.port) }, log: (l) => log.push(l), retryMs: 10 });
  try {
    watch.start((live) => seen.push(live));
    assert.ok(await waitFor(() => log.some((l) => l.includes('refused')), 2000), log.join('\n'));
    assert.deepEqual(seen, [], 'a refusal is never "live"');
    assert.equal(watch.connected, false);

    // It keeps trying (an adb that is being restarted is not an adb that is gone), but it
    // says so once: the log is the user's, not a status light.
    assert.ok(await waitFor(() => server.requests.length >= 2, 2000));
    assert.equal(log.filter((l) => l.includes('refused')).length, 1);
  } finally {
    watch.stop();
    await server.close();
  }
});

test('a machine with no adb server at all is a state, not an error', async () => {
  // Nothing is listening: the honest answer is "no events here", and the app must be no
  // worse off than it was before this module existed.
  const server = await fakeAdbServer();
  const port = server.port;
  await server.close();

  const seen: boolean[] = [];
  const log: string[] = [];
  const watch = new DeviceWatch({ env: { ANDROID_ADB_SERVER_PORT: String(port) }, log: (l) => log.push(l), retryMs: 5 });
  try {
    watch.start((live) => seen.push(live));
    await sleep(120);
    assert.deepEqual(seen, [], 'never live, so never a change to report');
    assert.equal(watch.connected, false);
    assert.equal(log.filter((l) => l.includes('asking the bus on a timer instead')).length, 1, log.join('\n'));
  } finally {
    watch.stop();
  }
});

test('stop() detaches: no socket, no retry, no more callbacks', async () => {
  const server = await fakeAdbServer({ list: 'HA2HS0KT\tdevice\n' });
  const seen: boolean[] = [];
  const watch = new DeviceWatch({ env: { ANDROID_ADB_SERVER_PORT: String(server.port) }, log: () => undefined, retryMs: 5 });
  try {
    watch.start((live) => seen.push(live));
    assert.ok(await waitFor(() => seen.length === 1));
    watch.stop();

    assert.ok(await waitFor(() => server.clients.length === 0), 'the socket must be closed');
    server.push('HA2HS0KT\tdevice\n'); // to nobody, and not a reason to call back
    const attaches = server.requests.length;
    await sleep(60);
    assert.deepEqual(seen, [true], 'no callback after stop');
    assert.equal(server.requests.length, attaches, 'and no attaching again');
  } finally {
    watch.stop();
    await server.close();
  }
});

test('a unix-socket server is watched the same way', { skip: process.platform === 'win32' ? 'no unix sockets' : false }, async () => {
  // `ADB_SERVER_SOCKET=unix:…` is how a machine runs adb off the loopback port, and the
  // watch has to follow the client there rather than assume 5037.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ether-devwatch-'));
  const sockPath = path.join(dir, 'adb.sock');
  const clients: net.Socket[] = [];
  const server = net.createServer((sock) => {
    clients.push(sock);
    sock.on('data', () => sock.write(Buffer.concat([Buffer.from('OKAY', 'latin1'), frame('HA2HS0KT\tdevice\n')])));
    sock.on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(sockPath, r));

  const seen: boolean[] = [];
  const watch = new DeviceWatch({ env: { ADB_SERVER_SOCKET: `unix:${sockPath}` }, log: () => undefined });
  try {
    watch.start((live) => seen.push(live));
    assert.ok(await waitFor(() => seen.length === 1), 'the unix socket is the server too');
    assert.equal(watch.devices, 'HA2HS0KT\tdevice\n');
  } finally {
    watch.stop();
    for (const c of clients) c.destroy();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});
