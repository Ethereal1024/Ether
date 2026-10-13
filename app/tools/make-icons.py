#!/usr/bin/env python3
"""make-icons.py — one mark, every icon file Ether ships, all of them source.

The mark is the window's own footer: a device node and a PC node joined by one rule,
with the leg that is *carrying* drawn in the action colour.  It is defined here once —
as a handful of fractions of the canvas — and every icon the app has is a rendering of
it at one size, so the launcher, the taskbar, the tray and the title bar cannot drift
into four brands:

  build/icon.svg                 the vector master: the same geometry, editable, the
                                 file to reach for when the mark itself changes
  build/icon.png                 1024x1024, the master the packager reads — the .ico
                                 and the .icns are derived from it at package time
  build/icons/<N>x<N>.png        16…1024, the set a Linux desktop installs into
                                 hicolor/*/apps (electron-builder names this dir in
                                 `linux.icon`); one 1024 file only is not a set — a
                                 panel asking for 24 px then has nothing to draw
  resources/appicon.png          256x256, the window's icon: the taskbar and the
                                 alt-tab switcher, and in `npm run dev` the only icon
                                 there is (Electron's own mark otherwise)
  resources/tray.png             64x64, accent plate, ink mark — Linux and Windows
  resources/trayTemplate.png     16x16, black on transparent, macOS only: the menu bar
  resources/trayTemplate@2x.png  32x32, recolours a "template" image to the user's theme

Colours are the window's own (style.css §1), converted from its oklch tokens with the
Oklab definition rather than eyeballed, so an icon and the control it mirrors cannot
disagree.  The palette is locked; nothing is drawn outside it.

    python3 tools/make-icons.py            # writes every file above, from app/
    python3 tools/make-icons.py --check    # non-zero if any committed file is stale

Requires Pillow (and nothing else — this is a source generator, not a build step: the
PNGs it writes are committed, and no build or packaging path imports it).
"""
from __future__ import annotations

import io
import math
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:  # pragma: no cover - a host without Pillow is the normal case
    sys.exit("make-icons.py needs Pillow:  pip install --user pillow")


# ── the palette: style.css §1, in hex ────────────────────────────────────────
# Björn Ottosson's Oklab, then the sRGB transfer function.  Kept in full so the numbers
# below stay traceable to the CSS they came from — the icon is not allowed a colour the
# window does not have.
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


PLATE = _oklch_to_srgb(0.185, 0.0, 0)       # --bg
PLATE_EDGE = _oklch_to_srgb(0.315, 0.0, 0)  # --line
NODE = _oklch_to_srgb(0.96, 0.0, 0)         # --text
RULE = _oklch_to_srgb(0.72, 0.0, 0)         # --muted
LIT = _oklch_to_srgb(0.80, 0.10, 225)       # --accent
ACCENT = LIT
INK = _oklch_to_srgb(0.22, 0.045, 240)      # --accent-ink


def hexof(rgb: tuple[int, int, int]) -> str:
    return '#%02X%02X%02X' % rgb


# ── the mark: one construction system, in fractions of the canvas ────────────
# Every icon is this, at its own size.  Nothing is per-icon except the size and which
# colours play which part, so a change here is a change everywhere — which is the point.
PLATE_MARGIN = 0.055    # inset, so the plate reads as an app icon and not a window
PLATE_RADIUS = 0.225    # the squircle-ish corner the usual desktop icons use
PLATE_EDGE_W = 0.0055   # the plate's 1px inset line, the way the card draws one
NODE_R = 0.066          # a node: the tablet, and the PC
NODE_X = 0.235          # half the distance between the two nodes
RULE_W = 0.0145         # the quiet leg
LIT_W = 0.0255          # the leg that is carrying: brighter and thicker, a second cue
LIT_HALF = 0.075        # half its length
RULE_GAP = 1.45         # from a node's centre to the start of its rule, x node radius

# The detail budget.  At 16 px the same fractions would be a 0.23 px line — invisible —
# so the minimums below are what turn one construction system into a legible mark at
# every size: no node smaller than 4 px across, no leg thinner than a device pixel, the
# lit leg never shorter than its own width, and a quiet leg keeping at least a pixel of
# its own.  That is the *only* thing that differs between sizes.
#
# Every one of those widths is then rounded to an *even* number of device pixels.  The
# mark sits at the centre of the canvas, and at an even size that centre falls on a
# pixel boundary: a feature 3 px tall centred there is half-covered on its top and its
# bottom row and reaches the screen at half strength — which is how a 16 px icon ends up
# drawing its lit leg as a grey-blue smudge instead of as the accent — while one 2 or
# 4 px tall lands on whole rows and arrives at full strength.
MIN_NODE_D = 4.0    # across: the smallest a node can be drawn and still read as round
MIN_LINE = 1.0      # the floor before the snap below; a 1 px feature becomes 2
MIN_LIT_HALF = 2.0
MIN_RULE = 1.2


