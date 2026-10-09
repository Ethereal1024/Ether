// renderer.test.ts — the window, executed.
//
// This machine has no display, so `renderer.js` is run for real against a minimal DOM
// instead of being inspected: a button disabled before it asks the main process to do
// anything, a label that never arrives, or a live region rewritten on every push are
// all invisible to every other suite. The source checks at the end pin the rest — the
// CSP, the window's fixed size, and the fact that the page carries no user-facing
// string of its own.

import { t, uiLabels, type UiLabels } from '../src/main/messages.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...parts: string[]) => readFileSync(path.join(appRoot, ...parts), 'utf8');

const rendererSrc = read('src', 'renderer', 'renderer.js');
const htmlSrc = read('src', 'renderer', 'index.html');
const cssSrc = read('src', 'renderer', 'style.css');
const preloadSrc = read('src', 'main', 'preload.cjs');
const indexSrc = read('src', 'main', 'index.ts');

/** The two files with their comments removed: a comment is never drawn, so the copy
 * guards run on what ships to the user. */
const htmlCode = htmlSrc.replace(/<!--[\s\S]*?-->/g, '');
const rendererCode = rendererSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');

const CJK = /[\u3400-\u9fff]/;
/** A program this app talks to. Only Related software may name one. */
const PEER = /moonlight|sunshine/i;

/** The body of one rule, read out of a stylesheet. Anchored at the start of a line on
 * purpose: a selector here is the whole selector, never a fragment of one. */
