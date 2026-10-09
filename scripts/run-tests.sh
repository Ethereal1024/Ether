#!/usr/bin/env bash
# Run Ether's whole suite the way a release runs it, and refuse to call a suite
# with skips a pass.
#
# Why the C relay matters here: three interop cases in test/interop.test.ts run
# the frozen wire format against the C implementation, and they are declared
# `{ skip }` when c-relay/udp2tcp is not built.  A checkout that forgot to build
# it therefore reports a *green* run of a suite that quietly stopped proving the
# one thing the two implementations must agree on.  This script builds the relay
# first (gcc/cc is all it needs) and then asserts both counters.
#
# On Windows there is no POSIX C relay to build, so the interop cases and the
# `posixOnly` cases are *expected* to skip there; the CI matrix passes
# ALLOW_SKIPS=1 for that job and asserts only "nothing failed".
#
# Usage: bash scripts/run-tests.sh            # 0 failed, 0 skipped
#        ALLOW_SKIPS=1 bash scripts/run-tests.sh   # 0 failed (Windows)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOG="${TMPDIR:-/tmp}/ether-tests.log"

if [ ! -x c-relay/udp2tcp ]; then
  if [ "$(uname -s)" = "Linux" ] || [ "$(uname -s)" = "Darwin" ]; then
    echo "==> c-relay/udp2tcp is missing: building the host relay so the interop cases run"
    (cd c-relay && ./build.sh --host)
  else
    echo "==> no host C relay on $(uname -s) — the interop cases will skip"
  fi
fi

echo "==> npm test (app/; pretest runs tsc)"
cd app
# pipefail is on, so a failing suite fails the pipeline too
npm test 2>&1 | tee "$LOG"

# node --test prints these under its spec and its tap reporter alike
if [ -z "${ALLOW_SKIPS:-}" ]; then
  grep -qE 'skipped 0$' "$LOG" || {
    echo "FAIL: the suite skipped something — interop without the C relay is not a pass" >&2
    exit 1
  }
fi
grep -qE 'fail 0$' "$LOG" || {
  echo "FAIL: the suite reported failures" >&2
  exit 1
}

if [ -z "${ALLOW_SKIPS:-}" ]; then
  echo "==> tests: 0 failed, 0 skipped"
else
  echo "==> tests: 0 failed (skips allowed on this platform)"
fi
