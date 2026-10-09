// relay.ts — the Node side of the UDP⇄TCP bridge.
//
// This is a line-by-line port of `udp2tcp.c`'s two runtime roles.  The wire
// format and the queueing semantics are a *contract* (§13.3):
// the Node host relay has to interoperate with the C ELF on the tablet, so any
// "improvement" here is a bug there.
//
// The two JS-only traps the plan calls out, and how they are handled:
//
//   1. `socket.write()` keeps buffering without bound after it returns false.
//      A relay must drop instead of queueing forever, so every TCP write goes
//      through `writeFrame()`, which compares `socket.writableLength` against
//      the queue budget and tail-drops the WHOLE frame (never a fragment).
//   2. A connected UDP socket reports an ICMP port-unreachable (Sunshine not
//      running yet) asynchronously as an `'error'` event.  Without a handler
//      that swallows ECONNREFUSED, the whole main process dies.

import dgram from 'node:dgram';
import net from 'node:net';

export const MAXFRAME = 65535;
export const RBUF_SIZE = 2 + MAXFRAME;
export const MAXPEER = 8;
export const DEFAULT_QUEUE = 256 * 1024;
export const DEFAULT_SNDBUF = 512 * 1024;
export const UDP_RCVBUF = 1 << 20;
export const UDP_BENCH_RCVBUF = 4 << 20;

export interface RelayStats {
  datagrams: number;
  bytes: number;
  dropped: number;
  peers: number;
}

export interface Relay {
  stats(): RelayStats;
  close(): Promise<void>;
}

export class Counters {
  datagrams = 0;
  bytes = 0;
  dropped = 0;
  /** frames absorbed from the UDP side, and sent towards the UDP side */
  toUdp = 0;
}

/** Errors that mean "try again later", not "this channel is broken". */
export function isRetryableUdpError(err: NodeJS.ErrnoException | null | undefined): boolean {
  const c = err?.code;
  return (
    c === 'ECONNREFUSED' ||
    c === 'EAGAIN' ||
    c === 'EWOULDBLOCK' ||
    c === 'EINTR' ||
    c === 'ENETUNREACH' ||
    c === 'EHOSTUNREACH'
  );
}

export function frameEncode(payload: Buffer): Buffer {
  const frame = Buffer.allocUnsafe(2 + payload.length);
  frame.writeUInt16BE(payload.length, 0);
  payload.copy(frame, 2);
  return frame;
}

/**
 * Bounded TCP send queue: a frame that does not fit whole is dropped whole.
 * Mirrors `txq_enqueue()` + `txq_flush()` from udp2tcp.c 176-223.
 */
export function writeFrame(
  sock: net.Socket,
  payload: Buffer,
  queueBytes: number,
  counters: Counters,
): boolean {
  if (sock.destroyed || !sock.writable) return false;
  const total = payload.length + 2;
  if (sock.writableLength + total > queueBytes) {
    counters.dropped++;
    return false;
  }
  sock.write(frameEncode(payload));
  return true;
}

/**
 * Reassembles `[u16 BE len][payload]` frames from a byte stream, preserving
 * datagram boundaries.  `onFrame` returning false kills the peer, as does a
 * buffer that fills up without yielding a frame (desync).
 */
export class FrameReader {
  private readonly buf = Buffer.allocUnsafe(RBUF_SIZE);
  private len = 0;

  constructor(private readonly onFrame: (payload: Buffer) => boolean) {}

  feed(chunk: Buffer): boolean {
    let off = 0;
    for (;;) {
      while (this.len >= 2) {
        const n = (this.buf[0]! << 8) | this.buf[1]!;
        if (n === 0) {
          // Defensive: the C implementation tolerates zero-length frames and
          // never sends them.  Tolerate, but never use as a heartbeat.
          this.consume(2);
          continue;
        }
        if (this.len < 2 + n) break;
        const payload = Buffer.from(this.buf.subarray(2, 2 + n));
        this.consume(2 + n);
        if (!this.onFrame(payload)) return false;
      }
      if (off >= chunk.length) return true;
      if (this.len === RBUF_SIZE) return false; // desynced framing
      const n = Math.min(RBUF_SIZE - this.len, chunk.length - off);
      chunk.copy(this.buf, this.len, off, off + n);
      this.len += n;
      off += n;
    }
  }

  get pending(): number {
    return this.len;
  }

  private consume(n: number): void {
    this.buf.copyWithin(0, n, this.len);
    this.len -= n;
  }
}

function tuneUdpBuffers(sock: dgram.Socket, log: (l: string) => void, size = UDP_RCVBUF): void {
  try {
    sock.setRecvBufferSize(size);
    sock.setSendBufferSize(size);
  } catch (e) {
    // Not fatal: the OS may cap it.  Record it and carry on (§13.3).
    log(`[relay] udp buffer tune skipped: ${(e as Error).message}`);
  }
}

