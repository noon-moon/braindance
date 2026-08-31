#!/usr/bin/env bash
# test_vault-push.sh — behavior spec for vault-push.sh.
#
# The properties worth pinning are the SAFETY ones, same as its sibling. This
# thing commits your notes unattended, so the tests that matter are the ones
# asserting WHEN IT REFUSES TO: while you are still typing, when a rename is
# only half-settled, when a rebase would conflict. A regression in "did it
# publish" shows up the next time you look at your phone; a regression in "did
# it publish half a rename" looks like a note that vanished.
#
# Debounce is exercised by passing it explicitly rather than by sleeping: a
# huge value means "everything is fresh", zero means "everything is settled".
#
# Self-contained: throwaway origin + desk clone + a second clone standing in for
# the phone. Run: ./test_vault-push.sh
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUSH="$HERE/vault-push.sh"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/bdvaultpush.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

PASS=0; FAIL=0
check() { # check <desc> <condition-result>
  if [ "$2" = "0" ]; then printf '  ✓ %s\n' "$1"; PASS=$((PASS+1))
  else printf '  ✗ %s\n' "$1"; FAIL=$((FAIL+1)); fi
}
git_q() { git -C "$1" "${@:2}" >/dev/null 2>&1; }

# --- fixture: bare origin, a "desk" clone, a "phone" clone ------------------
ORIGIN="$TMP/origin.git"; DESK="$TMP/desk"; PHONE="$TMP/phone"
git init -q --bare "$ORIGIN"
git clone -q "$ORIGIN" "$PHONE" 2>/dev/null
git -C "$PHONE" config user.email t@example.com; git -C "$PHONE" config user.name t
printf 'one\n' > "$PHONE/note.md"
printf '_ephemeral/\n' > "$PHONE/.gitignore"
git_q "$PHONE" add -A; git_q "$PHONE" commit -m init
git_q "$PHONE" push origin HEAD:main
git clone -q -b main "$ORIGIN" "$DESK"
git -C "$DESK" config user.email t@example.com; git -C "$DESK" config user.name t
git_q "$PHONE" checkout -B main; git_q "$PHONE" branch --set-upstream-to=origin/main

export BD_VAULT_PUSH_STATE_DIR="$TMP/state"; mkdir -p "$BD_VAULT_PUSH_STATE_DIR"
run() { VAULT_PATH="$DESK" bash "$PUSH" --debounce "${1:-0}" 2>&1; }
stamp_outcome() { cut -d' ' -f2 < "$BD_VAULT_PUSH_STATE_DIR/braindance-vault-push.last" 2>/dev/null; }
origin_head() { git -C "$ORIGIN" rev-parse main 2>/dev/null; }

echo "test: STILL TYPING — a fresh change is never committed"
printf 'half a thou' > "$DESK/wip.md"
before="$(origin_head)"
out="$(run 99999)"; rc=$?
check "exits 2 (skipped, not failed)" "$([ $rc -eq 2 ] && echo 0 || echo 1)"
check "says it is waiting" "$(echo "$out" | grep -q 'still typing' && echo 0 || echo 1)"
check "NOTHING was committed" "$([ -n "$(git -C "$DESK" status --porcelain)" ] && echo 0 || echo 1)"
check "the remote did not move" "$([ "$before" = "$(origin_head)" ] && echo 0 || echo 1)"

echo "test: settled work commits and publishes"
out="$(run 0)"; rc=$?
check "exits 0" "$([ $rc -eq 0 ] && echo 0 || echo 1)"
check "reports publishing" "$(echo "$out" | grep -q 'published' && echo 0 || echo 1)"
check "the desk tree is now clean" "$([ -z "$(git -C "$DESK" status --porcelain)" ] && echo 0 || echo 1)"
check "the remote actually moved" "$([ "$before" != "$(origin_head)" ] && echo 0 || echo 1)"
check "commit is marked machine-made (autosave:)" \
  "$(git -C "$DESK" log -1 --format=%s | grep -q '^autosave:' && echo 0 || echo 1)"

echo "test: A STEADY STATE IS SILENT — the log records changes, not ticks"
# The FIRST idle run is the transition out of `pushed`, so it legitimately logs.
out="$(run 0)"
check "the transition into idle is reported once" \
  "$(echo "$out" | grep -q 'nothing to publish' && echo 0 || echo 1)"
o1="$(run 0)"; o2="$(run 0)"; o3="$(run 0)"
check "repeat idle runs print nothing" "$([ -z "$o1$o2$o3" ] && echo 0 || echo 1)"
check "…but the stamp still refreshes, so liveness is visible" \
  "$([ "$(stamp_outcome)" = "uptodate" ] && echo 0 || echo 1)"

