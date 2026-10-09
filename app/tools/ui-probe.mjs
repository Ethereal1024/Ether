// ui-probe.mjs — look at the window's layout in the real engine.
//
// This is not a second test suite.  It answers the questions a stylesheet can only be
// asked from inside a real engine: is the column 560×320 CSS px, does anything escape
// it sideways, do the two rails stay put while the page scrolls, is the one button on
// the bottom edge and big enough, does a value that got cut off still carry a tooltip.
// Behaviour (which word for which state, which copy block, the 200-line cap) is pinned
// by renderer.test.ts against a fake DOM; this run is about where the boxes land.
//
// It runs the app's own `index.html` markup, `style.css` and `renderer.js`: the body of
// index.html is lifted at run time, and the only thing added is a stand-in for the
// preload bridge.  No markup is duplicated here, and nothing touches the main process,
// adb, or a tablet.
//
// The app's own 560×320 window loads the probe page, and the layout viewport is pinned
// to 560×320 CSS px at device pixel ratio 1 — the window's own content size
// (main/index.ts) — so the screenshots are the layout under test and not a scaled copy
// of it.  `window.ether` cannot be replaced from a page (the preload's bridge is
// non-writable on purpose), so renderer.js is handed the stand-in the one way that
// works: the same file, wrapped in a scope where `window` is the stand-in.
//
// Usage: node tools/ui-probe.mjs <cdp-port> [shotdir]   (from the app root; ui-probe.sh
// does that and passes the port and the shot directory)
// Exit code 0 = every invariant held.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { t, uiLabels } from '../dist/src/main/messages.js';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(toolsDir, '..');
const port = Number(process.argv[2] ?? 9356);
const shotDir = process.argv[3] ?? '';
const deadline = Date.now() + 60_000;
const WIDTH = 560;
const HEIGHT = 320;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the states to draw, built out of the app's own sentences ────────────────

const labels = uiLabels();

const base = {
  state: 'idle',
  message: '',
  logs: [],
  channels: [],
  tcpMap: [],
  udpMap: [],
  stats: {},
};

const logs = Array.from({ length: 40 }, (_, i) => `[${String(i).padStart(2, '0')}] relay: frame ${i} forwarded`);
const ports = { base: 47989 };
const device = { serial: '9C0X1A2B3C4D', model: 'Pixel 8', state: 'device' };
const up = {
  ...base,
  state: 'up',
  messageKey: 'ready',
  message: t('ready'),
  device,
  sunshine: 'up',
  ports,
  adb: { path: '/usr/bin/adb', version: '1.0.41', conflict: false },
  channels: ['47984 HTTPS', '47989 HTTP', '48010 RTSP', '47998 Video'],
  tcpMap: [
    [47984, 38090],
    [47989, 38091],
    [48010, 38092],
  ],
  udpMap: [
    [47998, 38093],
    [47999, 38094],
  ],
  stats: { datagrams: 148231, bytes: 190234567, dropped: 0, peers: 2 },
  logs,
  mbps: 119.4,
};
const udevState = {
  ...base,
  state: 'error',
  messageKey: 'noPermissions',
  message: t('noPermissions'),
  device,
  sunshine: 'up',
  ports,
  adb: { path: '/usr/bin/adb', version: '1.0.41', conflict: false },
  hint: 'SUBSYSTEM=="usb", ATTR{idVendor}=="18d1", MODE="0666"',
};

// The one state where the card's last line has to hold both kinds of news: the
// cable is real and the tunnel carries, but the udp leg does not — so the sentence
// takes the line and the diagram is what it is about. Drawn here because it is the
// only shot where the two halves of that line compete for the width.
const degraded = {
  ...up,
  state: 'degraded',
  messageKey: 'udpFail',
  message: t('udpFail'),
  udpMap: [],
};

// The state the window sits in most of the time: the cable is in and adb sees the
// device, but nothing has been started.  This is the one shot where the path is
// drawn with a leg carrying and legs that are not — the reason it is drawn at all.
const plugged = { ...base, device };

// The state where the app can install the missing access rule itself, through the
// desktop's own consent prompt: the remedy is offered from the first screen, which is
// exactly where a user who just read "no permissions" is looking.
const fixState = { ...up, fix: 'grantDeviceAccess' };

const STATES = [
  ['01-idle.png', base, false, null],
  ['02-up.png', up, false, null],
  ['03-working.png', { ...base, state: 'starting' }, false, null],
  ['04-error.png', { ...base, state: 'error', messageKey: 'noDevice', message: t('noDevice') }, false, null],
  ['05-udev.png', udevState, false, null],
  ['06-details-up.png', up, true, null],
  ['07-details-ports.png', up, true, '#ports'],
  ['08-details-logs.png', { ...up, logs: logs.map((l) => `2024-05-05T10:00:00Z ${l}`) }, true, '#logs'],
  ['09-degraded.png', degraded, false, null],
  ['10-plugged.png', plugged, false, null],
  // The switches have their own shot: they are the first block of the sheet, so at
  // scroll 0 they sit under the action rail and no other shot shows them at all.
  ['11-details-startup.png', up, true, '#h-startup'],
  // The remedy the app carries out itself, drawn where it belongs: above the
  // disclosure, on the screen the user is already on.
  ['12-fix.png', fixState, false, null],
];

