// noadmin.test.ts — the promise "the app never needs administrator rights" is
// checked here, on the source, because a promise nobody executes is how it rots.
//
// What this file is defending (§3.1, §3.4 row 3):
//
//   * the app *prints* the two udev commands and never runs them — the user runs
//     them, in the OS, once;
//   * nothing escalates on its own: no sudo/pkexec process, no `shell: true`, no
//     writing into /etc or /usr, no registry/PATH edits, no autostart;
//   * the one privileged-looking sentence is the §3.4 row-3 hint, and it lives in
//     exactly one file, which is the only place allowed to know about platforms.
//
// A failure here is not a style complaint: it means the product now asks for
// something the plan says it must never ask for.

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

function scan(re: RegExp, where: Array<[string, string]> = appSources): string[] {
  const hits: string[] = [];
  for (const [file, text] of where) {
    for (const line of text.split('\n')) {
      if (re.test(line)) hits.push(`${file}: ${line.trim()}`);
    }
  }
  return hits;
}

test('the app never spawns a privileged helper', () => {
  // `execFile('sudo', ...)` is the shape this is about. Quote-agnostic and
  // intended for both the sync and async forms.
  assert.deepEqual(scan(/(execFile|execFileSync|spawn|spawnSync)\s*\(\s*['"`](sudo|pkexec|gksudo|doas)\b/), []);
  assert.deepEqual(scan(/shell\s*:\s*true/), [], 'shell:true turns any string into a shell command');
  assert.deepEqual(scan(/\b(ShellExecute|runas|Start-Process)\b/), [], 'Windows escalation');
});

test('the app never writes outside its own data dir', () => {
  // Reading sysfs/udev rule dirs is allowed (platform.ts does it); *writing* into
  // /etc, /usr, /lib or a Windows system dir is not — that is what an installer
  // with admin would do, and this app intentionally has none.
  assert.deepEqual(
    scan(/(writeFile|writeFileSync|mkdir|mkdirSync|appendFile\w*|rm|rmSync|unlink\w*|cp|copyFile\w*)\s*\(\s*['"`](\/etc\/|\/usr\/|\/lib\/|\/run\/|[A-Za-z]:\\\\)/),
    [],
  );
  assert.deepEqual(scan(/\b(reg\s+add|HKEY_|setx\b|setPath\b|\.rdf\/rules|autostart|\.config\/autostart)/i), []);
});

test('the privileged text lives in exactly one file, and only as text to print', () => {
  // platform.ts is the only file allowed to hold the commands.  Other files may
  // *mention* sudo in a comment (adb.ts promises it never sudoes); code may not.
  for (const [file, text] of appSources) {
    if (file.endsWith('platform.ts')) continue;
    for (const line of text.split('\n')) {
      if (!/\bsudo\b/.test(line)) continue;
      const t = line.trim();
      assert.ok(t.startsWith('//') || t.startsWith('*'), `sudo in code outside platform.ts: ${file}: ${t}`);
    }
  }
  const withRulePath = appSources.filter(([, text]) => /\/etc\/udev\/rules\.d/.test(text)).map(([f]) => f);
  assert.deepEqual(withRulePath, ['src/main/platform.ts']);

  const platform = readFileSync(path.join(srcMain, 'platform.ts'), 'utf8');
  const sudoLines = platform.split('\n').filter((l) => /\bsudo\b/.test(l));
  assert.ok(sudoLines.length >= 2, 'the §3.4 row-3 hint is two commands');
  for (const line of sudoLines) {
    // Every privileged line must be a string literal that ends up in `hint`.
    const t = line.trim();
    assert.ok(
      t.startsWith('`') || t.startsWith("'") || t.startsWith('"') || /^return\s+['"`]/.test(t) || t.startsWith('//') || t.startsWith('*'),
      `sudo outside a returned string: ${t}`,
    );
  }
});

test('packaging keeps the promise too: Windows installs per-user, never elevating', () => {
  const yml = readFileSync(path.join(appRoot, 'electron-builder.yml'), 'utf8');
  assert.match(yml, /^\s*perMachine:\s*false\s*$/m, 'an all-users install asks for admin');
  assert.match(yml, /^\s*allowElevation:\s*false\s*$/m, 'allowElevation:true lets NSIS pop a UAC prompt');
});