function attachUdpErrorHandler(sock: dgram.Socket, log: (l: string) => void, onFatal?: () => void): void {
  sock.on('error', (err: NodeJS.ErrnoException) => {
    if (isRetryableUdpError(err)) return; // e.g. Sunshine not listening yet
    log(`[relay] udp error: ${err.code ?? ''} ${err.message}`);
    onFatal?.();
  });
}

// --------------------------------------------------------------- host role

export interface HostRelayOpts {
  tcpListen: number;
  udpConnect: { host: string; port: number };
  queueBytes?: number;
  sndbufBytes?: number;
  onLog?: (l: string) => void;
}

interface Peer {
  sock: net.Socket;
  reader: FrameReader;
  udp?: dgram.Socket;
  key?: string;
  port?: number;
  address?: string;
  closing: boolean;
}

export class HostRelay implements Relay {
  private readonly peers = new Set<Peer>();
  private readonly counters = new Counters();
  private readonly queueBytes: number;
  private readonly log: (l: string) => void;
  private closed = false;

  private constructor(
    private readonly server: net.Server,
    private readonly opts: HostRelayOpts,
  ) {
    this.queueBytes = opts.queueBytes ?? DEFAULT_QUEUE;
    this.log = opts.onLog ?? (() => {});
  }

  static start(o: HostRelayOpts): Promise<HostRelay> {
    return new Promise((resolve, reject) => {
      const server = net.createServer({ allowHalfOpen: false });
      server.maxConnections = MAXPEER;
      const relay = new HostRelay(server, o);

      server.once('error', (err) => reject(err));
      server.listen(o.tcpListen, '127.0.0.1', () => {
        server.removeAllListeners('error');
        server.on('error', (err) => relay.log(`[host] server error: ${err.message}`));
        server.on('connection', (sock) => relay.accept(sock));
        relay.log(
          `[host] tcp 127.0.0.1:${o.tcpListen} -> udp ${o.udpConnect.host}:${o.udpConnect.port} (queue=${relay.queueBytes})`,
        );
        resolve(relay);
      });
    });
  }

  private accept(sock: net.Socket): void {
    if (this.peers.size >= MAXPEER) {
      this.log('[host] peer table full, dropping connection');
      sock.destroy();
      return;
    }
    sock.setNoDelay(true);
    // Node cannot set SO_SNDBUF on a net.Socket; note it once, do not fail (§13.3).
    void (this.opts.sndbufBytes ?? DEFAULT_SNDBUF);

    const peer: Peer = {
      sock,
      closing: false,
      reader: new FrameReader((payload) => {
        // tunnel -> Sunshine
        const udp = peer.udp;
        if (!udp) return true;
        udp.send(payload, (err) => {
          if (err && !isRetryableUdpError(err)) this.destroyPeer(peer);
        });
        this.counters.toUdp++;
        return true;
      }),
    };

    // One UDP socket per accepted TCP connection: Sunshine learns each stream's
    // peer address from that stream's own ping (§13.3 — skip this and only the
    // first stream ever works).
    const udp = dgram.createSocket('udp4');
    peer.udp = udp;
    attachUdpErrorHandler(udp, this.log, () => this.destroyPeer(peer));
    udp.connect(this.opts.udpConnect.port, this.opts.udpConnect.host, () => {
      // After connect(), not before: a dgram socket has no fd until it is bound or
      // connected, and setRecvBufferSize on a socket without an fd throws EBADF —
      // which is how §13.3's 1 MiB stayed a comment instead of a setsockopt.
      tuneUdpBuffers(udp, this.log);
      this.log(`[host] tunnel up -> udp ${this.opts.udpConnect.host}:${this.opts.udpConnect.port}`);
    });
    udp.on('message', (msg) => {
      // Sunshine -> tunnel
      this.counters.datagrams++;
      this.counters.bytes += msg.length;
      writeFrame(peer.sock, msg, this.queueBytes, this.counters);
    });

    sock.on('data', (chunk) => {
      if (!peer.reader.feed(chunk)) this.destroyPeer(peer);
    });
    sock.on('error', () => this.destroyPeer(peer));
    sock.on('close', () => this.destroyPeer(peer));

    this.peers.add(peer);
  }

  private destroyPeer(peer: Peer): void {
    if (peer.closing) return;
    peer.closing = true;
    this.peers.delete(peer);
    try {
      peer.udp?.close();
    } catch {
      /* ignore */
    }
    peer.sock.destroy();
  }