// ── the probe page: the shipping markup, a stand-in bridge ─────────────────

const html = readFileSync(path.join(appRoot, 'src', 'renderer', 'index.html'), 'utf8');
const rendererSrc = readFileSync(path.join(appRoot, 'src', 'renderer', 'renderer.js'), 'utf8');
const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)[1].replace(/<script src="renderer\.js"><\/script>/, '');
writeFileSync(
  path.join(toolsDir, 'ui-probe.html'),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="../src/renderer/style.css" />
    <title>Ether (layout probe)</title>
  </head>
  <body>${body}
    <script src="ui-probe-fake.js"></script>
    <script src="ui-probe-run.js"></script>
  </body>
</html>
`,
);
writeFileSync(
  path.join(toolsDir, 'ui-probe-fake.js'),
  `// Generated by ui-probe.mjs: the preload bridge, in the app's own words.
window.__probe = { labels: ${JSON.stringify(labels)}, fake: null };
// The switches' own half of the payload, and what a verb answered: the stand-in keeps
// them in one object the way the main process does, so a switch drawn from the answer is
// the same thing as a switch drawn from the payload.
window.__probe.settings = { autoConnect: false, launchAtLogin: false, keepRunning: true, error: false };
window.__probe.calls = [];
window.__probe.refuse = false;
// What a privileged run answered. One receipt, handed back the way a pushed status is,
// so the line under the button is the app's own sentence for the outcome.
window.__probe.receipt = { ok: true, reason: 'done' };
window.__probe.payload = { status: ${JSON.stringify(base)}, labels: window.__probe.labels, settings: window.__probe.settings, lang: 'en' };
window.__probe.verbs = {
  up: { status: ${JSON.stringify({ ...up, mbps: 0 })}, labels: window.__probe.labels, settings: window.__probe.settings, lang: 'en' },
  idle: { status: ${JSON.stringify(base)}, labels: window.__probe.labels, settings: window.__probe.settings, lang: 'en' },
};
window.__probe.fake = {
  state: () => Promise.resolve(window.__probe.payload),
  start: () => Promise.resolve(window.__probe.verbs.up),
  stop: () => Promise.resolve(window.__probe.verbs.idle),
  restartAdb: () => Promise.resolve(window.__probe.verbs.idle),
  measure: () => Promise.resolve({ ok: true, mbps: 103.1 }),
  fix: () => {
    window.__probe.calls.push({ key: 'fix', value: true });
    // The remedy is behind the prompt and never in the answer: what comes back is the
    // receipt, exactly as the main process sends it.
    return Promise.resolve({
      status: Object.assign({}, window.__probe.payload.status, { fix: undefined, fixResult: window.__probe.receipt }),
      labels: window.__probe.labels,
      settings: window.__probe.settings,
    });
  },
  setSetting: (o) => {
    const key = String((o || {}).key || '');
    const value = (o || {}).value === true;
    window.__probe.calls.push({ key, value });
    if (key === 'autoConnect' || key === 'launchAtLogin' || key === 'keepRunning') {
      // The answer, not the request: an OS that will not take the change comes back with
      // the setting where it was and \`error\` set, which is what the note under the
      // switches is drawn from.
      window.__probe.settings = Object.assign({}, window.__probe.settings, {
        [key]: window.__probe.refuse ? window.__probe.settings[key] : value,
        error: window.__probe.refuse === true,
      });
    }
    return Promise.resolve({
      status: window.__probe.payload.status,
      labels: window.__probe.labels,
      settings: window.__probe.settings,
    });
  },
  onState: (cb) => {
    window.__probe.emit = cb;
  },
};
window.__probeWindow = { ether: window.__probe.fake };
`,
);
// `src/renderer/renderer.js`, verbatim, in a scope whose `window` is the stand-in: the
// page's own bridge is not replaceable, and a copy of the renderer would be a second
// thing to keep true.
writeFileSync(
  path.join(toolsDir, 'ui-probe-run.js'),
  `(function (window, document, navigator, setTimeout) {\n${rendererSrc}\n})(window.__probeWindow, document, navigator, window.setTimeout);\n`,
);

// ── CDP plumbing ───────────────────────────────────────────────────────────

function connect(url) {
  const ws = new WebSocket(url);
  let seq = 0;
  const open = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const send = (method, params = {}) => {
    const id = ++seq;
    return new Promise((resolve) => {
      const onMessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id !== id) return;
        ws.removeEventListener('message', onMessage);
        resolve(msg);
      };
      ws.addEventListener('message', onMessage);
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
  return { ws, open, send };
}

async function findPage() {
  while (Date.now() < deadline) {
    try {
      const found = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
        (x) => x.type === 'page' && x.webSocketDebuggerUrl,
      );
      if (found) return found;
    } catch {
      // the devtools endpoint is not up yet
    }
    await wait(300);
  }
  throw new Error(`no debug page on 127.0.0.1:${port} within 60s`);
}

const appPage = await findPage();
const probe = connect(appPage.webSocketDebuggerUrl);
await probe.open;
await probe.send('Runtime.enable');
await probe.send('Page.enable');
await probe.send('Page.navigate', { url: `file://${path.join(toolsDir, 'ui-probe.html')}` });
await wait(600);
await probe.send('Emulation.setDeviceMetricsOverride', {
  width: WIDTH,
  height: HEIGHT,
  deviceScaleFactor: 1,
  mobile: false,
});

const evaluate = async (expression, awaitPromise = false) => {
  const res = await probe.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  const ex = res.result?.exceptionDetails;
  if (ex) throw new Error(`page threw: ${ex.exception?.description ?? ex.text ?? 'unknown'}`);
  return res.result?.result?.value;
};
const json = async (expression) => JSON.parse((await evaluate(`JSON.stringify(${expression})`)) ?? 'null');

// The stand-in must be the bridge renderer.js used: only its `onState` records a
// callback, so an undefined `__probe.emit` means the wrapped source never ran and every
// number below would be about a page nothing drew.
if ((await evaluate('typeof window.__probe.emit')) !== 'function') {
  console.log('FAIL: renderer.js did not run against the stand-in bridge');
  process.exit(1);
}

// The first frame is drawn by renderer.js itself; wait until the payload has replaced
// its placeholder word, so no shot is of a page that has nothing in it yet.
let painted = false;
while (Date.now() < deadline) {
  const word = await evaluate(`(document.getElementById('main-button') || {}).textContent || ''`);
  if (typeof word === 'string' && word.trim() !== '' && word.trim() !== '…') {
    painted = true;
    break;
  }
  await wait(250);
}
if (!painted) {
  console.log('FAIL: the renderer never painted its first frame');
  process.exit(1);
}

// ── in-page helpers ─────────────────────────────────────────────────────────

await evaluate(`
window.__ui = {
  emit(status, settings) { window.__probe.payload.status = status; window.__probe.emit({ labels: window.__probe.labels, status, lang: 'en', settings: settings || window.__probe.settings }); },
  scrollTo(top) { document.getElementById('app').scrollTop = top; },
  open(on) { document.getElementById('more').open = on; },
  /** Every element whose box leaves the column sideways, worst first. */
  overflow() {
    const out = [];
    for (const e of document.querySelectorAll('body *')) {
      if (e.hidden || e.closest('[hidden]')) continue;
      const b = e.getBoundingClientRect();
      if (b.width <= 0 && b.height <= 0) continue;
      const over = Math.max(0, -b.left, b.right - innerWidth);
      if (over > 1) out.push({ id: e.id || '.' + String(e.className).split(/\\s+/)[0], over: +over.toFixed(2) });
    }
    return out.sort((a, b) => b.over - a.over).slice(0, 5);
  },
  box(sel) {
    const e = document.querySelector(sel);
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return { top: +b.top.toFixed(2), left: +b.left.toFixed(2), right: +b.right.toFixed(2),
             bottom: +b.bottom.toFixed(2), w: +b.width.toFixed(2), h: +b.height.toFixed(2) };
  },
  /** Rows whose text is longer than the room they were given. */
  clipped() {
    const out = [];
    for (const e of document.querySelectorAll('.value, .chip, .status, .leg-name, .leg-state, .brand, .block-title, .code')) {
      if (e.hidden || !e.textContent.trim()) continue;
      if (e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1) {
        out.push({ id: e.id || '.' + String(e.className).split(/\\s+/)[0], title: e.title, wraps: e.scrollHeight > e.clientHeight + 1 });
      }
    }
    return out;
  },
  /** A row that is cut off must carry its whole value as a tooltip; a row that wrapped
   *  is not cut off at all and needs none. */
  unrecoverable() {
    return window.__ui.clipped().filter((c) => !c.wraps && !c.title).map((c) => c.id);
  },
  /** Contrast of an element's own text against the first opaque background above it.
   *  Colours arrive in whatever space the sheet used (this one is oklch), so they go
   *  through a canvas to become the sRGB bytes the eye actually gets. */
  contrast(sel) {
    const e = document.querySelector(sel);
    if (!e) return null;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rgb = (css) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    };
    const lum = ([r, g, b]) => {
      const ch = [r, g, b].map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    };
    let node = e;
    let bg = null;
    while (node && !bg) {
      const c = rgb(getComputedStyle(node).backgroundColor);
      if (c[3] >= 0.95) bg = c;
      node = node.parentElement;
    }
    if (!bg) bg = rgb(getComputedStyle(document.body).backgroundColor);
    if (bg[3] < 0.95) bg = [19, 19, 19];
    const fg = rgb(getComputedStyle(e).color);
    const a = lum(fg);
    const b = lum(bg);
    return +((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2);
  },
  oneRow(sel) {
    const tops = [...document.querySelectorAll(sel)].map((e) => +e.getBoundingClientRect().top.toFixed(1));
    return { count: tops.length, spread: +(Math.max(...tops) - Math.min(...tops)).toFixed(2) };
  },
  state() {
    return {
      chip: document.getElementById('state-chip').className,
      word: document.getElementById('state-word').textContent,
      button: document.getElementById('main-button').textContent,
      disabled: document.getElementById('main-button').disabled,
      status: document.getElementById('status-line').textContent,
      udevHidden: document.getElementById('udev').hidden,
      restartHidden: document.getElementById('restart-adb').hidden,
      measureDisabled: document.getElementById('measure').disabled,
      rttHidden: document.getElementById('rtt').hidden,
    };
  },
};
'ok'`);

const draw = async (status, open, focus) => {
  await evaluate(
    `(window.__ui.emit(${JSON.stringify(status)}), window.__ui.open(${open}), document.getElementById('app').scrollTop = 0, 'ok')`,
  );
  // The title rail is sticky inside the scroller, so `scrollIntoView` — which aims at the
  // scrollport's own top edge — parks the block *behind* it and the shot opens on a
  // heading the reader cannot see.  Land it just under the rail instead.
  if (focus) {
    await evaluate(`(() => {
      const app = document.getElementById('app');
      const rail = document.querySelector('.appbar').getBoundingClientRect().height + 8;
      const top = document.querySelector(${JSON.stringify(focus)}).getBoundingClientRect().top;
      app.scrollTop = app.scrollTop + top - rail;
      return 'ok';
    })()`);
  }
  await wait(340); // every colour transitions over --fast: ask after it has settled
};
const state = () => json('window.__ui.state()');

// ── the checks ─────────────────────────────────────────────────────────────

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail });

