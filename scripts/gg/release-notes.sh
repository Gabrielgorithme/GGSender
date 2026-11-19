#!/usr/bin/env bash
# GGSender: the text of a release, for one fork version: how to install the
# app.asar, then the notes of that version from the change log in GGSENDER.md.
# Usage: scripts/gg/release-notes.sh <version>      (for example 0.7.3)
set -euo pipefail
cd "$(dirname "$0")/../.."
VERSION=${1:?usage: release-notes.sh <version>}

NOTES=$(awk -v v="$VERSION" '
    /^### / { on = ($2 == v) }
    /^## / && !/^### / { on = 0 }
    on && !/^### / { print }
' GGSENDER.md)
if [ -z "$(printf '%s' "$NOTES" | tr -d '[:space:]')" ]; then
    echo "No notes for version $VERSION in GGSENDER.md" >&2
    exit 1
fi

cat <<TEXT
\`app.asar\` for an installed **official gSender 1.6.4** on Windows. It replaces one file of that
installation; nothing else changes.

1. Install official gSender 1.6.4 and close it.
2. In \`C:\\Program Files\\gSender\\resources\\\`, rename \`app.asar\` to \`app.asar.stock\`.
3. Copy the \`app.asar\` from this release into that folder.
4. Start gSender. The window title reads \`GGSender ${VERSION} (gSender 1.6.4)\`.

To go back: delete \`app.asar\` and rename \`app.asar.stock\` to \`app.asar\`.

This is not an official gSender build. It is not supported by Sienci Labs: do not report problems
with it to them. It moves a machine: read the notes, and make air cuts first.

Everything the fork adds to gSender, with pictures: the [README](https://github.com/${GITHUB_REPOSITORY:-Gabrielgorithme/GGSender}#readme).
All versions, the machine checklists and the traps: [GGSENDER.md](https://github.com/${GITHUB_REPOSITORY:-Gabrielgorithme/GGSender}/blob/gg/main/GGSENDER.md).

## What changed in ${VERSION}
$NOTES
TEXT
