#!/usr/bin/env bash
# The braindance applier, one pass. Driven by braindance-applier.timer.
#
#   pull → propose (classify what is armed) → pass (act on answered proposals)
#        → commit + push whatever changed
#
# The api used to own the vault checkout and drive its own reconcile. It is gone;
# this script is the only writer on this box, which is why the git handling lives
# here rather than inside the tool. Obsidian's own clients (obsidian-git on the
# desk and the phone) are the other writers, so every pull is a rebase and a
# conflict is reported rather than resolved.
#
# EVERY FAILURE LANDS IN THE VAULT. A timer that fails silently is the exact
# problem this whole loop is designed against — see the failure backoff and the
# token accounting in api/src. So a pass that cannot complete writes a note into
# `_triage/` and pushes it, where it turns up in Obsidian on the phone like
# anything else. The note DELETES ITSELF on the next good pass, so its presence
# always means "broken right now" rather than "was broken once".
set -uo pipefail

# EXPORTED, not just used locally. The tool resolves its own vault from
# VAULT_PATH and falls back to REPO_PATH/VAULT_SUBDIR — so a script that knew
# where the vault was and kept it to itself pointed a live run at a stale
# checkout, created a `_triage/` in it, and filed a failure note there. One
# source of truth for "which vault", and it is this line.
export VAULT_PATH="${VAULT_PATH:-/srv/vault}"
VAULT="$VAULT_PATH"

# THE SCRIPT READS ITS OWN ENV FILE.
#
# The unit carries `EnvironmentFile=-/srv/.env`, which systemd honours and a
# shell does not — so running this by hand ran it without an API key, and the
# instruction "test it by hand before enabling the timer" was testing a
# different program than the one the timer runs. A script whose behaviour
# depends on who invoked it is a script you cannot rehearse.
#
# Parsed, not sourced: `/srv/.env` is a docker-style env file and `.` would hand
# arbitrary shell to bash on a file nobody thinks of as code. Only well-formed
# KEY=VALUE lines are taken, and ANYTHING ALREADY IN THE ENVIRONMENT WINS, so
# `VAULT_PATH=… ops/applier.sh` still overrides for a one-off run.
ENV_FILE="${BD_ENV_FILE:-/srv/.env}"
if [ -r "$ENV_FILE" ]; then
  while IFS='=' read -r k v; do
    case "$k" in ''|'#'*|*[!A-Za-z0-9_]*) continue ;; esac
    [ -n "${!k:-}" ] && continue
    v="${v%$'\r'}"; v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
    export "$k=$v"
  done < "$ENV_FILE"
fi

[ -n "${ANTHROPIC_API_KEY:-}" ] || echo "warning: no ANTHROPIC_API_KEY (looked in $ENV_FILE)" >&2
API="${BD_API:-/srv/braindance/api}"
LIMIT="${BD_LIMIT:-10}"
NOTE="$VAULT/_triage/BRAINDANCE PASS FAILING.md"
LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

# One pass at a time. At a one-minute cadence a slow pass would otherwise start
# overlapping itself, and two appliers writing one vault is the thing every
# other design here refuses.
# `flock` is util-linux and is always present on the deploy target. It is guarded
# so the script can be exercised on a Mac, and it SAYS SO when it is missing —
# an unlocked run is a real risk to state silently accepted, and the one thing
# worse than no lock is a lock you believe you have.
if command -v flock >/dev/null 2>&1; then
  exec 9>/tmp/braindance-applier.lock
  flock -n 9 || exit 0
else
  echo "warning: flock unavailable — running without an overlap guard" >&2
fi

cd "$VAULT" || { echo "no vault at $VAULT"; exit 1; }

# How long it has been broken, carried across runs so the note can say.
prev_failures=0
prev_since=""
if [ -f "$NOTE" ]; then
  prev_failures=$(sed -n 's/^bd_failures: *//p' "$NOTE" | head -1)
  prev_since=$(sed -n 's/^bd_since: *//p' "$NOTE" | head -1)
  [ -n "$prev_failures" ] || prev_failures=0
fi

