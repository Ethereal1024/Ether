'use strict';

// The window, finished: the main process pushes one status payload and this file
// draws it. No framework, no node access and no window verb — `window.ether`
// (preload.cjs) is the only API, and the window's size is fixed in main/index.ts, so
// nothing here measures, observes or lays anything out by hand.
//
// Two rules keep the drawing honest:
//   * a word is written only when it changed, so a status push every two seconds does
//     not re-announce a live region or discard what the user selected in the log;
//   * every word comes from `labels` (messages.ts) or from the status itself. This
//     file carries no user-facing string of its own.

const api = window.ether;
const $ = (id) => document.getElementById(id);

const el = {
  chip: $('state-chip'),
  word: $('state-word'),
  kDevice: $('k-device'),
  vDevice: $('v-device'),
  kPc: $('k-pc'),
  vPc: $('v-pc'),
  statusLine: $('status-line'),
  rtt: $('rtt'),
  udev: $('udev'),
  udevCmd: $('udev-cmd'),
  restartAdb: $('restart-adb'),
  restartAdbLabel: $('restart-adb-label'),
  moreLabel: $('more-label'),
  hPath: $('h-path'),
  hStartup: $('h-startup'),
  chkAtLogin: $('set-at-login'),
  chkAtLoginLabel: $('set-at-login-label'),
  chkAutoConnect: $('set-auto-connect'),
  chkAutoConnectLabel: $('set-auto-connect-label'),
  startupNote: $('startup-note'),
  hCounts: $('h-counts'),
  hRelated: $('h-related'),
  hPorts: $('h-ports'),
  hLogs: $('h-logs'),
  ports: $('ports'),
  portsNone: $('ports-none'),
  logs: $('logs'),
  measure: $('measure'),
  measureLabel: $('measure-label'),
  kClient: $('k-client'),
  vClient: $('v-client'),
  kHost: $('k-host'),
  vHost: $('v-host'),
  kAdb: $('k-adb'),
  vAdb: $('v-adb'),
  button: $('main-button'),
  copyLive: $('copy-live'),
};

/** The three legs this app builds, left to right in the order it builds them. */
const LEGS = ['usb', 'tcp', 'udp'];

/** The three plain-text blocks, each with its own copy control. The text is read
 * back out of the block on click, never rebuilt: what is copied is what is on screen,
 * padding and 200-line cap included. */
const COPIES = [
  { button: $('copy'), label: $('copy-label'), key: 'copy', fallback: 'Copy', block: el.logs },
  { button: $('copy-ports'), label: $('copy-ports-label'), key: 'copyPorts', fallback: 'Copy', block: el.ports },
  { button: $('copy-udev'), label: $('copy-udev-label'), key: 'copyCommand', fallback: 'Copy', block: el.udevCmd },
];

/** The four counters and the heading under each number. */
const STATS = [
  { key: 'datagrams', box: $('stat-datagrams-box'), value: $('stat-datagrams'), label: $('stat-datagrams-k') },
  { key: 'bytes', box: $('stat-bytes-box'), value: $('stat-bytes'), label: $('stat-bytes-k') },
  { key: 'dropped', box: $('stat-dropped-box'), value: $('stat-dropped'), label: $('stat-dropped-k') },
  { key: 'peers', box: $('stat-peers-box'), value: $('stat-peers'), label: $('stat-peers-k') },
];

const leg = (name) => ({ box: $(`leg-${name}`), state: $(`leg-${name}-state`) });
const LEG_NODES = Object.fromEntries(LEGS.map((name) => [name, leg(name)]));
const LINK_NODES = { usb: $('link-usb'), tcp: $('link-tcp') };

// ── state ───────────────────────────────────────────────────────────────────

let labels = {};
/** What the main process says about the two switches in Details → Startup.  The default
 * is "nothing on", which is also what a payload that predates the settings carries. */
let settings = { autoConnect: false, launchAtLogin: false, error: false };
/** A setting change the main process itself refused (an IPC that rejected), until the
 * next payload replaces it.  The refusal is drawn where the switch is, not in the
 * sentence under the link. */
let settingsNote = '';
/** The frame drawn before anything arrives. It is the truth and not a placeholder:
 * the main process is creating the controller, which on a fresh machine can take a
 * while, so the first paint already says the app is working and the button is off. */
let status = { state: 'checking', message: '', logs: [] };
const locale = 'en-US';   // the app is English: figures are grouped the en-US way
let measured = 0;       // the last UDP round trip in Mbps; belongs to one link only
let inflight = false;   // a start/stop/restart is running right now
let failure = '';       // the reason the last verb gave up, until a status replaces it

