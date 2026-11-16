#!/usr/bin/env bash
# GGSender: build the three JavaScript layers (interface, server, main process)
# into dist/gsender, the same layout the official build produces.
#
# Usage: scripts/gg/build.sh
# Needs: node >= 18 and the dependencies installed (see GGSENDER.md).
set -euo pipefail
cd "$(dirname "$0")/../.."

BIN=node_modules/.bin

echo "== clean"
rm -rf dist/gsender

echo "== css"
"$BIN/postcss" src/app/src/index.css -o src/app/src/application.css \
    --config src/app/postcss.config.cjs

echo "== server + main process"
node esbuild.config.js --production --target=all

echo "== interface"
(
    cd src/app
    NODE_OPTIONS="--max-old-space-size=6144" ../../node_modules/.bin/vite build \
        --sourcemap false --outDir ../../dist/gsender/app --emptyOutDir
)

echo "== static files"
mkdir -p dist/gsender/app/src
cp -af src/app/favicon.ico src/app/images src/app/assets dist/gsender/app/
cp src/app/src/application.css dist/gsender/app/src/

echo "== done: dist/gsender"
