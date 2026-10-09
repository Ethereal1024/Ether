// elevate.ts — the one place this app asks for administrator rights.
//
// The product rule this file implements, and that `test/escalation.test.ts` enforces
// on the source: Ether **may** ask the OS for raised rights, but it must never *make
// the user* open a terminal and type the privileged command themselves.  A one-time
// udev rule, a missing AppIndicator package, a USB driver — those are the app's job to
// install, through the desktop's own consent prompt, not homework.
//
// So every privileged action in this repository is
//
//   * declared here as data: an argv vector, never a string a shell parses;
//   * handed to the platform's consent broker — `pkexec` on Linux, `Start-Process
//     -Verb RunAs` on Windows, `do shell script … with administrator privileges` on
//     macOS — so the user answers the prompt their desktop already shows them, and
//     the answer is what we act on;
//   * refusable without damage: dismissing the prompt means nothing happened, and the
//     caller then shows the sentence plus the manual command instead of an error
//     nobody can act on.
//
// `shell: true` never appears in this file, and no argv element is ever built out of
// unvalidated text: the difference between "install the app-indicator package" and
// "install the app-indicator package; and also this" is exactly a shell.

import type { Plat } from './platform.js';
import path from 'node:path';

/** One program and its arguments. Never a string: a shell would re-read it. */
export interface Step {
  file: string;
  args: string[];
}

/** The package managers this app knows how to drive, and only those. */
export type PackageManager = 'apt-get' | 'dnf' | 'pacman' | 'zypper';

/** Package names are a closed vocabulary: they come from this repository, never from a
 * response body, a PATH lookup or the user.  A name that could travel in would be an
 * argv element handed to a privileged package manager. */
const PACKAGE_NAME = /^[a-z0-9][a-z0-9+._-]*$/;

export function isPackageName(s: string): boolean {
  return PACKAGE_NAME.test(s);
}

/**
 * The argv for one package manager.  Non-interactive on purpose: the consent prompt
 * the user already answered is the confirmation, and a second question asked in a
 * terminal that no longer exists would hang forever.
 */
export function packageArgs(manager: PackageManager, packages: readonly string[]): string[] {
  for (const p of packages) {
    if (!isPackageName(p)) throw new Error(`refusing a package name that is not one: '${p}'`);
  }
  switch (manager) {
    case 'apt-get':
      return ['install', '-y', '--no-install-recommends', ...packages];
    case 'dnf':
      return ['install', '-y', ...packages];
    case 'pacman':
      return ['-S', '--noconfirm', '--needed', ...packages];
    case 'zypper':
      return ['--non-interactive', 'install', ...packages];
  }
}

/** The udev rule that lets the user's own session reach an Android device.  One shared
 * builder, so the file this app writes and the command it prints can never drift. */
export function udevRuleLine(vendorId: string): string {
  const vid = vendorId.trim().toLowerCase();
  if (!/^[0-9a-f]{4}$/.test(vid)) throw new Error(`not a USB vendor id: '${vendorId}'`);
  return `SUBSYSTEM=="usb", ATTR{idVendor}=="${vid}", MODE="0666"`;
}

/** Where the rule goes.  A drop-in of our own: `51-android.rules` is the name every
 * Android how-to uses, so a machine that already followed one keeps working. */
export const RULE_PATH = '/etc/udev/rules.d/51-android.rules';

/** The privileged work this app is allowed to do — the complete list. */
export type PrivOp =
  | { kind: 'grantDeviceAccess'; vendorId: string; rulePath: string; stagedFile: string }
  | { kind: 'installPackages'; manager: PackageManager; packages: string[] }
  | { kind: 'installUsbDriver'; inf: string };

/**
 * The remedies the window can offer, named for what the *user* gets rather than for the
 * op that implements them: `installTraySupport` is one `installPackages` op, and the
 * name the window draws has to be the thing that is missing.  Kept here, next to the
 * ops, so the two vocabularies cannot drift; the priority a caller picks between them in
 * (`grantDeviceAccess` first) is the caller's, not this file's.
 */
export type FixKind = 'grantDeviceAccess' | 'installUsbDriver' | 'installTraySupport';

/** What one remedy can end with.  A dismissal is an answer, not a failure. */
export type FixReason = 'done' | 'refused' | 'failed' | 'noBroker';

export interface FixResult {
  ok: boolean;
  reason: FixReason;
}

/**
 * The steps one op runs, in order, as the administrator.  `grantDeviceAccess` writes
 * nothing itself: the rule text is staged by the unprivileged half of the app and
 * `install(1)` copies it into `/etc`, which is why no shell redirection — and so no
 * shell — is needed for the one op that writes a file.
 */
export function privSteps(op: PrivOp): Step[] {
  switch (op.kind) {
    case 'grantDeviceAccess':
      return [
        { file: 'install', args: ['-m', '0644', op.stagedFile, op.rulePath] },
        { file: 'udevadm', args: ['control', '--reload-rules'] },
        { file: 'udevadm', args: ['trigger'] },
      ];
    case 'installPackages':
      return [{ file: op.manager, args: packageArgs(op.manager, op.packages) }];
    case 'installUsbDriver':
      // `pnputil` is present on every Windows since 10; two steps because the second
      // one is what makes the driver take effect on the device already on the bus.
      return [
        { file: 'pnputil', args: ['/add-driver', op.inf, '/install'] },
        { file: 'pnputil', args: ['/scan-devices'] },
      ];
  }
}

