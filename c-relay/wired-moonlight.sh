#!/bin/sh
# wired-moonlight.sh - run a stock Sunshine <-> stock Moonlight session over the
# adb USB link instead of Wi-Fi.
#
#   ./wired-moonlight.sh up      wire the link up (TCP forwards + UDP bridges)
#   ./wired-moonlight.sh down    tear everything down
#   ./wired-moonlight.sh status  show what is running
#   ./wired-moonlight.sh verify  prove both channel types reach Sunshine
#   ./wired-moonlight.sh bench   measure the wired round-trip goodput in Mbps
#
# Env: DEV=<adb serial>  ADB=<adb path>  BENCH_SECONDS=10  WINDOW=1024
#
# Nothing in Sunshine or Moonlight is patched: adb carries the TCP channels
# (HTTPS/HTTP/WebUI/RTSP) natively, and udp2tcp carries the UDP channels
# (video/control/audio) by preserving datagram boundaries over TCP.
#
# In Moonlight, add a PC at 127.0.0.1 (or "127.0.0.1:47989").
set -e
DIR=$(cd "$(dirname "$0")" && pwd)
RUN="$DIR/_run"
ADB=${ADB:-adb}
[ -n "$DEV" ] && ADB="$ADB -s $DEV"
BIN_HOST="$DIR/udp2tcp"
BIN_DEV="$DIR/udp2tcp.aarch64"
DEV_TMP=/data/local/tmp/udp2tcp

TCP_PORTS="47984 47989 47990 48010"          # HTTPS, HTTP, WebUI, RTSP
UDP_PORTS="47998 47999 48000"                # video, control, audio  (+48001 mic, off by default)
TUN_BASE=27498                               # tunnel TCP ports: 47998 -> 27498, etc.
BENCH_UDP=47800
BENCH_TUN=27300
STATS=${STATS:---stats}

adbs() { $ADB shell "$@"; }
tun_port() { echo $((TUN_BASE + $1 - 47998)); }

need_device() {
  if ! $ADB get-state >/dev/null 2>&1; then
    echo "!! no adb device. plug in USB and accept the 'Allow USB debugging' prompt."
    echo "   (if it says 'unauthorized', look at the tablet screen)"
    exit 1
  fi
}

# Reap the dedicated-bench relays.  A bench forks three helpers with nohup, so
# they survive an aborted run (harness timeout, Ctrl-C, a failed step under
# `set -e`) -- and the next run's `rm` of the pid files would then lose track of
# them for good.  Hence three layers, cheapest first:
#   1. the pids this run captured in $BENCH_PIDS (still valid even if the pid
#      files were already unlinked),
#   2. the pid files on disk (covers a previous run), device side included,
#   3. an ss sweep of the two bench ports, requiring the holder to actually be
#      named udp2tcp, so a leaked pair with no pid file at all is still found.
bench_reap() {
  for p in ${BENCH_PIDS:-}; do
    [ -n "$p" ] && kill "$p" 2>/dev/null || true
  done
  BENCH_PIDS=
  for f in "$RUN"/bench.*.pid; do
    [ -f "$f" ] || continue
    p=$(cat "$f" 2>/dev/null) || p=
    case "$f" in
      */bench.dev.pid) [ -n "$p" ] && adbs "kill $p 2>/dev/null" >/dev/null 2>&1 || true ;;
      *)               [ -n "$p" ] && kill "$p" 2>/dev/null || true ;;
    esac
    rm -f "$f"
  done
  if command -v ss >/dev/null 2>&1; then
    for p in $( { ss -lptnH "sport = :$BENCH_TUN"; ss -lpunH "sport = :$BENCH_UDP"; } 2>/dev/null \
                  | sed -n 's/.*(("udp2tcp",pid=\([0-9][0-9]*\).*/\1/p' ); do
      kill "$p" 2>/dev/null || true
    done
  fi
  # A SIGKILLed bench also leaves the host-side `adb shell ... --bench` client
  # alive, which keeps the device-side traffic generator running until its
  # --seconds expire -- and that traffic would pollute the next measurement.
  # Killing the device process makes the orphaned adb client return by itself.
  # The [u] trick keeps this command from matching its own pattern under pgrep -f.
  adbs "pgrep -f '[u]dp2tcp --bench' 2>/dev/null | while read x; do kill \$x 2>/dev/null; done" \
    >/dev/null 2>&1 || true
  $ADB reverse --remove "tcp:$BENCH_TUN" >/dev/null 2>&1 || true
}

