#!/usr/bin/env python3
"""make-tray-icons.py — draw the tray icon files, so they are source and not binaries.

Three files come out of this, and each has a job:

  * `resources/tray.png`           64x64, the accent plate with the link glyph — what
                                   Linux and Windows draw (they do not recolour it);
  * `resources/trayTemplate.png`   16x16, black on transparent, macOS only: the menu bar
                                   recolours a "template" image to match the user's theme;
  * `resources/trayTemplate@2x.png` 32x32, the same at the Retina scale.

The colours are the window's own, converted from its oklch tokens: `--accent`
`oklch(0.8 0.1 225)` is `#70CBEE` and `--accent-ink` `oklch(0.22 0.045 240)` is
`#031D2D`.  Keeping them here as hex with that note is the point — an icon that drifts
from the button it mirrors is a second brand.

Everything is drawn at 8x and downsampled, which is what buys the smooth plate edge the
tray wants; Pillow does the resampling.  Run it from `app/`:

    python3 tools/make-tray-icons.py          # writes resources/
    python3 tools/make-tray-icons.py --check  # exits non-zero if the files are stale
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw

ACCENT = (0x70, 0xCB, 0xEE, 255)  # --accent  oklch(0.8 0.1 225)
INK = (0x03, 0x1D, 0x2D, 255)  # --accent-ink  oklch(0.22 0.045 240)
SS = 8  # supersampling factor

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / 'resources'


def rounded_plate(size: int, radius_frac: float, colour):
    """A rounded square, drawn at SSx and resampled down."""
    big = size * SS
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, big - 1, big - 1], radius=radius_frac * big, fill=colour)
    return img.resize((size, size), Image.LANCZOS)


def link_glyph(size: int, colour, stroke_frac: float = 0.085):
    """Two interlocking rings — the "link is up" mark, and the same mark the window's
    path row draws.  Drawn as outlines so it reads as a chain at 64px and still has a
    recognisable silhouette at 16px."""
    big = size * SS
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = 0.185 * big
    w = max(2, round(stroke_frac * big))
    cy = big / 2
    for cx in (0.635 * big, 0.365 * big):
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=colour, width=w)
    return img.resize((size, size), Image.LANCZOS)


def coloured(size: int = 64) -> Image.Image:
    plate = rounded_plate(size, 0.28, ACCENT)
    plate.alpha_composite(link_glyph(size, INK))
    return plate


def template(size: int) -> Image.Image:
    """Black on transparent: macOS keeps only the alpha channel and repaints it."""
    return link_glyph(size, (0, 0, 0, 255), stroke_frac=0.09)


FILES = {
    'tray.png': lambda: coloured(64),
    'trayTemplate.png': lambda: template(16),
    'trayTemplate@2x.png': lambda: template(32),
}


def png_bytes(img: Image.Image) -> bytes:
    import io

    buf = io.BytesIO()
    img.save(buf, format='PNG', optimize=True)
    return buf.getvalue()


def main(argv: list[str]) -> int:
    check = '--check' in argv
    OUT.mkdir(parents=True, exist_ok=True)
    stale = []
    for name, make in FILES.items():
        want = png_bytes(make())
        path = OUT / name
        have = path.read_bytes() if path.exists() else None
        if check:
            if have != want:
                stale.append(name)
            continue
        if have != want:
            path.write_bytes(want)
            print(f'wrote {path.relative_to(HERE.parent)} ({len(want)} bytes)')
        else:
            print(f'unchanged {path.relative_to(HERE.parent)}')
    if check and stale:
        print(f'stale tray icons: {", ".join(stale)} — run tools/make-tray-icons.py')
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
