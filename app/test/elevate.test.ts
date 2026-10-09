// elevate.test.ts — the privileged half of the app, tested as argv.
//
// Ether may ask the desktop for raised rights (the udev rule, the tray packages, the
// Windows USB driver), and the whole of that promise is this file's subject: what
// exactly gets spawned, in what order, and what the answer "no" looks like.  The
// product rule is not "never elevates" any more, it is "never makes the *user* type the
// command" — so the tests below are about the shape of the spawn:
//
//   * an argv vector, never a string a shell parses (`pkexec` and the program it runs
//     are two elements, not one line);
//   * the platform's own consent broker, so the user answers the prompt their desktop
//     already shows them;
//   * a refusal that leaves the machine exactly as it was, reported as an answer
//     (`refused`) rather than as a failure the user cannot act on;
//   * a fallback for the machine that has no broker at all (`noBroker`), which is the
//     only case `platform.ts`'s paste-able commands exist for.

import {
  brokerArgv,
  brokerCandidates,
  brokerTool,
  isPackageName,
  isRefusal,
  packageArgs,
  privSteps,
  quoteAppleScript,
  quotePowershell,
  quoteSh,
  RULE_PATH,
  runPrivOp,
  stepText,
  udevRuleLine,
  type FixKind,
  type PrivOp,
  type Step,
} from '../src/main/elevate.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';

/** The one op that writes a file, narrowed so the tests can read `stagedFile` back. */
type DeviceOp = Extract<PrivOp, { kind: 'grantDeviceAccess' }>;

const op = (over: Partial<DeviceOp> = {}): DeviceOp => ({
  kind: 'grantDeviceAccess',
  vendorId: '18d1',
  rulePath: RULE_PATH,
  stagedFile: '/home/me/.config/ether/51-android-18d1.rules',
  ...over,
});

// ── the rule, and the packages ──────────────────────────────────────────────

test('the rule this app writes is the rule it prints, and a vendor id is four hex digits', () => {
  assert.equal(udevRuleLine('18d1'), 'SUBSYSTEM=="usb", ATTR{idVendor}=="18d1", MODE="0666"');
  assert.equal(udevRuleLine('18D1'), udevRuleLine('18d1'), 'case is not part of a vendor id');
  assert.equal(udevRuleLine(' 18d1 '), udevRuleLine('18d1'));

  // Anything that is not a vendor id would end up inside a rule file the *system*
  // reads, so it is refused here rather than quoted and hoped for.
  for (const bad of ['', '18d', '18d1x', '0x18d1', '$(id)', '18d1\nSUBSYSTEM=="usb", MODE="0666"']) {
    assert.throws(() => udevRuleLine(bad), `accepted '${bad}'`);
  }
  // The group clause is deliberately absent: the mode bit is what adb needs, and the
  // group it would name does not exist on every distro.
  assert.doesNotMatch(udevRuleLine('18d1'), /GROUP=/);
});

test('a package name is a closed vocabulary, and one that could travel in is refused', () => {
  assert.equal(isPackageName('libayatana-appindicator3-1'), true);
  assert.equal(isPackageName('gnome-shell-extension-appindicator'), true);
  for (const bad of ['', '-n', 'a b', 'a;b', 'a&&b', 'a/b', 'a$(id)', 'A']) {
    assert.equal(isPackageName(bad), false, bad);
  }
  assert.throws(() => packageArgs('apt-get', ['ok', 'bad name']));

  assert.deepEqual(packageArgs('apt-get', ['p']), ['install', '-y', '--no-install-recommends', 'p']);
  assert.deepEqual(packageArgs('dnf', ['p']), ['install', '-y', 'p']);
  assert.deepEqual(packageArgs('pacman', ['p']), ['-S', '--noconfirm', '--needed', 'p']);
  assert.deepEqual(packageArgs('zypper', ['p']), ['--non-interactive', 'install', 'p']);
  // Non-interactive every way: a package manager that asks a question in a terminal
  // that no longer exists hangs the whole fix.
  for (const manager of ['apt-get', 'dnf', 'pacman', 'zypper'] as const) {
    const argv = packageArgs(manager, ['p']);
    assert.ok(argv.some((a) => /^(-y|--noconfirm|--non-interactive)$/.test(a)), manager);
  }
});

// ── the ops ────────────────────────────────────────────────────────────────

