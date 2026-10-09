// escalation.test.ts — the shape of "the app may ask for admin, the user never types a
// privileged command".  Checked on the source, because a promise nobody executes is how
// it rots.
//
// What this file is defending:
//
//   * the privileged commands are *data* in exactly two files: `elevate.ts` declares the
//     argv the broker is handed, and `platform.ts` prints the fallback as text for the
//     human to paste.  No third file names one at all, and the printed half is never
//     spawned — a string the user copies is not a command the app runs;
//   * a prompt is raised only when the remedy button is pressed: one call site for
//     `runPrivOp`, one caller of `runFix`, and neither reachable from the startup path;
//   * nothing is ever handed to a shell (`shell: true` turns any string into a command),
//     and the Windows half is the one place a `powershell.exe` query runs — read-only,
//     and with no `-Verb RunAs` anywhere near it;
//   * the system stays the user's: no writes into /etc, /usr, /lib or a drive root, one
//     per-user startup entry in one module, and an installer that installs per-user and
//     still refuses to elevate.
//
// A failure here is not a style complaint: it means the product now asks the user for
// something this file says the app must ask the OS for instead.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const srcMain = path.join(appRoot, 'src', 'main');
const srcRenderer = path.join(appRoot, 'src', 'renderer');

function sources(dir: string, keep: (f: string) => boolean): Array<[string, string]> {
  // Always spelled with `/`, whatever the host uses: these names are asserted on
  // ("the privileged text lives in exactly one file"), and on Windows the same walk
  // yields `src\main\platform.ts`, which would fail an assertion about content.
  const rel = path.relative(appRoot, dir).split(path.sep).join('/');
  return readdirSync(dir)
    .filter(keep)
    .sort()
    .map((f) => [path.posix.join(rel, f), readFileSync(path.join(dir, f), 'utf8')] as [string, string]);
}

const appSources: Array<[string, string]> = [
  ...sources(srcMain, (f) => /\.(ts|cjs)$/.test(f) && !f.endsWith('.test.ts')),
  ...sources(srcRenderer, (f) => /\.(js|html|css)$/.test(f)),
  ['bin/cli.mjs', readFileSync(path.join(appRoot, 'bin', 'cli.mjs'), 'utf8')],
];

const ELEVATE = 'src/main/elevate.ts';
const PLATFORM = 'src/main/platform.ts';
const DRIVER = 'src/main/driver.ts';

/**
 * The part of a line a person would call code: a `//` comment is dropped, and a line
 * that is only a block-comment continuation is code-free too.  Quoting a rule in a
 * comment is how this repository explains itself, so comments must not fail the scan.
 */
function codeLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const cut = raw.indexOf('//');
    const line = (cut === -1 ? raw : raw.slice(0, cut)).trim();
    if (line === '' || line.startsWith('*') || line.startsWith('/*')) continue;
    out.push(line);
  }
  return out;
}

/** Every code line of every source that matches, as `file: line`. */
function scanCode(re: RegExp): string[] {
  const hits: string[] = [];
  for (const [file, text] of appSources) {
    for (const line of codeLines(text)) if (re.test(line)) hits.push(`${file}: ${line}`);
  }
  return hits;
}

function filesOf(hits: string[]): string[] {
  return [...new Set(hits.map((h) => h.slice(0, h.indexOf(':'))))].sort();
}

