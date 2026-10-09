// index.ts — the Electron shell: one window, one button, no surprises.
//
// Everything that touches the tablet lives in Controller; this file only owns
// the window, the IPC surface, the single-instance lock and the promise that
// closing the app leaves the network exactly as it was found (§5.5).

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import { Controller, type Status } from './controller.js';
import { uiLabels } from './messages.js';
import { currentPlat, userDataDir } from './platform.js';
import {
  installStartup,
  readSettings,
  removeStartup,
  shouldAutoConnect,
  startupDir,
  startupEntry,
  startupInstalled,
  writeSettings,
  type Settings,
} from './startup.js';

let win: BrowserWindow | undefined;
let controller: Controller | undefined;
let controllerReady: Promise<Controller> | undefined;
let quitting = false;
let lastStatus: Status | undefined;

/** The controller's data dir, so the settings sit next to the state.json it writes. */
const DATA_DIR = userDataDir();
const PLAT = currentPlat();

/** The settings we own. Read on the way up, written when a switch in the window moves. */
let settings: Settings = { autoConnect: false };
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
  autoConnectStep(s);
}

function payload(s: Status) {
  return {
    status: s,
    labels: uiLabels(),
    // What the two switches in Details → Startup draw.  `launchAtLogin` is the OS's
    // own answer (re-read at startup and after every write), never a copy we keep,
    // and `error` is set while the last change could not be made.
    settings: { autoConnect: settings.autoConnect, launchAtLogin: loginItemOn, error: settingsError },
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
    const c = await requireController();
    return payload(await c.up());
  });

  ipcMain.handle('stop', async () => {
    autoConnectPending = false;
    const c = await requireController();
    return payload(await c.down());
  });

  ipcMain.handle('restart-adb', async () => {
    autoConnectPending = false;
    const c = await requireController();
    return payload(await c.restartAdb());
  });

  ipcMain.handle('measure', async (_e, o: { seconds?: number; window?: number } = {}) => {
    const c = await requireController();
    return c.measure({ seconds: o.seconds ?? 5, window: o.window ?? 1024 });
  });

  /**
   * One switch in Details → Startup.  A change that cannot be made is not an
   * exception thrown at the window: the payload comes back with `error` set and the
   * window says so where the switch is — the state it draws is then the state the OS
   * actually reports, i.e. the switch shows what happened, not what was asked for.
   */
  ipcMain.handle('set-setting', async (_e, o: { key?: string; value?: unknown } = {}) => {
    settingsError = false;
    try {
      if (o.key === 'autoConnect') {
        settings = { ...settings, autoConnect: o.value === true };
        await writeSettings(DATA_DIR, settings);
        // Turning it off also cancels an attempt that has not happened yet.  Turning it
        // on does not dial now: the switch is about the *next* launch.
        if (!settings.autoConnect) autoConnectPending = false;
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
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady().then(async () => {
    registerIpc();

    // Before a payload can be built: `payload()` draws both of these.
    settings = await readSettings(DATA_DIR);
    refreshLoginItem();

    win = createWindow();

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

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) win = createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // Even on macOS: this app has exactly one window, and a hidden app that holds
    // `adb reverse` mappings is exactly the surprise §5 is written to avoid.
    app.quit();
  });

  app.on('before-quit', (e) => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    void teardown().finally(() => app.exit(0));
  });

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      void teardown().finally(() => app.exit(0));
    });
  }
}

export { lastStatus };
