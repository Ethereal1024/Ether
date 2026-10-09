#!/usr/bin/env python3
"""Draw Ether's app icon (app/build/icon.png) — one rounded plate, one lit link.

This is a *source* generator, not a build step: the PNG it writes is committed,
and every platform icon is derived from it at package time (electron-builder
turns `build/icon.png` into the Windows .ico and the macOS .icns itself — one
image, three platforms, no per-platform asset to drift).

The mark is the window's own footer: a device node and a PC node joined by a
rule, with the leg that is *carrying* drawn in the action colour.  Nothing else
is on the plate — at 32 px the two dots and the lit segment are still three
readable marks, and at 1024 px the plate's edge highlight is the same idea the
card uses (`1px inset top highlight`, style.css §6).

Colours come from the window's palette (style.css §1) so the icon and the app
cannot disagree: --bg, --line, --muted, --text, --accent.  oklch() is not a
thing this script's viewer understands, so the tokens are converted here with
the Oklab definition rather than eyeballed from a screenshot.

    python3 scripts/make-icon.py [--out app/build/icon.png] [--size 1024]

Requires Pillow (only this script does; nothing in the app or its packaging
pipeline imports it).
"""
from __future__ import annotations

import argparse
import math
import pathlib
import sys

try:
    from PIL import Image, ImageDraw
except ImportError:  # pragma: no cover - a host without Pillow is the normal case
    sys.exit("make-icon.py needs Pillow:  pip install --user pillow")


# ── oklch -> sRGB ────────────────────────────────────────────────────────────
# Björn Ottosson's Oklab, then the sRGB transfer function.  Kept here in full so
# the numbers below stay traceable to the CSS they came from.
def _oklch_to_srgb(lightness: float, chroma: float, hue_deg: float) -> tuple[int, int, int]:
    hue = math.radians(hue_deg)
    a = chroma * math.cos(hue)
    b = chroma * math.sin(hue)

    l_ = lightness + 0.3963377774 * a + 0.2158037573 * b
    m_ = lightness - 0.1055613458 * a - 0.0638541728 * b
    s_ = lightness - 0.0894841775 * a - 1.2914855480 * b
    l, m, s = l_**3, m_**3, s_**3

    linear = (
        +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    )

    def encode(c: float) -> int:
        c = min(1.0, max(0.0, c))
        srgb = 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055
        return round(srgb * 255)

    return tuple(encode(c) for c in linear)  # type: ignore[return-value]


# style.css §1 — the five values the icon is allowed to use.
PLATE = _oklch_to_srgb(0.185, 0.0, 0)      # --bg
PLATE_EDGE = _oklch_to_srgb(0.315, 0.0, 0)  # --line
NODE = _oklch_to_srgb(0.96, 0.0, 0)        # --text
RULE = _oklch_to_srgb(0.72, 0.0, 0)        # --muted
LIT = _oklch_to_srgb(0.80, 0.10, 225)      # --accent


def draw(size: int, ss: int = 4) -> Image.Image:
    """Render at `size * ss` and downsample — the only antialiasing PIL offers."""
    px = size * ss
    img = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def u(v: float) -> float:
        """A fraction of the final size, in supersampled pixels."""
        return v * px

    # The plate: a rounded square, inset so it reads as an app icon rather than
    # a window.  Radius/margin are the usual macOS-ish proportions.
    margin = u(0.055)
    radius = u(0.225)
    box = (margin, margin, px - margin, px - margin)
    d.rounded_rectangle(box, radius=radius, fill=PLATE + (255,))

    # The plate's edge, the way the card draws one: a thin inset line, a touch
    # brighter along the top edge (a single stroke, half hidden, reads as light).
    line = max(1, round(u(0.0055)))
    d.rounded_rectangle(
        (box[0] + line / 2, box[1] + line / 2, box[2] - line / 2, box[3] - line / 2),
        radius=radius - line / 2,
        outline=PLATE_EDGE + (255,),
        width=line,
    )

    # The mark: node — rule — lit leg — rule — node, centred on the plate.
    cy = px / 2
    node_r = u(0.052)
    gap = u(0.104)          # from a node's centre to its nearest rule
    lit_half = u(0.060)     # half the lit leg
    rule_h = u(0.0115)
    lit_h = u(0.0195)

    cx = px / 2
    left_x = cx - u(0.207)
    right_x = cx + u(0.207)

    for x in (left_x, right_x):
        d.ellipse((x - node_r, cy - node_r, x + node_r, cy + node_r), fill=NODE + (255,))

    rule_start = left_x + gap
    rule_end = right_x - gap
    lit_from = cx - lit_half
    lit_to = cx + lit_half
    for x0, x1 in ((rule_start, lit_from), (lit_to, rule_end)):
        d.rounded_rectangle((x0, cy - rule_h / 2, x1, cy + rule_h / 2), radius=rule_h / 2, fill=RULE + (255,))
    d.rounded_rectangle((lit_from, cy - lit_h / 2, lit_to, cy + lit_h / 2), radius=lit_h / 2, fill=LIT + (255,))

    return img.resize((size, size), Image.LANCZOS)


def main() -> int:
    root = pathlib.Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default=str(root / "app" / "build" / "icon.png"))
    ap.add_argument("--size", type=int, default=1024)
    args = ap.parse_args()

    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    draw(args.size).save(out)
    print(f"{out}: {args.size}x{args.size}, {out.stat().st_size} bytes")
    print(f"  plate {PLATE}  edge {PLATE_EDGE}  node {NODE}  rule {RULE}  lit {LIT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