const viewport = await json('({ w: innerWidth, h: innerHeight })');
check('the column is 560×320 CSS px', viewport.w === WIDTH && viewport.h === HEIGHT, `got ${viewport.w}×${viewport.h}`);

await draw(base, false, 0);
const idle = await state();
check('the chip and the button carry the idle state', idle.word === labels.off && idle.button === labels.start, JSON.stringify(idle));

const doc = await json('({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })');
check('the page itself never scrolls sideways', doc.sw <= doc.cw + 1, JSON.stringify(doc));
check('nothing escapes the column', (await json('window.__ui.overflow()')).length === 0, JSON.stringify(await json('window.__ui.overflow()')));

const appbar = await json('window.__ui.box(".appbar")');
const actionbar = await json('window.__ui.box(".actionbar")');
const button = await json('window.__ui.box("#main-button")');
check('the title rail is flush to the top', appbar && Math.abs(appbar.top) <= 1, JSON.stringify(appbar));
check('the action rail is flush to the bottom', actionbar && Math.abs(actionbar.bottom - viewport.h) <= 1, JSON.stringify(actionbar));
check(
  'the one button sits inside the action rail, 32px tall or more',
  button && button.top >= actionbar.top - 1 && button.bottom <= actionbar.bottom + 1 && button.h >= 32,
  `button ${JSON.stringify(button)} in rail ${JSON.stringify(actionbar)}`,
);
check('the two rails are one row each and never overlap', actionbar.top >= appbar.bottom, `${appbar.bottom} vs ${actionbar.top}`);
const scroller = await json(
  '({ sh: document.getElementById("app").scrollHeight, ch: document.getElementById("app").clientHeight })',
);
check('the page scrolls only inside #app', scroller.ch === HEIGHT, JSON.stringify(scroller));

