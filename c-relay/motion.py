#!/usr/bin/env python3
"""Put real motion on the host desktop so Sunshine's encoder has work to do.

A static desktop encodes to ~2 Mbps, which says nothing about how much of a
stream the wired link can actually carry.  This window covers the screen with
high-detail moving content (a scrolling bar + a bouncing ball + colour tiles),
which is the load generator used by the link measurements.

    python3 motion.py --seconds 25
"""
import math
import sys
import time
import tkinter as tk


def main() -> None:
    seconds = 20.0
    argv = sys.argv[1:]
    for i, arg in enumerate(argv):
        if arg == "--seconds" and i + 1 < len(argv):
            seconds = float(argv[i + 1])

    root = tk.Tk()
    root.attributes("-fullscreen", True)
    root.configure(cursor="none")
    w = root.winfo_screenwidth()
    h = root.winfo_screenheight()

    canvas = tk.Canvas(root, width=w, height=h, highlightthickness=0)
    canvas.pack()

    cols, rows = 8, 6
    tw, th = w // cols, h // rows
    for r in range(rows):
        for c in range(cols):
            colour = "#%06x" % ((r * cols + c) * 987654 % 0xFFFFFF)
            canvas.create_rectangle(
                c * tw, r * th, (c + 1) * tw, (r + 1) * th, fill=colour, outline=""
            )

    bar = canvas.create_rectangle(0, 0, 90, h, fill="#000000", outline="")
    ball = canvas.create_oval(0, 0, 260, 260, fill="#ffffff", outline="#ff0000", width=8)
    t0 = time.time()

    def step() -> None:
        t = time.time() - t0
        if t >= seconds:
            root.destroy()
            return
        x = int((t * 1400) % (w + 90))
        canvas.coords(bar, x, 0, x + 90, h)
        bx = int((t * 900) % (w - 260))
        by = int((h - 260) * (0.5 + 0.5 * math.sin(t * 2.0)))
        canvas.coords(ball, bx, by, bx + 260, by + 260)
        root.after(16, step)

    root.after(0, step)
    root.mainloop()
    print("motion: %.1fs of moving content" % seconds)


if __name__ == "__main__":
    main()