function ruleIn(css: string, selector: string): string {
  const at = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{`, 'm').exec(css);
  assert.ok(at, `no rule for ${selector}`);
  return css.slice(at.index, css.indexOf('}', at.index));
}

type Push = Record<string, unknown>;

/** A status as the main process sends it, with the fields the renderer reads. */
const st = (over: Push = {}): Push => ({
  state: 'idle',
  message: '',
  logs: [],
  channels: [],
  tcpMap: [],
  udpMap: [],
  stats: {},
  ...over,
});

interface FakeEl {
  id: string;
  textContent: string;
  className: string;
  hidden: boolean;
  disabled: boolean;
  checked: boolean;
  title: string;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** How many times `textContent` was assigned. A guarded write must leave this at 1. */
  writes: number;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | undefined;
  classList: {
    toggle(name: string, on?: boolean): void;
    contains(name: string): boolean;
    add(name: string): void;
    remove(name: string): void;
  };
  addEventListener(event: string, fn: () => void): void;
  click(): void;
  /** Move a checkbox the way the platform does: set it, then fire `change`. */
  check(on: boolean): void;
}

interface Harness {
  el(id: string): FakeEl;
  /** Push a payload the way `api.onState` would. `labels`/`settings` stick until replaced. */
  push(status: Push, labels?: UiLabels, settings?: Push): void;
  settle(): Promise<void>;
  calls: { start: number; stop: number; restartAdb: number; measure: number; setSetting: number; fix: number };
  /** The last `{key, value}` a switch sent to the main process. */
  lastSetting: { key?: string; value?: unknown };
  /** Let the gated `start`/`stop` promise resolve. */
  release(): void;
  clipboard: string[];
  root: { lang: string };
  /** Every id the renderer asked the document for, and every id the markup declares. */
  requested: Set<string>;
  htmlIds: Set<string>;
}

/**
 * Load the real `renderer.js` against a minimal DOM. Only ids that exist in
 * index.html are handed out, so a typo in either file is a crash and not a silently
 * null node.
 *
 * `stateFails` makes the first read reject the way `requireController()` does while the
 * controller is still being built; `startFails` makes a verb throw, which has to reach
 * the sentence the user reads.
 */
function harness(opts: {
  stateFails?: boolean;
  startFails?: boolean;
  setSettingFails?: boolean;
  /** What the main process offers when the remedy button is pressed, and how it ends. */
  fixKind?: string;
  fixReason?: string;
} = {}): Harness {
  const htmlIds = new Set([...htmlSrc.matchAll(/id="([^"]+)"/g)].map((m) => m[1] as string));
  const requested = new Set<string>();
  const els = new Map<string, FakeEl>();

  const makeEl = (id: string): FakeEl => {
    const classes = new Set<string>();
    const handlers = new Map<string, () => void>();
    const attrs: Record<string, string> = {};
    const node: FakeEl = {
      id,
      textContent: '',
      className: '',
      hidden: false,
      disabled: false,
      checked: false,
      title: '',
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
      writes: 0,
      setAttribute(name, value) {
        attrs[name] = String(value);
      },
      getAttribute: (name) => attrs[name],
      classList: {
        toggle(name, on) {
          const want = on ?? !classes.has(name);
          if (want) classes.add(name);
          else classes.delete(name);
        },
        contains: (name) => classes.has(name),
        add: (name) => void classes.add(name),
        remove: (name) => void classes.delete(name),
      },
      addEventListener(event, fn) {
        handlers.set(event, fn);
      },
      click() {
        const fn = handlers.get('click');
        assert.ok(fn, `#${id} has no click handler`);
        fn();
      },
      check(on) {
        node.checked = on;
        const fn = handlers.get('change');
        assert.ok(fn, `#${id} has no change handler`);
        fn();
      },
    };
    let content = '';
    Object.defineProperty(node, 'textContent', {
      get: () => content,
      set: (value: string) => {
        content = String(value);
        node.writes += 1;
      },
    });
    return node;
  };

  // What `index.html` declares. The renderer never rewrites it: one language, fixed.
  const documentElement = { lang: 'en' };
  // The clipboard is recorded rather than swallowed: the three copy controls draw no
  // word, so a control wired to the wrong block would look exactly like a correct one.
  const clipboard: string[] = [];
  const document = {
    documentElement,
    getElementById(id: string): FakeEl | null {
      requested.add(id);
      if (!htmlIds.has(id)) return null;
      let e = els.get(id);
      if (!e) {
        e = makeEl(id);
        els.set(id, e);
      }
      return e;
    },
  };

  const calls = { start: 0, stop: 0, restartAdb: 0, measure: 0, setSetting: 0, fix: 0 };
  let release: () => void = () => undefined;
  const gate = () =>
    new Promise<void>((resolve) => {
      release = () => resolve();
    });

  let onState: ((payload: unknown) => void) | undefined;
  let lastLabels: UiLabels | undefined;
  let lastSettings: Push | undefined;
  const lastSetting: { key?: string; value?: unknown } = {};
  const api = {
    state: async () => {
      if (opts.stateFails) throw new Error('controller is not ready yet');
      return { status: st(), labels: {} };
    },
    start: async () => {
      calls.start += 1;
      await gate();
      if (opts.startFails) throw new Error('adb is not installed');
      return { status: st({ state: 'up', messageKey: 'ready', message: t('ready') }) };
    },
    stop: async () => {
      calls.stop += 1;
      await gate();
      return { status: st() };
    },
    restartAdb: async () => {
      calls.restartAdb += 1;
      return { status: st() };
    },
    measure: async () => {
      calls.measure += 1;
      return { ok: true, mbps: 103.1 };
    },
    /** The remedy button: the main process decides which remedy applies, carries it out
     * through the desktop's own consent prompt, and answers with the whole payload. */
    fix: async () => {
      calls.fix += 1;
      await gate();
      return {
        status: st({
          state: 'error',
          fix: opts.fixKind,
          fixResult: opts.fixReason ? { ok: opts.fixReason === 'done', reason: opts.fixReason } : undefined,
        }),
      };
    },
    /** The main process answers a switch with the whole payload, so the window draws
     * what happened — here, what was asked for. */
    setSetting: async (o: { key?: string; value?: unknown }) => {
      calls.setSetting += 1;
      lastSetting.key = o.key;
      lastSetting.value = o.value;
      if (opts.setSettingFails) throw new Error('the settings file is read-only');
      const next: Push = {
        autoConnect: false,
        launchAtLogin: false,
        keepRunning: true,
        error: false,
        ...(lastSettings ?? {}),
      };
      if (o.key === 'autoConnect') next.autoConnect = o.value === true;
      if (o.key === 'launchAtLogin') next.launchAtLogin = o.value === true;
      if (o.key === 'keepRunning') next.keepRunning = o.value !== false;
      return { status: st(), settings: next };
    },
    onState: (cb: (payload: unknown) => void) => {
      onState = cb;
    },
  };

  const context = {
    window: { ether: api },
    document,
    navigator: { clipboard: { writeText: async (text: string) => void clipboard.push(text) } },
    setTimeout: () => 0,
    console,
  };
  vm.runInNewContext(rendererSrc, context, { filename: 'renderer.js' });

  return {
    el: (id) => {
      const e = els.get(id);
      assert.ok(e, `#${id} was never rendered`);
      return e;
    },
    push: (status, labels, settings) => {
      assert.ok(onState, 'the renderer never subscribed with onState');
      // The main process pushes the whole payload when anything changes: `status`,
      // the label set, and what the two switches are set to. The channel never
      // carries a bare status, and no language field.
      if (labels) lastLabels = labels;
      if (settings) lastSettings = settings;
      onState?.({ status, labels: lastLabels, settings: lastSettings });
    },
    settle: async () => {
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
    calls,
    lastSetting,
    release: () => release(),
    clipboard,
    root: documentElement,
    requested,
    htmlIds,
  };
}

const labels = uiLabels();
const word = (labels: UiLabels, key: string): string =>
  (labels as unknown as Record<string, string>)[key];

// ── the one action ──────────────────────────────────────────────────────────

test('the one button starts the link, then stops it', async () => {
  const h = harness();
  await h.settle();
  h.push(st(), labels); // the labels the main process sends with its first status

  const button = h.el('main-button');
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, labels.start);

  button.click();
  assert.equal(h.calls.start, 1);
  h.release();
  await h.settle();
  assert.equal(h.el('state-word').textContent, labels.on);
  assert.equal(button.textContent, labels.stop);

  button.click();
  assert.equal(h.calls.stop, 1);
  h.release();
  await h.settle();
  assert.equal(h.el('state-word').textContent, labels.off);
  assert.equal(button.textContent, labels.start);
});

