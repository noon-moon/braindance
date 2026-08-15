#!/usr/bin/env bash
# test_configure.sh — behavior spec + tests for configure.sh (instance register).
# Builds throwaway core/vault/repos trees + a temp registry, drives configure.sh,
# and asserts the registry it writes (and that resolve.sh then resolves it).
# Run: ./test_configure.sh
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIGURE="$HERE/configure.sh"
RESOLVE="$HERE/resolve.sh"

# Canonicalize TMP up front so $TMPDIR's /var -> /private/var symlink doesn't
# make expected (raw) paths differ from configure's canonicalized output.
TMP="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/bdconfig.XXXXXX")" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT

# Don't let the caller's real instance env leak into the default-resolution tests.
unset BD_ROOT VAULT_PATH REPOS_PATH BD_ACTIVE_INSTANCE BD_USE

pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; echo "  rc=$RC out=[$OUT] err=[$ERR]"; }
eq()  { if [ "$2" = "$3" ]; then ok; else bad "$1 (want [$3] got [$2])"; fi; }
# Registration/validation tests never touch the harness/rc — force --no-wire so
# they can't mutate the real ~/.claude/settings.json or shell rc.
run() { OUT="$("$CONFIGURE" "$@" --no-wire 2>"$TMP/err")"; RC=$?; ERR="$(cat "$TMP/err")"; }
run_wire() { OUT="$("$CONFIGURE" "$@" 2>"$TMP/err")"; RC=$?; ERR="$(cat "$TMP/err")"; }
val() { sed -n "s/^$2[[:space:]]*=[[:space:]]*//p" "$1"; }  # val <conf> <key>

fresh_reg() { REG="$TMP/reg.$RANDOM"; mkdir -p "$REG"; export BD_REGISTRY="$REG"; }
mk() { mkdir -p "$@"; }

# fixture territory trees
mk "$TMP/dev/braindance" "$TMP/dev/vault" "$TMP/dev/repo" \
   "$TMP/work/braindance" "$TMP/work/vault" "$TMP/work/repo"

# 1. fresh register writes a well-formed conf
fresh_reg
run --core "$TMP/dev/braindance" --vault "$TMP/dev/vault" --repos "$TMP/dev/repo" --name personal
eq "register rc" "$RC" 0
CF="$REG/instances/personal.conf"
if [ -f "$CF" ]; then ok; else bad "personal.conf written"; fi
eq "conf core"  "$(val "$CF" core)"  "$TMP/dev/braindance"
eq "conf vault" "$(val "$CF" vault)" "$TMP/dev/vault"
eq "conf repos" "$(val "$CF" repos)" "$TMP/dev/repo"

# 2. name defaults to basename(core)
fresh_reg
run --core "$TMP/dev/braindance" --vault "$TMP/dev/vault" --repos "$TMP/dev/repo"
eq "default-name rc" "$RC" 0
if [ -f "$REG/instances/braindance.conf" ]; then ok; else bad "default name = basename(core)"; fi

# 3. invalid name rejected
fresh_reg
run --core "$TMP/dev/braindance" --vault "$TMP/dev/vault" --repos "$TMP/dev/repo" --name "Bad Name"
if [ "$RC" -ne 0 ]; then ok; else bad "invalid name should fail"; fi

# 4. territories from env (BD_ROOT) when flags omitted
fresh_reg
BD_ROOT="$TMP/work" run --core "$TMP/work/braindance" --name work-env
CF="$REG/instances/work-env.conf"
eq "env vault" "$(val "$CF" vault)" "$TMP/work/vault"
eq "env repos" "$(val "$CF" repos)" "$TMP/work"

# 5. nested defaults when no flags/env
fresh_reg
run --core "$TMP/dev/braindance" --name nested
CF="$REG/instances/nested.conf"
eq "nested vault" "$(val "$CF" vault)" "$TMP/dev/braindance/ctx/vault"
eq "nested repos" "$(val "$CF" repos)" "$TMP/dev/braindance/repo"

