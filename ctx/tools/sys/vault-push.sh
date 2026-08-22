#!/usr/bin/env bash
# vault-push.sh — publish LOCAL vault edits to the remote, on a timer, safely.
#
# The counterpart to vault-pull.sh. That tool only ever pulls, and its header
# explains why it must never commit: an Obsidian vault always has uncommitted
# work in it — a half-written note, a file mid-rename — and `git add -A` on a
# timer sweeps that into commits you never chose to make. That objection is
# real, and it is an argument for DEBOUNCING rather than for never publishing.
#
# THE TREE MUST BE QUIET BEFORE ANYTHING IS COMMITTED.
#
# Every changed path is stat'd, and if ANY of them was touched within the
# debounce window (default 120s) the whole run does nothing and says so. Not
# "commit the settled files and leave the fresh ones" — that would split a
# rename, which Obsidian performs as a delete plus an add, and publish the
# deletion of a note whose replacement is still too new to go with it. The
# remote would show the note gone. So quiet means the WHOLE tree is quiet, and
# a vault you are actively typing in simply waits until you stop.
#
# That is also why this is a separate script and not a flag on vault-pull:
# pulling is safe every 30 seconds, and publishing is only safe when you have
# stopped moving. Two cadences, two tools, two log files.
#
# WHAT IT WILL NOT DO.
#
# It never stashes, never resets, never force-pushes, never resolves a conflict.
# The rebase before pushing is how a phone's commits and the desk's commits get
# onto one line of history; if that rebase conflicts it aborts and leaves the
# local commit sitting there for a human, exactly as vault-pull leaves a
# divergence alone. Sync pausing is a thing you can see and fix. A machine
# picking a side of a conflict in your notes is not.
#
# `_ephemeral/` and `.obsidian/workspace*.json` are already gitignored by the
# vault, so scratch and pane churn never reach this path at all.
#
# COMMITS ARE MARKED AS MACHINE-MADE.
#
# The message is prefixed `autosave:`, alongside the vault's other machine
# prefixes (`triage:`, `inbox:`, `todo:`), so `Vault:` keeps meaning "a human
# decided this" and the log stays readable as a history of intent.
#
# Usage:
#   vault-push.sh                      # one cycle (this is what the timer runs)
#   vault-push.sh --install            # launchd agent (macOS), default 5 min
#   vault-push.sh --install --interval 300 --debounce 120
#   vault-push.sh --uninstall
#   vault-push.sh --status             # installed? last run? what happened?
#
# Exit: 0 = published, or nothing to publish
#       1 = usage / no vault / not a git repo
#       2 = skipped for a reason worth knowing (still typing, offline, conflict)
set -u

LABEL="net.noon-moon.braindance.vault-push"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DEFAULT_INTERVAL=300 # 5 minutes — the debounce dominates, so this need not be tight
DEFAULT_DEBOUNCE=120 # seconds a path must be untouched before it may be committed

# State dir: overridable so the tests never touch the real one.
state_dir() {
  if [ -n "${BD_VAULT_PUSH_STATE_DIR:-}" ]; then printf '%s\n' "$BD_VAULT_PUSH_STATE_DIR"; return; fi
  case "$(uname -s)" in
    Darwin) printf '%s\n' "$HOME/Library/Logs" ;;
    *) printf '%s\n' "${XDG_STATE_HOME:-$HOME/.local/state}" ;;
  esac
}
LOG_FILE() { printf '%s/braindance-vault-push.log' "$(state_dir)"; }
STAMP_FILE() { printf '%s/braindance-vault-push.last' "$(state_dir)"; }

# note <outcome-key> <message>
# Always writes the stamp; prints (→ the log) only when the outcome differs from
# the previous run's, so a steady state stays quiet. `pushed` and `error` are
# exempt: real work and hard failures are worth a line every time. `waiting` is
# NOT exempt — a vault you are typing in emits it on every tick by design.
note() {
  local outcome="$1" msg="$2" prev="" stamp line
  stamp="$(STAMP_FILE)"; mkdir -p "$(dirname "$stamp")" 2>/dev/null || true
  [ -f "$stamp" ] && prev="$(cut -d' ' -f2 < "$stamp" 2>/dev/null)"
  line="$(date '+%Y-%m-%dT%H:%M:%S%z') $outcome vault-push: $msg"
  printf '%s\n' "$line" > "$stamp" 2>/dev/null || true
  case "$outcome" in
    pushed|error) printf '%s\n' "$line" ;;
    *) [ "$outcome" != "$prev" ] && printf '%s\n' "$line" ;;
  esac
  return 0
}