  stats(): RelayStats {
    return {
      datagrams: this.counters.datagrams,
      bytes: this.counters.bytes,
      dropped: this.counters.dropped,
      peers: this.peers.size,
    };
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    for (const p of [...this.peers]) this.destroyPeer(p);
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

export function startHostRelay(o: HostRelayOpts): Promise<Relay> {
  return HostRelay.start(o);
}

// ------------------------------------------------------------- device role

export interface DeviceRelayOpts {
  udpListen: number;
  tcpConnect: number;
  queueBytes?: number;
  onLog?: (l: string) => void;
}

export class DeviceRelay implements Relay {
  private readonly peers = new Map<string, Peer>();
  private readonly counters = new Counters();
  private readonly queueBytes: number;
  private readonly log: (l: string) => void;
  private closed = false;

  private constructor(
    private readonly udp: dgram.Socket,
    private readonly opts: DeviceRelayOpts,
  ) {
    this.queueBytes = opts.queueBytes ?? DEFAULT_QUEUE;
    this.log = opts.onLog ?? (() => {});
  }

  static start(o: DeviceRelayOpts): Promise<DeviceRelay> {
    return new Promise((resolve, reject) => {
      const udp = dgram.createSocket('udp4');
      const relay = new DeviceRelay(udp, o);
      udp.once('error', (err) => reject(err));
      udp.bind(o.udpListen, '127.0.0.1', () => {
        // Bound first, tuned second (see the host relay: an unbound dgram socket
        // has no fd, so the setsockopt would fail with EBADF).
        tuneUdpBuffers(udp, relay.log);
        udp.removeAllListeners('error');
        attachUdpErrorHandler(udp, relay.log, () => relay.destroyAll());
        udp.on('message', (msg, rinfo) => relay.fromUdp(msg, rinfo));
        relay.log(
          `[device] udp 127.0.0.1:${o.udpListen} -> tcp 127.0.0.1:${o.tcpConnect} (queue=${relay.queueBytes})`,
        );
        resolve(relay);
      });
    });
  }

  private fromUdp(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    const key = `${rinfo.address}:${rinfo.port}`;
    let peer = this.peers.get(key);
    if (!peer) {
      if (this.peers.size >= MAXPEER) return; // all slots busy: drop
      peer = this.newPeer(key, rinfo);
    }
    this.counters.datagrams++;
    this.counters.bytes += msg.length;
    writeFrame(peer.sock, msg, this.queueBytes, this.counters);
  }

  private newPeer(key: string, rinfo: dgram.RemoteInfo): Peer {
    const sock = net.connect({ host: '127.0.0.1', port: this.opts.tcpConnect });
    sock.setNoDelay(true);
    const peer: Peer = {
      sock,
      closing: false,
      key,
      address: rinfo.address,
      port: rinfo.port,
      reader: new FrameReader((payload) => {
        // tunnel -> tablet
        this.udp.send(payload, peer.port!, peer.address!, (err) => {
          if (err && !isRetryableUdpError(err)) this.destroyPeer(peer);
        });
        this.counters.toUdp++;
        return true;
      }),
    };
    // A failed connect is retryable, not fatal: drop the slot so the next
    // datagram from this source starts a fresh attempt (C: ECONNREFUSED retry).
    sock.on('error', (err: NodeJS.ErrnoException) => {
      if (!isRetryableUdpError(err) && err.code !== 'ECONNREFUSED') {
        this.log(`[device] peer ${key} error: ${err.message}`);
      }
      this.destroyPeer(peer);
    });
    sock.on('close', () => this.destroyPeer(peer));
    sock.on('data', (chunk) => {
      if (!peer.reader.feed(chunk)) this.destroyPeer(peer);
    });
    sock.on('connect', () => this.log(`[device] new client ${key}`));
    this.peers.set(key, peer);
    return peer;
  }

  private destroyPeer(peer: Peer): void {
    if (peer.closing) return;
    peer.closing = true;
    if (peer.key !== undefined) this.peers.delete(peer.key);
    peer.sock.destroy();
  }

  private destroyAll(): void {
    for (const p of [...this.peers.values()]) this.destroyPeer(p);
  }

  stats(): RelayStats {
    return {
      datagrams: this.counters.datagrams,
      bytes: this.counters.bytes,
      dropped: this.counters.dropped,
      peers: this.peers.size,
    };
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.destroyAll();
    return new Promise((resolve) => {
      try {
        this.udp.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

}

export function startDeviceRelay(o: DeviceRelayOpts): Promise<Relay> {
  return DeviceRelay.start(o);
}

// -------------------------------------------------------------- udp echo

export interface UdpEcho extends Relay {
  port: number;
}

/** Stand-in for Sunshine: echo every datagram straight back to its sender. */
export function startUdpEcho(port = 0): Promise<UdpEcho> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const counters = new Counters();
    sock.once('error', (err) => reject(err));
    sock.bind(port, '127.0.0.1', () => {
      // Bound first, tuned second: an unbound dgram socket has no fd to setsockopt.
      tuneUdpBuffers(sock, () => {}, UDP_BENCH_RCVBUF);
      sock.removeAllListeners('error');
      attachUdpErrorHandler(sock, () => {});
      sock.on('message', (msg, rinfo) => {
        counters.datagrams++;
        counters.bytes += msg.length;
        sock.send(msg, rinfo.port, rinfo.address);
      });
      const addr = sock.address();
      resolve({
        port: typeof addr === 'object' && addr ? addr.port : port,
        stats: () => ({
          datagrams: counters.datagrams,
          bytes: counters.bytes,
          dropped: counters.dropped,
          peers: 0,
        }),
        close: () =>
          new Promise<void>((r) => {
            try {
              sock.close(() => r());
            } catch {
              r();
            }
          }),
      });
    });
  });
}
