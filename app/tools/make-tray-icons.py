#!/usr/bin/env python3
"""make-tray-icons.py — the tray icons, as this repository has always spelled it.

The three files this used to draw (and only those three) are now drawn by
`tools/make-icons.py`, from the same mark as the app icon: the tray is the window's
mark in its own colours, not a second drawing of "a link".  Kept as the path already
in people's shells and in the README; arguments pass through, so `--check` still works.

    python3 tools/make-tray-icons.py          # rewrite every icon file
    python3 tools/make-tray-icons.py --check  # non-zero if any of them is stale
"""
import pathlib
import runpy
import sys

TARGET = pathlib.Path(__file__).resolve().parent / 'make-icons.py'
sys.argv[0] = str(TARGET)
runpy.run_path(str(TARGET), run_name='__main__')