trim_log() {
  local f; f="$(LOG_FILE)"
  [ -f "$f" ] || return 0
  local size; size="$(wc -c < "$f" 2>/dev/null | tr -d ' ')"
  [ "${size:-0}" -gt 262144 ] || return 0
  tail -n 200 "$f" > "$f.tmp" 2>/dev/null && mv "$f.tmp" "$f"
}

# Resolve the active instance's vault the same way every other tool does, so a
# `bd use` switch moves this too and there is no second source of truth.
resolve_vault() {
  if [ -n "${VAULT_PATH:-}" ]; then printf '%s\n' "$VAULT_PATH"; return 0; fi
  local here resolver
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  resolver="$here/resolve.sh"
  if [ -x "$resolver" ]; then
    # shellcheck disable=SC1090
    eval "$("$resolver" "$here" 2>/dev/null)" || true
  fi
  printf '%s\n' "${VAULT_PATH:-}"
}

_mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null; }

# youngest_change <vault> -> seconds since the most recently touched changed path
# Prints nothing when there is nothing to commit. A path that no longer exists
# (a deletion) has no mtime and cannot be "half-written", so it is skipped.
youngest_change() {
  local vault="$1" now newest="" st p m
  now="$(date +%s)"
  while IFS= read -r -d '' entry; do
    st="${entry:0:2}"; p="${entry:3}"
    # A rename/copy entry carries its origin path as a second NUL field.
    case "$st" in R*|C*) IFS= read -r -d '' _ || true ;; esac
    [ -n "$p" ] || continue
    [ -e "$vault/$p" ] || continue
    m="$(_mtime "$vault/$p")" || continue
    [ -n "$m" ] || continue
    if [ -z "$newest" ] || [ "$m" -gt "$newest" ]; then newest="$m"; fi
  done < <(git -C "$vault" status --porcelain=v1 -z --untracked-files=all 2>/dev/null)
  [ -n "$newest" ] || return 0
  printf '%s\n' "$((now - newest))"
}

changed_count() {
  git -C "$1" status --porcelain=v1 --untracked-files=all 2>/dev/null | grep -c . | tr -d ' '
}

do_push() {
  local debounce="${1:-$DEFAULT_DEBOUNCE}" vault
  vault="$(resolve_vault)"
  if [ -z "$vault" ] || [ ! -d "$vault" ]; then
    note error "no vault resolved (VAULT_PATH unset and the resolver found none)"
    return 1
  fi
  if ! git -C "$vault" rev-parse --git-dir >/dev/null 2>&1; then
    note error "$vault is not a git checkout — nothing to push"
    return 1
  fi

  local branch
  branch="$(git -C "$vault" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  if [ "$branch" = "HEAD" ]; then
    note detached "detached HEAD in $vault — skipping"
    return 2
  fi
  if ! git -C "$vault" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
    note noupstream "$branch has no upstream — skipping"
    return 2
  fi

  # 1. Commit, if the tree has been quiet long enough.
  local n age
  n="$(changed_count "$vault")"
  if [ "${n:-0}" -gt 0 ]; then
    age="$(youngest_change "$vault")"
    if [ -n "$age" ] && [ "$age" -lt "$debounce" ]; then
      note waiting "$n change(s), newest ${age}s old — still typing (debounce ${debounce}s)"
      return 2
    fi
    git -C "$vault" add -A || { note error "git add failed in $vault"; return 1; }
    # Re-check: `add -A` resolves gitignore, so a tree of only-ignored churn
    # stages nothing and must not produce an empty commit.
    if git -C "$vault" diff --cached --quiet; then
      note quiet "nothing staged after add (ignored churn only)"
    else
      local host; host="$(hostname -s 2>/dev/null || echo desk)"
      if ! git -C "$vault" commit -q -m "autosave: $n change(s) from $host" \
             -m "$(git -C "$vault" diff --cached --name-only | head -30)"; then
        note error "commit failed in $vault"
        return 1
      fi
    fi
  fi

  # 2. Anything to send? (Also covers a commit whose push failed on an earlier run.)
  if ! git -C "$vault" fetch --quiet origin 2>/dev/null; then
    note offline "fetch failed (offline?) — will retry next run"
    return 2
  fi
  local upstream ahead
  upstream="$(git -C "$vault" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)"
  ahead="$(git -C "$vault" rev-list --count "$upstream..HEAD" 2>/dev/null || echo 0)"
  if [ "$ahead" = "0" ]; then
    note uptodate "nothing to publish"
    return 0
  fi

  # 3. Rebase onto the remote so the phone's commits and the desk's interleave
  #    rather than diverge. A conflict is a decision, so it aborts and waits.
  local behind
  behind="$(git -C "$vault" rev-list --count "HEAD..$upstream" 2>/dev/null || echo 0)"
  if [ "$behind" != "0" ]; then
    if ! git -C "$vault" rebase --quiet "$upstream" 2>/dev/null; then
      git -C "$vault" rebase --abort 2>/dev/null || true
      note conflict "REBASE CONFLICT against $upstream — $ahead local commit(s) held; resolve by hand"
      return 2
    fi
  fi

  if git -C "$vault" push --quiet 2>/dev/null; then
    note pushed "published $ahead commit(s) — $(git -C "$vault" rev-parse --short HEAD)"
    return 0
  fi
  note pushfail "push rejected — will retry next run"
  return 2
}