# 6. disjointness: reject an instance whose repos nests under another's repos
fresh_reg
run --core "$TMP/dev/braindance" --vault "$TMP/dev/vault" --repos "$TMP/dev/repo" --name personal
eq "disjoint setup rc" "$RC" 0
mk "$TMP/dev/repo/nested-clone"
run --core "$TMP/dev/repo/nested-clone" --vault "$TMP/work/vault" --repos "$TMP/work/repo" --name intruder
if [ "$RC" -ne 0 ]; then ok; else bad "overlap should be rejected"; fi
if [ ! -f "$REG/instances/intruder.conf" ]; then ok; else bad "rejected instance must not be written"; fi
case "$ERR" in *personal*|*overlap*|*disjoint*) ok;; *) bad "overlap err explains conflict";; esac

# 7. disjointness ignores self -> idempotent update in place
fresh_reg
run --core "$TMP/dev/braindance" --vault "$TMP/dev/vault" --repos "$TMP/dev/repo" --name personal
run --core "$TMP/dev/braindance" --vault "$TMP/dev/vault2" --repos "$TMP/dev/repo" --name personal
eq "update rc" "$RC" 0
eq "update vault changed" "$(val "$REG/instances/personal.conf" vault)" "$TMP/dev/vault2"

# 7b. a rerun preserves keys this build does not write. The registry is shared
# by clones at different versions, so an older configure must not silently
# strip a newer one's settings (`worktrees` was the live case).
fresh_reg
run --core "$TMP/dev/braindance" --vault "$TMP/dev/vault" --repos "$TMP/dev/repo" --name personal
CF="$REG/instances/personal.conf"
printf 'worktrees = %s\n' "$TMP/dev/worktrees" >> "$CF"
printf 'future-key = somevalue\n' >> "$CF"
run --core "$TMP/dev/braindance" --vault "$TMP/dev/vault2" --repos "$TMP/dev/repo" --name personal
eq "rerun rc" "$RC" 0
eq "known key still updated" "$(val "$CF" vault)" "$TMP/dev/vault2"
eq "unknown key preserved"   "$(val "$CF" worktrees)" "$TMP/dev/worktrees"
eq "second unknown preserved" "$(val "$CF" future-key)" "somevalue"
eq "unknown key not duplicated" "$(grep -c '^worktrees' "$CF")" "1"
# Generic drift guard: a key added to the writer but left out of _OWNED_KEYS
# would be emitted twice — once written, once "preserved". Asserting it for
# every key catches future keys too, not just the ones that exist today.
eq "no key duplicated after rerun" \
   "$(grep -v '^#' "$CF" | grep -v '^[[:space:]]*$' | sed 's/[[:space:]]*=.*//' | sort | uniq -d | tr '\n' ' ')" \
   ""

# 8. --default writes the default pointer
fresh_reg
run --core "$TMP/dev/braindance" --vault "$TMP/dev/vault" --repos "$TMP/dev/repo" --name personal --default
eq "default file" "$(cat "$REG/default" 2>/dev/null)" "personal"

# 9. end-to-end: after configure, resolve.sh resolves by location
fresh_reg
run --core "$TMP/dev/braindance" --vault "$TMP/dev/vault" --repos "$TMP/dev/repo" --name personal
mk "$TMP/dev/repo/loon"
unset BD_USE VAULT_PATH REPOS_PATH BD_ACTIVE_INSTANCE
RESOLVED="$("$RESOLVE" "$TMP/dev/repo/loon" 2>/dev/null)"
case "$RESOLVED" in *"BD_ACTIVE_INSTANCE=personal"*) ok;; *) bad "resolve after configure (got [$RESOLVED])";; esac
case "$RESOLVED" in *"VAULT_PATH=$TMP/dev/vault"*) ok;; *) bad "resolve emits configured vault";; esac

