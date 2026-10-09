#!/bin/sh
# tools/ui-probe.sh — launch the window and check the layout in the real engine
# (tools/ui-probe.mjs), then capture the twelve states.
#
# The fake-bridge probe answers layout questions only ("is anything outside the 560px
# column", "do the rails stay put", "is the button on the bottom edge") — nothing that
# needs the cable.  It draws its states through a stand-in for the preload bridge and
# never touches the main process, adb, or a tablet.  For a run against the real bridge
# use tools/ui-live.sh.
#
# The window is launched with its own profile and found by pid (_NET_WM_PID), so it
# cannot click through someone else's window.  Cleanup is by explicit pid (never a
# broad pkill).
set -u
cd "$(dirname "$0")/.." || exit 1   # app/

PORT=${UI_PORT:-9356}
SHOT_DIR=${SHOT_DIR:-tools/_ui_shots}
PROBE_DIR=/tmp/ether-ui.$$
# The app's own state dir, also thrown away at the end.  This script starts a *second*
# instance, and `reap.ts` kills whatever pid the state file records — with the real data
# dir that is the developer's own `npm run dev` window.  An empty data dir records
# nothing, so this run can only ever reap itself (platform.ts honours the override).
DATA_DIR=/tmp/ether-ui-data.$$
# The same reasoning for the startup entry: this probe only draws the switches, but the
# window it draws them in is a real app whose launch-at-login truth is read from the OS —
# pinned here so a stray click can never touch the developer's own session.
AT_DIR=/tmp/ether-ui-autostart.$$
LOG=tools/_ui_app.log
: > "$LOG"
rm -rf "$PROBE_DIR" "$DATA_DIR" "$AT_DIR" "$SHOT_DIR"
mkdir -p "$SHOT_DIR" "$DATA_DIR" "$AT_DIR"

if ! npm run build > tools/_ui_build.log 2>&1; then
  echo "FAIL: build"; tail -5 tools/_ui_build.log; exit 1
fi

# --disable-gpu is for this host only: its GPU process cannot start (error_code=1002)
# and newer Chromium escalates that to "GPU process isn't usable. Goodbye."; the layout
# and the computed styles do not care how the pixels are produced.
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
xwininfo -id "$wid" 2>/dev/null | sed -n '1,12p'

node tools/ui-probe.mjs "$PORT" "$SHOT_DIR" > tools/_ui_report.txt 2>&1
rc=$?

cat tools/_ui_report.txt
echo "--- app log lines that are not Chromium noise ---"
grep -vE "ERROR:|WARNING:|libva|GPU process|dbus|Fontconfig" "$LOG" | head -12

# cleanup: only the window this run launched, by pid
launcher=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
kill -TERM "$pid" 2>/dev/null && echo "kill -TERM $pid (window)"
sleep 3
[ -n "$launcher" ] && kill -TERM "$launcher" 2>/dev/null && echo "kill -TERM $launcher (launcher)"
sleep 1
rm -rf "$PROBE_DIR" "$DATA_DIR" "$AT_DIR"
echo "Ether windows left: $(xwininfo -root -tree 2>/dev/null | grep -c '"Ether"')"
echo "shots: $(ls "$SHOT_DIR" 2>/dev/null | tr '\n' ' ')"
echo "ui probe rc=$rc"
exit "$rc"
