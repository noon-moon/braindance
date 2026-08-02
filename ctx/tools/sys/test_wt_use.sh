#!/usr/bin/env bash
# test_wt_use.sh — tests for the wt.sh shell integration: bd use / bd where /
# ls-instances and the chpwd auto-resolve. Sources wt.sh into this bash process,
# builds a throwaway registry via configure.sh, then drives the functions and
# asserts the exported env. Run: ./test_wt_use.sh
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/bdwtuse.XXXXXX")" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT

# clean env so the escape hatch / caller's real config doesn't interfere
unset BD_ROOT VAULT_PATH REPOS_PATH BD_ACTIVE_INSTANCE BD_USE
REG="$TMP/registry"; export BD_REGISTRY="$REG"

mkdir -p "$TMP/dev/braindance" "$TMP/dev/vault" "$TMP/dev/repo/loon" \
         "$TMP/work/braindance" "$TMP/work/vault" "$TMP/work/repo"
"$HERE/configure.sh" --core "$TMP/dev/braindance"  --vault "$TMP/dev/vault"  --repos "$TMP/dev/repo"  --name personal >/dev/null
"$HERE/configure.sh" --core "$TMP/work/braindance" --vault "$TMP/work/vault" --repos "$TMP/work/repo" --name work     >/dev/null

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

# 2. bd use work pins and switches, regardless of cwd
bd use work >/dev/null 2>&1
eq "use active" "${BD_ACTIVE_INSTANCE:-}" "work"
eq "use pin"    "${BD_USE:-}"             "work"
eq "use vault"  "${VAULT_PATH:-}"         "$TMP/work/vault"

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

echo "-----"
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