# --- wiring (settings.json + rc) --------------------------------------------
# helper: python assertion over the settings JSON, prints OK/or a message
jqcheck() { python3 - "$1" "$2" ; }  # $1=settings path, $2=python expr over `s`

count_our_hooks() {  # $1=settings path -> "<SessionStart count> <PreToolUse count>"
  python3 - "$1" <<'PY'
import json, os, sys
s = json.load(open(sys.argv[1]))
OURS = {"resolve-instance.py", "block-cross-instance-writes.py"}
def n(ev):
    c = 0
    for g in s.get("hooks", {}).get(ev, []):
        c += sum(1 for h in g.get("hooks", []) if os.path.basename(h.get("command","")) in OURS)
    return c
print(n("SessionStart"), n("PreToolUse"))
PY
}

# 10. fresh wiring: creates settings with both hooks + sources wt.sh in rc
fresh_reg
S="$TMP/s.$RANDOM.json"; R="$TMP/rc.$RANDOM"
run_wire --core "$TMP/dev/braindance" --vault "$TMP/dev/vault" --repos "$TMP/dev/repo" \
         --name personal --settings "$S" --rc "$R"
eq "wire rc" "$RC" 0
eq "wire hook counts" "$(count_our_hooks "$S")" "1 1"
if grep -q 'ctx/tools/sys/wt.sh' "$R"; then ok; else bad "rc sources wt.sh"; fi
# the wired command paths point at this core's hooks
if grep -q "$TMP/dev/braindance/.claude/hooks/block-cross-instance-writes.py" "$S"; then ok; else bad "guard path wired"; fi

# 11. idempotent: re-run doesn't duplicate hooks, rc not re-added
run_wire --core "$TMP/dev/braindance" --vault "$TMP/dev/vault" --repos "$TMP/dev/repo" \
         --name personal --settings "$S" --rc "$R"
eq "wire idempotent counts" "$(count_our_hooks "$S")" "1 1"
eq "rc single source line" "$(grep -c 'ctx/tools/sys/wt.sh' "$R")" "1"

# 12. preserves pre-existing unrelated settings
fresh_reg
S="$TMP/s2.$RANDOM.json"; R="$TMP/rc2.$RANDOM"
printf '{\n  "permissions": { "allow": ["Bash(ls *)"] }\n}\n' > "$S"
run_wire --core "$TMP/dev/braindance" --vault "$TMP/dev/vault" --repos "$TMP/dev/repo" \
         --name personal --settings "$S" --rc "$R"
if python3 -c "import json,sys; s=json.load(open('$S')); sys.exit(0 if s.get('permissions',{}).get('allow')==['Bash(ls *)'] and s.get('hooks') else 1)"; then ok; else bad "preserves existing settings"; fi
if [ -f "$S.bak" ]; then ok; else bad "backup written before edit"; fi

# 13. --no-wire leaves settings/rc untouched
fresh_reg
S="$TMP/s3.$RANDOM.json"; R="$TMP/rc3.$RANDOM"
run --core "$TMP/dev/braindance" --vault "$TMP/dev/vault" --repos "$TMP/dev/repo" \
    --name personal --settings "$S" --rc "$R"
if [ ! -e "$S" ] && [ ! -e "$R" ]; then ok; else bad "--no-wire must not write settings/rc"; fi

# 14. rc already sourcing wt.sh -> not duplicated
fresh_reg
S="$TMP/s4.$RANDOM.json"; R="$TMP/rc4.$RANDOM"
printf 'source /somewhere/ctx/tools/sys/wt.sh\n' > "$R"
run_wire --core "$TMP/dev/braindance" --vault "$TMP/dev/vault" --repos "$TMP/dev/repo" \
         --name personal --settings "$S" --rc "$R"
eq "rc pre-sourced not duplicated" "$(grep -c 'ctx/tools/sys/wt.sh' "$R")" "1"

echo "-----"
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