await draw(up, false, 0);
const upState = await state();
check('the chip turns green only while the link carries', upState.chip === 'chip ok' && upState.word === labels.on, JSON.stringify(upState));
check('the button offers to stop the link it started', upState.button === labels.stop && upState.disabled === false, upState.button);
check('the measured round trip is drawn with the link', upState.rttHidden === false, String(upState.rttHidden));

await draw(up, true, 0);
const stats = await json('window.__ui.oneRow(".stat")');
check('the four counters share one line', stats.count === 4 && stats.spread <= 1, JSON.stringify(stats));
const legRow = await json('window.__ui.oneRow(".leg")');
check('the three legs share one line', legRow.count === 3 && legRow.spread <= 1, JSON.stringify(legRow));
const logWell = await json(
  '({ ch: document.getElementById("logs").clientHeight, sh: document.getElementById("logs").scrollHeight })',
);
check('the log scrolls inside its own well instead of growing the page', logWell.sh > logWell.ch && logWell.ch <= 200, JSON.stringify(logWell));

// The rails are sticky: with the disclosure open and the page at its end, the title is
// still at the top, the button is still on the bottom edge, and the last block of the
// page is reachable above it.
await draw(up, true, null);
await evaluate('(window.__ui.scrollTo(1e6), "ok")');
await wait(150);
const scrolled = await json(
  '({ appbar: window.__ui.box(".appbar"), actionbar: window.__ui.box(".actionbar"), last: window.__ui.box("#measure"), top: document.getElementById("app").scrollTop })',
);
check('scrolling the page does not move the title rail', scrolled.top > 0 && Math.abs(scrolled.appbar.top) <= 1, JSON.stringify(scrolled.appbar));
check('scrolling the page does not move the action rail', Math.abs(scrolled.actionbar.bottom - viewport.h) <= 1, JSON.stringify(scrolled.actionbar));
check(
  'the end of the page is reachable above the action rail',
  scrolled.last.bottom <= scrolled.actionbar.top + 1,
  `last block ${JSON.stringify(scrolled.last)} vs rail top ${scrolled.actionbar.top}`,
);

