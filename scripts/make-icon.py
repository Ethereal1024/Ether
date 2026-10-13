#!/usr/bin/env python3
"""make-icon.py — the app icon, as this repository has always spelled it.

The drawing moved to `app/tools/make-icons.py`, which is now the single definition of
the mark: the app icon, the 1024 master, the Linux size set, the window icon and the
tray icons are all renderings of it, so they cannot drift into four brands.  This file
stays as the path everyone already types, and forwards its arguments unchanged.

    python3 scripts/make-icon.py            # rewrite every icon file
    python3 scripts/make-icon.py --check    # non-zero if any of them is stale
"""
import pathlib
import runpy
import sys

TARGET = pathlib.Path(__file__).resolve().parent.parent / 'app' / 'tools' / 'make-icons.py'
sys.argv[0] = str(TARGET)
runpy.run_path(str(TARGET), run_name='__main__')