cmd_up() {
  need_device
  mkdir -p "$RUN"
  [ -x "$BIN_HOST" ] || { echo "!! run ./build.sh first"; exit 1; }
  [ -x "$BIN_DEV" ]  || { echo "!! run ./build.sh first"; exit 1; }

  # clean slate: a previous run may have left relays and forwards behind
  cmd_down >/dev/null 2>&1 || true

  echo "== pushing device helper =="
  $ADB push "$BIN_DEV" "$DEV_TMP" >/dev/null
  adbs "chmod 755 $DEV_TMP"

  echo "== TCP channels: adb reverse (no code needed) =="
  for p in $TCP_PORTS; do
    $ADB reverse "tcp:$p" "tcp:$p"
    echo "   adb reverse tcp:$p -> host tcp:$p"
  done

  echo "== UDP channels: udp2tcp bridge =="
  for p in $UDP_PORTS; do
    t=$(tun_port "$p")
    # host side: TCP listener (fed by adb reverse) -> UDP to Sunshine
    nohup "$BIN_HOST" --host --tcp-listen "127.0.0.1:$t" --udp-connect "127.0.0.1:$p" $STATS \
      > "$RUN/host.$p.log" 2>&1 < /dev/null &
    echo $! > "$RUN/host.$p.pid"
    $ADB reverse "tcp:$t" "tcp:$t"
    # device side: UDP listener on the tablet -> TCP into the adb reverse port
    pid=$(adbs "nohup $DEV_TMP --device --udp-listen 127.0.0.1:$p --tcp-connect 127.0.0.1:$t \
      >/dev/null 2>&1 </dev/null & echo \$!")
    echo "$pid" > "$RUN/dev.$p.pid"
    echo "   udp 127.0.0.1:$p (tablet) <-> adb tcp:$t <-> udp 127.0.0.1:$p (Sunshine)"
  done
  echo
  echo "ready. In Moonlight add a PC at 127.0.0.1 -- then pair as usual."
  echo "logs: $RUN/host.*.log"
}

cmd_down() {
  echo "== stopping host relays =="
  for f in "$RUN"/host.*.pid; do
    [ -f "$f" ] || continue
    kill "$(cat "$f")" 2>/dev/null || true
    rm -f "$f"
  done
  for f in "$RUN"/dev.*.pid; do
    [ -f "$f" ] || continue
    adbs "kill $(cat "$f") 2>/dev/null" >/dev/null 2>&1 || true
    rm -f "$f"
  done
  # bench relays outlive an aborted bench, and their pid files may be gone too
  bench_reap
  echo "== removing adb forwards =="
  for p in $TCP_PORTS; do $ADB reverse --remove "tcp:$p" >/dev/null 2>&1 || true; done
  for p in $UDP_PORTS; do $ADB reverse --remove "tcp:$(tun_port "$p")" >/dev/null 2>&1 || true; done
  $ADB reverse --remove "tcp:$BENCH_TUN" >/dev/null 2>&1 || true
  echo "done."
}

cmd_status() {
  need_device
  echo "-- adb reverse --"; $ADB reverse --list || true
  echo "-- host relays --"
  seen=0
  for f in "$RUN"/host.*.pid; do
    [ -f "$f" ] || continue
    seen=1
    p=$(cat "$f")
    if kill -0 "$p" 2>/dev/null; then echo "   pid $p alive ($(basename "$f" .pid))"; else echo "   pid $p DEAD"; fi
  done
  [ "$seen" = 0 ] && echo "   (none)"
  echo "-- device relays --"
  adbs "pidof udp2tcp 2>/dev/null || echo '   (none)'"
  echo "-- host udp2tcp processes (leak check) --"
  if command -v pgrep >/dev/null 2>&1; then
    # $2 is the program path: that drops the caller's own `sh -c ...` wrapper,
    # whose command line merely mentions udp2tcp.
    out=$(pgrep -af "[u]dp2tcp" | awk '$2 ~ /udp2tcp$/ {print}' || true)
    if [ -n "$out" ]; then echo "$out" | sed 's/^/   /'; else echo "   (none)"; fi
  fi
  echo "-- bench ports udp/$BENCH_UDP tcp/$BENCH_TUN --"
  if command -v ss >/dev/null 2>&1; then
    out=$( { ss -lptnH "sport = :$BENCH_TUN"; ss -lpunH "sport = :$BENCH_UDP"; } 2>/dev/null || true )
    if [ -n "$out" ]; then echo "$out" | sed 's/^/   /'; else echo "   free"; fi
  fi
}