test('a second click while the main process is working is ignored', async () => {
  const h = harness();
  await h.settle();
  const button = h.el('main-button');
  button.click();
  button.click();
  assert.equal(h.calls.start, 1, 'a second start would open a second tunnel');
  h.release();
  await h.settle();
});

test('the button is unavailable while work is in flight and while the app is starting', async () => {
  const h = harness();
  await h.settle();
  const button = h.el('main-button');
  button.click(); // in flight, not yet answered
  assert.equal(button.disabled, true);
  h.release();
  await h.settle();
  assert.equal(button.disabled, false);

  h.push(st({ state: 'checking' }), labels);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, labels.working);
});

test('a verb that fails puts the reason in the sentence the user reads', async () => {
  const h = harness({ startFails: true });
  await h.settle();
  h.el('main-button').click();
  h.release();
  await h.settle();
  assert.equal(h.el('status-line').textContent, 'adb is not installed');
  assert.equal(h.el('status-line').className, 'status bad');
});

// ── the first frame ─────────────────────────────────────────────────────────

test('the first frame is drawn, not left blank, and it says the app is working', () => {
  const h = harness();
  const button = h.el('main-button');
  assert.equal(button.disabled, true);
  assert.equal(button.writes > 0, true);
  assert.notEqual(h.el('state-word').textContent, '');
  assert.equal(h.el('state-chip').className, 'chip');
});

test('a first read that rejects leaves the drawn frame, never a silent blank', async () => {
  const h = harness({ stateFails: true });
  await h.settle();
  assert.equal(h.el('state-chip').className, 'chip');
  assert.notEqual(h.el('state-word').textContent, '');
  assert.equal(h.el('main-button').disabled, true);
});

test('the page is English and its figures are grouped the en-US way', async () => {
  const h = harness();
  await h.settle();
  h.push(st({ stats: { datagrams: 123456 } }));
  // `index.html` declares `lang="en"` and the renderer never rewrites it: no field
  // of the payload can change the language of a program that has only one.
  assert.equal(h.root.lang, 'en');
  assert.equal(h.el('stat-datagrams').textContent, (123456).toLocaleString('en-US'));
  assert.match(h.el('stat-datagrams').textContent, /123,456/, 'thousands grouped the en-US way');
});

// ── the chip: one word, one tone ────────────────────────────────────────────

test('the chip says the state in one word and one tone', async () => {
  const h = harness();
  await h.settle();
  const cases: Array<[Push, string, string]> = [
    [st({ state: 'checking' }), labels.working, 'chip'],
    [st({ state: 'starting' }), labels.working, 'chip'],
    [st({ state: 'up' }), labels.on, 'chip ok'],
    [st({ state: 'degraded' }), labels.on, 'chip warn'],
    [st({ state: 'error' }), labels.needsAttention, 'chip bad'],
    [st({ state: 'idle' }), labels.off, 'chip'],
  ];
  for (const [status, word, className] of cases) {
    h.push(status, labels);
    assert.equal(h.el('state-word').textContent, word, `word for ${String(status.state)}`);
    assert.equal(h.el('state-chip').className, className, `tone for ${String(status.state)}`);
  }
});

test('a push that repeats the same state does not write the live region again', async () => {
  const h = harness();
  await h.settle();
  h.push(st({ state: 'up' }), labels);
  const word = h.el('state-word');
  const line = h.el('status-line');
  assert.equal(word.textContent, labels.on);
  const wordWrites = word.writes;
  const lineWrites = line.writes;

  h.push(st({ state: 'up' }), labels);
  h.push(st({ state: 'up' }), labels);
  assert.equal(word.writes, wordWrites, 'a live region handed the same word re-announces it');
  assert.equal(line.writes, lineWrites);
});

test('the ready sentence is not printed: the button and the chip already said it', async () => {
  const h = harness();
  await h.settle();
  h.push(st({ state: 'up', messageKey: 'ready', message: t('ready') }), labels);
  assert.equal(h.el('status-line').textContent, '');

  h.push(st({ state: 'idle', messageKey: 'noDevice', message: t('noDevice') }), labels);
  assert.equal(h.el('status-line').textContent, t('noDevice'));
});

// ── the contextual remedies ─────────────────────────────────────────────────

test('noPermissions draws the commands to paste, and nothing else does', async () => {
  const h = harness();
  await h.settle();
  const hint = 'SUBSYSTEM=="usb", ATTR{idVendor}=="18d1", MODE="0666"';
  h.push(st({ state: 'error', messageKey: 'noPermissions', message: t('noPermissions'), hint }), labels);
  assert.equal(h.el('udev').hidden, false);
  assert.equal(h.el('udev-cmd').textContent, hint);
  assert.equal(h.el('copy-udev-label').textContent, labels.copyCommand);

  h.push(st({ state: 'error', messageKey: 'noDevice', message: t('noDevice') }), labels);
  assert.equal(h.el('udev').hidden, true);
  h.push(st({ state: 'error', messageKey: 'noPermissions', message: t('noPermissions') }), labels);
  assert.equal(h.el('udev').hidden, true, 'the sentence without its command is not a fix');
});