// ── the consent broker ──────────────────────────────────────────────────────

/** `sh` quoting for the one platform whose broker takes a string (macOS). */
export function quoteSh(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** AppleScript string quoting: backslash and double quote, and nothing else. */
export function quoteAppleScript(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** A PowerShell literal: single quotes, doubled. */
export function quotePowershell(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * How one step is handed to the platform's consent broker.  The returned argv is what
 * gets spawned — `file` is always an absolute-by-PATH name of a system program
 * (`pkexec`, `osascript`, `powershell.exe`) and never a shell.
 *
 * macOS and Windows take a command *string* rather than an argv, so they are the two
 * places where quoting matters: macOS quotes the argv for `sh` and the result for
 * AppleScript, Windows quotes each argument for PowerShell.  Both are pure functions
 * so a test can pin them.
 */
export function brokerArgv(plat: Plat, step: Step): string[] {
  switch (plat) {
    case 'linux':
      return ['pkexec', step.file, ...step.args];
    case 'darwin': {
      const cmd = [step.file, ...step.args].map(quoteSh).join(' ');
      return [
        'osascript',
        '-e',
        `do shell script ${quoteAppleScript(cmd)} with administrator privileges`,
      ];
    }
    case 'win32': {
      const list = step.args.map(quotePowershell).join(',');
      const run =
        `$p = Start-Process -FilePath ${quotePowershell(step.file)}` +
        ` -ArgumentList ${list} -Verb RunAs -Wait -PassThru; exit $p.ExitCode`;
      return ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', run];
    }
  }
}

/** The name of the program each platform's broker needs to exist. */
export function brokerTool(plat: Plat): string {
  return plat === 'linux' ? 'pkexec' : plat === 'darwin' ? 'osascript' : 'powershell.exe';
}

/**
 * Where the broker would be, in PATH order.  Asking "can this machine raise a consent
 * prompt?" must not itself run a program — and must not raise a prompt — so it is a
 * directory scan the caller does with `fileExists`, never a spawn.
 */
export function brokerCandidates(plat: Plat, env: NodeJS.ProcessEnv): string[] {
  const name = brokerTool(plat);
  // The separators are the *target* platform's, not the host's: these strings are handed
  // to that platform's own `existsSync`, and a test has to be able to ask about a machine
  // it is not running on.
  const win = plat === 'win32';
  const join = win ? path.win32.join : path.posix.join;
  const out: string[] = [];
  for (const dir of (env.PATH ?? '').split(win ? ';' : ':')) {
    if (dir) out.push(join(dir, name));
  }
  if (plat === 'linux') out.push('/usr/bin/pkexec', '/usr/local/bin/pkexec');
  if (plat === 'darwin') out.push('/usr/bin/osascript');
  if (plat === 'win32') {
    const root = env.SystemRoot ?? 'C:\\Windows';
    out.push(path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', name));
  }
  return out;
}

/**
 * Did the user say no?  `pkexec` says so with 126 (dismissed) and 127 (not
 * authorised); Windows and macOS report a refusal as a non-zero code from the broker
 * itself.  Telling "the user declined" apart from "the command failed" is the
 * difference between a sentence and a bug report.
 */
export function isRefusal(plat: Plat, code: number): boolean {
  if (plat === 'linux') return code === 126 || code === 127;
  return code === 1 || code === 1223; // 1223: ERROR_CANCELLED, Windows
}

/** A step, spelled the way a user would type it — the fallback text, and the log line. */
export function stepText(step: Step): string {
  return [step.file, ...step.args].map((a) => (/^[A-Za-z0-9_./:=+-]+$/.test(a) ? a : quoteSh(a))).join(' ');
}

// ── running them ────────────────────────────────────────────────────────────

export interface ElevateResult {
  /** Every step ran and exited 0. */
  ok: boolean;
  /** The step that did not run, if any: an index into the op's steps. */
  step?: number;
  code?: number;
  /** `noBroker`: this machine has no consent broker at all (a bare container, a
   * stripped desktop) — the caller must fall back to telling the user. */
  reason?: 'noBroker' | 'refused' | 'failed';
  /** The output of the step that failed, for the log. */
  out?: string;
}

export interface ElevateDeps {
  plat: Plat;
  /** Spawn one argv. Must not throw: a missing program is `code: 127`. */
  run: (file: string, args: string[]) => Promise<{ code: number; out?: string }>;
  /** Does the broker exist? Defaults to "assume yes" so a caller that cannot check
   * does not silently lose the automatic path. */
  haveBroker?: () => boolean | Promise<boolean>;
}

/**
 * Run one op through the consent broker, in order, stopping at the first step that
 * does not succeed.  A refusal is not an error: it is an answer, and it leaves the
 * machine exactly as it was.
 */
export async function runPrivOp(op: PrivOp, deps: ElevateDeps): Promise<ElevateResult> {
  if (deps.haveBroker && !(await deps.haveBroker())) return { ok: false, reason: 'noBroker' };
  const steps = privSteps(op);
  for (let i = 0; i < steps.length; i++) {
    const argv = brokerArgv(deps.plat, steps[i]!);
    const { code, out } = await deps.run(argv[0]!, argv.slice(1));
    if (code !== 0) {
      return { ok: false, step: i, code, reason: isRefusal(deps.plat, code) ? 'refused' : 'failed', out };
    }
  }
  return { ok: true };
}
