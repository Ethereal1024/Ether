// traymenu.ts — what the tray icon says and what its menu offers, as data.
//
// The tray is how the app keeps its promise that closing the window does not drop the
// wired link: the icon is the window's second door, and its menu is the only way back
// to a window the user hid.  Everything about it that can be decided without Electron
// is decided *here*, so `tray.ts` is a thin adapter (create an icon, build the menu,
// teardown) and a unit test can pin the wording and the disabled/enabled logic without
// a running desktop.
//
// One icon for every state on purpose.  A per-state icon set is N files to keep in
// step with the state machine and N chances for one of them to be stale; the tooltip
// and the menu's first line already carry the state, and both are read from the same
// status the window draws.

import path from 'node:path';
import type { Plat } from './platform.js';

/** The three things the menu can ask the shell to do. */
export type TrayAction = 'show' | 'toggle' | 'quit';

/** The item ids the adapter maps back to actions; `status` is drawn, never clicked. */
export type TrayItemId = TrayAction | 'status';

export interface TrayMenuItem {
  id: TrayItemId;
  label: string;
  enabled: boolean;
  /** A rule after this item. Only ever set on the last one. */
  separatorAfter?: boolean;
}

/** The words the tray borrows from the window's own catalogue. */
export interface TrayLabels {
  /** One word per state, from `messages.ts` (`on` / `off` / `working…` / `needs attention`). */
  on: string;
  off: string;
  working: string;
  needsAttention: string;
  /** The menu, in the app's own voice. */
  show: string;
  start: string;
  stop: string;
  quit: string;
}

/** The state word the tooltip and the menu's first line carry, read from the same
 * table the window's chip uses. */
export function trayWord(state: string, l: TrayLabels): string {
  switch (state) {
    case 'up':
    case 'degraded':
      return l.on;
    case 'error':
      return l.needsAttention;
    case 'checking':
    case 'starting':
      return l.working;
    default:
      return l.off;
  }
}

/** Hovering the icon answers "what is the app doing" without a click. */
export function trayTooltip(state: string, l: TrayLabels): string {
  return `Ether — ${trayWord(state, l)}`;
}

/** A link that is up can be stopped and one that is down can be started; while the app
 * is working on either, the menu offers neither (a second press would be a second
 * tunnel). */
export function trayToggle(state: string, l: TrayLabels): { label: string; enabled: boolean } {
  if (state === 'checking' || state === 'starting' || state === 'stopping') {
    return { label: l.working, enabled: false };
  }
  if (state === 'up' || state === 'degraded') return { label: l.stop, enabled: true };
  return { label: l.start, enabled: true };
}

/**
 * The menu: the state, then the two doors (show the window, stop/start), then quit.
 * `Show Ether` is first because it is the one item a user reaches for when the window
 * is gone — the whole reason the tray exists.
 */
export function trayMenu(state: string, l: TrayLabels): TrayMenuItem[] {
  const toggle = trayToggle(state, l);
  return [
    { id: 'status', label: `Ether — ${trayWord(state, l)}`, enabled: false },
    { id: 'show', label: l.show, enabled: true },
    { id: 'toggle', label: toggle.label, enabled: toggle.enabled },
    { id: 'quit', label: l.quit, enabled: true, separatorAfter: true },
  ];
}

/** Translate the adapter's click ids back into the app's own verbs. Anything unknown is
 * a no-op rather than a guess. */
export function actionFor(id: string): TrayAction | undefined {
  return id === 'show' || id === 'toggle' || id === 'quit' ? id : undefined;
}

/**
 * The icon file.  macOS draws a "template" image — black on transparent, recoloured by
 * the menu bar to match the user's theme — and only recognises it as one when the file
 * name ends in `Template`.  Everywhere else the icon keeps its own colours.
 */
export function trayIconName(plat: Plat): string {
  return plat === 'darwin' ? 'trayTemplate.png' : 'tray.png';
}

export function trayIconPath(plat: Plat, resourcesDir: string): string {
  return path.join(resourcesDir, trayIconName(plat));
}