cmd_bench() {
  need_device
  mkdir -p "$RUN"
  bench_reap                                  # clean slate: also kills leaks with no pid file
  echo "== wiring a dedicated bench pair (udp $BENCH_UDP) =="
  $ADB push "$BIN_DEV" "$DEV_TMP" >/dev/null
  adbs "chmod 755 $DEV_TMP"
  nohup "$BIN_HOST" --echo "127.0.0.1:$BENCH_UDP" > "$RUN/bench.echo.log" 2>&1 < /dev/null &
  BENCH_ECHO_PID=$!
  echo "$BENCH_ECHO_PID" > "$RUN/bench.echo.pid"
  nohup "$BIN_HOST" --host --tcp-listen "127.0.0.1:$BENCH_TUN" --udp-connect "127.0.0.1:$BENCH_UDP" \
    > "$RUN/bench.host.log" 2>&1 < /dev/null &
  BENCH_HOST_PID=$!
  echo "$BENCH_HOST_PID" > "$RUN/bench.host.pid"
  BENCH_PIDS="$BENCH_ECHO_PID $BENCH_HOST_PID"
  # nohup'd helpers ignore SIGHUP, so an outside kill of this script would leave
  # them running; catch anything we can (a hard SIGKILL is covered by the pid
  # files + the ss sweep the next time bench/down runs).
  trap 'bench_reap' EXIT INT TERM HUP
  $ADB reverse "tcp:$BENCH_TUN" "tcp:$BENCH_TUN"
  sleep 0.5
  pid=$(adbs "nohup $DEV_TMP --device --udp-listen 127.0.0.1:$BENCH_UDP --tcp-connect 127.0.0.1:$BENCH_TUN \
    >/dev/null 2>&1 </dev/null & echo \$!")
  echo "$pid" > "$RUN/bench.dev.pid"
  sleep 0.5
  echo "== measuring (windowed so nothing is dropped on purpose) =="
  rc=0
  adbs "$DEV_TMP --bench 127.0.0.1:$BENCH_UDP --seconds ${BENCH_SECONDS:-10} --window ${WINDOW:-1024}" || rc=$?
  echo "== cleanup =="
  bench_reap
  trap - EXIT INT TERM HUP
  return $rc
}

# Prove the two channel types reach Sunshine: TCP with a plain HTTP GET from the
# tablet (no helper involved), UDP with a round trip through a bridged channel.
cmd_verify() {
  need_device
  mkdir -p "$RUN"
  echo "== 1/2 TCP: HTTP 47989, tablet -> adb reverse -> Sunshine =="
  # NB: stdin is kept open for a moment on purpose.  Plain `nc` closes its write
  # side the instant the pipe ends, and adb tears the whole connection down
  # before Sunshine's reply gets back -- that half-close race is not a bug in
  # the forward, so the probe has to mimic a real client that stays connected.
  out=$(adbs '(printf "GET / HTTP/1.0\r\n\r\n"; sleep 2) | toybox nc -w 4 127.0.0.1 47989' 2>/dev/null) || true
  case "$out" in
    HTTP/*) echo "   OK   Sunshine answered: $(printf '%s' "$out" | head -n 1)" ;;
    *)      echo "   FAIL no reply -- run '$0 up' first, and check Sunshine is running" ;;
  esac
  echo "== 2/2 UDP: video-port round trip through the udp2tcp bridge =="
  cmd_bench
}

case "${1:-}" in
  up)     cmd_up ;;
  down)   cmd_down ;;
  status) cmd_status ;;
  verify) cmd_verify ;;
  bench)  cmd_bench ;;
  *) echo "usage: $0 {up|down|status|verify|bench}"; exit 2 ;;
esac
