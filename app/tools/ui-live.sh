#!/bin/sh
# tools/ui-live.sh — launch the real app (real preload, real IPC, real renderer.js) and
# read what the window actually drew (tools/ui-live.mjs).
#
# The window gets its own profile, its own data dir and its own startup directory, like
# tools/ui-probe.sh: this is a second instance, and `reap.ts` kills whatever pid the real
# data dir records — with the real dir that is the developer's own window.  An empty data
# dir records nothing, so this run can only ever reap itself.  ETHER_AUTOSTART_DIR matters
# for the same reason: the last thing this run does is click the launch-at-login switch,
# and with the real value that entry would land in the developer's own session.  The only
# thing clicked is that pair of switches, and each is clicked back off.
set -u
cd "$(dirname "$0")/.." || exit 1   # app/

PORT=${LIVE_PORT:-9357}
PROBE_DIR=/tmp/ether-live.$$
DATA_DIR=/tmp/ether-live-data.$$
AT_DIR=/tmp/ether-live-autostart.$$
LOG=tools/_ui_live_app.log
: > "$LOG"
rm -rf "$PROBE_DIR" "$DATA_DIR" "$AT_DIR"
mkdir -p "$DATA_DIR" "$AT_DIR"

if ! npm run build > tools/_ui_live_build.log 2>&1; then
  echo "FAIL: build"; tail -5 tools/_ui_live_build.log; exit 1
fi

# --disable-gpu is this host's: its GPU process cannot start (error_code=1002) and
# newer Chromium escalates that to "GPU process isn't usable. Goodbye."
setsid nohup env ETHER_DATA_DIR="$DATA_DIR" ETHER_AUTOSTART_DIR="$AT_DIR" ./node_modules/.bin/electron --user-data-dir="$PROBE_DIR" --remote-debugging-port="$PORT" --disable-gpu . > "$LOG" 2>&1 &

i=0; wid=""; pid=""
while [ "$i" -lt 40 ]; do
  sleep 1; i=$((i + 1))
  for id in $(xwininfo -root -tree 2>/dev/null | grep '"Ether"' | awk '{print $1}'); do
    owner=$(xprop -id "$id" _NET_WM_PID 2>/dev/null | awk '{print $3}')
    if ps -o args= -p "$owner" 2>/dev/null | grep -q -F -- "--user-data-dir=$PROBE_DIR"; then
      wid=$id; pid=$owner; break
    fi
  done
  [ -n "$wid" ] && break
done
if [ -z "$wid" ]; then
  echo "FAIL: no Ether window after ${i}s"
  tail -8 "$LOG"
  rm -rf "$PROBE_DIR" "$DATA_DIR" "$AT_DIR"
  exit 1
fi
echo "window $wid (pid $pid) appeared after ${i}s"

node tools/ui-live.mjs "$PORT" "$DATA_DIR" "$AT_DIR" > tools/_ui_live_report.txt 2>&1
rc=$?
cat tools/_ui_live_report.txt
echo "--- app log lines that are not Chromium noise ---"
grep -vE "ERROR:|WARNING:|libva|GPU process|dbus|Fontconfig" "$LOG" | head -12

launcher=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
kill -TERM "$pid" 2>/dev/null && echo "kill -TERM $pid (window)"
sleep 3
[ -n "$launcher" ] && kill -TERM "$launcher" 2>/dev/null && echo "kill -TERM $launcher (launcher)"
sleep 1
rm -rf "$PROBE_DIR" "$DATA_DIR" "$AT_DIR"
echo "Ether windows left: $(xwininfo -root -tree 2>/dev/null | grep -c '"Ether"')"
echo "ui live rc=$rc"
exit "$rc"
