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
# THE LOG RECORDS CHANGES, NOT TICKS.
#
# The interval is a knob, and at a short one (30s is reasonable — the point is
# for the desk copy to already be current when you glance at it, not to converge
# "eventually") a line per run would be thousands of identical "up to date"
# entries a day, growing without bound, burying the one line that mattered. So a
# routine outcome repeating itself is silent: an outcome is written to a stamp
# file every run, and only appended to the log when it DIFFERS from the previous
# run's. The log becomes a history of transitions — began holding back, cleared,
# went offline, came back — which is what you would actually read. Real work
# (a fast-forward) and hard errors always log, however often they occur.
#
# `--status` reads both: the stamp answers "is it alive and what is it doing
# right now", the log answers "what has happened".
#
# Usage:
#   vault-pull.sh              # pull once (this is what the timer runs)
#   vault-pull.sh --install    # install a launchd agent (macOS), default 15 min
#   vault-pull.sh --install --interval 30
#   vault-pull.sh --uninstall  # remove it
#   vault-pull.sh --status     # is it installed, when did it last run, what happened
#
# Exit: 0 = up to date or fast-forwarded (nothing to do / did it)
#       1 = usage / no vault / not a git repo
#       2 = skipped for a reason worth knowing (dirty overlap, diverged, offline)
set -u

LABEL="net.noon-moon.braindance.vault-pull"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DEFAULT_INTERVAL=900 # 15 minutes — conservative default; --interval takes any cadence

# State dir: overridable so the tests never touch the real one.
state_dir() {
  if [ -n "${BD_VAULT_PULL_STATE_DIR:-}" ]; then printf '%s\n' "$BD_VAULT_PULL_STATE_DIR"; return; fi
  case "$(uname -s)" in
    Darwin) printf '%s\n' "$HOME/Library/Logs" ;;
    *) printf '%s\n' "${XDG_STATE_HOME:-$HOME/.local/state}" ;;
  esac
}
LOG_FILE() { printf '%s/braindance-vault-pull.log' "$(state_dir)"; }
STAMP_FILE() { printf '%s/braindance-vault-pull.last' "$(state_dir)"; }

# note <outcome-key> <message>
# Always writes the stamp. Prints (→ the log) only when this outcome differs from
# the previous run's, so a steady state stays quiet. `ff` and `error` are exempt:
# a fast-forward is real work and an error is worth seeing every time.
note() {
  local outcome="$1" msg="$2" prev="" stamp line
  stamp="$(STAMP_FILE)"; mkdir -p "$(dirname "$stamp")" 2>/dev/null || true
  [ -f "$stamp" ] && prev="$(cut -d' ' -f2 < "$stamp" 2>/dev/null)"
  line="$(date '+%Y-%m-%dT%H:%M:%S%z') $outcome vault-pull: $msg"
  printf '%s\n' "$line" > "$stamp" 2>/dev/null || true
  case "$outcome" in
    ff|error) printf '%s\n' "$line" ;;
    *) [ "$outcome" != "$prev" ] && printf '%s\n' "$line" ;;
  esac
  return 0
}

# Belt and braces: even transition-only logging grows over years. Keep the tail.
trim_log() {
  local f; f="$(LOG_FILE)"
  [ -f "$f" ] || return 0
  local size; size="$(wc -c < "$f" 2>/dev/null | tr -d ' ')"
  [ "${size:-0}" -gt 262144 ] || return 0
  tail -n 200 "$f" > "$f.tmp" 2>/dev/null && mv "$f.tmp" "$f"
}

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
    note error "no vault resolved (VAULT_PATH unset and the resolver found none)"
    return 1
  fi
  if ! git -C "$vault" rev-parse --git-dir >/dev/null 2>&1; then
    note error "$vault is not a git checkout — nothing to pull"
    return 1
  fi

  local branch
  branch="$(git -C "$vault" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  if [ "$branch" = "HEAD" ]; then
    note detached "detached HEAD in $vault — skipping"
    return 2
  fi

  if ! git -C "$vault" fetch --quiet origin 2>/dev/null; then
    # Offline, asleep, or on a captive portal. Routine on a laptop; not an error.
    note offline "fetch failed (offline?) — will retry next run"
    return 2
  fi

  local upstream behind
  upstream="$(git -C "$vault" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)" || {
    note noupstream "$branch has no upstream — skipping"
    return 2
  }
  behind="$(git -C "$vault" rev-list --count "HEAD..$upstream" 2>/dev/null || echo 0)"
  if [ "$behind" = "0" ]; then
    note uptodate "up to date with $upstream"
    return 0
  fi

  # Diverged is not something to resolve on a timer — merging or rebasing local
  # commits is a decision, and making it silently is how you get a merge you did
  # not review. Report and leave it.
  local ahead
  ahead="$(git -C "$vault" rev-list --count "$upstream..HEAD" 2>/dev/null || echo 0)"
  if [ "$ahead" != "0" ]; then
    note diverged "DIVERGED: $ahead local commit(s), $behind remote — resolve by hand (not doing it on a timer)"
    return 2
  fi

  if git -C "$vault" pull --ff-only --quiet 2>/dev/null; then
    note ff "fast-forwarded $behind commit(s) to $(git -C "$vault" rev-parse --short HEAD)"
    return 0
  fi
  # Almost always: an incoming file is one you have edited but not committed.
  # git declined before touching anything, which is the correct outcome.
  note held "held back $behind commit(s) — local edits overlap the incoming changes; commit or revert them and this clears itself"
  return 2
}

install_agent() {
  local interval="${1:-$DEFAULT_INTERVAL}"
  case "$(uname -s)" in
    Darwin) ;;
    *) printf 'vault-pull: --install is macOS/launchd only; on Linux use a systemd user timer calling this script\n'; return 1 ;;
  esac
  local self logdir logf
  self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  logdir="$(state_dir)"; logf="$(LOG_FILE)"; mkdir -p "$logdir" "$(dirname "$PLIST")"
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
    <key>StandardOutPath</key><string>$logf</string>
    <key>StandardErrorPath</key><string>$logf</string>
</dict>
</plist>
PLISTEOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST" 2>/dev/null || { printf 'vault-pull: launchctl load failed\n'; return 1; }
  printf 'vault-pull: installed %s — every %ss and at login; log: %s\n' "$LABEL" "$interval" "$logf"
}

uninstall_agent() {
  [ -f "$PLIST" ] || { printf 'vault-pull: not installed\n'; return 0; }
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  printf 'vault-pull: removed %s\n' "$LABEL"
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
  # The stamp is written EVERY run, so it answers "is this thing alive and what
  # is it doing right now" — which the log deliberately cannot, since a steady
  # state leaves no lines there.
  local stamp logf
  stamp="$(STAMP_FILE)"; logf="$(LOG_FILE)"
  if [ -f "$stamp" ]; then printf 'last run:  %s\n' "$(cat "$stamp")"
  else printf 'last run:  <never>\n'; fi
  [ -f "$logf" ] && { printf 'changes:\n'; tail -5 "$logf" | sed 's/^/  /'; }
  return 0
}

case "${1:---pull}" in
  --pull|"") trim_log; do_pull ;;
  --install)
    shift
    interval="$DEFAULT_INTERVAL"
    [ "${1:-}" = "--interval" ] && { interval="${2:?--interval needs seconds}"; }
    install_agent "$interval"
    ;;
  --uninstall) uninstall_agent ;;
  --status) status_agent ;;
  -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
  *) printf 'vault-pull: unknown option: %s (try --help)\n' "$1"; exit 1 ;;
esac
