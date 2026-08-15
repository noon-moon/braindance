#!/usr/bin/env bash
# vault-pull.sh — keep the LOCAL vault checkout current with its remote.
#
# The problem it solves: the vault is written from two places. The droplet's api
# commits captures and todo state continuously; you edit the same vault in
# Obsidian at the desk. Nothing reconciles the desk copy unless you remember to
# pull before you start typing — and the failure is silent and expensive. You
# edit a stale note, the remote has moved, and the next sync is a content
# conflict in a file you were halfway through. (That is exactly how a month of
# droplet captures ended up stranded: a rebase conflict paused sync and nobody
# was watching.) A timer that pulls for you removes the remembering.
#
# THIS TOOL ONLY EVER PULLS, AND ONLY WHEN IT IS SAFE.
#
# It never commits, never stages, never stashes, never resets, never pushes.
# That is a deliberate limit, not an unfinished feature: an Obsidian vault
# always has uncommitted work in it — a half-written note, a moved file,
# `.obsidian/workspace.json` churning every time you focus a pane. A tool that
# ran `git add -A` on a timer would sweep that into commits you never chose to
# make, and one that stashed could surprise you by moving your work out from
# under the editor. Publishing your side stays a thing you do deliberately.
#
# The pull is `--ff-only`. If the remote moved somewhere your history can't
# fast-forward onto, that is a real divergence and it stops and says so rather
# than guessing. If the incoming changes touch a file you have modified locally,
# git refuses on its own and nothing is lost — the tool reports and exits calmly,
# because the next run will succeed once you have committed or reverted that
# file. Neither case is an emergency, so neither is loud.
#
# Usage:
#   vault-pull.sh              # pull once (this is what the timer runs)
#   vault-pull.sh --install    # install a launchd agent (macOS), default 15 min
#   vault-pull.sh --install --interval 300
#   vault-pull.sh --uninstall  # remove it
#   vault-pull.sh --status     # is it installed, when did it last run, what happened
#
# Exit: 0 = up to date or fast-forwarded (nothing to do / did it)
#       1 = usage / no vault / not a git repo
#       2 = skipped for a reason worth knowing (dirty overlap, diverged, offline)
set -u

LABEL="net.noon-moon.braindance.vault-pull"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DEFAULT_INTERVAL=900 # 15 minutes — a desk-session cadence, not a deploy cadence

log() { printf '%s vault-pull: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }

# Resolve the active instance's vault the same way every other tool does, so a
# `bd use` switch moves this too and there is no second source of truth. An
# explicit VAULT_PATH in the environment still wins (ladder step 0).
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

do_pull() {
  local vault
  vault="$(resolve_vault)"
  if [ -z "$vault" ] || [ ! -d "$vault" ]; then
    log "no vault resolved (VAULT_PATH unset and the resolver found none)"
    return 1
  fi
  if ! git -C "$vault" rev-parse --git-dir >/dev/null 2>&1; then
    log "$vault is not a git checkout — nothing to pull"
    return 1
  fi

  local branch
  branch="$(git -C "$vault" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  if [ "$branch" = "HEAD" ]; then
    log "detached HEAD in $vault — skipping"
    return 2
  fi

  if ! git -C "$vault" fetch --quiet origin 2>/dev/null; then
    # Offline, asleep, or on a captive portal. Routine on a laptop; not an error.
    log "fetch failed (offline?) — will retry next run"
    return 2
  fi

  local upstream behind
  upstream="$(git -C "$vault" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)" || {
    log "$branch has no upstream — skipping"
    return 2
  }
  behind="$(git -C "$vault" rev-list --count "HEAD..$upstream" 2>/dev/null || echo 0)"
  if [ "$behind" = "0" ]; then
    log "up to date with $upstream"
    return 0
  fi

  # Diverged is not something to resolve on a timer — merging or rebasing local
  # commits is a decision, and making it silently is how you get a merge you did
  # not review. Report and leave it.
  local ahead
  ahead="$(git -C "$vault" rev-list --count "$upstream..HEAD" 2>/dev/null || echo 0)"
  if [ "$ahead" != "0" ]; then
    log "DIVERGED: $ahead local commit(s), $behind remote — resolve by hand (not doing it on a timer)"
    return 2
  fi

  if git -C "$vault" pull --ff-only --quiet 2>/dev/null; then
    log "fast-forwarded $behind commit(s) to $(git -C "$vault" rev-parse --short HEAD)"
    return 0
  fi
  # Almost always: an incoming file is one you have edited but not committed.
  # git declined before touching anything, which is the correct outcome.
  log "held back $behind commit(s) — local edits overlap the incoming changes; commit or revert them and this clears itself"
  return 2
}

install_agent() {
  local interval="${1:-$DEFAULT_INTERVAL}"
  case "$(uname -s)" in
    Darwin) ;;
    *) log "--install is macOS/launchd only; on Linux use a systemd user timer calling this script"; return 1 ;;
  esac
  local self logdir
  self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  logdir="$HOME/Library/Logs"; mkdir -p "$logdir" "$(dirname "$PLIST")"
  # RunAtLoad matters more than the interval: the common case is opening the
  # laptop and going straight to Obsidian, and that is precisely the moment the
  # desk copy is most likely to be stale.
  cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array><string>/bin/bash</string><string>$self</string></array>
    <key>StartInterval</key><integer>$interval</integer>
    <key>RunAtLoad</key><true/>
    <key>StandardOutPath</key><string>$logdir/braindance-vault-pull.log</string>
    <key>StandardErrorPath</key><string>$logdir/braindance-vault-pull.log</string>
</dict>
</plist>
PLISTEOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST" 2>/dev/null || { log "launchctl load failed"; return 1; }
  log "installed $LABEL — every ${interval}s and at login; log: $logdir/braindance-vault-pull.log"
}

uninstall_agent() {
  [ -f "$PLIST" ] || { log "not installed"; return 0; }
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  log "removed $LABEL"
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
  local logf="$HOME/Library/Logs/braindance-vault-pull.log"
  [ -f "$logf" ] && { printf 'last runs:\n'; tail -5 "$logf" | sed 's/^/  /'; }
  return 0
}

case "${1:---pull}" in
  --pull|"") do_pull ;;
  --install)
    shift
    interval="$DEFAULT_INTERVAL"
    [ "${1:-}" = "--interval" ] && { interval="${2:?--interval needs seconds}"; }
    install_agent "$interval"
    ;;
  --uninstall) uninstall_agent ;;
  --status) status_agent ;;
  -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
  *) log "unknown option: $1 (try --help)"; exit 1 ;;
esac
