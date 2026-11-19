#!/usr/bin/env bash
# GGSender: get the app.asar of the official gSender release that this fork is
# built on. pack-asar.mjs needs it: everything the fork does not change
# (node_modules, the native serial-port libraries' loader) is copied from it.
#
# Usage: scripts/gg/fetch-stock-asar.sh <output app.asar> [installer.exe]
#        With an installer already on disk as second argument, nothing is downloaded.
# Needs: curl, python3, and 7-Zip (7z, 7zz or 7za; SEVENZIP=<path> to name one).
#
# The Windows installer is an NSIS program with a 7-Zip archive behind it.
# The archive starts at the first 7z signature (37 7A BC AF 27 1C) in the
# file; resources/app.asar is inside it. Both files are checked against the
# SHA-256 of the 1.6.4 release, so a changed download stops here.
set -euo pipefail

VERSION=1.6.4
URL="https://github.com/Sienci-Labs/gsender/releases/download/v${VERSION}/gSender-${VERSION}-x64.exe"
EXE_SHA256=cb95676fa16f168378f95fd16a48bc8925e42653b21482b5e2f22ae845297d07
ASAR_SHA256=43e4e548de71846b03b878cf8604c46d6cb3ac577bb0327e1c229dc59a559b24

OUT=${1:?usage: fetch-stock-asar.sh <output app.asar> [installer.exe]}
EXE=${2:-}

SEVENZIP=${SEVENZIP:-$(command -v 7z || command -v 7zz || command -v 7za || true)}
if [ -z "$SEVENZIP" ]; then
    echo "7-Zip not found (7z, 7zz or 7za). Install p7zip-full, or set SEVENZIP." >&2
    exit 1
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

if [ -z "$EXE" ]; then
    EXE="$WORK/installer.exe"
    echo "== download gSender ${VERSION} installer"
    curl -fL --retry 3 -o "$EXE" "$URL"
fi

check() { # file, expected sha256, what
    local got
    got=$(sha256sum "$1" | cut -d' ' -f1)
    if [ "$got" != "$2" ]; then
        echo "$3: SHA-256 is $got, expected $2" >&2
        exit 1
    fi
}
check "$EXE" "$EXE_SHA256" "installer"

echo "== cut the 7-Zip archive out of the installer"
python3 - "$EXE" "$WORK/payload.7z" <<'PY'
import sys
data = open(sys.argv[1], 'rb').read()
at = data.find(bytes.fromhex('377abcaf271c'))
if at < 0:
    sys.exit('no 7z signature in the installer')
open(sys.argv[2], 'wb').write(data[at:])
print(f'archive starts at byte {at}')
PY

echo "== extract resources/app.asar"
"$SEVENZIP" e -y -o"$WORK/out" "$WORK/payload.7z" resources/app.asar >/dev/null
check "$WORK/out/app.asar" "$ASAR_SHA256" "app.asar"

mkdir -p "$(dirname "$OUT")"
mv "$WORK/out/app.asar" "$OUT"
echo "== done: $OUT"
