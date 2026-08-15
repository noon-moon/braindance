#!/usr/bin/env bash
# test_wt_use.sh — tests for the wt.sh shell integration: bd use / bd where /
# ls-instances and the chpwd auto-resolve. Sources wt.sh into this bash process,
# builds a throwaway registry via configure.sh, then drives the functions and
# asserts the exported env. Run: ./test_wt_use.sh
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/bdwtuse.XXXXXX")" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT

# clean env so the escape hatch / caller's real config doesn't interfere.
# BD_CORE and BD_REPOS belong in this list: wt.sh keeps an inherited BD_CORE
# (`${BD_CORE:-...}`), so a caller whose shell exports a stale one — the normal
# state of any terminal opened before the core moved — points BD_RESOLVE at a
# path that no longer exists. _bd_apply then finds no executable resolver, exits
# 0 without exporting anything, and EVERY assertion below fails with an empty
# BD_ACTIVE_INSTANCE. That failure is environmental, not a real regression.
unset BD_ROOT BD_CORE BD_REPOS VAULT_PATH REPOS_PATH BD_WT BD_ACTIVE_INSTANCE BD_USE
REG="$TMP/registry"; export BD_REGISTRY="$REG"
# Defense in depth behind --no-wire below: if a future edit drops that flag, the
# wiring lands in $TMP rather than the developer's real settings.json.
export BD_SETTINGS="$TMP/settings.json"

mkdir -p "$TMP/dev/braindance" "$TMP/dev/vault" "$TMP/dev/repo/loon" \
         "$TMP/work/braindance" "$TMP/work/vault" "$TMP/work/repo"
# --no-wire is LOAD-BEARING: without it configure.sh wires the caller's REAL
# ~/.claude/settings.json and shell rc to point at this throwaway $TMP core,
# which the EXIT trap then deletes — leaving the developer's harness sourcing
# and exec'ing paths that no longer exist. This test only needs the registry.
"$HERE/configure.sh" --core "$TMP/dev/braindance"  --vault "$TMP/dev/vault"  --repos "$TMP/dev/repo"  --name personal --no-wire >/dev/null
"$HERE/configure.sh" --core "$TMP/work/braindance" --vault "$TMP/work/vault" --repos "$TMP/work/repo" --name work     --no-wire >/dev/null

# BD_CORE self-resolves from wt.sh's location (this worktree); resolve.sh sits
# beside it. Source with -u relaxed (wt.sh isn't written for nounset sourcing).
set +u; . "$HERE/wt.sh"; set -u

pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; echo "  ACTIVE=[${BD_ACTIVE_INSTANCE:-}] USE=[${BD_USE:-}] VAULT=[${VAULT_PATH:-}]"; }
eq()  { if [ "$2" = "$3" ]; then ok; else bad "$1 (want [$3] got [$2])"; fi; }

# 1. chpwd into personal territory activates personal
cd "$TMP/dev/repo/loon"; _bd_chpwd
eq "chpwd active"  "${BD_ACTIVE_INSTANCE:-}" "personal"
eq "chpwd vault"   "${VAULT_PATH:-}"         "$TMP/dev/vault"
eq "chpwd repos"   "${REPOS_PATH:-}"         "$TMP/dev/repo"
# BD_WT is part of the contract, so `bd new` cuts worktrees for THIS instance
eq "chpwd wt"      "${BD_WT:-}"              "$TMP/dev/worktrees"

# 2. bd use work pins and switches, regardless of cwd
bd use work >/dev/null 2>&1
eq "use active" "${BD_ACTIVE_INSTANCE:-}" "work"
eq "use pin"    "${BD_USE:-}"             "work"
eq "use vault"  "${VAULT_PATH:-}"         "$TMP/work/vault"
eq "use wt"     "${BD_WT:-}"              "$TMP/work/worktrees"

# 3. pin is sticky across cd into another instance's territory
cd "$TMP/dev/repo/loon"; _bd_chpwd
eq "pin sticky over cd" "${BD_ACTIVE_INSTANCE:-}" "work"

