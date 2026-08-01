#!/usr/bin/env bash
# test_resolve.sh — behavior spec + tests for resolve.sh (the instance resolver).
# Mirrors the resolution ladder in docs/instances.md. Self-contained: builds a
# throwaway registry + territory tree under a temp dir, drives resolve.sh with
# controlled cwd / env, and asserts stdout + exit code. Run: ./test_resolve.sh
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESOLVE="$HERE/resolve.sh"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/bdresolve.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# --- fixture: two disjoint instances, personal (with a real git core) + work ---
REG="$TMP/registry"; mkdir -p "$REG/instances"
mkdir -p "$TMP/dev/braindance" "$TMP/dev/vault" "$TMP/dev/repo/loon/src" \
         "$TMP/work/braindance" "$TMP/work/vault" "$TMP/work/repo/app" \
         "$TMP/scratch"

cat > "$REG/instances/personal.conf" <<EOF
core  = $TMP/dev/braindance
vault = $TMP/dev/vault
repos = $TMP/dev/repo
EOF
cat > "$REG/instances/work.conf" <<EOF
core  = $TMP/work/braindance
vault = $TMP/work/vault
repos = $TMP/work/repo
EOF

# make personal.core a real repo with a worktree OUTSIDE every territory
git -C "$TMP/dev/braindance" init -q
git -C "$TMP/dev/braindance" -c user.email=t@e -c user.name=t commit -q --allow-empty -m init
git -C "$TMP/dev/braindance" worktree add -q "$TMP/scratch/wt-x" -b wt/x >/dev/null 2>&1
WT_X="$TMP/scratch/wt-x"

export BD_REGISTRY="$REG"

pass=0; fail=0
# Each test calls reset_env first, then sets any per-test env inline (no
# subshell — so run's OUT/RC/ERR persist to the assertions).
reset_env() { unset BD_USE VAULT_PATH REPOS_PATH BD_ACTIVE_INSTANCE; export BD_REGISTRY="$REG"; }
run() { OUT="$("$RESOLVE" "$1" 2>"$TMP/err")"; RC=$?; ERR="$(cat "$TMP/err")"; }
ok()   { pass=$((pass+1)); }
bad()  { fail=$((fail+1)); echo "FAIL: $1"; echo "  rc=$RC"; echo "  out=[$OUT]"; echo "  err=[$ERR]"; }
eq()   { if [ "$2" = "$3" ]; then ok; else bad "$1 (want [$3] got [$2])"; fi; }

emit() { # expected stdout for an instance, in _emit order
  printf 'BD_ACTIVE_INSTANCE=%s\nBD_CORE=%s\nVAULT_PATH=%s\nREPOS_PATH=%s' \
    "$1" "$2" "$3" "$4"
}
P="$(emit personal "$TMP/dev/braindance" "$TMP/dev/vault" "$TMP/dev/repo")"
W="$(emit work "$TMP/work/braindance" "$TMP/work/vault" "$TMP/work/repo")"

# 1. location: deep under personal.repos -> personal
reset_env; run "$TMP/dev/repo/loon/src"; eq "loc-personal-deep rc" "$RC" 0; eq "loc-personal-deep out" "$OUT" "$P"

# 2. location: under work.repos -> work
reset_env; run "$TMP/work/repo/app"; eq "loc-work rc" "$RC" 0; eq "loc-work out" "$OUT" "$W"

# 3. location: the core territory itself -> personal
reset_env; run "$TMP/dev/braindance"; eq "loc-core out" "$OUT" "$P"

# 4. location: the vault territory -> personal
reset_env; run "$TMP/dev/vault"; eq "loc-vault out" "$OUT" "$P"

# 5. worktree OUTSIDE territories -> resolves via git common-dir to personal.core
reset_env; run "$WT_X"; eq "worktree rc" "$RC" 0; eq "worktree out" "$OUT" "$P"

# 6. pin (BD_USE) wins over location
reset_env; export BD_USE=work; run "$TMP/dev/repo/loon"; eq "pin-wins out" "$OUT" "$W"

# 7. pin to a nonexistent instance -> error, exit 4
reset_env; export BD_USE=ghost; run "$TMP/dev/repo"; eq "pin-bad rc" "$RC" 4
case "$ERR" in *ghost*) ok;; *) bad "pin-bad err mentions name";; esac

# 8. step 0: preset VAULT_PATH, unstamped -> honor, no output, exit 0
reset_env; export VAULT_PATH=/somewhere/else; run "$TMP/dev/repo/loon"
eq "preset rc" "$RC" 0; eq "preset out" "$OUT" ""

# 9. stamped env (ours) is ignored -> re-resolves by location
reset_env; export VAULT_PATH=/stale BD_ACTIVE_INSTANCE=work; run "$TMP/dev/repo/loon"
eq "stamped re-resolve out" "$OUT" "$P"

# 10. no match, no default, instances exist -> stop, exit 3
reset_env; run "$TMP/scratch"; eq "unresolved rc" "$RC" 3
case "$ERR" in *"bd use"*) ok;; *) bad "unresolved err suggests bd use";; esac

# 11. default pointer used when cwd matches nothing
reset_env; echo personal > "$REG/default"
run "$TMP/scratch"; eq "default rc" "$RC" 0; eq "default out" "$OUT" "$P"
rm -f "$REG/default"

# 12. zero instances registered -> legacy no-op (no output, exit 0)
EMPTY="$TMP/empty-reg"; mkdir -p "$EMPTY/instances"
reset_env; export BD_REGISTRY="$EMPTY"; run "$TMP/dev/repo/loon"
eq "legacy rc" "$RC" 0; eq "legacy out" "$OUT" ""

echo "-----"
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