const clipped = await json('window.__ui.unrecoverable()');
check('a value cut off by its row still carries its whole self as a tooltip', clipped.length === 0, JSON.stringify(clipped));

await draw(udevState, false, 0);
const udev = await state();
check('the udev remedy appears only in the state that has it', udev.udevHidden === false && udev.restartHidden === true, JSON.stringify(udev));
check('the reason drawn is the sentence the user reads', udev.status === t('noPermissions'), udev.status);

await draw({ ...base, state: 'error', messageKey: 'adbConflict', message: t('adbConflict') }, false, 0);
const conflict = await state();
check('restarting adb is offered only for the conflict it fixes', conflict.restartHidden === false && conflict.udevHidden === true, JSON.stringify(conflict));
check('with no link there is nothing to measure', conflict.measureDisabled === true, String(conflict.measureDisabled));

await draw({ ...base, state: 'starting' }, false, 0);
const working = await state();
check('a verb in flight is one word and a locked button', working.button === labels.working && working.disabled === true, JSON.stringify(working));

for (const [name, status, open, scroll] of STATES) {
  await draw(status, open, scroll);
  const over = await json('window.__ui.overflow()');
  check(`${name}: drawn inside the column`, over.length === 0, JSON.stringify(over));
}

// Text the reader has to read, in the tone it is drawn in.
for (const [sel, what] of [
  ['#status-line', 'the sentence under the rows'],
  ['.brand', 'the window title'],
  ['.value', 'a row value'],
  ['.leg-name', 'a leg name'],
  ['.block-title', 'a section heading'],
]) {
  const ratio = await json(`window.__ui.contrast(${JSON.stringify(sel)})`);
  check(`${what} clears 4.5:1`, ratio !== null && ratio >= 4.5, `${sel} ${ratio}:1`);
}

// ── the toggle must not re-space the card ──────────────────────────────────

// Details opens a sheet taller than the window, so the page always overflows once it
// is open: a card that grew from the page's leftover space would lose that slack
// in one step and the rows above the disclosure would jump.  The card's height
// therefore has to come from the window, not from what the page has left over,
// and it has to be the same closed and open.

const geom = () =>
  json(`({
    card: window.__ui.box(".card"),
    fields: window.__ui.box(".fields"),
    footer: window.__ui.box(".footer"),
    more: window.__ui.box(".more"),
    sheet: window.__ui.box(".sheet"),
    rail: window.__ui.box(".actionbar"),
    scroll: document.getElementById("app").scrollHeight,
    client: document.getElementById("app").clientHeight,
  })`);
const tokens = await json(`({
  chrome: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--page-chrome")),
  inset: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--s-4")),
})`);
const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;
const air = (g) => g.footer.top - g.fields.bottom; // the blank the reader sees under the PC row

await draw(up, false, 0);
const closed = await geom();
await draw(up, true, 0);
const opened = await geom();