fail() {
  local stage="$1"
  # BACK TO THE VAULT FIRST. A failure can be raised from the api directory, and
  # git run from there commits nothing — which left the note on the box and off
  # the phone, silently, which is the one outcome this note exists to prevent.
  cd "$VAULT" || { echo "cannot reach $VAULT to report: $stage"; exit 1; }
  local n=$((prev_failures + 1))
  # Portable format: GNU date takes -Is, BSD date does not, and this script
  # gets run by hand on a Mac often enough to matter.
  local since="${prev_since:-$(date +%Y-%m-%dT%H:%M:%S)}"
  mkdir -p "$VAULT/_triage"
  # NOT a *.triage.md file, deliberately: this is not a proposal and the pass
  # must not iterate over it.
  cat > "$NOTE" <<NOTEEOF
---
bd_state: pass-failed
bd_stage: $stage
bd_since: $since
bd_failures: $n
bd_host: $(hostname)
---
# ⚠ The braindance pass is failing

Failing at **$stage** since $(echo "$since" | cut -c1-16 | tr 'T' ' ') · $n consecutive runs.

\`\`\`
$(tail -c 2000 "$LOG")
\`\`\`

**Nothing has been filed or discarded.** Every capture and every proposal is
exactly as you left it; the loop stops rather than guessing.

Worth checking, roughly in order:

- \`systemctl status braindance-applier.timer\`
- \`journalctl -u braindance-applier -n 50\`
- Is \`ANTHROPIC_API_KEY\` still set for the unit? (\`/srv/.env\`)
- Did the rebase conflict? This vault has several writers — \`git -C $VAULT status\`.
- Is the box simply out of disk or off the network?

This note deletes itself on the next successful pass.
NOTEEOF
  # Best effort: if git is what broke, the note cannot be pushed and will ride
  # out on the next run that can. It is on the box either way.
  git add -A -- "$NOTE" >/dev/null 2>&1 \
    && git commit -qm "braindance: pass failing at $stage" >/dev/null 2>&1 \
    && git push -q origin "$(git symbolic-ref --short HEAD 2>/dev/null)" >/dev/null 2>&1
  echo "pass failed at $stage (run $n)"
  cat "$LOG"
  exit 1
}

# EXPLICIT REFS, not `git pull --rebase`. That form asks git to work out what
# to rebase onto from `branch.*.merge`, `remote.*.fetch` and FETCH_HEAD — and on
# this box it answered "Cannot rebase onto multiple branches", because the api
# synced by explicit URL to keep its PAT out of `.git/config` and left the
# tracking config in a shape a bare pull cannot read. Naming the branch removes
# the question rather than repairing the config, which is the right fix for a
# script that has to run on a checkout it did not create.
BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null)" || fail "detached HEAD"
[ -n "$BRANCH" ] || fail "detached HEAD"
git fetch -q origin "$BRANCH" >>"$LOG" 2>&1 || fail "git fetch"
git rebase -q "origin/$BRANCH" >>"$LOG" 2>&1 || fail "git rebase"

cd "$API" || fail "api directory"

# COMPILED OUTPUT IF THERE IS ANY. At a one-minute cadence, re-transpiling the
# whole module graph on every run is pure waste — `npm ci && npm run build` once
# at deploy time and every pass is a plain `node`. tsx stays as the fallback
# because it is what a checkout has before anyone has built it, and a loop that
# refuses to run until someone remembers a build step is a loop that is off.
if [ -f dist/cli.js ]; then
  RUN=(node dist/cli.js)
else
  echo "note: no dist/ — falling back to tsx (run 'npm ci && npm run build')" >>"$LOG"
  RUN=(npx --yes tsx src/cli.ts)
fi

"${RUN[@]}" propose --limit "$LIMIT" >>"$LOG" 2>&1 || fail "propose"
"${RUN[@]}" pass    --limit "$LIMIT" >>"$LOG" 2>&1 || fail "pass"

cd "$VAULT" || fail "vault directory"
# A good pass clears the alarm before anything else, so "the note is gone" and
# "the loop is working" are the same fact.
[ -f "$NOTE" ] && rm -f "$NOTE"

if [ -n "$(git status --porcelain)" ]; then
  git add -A >>"$LOG" 2>&1 || fail "git add"
  git commit -qm "braindance: applier pass" >>"$LOG" 2>&1 || fail "git commit"
  git push -q origin "$BRANCH" >>"$LOG" 2>&1 || fail "git push"
fi
cat "$LOG"
