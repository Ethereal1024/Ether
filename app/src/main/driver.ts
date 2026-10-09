// driver.ts — the Windows half of "plug the device in and it just works".
//
// On Linux the device is reachable once a udev rule lets the session at it.  Windows is
// the other way round: the USB stack needs Google's WinUSB driver bound to the device,
// and a machine that has never had Android tooling installed simply does not have it —
// the device shows up with a warning badge and adb says nothing at all.  Telling the
// user to go and find a driver zip is exactly the homework this app is supposed to
// remove, so the app fetches Google's own published package, extracts its `.inf`, and
// hands the *install* to `elevate.ts` (which asks Windows for the consent it needs).
//
// Two halves, deliberately separate:
//   * the probe — read the PnP device list and answer "is an Android device on the bus
//     without a driver?" — pure text parsing, unit-tested against a captured CSV;
//   * the plan — where the package comes from and which file inside it is the driver.
// The download and the elevated install are performed by the shell, not here.

import { ANDROID_VENDOR_IDS } from './platform.js';

/** Google publishes the Windows driver with platform-tools; this is the stable URL. */
export const USB_DRIVER_URL = 'https://dl.google.com/android/repository/usb_driver_r13-windows.zip';

/** The name the download gets inside the app's own data dir. */
export const USB_DRIVER_ZIP = 'usb_driver_r13-windows.zip';

/** The driver's own file name inside the zip (`usb_driver/android_winusb.inf`). */
export const USB_DRIVER_INF = 'android_winusb.inf';

/**
 * How the device list is read: `Get-PnpDevice` is part of Windows itself and needs no
 * rights to *query*, so the probe never raises a prompt.  CSV rather than a table
 * because `ConvertTo-Csv` gives one record per line with both fields quoted — parsing
 * that is a pure function and not a matter of guessing at column widths.
 */
export function pnpQueryArgv(): string[] {
  const cmd =
    "$ErrorActionPreference='SilentlyContinue'; " +
    'Get-PnpDevice -Class USB | Select-Object Status,InstanceId | ConvertTo-Csv -NoTypeInformation';
  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', cmd];
}

/**
 * Is one of the Android vendor ids on the bus *without* a working driver?
 *
 * The CSV comes from `Get-PnpDevice`:
 *
 *     "Status","InstanceId"
 *     "OK","USB\VID_17EF&PID_7E1C\HA2HS0KT"
 *     "Error","USB\VID_18D1&PID_4EE7\0123456789ABCDEF"
 *
 * Only `OK` means "bound and working"; `Error`, `Unknown` and `Degraded` are the
 * states a device is in when the driver is missing or wrong.  An unrecognised status
 * counts as not-OK on purpose: blaming a driver is a fixable sentence, and claiming a
 * device is fine when it is not is not.
 */
export function driverMissingFromCsv(text: string, known: readonly string[] = ANDROID_VENDOR_IDS): boolean {
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const m = /^"([^"]*)"\s*,\s*"(.*)"$/.exec(line);
    if (!m) continue; // the header, a blank line, or anything that is not one record
    const status = (m[1] ?? '').trim().toUpperCase();
    const instance = m[2] ?? '';
    const vid = /VID_([0-9A-Fa-f]{4})/.exec(instance);
    if (!vid) continue;
    if (!known.includes((vid[1] as string).toLowerCase())) continue;
    if (status !== 'OK') return true;
  }
  return false;
}

/**
 * Which file inside the extracted package is the driver.  Google's zip has exactly one
 * `.inf` (`usb_driver/android_winusb.inf`), but the name is looked for first so a
 * repackaged or renamed tree still resolves — and any other `.inf` is the fallback,
 * because the file that was shipped is a better answer than "nothing found".
 */
export function findInfInList(files: readonly string[]): string | undefined {
  const named = files.find((f) => f.toLowerCase().endsWith(USB_DRIVER_INF));
  if (named) return named;
  return files.find((f) => f.toLowerCase().endsWith('.inf'));
}