test('restarting adb is offered only where it is the fix, and it asks the main process', async () => {
  const h = harness();
  await h.settle();
  assert.equal(h.el('restart-adb').hidden, true);

  h.push(st({ state: 'error', messageKey: 'adbConflict', message: t('adbConflict') }), labels);
  assert.equal(h.el('restart-adb').hidden, false);
  assert.equal(h.el('restart-adb-label').textContent, labels.restartAdb);
  h.el('restart-adb').click();
  await h.settle();
  assert.equal(h.calls.restartAdb, 1);

  h.push(st({ state: 'error', messageKey: 'noDevice', message: t('noDevice') }), labels);
  assert.equal(h.el('restart-adb').hidden, true);
});

// ── the path ────────────────────────────────────────────────────────────────

test('each leg lights from what was observed, and the rule lights with the leg it leaves', async () => {
  const h = harness();
  await h.settle();
  const legOn = (name: string) => h.el(`leg-${name}`).classList.contains('on');

  // The cable alone: the device answers, nothing is tunnelled yet.
  h.push(st({ device: { serial: 'ABC', state: 'device' } }), labels);
  assert.deepEqual([legOn('usb'), legOn('tcp'), legOn('udp')], [true, false, false]);
  assert.equal(h.el('link-usb').classList.contains('on'), false);
  assert.equal(h.el('leg-udp-state').textContent, labels.legDown);

  // The link is up: the tcp reverse exists and the udp round trip was verified.
  const tunnelled = { device: { serial: 'ABC', state: 'device' }, tcpMap: [[47984, 38090]], udpMap: [[47999, 38091]] };
  h.push(st({ ...tunnelled, state: 'up' }), labels);
  assert.deepEqual([legOn('usb'), legOn('tcp'), legOn('udp')], [true, true, true]);
  assert.equal(h.el('link-usb').classList.contains('on'), true);
  assert.equal(h.el('link-tcp').classList.contains('on'), true);
  assert.equal(h.el('leg-udp-state').textContent, labels.legUp);

  // Up with a failed check is exactly the state in which udp is not carrying: the
  // drawing shows *where* the path stops, which one word about the link cannot.
  h.push(st({ ...tunnelled, state: 'degraded' }), labels);
  assert.deepEqual([legOn('usb'), legOn('tcp'), legOn('udp')], [true, true, false]);
  assert.equal(h.el('link-tcp').classList.contains('on'), false);
  assert.equal(h.el('leg-udp-state').textContent, labels.legDown);
});

// ── the round trip, and the counters ────────────────────────────────────────

test('the round trip is a figure of its own, drawn only while there is a link', async () => {
  const h = harness();
  await h.settle();
  h.push(st({ state: 'idle', mbps: 119.4 }), labels);
  assert.equal(h.el('rtt').hidden, true);
  assert.equal(h.el('rtt').textContent, '');

  h.push(st({ state: 'up', mbps: 119.4 }), labels);
  assert.equal(h.el('rtt').hidden, false);
  assert.equal(h.el('rtt').textContent, `${labels.rtt} 119 Mbps`);
});

test('measuring writes the figure, and the action needs a link to exist', async () => {
  const h = harness();
  await h.settle();
  h.push(st({ state: 'idle' }), labels);
  assert.equal(h.el('measure').disabled, true);

  h.push(st({ state: 'up' }), labels);
  assert.equal(h.el('measure').disabled, false);
  h.el('measure').click();
  await h.settle();
  assert.equal(h.calls.measure, 1);
  assert.equal(h.el('rtt').textContent, `${labels.rtt} 103 Mbps`);

  // The figure belongs to the link it was measured on: stopping clears it.
  h.el('main-button').click();
  h.release();
  await h.settle();
  assert.equal(h.el('rtt').hidden, true);
});

test('the four counters share one row, and only Dropped turns bad', async () => {
  const h = harness();
  await h.settle();
  h.push(st({ stats: { datagrams: 1234, bytes: 5678, dropped: 0, peers: 2 } }), labels);
  assert.equal(h.el('stat-datagrams').textContent, (1234).toLocaleString('zh-CN'));
  assert.equal(h.el('stat-bytes').textContent, (5678).toLocaleString('zh-CN'));
  assert.equal(h.el('stat-peers').textContent, '2');
  assert.equal(h.el('stat-datagrams-k').textContent, labels.datagrams);
  assert.deepEqual(
    ['stat-datagrams-box', 'stat-bytes-box', 'stat-dropped-box', 'stat-peers-box'].map((id) =>
      h.el(id).classList.contains('bad'),
    ),
    [false, false, false, false],
  );

  h.push(st({ stats: { datagrams: 1234, bytes: 5678, dropped: 3, peers: 2 } }), labels);
  assert.equal(h.el('stat-dropped-box').classList.contains('bad'), true);
  assert.equal(h.el('stat-datagrams-box').classList.contains('bad'), false);
});

