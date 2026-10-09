// tools/ui-live.mjs — read the *real* window: packaged preload, real IPC payload, real
// renderer.js.  tools/ui-probe.mjs draws the layout through a stand-in bridge; this one
// checks the other half — that the payload the main process actually pushes draws
// without a single page error and fills every node the markup promises.
//
// Usage: node tools/ui-live.mjs [port]   (the app must run with
//        --remote-debugging-port=<port>; tools/ui-live.sh does that)
const port = Number(process.argv[2] ?? 9357);
const deadline = Date.now() + 20_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // the devtools endpoint is not up yet
    }
    await sleep(300);
  }
  throw new Error(`no debuggable page on 127.0.0.1:${port} within 20s`);
}

const page = await findPage();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

// Everything the page reports as a problem, for as long as we watch it.
const errors = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    errors.push(`exception ${d.text} ${d.exception?.description ?? ''}`.trim());
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    errors.push(`console ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    const e = msg.params.entry;
    if (!/GPU process|libva|dbus|Fontconfig/.test(e.text)) errors.push(`log ${e.text} (${e.url ?? ''})`);
  }
});

await send('Runtime.enable');
await send('Log.enable');

// The ids index.html promises.  A missing one is a typo the fake-DOM test cannot see
// (it builds its own tree), so the real document is where the contract is checked.
const IDS = [
  'app', 'state-chip', 'state-word', 'k-device', 'v-device', 'k-pc', 'v-pc', 'status-line', 'rtt',
  'udev', 'udev-cmd', 'copy-udev', 'copy-udev-label', 'restart-adb', 'restart-adb-label', 'more',
  'more-label', 'h-path', 'leg-usb', 'leg-usb-state', 'link-usb', 'leg-tcp', 'leg-tcp-state', 'link-tcp',
  'leg-udp', 'leg-udp-state', 'h-counts', 'stat-datagrams-box', 'stat-datagrams', 'stat-datagrams-k',
  'stat-bytes-box', 'stat-bytes', 'stat-bytes-k', 'stat-dropped-box', 'stat-dropped', 'stat-dropped-k',
  'stat-peers-box', 'stat-peers', 'stat-peers-k', 'h-related', 'k-client', 'v-client', 'k-host', 'v-host',
  'k-adb', 'v-adb', 'h-ports', 'ports', 'ports-none', 'copy-ports', 'copy-ports-label', 'h-logs', 'logs',
  'copy', 'copy-label', 'measure', 'measure-label', 'main-button', 'copy-live',
];

const snapshot = `(() => {
  const g = (id) => document.getElementById(id);
  const txt = (id) => (g(id) ? g(id).textContent.trim() : null);
  const box = (sel) => { const e = document.querySelector(sel); return e ? e.getBoundingClientRect().toJSON() : null; };
  const missing = ${JSON.stringify(IDS)}.filter((id) => !g(id));
  return JSON.stringify({
    readyState: document.readyState,
    bridge: Object.keys(window.ether ?? {}).sort(),
    missing,
    lang: document.documentElement.lang,
    chip: { cls: g('state-chip').className, word: txt('state-word') },
    button: { text: txt('main-button'), disabled: g('main-button').disabled },
    device: { label: txt('k-device'), value: txt('v-device') },
    pc: { label: txt('k-pc'), value: txt('v-pc') },
    status: txt('status-line'),
    more: txt('more-label'),
    countsHeading: txt('h-counts'),
    logsFirst: (txt('logs') ?? '').split('\\n')[0],
    cardBox: box('.card'),
    fieldsBox: box('.fields'),
    footerBox: box('.footer'),
    moreBox: box('.more'),
    chrome: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--page-chrome')),
    overflowX: [...document.querySelectorAll('body *')]
      .filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1).length,
    appbarTop: box('.appbar')?.top ?? null,
    actionbarBottom: box('.actionbar')?.bottom ?? null,
    viewport: { w: document.documentElement.clientWidth, h: window.innerHeight },
  });
})()`;

// Wait for the document *and* the bridge, then a beat for the first status push.
let live = null;
while (Date.now() < deadline) {
  const raw = (await send('Runtime.evaluate', { expression: snapshot, returnByValue: true })).result?.result?.value;
  if (typeof raw === 'string') {
    const s = JSON.parse(raw);
    if (s.readyState === 'complete' && s.bridge.length > 0) {
      live = s;
      if (s.chip.word && s.button.text) break;
    }
  }
  await sleep(300);
}
if (!live) {
  console.log('could not read the live window within 20s');
  process.exit(1);
}
await sleep(1200);
live = JSON.parse((await send('Runtime.evaluate', { expression: snapshot, returnByValue: true })).result.result.value);

// The toggle the reader reported: opening Details must not re-space the card.  This is
// a real click on the real summary in the real window, so it covers whatever the
// live state happens to be.
await send('Runtime.evaluate', { expression: `(document.querySelector('.summary').click(), 'ok')`, returnByValue: true });
await sleep(600);
const opened = JSON.parse((await send('Runtime.evaluate', { expression: snapshot, returnByValue: true })).result.result.value);
const still =
  Math.abs(opened.cardBox.top - live.cardBox.top) <= 0.5 &&
  Math.abs(opened.cardBox.height - live.cardBox.height) <= 0.5 &&
  Math.abs(opened.fieldsBox.top - live.fieldsBox.top) <= 0.5 &&
  Math.abs(opened.footerBox.top - live.footerBox.top) <= 0.5 &&
  Math.abs(opened.moreBox.top - live.moreBox.top) <= 0.5;

console.log('readyState     :', live.readyState, '  lang:', live.lang);
console.log('bridge keys    :', live.bridge.join(', '));
console.log('viewport       :', `${live.viewport.w}×${live.viewport.h} CSS px`);
console.log('chip           :', JSON.stringify(live.chip));
console.log('button         :', JSON.stringify(live.button));
console.log('rows           :', JSON.stringify(live.device), JSON.stringify(live.pc));
console.log('status line    :', JSON.stringify(live.status));
console.log('Details label  :', JSON.stringify(live.more), '  counts heading:', JSON.stringify(live.countsHeading));
console.log('first log line :', JSON.stringify(live.logsFirst));
console.log('rails          :', `appbar.top=${live.appbarTop} actionbar.bottom=${live.actionbarBottom}`);
console.log('card           :', `closed ${live.cardBox.height}@${live.cardBox.top}, open ${opened.cardBox.height}@${opened.cardBox.top}, footer ${live.footerBox.top} → ${opened.footerBox.top}`);
console.log('page errors    :', errors.length === 0 ? 'none' : errors.join(' | '));

const checks = [
  ['every id in the contract exists', live.missing.length === 0, live.missing.join(', ')],
  ['the real payload drew a state word', live.chip.word.length > 0 && live.button.text.length > 0, JSON.stringify(live.chip)],
  ['the page is English, and so is the button', live.lang === 'en' && !/[\u3400-\u9fff]/.test(live.button.text), `${live.lang} / ${live.button.text}`],
  ['the real payload drew its rows', live.device.value.length > 0 && live.pc.value.length > 0, JSON.stringify(live.device)],
  ['the two rails are flush to the window', live.appbarTop === 0 && live.actionbarBottom === live.viewport.h, `${live.appbarTop}/${live.actionbarBottom}`],
  ['nothing is drawn outside the column', live.overflowX === 0, String(live.overflowX)],
  ['opening Details re-spaces nothing in the real window', still, `card ${live.cardBox.height}@${live.cardBox.top} → ${opened.cardBox.height}@${opened.cardBox.top}, footer ${live.footerBox.top} → ${opened.footerBox.top}`],
  [
    'the real card is never shorter than the window leaves it',
    live.cardBox.height >= live.viewport.h - live.chrome - 0.5,
    `card ${live.cardBox.height}, window ${live.viewport.h} − chrome ${live.chrome}`,
  ],
  ['the page threw nothing', errors.length === 0, errors.join(' | ')],
];
let bad = 0;
for (const [what, ok, detail] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : ` — ${detail}`}`);
}
console.log(`\nui live: ${checks.length - bad}/${checks.length} checks passed`);
process.exit(bad === 0 ? 0 : 1);
