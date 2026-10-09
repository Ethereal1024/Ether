// index.ts — the Electron shell: one window, one button, no surprises.
//
// Everything that touches the tablet lives in Controller; this file owns the window,
// the IPC surface, the tray icon, the single-instance lock, and the two promises a
// window-shaped app usually breaks:
//
//   * closing the window does not drop the wired link.  It goes behind the tray icon,
//     or — on a desktop with no tray — it is minimised to the taskbar, so it keeps the
//     link up *and* stays reachable (`windowCloseAction`); a real quit still leaves the
//     machine exactly as it was found (§5.5);
//   * the app never makes the user open a terminal.  The one privileged thing it needs
//     (a udev rule, a missing tray package, a Windows USB driver) is installed through
//     the desktop's own consent prompt by `elevate.ts`; the paste-able commands survive
//     only as the fallback for a machine that cannot raise that prompt.

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import { Controller, type Status } from './controller.js';
import {
  driverMissingFromCsv,
  findInfInList,
  pnpQueryArgv,
  USB_DRIVER_INF,
  USB_DRIVER_URL,
  USB_DRIVER_ZIP,
} from './driver.js';
import { downloadToFile } from './download.js';
import {
  brokerCandidates,
  privSteps,
  RULE_PATH,
  runPrivOp,
  stepText,
  udevRuleLine,
  type FixKind,
  type FixReason,
  type FixResult,
  type PrivOp,
} from './elevate.js';
import { uiLabels } from './messages.js';
import { currentPlat, udevVendorId, userDataDir } from './platform.js';
import { createTray, type TrayHandle } from './tray.js';
import type { TrayAction } from './traymenu.js';
import { traySupport, type TrayFix } from './traysupport.js';
import {
  installStartup,
  readSettings,
  removeStartup,
  shouldAutoConnect,
  startupDir,
  startupEntry,
  startupInstalled,
  windowCloseAction,
  writeSettings,
  DEFAULT_SETTINGS,
  type CloseAction,
  type Settings,
} from './startup.js';
import { extractZip } from './zip.js';

let win: BrowserWindow | undefined;
let controller: Controller | undefined;
let controllerReady: Promise<Controller> | undefined;
let quitting = false;
let lastStatus: Status | undefined;

/** The controller's data dir, so the settings sit next to the state.json it writes. */
const DATA_DIR = userDataDir();
const PLAT = currentPlat();

/** The settings we own. Read on the way up, written when a switch in the window moves. */
let settings: Settings = { ...DEFAULT_SETTINGS };
/** True while the last write of a setting failed — the window then says so, once. */
let settingsError = false;
/** Whether the OS currently has us in the session's own login items. */
let loginItemOn = false;
/**
 * The auto-connect attempt: at most one per launch.  Armed when the controller is
 * ready and given up for good as soon as the user presses a button themselves or the
 * link moves past idle — never re-armed while the app is open, so the switch means
 * "when you open Ether", not "whenever a cable appears".
 */
let autoConnectPending = false;

// ── the tray, and the remedies the window can offer ─────────────────────────

/** The icon, once the app is ready. `undefined` before that, and a no-op handle when
 * this desktop cannot draw one. */
let tray: TrayHandle | undefined;
/** Whether this desktop has somewhere to *put* an icon, and whether the app can install
 * that somewhere. Probed once on the way up and again after a successful install. */
let traySupportInfo: { ok: boolean; fixable: boolean } = { ok: true, fixable: false };
/** The elevated install that would give this session a tray, when there is one. */
let trayFix: TrayFix | undefined;
/** Whether a Windows device on the bus has no working USB driver (probed, never guessed). */
let driverMissing = false;
/** What the last press of the remedy button ended in, until the next verb clears it.  A
 * status push must not clear it: the link keeps pushing every two seconds, and a receipt
 * that survives less than that is not a receipt. */
let lastFix: { kind: FixKind; result: FixResult } | undefined;

