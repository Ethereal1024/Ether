#!/bin/sh
# Build udp2tcp for the PC and for the tablet, then run the self-test.
#
#   ./build.sh          host + device + self-test
#   ./build.sh --host   host binary only
set -e
cd "$(dirname "$0")"

CC=${CC:-cc}
NDK=${NDK:-$HOME/Android/Sdk/ndk/26.3.11579264}
APIVER=${APIVER:-24}

echo "== host binary (x86_64) =="
$CC -O2 -Wall -Wextra -o udp2tcp udp2tcp.c
echo "   -> udp2tcp"

if [ "$1" = "--host" ]; then exit 0; fi

CROSS="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android$APIVER-clang"
if [ ! -x "$CROSS" ]; then
  echo "!! cross compiler not found: $CROSS"
  echo "   set NDK=... to your NDK path (ls \$HOME/Android/Sdk/ndk)"
  exit 1
fi

echo "== device binary (aarch64) =="
# Note: do NOT use -static here. Bionic refuses a static aarch64 executable whose
# PT_TLS alignment is 8 ("executable's TLS segment is underaligned ... needs 64").
# A normal PIE linked against the platform libc runs fine from /data/local/tmp.
"$CROSS" -O2 -Wall -Wextra -o udp2tcp.aarch64 udp2tcp.c
size=$(wc -c < udp2tcp.aarch64)
echo "   -> udp2tcp.aarch64 ($size bytes)"

echo "== self-test (loopback, no tablet needed) =="
./udp2tcp --test