test('a privileged program is named in two files only, and the second one prints rather than spawns', () => {
  // `sudo`/`pkexec`/`pnputil`/`Start-Process`: all the ways a machine is asked to do
  // something as the administrator.  Anything else naming one is a new escalation path.
  const named = scanCode(/\b(sudo|pkexec|gksudo|doas|pnputil)\b|Start-Process/);
  assert.deepEqual(filesOf(named), [ELEVATE, PLATFORM].sort(), `unexpected privileged code: ${named.join(' | ')}`);

  // platform.ts is the *fallback*: its privileged lines are string literals that go into
  // `hint`, so the user can paste them.  A line that does not start with a quote would be
  // the app running them instead.
  for (const hit of named.filter((h) => h.startsWith(`${PLATFORM}:`))) {
    const line = hit.slice(PLATFORM.length + 2);
    assert.match(line, /^[`'"]/, `the fallback must be text, not a spawn: ${line}`);
  }
  const platform = readFileSync(path.join(srcMain, 'platform.ts'), 'utf8');
  const sudoLines = platform.split('\n').filter((l) => /\bsudo\b/.test(l) && !l.trim().startsWith('//'));
  assert.ok(sudoLines.length >= 2, 'the fallback is the two commands a user would type');

  // The other two escalation markers belong to the broker declaration and nowhere else.
  assert.deepEqual(filesOf(scanCode(/with administrator privileges|-Verb\s+RunAs|-Verb,'RunAs'/i)), [ELEVATE]);
});

test('the Windows half queries the device list without asking for anything', () => {
  // `powershell.exe` is allowed in one more file: `driver.ts` reads the PnP device list,
  // which needs no rights.  Elevating there would turn a probe into a prompt on startup.
  assert.deepEqual(filesOf(scanCode(/powershell\.exe/i)), [DRIVER, ELEVATE].sort());
  for (const [file, text] of appSources) {
    if (file === ELEVATE) continue;
    for (const line of codeLines(text)) {
      if (!/powershell\.exe/i.test(line)) continue;
      assert.equal(file, DRIVER, `${file} spawns PowerShell: ${line}`);
      assert.doesNotMatch(line, /RunAs|Start-Process/i, line);
    }
  }
  const driver = readFileSync(path.join(srcMain, 'driver.ts'), 'utf8');
  assert.match(driver, /Get-PnpDevice/);
  assert.match(driver, /-NoProfile/);
  assert.match(driver, /-NonInteractive/);
});

test('nothing is ever handed to a shell, anywhere', () => {
  // `shell: true` (and its `{ shell: true }` spelling) is the one line that turns a
  // validated argv back into a string a shell re-reads.  There is no legitimate use.
  assert.deepEqual(scanCode(/shell\s*:\s*true/), []);
  // Same rule stated positively: what reaches the spawn is elements, never a joined line.
  const elevate = readFileSync(path.join(srcMain, 'elevate.ts'), 'utf8');
  assert.match(elevate, /brokerArgv/);
  assert.match(elevate, /deps\.run\(argv\[0\]!, argv\.slice\(1\)\)/, 'the broker is handed an argv');
});

test('a prompt is raised only when the remedy button is pressed', () => {
  const index = readFileSync(path.join(srcMain, 'index.ts'), 'utf8');
  const lines = index.split('\n');

  // One place runs a privileged op, and it is `runFix`.
  const runners = lines.filter((l) => /\brunPrivOp\s*\(/.test(l));
  assert.equal(runners.length, 1, `privileged ops are run from one place: ${runners.join(' | ')}`);

  // ...which has exactly one caller, inside the `fix` handler.  Starting the app,
  // probing the desktop and drawing the window never call it.
  const calls = lines.flatMap((l, i) => (/await runFix\(\)/.test(l) ? [i] : []));
  assert.equal(calls.length, 1, 'one caller for the whole remedy path');
  const handler = lines.findIndex((l) => /ipcMain\.handle\(\s*'fix'/.test(l));
  assert.ok(handler !== -1, "the window's one verb is `fix`");
  assert.ok(calls[0]! > handler, 'the only caller is inside the fix handler');

  // The startup path — everything from `app.whenReady` on — must not even mention it.
  const startup = index.slice(index.indexOf('app.whenReady'));
  assert.ok(startup.length > 0);
  assert.doesNotMatch(startup, /runFix|runPrivOp/, 'nothing escalates while the app comes up');

  // And the log line spells the op out of `stepText`, so no privileged literal is written
  // by hand here (a hand-written one would be a second, untested copy of the argv).
  assert.match(index, /privSteps\(op\)\.map\(stepText\)\.join\(' && '\)/);
});

test('the rule file is written by install(1), and its path is named in two files', () => {
  // `/etc/udev/rules.d` may be *named* by the module that declares the rule and by the
  // module that prints the fallback; copying into it happens through the broker.
  const withRulePath = appSources.filter(([, text]) => /\/etc\/udev\/rules\.d/.test(text)).map(([f]) => f);
  assert.deepEqual(withRulePath.sort(), [ELEVATE, PLATFORM].sort());

  // The rule text is staged by the unprivileged half and copied by `install`, so the
  // privileged argv needs no redirection — which is why it needs no shell.
  const elevate = readFileSync(path.join(srcMain, 'elevate.ts'), 'utf8');
  assert.match(elevate, /\{ file: 'install', args: \['-m', '0644'/);
});

test('the app never writes outside its own data dir', () => {
  // Reading sysfs and the udev rule dirs is allowed (platform.ts does it); *writing*
  // into /etc, /usr, /lib or a drive root is not — that is what an installer with admin
  // does, and this app asks the broker for exactly three named things instead.
  assert.deepEqual(
    scanCode(/(writeFile|writeFileSync|mkdir|mkdirSync|appendFile\w*|rm|rmSync|unlink\w*|cp|copyFile\w*)\s*\(\s*['"`](\/etc\/|\/usr\/|\/lib\/|\/run\/|[A-Za-z]:\\\\)/),
    [],
  );
  assert.deepEqual(scanCode(/\b(reg\s+add|HKEY_|setx\b|setPath\b|\.rdf\/rules)/i), []);

  // The one exception, and it is a narrow one: the per-user startup entry of the desktop
  // session the user is already in, written only when they turn the switch in the window
  // on.  It is their own file in their own config dir — no rights, no PATH edit, no other
  // account.  Naming that directory is allowed in the one module that writes it, so a
  // second place that knows the path is a deliberate change rather than an accident.
  const startup = appSources.filter(([, text]) => /autostart/i.test(text)).map(([f]) => f);
  assert.deepEqual(startup, ['src/main/startup.ts'], 'the per-user entry is written in one module');
  // ...while the system-wide ones stay forbidden everywhere, because those are what an
  // installer with admin would write and this app has no installer and no admin.
  assert.deepEqual(scanCode(/\/etc\/xdg\/autostart|\/usr\/share\/applications/i), []);
});

test('packaging keeps the promise too: Windows installs per-user, and NSIS does not elevate', () => {
  const yml = readFileSync(path.join(appRoot, 'electron-builder.yml'), 'utf8');
  assert.match(yml, /^\s*perMachine:\s*false\s*$/m, 'an all-users install asks for admin');
  assert.match(yml, /^\s*allowElevation:\s*false\s*$/m, 'allowElevation:true lets NSIS pop a UAC prompt');
});
