// startup.ts — the two things this app is allowed to do before the user asks: nothing
// at all, unless they said so.  It owns
//
//   * the settings we persist (`settings.json`, next to state.json in the data dir) —
//     connect on launch, and whether closing the window keeps the link up;
//   * the desktop's own way of opening an app with the session (a per-user startup
//     entry on Linux; macOS and Windows hand that to Electron, which is why the
//     platform split lives in the shell);
//   * the one decision the shell makes when the close button is pressed (below).
//
// Electron-free on purpose, like controller.ts: the decisions below are testable
// headlessly.  The Linux half is a plain file in the user's own config directory — no
// admin, no /etc, no registry, no PATH edit.  `test/escalation.test.ts` fails the build
// if that stops being true, and it is the reason this is the only file that may name
// that directory at all.
//
// The launch-at-login switch is deliberately *not* stored here.  Its truth is the OS
// (`app.getLoginItemSettings()`, or the entry file itself): the moment the user
// deletes the entry by hand, a remembered copy would be a checkbox that lies.  Only
// `autoConnect` and `keepRunning` are settings we own.

import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

// ── the settings we own ─────────────────────────────────────────────────────

export interface Settings {
  /** Dial the wired link as soon as the app is up, when a usable device is there. */
  autoConnect: boolean;
  /** Keep the wired link up when the window is closed: the app stays alive, behind its
   * tray icon (or minimised to the taskbar where the desktop has no tray).  On by
   * default, because a link the user started is not something closing a window should
   * silently drop. */
  keepRunning: boolean;
}

export const SETTINGS_NAME = 'settings.json';
export const DEFAULT_SETTINGS: Settings = { autoConnect: false, keepRunning: true };

export function settingsPath(dataDir: string): string {
  return path.join(dataDir, SETTINGS_NAME);
}

/**
 * A settings file is a hint about what *we* wrote, so it is re-validated rather than
 * trusted (the same rule state.json follows): a truncated or hand-edited file falls
 * back to the defaults, never to a crash.  `autoConnect` is the one setting whose wrong
 * default would *do* something (dial a link nobody asked for), so only the boolean is a
 * yes there; `keepRunning` defaults to on, so only an explicit `false` turns it off.
 */
export function normalizeSettings(v: unknown): Settings {
  const o = (v ?? {}) as Partial<Settings>;
  return { autoConnect: o.autoConnect === true, keepRunning: o.keepRunning !== false };
}

export async function readSettings(dataDir: string): Promise<Settings> {
  try {
    return normalizeSettings(JSON.parse(await readFile(settingsPath(dataDir), 'utf8')));
  } catch {
    return { ...DEFAULT_SETTINGS }; // no file, unreadable, or not JSON
  }
}

/**
 * Written through a temporary name and renamed into place: the file is read while the
 * app starts, and a half-written one would be indistinguishable from "the user turned
 * it off".
 */
export async function writeSettings(dataDir: string, s: Settings): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const tmp = `${settingsPath(dataDir)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(normalizeSettings(s), null, 2)}\n`);
  await rename(tmp, settingsPath(dataDir));
}

// ── the desktop's startup entry (Linux) ─────────────────────────────────────

/** The entry's file name, and the variable that pins the directory for a test run. */
export const STARTUP_ENTRY_NAME = 'ether.desktop';
const STARTUP_DIR_ENV = 'ETHER_AUTOSTART_DIR';

/**
 * The per-user directory a freedesktop desktop reads startup entries from.  Never a
 * system-wide one: this is the user's own session, so the entry needs no admin and
 * touches no other account.
 */
export function startupDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[STARTUP_DIR_ENV];
  if (override) return override;
  const config = env.XDG_CONFIG_HOME;
  if (config) return path.join(config, 'autostart');
  return path.join(env.HOME || homedir(), '.config', 'autostart');
}

export function startupEntryPath(dir: string): string {
  return path.join(dir, STARTUP_ENTRY_NAME);
}

/**
 * One argument of an entry's `Exec` line, quoted the way the desktop-entry spec says:
 * an argument with a space (a binary under `/home/me/My Apps`, an AppImage in a
 * downloads folder) is wrapped in double quotes, and inside quotes the four characters
 * the spec reserves are backslash-escaped.  Getting this wrong does not fail loudly —
 * the desktop either drops the entry or opens the wrong thing.
 */
