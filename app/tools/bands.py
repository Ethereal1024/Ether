"""Text bands in a column of a shot: which CSS-px rows actually carry ink.

usage: python3 _bands.py file.png [x0 x1] [bg-colour]

For each CSS row, count pixels that differ from the row's own dominant colour by
more than a hair.  Rows are grouped into bands and printed with the ink height, so I
can see where the content sits and how big the gaps between blocks really are.
"""
import sys
from collections import Counter

from PIL import Image

path = sys.argv[1]
im = Image.open(path).convert('RGB')
x0 = int(sys.argv[2]) if len(sys.argv) > 2 else 60
x1 = int(sys.argv[3]) if len(sys.argv) > 3 else 1060
scale = im.size[0] / 560

rows = []
for dy in range(im.size[1]):
    px = [im.getpixel((x, dy)) for x in range(x0, x1)]
    bg, n = Counter(px).most_common(1)[0]
    ink = sum(1 for p in px if max(abs(p[i] - bg[i]) for i in range(3)) > 24)
    rows.append((dy / scale, ink / len(px), bg))

bands = []
for y, share, bg in rows:
    if share > 0.004:
        if bands and bands[-1][2] >= y - 1.01:
            bands[-1][2] = y
            bands[-1][3] = max(bands[-1][3], share)
            bands[-1][4] = bg
        else:
            bands.append([y, y, y, share, bg])
    elif bands:
        continue

print(f'{path}: {im.size[0]}x{im.size[1]} device px, x {x0}..{x1} (CSS {x0/scale:.0f}..{x1/scale:.0f})')
prev_end = None
for a, _b, c, share, bg in bands:
    gap = '' if prev_end is None else f'   gap above {a - prev_end:.1f}'
    print(f'{a:7.1f}..{c:<7.1f} h={c - a + 0.5:5.1f} ink {share*100:4.1f}% bg {bg}{gap}')
    prev_end = c + 0.5
