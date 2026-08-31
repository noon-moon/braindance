#!/usr/bin/env bash
# test_vault-pull.sh — behavior spec for vault-pull.sh.
#
# The properties worth pinning are the SAFETY ones. This thing runs unattended on
# a timer against a vault that always has uncommitted work in it, so the tests
# that matter are the ones asserting what it refuses to do: never commit, never
# stash, never discard, never resolve a divergence on its own. A regression in
# "did it fast-forward" is visible the next time you look; a regression in "did
# it eat my draft" is not.
#
# Self-contained: builds throwaway origin + clone under a temp dir, drives the
# script with VAULT_PATH pointed at the clone. Run: ./test_vault-pull.sh
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PULL="$HERE/vault-pull.sh"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/bdvaultpull.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

PASS=0; FAIL=0
check() { # check <desc> <condition-result>
  if [ "$2" = "0" ]; then printf '  ✓ %s\n' "$1"; PASS=$((PASS+1))
  else printf '  ✗ %s\n' "$1"; FAIL=$((FAIL+1)); fi
}

git_q() { git -C "$1" "${@:2}" >/dev/null 2>&1; }

# --- fixture: a bare origin, a "desk" clone standing in for the local vault ---
ORIGIN="$TMP/origin.git"; DESK="$TMP/desk"; OTHER="$TMP/other"
git init -q --bare "$ORIGIN"
git clone -q "$ORIGIN" "$OTHER"
git -C "$OTHER" config user.email t@example.com; git -C "$OTHER" config user.name t
printf 'one\n' > "$OTHER/note.md"; printf 'draft\n' > "$OTHER/wip.md"
git_q "$OTHER" add note.md wip.md; git_q "$OTHER" commit -m init
git_q "$OTHER" push origin HEAD:main
git clone -q -b main "$ORIGIN" "$DESK"
git -C "$DESK" config user.email t@example.com; git -C "$DESK" config user.name t

# Isolate the stamp/log so the tests never read or write the real state dir.
export BD_VAULT_PULL_STATE_DIR="$TMP/state"
mkdir -p "$BD_VAULT_PULL_STATE_DIR"
run() { VAULT_PATH="$DESK" bash "$PULL" --pull 2>&1; }
stamp_outcome() { cut -d' ' -f2 < "$BD_VAULT_PULL_STATE_DIR/braindance-vault-pull.last" 2>/dev/null; }

echo "test: pulls when the remote has moved and the desk is clean"
printf 'two\n' >> "$OTHER/note.md"
git_q "$OTHER" commit -am second; git_q "$OTHER" push origin HEAD:main
out="$(run)"; rc=$?
check "exits 0" "$([ $rc -eq 0 ] && echo 0 || echo 1)"
check "reports the fast-forward" "$(echo "$out" | grep -q 'fast-forwarded' && echo 0 || echo 1)"
check "the new content actually arrived" "$(grep -q two "$DESK/note.md" && echo 0 || echo 1)"

echo "test: a second run with nothing to do reports the transition once"
out="$(run)"; rc=$?
check "exits 0" "$([ $rc -eq 0 ] && echo 0 || echo 1)"
check "says up to date" "$(echo "$out" | grep -q 'up to date' && echo 0 || echo 1)"

echo "test: A STEADY STATE IS SILENT — the log records changes, not ticks"
# At a 30s cadence a line per run is thousands of identical entries a day. Only
# the transition INTO a state is logged; repeats of it say nothing.
out3="$(run)"; out4="$(run)"; out5="$(run)"
check "repeat runs print nothing at all" "$([ -z "$out3$out4$out5" ] && echo 0 || echo 1)"
check "…but they still exit 0" "$([ $? -eq 0 ] && echo 0 || echo 1)"
check "…and the stamp is refreshed every run, so liveness is still visible" \
  "$([ "$(stamp_outcome)" = "uptodate" ] && echo 0 || echo 1)"

echo "test: UNCOMMITTED WORK IS NEVER TOUCHED — the whole point of the tool"
printf 'my unsaved thought\n' >> "$DESK/wip.md"      # dirty, and the remote is about to move the SAME file
before="$(cat "$DESK/wip.md")"
printf 'remote edit\n' >> "$OTHER/wip.md"
git_q "$OTHER" commit -am "remote touches wip"; git_q "$OTHER" push origin HEAD:main
out="$(run)"; rc=$?
check "exits 2 (skipped, not failed)" "$([ $rc -eq 2 ] && echo 0 || echo 1)"
check "explains that local edits overlap" "$(echo "$out" | grep -q 'held back' && echo 0 || echo 1)"
check "the uncommitted draft is BYTE-IDENTICAL" "$([ "$(cat "$DESK/wip.md")" = "$before" ] && echo 0 || echo 1)"
check "it did not commit the draft" "$(git -C "$DESK" status --porcelain | grep -q '^ M wip.md' && echo 0 || echo 1)"
check "it did not stash the draft" "$([ -z "$(git -C "$DESK" stash list)" ] && echo 0 || echo 1)"

echo "test: a repeated hold is silent too, but a fast-forward always logs"
out_a="$(run)"
check "the second consecutive hold prints nothing" "$([ -z "$out_a" ] && echo 0 || echo 1)"
check "stamp still shows the hold" "$([ "$(stamp_outcome)" = "held" ] && echo 0 || echo 1)"

