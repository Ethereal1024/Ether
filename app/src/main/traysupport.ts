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

/** The families whose package manager this app knows how to drive, and the names that
 * family gives each of the two things that can be missing.
 *
 * A name here is a name this project has checked against the distribution's *own*
 * repositories — Arch's `extra` and openSUSE Tumbleweed's OSS repo, like `apt` and `dnf`
 * before them — because a package manager invocation that fails on a guessed name is
 * worse than a sentence: it costs a consent prompt and leaves the desktop no better off.
 *
 * `extension` is absent where the distribution does not package the GNOME host at all.
 * openSUSE ships the client library and not the extension, so a GNOME session there gets
 * the sentence instead of a button for a package that does not exist. */
interface FamilyPackages {
  manager: PackageManager;
  /** The client library Electron `dlopen()`s. */
  library: string;
  /** The GNOME Shell extension that hosts the icon — where the distro has one. */
  extension?: string;
}

export type DistroFamily = 'debian' | 'fedora' | 'arch' | 'suse';

const FAMILIES: Record<DistroFamily, FamilyPackages> = {
  debian: {
    manager: 'apt-get',
    library: 'libayatana-appindicator3-1',
    extension: 'gnome-shell-extension-appindicator',
  },
  fedora: {
    manager: 'dnf',
    library: 'libappindicator-gtk3',
    extension: 'gnome-shell-extension-appindicator',
  },
  arch: {
    manager: 'pacman',
    library: 'libayatana-appindicator',
    extension: 'gnome-shell-extension-appindicator',
  },
  // openSUSE: `libayatana-appindicator3-1` is the library, and there is no extension
  // package in the distribution's repositories — so `sni-host` has no install here.
  suse: { manager: 'zypper', library: 'libayatana-appindicator3-1' },
};

/** The families this app installs packages on.  `ID` first, then `ID_LIKE`, which is how
 * a derivative (Linux Mint, Manjaro, GeckoLinux) says what it is built on — so the
 * derivatives arrive through their base rather than through a list of every respin.
 *
 * An immutable-root openSUSE (`opensuse-microos`) reports `ID_LIKE="opensuse suse"` and so
 * arrives here as the suse family; its root then refuses the install and the receipt says
 * the change could not be made.  That is a machine this app cannot drive, but not a *name*
 * this app guessed, and driving it (transactional-update, a reboot) is a different remedy
 * rather than a different package. */
export function distroFamily(id: string, like = ''): DistroFamily | undefined {
  const words = `${id} ${like}`.toLowerCase().split(/[\s,]+/).filter(Boolean);
  const families: Array<[DistroFamily, string[]]> = [
    ['debian', ['debian', 'ubuntu', 'linuxmint', 'pop', 'elementary', 'zorin', 'kali', 'raspbian', 'neon']],
    ['fedora', ['fedora', 'rhel', 'centos', 'rocky', 'almalinux', 'ol']],
    ['arch', ['arch', 'archlinux', 'manjaro', 'endeavouros', 'cachyos', 'garuda']],
    ['suse', ['suse', 'sles', 'sled', 'opensuse', 'opensuse-leap', 'opensuse-tumbleweed']],
  ];
  for (const [family, names] of families) {
    if (words.some((w) => names.includes(w))) return family;
  }
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

/**
 * The one install that fixes `reason` on this family, or nothing at all.
 *
 * Reason-specific on purpose: `traySupport` asks one question at a time, and a press must
 * install the thing that is actually missing rather than a bundle — a KDE session whose
 * client library is absent has no use for a GNOME extension, and asking a package manager
 * for one is exactly the guess this module refuses to make.
 */
export function familyFix(family: DistroFamily | undefined, reason: TrayReason): TrayFix | undefined {
  if (!family) return undefined;
  const found = FAMILIES[family];
  const name = reason === 'sni-host' ? found.extension : found.library;
  if (!name) return undefined;
  return { manager: found.manager, packages: [name] };
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
      fix: familyFix(family, 'appindicator-library'),
      detail: 'the app-indicator library is not installed',
    };
  }

  if (forced === 'missing' || (gnome && !known)) {
    const enabled = forced === 'missing' ? '' : (o.extensions?.() ?? '');
    if (forced === 'missing' || (enabled !== '' && !GNOME_HOST_EXT.test(enabled))) {
      return {
        ok: false,
        reason: 'sni-host',
        fix: familyFix(family, 'sni-host'),
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
