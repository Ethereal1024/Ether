// relay.test.ts — the wire format and the two roles, verbatim from §13.3.
//
// The format is frozen: `[u16 BE len][payload]`, `MAXFRAME` 65535, whole-frame
// tail drop.  A Node relay that is "close enough" would interop with the C ELF
// in the lab and fall apart under a real 4K stream, so these tests assert the
// exact numbers rather than a round trip that happens to work.

import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';
import { once } from 'node:events';
import { test } from 'node:test';
import {
  Counters,
  DEFAULT_QUEUE,
  FrameReader,
  MAXFRAME,
  MAXPEER,
  RBUF_SIZE,
  UDP_RCVBUF,
  frameEncode,
  isRetryableUdpError,
  startDeviceRelay,
  startHostRelay,
  startUdpEcho,
  writeFrame,
} from '../src/main/relay.js';
import { pickFreeTcpPort, pickFreeUdpPort } from '../src/main/ports.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal `net.Socket` stand-in: we need to control `writableLength` exactly. */
interface FakeSock {
  destroyed: boolean;
  writable: boolean;
  writableLength: number;
  written: Buffer[];
  write(b: Buffer): boolean;
}

function fakeSock(writableLength: number): FakeSock {
  return {
    destroyed: false,
    writable: true,
    writableLength,
    written: [],
    write(b: Buffer) {
      this.written.push(Buffer.from(b));
      return true;
    },
  };
}

test('the wire constants match the C implementation', () => {
  assert.equal(MAXFRAME, 65535);
  assert.equal(RBUF_SIZE, 2 + MAXFRAME);
  assert.equal(MAXPEER, 8);
  assert.equal(DEFAULT_QUEUE, 256 * 1024);
  assert.equal(UDP_RCVBUF, 1 << 20);
});

test('the 1 MiB receive buffer really reaches the kernel (§13.3)', async () => {
  // setRecvBufferSize() throws EBADF while a dgram socket has no fd — i.e. before
  // bind()/connect() — and the relay used to log exactly that and carry on, so the
  // 1 MiB of §13.3 was a comment instead of a setsockopt.  This test watches that
  // log line (both relays report to it) while a datagram is driven through them.
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  const echo = await startUdpEcho();
  const tcp = await pickFreeTcpPort();
  const udp = await pickFreeUdpPort();
  const host = await startHostRelay({
    tcpListen: tcp,
    udpConnect: { host: '127.0.0.1', port: echo.port },
    onLog: log,
  });
  // The host relay only sizes its UDP socket once a peer connects, so connect one.
  const device = await startDeviceRelay({ udpListen: udp, tcpConnect: tcp, onLog: log });
  const client = dgram.createSocket('udp4');
  try {
    const back = once(client, 'message');
    client.send(Buffer.from('tune', 'utf8'), udp, '127.0.0.1');
    await back;
  } finally {
    client.close();
    await sleep(50);
    await device.close();
    await host.close();
    await echo.close();
  }
  const skipped = lines.filter((l) => l.includes('udp buffer tune skipped'));
  assert.deepEqual(skipped, [], `buffer sizing never happened: ${skipped.join(' | ')}`);
});

test('frameEncode is a big-endian u16 length followed by the payload', () => {
  const frame = frameEncode(Buffer.from('moon', 'utf8'));
  assert.deepEqual([...frame], [0, 4, 0x6d, 0x6f, 0x6f, 0x6e]);
  const max = frameEncode(Buffer.alloc(MAXFRAME));
  assert.equal(max.length, RBUF_SIZE);
  assert.equal(max.readUInt16BE(0), MAXFRAME);
});

test('FrameReader reassembles frames across arbitrary chunk boundaries', () => {
  const seen: string[] = [];
  const r = new FrameReader((p) => {
    seen.push(p.toString('utf8'));
    return true;
  });
  const stream = Buffer.concat([
    frameEncode(Buffer.from('one', 'utf8')),
    frameEncode(Buffer.from('two-longer', 'utf8')),
  ]);
  for (let i = 0; i < stream.length; i++) assert.equal(r.feed(stream.subarray(i, i + 1)), true);
  assert.deepEqual(seen, ['one', 'two-longer']);
  assert.equal(r.pending, 0);
});

test('FrameReader keeps a partial frame until the rest arrives', () => {
  const seen: Buffer[] = [];
  const r = new FrameReader((p) => {
    seen.push(p);
    return true;
  });
  const frame = frameEncode(Buffer.from('partial', 'utf8'));
  assert.equal(r.feed(frame.subarray(0, 4)), true);
  assert.equal(seen.length, 0);
  assert.equal(r.feed(frame.subarray(4)), true);
  assert.deepEqual(seen.map((b) => b.toString('utf8')), ['partial']);
});

test('FrameReader tolerates a zero-length frame (C never sends one)', () => {
  const seen: Buffer[] = [];
  const r = new FrameReader((p) => {
    seen.push(p);
    return true;
  });
  assert.equal(r.feed(Buffer.from([0, 0])), true);
  assert.equal(r.feed(frameEncode(Buffer.from('after', 'utf8'))), true);
  assert.deepEqual(seen.map((b) => b.toString('utf8')), ['after']);
});

test('FrameReader stops the peer when onFrame says the channel is broken', () => {
  let calls = 0;
  const r = new FrameReader(() => {
    calls++;
    return false;
  });
  assert.equal(r.feed(Buffer.concat([frameEncode(Buffer.from('x')), frameEncode(Buffer.from('y'))])), false);
  assert.equal(calls, 1);
});