// ── ports and log ───────────────────────────────────────────────────────────

test('the port map folds the channel names in, and still lists what nothing tunnels', async () => {
  const h = harness();
  await h.settle();
  h.push(
    st({
      channels: ['47984 HTTPS', '48010 Control', '47999 Audio'],
      tcpMap: [[47984, 38090]],
      udpMap: [[47999, 38091]],
    }),
    labels,
  );
  const lines = h.el('ports').textContent.split('\n');
  assert.equal(lines[0], 'tcp  47984 HTTPS  ->  adb reverse tcp:38090');
  assert.equal(lines[1], 'udp  47999 Audio  ->  adb reverse tcp:38091  ->  host');
  assert.deepEqual(lines.slice(2), ['---', '48010 Control']);
  assert.equal(h.el('ports-none').textContent, '');
});

test('a well with nothing to draw says why in the app\u2019s own words', async () => {
  const h = harness();
  await h.settle();
  h.push(st({ messageKey: 'noDevice', message: t('noDevice') }), labels);
  assert.equal(h.el('ports').textContent, '');
  assert.equal(h.el('ports-none').textContent, t('noDevice'));
});

test('the log follows its newest line only while the reader is already there', async () => {
  const h = harness();
  await h.settle();
  const logs = h.el('logs');
  logs.scrollHeight = 100;
  logs.clientHeight = 50;
  logs.scrollTop = 50; // at the newest line

  h.push(st({ logs: ['one', 'two'] }), labels);
  assert.equal(logs.textContent, 'one\ntwo');
  assert.equal(logs.scrollTop, 100, 'a reader at the end is kept at the end');

  logs.scrollTop = 0; // reading further up
  h.push(st({ logs: ['one', 'two', 'three'] }), labels);
  assert.equal(logs.textContent, 'one\ntwo\nthree');
  assert.equal(logs.scrollTop, 0, 'a push must not drag the reader back down');
});

