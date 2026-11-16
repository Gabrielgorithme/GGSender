#!/usr/bin/env bash
# GGSender: type-check the interface with the TypeScript version it declares.
#
# The `tsc` in node_modules/.bin is TypeScript 3.9, pulled in by another
# package. It cannot parse current type declarations and stops at syntax
# errors in node_modules before checking any of gSender's own code, so its
# output says nothing about the code. This script uses TypeScript 5.4.5.
#
# Upstream gSender 1.6.4 itself has about 740 type errors; the build does not
# type-check. What matters is that files the fork adds have none, and that
# the files it changes have no more than upstream. The script prints the
# errors in the fork's own files and fails if there are any.
set -euo pipefail
cd "$(dirname "$0")/../.."

TSC_DIR="${TSC_DIR:-$HOME/.cache/gg-tsc-5.4.5}"
if [ ! -x "$TSC_DIR/node_modules/.bin/tsc" ]; then
    mkdir -p "$TSC_DIR"
    (cd "$TSC_DIR" && npm i --silent typescript@5.4.5 >/dev/null)
fi

OUT=$(mktemp)
(cd src/app && "$TSC_DIR/node_modules/.bin/tsc" --noEmit -p tsconfig.json > "$OUT" 2>&1) || true

TOTAL=$(grep -c "error TS" "$OUT" || true)
OWN=$(grep -E "src/(lib/gg|features/gg)/|__tests__/gg-|workers/__tests__/" "$OUT" || true)
echo "type errors in total (mostly upstream): $TOTAL"
if [ -n "$OWN" ]; then
    echo "type errors in GGSender files:"
    echo "$OWN"
    exit 1
fi
echo "type errors in GGSender files: 0"
