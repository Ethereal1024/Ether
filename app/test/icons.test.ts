// icons.test.ts — the app's face: one drawing, and every file it is rendered to.
//
// Packaging fails *silently* about icons, in two different ways, and both look like
// "the app" until they are seen next to the real thing:
//
//   * no icon at all.  electron-builder falls back to the stock Electron mark, so the
//     .exe and the .dmg come out looking like a different program (`release.yml` fails
//     a release whose master is missing, and this file pins the rest of the set);
//   * an icon that exists at exactly one size.  A panel that asks the theme for 24px
//     finds nothing to draw and scales a 1024 down badly, or gives up on the lookup
//     entirely — and a taskbar is where this app is looked at most of the time.
//
// The third thing here is not about size.  The mark is drawn in the window's own
// palette (style.css §1), and two of these tests re-derive that palette from the CSS
// and compare it with what is actually inside the files: an icon that keeps colours of
// its own is a second brand, and `tray.png` used to be exactly that.
//
// Everything is read from the files themselves — no Pillow, no renderer — so this runs
// in the same suite on Linux, macOS and Windows.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const buildDir = path.join(appRoot, 'build');
const resDir = path.join(appRoot, 'resources');

// ── PNG, read the long way ──────────────────────────────────────────────────
// `zlib` is the only thing needed: a PNG is IDAT, a filter byte per row and a
// predictor, and decoding it here is what lets the *colours* be asserted rather than
// only the header (a file that is a header and nothing else passes a size check).

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

type Png = { w: number; h: number; px: Buffer };

function readPng(file: string): Png {
  const buf = readFileSync(file);
  assert.equal(buf.subarray(1, 4).toString('ascii'), 'PNG', `${file} is not a PNG`);
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  assert.equal(buf[24], 8, `${file} is not 8 bits per channel`);
  assert.equal(buf[25], 6, `${file} is not RGBA — the alpha channel is the icon's shape`);
  assert.equal(buf[28], 0, `${file} is interlaced; nothing else here expects that`);

  const parts: Buffer[] = [];
  for (let at = 8; at + 12 <= buf.length; ) {
    const len = buf.readUInt32BE(at);
    if (buf.subarray(at + 4, at + 8).toString('ascii') === 'IDAT') parts.push(buf.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(parts));

  const bpp = 4;
  const stride = w * bpp;
  const px = Buffer.alloc(h * stride);
  const zero = Buffer.alloc(stride);
  let at = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[at++] as number;
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const prev = y ? px.subarray((y - 1) * stride, y * stride) : zero;
    for (let x = 0; x < stride; x++) {
      const v = raw[at + x] as number;
      const a = x >= bpp ? (cur[x - bpp] as number) : 0;
      const b = prev[x] as number;
      const c = x >= bpp ? (prev[x - bpp] as number) : 0;
      const fix =
        filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : paeth(a, b, c);
      cur[x] = (v + fix) & 0xff;
    }
    at += stride;
  }
  return { w, h, px };
}

const rgbaAt = (img: Png, x: number, y: number): [number, number, number, number] => {
  const at = (y * img.w + x) * 4;
  return [img.px[at] as number, img.px[at + 1] as number, img.px[at + 2] as number, img.px[at + 3] as number];
};

const hexOf = ([r, g, b]: [number, number, number, number]): string =>
  '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0').toUpperCase()).join('');

/** The colour the icon is mostly made of, among the pixels that are opaque enough to
 * be seen — the plate, in every file that has one. */
function dominant(img: Png): string {
  const counts = new Map<string, number>();
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const p = rgbaAt(img, x, y);
      if (p[3] < 200) continue;
      const c = hexOf(p);
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((l, r) => r[1] - l[1])[0]?.[0] ?? 'none';
}

function pixelCount(img: Png, colour: string): number {
  let n = 0;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) if (hexOf(rgbaAt(img, x, y)) === colour) n++;
  }
  return n;
}

// ── the window's palette, re-derived from the CSS ────────────────────────────
// The same conversion the generator does (Björn Ottosson's Oklab, then the sRGB
// transfer function), written here so a token that moves in style.css fails in this
// suite instead of reaching a release as an icon nobody re-drew.
function oklchToHex(token: string): string {
  const nums = token.match(/-?\d*\.?\d+/g)?.map(Number) ?? [];
  assert.equal(nums.length, 3, `style.css token "${token}" is not oklch(l c h)`);
  const [l, c, deg] = nums as [number, number, number];
  const h = (deg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);

  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const [lr, mr, sr] = [l_ ** 3, m_ ** 3, s_ ** 3];

  const linear = [
    4.0767416621 * lr - 3.3077115913 * mr + 0.2309699292 * sr,
    -1.2684380046 * lr + 2.6097574011 * mr - 0.3413193965 * sr,
    -0.0041960863 * lr - 0.7034186147 * mr + 1.707614701 * sr,
  ];
  const bytes = linear.map((v) => {
    const x = Math.min(1, Math.max(0, v));
    const srgb = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
    return Math.round(srgb * 255);
  });
  return '#' + bytes.map((v) => v.toString(16).padStart(2, '0').toUpperCase()).join('');
}