echo "test: IGNORED CHURN NEVER BECOMES A COMMIT"
mkdir -p "$DESK/_ephemeral"; printf 'scratch\n' > "$DESK/_ephemeral/junk.md"
before="$(git -C "$DESK" rev-parse HEAD)"
run 0 >/dev/null 2>&1
check "no commit was made for ignored files" \
  "$([ "$before" = "$(git -C "$DESK" rev-parse HEAD)" ] && echo 0 || echo 1)"

echo "test: A HALF-SETTLED RENAME IS NEVER SPLIT"
# Obsidian renames as delete + add. If the add is fresh, publishing the delete
# alone would show the note as gone on the phone. Quiet means the WHOLE tree.
git_q "$DESK" mv note.md renamed.md
touch "$DESK/renamed.md"                     # the new half is brand new
before="$(origin_head)"
out="$(run 99999)"; rc=$?
check "exits 2" "$([ $rc -eq 2 ] && echo 0 || echo 1)"
check "holds the whole rename, not just the deletion" \
  "$([ "$before" = "$(origin_head)" ] && echo 0 || echo 1)"
check "the deletion is still uncommitted" \
  "$(git -C "$DESK" status --porcelain | grep -q 'renamed.md' && echo 0 || echo 1)"
run 0 >/dev/null 2>&1
check "…and once settled, both halves publish together" \
  "$(git -C "$ORIGIN" ls-tree --name-only main | grep -q '^renamed.md$' && echo 0 || echo 1)"
check "…with the old path gone from the remote" \
  "$(git -C "$ORIGIN" ls-tree --name-only main | grep -qv '^note.md$' && echo 0 || echo 1)"

echo "test: the phone's commits and the desk's INTERLEAVE (rebase, not diverge)"
git_q "$PHONE" pull --rebase
printf 'from the phone\n' > "$PHONE/phone.md"
git_q "$PHONE" add -A; git_q "$PHONE" commit -m "phone capture"; git_q "$PHONE" push origin HEAD:main
printf 'from the desk\n' > "$DESK/desk.md"
out="$(run 0)"; rc=$?
check "exits 0" "$([ $rc -eq 0 ] && echo 0 || echo 1)"
check "both notes are on the remote" \
  "$(git -C "$ORIGIN" ls-tree --name-only main | grep -q '^phone.md$' &&
     git -C "$ORIGIN" ls-tree --name-only main | grep -q '^desk.md$' && echo 0 || echo 1)"
check "history is linear — rebased, not merged" \
  "$([ "$(git -C "$DESK" rev-list --count --merges HEAD)" = "0" ] && echo 0 || echo 1)"

echo "test: A REBASE CONFLICT PAUSES SYNC — it never picks a side"
git_q "$PHONE" pull --rebase
printf 'phone version\n' > "$PHONE/clash.md"
git_q "$PHONE" add -A; git_q "$PHONE" commit -m "phone edit"; git_q "$PHONE" push origin HEAD:main
printf 'desk version\n' > "$DESK/clash.md"
remote_before="$(origin_head)"
out="$(run 0)"; rc=$?
check "exits 2 (paused, not failed)" "$([ $rc -eq 2 ] && echo 0 || echo 1)"
check "says the rebase conflicted" "$(echo "$out" | grep -q 'REBASE CONFLICT' && echo 0 || echo 1)"
check "the remote was NOT force-moved" "$([ "$remote_before" = "$(origin_head)" ] && echo 0 || echo 1)"
check "no rebase is left in progress" \
  "$([ ! -d "$DESK/.git/rebase-merge" ] && [ ! -d "$DESK/.git/rebase-apply" ] && echo 0 || echo 1)"
check "the desk's own version survives untouched" \
  "$(grep -q 'desk version' "$DESK/clash.md" && echo 0 || echo 1)"
check "the local commit is still there to resolve" \
  "$(git -C "$DESK" log -1 --format=%s | grep -q '^autosave:' && echo 0 || echo 1)"

echo "test: no upstream -> skips rather than guessing a remote"
NOUP="$TMP/noup"; git init -q "$NOUP"
git -C "$NOUP" config user.email t@example.com; git -C "$NOUP" config user.name t
printf 'x\n' > "$NOUP/a.md"; git_q "$NOUP" add -A; git_q "$NOUP" commit -m init
out="$(VAULT_PATH="$NOUP" bash "$PUSH" --debounce 0 2>&1)"; rc=$?
check "exits 2" "$([ $rc -eq 2 ] && echo 0 || echo 1)"
check "says there is no upstream" "$(echo "$out" | grep -q 'no upstream' && echo 0 || echo 1)"

echo "test: not a git checkout -> a clear error, exit 1"
mkdir -p "$TMP/plain"
out="$(VAULT_PATH="$TMP/plain" bash "$PUSH" --debounce 0 2>&1)"; rc=$?
check "exits 1" "$([ $rc -eq 1 ] && echo 0 || echo 1)"
check "names the problem" "$(echo "$out" | grep -q 'not a git checkout' && echo 0 || echo 1)"

printf '\n-----\npassed=%s failed=%s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
