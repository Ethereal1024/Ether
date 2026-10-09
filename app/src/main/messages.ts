// messages.ts — every user-facing sentence in the app lives here.
//
// Ether is an English-language program: this file holds one catalogue, in English,
// and nothing in the UI invents prose anywhere else.  A message the user can read
// is one line here, shaped as an action ("check the cable", "allow USB debugging"),
// never as a tutorial: no "Settings → About phone → tap Build number", no
// screenshots, no explanation of what adb is.  If a message cannot be acted on, it
// does not belong in the UI.
//
// Two words this file refuses to use:
//   * "tablet" — the thing on the other end of the cable is a device that can run a
//     streaming client.  Calling it a tablet is a guess the code cannot make;
//   * "Moonlight" / "Sunshine" — a peer program's name never appears in the main
//     window.  Those live in the Related software block inside Details
//     (`clientName` / `hostName` below), which is the one place the user asked for
//     them, and only from observation.

export type MsgKey =
  | 'noDevice'
  | 'unauthorized'
  | 'noPermissions'
  | 'noPermissionsAfterRule'
  | 'offline'
  | 'noMoonlight'
  | 'noSunshine'
  | 'udpFail'
  | 'adbMissing'
  | 'adbConflict'
  | 'abiUnsupported'
  | 'elfNoExec'
  | 'ready'
  | 'hintTapHost';

type Vars = Record<string, string | number>;

const MESSAGES: Record<MsgKey, string> = {
  noDevice: 'No USB device: check the cable and enable USB debugging on the device',
  unauthorized: 'Allow USB debugging on the device',
  // Admin appears only at this step, and only as the user's own one-time action in
  // the OS: the app itself never elevates (see test/noadmin.test.ts).
  noPermissions: 'A one-time udev rule is needed to let the device through (run it in the OS; the app itself needs no admin)',
  noPermissionsAfterRule: 'The udev rule is in place but the device is still denied: unplug and replug the cable; if that does not help, log out and back in',
  offline: 'The device is not responding: unplug and replug the cable, then retry',
  // "Streaming client" is the role of the far end, not the name of a program: which
  // client the device actually runs is what the Related software rows report.
  noMoonlight: 'No streaming client is installed on the device',
  noSunshine: 'The streaming service on this PC is not running',
  udpFail: 'UDP channel verification failed',
  adbMissing: 'adb not found: install platform-tools or set the ADB environment variable, then retry',
  adbConflict: 'A different adb server version is running; it must be restarted (other sessions will drop)',
  abiUnsupported: 'Device ABI {abi} is not supported',
  elfNoExec: 'The device-side program cannot run (maybe /data/local/tmp is mounted noexec)',
  ready: 'Wired channel is up',
  // One actionable next step: name the action (connect to this PC in the client),
  // never what some program's interface looks like.
  hintTapHost: 'Connect to this PC from your client',
};

export function t(key: MsgKey, vars?: Vars): string {
  let s: string = MESSAGES[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}

/** Every key the catalogue holds (used by the unit test that freezes it). */
export function allKeys(): MsgKey[] {
  return Object.keys(MESSAGES) as MsgKey[];
}

/** The few pieces of window chrome that are not status sentences. */
export interface UiLabels {
  /** The device row and its empty state. Never "tablet": see the note above. */
  device: string;
  pc: string;
  usbConnected: string;
  /** The PC row: the *role* of the program listening there, not its name. */
  serviceRunning: string;
  serviceMissing: string;
  start: string;
  stop: string;
  /** The button's word while work is in flight — and the badge's, which is why it
   * has to read as a state and not as a verb. */
  working: string;
  /** The state badge: the card says what the link is doing in one word instead of
   * a sentence the button already implies. */
  on: string;
  off: string;
  /** The verified UDP round trip, in front of the figure (`UDP round trip 119 Mbps`). */
  rtt: string;
  /** The disclosure's own label — everything the first screen does not need. */
  details: string;
  /** The block headings behind it: the path, the counters, the ports, the log. */
  path: string;
  counts: string;
  ports: string;
  logs: string;
  /** Whether one leg of the path is carrying. One word, drawn after USB/TCP/UDP. */
  legUp: string;
  legDown: string;
  /** The chip's word for a state that is broken, and the badge's (one fact, one
   * word, in one place). */
  needsAttention: string;
  /** The four counters in the details panel, one word each (they sit under a number). */
  datagrams: string;
  bytes: string;
  dropped: string;
  peers: string;
  measure: string;
  restartAdb: string;
  copy: string;
  copied: string;
  /** The same control, for the two other wells whose text exists to be pasted: the
   * port map (ports the user retypes into a client) and the udev commands. */
  copyPorts: string;
  copyCommand: string;
  notConnected: string;
  /** Details → Related software: the only place a peer program may be named. */
  related: string;
  clientRole: string;
  hostRole: string;
  clientName: string;
  hostName: string;
  installed: string;
  notInstalled: string;
  unknown: string;
  listening: string;
  notDetected: string;
}

export const UI: UiLabels = {
  device: 'Device',
  pc: 'PC',
  usbConnected: 'USB connected',
  serviceRunning: 'Streaming service is running',
  serviceMissing: 'No streaming service detected',
  start: 'Start wired link',
  stop: 'Stop',
  working: 'working…',
  on: 'On',
  off: 'Off',
  rtt: 'UDP round trip',
  details: 'Details',
  needsAttention: 'needs attention',
  path: 'Link path',
  counts: 'Counters',
  ports: 'Ports',
  logs: 'Logs',
  legUp: 'up',
  legDown: 'down',
  datagrams: 'Datagrams',
  bytes: 'Bytes',
  dropped: 'Dropped',
  peers: 'Peers',
  measure: 'Measure (UDP round trip)',
  restartAdb: 'Restart adb server',
  copy: 'Copy logs',
  copied: 'copied',
  copyPorts: 'Copy ports',
  copyCommand: 'Copy commands',
  notConnected: 'No device connected',
  related: 'Related software',
  clientRole: 'Client',
  hostRole: 'Host',
  clientName: 'Moonlight',
  hostName: 'Sunshine',
  installed: 'installed',
  notInstalled: 'not installed',
  unknown: 'unknown',
  listening: 'listening on',
  notDetected: 'not detected',
};

export function uiLabels(): UiLabels {
  return UI;
}
