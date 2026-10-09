// driver.test.ts — the Windows half of "plug the device in and it just works", tested
// where it is a pure function: a captured device list in, one boolean out.
//
// Windows has no udev rule to install; it needs Google's WinUSB driver bound to the
// device, and a machine that has never had Android tooling installed does not have it.
// The probe is deliberately the unprivileged half — it asks Windows' own PnP database
// what it thinks, and the *install* is `elevate.ts`'s business.  What this file pins:
//
//   * the query needs no rights (no `-Verb RunAs`, no `Start-Process`) and reads a format
//     a machine can actually print;
//   * only `OK` means "bound and working", and an unrecognised status is not OK;
//   * only the vendor ids this project knows about are ours to fix;
//   * the `.inf` handed to the installer is the one Google shipped, not the first file
//     that happens to end in `.inf`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  driverMissingFromCsv,
  findInfInList,
  pnpQueryArgv,
  USB_DRIVER_INF,
  USB_DRIVER_URL,
  USB_DRIVER_ZIP,
} from '../src/main/driver.js';

/** A captured `Get-PnpDevice | ConvertTo-Csv` answer: one working device, one broken. */
const CSV = [
  '"Status","InstanceId"',
  '"OK","USB\\VID_17EF&PID_7E1C\\HA2HS0KT"',
  '"Error","USB\\VID_18D1&PID_4EE7\\0123456789ABCDEF"',
  '',
].join('\r\n');

test('the probe asks Windows itself, and asks for nothing', () => {
  const argv = pnpQueryArgv();
  assert.equal(argv[0], 'powershell.exe');
  assert.ok(argv.includes('-NoProfile'), 'a user profile must not be able to change the answer');
  assert.ok(argv.includes('-NonInteractive'));
  const cmd = argv[argv.length - 1] ?? '';
  assert.match(cmd, /Get-PnpDevice/);
  assert.match(cmd, /ConvertTo-Csv/);
  // Reading the device list needs no rights, so the probe must never ask for them: a
  // prompt on startup would be the exact thing this app promises not to do.
  for (const a of argv) assert.doesNotMatch(a, /RunAs|Start-Process/i, a);
  // One `-Command` string and nothing that could add a second one.
  assert.equal(argv.filter((a) => a === '-Command').length, 1);
});

test('only a device Windows says is working counts as working', () => {
  // The captured answer above has a working phone and a broken one, both Android.
  assert.equal(driverMissingFromCsv(CSV), true);

  assert.equal(driverMissingFromCsv('"Status","InstanceId"'), false, 'a header alone says nothing');
  assert.equal(driverMissingFromCsv(''), false);

  // Every other status Windows reports is the state a device is in when the driver is
  // missing or wrong — and an unrecognised one is not OK either, on purpose: blaming a
  // driver is a fixable sentence, and calling a broken device fine is not.
  for (const status of ['Error', 'Unknown', 'Degraded', 'ERROR', 'weird']) {
    const csv = `"Status","InstanceId"\n"${status}","USB\\VID_18D1&PID_4EE7\\S"`;
    assert.equal(driverMissingFromCsv(csv), true, status);
  }
  assert.equal(driverMissingFromCsv('"Status","InstanceId"\n"OK","USB\\VID_18D1&PID_4EE7\\S"'), false);
});

test('a vendor id this app does not know is never ours to "fix"', () => {
  // A webcam with a bad driver is a real problem, but not this app's: installing the
  // Android driver over it would be a bug that is hard to see and hard to undo.
  assert.equal(driverMissingFromCsv('"Status","InstanceId"\n"Error","USB\\VID_dead&PID_0001\\X"'), false);
  assert.equal(driverMissingFromCsv('"Status","InstanceId"\n"Error","USB\\VID_18D&PID_4EE7\\X"'), false);
  assert.equal(driverMissingFromCsv('"Status","InstanceId"\n"Error","USB\\PID_18D1\\X"'), false);
  // The vendor id identifies the hardware, whatever enumerator prefix Windows put in
  // front of it: a phone whose composite children are in error is still the phone.
  assert.equal(driverMissingFromCsv('"Status","InstanceId"\n"Error","HID\\VID_18D1&PID_4EE7\\X"'), true);

  // The comparison is case-insensitive because the id in the device path is upper case
  // while the list this project keeps is lower case.
  assert.equal(driverMissingFromCsv('"Status","InstanceId"\n"Error","USB\\VID_18d1&PID_4EE7\\X"'), true);

  // And the known list is a parameter, so a caller can ask about one specific phone.
  const one = 'USB\\VID_2717&PID_FF40\\S';
  assert.equal(driverMissingFromCsv(`"Status","InstanceId"\n"Error","${one}"`, ['2717']), true);
  assert.equal(driverMissingFromCsv(`"Status","InstanceId"\n"Error","${one}"`, ['18d1']), false);
});

test('the driver file is the one Google shipped, and the fetch is Google-s own URL', () => {
  assert.equal(USB_DRIVER_URL, 'https://dl.google.com/android/repository/usb_driver_r13-windows.zip');
  assert.equal(USB_DRIVER_ZIP, 'usb_driver_r13-windows.zip');
  assert.equal(USB_DRIVER_INF, 'android_winusb.inf');

  const inf = USB_DRIVER_INF;
  // The package's real layout: the zip has several files, and exactly one of them is the
  // driver.  Picking the first `.inf` wins only when the named one is genuinely absent.
  const files = [
    'usb_driver/amd64/WinUSBCoInstaller2.dll',
    `usb_driver/${inf}`,
    'usb_driver/other.inf',
    'usb_driver/x86/WdfCoInstaller.dll',
  ];
  assert.equal(findInfInList(files), `usb_driver/${inf}`);
  assert.equal(findInfInList(['a/b/other.inf']), 'a/b/other.inf');
  assert.equal(findInfInList([]), undefined);
  assert.equal(findInfInList(['nothing/here.dll']), undefined);
  // A repackaged tree still resolves: the name is looked for case-insensitively.
  assert.equal(findInfInList(['DRIVER/Android_WinUSB.INF']), 'DRIVER/Android_WinUSB.INF');
});