const BUSY = new Set(['checking', 'starting']);
const isUp = (state) => state === 'up' || state === 'degraded';
const isBusy = () => inflight || BUSY.has(status.state);

/** The chip's word and tone, one entry per state the main process can report. In one
 * table because the word the user reads and the colour they read it in are one fact. */
const CHIP = {
  checking: { key: 'working', tone: '' },
  starting: { key: 'working', tone: '' },
  up: { key: 'on', tone: 'ok' },
  degraded: { key: 'on', tone: 'warn' },
  error: { key: 'needsAttention', tone: 'bad' },
  idle: { key: 'off', tone: '' },
};

// ── drawing helpers ─────────────────────────────────────────────────────────

/** Write `value` into `node` only if it is not already there. Every payload redraws
 * every node, so "the same word, written again" is the normal case: a live region
 * handed an identical string re-announces it, and rewriting the log throws away the
 * reader's selection. */
function text(node, value) {
  const next = String(value ?? '');
  if (node.textContent !== next) node.textContent = next;
}

/** A readout the window may have to cut off carries its whole value as a tooltip: at a
 * fixed 560 px a serial or a path is ellipsised often enough that the ellipsis is the
 * normal case, and a truncation the user cannot recover is a value this app knows and
 * would not say. */
function readout(node, value) {
  text(node, value);
  if (node.title !== node.textContent) node.title = node.textContent;
}

const count = (v) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n.toLocaleString(locale) : '0';
};

/** One line out of the parts that exist, separator included only between two: an
 * empty half leaves no trace. */
const sentence = (parts) => parts.filter(Boolean).join(' · ');

/** One uniform figure: a five-second probe's tenth of a megabit is noise, and a readout
 * whose number of decimals depends on how fast the link is cannot be compared. */
const fmtRate = (mbps) => `${Math.round(mbps)} Mbps`;

/** A port belongs to the word it is a port of. */
const withPort = (word, port) => (port ? `${word} ${port}` : String(word));

// ── drawing ─────────────────────────────────────────────────────────────────