const cssSrc = readFileSync(path.join(appRoot, 'src', 'renderer', 'style.css'), 'utf8');

function token(name: string): string {
  const found = cssSrc.match(new RegExp(`^\\s*--${name}:\\s*(oklch\\([^)]*\\))`, 'm'));
  assert.ok(found, `style.css has no --${name}`);
  return oklchToHex(found[1] as string);
}

const BG = token('bg');
const LINE = token('line');
const TEXT = token('text');
const MUTED = token('muted');
const ACCENT = token('accent');
const INK = token('accent-ink');

const PALETTE = [BG, LINE, TEXT, MUTED, ACCENT, INK];

const bytesOf = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

const distance = (p: [number, number, number, number], hex: string): number => {
  const c = bytesOf(hex);
  return (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
};

/** The opaque pixels nearer to `colour` than to any other colour of the mark's own
 * palette.  Exact matching is the wrong question for a leg two pixels tall: most of what
 * is seen of it is antialiased edge, so a shape has to be measured by what each pixel
 * most resembles rather than by which hexes it happens to hold. */
function nearestPixels(img: Png, colour: string): [number, number][] {
  const others = PALETTE.filter((c) => c !== colour);
  const found: [number, number][] = [];
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const p = rgbaAt(img, x, y);
      if (p[3] < 40) continue;
      const mine = distance(p, colour);
      if (others.every((c) => distance(p, c) > mine)) found.push([x, y]);
    }
  }
  return found;
}

/** The rows holding at least one pixel of exactly `colour` — for the lit leg, which is
 * the only thing in the app icon drawn in `--accent`. */
function rowsOf(img: Png, colour: string): number[] {
  const rows: number[] = [];
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (hexOf(rgbaAt(img, x, y)) === colour) {
        rows.push(y);
        break;
      }
    }
  }
  return rows;
}

// ── the files ───────────────────────────────────────────────────────────────

test('the master is big enough to derive the .ico and the .icns from', () => {
  const icon = readPng(path.join(buildDir, 'icon.png'));
  assert.deepEqual([icon.w, icon.h], [1024, 1024], 'the Windows and macOS icons are derived from this one file');
  // release.yml checks the header of this same file before a release; here it is the
  // pixels that are checked, so a truncated or blank master cannot ship either.
  assert.equal(dominant(icon), BG, 'the plate is the window --bg, not some grey of its own');
  assert.equal(rgbaAt(icon, 0, 0)[3], 0, 'the plate has to be round: a square icon ignores the desktop');
});

test('Linux is handed a set of sizes, not one 1024px file', () => {
  const dir = path.join(buildDir, 'icons');
  const names = readdirSync(dir).sort();
  assert.ok(names.length >= 5, `build/icons carries ${names.length} files`);

  for (const name of names) {
    const named = name.match(/^(\d+)x(\d+)\.png$/);
    assert.ok(named, `${name} is not named <N>x<N>.png, which is how electron-builder reads a set`);
    const img = readPng(path.join(dir, name));
    assert.deepEqual([img.w, img.h], [Number(named?.[1]), Number(named?.[2])], `${name} does not hold that size`);
    // A panel asking for 16px needs a 16px drawing, not a 16px file holding a 1024px
    // drawing: the mark has a detail budget and it is spent per size.  The lit leg is the
    // feature that budget loses first — it is the thinnest thing in the drawing — so it
    // is the one pinned here, row by row.
    //
    // Every feature is an even number of device pixels wide, because the mark is centred
    // on the canvas and at an even size that centre is a pixel *edge*: a leg 3 rows tall
    // spans one and a half of them on each side, is half-covered top and bottom, and
    // reaches the screen at half strength.  Before this was a rule, no icon below 256 px
    // held a single pixel of --accent — the lit leg was there, as a grey-blue smudge.
    const lit = rowsOf(img, ACCENT);
    assert.ok(lit.length >= 2, `${name} has no lit leg in it — the accent leg is the mark`);
    assert.equal(lit.length % 2, 0, `${name}: the lit leg is ${lit.length} rows tall, and an even-centred feature has to be an even number of them`);
    assert.equal(
      (lit[0] as number) + (lit[lit.length - 1] as number),
      img.h - 1,
      `${name}: the lit leg is off-centre on the canvas`,
    );
  }

  // The directory is only worth having if the packager is told to read it.
  const yml = readFileSync(path.join(appRoot, 'electron-builder.yml'), 'utf8');
  assert.match(yml, /^\s*icon:\s*build\/icons\s*$/m, 'the deb installs one 1024px icon without this');
});