/** The menu words the tray borrows from the window's own catalogue (traymenu.ts). */
function trayLabels() {
  const l = uiLabels();
  return {
    on: l.on,
    off: l.off,
    working: l.working,
    needsAttention: l.needsAttention,
    show: l.showWindow,
    start: l.start,
    stop: l.stop,
    quit: l.quit,
  };
}

/** Run one unprivileged program and give back its exit code and its output.  Never
 * throws: a program that is not there is `127`, which is an answer the caller can use. */
function run(file: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 15_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const raw = (err as (NodeJS.ErrnoException & { code?: number | string }) | null)?.code;
      const code = raw === undefined ? 0 : typeof raw === 'number' ? raw : 127;
      resolve({ code, out: `${stdout ?? ''}${stderr ?? ''}` });
    });
  });
}

/** The same, for the two probes whose answers are read synchronously at startup. */
function runSync(file: string, args: string[]): string {
  try {
    return execFileSync(file, args, { encoding: 'utf8', timeout: 8000 });
  } catch {
    return '';
  }
}

/**
 * Does this desktop have a tray?  `traysupport.ts` decides; this only feeds it the
 * evidence — the shell's own extension list, the linker's own cache, and the distro's
 * own name for itself.  Every one of those commands needs no rights, which is the point:
 * asking the question must not be the thing that raises a prompt.
 */
function probeTraySupport(): void {
  const support = traySupport({
    plat: PLAT,
    env: process.env,
    libs: () => runSync('ldconfig', ['-p']),
    extensions: () => runSync('gnome-extensions', ['list', '--enabled']),
    osRelease: () => {
      try {
        return readFileSync('/etc/os-release', 'utf8');
      } catch {
        return '';
      }
    },
  });
  traySupportInfo = { ok: support.ok, fixable: Boolean(support.fix) };
  trayFix = support.fix;
  if (!support.ok) process.stdout.write(`[tray] ${support.detail ?? 'no tray host'}\n`);
}

/**
 * Is an Android device on the bus without a working driver?  Windows only, and the
 * query itself is unprivileged (`Get-PnpDevice` never needs rights); the *install* is
 * the elevated half, in `elevate.ts`.
 */
async function probeUsbDriver(): Promise<void> {
  if (PLAT !== 'win32') {
    driverMissing = false;
    return;
  }
  const argv = pnpQueryArgv();
  const { out } = await run(argv[0]!, argv.slice(1));
  const missing = driverMissingFromCsv(out);
  if (missing !== driverMissing) process.stdout.write(`[driver] android device without a driver: ${missing}\n`);
  driverMissing = missing;
}

/** Would the desktop's own consent broker be there?  A path question, never a spawn: an
 * existence check cannot raise a prompt, which is what makes it safe to ask up front. */
function haveBroker(): boolean {
  return brokerCandidates(PLAT, process.env).some((p) => existsSync(p));
}

/**
 * The remedy the payload offers, in one priority order: the device the OS is denying,
 * then the missing USB driver (nothing works at all without it), then the tray.  The
 * kind is what the window names; the op that implements it is built only when the button
 * is actually pressed.
 */
function offeredFix(s: Status | undefined): FixKind | undefined {
  // The controller's own answer: a device the OS denies, and no rule for it yet.
  if (s?.fix === 'grantDeviceAccess') return 'grantDeviceAccess';
  if (driverMissing) return 'installUsbDriver';
  if (!traySupportInfo.ok && traySupportInfo.fixable) return 'installTraySupport';
  return undefined;
}

/**
 * Build the privileged op for one remedy, out of what the app has just probed.  The
 * `grantDeviceAccess` half stages the rule text in the app's *own* data dir, so the op
 * itself is `install(1)` copying a file — no shell redirection, and so no shell.  The
 * driver half fetches Google's own published package because the driver is not something
 * this app ships.
 *
 * `undefined` means "this remedy cannot be built after all": a fact that changed
 * between the probe and the press, never a button that pretends.
 */
