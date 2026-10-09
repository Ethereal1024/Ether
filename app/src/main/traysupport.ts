// traysupport.ts — does this desktop have anywhere to *put* a tray icon, and if not,
// what does the app need to install to get one?
//
// "Minimise to the tray" is a promise the app can only keep if the desktop has a
// tray.  On Windows and macOS that is the OS's own notification area and menu bar: no
// dependency, nothing to check.  On Linux the icon lives in a StatusNotifierItem host
// that the *desktop* provides, and Electron needs the app-indicator client library to
// talk to it — so a stock GNOME session with neither the extension nor the library is
// a machine where `new Tray()` succeeds, prints nothing, and shows nothing.
//
// That is exactly the case the user should not have to diagnose.  This module answers
// the question with evidence (the shell's own extension list, the dynamic linker's own
// cache, and `/etc/os-release` for which package manager to ask), and hands the caller
// the one elevated install that fixes it.  Nothing here installs anything: the plan is
// data, `elevate.ts` runs it, and on a machine whose package manager we do not know the
// honest answer is a sentence rather than a guess.

import type { PackageManager } from './elevate.js';
import type { Plat } from './platform.js';

/** Desktops whose tray is a StatusNotifierItem host. Everything else is "assume yes":
 * an app that nags a working desktop has the same defect as one that hides silently. */
const SNI_DESKTOPS = [
  'kde',
  'plasma',
  'xfce',
  'cinnamon',
  'mate',
  'budgie',
  'deepin',
  'lxqt',
  'unity',
  'pantheon',
];

export type TrayReason = 'sni-host' | 'appindicator-library';

export interface TrayFix {
  manager: PackageManager;
  packages: string[];
}

export interface TraySupport {
  ok: boolean;
  /** What is missing, when something is. */
  reason?: TrayReason;
  /** The elevated install that fixes it — present only when this machine's package
   * manager is one this app knows how to drive. */
  fix?: TrayFix;
  /** One line, for the log and for the sentence the window shows. */
  detail?: string;
}

/** The library Electron dlopen()s to talk to a StatusNotifierItem host. */
const APPLET_LIB = /lib(?:ayatana-)?appindicator3\.so/;
/** The GNOME Shell extension that provides the host itself (`ubuntu-appindicators` on
 * Ubuntu, `appindicator` upstream — both spell the word). */
const GNOME_HOST_EXT = /appindicator/i;

/** The extension and library packages, per family, when the package *names* are ones
 * this project has actually seen work.  A family that is not here gets no button: a
 * package manager invocation that fails on a name we guessed is worse than a sentence. */
const PACKAGES: Record<'debian' | 'fedora', string[]> = {
  debian: ['gnome-shell-extension-appindicator', 'libayatana-appindicator3-1'],
  fedora: ['gnome-shell-extension-appindicator', 'libappindicator-gtk3'],
};

const MANAGERS: Record<'debian' | 'fedora', PackageManager> = {
  debian: 'apt-get',
  fedora: 'dnf',
};

/** The two families this app installs packages on.  `ID` first, then `ID_LIKE`, which
 * is how a derivative (Linux Mint, Pop, Rocky) says what it is built on. */
export function distroFamily(id: string, like = ''): 'debian' | 'fedora' | undefined {
  const words = `${id} ${like}`.toLowerCase().split(/[\s,]+/).filter(Boolean);
  const debian = ['debian', 'ubuntu', 'linuxmint', 'pop', 'elementary', 'zorin', 'kali', 'raspbian', 'neon'];
  const fedora = ['fedora', 'rhel', 'centos', 'rocky', 'almalinux', 'ol'];
  if (words.some((w) => debian.includes(w))) return 'debian';
  if (words.some((w) => fedora.includes(w))) return 'fedora';
  return undefined;
}

/** `ID=ubuntu`, `ID_LIKE=debian` out of an os-release file. */
export function osReleaseIds(text: string): { id: string; like: string } {
  const pick = (key: string): string => {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'm').exec(text);
    if (!m) return '';
    return (m[1] ?? '').trim().replace(/^"(.*)"$/, '$1');
  };
  return { id: pick('ID'), like: pick('ID_LIKE') };
}

export function familyFix(family: 'debian' | 'fedora' | undefined): TrayFix | undefined {
  if (!family) return undefined;
  return { manager: MANAGERS[family], packages: [...PACKAGES[family]] };
}

export interface TraySupportDeps {
  plat: Plat;
  env: NodeJS.ProcessEnv;
  /** Output of `ldconfig -p`.  Empty means "no ldconfig": then we do not know, and
   * "do not know" is not "missing". */
  libs?: () => string;
  /** Output of `gnome-extensions list --enabled`.  Empty means the tool is absent. */
  extensions?: () => string;
  /** Contents of `/etc/os-release`. */
  osRelease?: () => string;
}

/**
 * Is there a tray to minimise into?  Three questions, in the order that makes a wrong
 * answer least likely:
 *
 *   1. not Linux → yes, the OS has one built in;
 *   2. is this a GNOME session?  GNOME has no host of its own and needs the extension,
 *      so the shell's own enabled list is asked — and a session whose extension list
 *      cannot be read is left alone rather than told it is broken;
 *   3. is the app-indicator library there at all?  A session with the host but no
 *      client library is a tray that never appears, which is the silent case this
 *      whole module exists for.
 */
export function traySupport(o: TraySupportDeps): TraySupport {
  if (o.plat !== 'linux') return { ok: true };

  const desktop = (o.env.XDG_CURRENT_DESKTOP ?? '').toLowerCase();
  const forced = o.env.ETHER_TRAY_HOST?.trim().toLowerCase(); // `present` | `missing`
  const gnome = desktop.includes('gnome') || desktop.includes('ubuntu');
  const known = SNI_DESKTOPS.some((d) => desktop.includes(d));
  const family = distroFamily(...Object.values(osReleaseIds(o.osRelease?.() ?? '')) as [string, string]);

  const libs = o.libs?.() ?? '';
  if (libs && !APPLET_LIB.test(libs)) {
    return {
      ok: false,
      reason: 'appindicator-library',
      fix: familyFix(family),
      detail: 'the app-indicator library is not installed',
    };
  }

  if (forced === 'missing' || (gnome && !known)) {
    const enabled = forced === 'missing' ? '' : (o.extensions?.() ?? '');
    if (forced === 'missing' || (enabled !== '' && !GNOME_HOST_EXT.test(enabled))) {
      return {
        ok: false,
        reason: 'sni-host',
        fix: familyFix(family),
        detail: 'this GNOME session has no app-indicator extension enabled',
      };
    }
  }

  return { ok: true };
}

/** The label a distro package is asked for by, for the log line and the fallback text. */
export function fixPackages(fix: TrayFix): string {
  return fix.packages.join(' ');
}