test('the window is handed an icon, and that file ships with it', () => {
  const icon = readPng(path.join(resDir, 'appicon.png'));
  assert.deepEqual([icon.w, icon.h], [256, 256]);
  assert.equal(dominant(icon), BG);
  assert.ok(rgbaAt(icon, icon.w / 2, icon.h / 2)[3] > 0, 'the mark is drawn on the plate, not beside it');

  // The taskbar entry and the alt-tab switcher read the window's icon, and in a dev
  // run it is the only icon the app has at all: without this line Electron draws its
  // own mark, which is a different program's face.
  const indexSrc = readFileSync(path.join(appRoot, 'src', 'main', 'index.ts'), 'utf8');
  assert.match(indexSrc, /new BrowserWindow\(\{[\s\S]*?icon:\s*windowIcon\(\)/, 'the window is drawn with no icon');
  assert.match(indexSrc, /appicon\.png/, 'the window icon has to be the file that ships in resources/');
  // A missing file is not fatal, but it must not be fatal *silently* either: an empty
  // image means Electron's default, which is what this call is there to replace.
  assert.match(indexSrc, /icon\.isEmpty\(\) \? undefined : icon/, 'an unreadable icon file would throw in a getter');
});

test('every icon is drawn in the window\u2019s own palette, not one of its own', () => {
  const svg = readFileSync(path.join(buildDir, 'icon.svg'), 'utf8').toUpperCase();
  for (const [name, hex] of [['--bg', BG], ['--line', LINE], ['--text', TEXT], ['--muted', MUTED], ['--accent', ACCENT]] as const) {
    assert.ok(svg.includes(hex), `build/icon.svg is missing style.css ${name} (${hex})`);
  }

  // The raster master is the same drawing: the plate is --bg, the nodes are --text and
  // the carrying leg is --accent, all three present as real pixels.
  const raster = readPng(path.join(buildDir, 'icon.png'));
  assert.ok(pixelCount(raster, TEXT) > 1000, 'the two nodes are drawn in --text');
  assert.ok(pixelCount(raster, ACCENT) > 1000, 'the carrying leg is --accent');
  assert.equal(pixelCount(raster, LINE) > 100, true, 'the plate edge is --line');
});

test('the tray is the same mark in the accent plate, at the sizes a menu bar wants', () => {
  // The tray used to be a second drawing — two interlocking rings — so the window and
  // its own icon advertised two different brands.  These three files are that mark
  // again, and this is what says so.
  const tray = readPng(path.join(resDir, 'tray.png'));
  assert.deepEqual([tray.w, tray.h], [64, 64]);
  assert.equal(dominant(tray), ACCENT, 'the tray plate is --accent');

  // The mark on it is ink, and it is the same chain the window is: two nodes on the
  // middle row, joined across the middle of the plate.  Measured by what each pixel most
  // resembles rather than by exact hexes — a 2 px leg is almost all antialiased edge, and
  // counting the hexes inside a shape is how a test comes to disagree with the drawing
  // it is guarding.
  const ink = nearestPixels(tray, INK);
  assert.ok(ink.length > 100, `the mark on the plate is --accent-ink (${ink.length} px)`);
  const xs = ink.map((p) => p[0]);
  const ys = ink.map((p) => p[1]);
  assert.equal(Math.min(...xs) + Math.max(...xs), tray.w - 1, 'the mark is not centred across the plate');
  assert.equal(Math.min(...ys) + Math.max(...ys), tray.h - 1, 'the mark is not centred down the plate');
  assert.ok(Math.max(...ys) - Math.min(...ys) < tray.h / 4, 'the mark is a chain on the middle of the plate, not a blob');
  assert.ok(Math.max(...xs) - Math.min(...xs) < tray.w * 0.8, 'the mark runs into the plate’s edge');

  // macOS recolours a "template" image from its alpha channel, so what matters is that
  // the shape is there and that it is black: a coloured template is drawn as a grey
  // blob on a light menu bar.
  for (const [name, size] of [['trayTemplate.png', 16], ['trayTemplate@2x.png', 32]] as const) {
    const img = readPng(path.join(resDir, name));
    assert.deepEqual([img.w, img.h], [size, size]);
    let painted = 0;
    for (let y = 0; y < img.h; y++) {
      for (let x = 0; x < img.w; x++) {
        const p = rgbaAt(img, x, y);
        if (p[3] < 40) continue;
        painted++;
        assert.deepEqual([p[0], p[1], p[2]], [0, 0, 0], `${name} is not a template: it carries colour`);
      }
    }
    assert.ok(painted > 10, `${name} is empty`);
  }
});
