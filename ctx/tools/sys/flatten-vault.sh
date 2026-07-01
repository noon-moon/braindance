#!/usr/bin/env bash
# Flattens the ~/notes/braindance vault into a working directory.
# Only copies the top-level Zettelkasten notes (the superset) and
# static assets. Skips all recursive braindance/braindance/... dirs.

set -euo pipefail

SOURCE_ZK="$HOME/notes/braindance/Zettelkasten"
SOURCE_ASSETS="$HOME/notes/braindance/Files"
DEST="${1:-$HOME/notes-flat}"

if [[ -d "$DEST" ]]; then
  echo "Destination already exists: $DEST"
  echo "Remove it first or pass a different path as \$1"
  exit 1
fi

mkdir -p "$DEST/notes"
mkdir -p "$DEST/assets"

# Copy only top-level .md files — maxdepth 1 skips the recursive dirs
echo "Copying notes from $SOURCE_ZK …"
find "$SOURCE_ZK" -maxdepth 1 -name "*.md" -exec cp {} "$DEST/notes/" \;

NOTE_COUNT=$(find "$DEST/notes" -name "*.md" | wc -l | tr -d ' ')
echo "  $NOTE_COUNT notes copied"

# Copy attachments/assets
if [[ -d "$SOURCE_ASSETS" ]]; then
  echo "Copying assets from $SOURCE_ASSETS …"
  cp -r "$SOURCE_ASSETS/." "$DEST/assets/"
  ASSET_COUNT=$(find "$DEST/assets" -type f | wc -l | tr -d ' ')
  echo "  $ASSET_COUNT assets copied"
fi

echo ""
echo "Flattened vault ready at: $DEST"
echo "  $DEST/notes/   — all .md notes"
echo "  $DEST/assets/  — images and other files"
