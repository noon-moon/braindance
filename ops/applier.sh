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

# CAN THIS USER ACTUALLY WRITE HERE? Checked first, and reported on stderr
# rather than through the usual failure note — because the failure note is a
# file in the vault, and a run that cannot write to the vault cannot write that
# either. Reporting a problem through the thing the problem breaks produced
# eight lines of git output and one "Permission denied" buried in the middle.
#
# The specific shape: `_triage/` owned by root while the vault around it was
# owned by the unit's user, after something ran once as root. Every pass then
# failed deep inside a rebase.
for d in "$VAULT" "$VAULT/_triage"; do
  [ -e "$d" ] || continue
  if [ ! -w "$d" ]; then
    me="$(id -un)"
    owner="$(stat -c %U "$d" 2>/dev/null || stat -f %Su "$d" 2>/dev/null)"
    mode="$(stat -c %a "$d" 2>/dev/null || stat -f %Lp "$d" 2>/dev/null)"
    echo "cannot write to $d" >&2
    echo "  running as: $me   owner: ${owner:-?}   mode: ${mode:-?}" >&2
    # Say which of the two it is rather than assuming — a directory can be
    # yours and still unwritable, and being told to chown something you already
    # own sends you looking in the wrong place.
    if [ "$owner" != "$me" ]; then
      echo "  fix: sudo chown -R $me $VAULT" >&2
    else
      echo "  fix: chmod u+w $d" >&2
    fi
    exit 1
  fi
done

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

commit_if_dirty() {
  [ -n "$(git status --porcelain)" ] || return 0
  git add -A >>"$LOG" 2>&1 && git commit -qm "$1" >>"$LOG" 2>&1
}

# COMMIT BEFORE PULLING. A rebase refuses to run against a dirty tree, so
# anything left lying around stopped the pass dead — including a failure note
# deleted by hand, which is the documented way to retry a stuck capture, and
# which is a tracked file. The instruction and the script disagreed.
#
# Committing rather than stashing, and the distinction matters: `vault-pull.sh`
# refuses to commit for the desk because a desk always carries half-written
# drafts. THIS box has no typist. The only things that appear here are the
# applier's own writes, the leftovers of a pass that died between writing and
# committing, and the occasional deliberate `rm` — all of which are real changes
# that belong in history rather than hidden in a stash that can fail to pop.
commit_if_dirty "braindance: local changes on $(hostname)"

git fetch -q origin "$BRANCH" >>"$LOG" 2>&1 || fail "git fetch"
git rebase -q "origin/$BRANCH" >>"$LOG" 2>&1 || fail "git rebase"

cd "$API" || fail "api directory"

# FIND NODE. systemd hands a unit a near-empty PATH — no shell profile, no
# nvm, none of what `which node` reports in your login shell. So a script that
# worked by hand failed under the timer with "node: command not found", which is
# the same failure as the env file and the vault path: behaviour that depended on
# who invoked it.
#
# Searched rather than configured, because the alternative is an
# `Environment=PATH=` line in the unit that is right on exactly one machine and
# silently wrong after the next node upgrade.
find_node() {
  [ -n "${BD_NODE:-}" ] && { echo "$BD_NODE"; return; }
  command -v node 2>/dev/null && return
  for c in /usr/local/bin/node /usr/bin/node /opt/homebrew/bin/node /snap/bin/node; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  # nvm keeps versions side by side; take the highest that is actually there.
  local nvm
  nvm="$(ls -d "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)"
  [ -n "$nvm" ] && [ -x "$nvm" ] && { echo "$nvm"; return; }
  return 1
}

NODE="$(find_node)" || fail "no node — looked on PATH, in /usr/local/bin, /usr/bin, /opt/homebrew/bin, /snap/bin and ${NVM_DIR:-$HOME/.nvm}/versions/node. Set BD_NODE in $ENV_FILE."
# npx and anything the tool shells out to needs it on PATH too, not just this
# one invocation.
export PATH="$(dirname "$NODE"):$PATH"

# COMPILED OUTPUT IF THERE IS ANY. At a one-minute cadence, re-transpiling the
# whole module graph on every run is pure waste — `npm ci && npm run build` once
# at deploy time and every pass is a plain `node`. tsx stays as the fallback
# because it is what a checkout has before anyone has built it, and a loop that
# refuses to run until someone remembers a build step is a loop that is off.
if [ -f dist/cli.js ]; then
  RUN=("$NODE" dist/cli.js)
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

commit_if_dirty "braindance: applier pass" || fail "git commit"

# Push on being AHEAD, not on having just committed: a pass that files nothing
# still has to send the commit made before the rebase, and one that failed to
# push last time has to catch up. "Is there anything origin lacks" is the
# question that covers both.
# RETRY A LOSING PUSH RATHER THAN REPORTING IT.
#
# There are three writers on this branch — this box and obsidian-git on the desk
# and the phone — and a pass holds its position for as long as two model calls
# take. Anything pushed in that window makes this push non-fast-forward. That is
# not a failure: the work is committed locally and correct, and the only thing
# behind is the sync.
#
# So re-fetch, rebase on top of what arrived, and try again. It is the same
# pull-rebase-retry the api's push queue used, for the same reason. Reporting it
# instead was measurably wrong: the first live collision wrote an alarm note into
# the vault for a pass that had just filed a note perfectly.
if [ -n "$(git rev-list "origin/$BRANCH..HEAD" 2>/dev/null)" ]; then
  pushed=""
  for attempt in 1 2 3; do
    if git push -q origin "$BRANCH" >>"$LOG" 2>&1; then pushed=1; break; fi
    echo "push $attempt lost a race; rebasing and retrying" >>"$LOG"
    git fetch -q origin "$BRANCH" >>"$LOG" 2>&1 || fail "git fetch (push retry)"
    # A conflict here is a real divergence and stops properly — that is a
    # decision for a person, never for a timer.
    git rebase -q "origin/$BRANCH" >>"$LOG" 2>&1 || fail "git rebase (push retry)"
  done
  [ -n "$pushed" ] || fail "git push"
fi
cat "$LOG"