check(
  'opening Details moves nothing above it',
  near(closed.card.top, opened.card.top) && near(closed.fields.top, opened.fields.top),
  `card ${closed.card.top}→${opened.card.top}, rows ${closed.fields.top}→${opened.fields.top}`,
);
check(
  'opening Details does not resize the card',
  near(closed.card.h, opened.card.h),
  `closed ${closed.card.h}, open ${opened.card.h}`,
);
check(
  'the blank under the PC row is the same size either way',
  near(air(closed), air(opened)),
  `closed ${air(closed)}, open ${air(opened)}`,
);
check(
  'opening Details does not move the path line',
  near(closed.footer.top, opened.footer.top),
  `closed ${closed.footer.top}, open ${opened.footer.top}`,
);
check(
  'opening Details does not move the disclosure row',
  near(closed.more.top, opened.more.top) && near(closed.rail.top, opened.rail.top),
  `row ${closed.more.top}→${opened.more.top}, rail ${closed.rail.top}→${opened.rail.top}`,
);
check(
  'the card is drawn as tall as the window leaves it',
  near(closed.card.h, viewport.h - tokens.chrome),
  `card ${closed.card.h}, window ${viewport.h} − chrome ${tokens.chrome}`,
);
check(
  'the closed page ends on its own inset, with no orphan band',
  near(closed.more.bottom, closed.rail.top - tokens.inset, 1),
  `row bottom ${closed.more.bottom}, rail top ${closed.rail.top} − inset ${tokens.inset}`,
);
check(
  'the closed page does not scroll: nothing is cut off to make room',
  closed.scroll <= closed.client + 1,
  `scroll ${closed.scroll}, client ${closed.client}`,
);

// Every state has to pass the same test, whatever its rows hold: opening Details may
// push what is *below* the card down the page, but nothing at or above the card
// may move.  And no state may leave the card shorter than the window's allowance —
// that short card is what strands a band of empty window under the disclosure.
const toggleOffenders = [];
const shortStates = [];
for (const [name, status, , scroll] of STATES) {
  await draw(status, false, 0);
  const before = await geom();
  await draw(status, true, 0);
  const after = await geom();
  if (
    !near(before.card.top, after.card.top) ||
    !near(before.card.h, after.card.h) ||
    !near(before.fields.top, after.fields.top) ||
    !near(before.footer.top, after.footer.top) ||
    !near(before.more.top, after.more.top)
  ) {
    toggleOffenders.push(
      `${name}: card ${before.card.h}@${before.card.top} → ${after.card.h}@${after.card.top}, footer ${before.footer.top} → ${after.footer.top}`,
    );
  }
  if (before.card.h < viewport.h - tokens.chrome - 0.5) {
    shortStates.push(`${name} ${before.card.h} < ${(viewport.h - tokens.chrome).toFixed(1)}`);
  }
}
check('opening Details re-spaces the card in no state', toggleOffenders.length === 0, toggleOffenders.join(' | '));
check('no state leaves the card shorter than the window', shortStates.length === 0, shortStates.join(', '));

// ── the card fills the window at every zoom ────────────────────────────────
// The window cannot be resized and the rails are fixed CSS px, so a zoom press only
// moves the layout viewport: 320 CSS px at 1×, 320/f at f.  Pushing the viewport
// through the same heights is the layout the zoom chord produces — and the card's
// floor has to follow it, or a zoomed-out window gets the blank band back.  Below
// the point where the chrome alone fills the window the floor goes to 0 and the
// card is simply its own content height, which the page then scrolls.

await draw(up, false, 0);
const setViewport = async (h) => {
  await probe.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: h, deviceScaleFactor: 1, mobile: false });
  await wait(200);
};
const zoomOffenders = [];
await setViewport(185); // the tightest zoom the chord allows: the chrome no longer fits
const natural = (await geom()).card.h;
for (const h of [185, 232, 320, 461]) {
  await setViewport(h);
  const g = await geom();
  const want = Math.max(natural, h - tokens.chrome);
  // Once the window's allowance exceeds the card's own content, the page fits and
  // the disclosure row has to end on the page's inset; below that it scrolls.
  const fits = h - tokens.chrome >= natural - 0.5;
  if (!near(g.card.h, want, 1) || (fits && !near(g.more.bottom, g.rail.top - tokens.inset, 1))) {
    zoomOffenders.push(`h${h}: card ${g.card.h} want ${want.toFixed(1)}, row bottom ${g.more.bottom} rail ${g.rail.top - tokens.inset}`);
  }
}
check('the card fills the band at every zoom', zoomOffenders.length === 0, zoomOffenders.join(' | '));
await setViewport(HEIGHT);

// ── the switches in Details → Startup ──────────────────────────────────────

// The switches are drawn from the payload like every other node, and a click is an ask:
// the box is drawn again from what came back, never flipped locally.  The stand-in
// answers the way the main process does, including the refusal.  The third switch is the
// one about the window itself: with it on, closing the window is not the end of the link.

const SWITCHES = [
  ['set-at-login', 'launchAtLogin'],
  ['set-auto-connect', 'autoConnect'],
  ['set-keep-running', 'keepRunning'],
];

