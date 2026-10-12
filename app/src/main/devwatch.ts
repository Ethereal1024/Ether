// devwatch.ts — the adb bus as an event source, instead of a metronome
//
// "Connect by itself when the tablet appears" needs exactly one fact: *when* the device
// list changed.  Asking `adb devices` on a timer does answer that, but it pays for the
// answer every two seconds — it forks an adb client, wakes the adb server for a USB scan
// nobody asked for, and pushes a status into the window that says what the last one said.
//
// adb already has the push half of this.  `host:track-devices` is a *streaming* host
// service: one socket to the local adb server, one request, and the server writes the
// current device list straight away and a new one every time the bus changes.  This module
// is that socket — attach, read frames, notice when the server goes away, attach again.
//
// Deliberately not load-bearing.  No `ADB_SERVER_SOCKET` form we speak, no adb server
// running yet, a server socket this app may not open, an adb too old for the service: all
// of them are reported as "not live" (`false`), and the caller keeps its own tick.  The
// event source is the fast path, never the only path — the same reason the download is
// still there behind our own copy of adb.

import net from 'node:net';

/** Where the local adb server listens: TCP, or a socket on the file system. */
export type AdbServerTarget = { host: string; port: number } | { path: string };

/** adb's own default.  The *client* reads these same variables, and it is the same
 *  server we are talking to, so the watch reads them too rather than guessing 5037. */
export const DEFAULT_ADB_SERVER_PORT = 5037;

/**
 * The adb server this machine is using, from the variables the adb client honours:
 * `ADB_SERVER_SOCKET` when it is set — `tcp:[host:]port`, `unix:<path>`, or the Android
 * socket prefixes, which on a unix host are abstract or ordinary unix sockets — and
 * otherwise `127.0.0.1:$ANDROID_ADB_SERVER_PORT`, then adb's 5037.
 *
 * `undefined` means "no event source here" (a Windows named pipe, a value we cannot
 * parse, a nonsense port): the caller then reads it as "poll, as before", which is what
 * every platform did until this file existed — so returning `undefined` is never a
 * regression, it is just an older machine.
 */