test('writeFrame drops a frame whole rather than splitting it (§13.3)', () => {
  const payload = Buffer.alloc(1200);
  const counters = new Counters();

  // Room for exactly one byte less than the frame: the whole thing goes.
  const full = fakeSock(DEFAULT_QUEUE - 1201);
  assert.equal(writeFrame(full as unknown as net.Socket, payload, DEFAULT_QUEUE, counters), false);
  assert.equal(full.written.length, 0);
  assert.equal(counters.dropped, 1);

  // Exact fit still goes through.
  const exact = fakeSock(DEFAULT_QUEUE - 1202);
  assert.equal(writeFrame(exact as unknown as net.Socket, payload, DEFAULT_QUEUE, counters), true);
  assert.equal(exact.written.length, 1);
  assert.equal(exact.written[0]!.readUInt16BE(0), 1200);
  assert.equal(counters.dropped, 1);

  // A dead socket is not a drop, it is a closed channel.
  const dead = fakeSock(0);
  dead.destroyed = true;
  assert.equal(writeFrame(dead as unknown as net.Socket, payload, DEFAULT_QUEUE, counters), false);
  assert.equal(counters.dropped, 1);
});

test('isRetryableUdpError swallows the asynchronous ICMP/unreachable family', () => {
  for (const code of ['ECONNREFUSED', 'EAGAIN', 'EWOULDBLOCK', 'EINTR', 'ENETUNREACH', 'EHOSTUNREACH']) {
    assert.equal(isRetryableUdpError(Object.assign(new Error('x'), { code })), true, code);
  }
  assert.equal(isRetryableUdpError(Object.assign(new Error('x'), { code: 'EACCES' })), false);
  assert.equal(isRetryableUdpError(null), false);
  assert.equal(isRetryableUdpError(undefined), false);
});

test('host relay carries a raw [len][payload] frame to the echo and back', async () => {
  const echo = await startUdpEcho();
  const tcp = await pickFreeTcpPort();
  const host = await startHostRelay({
    tcpListen: tcp,
    udpConnect: { host: '127.0.0.1', port: echo.port },
  });
  const sock = net.connect({ host: '127.0.0.1', port: tcp });
  try {
    await once(sock, 'connect');
    const payload = Buffer.from('hello-sunshine', 'utf8');
    const got = new Promise<Buffer>((resolve) => {
      const reader = new FrameReader((p) => {
        resolve(p);
        return true;
      });
      sock.on('data', (c: Buffer) => reader.feed(c));
    });
    sock.write(frameEncode(payload));
    assert.deepEqual(await got, payload);
    assert.equal(host.stats().peers, 1);
    assert.equal(host.stats().dropped, 0);
  } finally {
    sock.destroy();
    await sleep(50);
    assert.equal(host.stats().peers, 0);
    await host.close();
    await echo.close();
  }
});

test('device relay opens one TCP connection per UDP source and echoes payloads intact', async () => {
  const echo = await startUdpEcho();
  const tcp = await pickFreeTcpPort();
  const udp = await pickFreeUdpPort();
  const host = await startHostRelay({
    tcpListen: tcp,
    udpConnect: { host: '127.0.0.1', port: echo.port },
  });
  const device = await startDeviceRelay({ udpListen: udp, tcpConnect: tcp });
  const client = dgram.createSocket('udp4');
  try {
    const payload = Buffer.from('round-trip-through-both-roles', 'utf8');
    const got = new Promise<Buffer>((resolve) => client.on('message', (m) => resolve(Buffer.from(m))));
    client.send(payload, udp, '127.0.0.1');
    assert.deepEqual(await got, payload);
    await sleep(50);
    assert.equal(host.stats().dropped, 0);
    assert.equal(device.stats().dropped, 0);
    assert.equal(device.stats().peers, 1);
  } finally {
    client.close();
    await device.close();
    await host.close();
    await echo.close();
  }
});

test('device relay keeps datagram boundaries for two different sources', async () => {
  const echo = await startUdpEcho();
  const tcp = await pickFreeTcpPort();
  const udp = await pickFreeUdpPort();
  const host = await startHostRelay({
    tcpListen: tcp,
    udpConnect: { host: '127.0.0.1', port: echo.port },
  });
  const device = await startDeviceRelay({ udpListen: udp, tcpConnect: tcp });
  const a = dgram.createSocket('udp4');
  const b = dgram.createSocket('udp4');
  try {
    const pa = new Promise<Buffer>((res) => a.on('message', (m) => res(Buffer.from(m))));
    const pb = new Promise<Buffer>((r) => b.on('message', (m) => r(Buffer.from(m))));
    a.send(Buffer.from('from-a'), udp, '127.0.0.1');
    b.send(Buffer.from('from-b'), udp, '127.0.0.1');
    assert.equal((await pa).toString('utf8'), 'from-a');
    assert.equal((await pb).toString('utf8'), 'from-b');
    await sleep(50);
    assert.equal(device.stats().peers, 2);
    assert.equal(host.stats().dropped, 0);
  } finally {
    a.close();
    b.close();
    await device.close();
    await host.close();
    await echo.close();
  }
});

test('startUdpEcho hands out a real bound port', async () => {
  const echo = await startUdpEcho(0);
  try {
    assert.ok(echo.port > 0);
    assert.equal(echo.stats().datagrams, 0);
  } finally {
    await echo.close();
  }
});