await draw(up, true, 0);
const switches = await json(`({
  heading: document.getElementById('h-startup').textContent.trim(),
  labels: ${JSON.stringify(SWITCHES.map(([id]) => id + '-label'))}.map((id) => document.getElementById(id).textContent.trim()),
  checked: ${JSON.stringify(SWITCHES.map(([id]) => id))}.map((id) => document.getElementById(id).checked),
  note: document.getElementById('startup-note').hidden,
  boxes: ${JSON.stringify(SWITCHES.map(([id]) => '#' + id))}.map((sel) => window.__ui.box(sel)),
})`);
check(
  'the switches start in the state the file holds: nothing at login, no auto connect, and a window that keeps the link up',
  switches.heading.length > 0 &&
    switches.checked[0] === false &&
    switches.checked[1] === false &&
    switches.checked[2] === true &&
    switches.note === true,
  JSON.stringify(switches),
);
check(
  'each switch is labelled in the window’s own words',
  switches.labels.every((l) => l.length > 0) && !/[\u3400-\u9fff]/.test(`${switches.heading}${switches.labels.join('')}`),
  JSON.stringify([switches.heading, ...switches.labels]),
);
check(
  'the switches are one column of equal rows, not a sideways row',
  switches.boxes.every((b, i) => b && (i === 0 || (b.top >= switches.boxes[i - 1].bottom - 0.5 && b.left === switches.boxes[0].left))),
  JSON.stringify(switches.boxes),
);

await evaluate(`(document.getElementById('set-at-login').click(), 'ok')`);
await wait(250); // the answer is a promise: the box is drawn when it lands
await evaluate(`(document.getElementById('set-auto-connect').click(), 'ok')`);
await wait(250);
const clicked = await json(`({
  calls: window.__probe.calls.slice(-2),
  atLogin: document.getElementById('set-at-login').checked,
  autoConnect: document.getElementById('set-auto-connect').checked,
  keepRunning: document.getElementById('set-keep-running').checked,
  note: document.getElementById('startup-note').hidden,
})`);
check(
  'each switch asks the bridge by its own name, and is drawn from the answer it gets back',
  clicked.calls[0]?.key === 'launchAtLogin' &&
    clicked.calls[0].value === true &&
    clicked.calls[1]?.key === 'autoConnect' &&
    clicked.calls[1].value === true &&
    clicked.atLogin === true &&
    clicked.autoConnect === true &&
    clicked.keepRunning === true &&
    clicked.note === true,
  JSON.stringify(clicked),
);

// The one the OS can refuse: turning the keep-alive switch off from the answer alone is
// how the window would lie about a file it never wrote, so a refusal has to leave the
// box where the payload put it.
await evaluate(`(window.__probe.refuse = true, document.getElementById('set-keep-running').click(), 'ok')`);
await wait(250);
const refused = await json(`({
  call: window.__probe.calls[window.__probe.calls.length - 1],
  note: document.getElementById('startup-note').textContent.trim(),
  hidden: document.getElementById('startup-note').hidden,
  status: document.getElementById('status-line').textContent.trim(),
  keepRunning: document.getElementById('set-keep-running').checked,
  contrast: window.__ui.contrast('#startup-note'),
  over: window.__ui.overflow(),
})`);
check(
  'a change the app could not make says so under the switches, and leaves them where they were',
  refused.call?.key === 'keepRunning' &&
    refused.call.value === false &&
    refused.note === labels.startupError &&
    refused.hidden === false &&
    refused.keepRunning === true,
  JSON.stringify(refused),
);
check(
  'the refusal is the switch’s own line, not the status line the link writes',
  refused.status === '',
  JSON.stringify(refused.status),
);
check('the refusal clears 4.5:1 on the sheet', refused.contrast !== null && refused.contrast >= 4.5, `${refused.contrast}:1`);
check('the refusal is drawn inside the column', refused.over.length === 0, JSON.stringify(refused.over));

// Back to the state the shots are taken in: three switches, the file's own values, and
// nothing to say.
await evaluate(
  `(window.__probe.refuse = false, window.__probe.settings = { autoConnect: false, launchAtLogin: false, keepRunning: true, error: false }, 'ok')`,
);
await draw(up, true, 0);

// ── the remedy well ────────────────────────────────────────────────────────

// The one well whose action the app performs itself, through the desktop's own consent
// prompt.  Whether there is a remedy at all is the main process's word (`status.fix`),
// never the window's guess, so what has to hold is: nothing offered → nothing on screen;
// offered → one button named for what it installs; pressed → the receipt the answer
// carried, and no button to press twice; a desktop with no tray at all → the note that
// says why closing the window only minimises it.

await draw(up, false, 0);
check(
  'with nothing to fix, the remedy well is not on screen at all',
  (await json(`document.getElementById('fix').hidden`)) === true,
  'fix well',
);