test('the log keeps the newest 200 lines, and a repeat is not rewritten', async () => {
  const h = harness();
  await h.settle();
  const lines = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`);
  h.push(st({ logs: lines }), labels);
  const drawn = h.el('logs').textContent.split('\n');
  assert.equal(drawn.length, 200);
  assert.equal(drawn[0], 'line 51');

  const writes = h.el('logs').writes;
  h.push(st({ logs: lines }), labels);
  assert.equal(h.el('logs').writes, writes, 'a rewrite would drop the reader\u2019s selection');
});

// ── copying ─────────────────────────────────────────────────────────────────

test('each copy control copies exactly the block it stands on', async () => {
  const h = harness();
  await h.settle();
  const hint = 'sudo tee /etc/udev/rules.d/51-ether.rules';
  h.push(
    st({
      state: 'error',
      messageKey: 'noPermissions',
      message: t('noPermissions'),
      hint,
      channels: ['47984 HTTPS'],
      tcpMap: [[47984, 38090]],
      logs: ['first line', 'second line'],
    }),
    labels,
  );

  h.el('copy').click();
  h.el('copy-ports').click();
  h.el('copy-udev').click();
  await h.settle();
  assert.deepEqual(h.clipboard, ['first line\nsecond line', h.el('ports').textContent, hint]);
});

test('a copy is answered on screen and on the other channel, and twice is twice', async () => {
  const h = harness();
  await h.settle();
  h.push(st({ state: 'error', messageKey: 'noPermissions', message: t('noPermissions'), hint: 'rule' }), labels);

  h.el('copy-udev').click();
  await h.settle();
  assert.equal(h.el('copy-udev').classList.contains('copied'), true, 'the tick is the answer');
  assert.equal(h.el('copy-udev-label').textContent, labels.copied);
  assert.equal(h.el('copy-live').textContent, labels.copied);

  const writes = h.el('copy-live').writes;
  h.el('copy-udev').click();
  await h.settle();
  assert.equal(h.el('copy-live').textContent, labels.copied);
  assert.equal(h.el('copy-live').writes > writes, true, 'the second receipt must be a change again');
});

// ── what the rows are allowed to say ────────────────────────────────────────

test('the device row is one line, and its whole value travels as the tooltip', async () => {
  const h = harness();
  await h.settle();
  h.push(st({ device: { serial: 'A'.repeat(64), model: 'Pixel 8', state: 'device' } }), labels);
  const row = h.el('v-device');
  assert.equal(row.textContent, `Pixel 8 (${'A'.repeat(64)}) · ${labels.usbConnected}`);
  assert.equal(row.title, row.textContent);

  h.push(st(), labels);
  assert.equal(h.el('v-device').textContent, labels.notConnected);
  assert.equal(h.el('v-device').title, labels.notConnected);
});

test('the service on this PC is reported from the probe, never from a device that is silent', async () => {
  const h = harness();
  await h.settle();
  h.push(st({ sunshine: 'up', ports: { base: 47989 } }), labels);
  assert.equal(h.el('v-pc').textContent, `${labels.serviceRunning} 47989`);

  // The device is missing, and that says nothing about this PC's service: it is running.
  h.push(st({ sunshine: 'up', ports: { base: 47989 } }), labels);
  assert.equal(h.el('v-pc').textContent, `${labels.serviceRunning} 47989`);

  h.push(st({ sunshine: 'down' }), labels);
  assert.equal(h.el('v-pc').textContent, labels.serviceMissing);
  h.push(st({ sunshine: 'unknown' }), labels);
  assert.equal(h.el('v-pc').textContent, labels.unknown);
});

test('Related software is the one block that names another program, and only from observation', async () => {
  const h = harness();
  await h.settle();
  const device = { serial: 'ABC', state: 'device' };

  h.push(
    st({
      device,
      sunshine: 'up',
      ports: { base: 47989 },
      adb: { path: '/usr/bin/adb', version: '1.0.41', conflict: false },
    }),
    labels,
  );
  assert.equal(h.el('v-client').textContent, `${labels.clientName} · ${labels.installed}`);
  assert.equal(h.el('v-host').textContent, `${labels.hostName} · ${labels.listening} 47989`);
  assert.equal(h.el('v-adb').textContent, '/usr/bin/adb · 1.0.41');

  h.push(st({ device, messageKey: 'noMoonlight', message: t('noMoonlight'), sunshine: 'up' }), labels);
  assert.equal(h.el('v-client').textContent, `${labels.clientName} · ${labels.notInstalled}`);

  h.push(st({ messageKey: 'noDevice', message: t('noDevice'), adb: { path: 'adb', version: '1', conflict: true } }), labels);
  // No device is no evidence about the client, and a probe that did not answer is not
  // the same sentence as "not there".
  assert.equal(h.el('v-client').textContent, `${labels.clientName} · ${labels.unknown}`);
  assert.equal(h.el('v-host').textContent, `${labels.hostName} · ${labels.unknown}`);
  assert.match(h.el('v-adb').textContent, /\[conflict\]$/);
});

// ── the three switches ──────────────────────────────────────────────────────

test('the startup switches draw the state the OS reports, and send every change back', async () => {
  const h = harness();
  await h.settle();
  h.push(st(), labels, { autoConnect: true, launchAtLogin: false, keepRunning: true, error: false });

  assert.equal(h.el('h-startup').textContent, labels.startup);
  assert.equal(h.el('set-at-login-label').textContent, labels.launchAtLogin);
  assert.equal(h.el('set-auto-connect-label').textContent, labels.autoConnect);
  assert.equal(h.el('set-keep-running-label').textContent, labels.keepRunning);
  // Three switches, two different kinds of truth: one is the OS's own login item, the
  // other two are lines we write ourselves. The payload says which is which.
  assert.equal(h.el('set-auto-connect').checked, true);
  assert.equal(h.el('set-at-login').checked, false);
  assert.equal(h.el('set-keep-running').checked, true);
  assert.equal(h.el('startup-note').hidden, true);

  h.el('set-at-login').check(true);
  await h.settle();
  assert.equal(h.calls.setSetting, 1);
  assert.deepEqual(h.lastSetting, { key: 'launchAtLogin', value: true });
  // The answer is the whole payload, so the switch is drawn from what the main process
  // reports and never from what the click asked for.
  assert.equal(h.el('set-at-login').checked, true);

  h.el('set-auto-connect').check(false);
  await h.settle();
  assert.equal(h.calls.setSetting, 2);
  assert.deepEqual(h.lastSetting, { key: 'autoConnect', value: false });
  assert.equal(h.el('set-auto-connect').checked, false);

  // The third one is what a close *means*: the window is the front door, not the app.
  h.el('set-keep-running').check(false);
  await h.settle();
  assert.equal(h.calls.setSetting, 3);
  assert.deepEqual(h.lastSetting, { key: 'keepRunning', value: false });
  assert.equal(h.el('set-keep-running').checked, false);
});

test('a setting the OS will not take is one line where it was asked for', async () => {
  const h = harness();
  await h.settle();
  h.push(st(), labels, { autoConnect: false, launchAtLogin: false, keepRunning: true, error: true });
  assert.equal(h.el('startup-note').hidden, false);
  assert.equal(h.el('startup-note').textContent, labels.startupError);
  // Not the sentence under the link: the link is fine, the switch is what failed.
  assert.equal(h.el('status-line').textContent, '');

  h.push(st(), labels, { autoConnect: false, launchAtLogin: false, keepRunning: true, error: false });
  assert.equal(h.el('startup-note').hidden, true);
  assert.equal(h.el('startup-note').textContent, '');
});

test('a setting change that cannot even be sent is the line under the switches', async () => {
  const h = harness({ setSettingFails: true });
  await h.settle();
  h.el('set-auto-connect').check(true);
  await h.settle();
  assert.equal(h.calls.setSetting, 1);
  assert.equal(h.el('startup-note').hidden, false);
  assert.equal(h.el('startup-note').textContent, 'the settings file is read-only');
  assert.equal(h.el('status-line').textContent, '');
});

test('a payload with no settings draws the switches off rather than failing', async () => {
  const h = harness();
  await h.settle();
  h.push(st(), labels); // an older payload: no `settings` field at all
  assert.equal(h.el('set-at-login').checked, false);
  assert.equal(h.el('set-auto-connect').checked, false);
  // Keeping the link up is the one whose default is on: an unreadable settings file must
  // not silently turn a running link into something a closed window drops.
  assert.equal(h.el('set-keep-running').checked, true);
  assert.equal(h.el('startup-note').hidden, true);
});

// ── the remedy the app carries out itself ───────────────────────────────────

test('the remedy button is drawn only when the main process offers one, and it is the one offered', async () => {
  const h = harness();
  await h.settle();
  assert.equal(h.el('fix').hidden, true, 'a plain status has nothing to install');
  assert.equal(h.el('fix-button').hidden, true);

  // One well, three remedies: the button says what this press will actually do, and the
  // window never picks the remedy itself.
  for (const [kind, name] of [
    ['grantDeviceAccess', 'fixGrantAccess'],
    ['installTraySupport', 'fixInstallTray'],
    ['installUsbDriver', 'fixInstallDriver'],
  ] as const) {
    h.push(st({ state: 'error', messageKey: 'noPermissions', message: t('noPermissions'), fix: kind }), labels);
    assert.equal(h.el('fix').hidden, false, kind);
    assert.equal(h.el('fix-button').hidden, false, kind);
    assert.equal(h.el('fix-label').textContent, word(labels, name), kind);
    assert.equal(h.el('fix-note').hidden, true, 'nothing has happened yet');
  }

  // Anything the window does not know is not a button: a payload from a newer main
  // process must not turn into a press that does the wrong thing.
  h.push(st({ fix: 'installSomethingElse' }), labels);
  assert.equal(h.el('fix').hidden, true);
  assert.equal(h.el('fix-button').hidden, true);
});

test('the press asks the main process, and the receipt is what the press ended in', async () => {
  const h = harness({ fixKind: 'installTraySupport', fixReason: 'done' });
  await h.settle();
  h.push(st({ fix: 'installTraySupport' }), labels);
  assert.equal(h.el('fix-label').textContent, labels.fixInstallTray);

  h.el('fix-button').click();
  assert.equal(h.calls.fix, 1);
  h.release();
  await h.settle();
  assert.equal(h.el('fix-note').textContent, labels.fixDone);
  assert.equal(h.el('fix-note').hidden, false);
});

test('a dismissal is an answer, not a failure to report', async () => {
  for (const [reason, name] of [
    ['done', 'fixDone'],
    ['refused', 'fixRefused'],
    ['failed', 'fixFailed'],
    ['noBroker', 'fixNoBroker'],
  ] as const) {
    const h = harness({ fixKind: 'grantDeviceAccess', fixReason: reason });
    await h.settle();
    h.push(st({ fix: 'grantDeviceAccess' }), labels);
    h.el('fix-button').click();
    h.release();
    await h.settle();
    assert.equal(h.el('fix-note').textContent, word(labels, name), reason);
    // The sentence under the link is the link's own; the remedy has its own line.
    assert.equal(h.el('status-line').textContent, '');
  }
});

test('the receipt outlives the remedy, and a desktop with no tray says why closing the window is safe', async () => {
  const h = harness();
  await h.settle();
  // A receipt with no remedy left: the install worked, so there is nothing to offer —
  // and the user still gets to read what the press did.
  h.push(st({ state: 'up', fixResult: { ok: true, reason: 'done' } }), labels);
  assert.equal(h.el('fix').hidden, false);
  assert.equal(h.el('fix-button').hidden, true);
  assert.equal(h.el('fix-note').textContent, labels.fixDone);

  // Nothing to install and no tray: the well stands for the one line that explains the
  // fallback, because "closing this minimises it" is the answer to a question the user
  // is about to ask.
  h.push(st({ state: 'up', tray: { ok: false, fixable: false } }), labels);
  assert.equal(h.el('fix').hidden, false);
  assert.equal(h.el('fix-button').hidden, true);
  assert.equal(h.el('fix-note').textContent, labels.trayMissing);

  // A tray that works, nothing to install, no receipt: the well is gone entirely.
  h.push(st({ state: 'up', tray: { ok: true, fixable: false } }), labels);
  assert.equal(h.el('fix').hidden, true);
  assert.equal(h.el('fix-note').textContent, '');
});

// ── the files themselves ────────────────────────────────────────────────────

test('every word on screen comes from messages.ts, never from the markup', () => {
  assert.doesNotMatch(rendererCode, CJK, 'renderer.js carries a user-facing string');
  assert.doesNotMatch(htmlCode, CJK, 'index.html carries a user-facing string');

  const keys = [...rendererCode.matchAll(/labels\.([A-Za-z]+)/g)].map((m) => m[1] as string);
  assert.ok(keys.length > 10);
  for (const key of keys) {
    assert.ok(key in labels, `labels.${key} is not a UiLabels key`);
  }
  // The one place a program may be named is Related software; every other word is
  // the app's own.
  for (const key of keys.filter((k) => k !== 'clientName' && k !== 'hostName')) {
    assert.doesNotMatch(word(labels, key), PEER, `labels.${key} names a program`);
  }
});

test('every id the renderer draws into exists in the markup, and every one it needs is drawn', async () => {
  const h = harness();
  await h.settle();
  h.push(
    st({
      state: 'up',
      device: { serial: 'ABC', state: 'device' },
      hint: 'rule',
      messageKey: 'noPermissions',
      stats: { datagrams: 1 },
      channels: ['47984 HTTPS'],
    }),
    labels,
  );

  const ids = new Set([...rendererCode.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1] as string));
  assert.ok(ids.size > 20);
  for (const id of ids) assert.ok(h.htmlIds.has(id), `#${id} is not in index.html`);
  // Every box the renderer resolves was handed out by the fake document, and the ones
  // the markup draws as empty text are filled from the labels.
  for (const id of h.requested) assert.equal(h.el(id).id, id);
  for (const id of ['state-word', 'more-label', 'h-path', 'h-ports', 'stat-dropped-k', 'copy-label']) {
    assert.ok(h.htmlIds.has(id), `#${id} is missing from index.html`);
    assert.notEqual(h.el(id).textContent, '', `#${id} was never filled in`);
  }
});

