#!/usr/bin/env bash
# sync.sh — install ctx/skills/ into your LLM harness
# Part of the braindance lifecycle; not a user-authored tool.
#
# Usage: ./ctx/tools/sys/sync.sh <harness>
#
# Harnesses:
#   claude-code   Symlink skills into .claude/commands/ (slash commands)
#   cursor        Copy skills into .cursor/rules/
#   zed           Copy skills into .zed/prompts/
#   continue      Copy skills into .continue/prompts/

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="$(cd "$SCRIPT_DIR/../../skills" && pwd)"
BD_ROOT="$(cd "$SCRIPT_DIR/../../../" && pwd)"

usage() {
  echo "Usage: $0 <harness>"
  echo ""
  echo "  claude-code   Symlink skills into .claude/commands/"
  echo "  cursor        Copy skills into .cursor/rules/"
  echo "  zed           Copy skills into .zed/prompts/"
  echo "  continue      Copy skills into .continue/prompts/"
  echo ""
  echo "Example: $0 claude-code"
  exit 1
}

[ -z "$1" ] && usage

HARNESS="$1"

install_symlinks() {
  local target="$1"
  mkdir -p "$target"
  while IFS= read -r -d '' skill; do
    name="$(basename "$skill")"
    ln -sf "$skill" "$target/$name"
    echo "  linked: $name"
  done < <(find "$SKILLS_DIR" -name "*.md" -print0)
  echo "Done. Skills linked to $target"
}

install_copies() {
  local target="$1"
  mkdir -p "$target"
  while IFS= read -r -d '' skill; do
    name="$(basename "$skill")"
    cp "$skill" "$target/$name"
    echo "  copied: $name"
  done < <(find "$SKILLS_DIR" -name "*.md" -print0)
  echo "Done. Skills copied to $target"
}

case "$HARNESS" in
  claude-code)
    install_symlinks "$BD_ROOT/.claude/commands"
    ;;
  cursor)
    install_copies "$BD_ROOT/.cursor/rules"
    ;;
  zed)
    install_copies "$BD_ROOT/.zed/prompts"
    ;;
  continue)
    install_copies "$BD_ROOT/.continue/prompts"
    ;;
  *)
    echo "Unknown harness: $HARNESS"
    echo ""
    usage
    ;;
esac
