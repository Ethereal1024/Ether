// ports.test.ts — port negotiation is where "one click" either works or collides
// with whatever else the user is running (§3.3, §3.4 #4).
//
// Nothing here is hard-coded: Sunshine's ports are derived from its base and
// confirmed by probing; the tunnel's own ports are asked from the OS.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import dgram from 'node:dgram';
import net from 'node:net';
import { test } from 'node:test';
import {
  DEFAULT_BASE,
  MIC_OFFSET,
  PROC_NET_SWEEP,
  TCP_OFFSETS,
  UDP_OFFSETS,
  detectSunshinePorts,
  parseProcNetPorts,
  parseSunshineConfPort,
  pickAvoidingBusy,
  pickFreeTcpPort,
  pickFreeUdpPort,
  portsForBase,
  sunshineConfPath,
  sunshineRunning,
  tcpListening,
  udpListenerPorts,
} from '../src/main/ports.js';

// Sunshine's config path is assembled with path.join, so its separators are the
// host's: the literals in the layout test below are POSIX paths, and on Windows the
// same call answers `\home\u\.config\sunshine\...`.  (The $SUNSHINE_CONF override is
// returned verbatim and is checked on every host.)
const posixOnly = process.platform === 'win32' ? 'POSIX path separators' : false;

function listenTcp(port = 0): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer(() => {});
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => {
      const a = srv.address();
      resolve({
        port: typeof a === 'object' && a ? a.port : 0,
        close: () => new Promise((r) => srv.close(() => r())),
      });
    });
  });
}

function bindUdp(port = 0): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.once('error', reject);
    s.bind(port, '127.0.0.1', () => {
      const a = s.address();
      resolve({
        port: typeof a === 'object' && a ? a.port : 0,
        close: () => {
          try {
            s.close();
          } catch {
            /* ignore */
          }
        },
      });
    });
  });
}

test('parseSunshineConfPort reads `port = N`, ignoring comments and junk', () => {
  assert.equal(parseSunshineConfPort('port = 47990\n'), 47990);
  assert.equal(parseSunshineConfPort('# port = 1234\nport=48000\n'), 48000);
  assert.equal(parseSunshineConfPort('  port = 50000  ; my port\n'), 50000);
  assert.equal(parseSunshineConfPort('address = 0.0.0.0\n'), undefined);
  assert.equal(parseSunshineConfPort('port = 80\n'), undefined); // privileged, ignored
  assert.equal(parseSunshineConfPort(''), undefined);
});

test('portsForBase derives the four TCP and three UDP channels Sunshine uses', () => {
  const p = portsForBase(47989, 'default');
  assert.deepEqual(p.tcp, TCP_OFFSETS.map((o) => 47989 + o));
  assert.deepEqual(p.udp, UDP_OFFSETS.map((o) => 47989 + o));
  assert.equal(p.base, 47989);
  assert.equal(p.source, 'default');

  const withMic = portsForBase(47989, 'probe', true);
  assert.deepEqual(withMic.udp, [...UDP_OFFSETS.map((o) => 47989 + o), 47989 + MIC_OFFSET]);
  assert.equal(TCP_OFFSETS.length, 4);
  assert.equal(UDP_OFFSETS.length, 3);
});

test('sunshineConfPath lets $SUNSHINE_CONF win on every platform', () => {
  // The override is handed back exactly as it came in, so this half says nothing
  // about the host's separators and runs everywhere.
  assert.equal(sunshineConfPath('linux', { SUNSHINE_CONF: '/custom/s.conf' }), '/custom/s.conf');
  assert.equal(sunshineConfPath('win32', { SUNSHINE_CONF: 'C:\\custom\\s.conf' }), 'C:\\custom\\s.conf');
});

test("sunshineConfPath builds each platform's default layout", { skip: posixOnly }, () => {
  const linux = sunshineConfPath('linux', { HOME: '/home/u', XDG_CONFIG_HOME: '' });
  assert.equal(linux, '/home/u/.config/sunshine/sunshine.conf');
  const xdg = sunshineConfPath('linux', { HOME: '/home/u', XDG_CONFIG_HOME: '/home/u/.cfg' });
  assert.equal(xdg, '/home/u/.cfg/sunshine/sunshine.conf');
  const mac = sunshineConfPath('darwin', { HOME: '/Users/u' });
  assert.ok(mac.endsWith('/Library/Application Support/Sunshine/sunshine.conf'));
});

