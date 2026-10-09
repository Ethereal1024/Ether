# Ether

One USB cable, one click: a wired channel between stock Sunshine (PC) and stock
Moonlight (tablet).  Sunshine and Moonlight are not patched — `adb` carries the
TCP channels (HTTPS/HTTP/WebUI/RTSP) and a small relay carries the UDP channels
(video/control/audio) by preserving datagram boundaries over TCP.

## Layout

```
app/        the Electron app — this is the product
  src/main/     main process: tunnel, relay, controller, reap, ports, platform
  src/renderer/ the single window (index.html, style.css, renderer.js)
  bin/cli.mjs   the headless CLI (`--up`, `--bench`, `--selftest`, …)
  test/         node:test suites, run against dist/
  tools/        dev harness: ui-probe (layout), ui-live (real bridge), PNG readers
  docs/         UI screenshots
  resources/    tablet ELF + NOTICE, copied to resourcesPath when packaged
c-relay/    the C relay and its bench scripts
  udp2tcp.c     the relay itself (host + device roles)
  udp2tcp       host build, used by the CLI and the interop suite
  udp2tcp.aarch64   device build pushed to /data/local/tmp
  build.sh      rebuild both, then self-test
  wired-moonlight.sh  wire/verify/bench a session over the cable
  motion.py     moving-content load generator for encoder benches
scripts/    release helpers: run-tests.sh, release.sh, make-icon.py (-> build/icon.png)
.github/    workflows: ci.yml (push/PR tests), release.yml (tag -> three installers)
LICENSE     MIT
*.clc       local session logs — kept, never committed (see .gitignore)
```

## Build and verify

```sh
cd app
npm install            # once
npx tsc --noEmit       # type check
npm run build          # tsc -> dist/
npm test               # node --test dist/test/*.test.js  (builds first)
npm run selftest       # bin/cli.mjs --selftest
npm run dev            # build + launch the window
npm run dist           # electron-builder -> app/release/
```

The C relay must exist before the interop suite runs, or those cases silently
skip:

```sh
cd c-relay && ./build.sh          # host + device + self-test
cd c-relay && ./build.sh --host   # host binary only
```

`app/tools/` holds the UI harness.  Both scripts launch their own Electron
instance with a throwaway profile and data dir (never the developer's window)
and print a pass/fail report:

```sh
cd app
sh tools/ui-probe.sh   # layout, fake bridge  -> tools/_ui_report.txt
sh tools/ui-live.sh    # real preload/IPC     -> tools/_ui_live_report.txt
python3 tools/ascii-shot.py <png> [x y w h] [cols]   # read a shot as text
```

## Releases

`.github/workflows/release.yml` fires on a `vX.Y.Z` tag push and attaches three
unsigned installers to the GitHub release for that tag:

| artifact | platform | built on |
| --- | --- | --- |
| `Ether-*.AppImage`, `ether_*_amd64.deb` | Linux x86_64 | `ubuntu-latest` |
| `Ether-*-arm64.dmg` | macOS arm64 | `macos-latest` |
| `Ether Setup *.exe` | Windows x64 (NSIS) | `windows-latest` |

Three runners because electron-builder cannot cross-build two of them. A `verify`
job runs first on Linux: it refuses a tag that disagrees with
`app/package.json`'s `version`, checks the icon and the tablet ELF are really
there, and runs `scripts/run-tests.sh` (which insists on *zero skips*, so a run
that quietly stopped building the C relay cannot pass). The first job to attach a
file creates the release, which is why the other two `needs` it.

All three platforms are **unsigned** — there is no Developer ID and no
Authenticode certificate here:

- **macOS**: Gatekeeper blocks the first launch. On macOS 15+ the right-click →
  Open bypass is gone and the dialog misreports the app as "damaged"; clear it
  once with `xattr -cr /Applications/Ether.app`.
- **Windows**: SmartScreen warns ("Windows protected your PC" → More info → Run
  anyway). The installer never asks for admin — `perMachine: false` and
  `allowElevation: false` are pinned in `app/electron-builder.yml`.
- **Linux**: nothing to bypass. `dpkg -i` the deb, or `chmod +x` the AppImage.

### Cutting a release

```sh
# 1) bump the version, commit it
$EDITOR app/package.json          # "version": "0.2.0"
git commit -am "chore(release): 0.2.0"
git push origin main

# 2) tag that exact commit and push the tag — this is what starts the workflow
git tag v0.2.0
git push origin v0.2.0
```

The tag and `app/package.json`'s version must be the same string (minus the `v`),
or the `verify` job fails before anything is built. To build for your own machine
instead of publishing, use the local path:

```sh
bash scripts/release.sh          # this host's platform
bash scripts/release.sh linux    # AppImage + deb
bash scripts/release.sh mac      # dmg
bash scripts/release.sh win      # NSIS installer
```

It writes `app/release/` and passes `--publish never`, so it can never touch the
GitHub release. `.github/workflows/ci.yml` runs the same suite on Linux, macOS and
Windows for every push to `main` and every pull request; only the Linux row
demands zero skips (macOS has no `/proc/<pid>/cmdline`, and Windows has neither
that nor a POSIX `sh`).