export function adbServerTarget(
  env: NodeJS.ProcessEnv = process.env,
  plat: string = process.platform,
): AdbServerTarget | undefined {
  const raw = env.ADB_SERVER_SOCKET?.trim();
  if (raw) {
    const tcp = /^tcp:(?:([^:\s]+):)?(\d+)$/.exec(raw);
    if (tcp) {
      const port = Number(tcp[2]);
      return port > 0 && port <= 65535 ? { host: tcp[1] || '127.0.0.1', port } : undefined;
    }
    const file = /^(?:unix|localfilesystem):(.+)$/.exec(raw);
    if (file) return { path: file[1] };
    // Linux and macOS reach these through the *abstract* namespace, which is how a path
    // beginning with a NUL byte is addressed.  Windows has no such thing.
    const abstract = /^local(?:abstract|reserved):(.+)$/.exec(raw);
    if (abstract && plat !== 'win32') return { path: `\0${abstract[1]}` };
    return undefined;
  }
  const port = Number(env.ANDROID_ADB_SERVER_PORT || DEFAULT_ADB_SERVER_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  return { host: '127.0.0.1', port };
}

export interface DeviceWatchOpts {
  env?: NodeJS.ProcessEnv;
  plat?: string;
  log: (l: string) => void;
  /** How long to wait before attaching again while the server is out of reach.  A socket
   *  connect to a local server costs microseconds, so this is politeness (and it keeps a
   *  machine with no adb server from spinning), not a budget. */
  retryMs?: number;
}

/**
 * The adb server's device list, as a callback.
 *
 * `start(onChange)` attaches and keeps `onChange` up to date:
 *
 *   * `onChange(true)` — the server wrote the device list.  Once on attach, then once per
 *     change on the bus (a cable, an authorization tap, a device going offline).
 *   * `onChange(false)` — that stream is gone (server stopped, socket closed, a frame we
 *     could not read).  Saying so is what lets the caller go back to a tick: a watch that
 *     silently died would be worse than no watch at all.
 *
 * `stop()` detaches and cancels the retry.  Nothing here throws: adb is a moving part on
 * someone else's machine and every failure of it is a state, not a crash.
 */
export class DeviceWatch {
  /** The last device list the server sent, verbatim (the same text `adb devices` prints
   *  under its header line).  For logs, tests and the occasional "what did it say". */
  devices = '';
  private readonly target: AdbServerTarget | undefined;
  private readonly retryMs: number;
  private onChange?: (live: boolean) => void;
  private sock?: net.Socket;
  private retry?: NodeJS.Timeout;
  private buf = Buffer.alloc(0);
  /** The `OKAY` handshake landed: this socket is a device stream, not a client session. */
  private ok = false;
  /** …and the caller has been told.  Never set without `onChange(true)` following. */
  private live = false;
  private stopped = true;
  /** One line per outage, not one per retry: the window's log panel is for the user. */
  private complained = false;

  constructor(private readonly o: DeviceWatchOpts) {
    this.target = adbServerTarget(o.env ?? process.env, o.plat ?? process.platform);
    this.retryMs = o.retryMs ?? 5000;
  }

  /** Whether the server is pushing to us right now. */
  get connected(): boolean {
    return this.live;
  }

  start(onChange: (live: boolean) => void): void {
    this.onChange = onChange;
    if (!this.stopped) return;
    this.stopped = false;
    if (!this.target) {
      this.complained = true;
      this.o.log('[adb] device watch: no adb server socket this app can watch; asking the bus on a timer');
      return;
    }
    this.attach();
  }

  stop(): void {
    this.stopped = true;
    this.live = false;
    this.ok = false;
    this.onChange = undefined;
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = undefined;
    }
    const s = this.sock;
    this.sock = undefined;
    s?.destroy();
  }

  private attach(): void {
    if (this.stopped || !this.target) return;
    const sock = 'path' in this.target
      ? net.connect({ path: this.target.path })
      : net.connect({ host: this.target.host, port: this.target.port });
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.ok = false;
    // A server that dies without a FIN — the machine quit, someone ran `kill-server`, the
    // process was SIGKILLed — otherwise leaves a socket that looks open forever.  Keepalive
    // is what turns that into a `close`, which is what turns it into a retry.
    sock.setKeepAlive(true, 30_000);
    sock.on('connect', () => {
      const req = Buffer.from('host:track-devices', 'latin1');
      sock.write(Buffer.concat([Buffer.from(req.length.toString(16).padStart(4, '0'), 'latin1'), req]));
    });
    sock.on('data', (d) => this.onData(d));
    sock.on('error', (e) => this.drop(`the adb server socket failed (${(e as Error).message})`));
    sock.on('close', () => this.drop('the adb server closed the device stream'));
  }

  /**
   * adb's host protocol, the two shapes of it that this service uses: a four-byte tag
   * (`OKAY`, or `FAIL` and a message) before the stream, then frames of four hex digits of
   * length and that many bytes of text.
   */
  private onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    if (!this.ok) {
      if (this.buf.length < 4) return;
      const tag = this.buf.subarray(0, 4).toString('latin1');
      this.buf = this.buf.subarray(4);
      if (tag !== 'OKAY') {
        this.drop(`the adb server refused host:track-devices (${tag})`);
        return;
      }
      this.ok = true;
    }
    for (;;) {
      if (this.buf.length < 4) return;
      const len = parseInt(this.buf.subarray(0, 4).toString('latin1'), 16);
      if (!Number.isInteger(len) || len < 0 || len > 1 << 20) {
        this.drop('the adb server wrote a frame this app cannot read');
        return;
      }
      if (this.buf.length < 4 + len) return;
      this.devices = this.buf.subarray(4, 4 + len).toString('utf8');
      this.buf = this.buf.subarray(4 + len);
      const first = !this.live;
      this.live = true;
      this.complained = false;
      if (first) {
        this.o.log('[adb] device watch: attached — the adb server will push the device list when it changes');
      }
      this.onChange?.(true);
    }
  }

  private drop(why: string): void {
    if (this.stopped) return;
    const was = this.live;
    this.live = false;
    this.ok = false;
    this.buf = Buffer.alloc(0);
    const sock = this.sock;
    this.sock = undefined;
    sock?.destroy();
    if (was || !this.complained) {
      this.complained = true;
      this.o.log(`[adb] device watch: ${why}; asking the bus on a timer instead`);
    }
    if (was) this.onChange?.(false);
    if (this.retry) return;
    const retry = setTimeout(() => {
      this.retry = undefined;
      this.attach();
    }, this.retryMs);
    retry.unref?.();
    this.retry = retry;
  }
}