test('granting device access is install(1) copying a staged file, never a shell redirection', () => {
  const steps = privSteps(op());
  assert.deepEqual(
    steps.map((s) => s.file),
    ['install', 'udevadm', 'udevadm'],
  );
  assert.deepEqual(steps[0]?.args, ['-m', '0644', op().stagedFile, RULE_PATH]);
  assert.deepEqual(steps[1]?.args, ['control', '--reload-rules']);
  assert.deepEqual(steps[2]?.args, ['trigger']);
  // The file is written by the unprivileged half (index.ts), so no step needs to
  // interpret a `>` — which is exactly why no step needs a shell.
  for (const s of steps) {
    for (const a of s.args) assert.doesNotMatch(a, /[|&;<>`$()]/, `shell metacharacter in ${a}`);
  }
});

test('the tray packages and the Windows driver are one op each, and the driver takes effect', () => {
  const packages = privSteps({ kind: 'installPackages', manager: 'apt-get', packages: ['a', 'b'] });
  assert.deepEqual(packages, [{ file: 'apt-get', args: ['install', '-y', '--no-install-recommends', 'a', 'b'] }]);

  const driver = privSteps({ kind: 'installUsbDriver', inf: 'C:\\ether\\usb-driver\\usb_driver\\android_winusb.inf' });
  assert.equal(driver[0]?.file, 'pnputil');
  assert.deepEqual(driver[0]?.args.slice(0, 2), ['/add-driver', driver[0]?.args[1] ?? '']);
  assert.ok((driver[0]?.args ?? []).includes('/install'));
  // The second step is what binds the driver to the device that is already on the bus.
  assert.deepEqual(driver[1], { file: 'pnputil', args: ['/scan-devices'] });
});

test('every remedy the window can name has steps behind it', () => {
  const kinds: FixKind[] = ['grantDeviceAccess', 'installTraySupport', 'installUsbDriver'];
  const ops: PrivOp[] = [
    op(),
    { kind: 'installPackages', manager: 'apt-get', packages: ['p'] },
    { kind: 'installUsbDriver', inf: 'x.inf' },
  ];
  const covered = new Set(ops.map((o) => (o.kind === 'installPackages' ? 'installTraySupport' : o.kind)));
  assert.deepEqual([...covered].sort(), [...kinds].sort());
  for (const o of ops) {
    const steps = privSteps(o);
    assert.ok(steps.length > 0, `${o.kind} has no steps`);
    for (const s of steps) assert.ok(s.file.length > 0 && Array.isArray(s.args));
  }
});

// ── the broker ─────────────────────────────────────────────────────────────

test('Linux hands the argv to pkexec as an argv: the program is never a shell string', () => {
  const step: Step = { file: 'install', args: ['-m', '0644', '/tmp/a b.rules', RULE_PATH] };
  const argv = brokerArgv('linux', step);
  assert.deepEqual(argv, ['pkexec', 'install', '-m', '0644', '/tmp/a b.rules', RULE_PATH]);
  // The path with a space stays *one* element: nothing re-splits it.
  assert.equal(argv.filter((a) => a === '/tmp/a b.rules').length, 1);
  assert.equal(brokerTool('linux'), 'pkexec');
});

test('macOS and Windows need a command string, so every element is quoted for its own parser', () => {
  const step: Step = { file: 'pnputil', args: ['/add-driver', "C:\\Program Files\\d\\a.inf", '/install'] };

  const mac = brokerArgv('darwin', step);
  assert.deepEqual(mac.slice(0, 2), ['osascript', '-e']);
  assert.match(mac[2] ?? '', /^do shell script ".*" with administrator privileges$/);
  assert.equal(mac.length, 3);
  // Two quoting layers on top of each other: the argv is `sh`-quoted, then the result is
  // AppleScript-quoted.  So the check is "unescape one layer and the quoted argv is
  // exactly there, backslashes and all".
  const body = (mac[2] ?? '').slice('do shell script "'.length, -'" with administrator privileges'.length);
  const unescaped = body.replace(/\\(["\\])/g, '$1');
  assert.ok(unescaped.includes(quoteSh("C:\\Program Files\\d\\a.inf")), unescaped);

  const win = brokerArgv('win32', step);
  assert.equal(win[0], 'powershell.exe');
  assert.ok(win.includes('-NonInteractive'));
  const script = win[win.length - 1] ?? '';
  assert.match(script, /Start-Process -FilePath 'pnputil'/);
  assert.match(script, /-Verb RunAs -Wait -PassThru/);
  assert.equal(script.includes(`C:\\Program Files\\d\\a.inf`), true, 'the path is single-quoted, not doubled');
  assert.equal(brokerTool('win32'), 'powershell.exe');

  // The quoting helpers, on their own: the difference between "one argument" and "one
  // argument and also this" is exactly what they have to get right.
  assert.equal(quoteSh("it's"), `'it'\\''s'`);
  assert.equal(quotePowershell("it's"), `'it''s'`);
  assert.equal(quoteAppleScript('a\\b"c'), '"a\\\\b\\"c"');
});

test('which broker this machine has is a path question, never a spawn', () => {
  const linux = brokerCandidates('linux', { PATH: '/usr/bin:/bin' });
  assert.deepEqual(linux.slice(0, 2), ['/usr/bin/pkexec', '/bin/pkexec']);
  assert.ok(linux.includes('/usr/bin/pkexec'));

  const win = brokerCandidates('win32', { PATH: '', SystemRoot: 'C:\\Windows' });
  assert.deepEqual(win, ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']);
  assert.ok(brokerCandidates('darwin', { PATH: '/usr/bin' }).includes('/usr/bin/osascript'));
  // An empty PATH still finds the platform's own copy, so a stripped environment does
  // not look like "this desktop has no consent prompt".
  assert.ok(brokerCandidates('linux', {}).length > 0);
});

test('a dismissal is told apart from a failure, on every platform', () => {
  assert.equal(isRefusal('linux', 126), true, 'pkexec: dismissed');
  assert.equal(isRefusal('linux', 127), true, 'pkexec: not authorised');
  assert.equal(isRefusal('linux', 1), false, 'the command itself failed');
  assert.equal(isRefusal('win32', 1223), true, 'ERROR_CANCELLED');
  assert.equal(isRefusal('darwin', 1), true, 'osascript: user cancelled');
  assert.equal(isRefusal('darwin', 0), false);
});

test('a step is spelled the way a user would type it, quoting only what needs it', () => {
  assert.equal(stepText({ file: 'install', args: ['-m', '0644', '/tmp/x.rules', RULE_PATH] }), `install -m 0644 /tmp/x.rules ${RULE_PATH}`);
  assert.equal(stepText({ file: 'install', args: ['a b'] }), "install 'a b'");
  // The fallback text is for a human to paste: a `|` in it is a command, which is why
  // the argv never contains one.
  assert.equal(stepText({ file: 'echo', args: ['x|y'] }), "echo 'x|y'");
});

// ── running one ────────────────────────────────────────────────────────────

/** A `run` that records every argv and answers from a script of exit codes. */
function runner(codes: number[] = []) {
  const calls: Array<{ file: string; args: string[] }> = [];
  let i = 0;
  return {
    calls,
    run: async (file: string, args: string[]): Promise<{ code: number; out?: string }> => {
      calls.push({ file, args });
      const code = codes[i++] ?? 0;
      return { code, out: code === 0 ? '' : 'denied' };
    },
  };
}

test('one op runs its steps in order, through the broker, and stops at the first failure', async () => {
  const r = runner();
  const ok = await runPrivOp(op(), { plat: 'linux', run: r.run });
  assert.deepEqual(ok, { ok: true });
  assert.deepEqual(
    r.calls.map((c) => c.file),
    ['pkexec', 'pkexec', 'pkexec'],
  );
  assert.deepEqual(r.calls[0]?.args.slice(0, 1), ['install']);
  assert.deepEqual(r.calls[1]?.args, ['udevadm', 'control', '--reload-rules']);

  // The second step failing must not run the third: a reload that did not happen makes
  // the trigger meaningless, and the user is told what stopped.
  const stop = runner([0, 1]);
  const failed = await runPrivOp(op(), { plat: 'linux', run: stop.run });
  assert.deepEqual(failed, { ok: false, step: 1, code: 1, reason: 'failed', out: 'denied' });
  assert.equal(stop.calls.length, 2);

  const denied = runner([126]);
  const refused = await runPrivOp(op(), { plat: 'linux', run: denied.run });
  assert.equal(refused.reason, 'refused');
  assert.equal(refused.ok, false);
  assert.equal(refused.step, 0);
  assert.equal(denied.calls.length, 1, 'nothing runs after a dismissal');
});

test('a desktop with no consent broker is answered before anything is spawned', async () => {
  const r = runner();
  const res = await runPrivOp(op(), { plat: 'linux', run: r.run, haveBroker: () => false });
  assert.deepEqual(res, { ok: false, reason: 'noBroker' });
  assert.deepEqual(r.calls, [], 'asking must not be the thing that raises the prompt');
});

test('a missing program is an answer, not an exception', async () => {
  // 127 is what a spawn of a program that is not there gives back; the caller has to
  // see a result either way, because the fix runs from a status handler.
  const res = await runPrivOp({ kind: 'installPackages', manager: 'dnf', packages: ['p'] }, {
    plat: 'linux',
    run: async () => ({ code: 127 }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 127);
  assert.equal(typeof res.reason, 'string');
});