test('pickFreeTcpPort never hands back a port the caller marked as used', async () => {
  const busy = await listenTcp();
  try {
    for (let i = 0; i < 5; i++) {
      const got = await pickFreeTcpPort(new Set([busy.port]));
      assert.notEqual(got, busy.port);
      const probe = await listenTcp(got); // and it really is bindable
      await probe.close();
    }
  } finally {
    await busy.close();
  }
});

test('pickFreeTcpPort respects an explicit range', async () => {
  const got = await pickFreeTcpPort(new Set(), [30000, 58000]);
  assert.ok(got >= 30000 && got <= 58000, `port ${got} out of range`);
});

test('pickFreeUdpPort never hands back a port that is already bound', async () => {
  const busy = await bindUdp();
  try {
    const got = await pickFreeUdpPort(new Set([busy.port]));
    assert.notEqual(got, busy.port);
    const again = await bindUdp(got);
    again.close();
  } finally {
    busy.close();
  }
});

// A byte-for-byte slice of /proc/net/{udp,udp6,tcp,tcp6} as the kernel prints it
// (IPv4 addresses are little-endian words, IPv6 ones are four 32-bit words).
const PROC_NET_SAMPLE = `@@udp
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops
   0: 0100007F:1F90 00000000:0000 07 00000000:00000000 00:00000000 00000000  1000        0 12345 2 0000000000000000 0
   1: 00000000:BB9E 00000000:0000 07 00000000:00000000 00:00000000 00000000  1000        0 12346 2 0000000000000000 0
@@udp6
  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops
   0: 00000000000000000000000000000000:1F91 00000000000000000000000000000000:0000 07 00000000:00000000 00:00000000 00000000  1000 0 12347 2 0000000000000000 0
@@tcp
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0000 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 23456 1 0000000000000000 100 0 0 10 0
   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 23457 1 0000000000000000 100 0 0 10 0
   2: 0A00A8C0:C350 5DB8D822:01BB 01 00000000:00000000 02:0000000A 00000000  1000        0 23458 2 0000000000000000 20 4 30 10 -1
@@tcp6
  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:BB9F 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 23459 1 0000000000000000 100 0 0 10 0
`;

test('parseProcNetPorts reads the local port column of all four kernel tables', () => {
  const busy = parseProcNetPorts(PROC_NET_SAMPLE);
  assert.ok(busy, 'a complete sweep must be recognised');
  assert.deepEqual([...busy.udp].sort((a, b) => a - b), [8080, 8081, 48030]);
  assert.deepEqual([...busy.tcp].sort((a, b) => a - b), [8080, 48031, 50000]);
  assert.ok(!busy.tcp.has(0), 'a port of 0000 is not a port anybody holds');
});

test('parseProcNetPorts answers "cannot tell" unless the whole sweep came back', () => {
  assert.equal(parseProcNetPorts(''), null);
  assert.equal(parseProcNetPorts('adb: device offline\n'), null);
  assert.equal(parseProcNetPorts('@@udp\n 0: 0100007F:1F90 00000000:0000 07\n'), null);
});

test(
  'the sweep finds a port this machine just bound (real /proc/net format)',
  { skip: process.platform !== 'linux' ? 'needs /proc/net' : false },
  async () => {
    const u = await bindUdp();
    const t = await listenTcp();
    try {
      const out = await new Promise<string>((resolve, reject) => {
        execFile('sh', ['-c', PROC_NET_SWEEP], { maxBuffer: 4 << 20 }, (err, stdout) =>
          err ? reject(err) : resolve(stdout),
        );
      });
      const busy = parseProcNetPorts(out);
      assert.ok(busy, 'the sweep output was not recognised');
      assert.ok(busy.udp.has(u.port), `udp ${u.port} missing from ${busy.udp.size} ports`);
      assert.ok(busy.tcp.has(t.port), `tcp ${t.port} missing from ${busy.tcp.size} ports`);
    } finally {
      t.close();
      u.close();
    }
  },
);