def _even(px: float) -> float:
    """A width in device pixels, rounded to the nearest even one, and never below two."""
    return 2.0 * max(1.0, float(round(px / 2.0)))


def geometry(size: float) -> dict[str, float]:
    """The mark at `size`, in *device* pixels — so the detail budget below is a promise
    about what the eye gets, not about how far the drawing was oversampled."""
    node_r = _even(max(NODE_R * size * 2, MIN_NODE_D)) / 2  # an even diameter, so it stays round
    rule_w = _even(max(RULE_W * size, MIN_LINE))
    lit_w = max(_even(max(LIT_W * size, MIN_LINE)), rule_w)  # carrying, never lighter
    lit_half = max(LIT_HALF * size, MIN_LIT_HALF, lit_w)
    # Where the quiet leg starts, measured from the canvas centre: normally a fixed
    # distance out from the node, and at small sizes at least MIN_RULE long.
    rule_from = max(NODE_X * size - RULE_GAP * node_r, lit_half + MIN_RULE)
    return {
        'size': size,
        'plate': PLATE_MARGIN * size,
        'radius': PLATE_RADIUS * size,
        'edge': max(PLATE_EDGE_W * size, MIN_LINE),
        'node_r': node_r,
        'node_x': NODE_X * size,
        'rule_w': rule_w,
        'lit_w': lit_w,
        'lit_half': lit_half,
        'rule_from': rule_from,
        'cx': size / 2,
        'cy': size / 2,
    }


def supersample(size: int) -> int:
    """Enough oversampling to hide the stair-steps, not so much that a 1024 is slow."""
    return 8 if size <= 128 else (4 if size <= 512 else 2)


def _shrink(img: Image.Image, size: int) -> Image.Image:
    """Down to `size`, alpha premultiplied and averaged over the whole oversampled tile.

    Two things have to be right here, and both are about averages:

      * premultiplied.  Resampling a straight RGBA image pulls every antialiased pixel
        towards the colour of the transparent pixels beside it — and those are black — so
        the edges of the mark come out fringed; a sharpening filter's negative lobes can
        even carry a pixel *past* its palette colour (the 128 px lit leg used to ship as
        #75D4F8, a colour the window does not have);
      * `BOX`, not `LANCZOS`.  The reduction is always by the whole integer factor the
        drawing was oversampled by, so a box average *is* the exact area coverage of the
        output pixel, and every feature the detail budget marks out lands at its full
        strength.  Lanczos averages over roughly three output pixels instead, which turns
        a 2 px leg into a smear of the plate around it.

    It is also why everything is drawn at the oversampled size and reduced exactly once
    here, instead of being reduced, composited and reduced again."""
    if img.size == (size, size):
        return img
    return img.convert('RGBa').resize((size, size), Image.BOX).convert('RGBA')


def _canvas(size: int) -> tuple[Image.Image, dict[str, float], int]:
    """A blank oversampled canvas plus the geometry, in the canvas's own pixels."""
    s = supersample(size)
    px = size * s
    g = {k: v * s for k, v in geometry(size).items()}  # device px -> the canvas drawn on
    return Image.new('RGBA', (px, px), (0, 0, 0, 0)), g, px


def _bbox(x0: float, y0: float, x1: float, y1: float) -> tuple[int, int, int, int]:
    """An exact half-open span on the canvas, as the inclusive box Pillow wants.

    Pillow fills a box's last row and column *inside* it, so a shape meant to span
    [x0, x1) has to be handed (x0, x1 - 1): without this the whole mark sits half a
    canvas pixel low, and its top row and its bottom row do not carry the same weight."""
    return (round(x0), round(y0), round(x1) - 1, round(y1) - 1)


def draw_mark(size: int, node_col, rule_col, lit_col) -> Image.Image:
    """node — rule — lit — rule — node, centred, on transparent.  Capsules throughout,
    so a node is a disc and both kinds of leg end in the same round cap."""
    img, g, _ = _canvas(size)
    _mark_on(img, g, node_col, rule_col, lit_col)
    return _shrink(img, size)


