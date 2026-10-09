#!/usr/bin/env bash
# Build an Ether release for this host.
#
#   bash scripts/release.sh            # this host's platform
#   bash scripts/release.sh linux      # AppImage + deb      (must run on Linux)
#   bash scripts/release.sh mac        # dmg                 (must run on macOS)
#   bash scripts/release.sh win        # NSIS installer      (must run on Windows)
#
# electron-builder has no cross-compiler for two of these: the dmg wants a Mac
# (its tooling is macOS-only) and the NSIS installer is happiest built on
# Windows. That is why the released artifacts for all three platforms come from
# .github/workflows/release.yml and this script exists for the local case —
# your own machine, your own arch.
#
# --publish never: a local build must never touch the GitHub release.  Publishing
# is the tag push's job (the workflow passes files to softprops/action-gh-release).
#
# All three platforms are UNSIGNED (there is no Developer ID / Authenticode
# certificate in this project):
#   macOS : Gatekeeper blocks the first launch — on macOS 15+ the right-click ->
#           Open bypass is gone and the notice misreports as "damaged".  Clear it
#           once:  xattr -cr /Applications/Ether.app
#   win   : SmartScreen warns on the first run: "Windows protected your PC" ->
#           More info -> Run anyway.
#   linux : nothing to bypass; the deb installs and the AppImage runs.
#
# Env overrides, same defaults as CI:
#   ELECTRON_MIRROR, ELECTRON_BUILDER_BINARIES_MIRROR  (npmmirror; set them to
#   the GitHub upstreams or your own mirror if you have one)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PLATFORM="${1:-}"
if [ -z "$PLATFORM" ]; then
  case "$(uname -s)" in
    Linux) PLATFORM=linux ;;
    Darwin) PLATFORM=mac ;;
    MINGW*|MSYS*|CYGWIN*) PLATFORM=win ;;
    *) echo "FATAL: unknown host $(uname -s); pass linux|mac|win" >&2; exit 1 ;;
  esac
fi

case "$PLATFORM" in
  linux)
    [ "$(uname -s)" = "Linux" ] || { echo "FATAL: the Linux build (fpm for the deb, appimage tooling) must run on Linux." >&2; exit 1; }
    DIST=dist:linux ;;
  mac)
    [ "$(uname -s)" = "Darwin" ] || { echo "FATAL: a dmg must be built on macOS — electron-builder cannot cross-build one." >&2; exit 1; }
    DIST=dist:mac ;;
  win)
    case "$(uname -s)" in
      MINGW*|MSYS*|CYGWIN*) ;;
      *) echo "FATAL: the NSIS installer must be built on Windows (or in the CI job that runs there)." >&2; exit 1 ;;
    esac
    DIST=dist:win ;;
  *) echo "FATAL: unknown platform '$PLATFORM' (linux|mac|win)" >&2; exit 1 ;;
esac

VERSION="$(node -p "require('$ROOT/app/package.json').version")"
echo "==> Ether ${VERSION} -> ${PLATFORM} (unsigned)"

[ -d app/node_modules ] || { echo "FATAL: app/node_modules is missing — run: cd app && npm install" >&2; exit 1; }

cd app
ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}" \
ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}" \
  npm run "$DIST"

echo "==> artifacts in app/release/:"
ls -lh "$ROOT/app/release" | sed 1d