# 4. bd use --auto clears the pin and re-resolves by location (now personal)
bd use --auto >/dev/null 2>&1
eq "auto clears pin"    "${BD_USE:-}"             ""
eq "auto re-resolves"   "${BD_ACTIVE_INSTANCE:-}" "personal"

# 5. sticky: cd to a neutral dir (no territory) leaves the active instance in place
cd "$TMP"; _bd_chpwd
eq "neutral dir sticky" "${BD_ACTIVE_INSTANCE:-}" "personal"

# 6. bd where reports the active instance
W="$(cd "$TMP/dev/repo/loon" && _bd_chpwd; bd where)"
case "$W" in *"instance: personal"*) ok;; *) bad "where reports personal (got: $W)";; esac
case "$W" in *"worktrees = $TMP/dev/worktrees"*) ok;; *) bad "where reports worktrees (got: $W)";; esac

# 7. ls-instances lists both, marks active + default
echo personal > "$REG/default"
L="$(bd ls-instances)"
case "$L" in *personal*) ok;; *) bad "ls-instances lists personal";; esac
case "$L" in *work*) ok;; *) bad "ls-instances lists work";; esac
case "$L" in *"(default)"*) ok;; *) bad "ls-instances marks default";; esac

# 8. bad pin fails, does not leave a stale pin
cd "$TMP/dev/repo/loon"; _bd_chpwd   # active personal
if bd use ghost >/dev/null 2>&1; then bad "bad pin should fail"; else ok; fi
eq "bad pin no stale BD_USE" "${BD_USE:-}" ""
eq "bad pin keeps prior active" "${BD_ACTIVE_INSTANCE:-}" "personal"

# 9. a stale exported BD_CORE must not disable the resolver. wt.sh keeps an
# inherited BD_CORE, so locating resolve.sh under it would aim at nothing in any
# shell opened before a core move — and _bd_apply would export nothing at all.
# The scrub is what gives this test teeth: earlier cases leave BD_ACTIVE_INSTANCE
# exported, and an inherited value would survive a no-op _bd_apply — so the
# assertion would pass with the bug fully present.
OUT9="$(env -u BD_ACTIVE_INSTANCE -u BD_USE -u VAULT_PATH -u REPOS_PATH -u BD_WT \
        BD_CORE=/nonexistent/core BD_REGISTRY="$REG" bash -c "
  cd '$TMP/dev/repo/loon'
  set +u; . '$HERE/wt.sh'; set -u
  printf '%s' \"\${BD_ACTIVE_INSTANCE:-}\"" 2>/dev/null)"
eq "stale BD_CORE still resolves" "$OUT9" "personal"

# 10. `bd where` must make the escape hatch legible: dead paths marked, and the
# registry's own answer shown, so a shadowing env is not misread as a stale
# registry (the two are otherwise indistinguishable at the point of use).
# BD_ACTIVE_INSTANCE must be unset for step 0 to fire at all — with it set the
# resolver treats the env as its own stamp and re-resolves normally.
OUT10="$(env -u BD_ACTIVE_INSTANCE -u BD_USE -u BD_WT \
         VAULT_PATH=/nope/vault REPOS_PATH=/nope/repos BD_REGISTRY="$REG" bash -c "
  cd '$TMP/dev/repo/loon'
  set +u; . '$HERE/wt.sh'; set -u
  bd where" 2>/dev/null)"
case "$OUT10" in *"(MISSING)"*) ok;; *) bad "where marks dead paths (got: $OUT10)";; esac
case "$OUT10" in *"registry here says: personal"*) ok;; *) bad "where reports shadowed registry (got: $OUT10)";; esac

# 11. a live path is NOT marked — the marker must mean something
case "$(cd "$TMP/dev/repo/loon" && _bd_chpwd; bd where)" in
  *"$TMP/dev/vault  (MISSING)"*) bad "live path wrongly marked MISSING";;
  *) ok;;
esac

echo "-----"
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