def _mark_on(img: Image.Image, g: dict[str, float], node_col, rule_col, lit_col) -> None:
    """The mark, drawn onto `img` at the canvas's own scale — no reduction here, so it
    can go straight onto a plate and be reduced once with it."""
    d = ImageDraw.Draw(img)

    cx, cy = g['cx'], g['cy']
    for x in (cx - g['node_x'], cx + g['node_x']):
        r = g['node_r']
        d.ellipse(_bbox(x - r, cy - r, x + r, cy + r), fill=node_col)

    def capsule(x0: float, x1: float, w: float, col) -> None:
        r = w / 2
        d.rounded_rectangle(_bbox(x0, cy - r, x1, cy + r), radius=r, fill=col)

    for x0, x1 in ((cx - g['rule_from'], cx - g['lit_half']), (cx + g['lit_half'], cx + g['rule_from'])):
        capsule(x0, x1, g['rule_w'], rule_col)
    capsule(cx - g['lit_half'], cx + g['lit_half'], g['lit_w'], lit_col)


def draw_plate(size: int, fill, edge_col=None, highlight=None) -> Image.Image:
    """A plate, at `size`.  Two surfaces, and each is the one the window draws for the
    same job: the app icon's plate is the *window* (`--bg` with a `--line` hairline on
    its edge, the way `.card` draws depth), and the tray's is the *button* (an accent
    plate with the lit top edge `.primary`'s inset box-shadow draws)."""
    img, g, px = _canvas(size)
    _plate_on(img, g, px, fill, edge_col=edge_col, highlight=highlight)
    return _shrink(img, size)


def _plate_on(img: Image.Image, g: dict[str, float], px: int, fill, edge_col=None, highlight=None) -> None:
    """The plate, drawn onto `img` at the canvas's own scale."""
    d = ImageDraw.Draw(img)

    m, radius = g['plate'], g['radius']
    d.rounded_rectangle(_bbox(m, m, px - m, px - m), radius=radius, fill=fill)

    if edge_col:
        line = max(1, round(g['edge']))
        # A single stroke, half hidden by the fill it sits on: it reads as light on the
        # plate's edge, which is how the card draws depth (an edge, never a shadow).
        d.rounded_rectangle(
            _bbox(m + line / 2, m + line / 2, px - m - line / 2, px - m - line / 2),
            radius=radius - line / 2,
            outline=edge_col + (255,),
            width=line,
        )

    if highlight:
        # One hairline of light on the plate's top edge — drawn on its own layer because
        # a translucent colour drawn straight onto the image would *replace* the plate's
        # pixels instead of lighting them.
        layer = Image.new('RGBA', (px, px), (0, 0, 0, 0))
        h = max(1, round(g['edge']))
        inset = m + radius * 0.35
        ImageDraw.Draw(layer).line(
            (inset, m + h / 2, px - inset, m + h / 2), fill=highlight, width=h
        )
        img.alpha_composite(layer)


def app_icon(size: int) -> Image.Image:
    """The plate, then the mark on it: the launcher, taskbar and alt-tab icon."""
    img, g, px = _canvas(size)
    _plate_on(img, g, px, PLATE + (255,), edge_col=PLATE_EDGE)
    _mark_on(img, g, NODE + (255,), RULE + (255,), LIT + (255,))
    return _shrink(img, size)


def tray_icon(size: int) -> Image.Image:
    """The accent plate with the same mark in ink: the one icon that is small and
    alive, and it is the app's own light rather than a second drawing."""
    img, g, px = _canvas(size)
    # oklch(1 0 0 / 0.35), the lit top edge a `.primary` button draws.
    _plate_on(img, g, px, ACCENT + (255,), highlight=(255, 255, 255, 89))
    _mark_on(img, g, INK + (255,), INK + (255,), INK + (255,))
    return _shrink(img, size)


def template_icon(size: int) -> Image.Image:
    """Black on transparent: macOS keeps only the alpha channel and repaints the shape
    to match the menu bar, so the colour here is a placeholder and the shape is not."""
    img, g, _ = _canvas(size)
    _mark_on(img, g, (0, 0, 0, 255), (0, 0, 0, 255), (0, 0, 0, 255))
    return _shrink(img, size)


