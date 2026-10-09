// tray.ts — the Electron half of the tray icon: create it, redraw it, tear it down.
//
// Everything decided without Electron is in `traymenu.ts`; this file is only the
// adapter, and it is written defensively on purpose.  A desktop with no StatusNotifier
// host makes `new Tray()` *succeed* and then show nothing, and a headless session can
// make it throw — so the handle reports whether the icon is real, and a caller that
// gets `ok: false` falls back to the taskbar instead of hiding the window into nothing.

import { Menu, Tray, nativeImage } from 'electron';
import type { Plat } from './platform.js';
import { actionFor, trayIconPath, trayMenu, trayTooltip, type TrayAction, type TrayLabels } from './traymenu.js';

export interface TrayHandle {
  /** False when this desktop has no tray: the caller must keep the window reachable. */
  ok: boolean;
  /** Redraw the tooltip and the menu for a new state. Safe to call before/after ok. */
  update(state: string): void;
  destroy(): void;
}

export interface TrayOpts {
  plat: Plat;
  resourcesDir: string;
  labels: TrayLabels;
  /** `show` / `toggle` / `quit` — the shell's verbs, never anything else. */
  onAction: (a: TrayAction) => void;
  /** Where a failure is reported. Optional: the tray is not allowed to be fatal. */
  log?: (l: string) => void;
}

const noop: TrayHandle = { ok: false, update: () => undefined, destroy: () => undefined };

/**
 * Build the icon.  Never throws: a tray that cannot be created is a fact about the
 * desktop, not an error the app should die of — the window simply keeps its own door
 * open (minimise) instead of the icon.
 */
export function createTray(o: TrayOpts): TrayHandle {
  let tray: Tray;
  try {
    const icon = nativeImage.createFromPath(trayIconPath(o.plat, o.resourcesDir));
    if (icon.isEmpty()) {
      o.log?.(`[tray] no icon at ${trayIconPath(o.plat, o.resourcesDir)}`);
      return noop;
    }
    tray = new Tray(icon);
  } catch (e) {
    o.log?.(`[tray] unavailable: ${(e as Error).message}`);
    return noop;
  }

  const click = (id: string) => {
    const action = actionFor(id);
    if (action) o.onAction(action);
  };

  const update = (state: string) => {
    try {
      const template: Electron.MenuItemConstructorOptions[] = [];
      for (const item of trayMenu(state, o.labels)) {
        // The state line is information, not a control: no click handler at all, so a
        // menu opened to start the link cannot stop it by accident.
        if (item.id === 'status') template.push({ label: item.label, enabled: false });
        else template.push({ label: item.label, enabled: item.enabled, click: () => click(item.id) });
        if (item.separatorAfter) template.push({ type: 'separator' });
      }
      tray.setContextMenu(Menu.buildFromTemplate(template));
      tray.setToolTip(trayTooltip(state, o.labels));
    } catch (e) {
      o.log?.(`[tray] update failed: ${(e as Error).message}`);
    }
  };

  update('checking');
  // A left click is the same door as `Show Ether`: on Windows and macOS the menu is
  // what the right button opens, so the plain click has to do something.
  tray.on('click', () => click('show'));

  return {
    ok: true,
    update,
    destroy: () => {
      try {
        tray.destroy();
      } catch {
        /* already gone */
      }
    },
  };
}