async function buildFixOp(kind: FixKind): Promise<PrivOp | undefined> {
  if (kind === 'grantDeviceAccess') {
    const serial = lastStatus?.device?.serial ?? '';
    const vid = udevVendorId({ serial, env: process.env });
    if (!vid) return undefined;
    const staged = path.join(DATA_DIR, `51-android-${vid}.rules`);
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(staged, `${udevRuleLine(vid)}\n`);
    } catch (e) {
      process.stdout.write(`[fix] could not stage the rule: ${(e as Error).message}\n`);
      return undefined;
    }
    return { kind, vendorId: vid, rulePath: RULE_PATH, stagedFile: staged };
  }

  if (kind === 'installTraySupport') {
    if (!trayFix) return undefined;
    return { kind: 'installPackages', manager: trayFix.manager, packages: trayFix.packages };
  }

  // Windows: fetch the package, unpack it where we may write, and hand the `.inf` in it
  // to pnputil through the broker.
  const zipPath = path.join(DATA_DIR, USB_DRIVER_ZIP);
  const destDir = path.join(DATA_DIR, 'usb-driver');
  try {
    await downloadToFile(USB_DRIVER_URL, zipPath, (l) => process.stdout.write(`[driver] ${l}\n`), 'usb driver');
    const written = await extractZip(readFileSync(zipPath), destDir, (l) => process.stdout.write(`[driver] ${l}\n`));
    const inf = findInfInList(written);
    if (!inf) {
      process.stdout.write(`[driver] no ${USB_DRIVER_INF} in the package\n`);
      return undefined;
    }
    return { kind, inf };
  } catch (e) {
    process.stdout.write(`[fix] driver package failed: ${(e as Error).message}\n`);
    return undefined;
  }
}

/**
 * The whole of the remedy button: pick the remedy, build it, run it through the desktop's
 * own consent prompt, and re-probe whatever the answer changed.  A refusal is an answer —
 * the caller then shows the fallback text instead of insisting.
 */
async function runFix(): Promise<{ kind: FixKind; result: FixResult } | undefined> {
  const kind = offeredFix(lastStatus);
  if (!kind) return undefined;
  const op = await buildFixOp(kind);
  if (!op) return { kind, result: { ok: false, reason: 'failed' } };

  if (!haveBroker()) {
    process.stdout.write(`[fix] no consent broker on this desktop; run: ${opStepsText(op)}\n`);
    return { kind, result: { ok: false, reason: 'noBroker' } };
  }

  process.stdout.write(`[fix] ${kind}: ${opStepsText(op)}\n`);
  const res = await runPrivOp(op, { plat: PLAT, run: (f, a) => run(f, a) });
  const reason: FixReason = res.ok ? 'done' : (res.reason ?? 'failed');
  if (!res.ok && res.out) process.stdout.write(`[fix] ${res.out.trim()}\n`);

  if (res.ok) {
    // Re-probe what the change was about, so the window draws the new truth rather than
    // the one that was true a second ago.
    if (kind === 'grantDeviceAccess') await controller?.refresh();
    if (kind === 'installTraySupport') {
      probeTraySupport();
      ensureTray();
    }
    if (kind === 'installUsbDriver') await probeUsbDriver();
  }
  return { kind, result: { ok: res.ok, reason } };
}

/** The steps of an op, spelled the way a user would type them: the fallback text. */
function opStepsText(op: PrivOp): string {
  // One line per step, joined: what the window would print if it had to.
  return privSteps(op).map(stepText).join(' && ');
}

// ── the second door: what a close means, and how the window comes back ──────

/** Is there a real icon to hide into?  Both halves have to be true: Electron made an
 * icon, *and* the desktop has somewhere to put it.  A tray that is created and never
 * shows is exactly the case the fallback exists for. */
function trayOn(): boolean {
  return Boolean(tray?.ok && traySupportInfo.ok);
}

/**
 * Make the icon, when this desktop can host one and we do not already have one.  Called
 * on the way up, and again once the tray support has been installed: a desktop that had
 * nowhere to put an icon a moment ago has one now, and an install the user just answered
 * a consent prompt for must not need a restart to be visible.  Never throws — a desktop
 * that cannot draw the icon leaves the window its own door (minimise) instead.
 */