test('the markup is a skeleton: one live region for the link, one for the receipt', () => {
  const live = [...htmlSrc.matchAll(/aria-live="([^"]+)"/g)];
  assert.equal(live.length, 2);
  assert.match(htmlSrc, /id="state-chip"[^>]*role="status" aria-live="polite"/);
  assert.match(htmlSrc, /id="copy-live"[^>]*role="status"/);
  assert.doesNotMatch(htmlSrc, /id="status-line"[^>]*(role|aria-live)/);
  assert.doesNotMatch(htmlSrc, /id="rtt"[^>]*(role|aria-live)/);
  // The details are the platform's own disclosure: no custom disclosure script.
  assert.match(htmlSrc, /<details id="more"/);
  assert.match(htmlSrc, /<summary/);
  assert.doesNotMatch(rendererCode, /open\s*=\s*true|setAttribute\('hidden'/);
});

test('the window is one fixed size, and the renderer never touches it', () => {
  assert.match(indexSrc, /const WIN_W = 560/);
  assert.match(indexSrc, /const WIN_H = 320/);
  assert.match(indexSrc, /useContentSize: true/);
  assert.match(indexSrc, /resizable: false/);
  assert.match(indexSrc, /backgroundColor: '#131313'/);
  assert.equal(ruleIn(cssSrc, ':root').includes('--bg: oklch(0.185 0 0)'), true, 'the first frame flashes');
  assert.doesNotMatch(rendererCode, /resizeTo|setSize|setBounds|innerWidth|outerWidth/);
});

test('every channel the preload exposes is one the main process answers', () => {
  const exposed = [...preloadSrc.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1] as string);
  assert.deepEqual(exposed, ['state', 'start', 'stop', 'restart-adb', 'measure', 'set-setting', 'fix']);

  const used = [...new Set([...rendererCode.matchAll(/api\.([A-Za-z]+)\(/g)].map((m) => m[1] as string))].sort();
  // `api.fix` is the whole remedy path: one verb, because the main process is the one
  // that knows which remedy applies.
  assert.deepEqual(used, ['fix', 'measure', 'onState', 'restartAdb', 'setSetting', 'start', 'state', 'stop']);
  // `onState` is the push subscription; the rest are the invoke channels above.
  const camel = (verb: string) => verb.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
  for (const verb of used.filter((v) => v !== 'onState')) {
    assert.ok(exposed.map(camel).includes(verb), `api.${verb} is not an exposed channel`);
  }
});

test('the layout is the three bands: two sticky rails and one scroller', () => {
  assert.match(ruleIn(cssSrc, '#app'), /overflow-y: auto/);
  assert.match(ruleIn(cssSrc, '.appbar'), /position: sticky/);
  assert.match(ruleIn(cssSrc, '.actionbar'), /position: sticky/);
  assert.match(ruleIn(cssSrc, '.actionbar'), /bottom: 0/);
  for (const selector of ['.chip.ok', '.chip.warn', '.chip.bad', '.status.bad', '.leg.on .dot', '.stat.bad', '.copy.copied', '.remedy']) {
    assert.ok(ruleIn(cssSrc, selector).length > 0);
  }
  // The remedy well stacks its button and its one line, and `hidden` collapses the gap
  // between them: `<p>` and `<button>` are `display:flex` children otherwise.
  assert.match(ruleIn(cssSrc, '.remedy'), /flex-direction: column/);
  assert.match(cssSrc, /\[hidden\]\s*\{\s*display: none/);
});
