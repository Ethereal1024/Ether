"""Print a coarse ASCII map of a PNG crop: mostly for reading a screenshot I cannot open.

usage: python3 _ascii_shot.py file.png [x y w h] [cols]
Light pixels are '.', mid '#', edges '+', dark ' '.
"""
import sys
from PIL import Image

path = sys.argv[1]
im = Image.open(path).convert('L')
if len(sys.argv) > 6:
    x, y, w, h = (int(v) for v in sys.argv[2:6])
    im = im.crop((x, y, x + w, y + h))
cols = int(sys.argv[6]) if len(sys.argv) > 6 else 110
W, H = im.size
rows = max(1, int(cols * H / W * 0.5))
px = im.resize((cols, rows), Image.BOX)
for j in range(rows):
    line = ''
    for i in range(cols):
        v = px.getpixel((i, j))
        line += ' ' if v < 25 else ('.' if v < 60 else ('-' if v < 110 else ('#' if v < 190 else '@')))
    print(f'{j:3d}|{line}')
print(f'{path}: {W}x{H} px shown as {cols}x{rows}')
