#!/bin/sh
# fake-adb.sh — a stand-in for a real adb, so the §3.4 negative acceptance cases
# can be tested with no tablet attached (§13.9 "M0 negative case").
#
# It answers exactly the subcommands the app uses, and the answers are chosen by
# $FAKE_ADB_MODE:
#   ok | none | unauthorized | offline | noperm | conflict
#
# Four optional variables cover the parts of the device contract that only show
# up once the tunnel is actually being raised (used by test/tunnel.test.ts):
#   FAKE_ADB_SWEEP=empty|busy|fail   what `for f in …; cat /proc/net/$f` answers
#   FAKE_ADB_PID=<n>                 the pid a `nohup … & echo $!` reports back
#   FAKE_ADB_BENCH=<line>            what the tablet-side `--bench` prints
#   FAKE_ADB_PS=<text>              what the reap sweep's `ps -A` prints
#   FAKE_ADB_SMOKE_FLAKE=<n>         answer TEST FAIL (exit 1) to the first n smoke runs
#   FAKE_ADB_SMOKE_FILE=<file>       where that counter lives
#   FAKE_ADB_LOG=<file>              append every command line, for assertions
#
# FAKE_ADB_FULL=1 turns the stub into a *working* device minus the silicon — the
# `--test` smoke passes, the toybox-nc HTTP proof answers and `reverse` is kept in
# a ledger (FAKE_ADB_STATE=<file>) so §13.9's "7 entries" can be counted.  That is
# how the acceptance driver itself is rehearsed with no tablet on the bus.
#
# Deliberately /bin/sh: the app must work on a machine where bash is not installed
# (§13.5), and the test fixture should not be the first thing to break that rule.

mode="${FAKE_ADB_MODE:-ok}"
full="${FAKE_ADB_FULL:-}"
ledger="${FAKE_ADB_STATE:-}"

if [ -n "${FAKE_ADB_LOG:-}" ]; then
  printf '%s\n' "$*" >> "$FAKE_ADB_LOG"
fi

# A mismatched adb server is exactly how the real thing behaves: the client still
# runs, but every command prints this line on stderr (§3.2, §3.4).
if [ "$mode" = "conflict" ]; then
  echo "adb server version (36) doesn't match this client (41); killing..." >&2
fi

case "$1" in
  version)
    cat <<'EOF'
Android Debug Bridge version 1.0.41
Version 37.0.1-15733141
Installed as /fake/platform-tools/adb
EOF
    exit 0
    ;;
  devices)
    echo "List of devices attached"
    case "$mode" in
      none) ;;
      unauthorized) printf 'HA2HS0KT\tunauthorized\n' ;;
      offline) printf 'HA2HS0KT\toffline\n' ;;
      noperm) printf 'HA2HS0KT\tno permissions (user in plugdev group; are your udev rules wrong?)\n' ;;
      *) printf 'HA2HS0KT\tdevice product:TB375FC model:TB375FC device:TB375FC transport_id:2\n' ;;
    esac
    exit 0
    ;;
  shell)
    shift
    case "$*" in
      *"pm list packages"*) echo "package:com.limelight" ;;
      *"ro.product.cpu.abi"*) echo "arm64-v8a" ;;
      *"/proc/net/"*)
        # §3.3: ask the tablet which ports it already holds before handing one out.
        case "${FAKE_ADB_SWEEP:-empty}" in
          busy)
            printf '@@udp\n   0: 0100007F:1F90 00000000:0000 07 00000000:00000000 00:00000000 00000000  1000 0 1 2 0 0\n   1: 00000000:BB9E 00000000:0000 07 00000000:00000000 00:00000000 00000000  1000 0 1 2 0 0\n'
            printf '@@udp6\n   0: 00000000000000000000000000000000:1F91 00000000000000000000000000000000:0000 07 00000000:00000000 00:00000000 00000000  1000 0 1 2 0 0\n'
            printf '@@tcp\n   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 1 1 0 0\n'
            printf '@@tcp6\n   0: 00000000000000000000000000000000:BB9F 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 1 1 0 0\n'
            ;;
          fail)
            echo "cat: /proc/net/udp: Permission denied" >&2
            exit 1
            ;;
          *)
            # Readable, and genuinely empty: this ROM simply has nothing bound.
            printf '@@udp\n@@udp6\n@@tcp\n@@tcp6\n'
            ;;
        esac
        ;;
      *nohup*) echo "${FAKE_ADB_PID:-4242}" ;;
      *"kill -0"*) echo yes ;;
      *"ps -A"*)
        # The reap sweep's process-table answer.  A live tunnel's relay and a
        # stray have the same cmdline shape, so this is how a test can prove the
        # probe's own teardown does not take the tunnel's relays with it.
        [ -n "${FAKE_ADB_PS:-}" ] && printf '%s\n' "$FAKE_ADB_PS"
        ;;
      *"--bench"*) [ -n "${FAKE_ADB_BENCH:-}" ] && echo "$FAKE_ADB_BENCH" ;;
      *"--test"*)
        # FAKE_ADB_SMOKE_FLAKE=<n>: the first n smoke runs answer TEST FAIL and
        # exit non-zero — the transient a real tablet showed once under load, and
        # the only way to drive tunnel.ts's retry from a test.  TEST FAIL goes to
        # stdout, exactly where the real ELF prints it; a noexec failure is what
        # puts text on stderr instead.  The counter lives in FAKE_ADB_SMOKE_FILE.
        if [ -n "$full" ]; then
          flake="${FAKE_ADB_SMOKE_FLAKE:-0}"
          if [ "$flake" -gt 0 ] 2>/dev/null; then
            f="${FAKE_ADB_SMOKE_FILE:-/tmp/fake-adb-smoke.count}"
            c=$(cat "$f" 2>/dev/null || echo 0)
            c=$((c + 1))
            printf '%s\n' "$c" > "$f"
            if [ "$c" -le "$flake" ]; then
              echo "TEST FAIL"
              exit 1
            fi
          fi
          echo "TEST PASS"
        fi
        ;;
      *"toybox nc"*) [ -n "$full" ] && echo "HTTP/1.1 200 OK" ;;
      *"/proc/"*cmdline*) [ -n "$full" ] && echo "/data/local/tmp/udp2tcp --device --udp-listen 127.0.0.1:47998 " ;;
    esac
    exit 0
    ;;
  reverse)
    shift
    case "$1" in
      --list)
        if [ -n "$ledger" ] && [ -f "$ledger" ]; then
          while read -r p; do
            [ -n "$p" ] && echo "UsbFfs tcp:$p tcp:$p"
          done < "$ledger"
        fi
        ;;
      --remove)
        if [ -n "$ledger" ] && [ -f "$ledger" ]; then
          grep -v -x -- "${2#tcp:}" "$ledger" > "$ledger.tmp" 2>/dev/null
          mv "$ledger.tmp" "$ledger"
        fi
        ;;
      *)
        [ -n "$ledger" ] && printf '%s\n' "${1#tcp:}" >> "$ledger"
        ;;
    esac
    exit 0
    ;;
  push|pull|kill-server|start-server|wait-for-device|get-state)
    # `reverse --list` prints nothing while the tunnel is down, which is the
    # state every one of these tests starts from.
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