echo "test: …and it clears itself once the overlap is gone, with no intervention"
git_q "$DESK" checkout -- wip.md
out="$(run)"; rc=$?
check "exits 0" "$([ $rc -eq 0 ] && echo 0 || echo 1)"
check "fast-forwarded on the next run" "$(echo "$out" | grep -q 'fast-forwarded' && echo 0 || echo 1)"

echo "test: a real divergence is REPORTED, never merged on a timer"
printf 'desk-only\n' > "$DESK/desk.md"
git_q "$DESK" add desk.md; git_q "$DESK" commit -m "desk commit"
printf 'remote-only\n' > "$OTHER/remote.md"
git_q "$OTHER" add remote.md; git_q "$OTHER" commit -m "remote commit"; git_q "$OTHER" push origin HEAD:main
head_before="$(git -C "$DESK" rev-parse HEAD)"
out="$(run)"; rc=$?
check "exits 2" "$([ $rc -eq 2 ] && echo 0 || echo 1)"
check "says DIVERGED" "$(echo "$out" | grep -q 'DIVERGED' && echo 0 || echo 1)"
check "HEAD did not move — no silent merge" "$([ "$(git -C "$DESK" rev-parse HEAD)" = "$head_before" ] && echo 0 || echo 1)"
check "no merge commit was created" "$([ -z "$(git -C "$DESK" log --merges --oneline)" ] && echo 0 || echo 1)"
check "the local commit is still there" "$(git -C "$DESK" log --oneline | grep -q 'desk commit' && echo 0 || echo 1)"

echo "test: it never pushes — publishing stays deliberate"
check "origin still lacks the desk-only commit" "$(git -C "$ORIGIN" log --oneline --all | grep -q 'desk commit' && echo 1 || echo 0)"

echo "test: a missing or non-git vault fails loudly rather than silently"
out="$(VAULT_PATH="$TMP/nope" bash "$PULL" --pull 2>&1)"; rc=$?
check "missing vault exits 1" "$([ $rc -eq 1 ] && echo 0 || echo 1)"
mkdir -p "$TMP/plain"
out="$(VAULT_PATH="$TMP/plain" bash "$PULL" --pull 2>&1)"; rc=$?
check "non-git dir exits 1" "$([ $rc -eq 1 ] && echo 0 || echo 1)"
check "…and says so" "$(echo "$out" | grep -q 'not a git checkout' && echo 0 || echo 1)"


echo "test: it defers only to a tool that will COMMIT what is on disk"
# The mechanism this guards: obsidian-git commits, THEN pulls, then pushes. A
# stale working tree is captured in the commit before any pull can correct it,
# so `pullBeforePush` cannot help. That is how a 43-file migration was reverted
# by a `vault backup` commit descending from the migration itself.
#
# Auto-commit off and there is nothing to defer to. The default is to PULL,
# because the two failures are not equal: pulling behind a tool that overwrites
# costs a revert git remembers, while not pulling costs silent staleness — the
# very thing this script exists to prevent.
eval "$(sed -n '/^obsidian_autocommits()/,/^}/p' "$PULL")"
mkgit() {
  local v; v="$(mktemp -d)"; mkdir -p "$v/.obsidian/plugins/obsidian-git"
  printf '["obsidian-git"]' > "$v/.obsidian/community-plugins.json"
  printf '%s' "$1" > "$v/.obsidian/plugins/obsidian-git/data.json"; echo "$v"
}
verdict() { obsidian_autocommits "$1" && echo defer || echo pull; }

if pgrep -x Obsidian >/dev/null 2>&1; then
  V="$(mkgit '{"autoSaveInterval":5}')"
  check "auto-commit on a timer defers" "$([ "$(verdict "$V")" = defer ] && echo 0 || echo 1)"
  V="$(mkgit '{"autoSaveInterval":0,"autoBackupAfterFileChange":true}')"
  check "commit-on-change defers too" "$([ "$(verdict "$V")" = defer ] && echo 0 || echo 1)"
  V="$(mkgit '{"autoSaveInterval":0}')"
  check "auto-commit off pulls" "$([ "$(verdict "$V")" = pull ] && echo 0 || echo 1)"
  # The live configuration at the time this was written: pushing every minute
  # with pullBeforePush, but never committing. Nothing can launder staleness.
  V="$(mkgit '{"autoSaveInterval":0,"autoPushInterval":1,"pullBeforePush":true}')"
  check "push-only, no auto-commit, pulls" "$([ "$(verdict "$V")" = pull ] && echo 0 || echo 1)"
  V="$(mkgit 'not json at all')"
  check "unreadable settings pull — cannot tell means pull" "$([ "$(verdict "$V")" = pull ] && echo 0 || echo 1)"
  V="$(mkgit '{"autoSaveInterval":5}')"; rm "$V/.obsidian/community-plugins.json"
  check "plugin not enabled pulls" "$([ "$(verdict "$V")" = pull ] && echo 0 || echo 1)"
  V="$(mkgit '{"autoSaveInterval":5}')"; rm "$V/.obsidian/plugins/obsidian-git/data.json"
  check "no settings file pulls" "$([ "$(verdict "$V")" = pull ] && echo 0 || echo 1)"
else
  echo "  · skipped — Obsidian is not running, so the pgrep gate short-circuits every case"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