const RESERVED = /[\s"'\\><~|&;$*?#()`]/;

export function quoteExecArg(arg: string): string {
  if (arg === '') return '""';
  if (!RESERVED.test(arg)) return arg;
  return `"${arg.replace(/(["\\`$])/g, '\\$1')}"`;
}

export interface StartupEntryOpts {
  /** The program to run: `process.execPath`, or `$APPIMAGE` when there is one. */
  exec: string;
  /** Arguments after it (in development: the path of the app to open). */
  args?: string[];
  /** The one line a desktop's own "startup applications" list shows. */
  comment: string;
}

/**
 * The contents of the entry.  `X-GNOME-Autostart-enabled=true` is what GNOME reads;
 * the other desktops ignore a key they do not know instead of each needing their own
 * file, so one entry serves them all.  `Terminal=false` matters: a desktop that opened
 * a terminal window at every login would look like a bug, and would be one.
 */
export function startupEntry(o: StartupEntryOpts): string {
  const exec = [o.exec, ...(o.args ?? [])].map(quoteExecArg).join(' ');
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Ether',
    `Comment=${o.comment}`,
    `Exec=${exec}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

export async function installStartup(dir: string, entry: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(startupEntryPath(dir), entry);
}

/** Idempotent: turning the switch off twice is not an error. */
export async function removeStartup(dir: string): Promise<void> {
  await rm(startupEntryPath(dir), { force: true });
}

/**
 * Is the entry there *and* enabled?  A desktop's own settings panel disables an entry
 * by flipping a key in it rather than deleting the file — so a switch that read only
 * "the file exists" would claim the app opens at login while the session quietly
 * ignores it.
 */
export function startupInstalled(dir: string): boolean {
  let text: string;
  try {
    text = readFileSync(startupEntryPath(dir), 'utf8');
  } catch {
    return false;
  }
  if (/^\s*Hidden\s*=\s*true\s*$/im.test(text)) return false;
  return !/^\s*X-GNOME-Autostart-enabled\s*=\s*false\s*$/im.test(text);
}

// ── the one decision the shell asks for ─────────────────────────────────────

/** Only the fields the decision reads, so the controller's Status fits unchanged. */
export interface AutoConnectStatus {
  state?: string;
  device?: { state?: string };
}

/**
 * The auto-connect precondition, in one place: the user asked for it, nothing is
 * running yet, and the device behind the cable is usable.  Everything else — no cable,
 * an unauthorized device, no streaming service on this PC (the controller reports that
 * as `error`) — is a state where starting would either fail or surprise, so the app
 * stays quiet and leaves the button to the user.
 */
export function shouldAutoConnect(settings: Settings, status: AutoConnectStatus): boolean {
  return settings.autoConnect === true && status.state === 'idle' && status.device?.state === 'device';
}

/**
 * What an *armed* attempt does with a status that did not dial.
 *
 * `wait` is the one that matters, and it is the fix for the launch this switch is
 * actually about.  At login the app is usually the first thing up: the cable is still
 * in the drawer, the tablet is still booting, or the device has been seen but not
 * authorized yet.  None of those is an answer — they are the reasons the switch exists —
 * so the attempt stays armed and keeps asking the bus (see `AutoConnectAttempt`).
 *
 * Only a link that is already running, or on its way up, ends it: that link *is* the
 * answer, and a second dial could not be what the user meant.  An `error` status does not
 * end it either: the errors this app reports are about the same boot order (no streaming
 * service yet, a device not allowed yet), and every one of them can turn into a usable
 * device while the app is sitting there.
 */
export type AutoConnectDecision = 'dial' | 'wait' | 'give-up';

/** The three states in which the link is someone's already (tunnel.ts's TunnelState). */
const LINK_STATES = new Set(['starting', 'up', 'degraded']);

export function autoConnectDecision(settings: Settings, status: AutoConnectStatus): AutoConnectDecision {
  if (shouldAutoConnect(settings, status)) return 'dial';
  if (settings.autoConnect !== true) return 'give-up';
  return LINK_STATES.has(status.state ?? '') ? 'give-up' : 'wait';
}

/** Everything the attempt needs from the shell that owns it. */
export interface AutoConnectDeps {
  /** The switches *now*: the user can turn the attempt off while it waits. */
  settings: () => Settings;
  /** Ask the machine again.  The shell maps this to `controller.refresh()`; the status
   * push that ends it is what runs the one decision in `step()`. */
  refresh: () => Promise<void>;
  /** Raise the link.  Called at most once per launch. */
  dial: () => Promise<void>;
  /** Make sure adb itself is there, called again while waiting when the first look
   * found none (a first run that raced the network, a machine where adb was never
   * installed).  Optional, and expected to be free when adb is already found. */
  provision?: () => Promise<void>;
  /**
   * The bus as an event source, when this machine has one (`devwatch.ts`: the adb server
   * pushes its device list over `host:track-devices`).  Called with `true` whenever that
   * list changes — which is the one fact this attempt is waiting for — and with `false`
   * when the stream is gone, so the tick below can go back to being a real poll.
   *
   * Optional on purpose: a watch is an optimisation, and a failed one must leave the
   * behaviour of a machine without it exactly as it was.  Returns the way to detach.
   */
  watch?: (cb: (live: boolean) => void) => () => void;
  log: (l: string) => void;
  /** How often the bus is asked again while waiting and nothing is pushing. */
  intervalMs?: number;
  /** How often it is asked while the event source *is* live.  Rare on purpose: the stream
   *  covers the device list, and a device list is what this attempt waits on.  What is left
   *  for this tick is the handful of things no device list can report — Sunshine's port
   *  appearing, an adb server that moved to another socket, a watch that died without
   *  saying so. */
  safetyMs?: number;
  /** How often a missing adb may be looked for again, so a failed download is not
   * retried every tick. */
  provisionEveryMs?: number;
}

/**
 * One launch's auto-connect attempt, from arming to the dial.
 *
 * It exists because "connect on launch" is not a decision about one status, it is a
 * small state machine that has to survive the launch order: armed when the switches have
 * been read, alive while the answer is "not yet", and over the moment it dialled, found a
 * link already running, or the user took over.  The three earlier bugs all lived in that
 * shape — an attempt that its own `checking` push disarmed, an attempt that no later
 * status ever woke (nothing polls the bus when the app is idle), and an attempt that gave
 * up on the first refusal from a device that was merely still booting.
 *
 * Waiting is where it is worth being careful about the price.  A tick that forks an adb
 * client every two seconds is cheap in absolute terms and still wrong: it wakes the adb
 * server for a USB scan nobody asked for, on a machine that is usually idle, for hours.  So
 * the wait has two speeds — the event source (`deps.watch`) when this machine has one, and
 * a tick that stays honest about being a fallback: fast while nothing is pushing, a rare
 * safety net while the adb server is pushing device changes at us.
 *
 * It is Electron-free on purpose: the timer, the watch, the retry and the decision are all
 * testable without a window, and the shell is left with the two calls only it can make.
 */
export class AutoConnectAttempt {
  private armed = false;
  private timer?: NodeJS.Timeout;
  /** The interval the current timer was built with, so a retune is a no-op when it would
   *  not change the answer. */
  private timerEvery?: number;
  private started = false;
  private watchLive = false;
  private unwatch?: () => void;
  private busy = false;
  private lastProvision = 0;
  private readonly interval: number;
  private readonly safety: number;
  private readonly provisionEvery: number;

  constructor(private readonly deps: AutoConnectDeps) {
    this.interval = deps.intervalMs ?? 2000;
    this.safety = deps.safetyMs ?? 30_000;
    this.provisionEvery = deps.provisionEveryMs ?? 30_000;
  }

  /** The switch was on when this launch read it. */
  arm(): void {
    this.armed = this.deps.settings().autoConnect === true;
    // The first look at the bus was the controller's own `refresh()`; a retry of a
    // *missing* adb is what this stamp spaces out.
    this.lastProvision = Date.now();
  }

  /** Over: it dialled, the link was already there, or the user took over (the button,
   * the switch, the tray, a quit). */
  disarm(): void {
    this.armed = false;
    this.stop();
  }

  /** Whether an attempt is still waiting — what the tests assert on. */
  get pending(): boolean {
    return this.armed;
  }

  /** One status: dial, keep waiting, or end the attempt. */
  step(s: AutoConnectStatus): void {
    if (!this.armed) return;
    const decision = autoConnectDecision(this.deps.settings(), s);
    if (decision === 'wait') {
      this.start();
      return;
    }
    this.disarm();
    if (decision === 'give-up') return;
    this.deps.log('[app] auto-connect: the device is ready, starting the wired link');
    void this.deps.dial().catch((e) => this.deps.log(`[app] auto-connect failed: ${(e as Error).message}`));
  }

  /**
   * Begin waiting: attach to the bus if this machine has an event source, and start the
   * tick that stands behind it.  Idempotent, because `step()` calls it on every status
   * that says "not yet".
   */
  private start(): void {
    if (this.started) return;
    this.started = true;
    this.unwatch = this.deps.watch?.((live) => this.onWatch(live));
    this.retune();
  }

  /**
   * The bus spoke: the device list changed, or the stream that was carrying it went away.
   * Either way, ask the machine once — and let the tick's speed follow what is pushing.
   */
  private onWatch(live: boolean): void {
    if (!this.armed) return;
    const changed = live !== this.watchLive;
    this.watchLive = live;
    if (changed) this.retune();
    // `changed || live`: a plain event is a reason to look, and the *first* `false` (no
    // stream on this machine at all) is not — the poll is about to run anyway.
    if (changed || live) void this.poll();
  }

  /**
   * Build the tick at the speed the current situation deserves: the fast interval while
   * nothing is pushing, the safety net's while the adb server is.  A timer that is already
   * right is left alone, so a busy bus cannot keep resetting the safety net.
   */
  private retune(): void {
    const want = this.watchLive ? this.safety : this.interval;
    if (this.timerEvery === want) return;
    this.stopTimer();
    // `unref` because a timer must never be the reason a quitting app stays alive.
    const timer = setInterval(() => void this.poll(), want);
    timer.unref?.();
    this.timer = timer;
    this.timerEvery = want;
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.timerEvery = undefined;
  }

  private stop(): void {
    this.stopTimer();
    this.started = false;
    this.watchLive = false;
    const unwatch = this.unwatch;
    this.unwatch = undefined;
    unwatch?.();
  }

  /**
   * Ask the machine again, then get out of the way: the decision is not taken here.  The
   * `refresh()` ends in a status push, and that push runs the one `step()` above — so
   * neither the tick nor the watch can dial a link the button would not, and "ready" keeps
   * exactly one definition.  Overlapping asks are dropped rather than queued: a slow adb
   * must not build a backlog of them.
   */
  private async poll(): Promise<void> {
    if (!this.armed) return this.stop();
    if (this.busy) return;
    this.busy = true;
    try {
      const now = Date.now();
      if (this.deps.provision && now - this.lastProvision >= this.provisionEvery) {
        this.lastProvision = now; // stamped before the await: a slow fetch must not stack
        await this.deps.provision();
      }
      await this.deps.refresh();
    } catch (e) {
      this.deps.log(`[app] auto-connect poll failed: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}

// ── the other decision the shell asks for: what closing the window means ────

/** What the shell does with the close button. */
export type CloseAction = 'close' | 'hide' | 'minimize';

/**
 * Closing the window must not drop the wired link, so with `keepRunning` on the window is
 * never really closed: it goes to the tray when there is one, and to the taskbar when
 * there is not.
 *
 * The fallback matters as much as the tray.  Hiding a window on a desktop with no tray
 * would leave a running app with no door at all — the user could neither see the link
 * they are keeping nor stop it, which is exactly the surprise this app avoids.  A
 * minimised window keeps the link up *and* stays reachable, so on a tray-less desktop
 * that is the honest answer, and it is a decision, not an accident.
 *
 * A quit (`quitting`, or the user turning the switch off) is passed straight through:
 * `before-quit` teardown is what guarantees the machine is left as it was found.
 */
export function windowCloseAction(o: { keepRunning?: boolean; quitting?: boolean; tray?: boolean }): CloseAction {
  if (o.quitting === true) return 'close';
  if (o.keepRunning !== true) return 'close';
  return o.tray === true ? 'hide' : 'minimize';
}