await draw(fixState, false, 0);
const offered = await json(`({
  hidden: document.getElementById('fix').hidden,
  button: document.getElementById('fix-button').hidden,
  label: document.getElementById('fix-label').textContent.trim(),
  note: document.getElementById('fix-note').hidden,
  contrast: window.__ui.contrast('#fix-label'),
  over: window.__ui.overflow(),
  box: window.__ui.box('#fix'),
})`);
check(
  'a remedy the app can carry out is offered as one button named for the change',
  offered.hidden === false && offered.button === false && offered.label === labels.fixGrantAccess && offered.note === true,
  JSON.stringify(offered),
);
check('the offer clears 4.5:1 on the well', offered.contrast !== null && offered.contrast >= 4.5, `${offered.contrast}:1`);
check('the offer is drawn inside the column', offered.over.length === 0, JSON.stringify(offered.over));

await evaluate(`(document.getElementById('fix-button').click(), 'ok')`);
await wait(300);
const receipt = await json(`({
  pressed: window.__probe.calls.filter((c) => c.key === 'fix').length,
  hidden: document.getElementById('fix').hidden,
  button: document.getElementById('fix-button').hidden,
  note: document.getElementById('fix-note').textContent.trim(),
  noteHidden: document.getElementById('fix-note').hidden,
  over: window.__ui.overflow(),
})`);
check(
  'pressing the offer asks the bridge once, and what comes back is the receipt',
  receipt.pressed === 1 && receipt.hidden === false && receipt.button === true && receipt.note === labels.fixDone && receipt.noteHidden === false,
  JSON.stringify(receipt),
);
check('the receipt is drawn inside the column', receipt.over.length === 0, JSON.stringify(receipt.over));

// Every outcome a press can have, drawn on its own: a dismissal is an answer, and none
// of them may put the button back.
const reasons = { done: labels.fixDone, refused: labels.fixRefused, failed: labels.fixFailed, noBroker: labels.fixNoBroker };
const wrongReceipts = [];
for (const [reason, sentence] of Object.entries(reasons)) {
  await draw({ ...base, fixResult: { ok: reason === 'done', reason } }, false, 0);
  const got = await json(`({
    hidden: document.getElementById('fix').hidden,
    button: document.getElementById('fix-button').hidden,
    note: document.getElementById('fix-note').textContent.trim(),
  })`);
  if (got.hidden !== false || got.button !== true || got.note !== sentence) wrongReceipts.push(`${reason}: ${JSON.stringify(got)}`);
}
check('each outcome of a press is one of the app’s own sentences, with nothing left to press', wrongReceipts.length === 0, wrongReceipts.join(' | '));

await draw({ ...base, tray: { ok: false, fixable: false } }, false, 0);
const noTray = await json(`({
  hidden: document.getElementById('fix').hidden,
  button: document.getElementById('fix-button').hidden,
  note: document.getElementById('fix-note').textContent.trim(),
})`);
check(
  'a desktop with no tray says why closing the window only minimises it, and offers nothing to press',
  noTray.hidden === false && noTray.button === true && noTray.note === labels.trayMissing,
  JSON.stringify(noTray),
);

await draw({ ...base, tray: { ok: true, fixable: false } }, false, 0);
check(
  'a desktop whose tray works keeps the well off screen',
  (await json(`document.getElementById('fix').hidden`)) === true,
  'fix well',
);

// Both lines at once — the offer and the last receipt — have to stack in the well's own
// column: the note belongs under the button, never beside it.
await draw({ ...fixState, fixResult: { ok: false, reason: 'failed' } }, false, 0);
const stacked = await json(`({
  button: window.__ui.box('#fix-button'),
  note: window.__ui.box('#fix-note'),
  over: window.__ui.overflow(),
})`);
check(
  'the note sits under the button in the same column',
  stacked.button && stacked.note && stacked.note.top >= stacked.button.bottom - 0.5 && Math.abs(stacked.note.left - stacked.button.left) <= 1,
  JSON.stringify(stacked),
);
check('the well with both lines in it stays inside the column', stacked.over.length === 0, JSON.stringify(stacked.over));

// ── the shots ──────────────────────────────────────────────────────────────

if (shotDir) {
  console.log('\n── shots ─────────────────────────────────────────────────────────');
  for (const [name, status, open, scroll] of STATES) {
    await draw(status, open, scroll);
    await wait(400);
    const shot = await probe.send('Page.captureScreenshot', { format: 'png' });
    const data = shot.result?.data;
    if (!data) {
      console.log(`  ${name}  FAILED: ${JSON.stringify(shot.error ?? 'no data')}`);
      continue;
    }
    const png = Buffer.from(data, 'base64');
    writeFileSync(`${shotDir}/${name}`, png);
    console.log(`  ${name}  ${png.length} bytes`);
  }
}

// ── report ─────────────────────────────────────────────────────────────────

const failed = results.filter((r) => !r.ok);
console.log('\n──────────────────────────────────────────────────────────────────');
console.log(`ui probe: ${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name} — ${f.detail}`);
probe.ws.close();
process.exit(failed.length ? 1 : 0);
