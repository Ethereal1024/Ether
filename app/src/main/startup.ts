// startup.ts — the two things this app is allowed to do before the user asks: nothing
// at all, unless they said so.  It owns
//
//   * the settings we persist (`settings.json`, next to state.json in the data dir);
//   * the desktop's own way of opening an app with the session (a per-user startup
//     entry on Linux; macOS and Windows hand that to Electron, which is why the
//     platform split lives in the shell).
//
// Electron-free on purpose, like controller.ts: the decision below is testable
// headlessly.  The Linux half is a plain file in the user's own config directory — no
// admin, no /etc, no registry, no PATH edit.  `test/noadmin.test.ts` fails the build
// if that stops being true, and it is the reason this is the only file that may name
// that directory at all.
//
// The launch-at-login switch is deliberately *not* stored here.  Its truth is the OS
// (`app.getLoginItemSettings()`, or the entry file itself): the moment the user
// deletes the entry by hand, a remembered copy would be a checkbox that lies.  Only
// `autoConnect` is a setting we own.

import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

// ── the settings we own ─────────────────────────────────────────────────────

export interface Settings {
  /** Dial the wired link as soon as the app is up, when a usable device is there. */
  autoConnect: boolean;
}

export const SETTINGS_NAME = 'settings.json';
export const DEFAULT_SETTINGS: Settings = { autoConnect: false };

export function settingsPath(dataDir: string): string {
  return path.join(dataDir, SETTINGS_NAME);
}

/**
 * A settings file is a hint about what *we* wrote, so it is re-validated rather than
 * trusted (the same rule state.json follows): a truncated or hand-edited file falls
 * back to the default, never to a crash and never to `true`.  In particular a string
 * `"yes"` is not a yes — only the boolean is.
 */
export function normalizeSettings(v: unknown): Settings {
  const o = (v ?? {}) as Partial<Settings>;
  return { autoConnect: o.autoConnect === true };
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
