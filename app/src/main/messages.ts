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
  | 'adbNeedsDistro'
  | 'abiUnsupported'
  | 'elfNoExec'
  | 'ready'
  | 'hintTapHost';

type Vars = Record<string, string | number>;

const MESSAGES: Record<MsgKey, string> = {
  noDevice: 'No USB device: check the cable and enable USB debugging on the device',
  unauthorized: 'Allow USB debugging on the device',
  // The app may raise the desktop's own consent prompt for this one (elevate.ts), and
  // the two commands stay as the fallback for a machine where it cannot or the user
  // says no.  What the sentence may never do is tell the user to go and run it by hand
  // as the only way: see test/escalation.test.ts.
  noPermissions: 'A one-time access rule is needed to let the device through: grant it in the app, or run the command yourself',
  noPermissionsAfterRule: 'The udev rule is in place but the device is still denied: unplug and replug the cable; if that does not help, log out and back in',
  offline: 'The device is not responding: unplug and replug the cable, then retry',
  // "Streaming client" is the role of the far end, not the name of a program: which
  // client the device actually runs is what the Related software rows report.
  noMoonlight: 'No streaming client is installed on the device',
  noSunshine: 'The streaming service on this PC is not running',
  udpFail: 'UDP channel verification failed',
  // The app carries its own adb, so this is the state where *every* door failed: the
  // copy shipped with the app, an adb already on this machine, and the built-in download
  // (offline, or a stripped build).  It must not send the user off to install
  // platform-tools — that is the manual step this app exists to remove — so it names
  // what failed and leaves the retry to the app's own polling and the Connect button.
  adbMissing: 'adb could not be started: neither the copy shipped with the app nor one on this machine works, and the download failed',
  adbConflict: 'A different adb server version is running; it must be restarted (other sessions will drop)',
  // The one machine where the bundled copy is not the answer: the app ships an aarch64
  // adb, but that payload needs glibc 2.35 (Debian 12 / Ubuntu 22.04) or newer, and
  // Google publishes Linux platform-tools for x86_64 only — so on an older arm64 system
  // there is nothing to fall back to over the network.  The fix is the distribution's
  // package, and it is a *package*, not a privileged command this app hands out —
  // `test/escalation.test.ts` fails if a sentence starts naming one.
  adbNeedsDistro: 'No adb can run here: the one the app ships needs glibc 2.35 or newer. Install your distribution\'s adb package',
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
  /** Details → Startup: the two things the app may do before the user asks, and the
   * one line it says when the OS would not take one of them. */
  startup: string;
  launchAtLogin: string;
  autoConnect: string;
  /** What the one button says while the auto-connect attempt has not dialled yet, and why
   * it is there rather than in the status line: the chip reads "Off" for a waiting app
   * exactly as it does for one nobody asked to connect, and the line under the link is the
   * state's own sentence.  The button is where the press would have gone, so the wait is
   * named on the button — and the button is disabled under it, because the app is already
   * doing the only thing a press could ask for. */
  autoConnectWaiting: string;
  startupError: string;
  /** The third row of that block: closing the window must not drop the link. */
  keepRunning: string;
  /** The comment the desktop's own startup-applications list shows — the one sentence
   * of ours that is read outside this window. */
  loginItemComment: string;
  /** The remedy well: one button per elevated action the app can perform itself, and
   * the one line it reports afterwards. */
  fixGrantAccess: string;
  fixInstallTray: string;
  fixInstallDriver: string;
  /** The outcomes.  A dismissal is an answer, not an error, and says so. */
  fixDone: string;
  fixRefused: string;
  fixFailed: string;
  fixNoBroker: string;
  /** The driver install that ran clean and did not take: the one outcome where the
   * remedy's own steps all succeeded and the thing it was for still is not true, so it
   * may not be reported as done.  An action, like every other sentence here. */
  fixNotBound: string;
  /** Shown when this desktop has no tray at all, so "close keeps the link" is not a
   * promise the user has to discover the meaning of. */
  trayMissing: string;
  /** The tray menu, in the main process. */
  showWindow: string;
  quit: string;
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
  startup: 'Startup',
  launchAtLogin: 'Open Ether when you sign in',
  autoConnect: 'Connect the wired link on launch',
  autoConnectWaiting: 'Waiting for the adb connection',
  startupError: 'The startup setting could not be changed',
  keepRunning: 'Keep the link running when the window is closed',
  loginItemComment: 'Wired (adb) channel for the streaming client on this PC',
  fixGrantAccess: 'Grant device access',
  fixInstallTray: 'Install tray support',
  fixInstallDriver: 'Install USB driver',
  fixDone: 'Done',
  fixRefused: 'Dismissed: nothing was changed',
  fixFailed: 'The change could not be made',
  fixNoBroker: 'This desktop cannot ask for elevated rights: run the command below',
  fixNotBound: 'The driver is installed but Windows still has not bound it to the device: unplug and replug the cable',
  trayMissing: 'No tray icon on this desktop: closing the window minimises it instead, and the link stays up',
  showWindow: 'Show Ether',
  quit: 'Quit Ether',
};

export function uiLabels(): UiLabels {
  return UI;
}