# ── the vector master ────────────────────────────────────────────────────────
def svg(size: int = 1024) -> str:
    """The same geometry as text.  Raster is for packaging; this is the real drawing,
    and the one to open when the mark changes."""
    g = geometry(size)
    m, r = g['plate'], g['radius']
    e = g['edge']
    cx, cy = g['cx'], g['cy']
    node_x, node_r = g['node_x'], g['node_r']
    rule_from, lit_half = g['rule_from'], g['lit_half']
    n = lambda v: f'{v:.2f}'  # noqa: E731 - one formatter, used thirty times

    # Rounded legs are SVG rects with a radius of half their height, exactly as PIL
    # draws them, so the two renderings are the same picture and not two drawings.
    def leg(x0: float, x1: float, w: float, col: str) -> str:
        return (
            f'  <rect x="{n(x0)}" y="{n(cy - w / 2)}" width="{n(x1 - x0)}" height="{n(w)}"'
            f' rx="{n(w / 2)}" fill="{col}"/>'
        )

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}">',
        '  <!-- Ether\'s mark, drawn from app/tools/make-icons.py.  The palette is',
        '       style.css §1: plate = --bg, edge = --line, nodes = --text,',
        '       quiet legs = --muted, the carrying leg = --accent. -->',
        f'  <rect x="{n(m)}" y="{n(m)}" width="{n(size - 2 * m)}" height="{n(size - 2 * m)}"'
        f' rx="{n(r)}" fill="{hexof(PLATE)}"/>',
        f'  <rect x="{n(m + e / 2)}" y="{n(m + e / 2)}" width="{n(size - 2 * m - e)}"'
        f' height="{n(size - 2 * m - e)}" rx="{n(r - e / 2)}" fill="none"'
        f' stroke="{hexof(PLATE_EDGE)}" stroke-width="{n(e)}"/>',
        f'  <circle cx="{n(cx - node_x)}" cy="{n(cy)}" r="{n(node_r)}" fill="{hexof(NODE)}"/>',
        f'  <circle cx="{n(cx + node_x)}" cy="{n(cy)}" r="{n(node_r)}" fill="{hexof(NODE)}"/>',
        leg(cx - rule_from, cx - lit_half, g['rule_w'], hexof(RULE)),
        leg(cx + lit_half, cx + rule_from, g['rule_w'], hexof(RULE)),
        leg(cx - lit_half, cx + lit_half, g['lit_w'], hexof(LIT)),
        '</svg>',
    ]
    return '\n'.join(parts) + '\n'


# ── the files ────────────────────────────────────────────────────────────────
HERE = Path(__file__).resolve().parent          # app/tools
APP = HERE.parent                               # app
BUILD = APP / 'build'
RES = APP / 'resources'

# The sizes a Linux desktop asks for by name.  256 is what a taskbar or a dock draws
# at most; 512 and 1024 are there for the file manager and the alt-tab preview.
LINUX_SIZES = (16, 24, 32, 48, 64, 128, 256, 512, 1024)
WINDOW_ICON = 256


def png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format='PNG', optimize=True)
    return buf.getvalue()


def artefacts() -> dict[Path, bytes]:
    """Every committed icon file, regenerated in memory.  Byte-comparable, so `--check`
    is exact: a file that no longer matches the mark is a file to rewrite, not to argue
    about."""
    out: dict[Path, bytes] = {
        BUILD / 'icon.svg': svg().encode(),
        BUILD / 'icon.png': png_bytes(app_icon(1024)),
        RES / 'appicon.png': png_bytes(app_icon(WINDOW_ICON)),
        RES / 'tray.png': png_bytes(tray_icon(64)),
        RES / 'trayTemplate.png': png_bytes(template_icon(16)),
        RES / 'trayTemplate@2x.png': png_bytes(template_icon(32)),
    }
    for size in LINUX_SIZES:
        out[BUILD / 'icons' / f'{size}x{size}.png'] = png_bytes(app_icon(size))
    return out


def main(argv: list[str]) -> int:
    check = '--check' in argv
    style = ', '.join(
        f'{name} {hexof(col)}' for name, col in (('plate', PLATE), ('edge', PLATE_EDGE), ('node', NODE), ('rule', RULE), ('lit', LIT), ('ink', INK))
    )
    files = artefacts()
    stale: list[str] = []
    for path, want in files.items():
        have = path.read_bytes() if path.exists() else None
        rel = path.relative_to(APP)
        if check:
            if have != want:
                stale.append(str(rel))
            continue
        if have != want:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(want)
            print(f'wrote {rel} ({len(want)} bytes)')
        else:
            print(f'unchanged {rel}')
    if check and stale:
        print(f'stale icons: {", ".join(stale)} — run tools/make-icons.py')
        return 1
    if check:
        print(f'{len(files)} icon files match the mark')
    else:
        print(f'  mark: node — rule — lit — rule — node, at {len(LINUX_SIZES)} sizes')
        print(f'  palette: {style}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