test('pickAvoidingBusy steps over ports the tablet already holds (§3.3)', async () => {
  const used = new Set<number>();
  const offered = [5001, 5002, 5003];
  const sawUsed: number[][] = [];
  const pick = async (u: Set<number>): Promise<number> => {
    sawUsed.push([...u]);
    const next = offered.shift();
    assert.notEqual(next, undefined, 'the picker was asked more times than expected');
    return next as number;
  };
  const got = await pickAvoidingBusy(pick, used, new Set([5001, 5002]));
  assert.equal(got, 5003);
  // The collisions are remembered, or the next pick could hand the same one back.
  assert.deepEqual(sawUsed, [[], [5001], [5001, 5002]]);
  assert.deepEqual([...used], [5001, 5002]);
});

test('pickAvoidingBusy changes nothing when the tablet cannot be asked', async () => {
  let calls = 0;
  const got = await pickAvoidingBusy(
    async () => {
      calls++;
      return 5001;
    },
    new Set(),
    null,
  );
  assert.equal(got, 5001);
  assert.equal(calls, 1, 'a device that will not answer must not cost extra attempts');
});

test('pickAvoidingBusy gives up after its tries and hands back the last pick', async () => {
  let calls = 0;
  const got = await pickAvoidingBusy(
    async () => {
      calls++;
      return 5001;
    },
    new Set(),
    new Set([5001]),
    3,
  );
  assert.equal(got, 5001); // the caller's bind-and-retry is the final arbiter
  assert.equal(calls, 3);
});

test('tcpListening tells a live listener from a dead port', async () => {
  const srv = await listenTcp();
  try {
    assert.equal(await tcpListening(srv.port), true);
  } finally {
    await srv.close();
  }
  assert.equal(await tcpListening(srv.port), false);
});

test('udpListenerPorts never throws; it reports "cannot tell" as null', async () => {
  const set = await udpListenerPorts(process.platform === 'win32' ? 'win32' : 'linux');
  assert.ok(set === null || set instanceof Set);
});

test('detectSunshinePorts prefers a live listener over what the config claims (§3.3)', async () => {
  // A port we own, so this holds whether or not Sunshine is running right now.
  const probe = await pickFreeTcpPort();
  const srv = await listenTcp(probe);
  const conf = await writeTempConf(`port = ${probe}\n`);
  const logs: string[] = [];
  try {
    const p = await detectSunshinePorts({ confPath: conf, log: (l) => logs.push(l) });
    assert.equal(p.base, probe);
    assert.equal(p.source, 'probe');
    assert.deepEqual(p.tcp, TCP_OFFSETS.map((o) => probe + o));
  } finally {
    await srv.close();
    await rmFile(conf);
  }
});

test('detectSunshinePorts falls back to the config when nothing is listening', async () => {
  const conf = await writeTempConf('port = 47989\n');
  try {
    const p = await detectSunshinePorts({ confPath: conf, log: () => {}, probe: false });
    assert.equal(p.base, 47989);
    assert.equal(p.source, 'conf');
  } finally {
    await rmFile(conf);
  }
});

test('detectSunshinePorts assumes 47989 when there is neither config nor listener', async () => {
  const logs: string[] = [];
  const p = await detectSunshinePorts({
    confPath: '/nonexistent/sunshine.conf',
    log: (l) => logs.push(l),
    probe: false,
  });
  assert.equal(p.base, DEFAULT_BASE);
  assert.equal(p.source, 'default');
  assert.ok(logs.some((l) => l.includes('not readable')));
});

test('sunshineRunning reports the base port only while something holds it', async () => {
  const port = await pickFreeTcpPort();
  const ports = portsForBase(port, 'probe');
  assert.equal((await sunshineRunning(ports)).tcp, false);
  const srv = await listenTcp(port);
  try {
    assert.equal((await sunshineRunning(ports)).tcp, true);
  } finally {
    await srv.close();
  }
  assert.equal((await sunshineRunning(ports)).tcp, false);
});

async function writeTempConf(body: string): Promise<string> {
  const { writeFile, mkdtemp } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ether-conf-'));
  const file = path.join(dir, 'sunshine.conf');
  await writeFile(file, body);
  return file;
}

async function rmFile(p: string): Promise<void> {
  const { rm } = await import('node:fs/promises');
  await rm(p, { force: true });
}