function render() {
  const s = status;
  const up = isUp(s.state);
  const chip = CHIP[s.state] ?? CHIP.idle;

  // The link, in one word.
  el.chip.className = chip.tone ? `chip ${chip.tone}` : 'chip';
  text(el.word, labels[chip.key] ?? chip.key);

  // Everything that is a word rather than a status.
  text(el.kDevice, labels.device ?? 'Device');
  text(el.kPc, labels.pc ?? 'PC');
  text(el.moreLabel, labels.details ?? 'Details');
  text(el.hPath, labels.path ?? 'Link');
  text(el.hCounts, labels.counts ?? 'Counters');
  text(el.hRelated, labels.related ?? 'Related');
  text(el.hPorts, labels.ports ?? 'Ports');
  text(el.hLogs, labels.logs ?? 'Logs');
  text(el.measureLabel, labels.measure ?? 'Measure');
  text(el.restartAdbLabel, labels.restartAdb ?? 'Restart');
  text(el.kClient, labels.clientRole ?? 'Client');
  text(el.kHost, labels.hostRole ?? 'Host');
  text(el.kAdb, 'adb');

  // The two switches the user owns.  `launchAtLogin` is not ours to remember: the main
  // process asks the OS, so the switch cannot go on claiming the app opens at login
  // after the user removed the entry themselves.  A change the OS refused is one line
  // under them, and the switch keeps showing what is actually true.
  text(el.hStartup, labels.startup ?? 'Startup');
  text(el.chkAtLoginLabel, labels.launchAtLogin ?? '');
  text(el.chkAutoConnectLabel, labels.autoConnect ?? '');
  el.chkAtLogin.checked = Boolean(settings.launchAtLogin);
  el.chkAutoConnect.checked = Boolean(settings.autoConnect);
  const note = settingsNote || (settings.error ? (labels.startupError ?? '') : '');
  text(el.startupNote, note);
  el.startupNote.hidden = !note;

  // The two rows of what is actually plugged in. The PC row says what the program on
  // this machine is *for*; which program it is belongs in Related software, further down.
  if (s.device) {
    const model = s.device.model ? `${s.device.model} ` : '';
    const state = s.device.state === 'device' ? (labels.usbConnected ?? 'connected') : s.device.state;
    readout(el.vDevice, `${model}(${s.device.serial}) · ${state}`);
  } else {
    readout(el.vDevice, labels.notConnected ?? '');
  }
  readout(
    el.vPc,
    s.sunshine === 'up'
      ? withPort(labels.serviceRunning ?? 'Running', s.ports?.base)
      : s.sunshine === 'down'
        ? (labels.serviceMissing ?? '')
        : (labels.unknown ?? ''),
  );

  // The sentence the chip cannot carry: what the app is waiting for, when it is
  // waiting for the user. A verb that failed is the newest news and wins over the last
  // status. The ready sentence is not news at all — the button already reads Stop and
  // the chip On, so it would be the third time.
  const line = failure || (s.messageKey === 'ready' ? '' : (s.message ?? ''));
  el.statusLine.className = failure ? 'status bad' : chip.tone ? `status ${chip.tone}` : 'status';
  text(el.statusLine, line);

  // The measured round trip, on its own line so the sentence never has to wrap around
  // a figure. It means something only while there is a link to have measured.
  const mbps = measured || s.mbps || 0;
  const rate = up && mbps ? `${labels.rtt ?? 'UDP round trip'} ${fmtRate(mbps)}` : '';
  text(el.rtt, rate);
  el.rtt.hidden = !rate;

  // The one remedy whose action is a command the user pastes: no permissions on Linux.
  const udev = s.messageKey === 'noPermissions' && Boolean(s.hint);
  el.udev.hidden = !udev;
  if (udev) text(el.udevCmd, s.hint);

  // Restarting adb drops every other debugging session on the machine, so the button
  // is on screen only in the one state that is about a conflicting adb server.
  el.restartAdb.hidden = s.messageKey !== 'adbConflict';

  // The path: which of the three legs is carrying, read off what was observed and never
  // off the headline state. A rule lights with the leg it leaves, so the drawing shows
  // where the path stops. The udp leg needs `up` and not "up or degraded": the one state
  // that means "up, but a check failed" is exactly the one where it is not carrying.
  const legs = {
    usb: Boolean(s.device) && s.device.state === 'device',
    tcp: (s.tcpMap ?? []).length > 0,
    udp: s.state === 'up',
  };
  for (const name of LEGS) {
    LEG_NODES[name].box.classList.toggle('on', legs[name]);
    text(LEG_NODES[name].state, legs[name] ? (labels.legUp ?? 'up') : (labels.legDown ?? 'down'));
  }
  LINK_NODES.usb.classList.toggle('on', legs.usb && legs.tcp);
  LINK_NODES.tcp.classList.toggle('on', legs.tcp && legs.udp);

  // The counters, as four numbers in one row: read at a glance, where a log line had to
  // be read as a paragraph. Dropped is the one number whose being non-zero is bad news.
  const st = s.stats ?? {};
  for (const stat of STATS) {
    text(stat.value, count(st[stat.key]));
    text(stat.label, labels[stat.key] ?? stat.key);
  }
  STATS[2].box.classList.toggle('bad', Number(st.dropped ?? 0) > 0);

  // Related software: the one block allowed to name another program. Every line is what was
  // observed, never a guess — a missing client is proven by that one sentence, a usable
  // device means the package list answered, and "unknown" is not "not detected".
  const deviceUsable = Boolean(s.device) && s.device.state === 'device';
  const clientState = !s.device
    ? labels.unknown
    : s.messageKey === 'noMoonlight'
      ? labels.notInstalled
      : deviceUsable
        ? labels.installed
        : labels.unknown;
  readout(el.vClient, sentence([labels.clientName, clientState]));
  const hostState =
    s.sunshine === 'up'
      ? withPort(labels.listening ?? 'Listening', s.ports?.base)
      : s.sunshine === 'down'
        ? labels.notDetected
        : labels.unknown;
  readout(el.vHost, sentence([labels.hostName, hostState]));
  readout(
    el.vAdb,
    s.adb
      ? sentence([s.adb.path, s.adb.version]) + (s.adb.conflict ? '  [conflict]' : '')
      : (labels.unknown ?? ''),
  );

  // The port map: each tunnelled channel, then whatever is left of the channels the
  // host service knows about. Folding the channel's name into its own line makes one
  // table instead of two lists repeating each other.
  const names = new Map();
  for (const channel of s.channels ?? []) {
    const m = /^(\d+)\s+(.+)$/.exec(channel);
    if (m) names.set(Number(m[1]), m[2]);
  }
  const withName = (port) => (names.has(port) ? `${String(port).padEnd(5)} ${names.get(port)}` : String(port));
  const lines = [];
  const tunnelled = new Set();
  for (const [port, tunnel] of s.tcpMap ?? []) {
    tunnelled.add(port);
    lines.push(`tcp  ${withName(port)}  ->  adb reverse tcp:${tunnel}`);
  }
  for (const [port, tunnel] of s.udpMap ?? []) {
    tunnelled.add(port);
    lines.push(`udp  ${withName(port)}  ->  adb reverse tcp:${tunnel}  ->  host`);
  }
  const idle = (s.channels ?? []).filter((c) => !tunnelled.has(Number(c.split(' ')[0])));
  if (idle.length) lines.push(`---\n${idle.join('\n')}`);
  text(el.ports, lines.join('\n'));
  // A well with nothing in it says why in the app's own words for the state it is in.
  text(el.portsNone, lines.length ? '' : (s.message ?? ''));

  // The log is a reading surface, not a ticker. It is rewritten only when it changed,
  // and it follows its newest line only while the reader is already at that line:
  // otherwise a push arriving while they read further up drags them back down.
  const logs = (s.logs ?? []).slice(-200).join('\n');
  const atEnd = el.logs.scrollHeight - el.logs.scrollTop - el.logs.clientHeight <= 1;
  text(el.logs, logs);
  if (atEnd) el.logs.scrollTop = el.logs.scrollHeight;

  // The one action, named for what it will do next.
  el.button.disabled = isBusy();
  text(el.button, isBusy() ? (labels.working ?? '…') : up ? (labels.stop ?? 'Stop') : (labels.start ?? 'Start'));

  // The diagnostic is offered only while there is a link whose round trip means
  // anything, and each copy control is reset here so no tick outlives its own click.
  el.measure.disabled = !up;
  for (const c of COPIES) text(c.label, labels[c.key] ?? c.fallback);
}