function ensureTray(): void {
  if (tray?.ok || !traySupportInfo.ok) return;
  tray = createTray({
    plat: PLAT,
    resourcesDir: resourcesDir(),
    labels: trayLabels(),
    onAction: onTrayAction,
    log: (l) => process.stdout.write(`${l}\n`),
  });
}

/** What the close button means right now.  The decision itself lives in startup.ts, so
 * the switch, the tray and the OS's own quit are one question with one answer. */
function closeAction(): CloseAction {
  return windowCloseAction({ keepRunning: settings.keepRunning, quitting, tray: trayOn() });
}

/** The other door to the same window: restore, show, focus.  A hidden window that cannot
 * be brought back is a running app nobody can reach. */
function showWindow(): void {
  if (!win || win.isDestroyed()) {
    win = createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** The three tray verbs.  `toggle` runs the same code as the main button rather than a
 * second implementation of it, so the icon cannot start a link the window would not. */
function onTrayAction(a: TrayAction): void {
  if (a === 'show') return showWindow();
  if (a === 'quit') return app.quit();
  autoConnectPending = false;
  lastFix = undefined;
  const c = controller;
  if (!c) return;
  const up = lastStatus?.state === 'up' || lastStatus?.state === 'degraded';
  void (up ? c.down() : c.up()).catch((e) => process.stdout.write(`[tray] ${a} failed: ${(e as Error).message}\n`));
}

/** Which device the driver probe was last answered for, so a new cable is a new
 * question and the same cable is not a probe every two seconds. */
let lastSerial = '';

/**
 * Ask the PnP bus again, and re-push the payload if the answer moved: the remedy button
 * appears and disappears with the driver, and the window is only ever told the truth
 * that was probed, never a state remembered from a launch ago.
 */
async function refreshDriverFix(): Promise<void> {
  const before = driverMissing;
  await probeUsbDriver();
  if (driverMissing !== before && lastStatus && win && !win.isDestroyed()) {
    win.webContents.send('status', payload(lastStatus));
  }
}

function noteSerial(s: Status): void {
  const serial = s.device?.serial ?? '';
  if (serial === lastSerial) return;
  lastSerial = serial;
  if (PLAT === 'win32') void refreshDriverFix();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The window is one fixed size (§4.1 rule 4) — 560 logical px wide, and tall
 * enough for the main view plus a little air, so clicking Details changes what is on
 * screen without the window itself moving.
 *
 * It used to be measured and animated to the height of its contents.  That
 * bought an exactly-fitting window and paid for it twice: the resize reflowed the
 * text on every frame of the animation, so the whole window appeared to twitch,
 * and the tallest state still overflowed the work area and grew a scrollbar —
 * i.e. the animation bought nothing.  A constant height cannot twitch, cannot
 * overflow differently between states, and leaves one scrollbar instead of two.
 *
 * 320 is measured, not taste (`app/_measure.sh`, a real window at scale 2, after
 * Details moved to a second level so nothing is written under the button):
 *   * 218 px — level 1 with nothing to say: two rows and the button;
 *   * 302 px — level 1's worst case: a status sentence that wraps to two lines
 *     plus the one next-step hint;
 *   * 252 px — Details opening on Status, the shortest of the four panels;
 *   * 375 px — the Linux udev block (two commands to paste + its retry button)
 *     inside Status, which scrolls by design at any height below it, 400 included.
 * So 320 shows every level-1 state without a scrollbar and leaves 18 px over the
 * worst one, while the 102 px of background under the button in idle is the same
 * order as the 95 px §4.1 accepted before — 360 would leave 141 px of blank now
 * that the copy under the button is gone, which is the very complaint that fixed
 * the size in the first place.
 */
const WIN_W = 560;
const WIN_H = 320;

/**
 * Chromium's page zoom, in levels (one level ≈ 1.2×): ±0.5 per press, i.e. 0.69×
 * to 1.73×.  Below `ZOOM_MIN` the log's 12px data face stops reading as a column of
 * digits, and above `ZOOM_MAX` a 560px card is a two-word line; the zoom is clamped
 * rather than refused, because a chord that silently does nothing reads as a broken
 * key.  It multiplies the page, not the window: §4.1 rule 1 is a promise about the
 * window's *size*, and a zoomed window is the same layout, larger.
 */
const ZOOM_STEP = 0.5;
const ZOOM_MIN = -2;
const ZOOM_MAX = 3;

/**
 * Which zoom a chord asks for: `+`/`=` in, `-`/`_` out, `0` back to 100%.  Both
 * spellings of each are listed because they are one physical key at two shifts —
 * on most layouts `+` *is* shift+`=` — and the user who reaches for the louder
 * looking one means the same thing.  `undefined` means "not a zoom chord".
 */
function zoomChord(key: string): number | 'reset' | undefined {
  if (key === '=' || key === '+') return ZOOM_STEP;
  if (key === '-' || key === '_') return -ZOOM_STEP;
  if (key === '0') return 'reset';
  return undefined;
}

/** In dev the ELF sits next to the sources; in a package electron-builder copied it. */
function resourcesDir(): string {
  const override = process.env.ETHER_RESOURCES;
  if (override) return override;
  return app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources');
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    // Fixed, in content pixels, and nobody may drag it: a window whose size is a
    // constant cannot reflow its contents, and "drag the corner" on a one-button
    // app could only ever produce a clipped button or a slab of background.
    useContentSize: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Ether',
    // Must equal `--bg` in style.css: the first frame is painted before the page
    // is, and a mismatch would show as a flash of the wrong colour.  This is the
    // 8-bit form of `oklch(0.185 0 0)`, and a test (renderer.test.ts) converts the
    // token and fails if the two ever drift apart again.
    backgroundColor: '#131313',
    // Shown once the page has something to draw, never at a placeholder size:
    // there is no second size any more.
    show: false,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'src', 'main', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  w.removeMenu();

  // Font size (P0-6): `removeMenu()` above is the reason this exists.  Every other app in
  // the dock gets "make the text bigger" from its menu bar's zoom roles, and taking
  // the menu away to keep a strip of furniture off a one-button window took that with
  // it — so the users who most need a larger font were the ones who had no way to ask
  // for one, in a window that cannot be resized either.
  //
  // So the three standard chords are handled here instead: Ctrl/Cmd `+`, `-` and `0`,
  // on this window's own webContents — no global shortcut (nothing is taken from any
  // other app) and no menu (nothing appears).  `preventDefault()` when it is ours, so
  // Chromium never acts on the same chord a second time.
  //
  // It cannot contradict §4.1 rule 1: `setZoomLevel` scales the page, never the
  // window, so the window stays 560×320 content px and no measurement anywhere
  // changes.  That is also why this is the *right* answer to "the text is too small"
  // here — the alternative, resizing the window, is the one thing this design
  // forbids.
  w.webContents.on('before-input-event', (event, input) => {
    // Cmd on macOS, Ctrl everywhere else — the same split the OS itself makes.
    const mod = process.platform === 'darwin' ? input.meta : input.control;
    if (!mod || input.alt) return;
    const chord = zoomChord(input.key);
    if (chord === undefined) return;
    const level =
      chord === 'reset'
        ? 0
        : Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, w.webContents.getZoomLevel() + chord));
    event.preventDefault();
    w.webContents.setZoomLevel(level);
  });

  // The page is a local file loaded asynchronously: whichever of these two lands
  // first is the one that shows the window.  No timer, because with a fixed size
  // there is nothing to wait for — and `ready-to-show` alone would leave an
  // invisible app if the load ever failed after the first paint.
  const show = () => {
    if (!w.isDestroyed() && !w.isVisible()) w.show();
  };
  w.once('ready-to-show', show);
  w.webContents.once('did-finish-load', show);

  // A link in the log panel must never navigate the app window.
  w.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // The renderer ships as source (`electron-builder.yml` copies `src/renderer/**`),
  // so it is resolved from the app root — the compiled main code under `dist/` has
  // no `renderer/` sibling at all.  Resolving it next to `dist/src/main` made the
  // window load fail, and the window then never showed at all.
  void w.loadFile(path.join(app.getAppPath(), 'src', 'renderer', 'index.html'));
  return w;
}

function push(s: Status): void {
  lastStatus = s;
  // Same shape as the invoke handlers below: the renderer applies one payload
  // type from both channels, so a status change and its labels never diverge.
  if (win && !win.isDestroyed()) win.webContents.send('status', payload(s));
  // The icon is the window's second door, and the tooltip's one word is read from the
  // same status the card draws.
  tray?.update(s.state);
  autoConnectStep(s);
  noteSerial(s);
}

/**
 * The remedy the payload offers, as data: which elevated action the state has (if any),
 * the outcome of the last press, and whether this desktop has a tray at all.  Electron-only
 * — `bin/cli.mjs` prints a frozen key set without any of it.
 */
function remedyFields(s: Status): { fix?: FixKind; fixResult?: FixResult; tray: { ok: boolean; fixable: boolean } } {
  const kind = offeredFix(s);
  const out: { fix?: FixKind; fixResult?: FixResult; tray: { ok: boolean; fixable: boolean } } = { tray: traySupportInfo };
  if (kind) out.fix = kind;
  // A receipt outlives the state it was about — a tray install *removes* the reason the
  // button was there — but a receipt about a different remedy would be a lie, so it is
  // only carried while it is still the one on offer (or while nothing is).
  if (lastFix && (kind === undefined || lastFix.kind === kind)) out.fixResult = lastFix.result;
  return out;
}

function payload(s: Status) {
  return {
    status: { ...s, ...remedyFields(s) },
    labels: uiLabels(),
    // What the switches in Details → Startup draw.  `launchAtLogin` is the OS's own
    // answer (re-read at startup and after every write), never a copy we keep, and
    // `error` is set while the last change could not be made.
    settings: {
      autoConnect: settings.autoConnect,
      keepRunning: settings.keepRunning,
      launchAtLogin: loginItemOn,
      error: settingsError,
    },
  };
}

/**
 * "Open Ether when you sign in", per platform.  On Linux it is the user's own startup
 * entry (startup.ts writes it); on macOS and Windows the same fact lives in the OS and
 * Electron is the only thing that can read or write it.  Either way the state is asked
 * for, never remembered across launches.
 */
function refreshLoginItem(): void {
  try {
    loginItemOn =
      PLAT === 'linux'
        ? startupInstalled(startupDir(process.env))
        : app.getLoginItemSettings().openAtLogin === true;
  } catch {
    loginItemOn = false; // an OS that will not answer has not enabled anything
  }
}

async function setLoginItem(on: boolean): Promise<void> {
  if (PLAT === 'linux') {
    // `$APPIMAGE` when there is one: inside the mounted image `process.execPath` is a
    // temporary path that is gone after a reboot, so an entry pointing at it would do
    // nothing at the next login.
    const exec = process.env.APPIMAGE ?? process.execPath;
    const args = process.defaultApp ? [app.getAppPath()] : [];
    if (on) await installStartup(startupDir(process.env), startupEntry({ exec, args, comment: uiLabels().loginItemComment }));
    else await removeStartup(startupDir(process.env));
    return;
  }
  // Windows: an unpackaged run *is* `electron`, so the app path has to travel with it;
  // a packaged app is its own entry point.  macOS takes the flag alone.
  app.setLoginItemSettings(
    PLAT === 'win32'
      ? { openAtLogin: on, path: process.execPath, args: process.defaultApp ? [app.getAppPath()] : [] }
      : { openAtLogin: on },
  );
}

/**
 * The one auto-connect attempt: made when the app already knows there is a usable
 * device, and dropped as soon as the status says anything else.  A launch with no cable
 * therefore stays *armed* — plugging the device in is the thing the switch was for —
 * while a link that came up, or a state that needs the user, ends the attempt.
 */
function autoConnectStep(s: Status): void {
  if (!autoConnectPending) return;
  if (shouldAutoConnect(settings, s)) {
    autoConnectPending = false;
    process.stdout.write('[app] auto-connect: the device is ready, starting the wired link\n');
    void controller?.up().catch((e) => process.stdout.write(`[app] auto-connect failed: ${(e as Error).message}\n`));
    return;
  }
  if (s.state !== 'idle') autoConnectPending = false;
}

/**
 * The status of an app that has not finished starting: the state machine's
 * `checking` (tunnel.ts), with nothing measured yet.  Same shape as every other
 * status, so the renderer applies it through the one path it has.
 */
function startingStatus(): Status {
  return {
    state: 'checking',
    message: '',
    // The service has not been looked for yet: "unknown" is the one honest answer,
    // and the row says that rather than accusing a service that is probably running.
    sunshine: 'unknown',
    logs: [],
    tcpMap: [],
    udpMap: [],
    stats: { datagrams: 0, bytes: 0, dropped: 0, peers: 0 },
  };
}

/**
 * Publish it while `Controller.create()` is still running — which on a fresh Linux
 * box can be a platform-tools download away (§3.2).  The renderer draws the same
 * `checking` state by itself before this lands; what the push adds is the words,
 * so the first frame is not a wordless button.
 *
 * Guarded exactly like the status push that follows it: the page is a local file
 * loaded asynchronously, so it may already have finished loading.
 */
function pushStarting(): void {
  const w = win;
  if (!w) return;
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', () => push(startingStatus()));
  else push(startingStatus());
}

function registerIpc(): void {
  ipcMain.handle('state', async () => {
    const c = await requireController();
    const s = await c.refresh();
    return payload(s);
  });

  ipcMain.handle('start', async () => {
    autoConnectPending = false; // the user took over: no attempt of ours may follow it
    lastFix = undefined;
    const c = await requireController();
    return payload(await c.up());
  });

  ipcMain.handle('stop', async () => {
    autoConnectPending = false;
    lastFix = undefined;
    const c = await requireController();
    return payload(await c.down());
  });

  ipcMain.handle('restart-adb', async () => {
    autoConnectPending = false;
    lastFix = undefined;
    const c = await requireController();
    return payload(await c.restartAdb());
  });

  ipcMain.handle('measure', async (_e, o: { seconds?: number; window?: number } = {}) => {
    const c = await requireController();
    return c.measure({ seconds: o.seconds ?? 5, window: o.window ?? 1024 });
  });

  /**
   * The remedy button.  It takes no argument on purpose: the main process is the one
   * that knows which of the three remedies the state has and how to build it, so the
   * window cannot ask for one that does not apply.  The answer is the whole payload,
   * with the outcome in `fixResult` — a refusal is drawn as a sentence, not thrown.
   */
  ipcMain.handle('fix', async () => {
    autoConnectPending = false;
    const pressed = await runFix();
    if (pressed) lastFix = pressed;
    return payload(lastStatus ?? controller?.status() ?? startingStatus());
  });

  /**
   * One switch in Details → Startup.  A change that cannot be made is not an
   * exception thrown at the window: the payload comes back with `error` set and the
   * window says so where the switch is — the state it draws is then the state the OS
   * actually reports, i.e. the switch shows what happened, not what was asked for.
   */
  ipcMain.handle('set-setting', async (_e, o: { key?: string; value?: unknown } = {}) => {
    settingsError = false;
    lastFix = undefined;
    try {
      if (o.key === 'autoConnect') {
        settings = { ...settings, autoConnect: o.value === true };
        await writeSettings(DATA_DIR, settings);
        // Turning it off also cancels an attempt that has not happened yet.  Turning it
        // on does not dial now: the switch is about the *next* launch.
        if (!settings.autoConnect) autoConnectPending = false;
      } else if (o.key === 'keepRunning') {
        // Turning it off is a promise about what the *next* close does; the window that
        // is open right now stays open, because nothing was closed to ask for it.
        settings = { ...settings, keepRunning: o.value !== false };
        await writeSettings(DATA_DIR, settings);
      } else if (o.key === 'launchAtLogin') {
        await setLoginItem(o.value === true);
        refreshLoginItem();
      } else {
        throw new Error(`unknown setting '${String(o.key)}'`);
      }
    } catch (e) {
      settingsError = true;
      process.stdout.write(`[app] setting ${String(o.key)} failed: ${(e as Error).message}\n`);
    }
    return payload(lastStatus ?? controller?.status() ?? startingStatus());
  });
}

function requireController(): Promise<Controller> {
  // The window is created before the controller has finished probing adb, so the
  // renderer's very first `state()` invoke can land while `controller` is still
  // undefined.  Throwing there rejected that invoke and left the window with no
  // status at all; hand out the creation promise instead.
  if (controller) return Promise.resolve(controller);
  if (controllerReady) return controllerReady;
  return Promise.reject(new Error('controller is not ready yet'));
}

/** Closing the window must not leave a relay, a reverse or a tablet process behind. */
async function teardown(): Promise<void> {
  if (!controller) return;
  try {
    await Promise.race([controller.down(), sleep(5000)]);
  } catch {
    /* the reap on next start is the backstop */
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow();
  });

  void app.whenReady().then(async () => {
    registerIpc();

    // Before a payload can be built: `payload()` draws both of these.
    settings = await readSettings(DATA_DIR);
    refreshLoginItem();

    // The tray is asked for before the window exists, because the close handler reads
    // its answer and the payload carries it.  A desktop with no tray must not be a
    // fatal error: the window simply keeps its own door open (minimise) instead.
    probeTraySupport();
    ensureTray();

    win = createWindow();

    // Closing the window is not quitting while the switch is on.  Which of the two
    // "keep it alive" answers applies — the tray icon, or the taskbar — is asked of the
    // desktop, never assumed: hiding a window on a desktop with no tray would leave a
    // running app with no door at all, which is worse than the link dropping.
    win.on('close', (e) => {
      const action = closeAction();
      if (action === 'close') return;
      e.preventDefault();
      if (action === 'hide') win?.hide();
      else win?.minimize();
      process.stdout.write(`[app] window ${action === 'hide' ? 'hidden in the tray' : 'minimised'}: the link stays up\n`);
    });

    // The window is up before the controller is, so say what the app is actually
    // doing (checking adb) instead of leaving the page to wait for the first probe.
    pushStarting();

    // Published before it is awaited: IPC handlers created a moment ago may already
    // be answering a `state()` invoke from a renderer that loaded faster than adb.
    controllerReady = Controller.create({
      resourcesDir: resourcesDir(),
      log: (l) => process.stdout.write(`${l}\n`),
      onStatus: (s) => push(s),
    });
    controller = await controllerReady;

    // Armed only now: the statuses pushed while the controller was being built say
    // "checking", and acting on one of those would disarm the attempt before it could
    // be made.  The push at the end of this block is what makes the attempt.
    autoConnectPending = settings.autoConnect;

    // The page is a local file loaded asynchronously, so it may already have
    // finished by the time adb answered: the push is what draws the first status,
    // and `did-finish-load` alone would silently never fire.
    const w = win;
    if (!w) return;
    if (w.webContents.isLoading()) w.webContents.once('did-finish-load', () => push(controller!.status()));
    else push(controller.status());

    // One driver question at startup (Windows), and one every time the cable changes
    // device: nothing is remembered between launches.
    void refreshDriverFix();

    app.on('activate', () => {
      showWindow();
    });
  });

  app.on('window-all-closed', () => {
    // With "keep the link running" on, a closed window is exactly that: a closed window.
    // The app, its relay and its table of port forwards stay up, reachable from the tray
    // icon.  Turning the switch off (or quitting from the icon) is what ends the process.
    if (settings.keepRunning) return;
    app.quit();
  });

  app.on('before-quit', (e) => {
    if (quitting) return;
    quitting = true;
    // The icon goes first: it is a control for an app that is on its way out, and a
    // menu left behind on a dead process is a ghost on the user's taskbar.
    tray?.destroy();
    tray = undefined;
    e.preventDefault();
    void teardown().finally(() => app.exit(0));
  });

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      tray?.destroy();
      tray = undefined;
      void teardown().finally(() => app.exit(0));
    });
  }
}

export { lastStatus };