install_agent() {
  local interval="${1:-$DEFAULT_INTERVAL}" debounce="${2:-$DEFAULT_DEBOUNCE}"
  case "$(uname -s)" in
    Darwin) ;;
    *) printf 'vault-push: --install is macOS/launchd only; on Linux use a systemd user timer calling this script\n'; return 1 ;;
  esac
  local self logdir logf
  self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  logdir="$(state_dir)"; logf="$(LOG_FILE)"; mkdir -p "$logdir" "$(dirname "$PLIST")"
  # Deliberately NO RunAtLoad: vault-pull wants to run the moment the laptop
  # opens, but publishing at that moment is the one time the tree is most likely
  # to hold something you left half-finished. Let the first interval elapse.
  cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array><string>/bin/bash</string><string>$self</string><string>--debounce</string><string>$debounce</string></array>
    <key>StartInterval</key><integer>$interval</integer>
    <key>StandardOutPath</key><string>$logf</string>
    <key>StandardErrorPath</key><string>$logf</string>
</dict>
</plist>
PLISTEOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST" 2>/dev/null || { printf 'vault-push: launchctl load failed\n'; return 1; }
  printf 'vault-push: installed %s — every %ss, debounce %ss; log: %s\n' "$LABEL" "$interval" "$debounce" "$logf"
}

uninstall_agent() {
  [ -f "$PLIST" ] || { printf 'vault-push: not installed\n'; return 0; }
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  printf 'vault-push: removed %s\n' "$LABEL"
}

status_agent() {
  local vault; vault="$(resolve_vault)"
  printf 'vault:     %s\n' "${vault:-<unresolved>}"
  if [ -f "$PLIST" ]; then
    printf 'agent:     installed (%s)\n' "$PLIST"
    printf 'loaded:    %s\n' "$(launchctl list 2>/dev/null | grep -c "$LABEL" | tr -d ' ') (0 = not loaded)"
  else
    printf 'agent:     not installed — run: %s --install\n' "$(basename "${BASH_SOURCE[0]}")"
  fi
  if [ -n "$vault" ] && [ -d "$vault" ]; then
    printf 'pending:   %s uncommitted change(s)\n' "$(changed_count "$vault")"
  fi
  local stamp logf
  stamp="$(STAMP_FILE)"; logf="$(LOG_FILE)"
  if [ -f "$stamp" ]; then printf 'last run:  %s\n' "$(cat "$stamp")"
  else printf 'last run:  <never>\n'; fi
  [ -f "$logf" ] && { printf 'changes:\n'; tail -5 "$logf" | sed 's/^/  /'; }
  return 0
}

debounce="$DEFAULT_DEBOUNCE"
case "${1:---push}" in
  --push|"")
    shift 2>/dev/null || true
    [ "${1:-}" = "--debounce" ] && debounce="${2:?--debounce needs seconds}"
    trim_log; do_push "$debounce"
    ;;
  --debounce)
    debounce="${2:?--debounce needs seconds}"
    trim_log; do_push "$debounce"
    ;;
  --install)
    shift
    interval="$DEFAULT_INTERVAL"
    while [ $# -gt 0 ]; do
      case "$1" in
        --interval) interval="${2:?--interval needs seconds}"; shift 2 ;;
        --debounce) debounce="${2:?--debounce needs seconds}"; shift 2 ;;
        *) printf 'vault-push: unknown --install option: %s\n' "$1"; exit 1 ;;
      esac
    done
    install_agent "$interval" "$debounce"
    ;;
  --uninstall) uninstall_agent ;;
  --status) status_agent ;;
  -h|--help) sed -n '2,50p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
  *) printf 'vault-push: unknown option: %s (try --help)\n' "$1"; exit 1 ;;
esac