// ── the verbs ───────────────────────────────────────────────────────────────

function apply(payload) {
  if (!payload) return;
  if (payload.labels) labels = payload.labels;
  // A payload is the newest word on the switches too, so it also clears a refusal the
  // previous *verb* reported — the state drawn is then the one the main process just
  // asked the OS for.
  if (payload.settings) {
    settings = payload.settings;
    settingsNote = '';
  }
  if (payload.status) {
    status = payload.status;
    failure = '';   // a fresh status from the main process supersedes a failed verb
  }
  render();
}

/**
 * One switch.  Like a verb it is never silent: an invoke that rejects becomes the line
 * under the switches, and a change the main process could not make comes back in the
 * payload itself.  It does not lock the main button — the link is not what it touches.
 */
async function setSetting(key, value) {
  settingsNote = '';
  render();
  try {
    apply(await api.setSetting({ key, value }));
  } catch (e) {
    settingsNote = String(e?.message ?? e);
  }
  render();
}

/** Run one verb, with the window locked for its duration: a second click while the
 * main process is working would start a second tunnel. A verb that throws is still
 * news — it becomes the sentence the user reads, never a silent console. */
async function run(fn) {
  if (inflight) return;
  inflight = true;
  failure = '';
  render();
  try {
    apply(await fn());
  } catch (e) {
    failure = String(e?.message ?? e);
  } finally {
    inflight = false;
  }
  render();
}

function copy(control) {
  void navigator.clipboard.writeText(control.block.textContent).then(() => {
    text(control.label, labels.copied ?? 'copied');
    control.button.classList.add('copied');
    // The control draws no word, so the receipt is spoken too. Two copies answer twice:
    // an identical string is no change to a live region, so it is cleared first.
    text(el.copyLive, '');
    text(el.copyLive, labels.copied ?? 'copied');
    setTimeout(() => {
      control.button.classList.remove('copied');
      text(control.label, labels[control.key] ?? control.fallback);
    }, 1200);
  }, () => undefined);
}

el.button.addEventListener('click', () => {
  const up = isUp(status.state);
  // The figure belongs to the link it was measured on, so a new link starts without one.
  if (up) measured = 0;
  void run(() => (up ? api.stop() : api.start()));
});

el.restartAdb.addEventListener('click', () => void run(() => api.restartAdb()));

// The switches ask the main process on every change — never a local flip it might not
// have honoured.  They are drawn again from the payload that comes back.
el.chkAtLogin.addEventListener('change', () => void setSetting('launchAtLogin', el.chkAtLogin.checked));
el.chkAutoConnect.addEventListener('change', () => void setSetting('autoConnect', el.chkAutoConnect.checked));

el.measure.addEventListener('click', () => {
  el.measure.disabled = true;
  text(el.statusLine, labels.working ?? '…');
  void api.measure({ seconds: 5, window: 1024 }).then((r) => {
    measured = r && r.ok ? r.mbps : 0;
    render();
  }, render);
});

for (const control of COPIES) control.button.addEventListener('click', () => copy(control));

// The first frame, before any payload can arrive, and then both channels: the push
// (every change) and the one read (the state at this instant). Both carry the same
// shape, so there is one place that knows what a payload is. If the main process cannot
// answer yet, the drawn frame stays — what may not happen is a blank page in silence.
render();
api.onState(apply);
void api.state().then(apply, render);
