#!/usr/bin/env bash
# Harness for ops/applier.sh.
#
# Every case below is a failure that actually happened on a live box, in one
# evening, on a script with no tests. That is the whole justification for this
# file: the loop it wraps has 231 checks and did not need a fix all evening,
# while the wrapper needed ten — arg parsing, the env file, node resolution, git
# refspecs, rebase ordering, orphan billing, push races, file ownership, and
# conflict resolution. The difference between them was not difficulty.
#
# It runs against throwaway repos and a STUB tool, so nothing here needs a
# network, an API key, or a vault. The stub stands in for `dist/cli.js` and is
# told what to do through the environment, which is enough to drive every branch
# the script has.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APPLIER="$HERE/applier.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0; fail=0
ok()   { printf '  ✓ %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  ✗ %s\n' "$1"; [ -n "${2:-}" ] && printf '      %s\n' "$2"; fail=$((fail+1)); }
check(){ if [ "$2" = "1" ]; then ok "$1"; else bad "$1" "${3:-}"; fi; }
has()  { case "$2" in *"$1"*) echo 1;; *) echo 0;; esac; }
# `check` asserts its second argument is 1, so "must NOT contain" needs saying
# explicitly rather than by passing 0 into the message slot — which is what the
# first draft of this file did, quietly turning four assertions into their
# opposite and still printing a tick for two of them.
lacks(){ case "$2" in *"$1"*) echo 0;; *) echo 1;; esac; }

# A vault, a remote it pushes to, and a second clone standing in for the phone.
new_vault() {
  local d="$WORK/$1"; rm -rf "$d"; mkdir -p "$d"
  git init -q --bare "$d/remote.git"
  git clone -q "$d/remote.git" "$d/vault" 2>/dev/null
  git -C "$d/vault" config user.email t@e.com; git -C "$d/vault" config user.name t
  mkdir -p "$d/vault/_triage"
  echo "a real note" > "$d/vault/real.md"
  git -C "$d/vault" add -A; git -C "$d/vault" commit -qm seed
  git -C "$d/vault" push -q origin HEAD:main; git -C "$d/vault" branch -M main
  git -C "$d/vault" branch --set-upstream-to=origin/main main >/dev/null 2>&1
  # the stub tool
  mkdir -p "$d/api/dist"
  cat > "$d/api/dist/cli.js" <<'STUB'
const fs = require("node:fs"), path = require("node:path");
const vault = process.env.VAULT_PATH;
const cmd = process.argv[2];
if (process.env.STUB_FAIL === cmd) { console.error(`stub: ${cmd} exploded`); process.exit(1); }
if (cmd === "propose" && process.env.STUB_PROPOSE) {
  fs.mkdirSync(path.join(vault, "_triage"), { recursive: true });
  fs.writeFileSync(path.join(vault, "_triage", "x.triage.md"), "a proposal\n");
}
if (cmd === "pass" && process.env.STUB_FILE) {
  fs.writeFileSync(path.join(vault, "filed.md"), "the filed note\n");
  fs.rmSync(path.join(vault, "_triage", "x.triage.md"), { force: true });
}
console.log(`stub ${cmd}`);
STUB
  printf 'ANTHROPIC_API_KEY=from-file\n# comment\nBD_LIMIT=7\nODD=a=b=c\n' > "$d/env"
  echo "$d"
}

run() { # run <dir> [extra env assignments...]
  local d="$1"; shift
  ( cd "$d" && env BD_ENV_FILE="$d/env" VAULT_PATH="$d/vault" BD_API="$d/api" "$@" bash "$APPLIER" 2>&1 )
}

echo "test: a clean pass with nothing to do"
d="$(new_vault clean)"
out="$(run "$d")"
check "it runs and says nothing failed" "$(has "stub propose" "$out")" "$out"
check "…and does not write an alarm note" "$([ -f "$d/vault/_triage/BRAINDANCE PASS FAILING.md" ] && echo 0 || echo 1)"
check "…and leaves the tree clean" "$([ -z "$(git -C "$d/vault" status --porcelain)" ] && echo 1 || echo 0)"

echo "test: the env file is read by the script, not just by systemd"
d="$(new_vault envfile)"
out="$(run "$d" STUB_FAIL=propose)"
check "no key warning — it found one in the env file" "$(lacks "no ANTHROPIC_API_KEY" "$out")" "$out"
out="$(run "$d" ANTHROPIC_API_KEY=already-set STUB_FAIL=propose)"
check "an already-set value wins over the file" "$(lacks "no ANTHROPIC_API_KEY" "$out")" "$out"

echo "test: it refuses to start when it cannot write"
d="$(new_vault perms)"
chmod 500 "$d/vault/_triage"
out="$(run "$d")"
chmod 700 "$d/vault/_triage"
check "it says which directory" "$(has "cannot write to" "$out")" "$out"
check "…and reports owner and mode rather than guessing" "$(has "mode:" "$out")" "$out"
check "…and stops BEFORE touching git" "$(lacks "stub propose" "$out")" "$out"

echo "test: a dirty tree is committed, not treated as an obstacle"
d="$(new_vault dirty)"
echo "left behind" > "$d/vault/leftover.md"
rm "$d/vault/real.md"          # the documented way to retry: delete a tracked file
out="$(run "$d")"
check "the pass completes" "$(has "stub pass" "$out")" "$out"
# `has` rather than `| grep -q`: this file runs under `pipefail`, and grep -q
# exits on the first match, so git gets SIGPIPE and the pipeline reports failure
# even though the string was found. That cost a real debugging detour here.
check "…and the leftovers are committed, not stashed" \
  "$(has "local changes" "$(git -C "$d/vault" log --oneline -5)")"

echo "test: it does not depend on the checkout's tracking config"
d="$(new_vault noupstream)"
git -C "$d/vault" branch --unset-upstream 2>/dev/null
out="$(run "$d" STUB_PROPOSE=1)"
check "an unset upstream still fetches and rebases" "$(has "stub pass" "$out")" "$out"
check "…and pushes what it made" \
  "$(git -C "$d/remote.git" cat-file -e main:_triage/x.triage.md 2>/dev/null && echo 1 || echo 0)"

echo "test: a detached HEAD fails by name"
d="$(new_vault detached)"
git -C "$d/vault" checkout -q --detach
out="$(run "$d")"
check "it says detached HEAD" "$(has "detached HEAD" "$out")" "$out"

echo "test: a push that loses a race is retried, not reported"
d="$(new_vault race)"
git clone -q "$d/remote.git" "$d/phone" 2>/dev/null
git -C "$d/phone" config user.email p@e.com; git -C "$d/phone" config user.name p
echo "from the phone" > "$d/phone/phone.md"
git -C "$d/phone" add -A; git -C "$d/phone" commit -qm phone; git -C "$d/phone" push -q origin HEAD:main
out="$(run "$d" STUB_PROPOSE=1)"
check "it succeeds despite the remote moving" "$(lacks "pass failed" "$out")" "$out"
check "…and both sides survive" \
  "$([ -f "$d/vault/phone.md" ] && [ -f "$d/vault/_triage/x.triage.md" ] && echo 1 || echo 0)"

echo "test: a conflict confined to _triage/ resolves by deletion"
d="$(new_vault triageconflict)"
git -C "$d/vault" push -q origin main
echo "a proposal" > "$d/vault/_triage/x.triage.md"
git -C "$d/vault" add -A; git -C "$d/vault" commit -qm proposal; git -C "$d/vault" push -q origin main
git clone -q "$d/remote.git" "$d/phone" 2>/dev/null
git -C "$d/phone" config user.email p@e.com; git -C "$d/phone" config user.name p
echo "my answer" > "$d/phone/_triage/x.triage.md"
git -C "$d/phone" add -A; git -C "$d/phone" commit -qm answered; git -C "$d/phone" push -q origin HEAD:main
out="$(run "$d" STUB_FILE=1)"
check "the pass completes" "$(lacks "pass failed" "$out")" "$out"
# THE case that `rebase --skip` destroyed: the filed note must survive.
check "THE FILED NOTE SURVIVES" "$([ -f "$d/vault/filed.md" ] && echo 1 || echo 0)"
check "…and the triage note is gone" "$([ -f "$d/vault/_triage/x.triage.md" ] && echo 0 || echo 1)"

echo "test: a conflict on a real note stops for a person"
d="$(new_vault realconflict)"
git clone -q "$d/remote.git" "$d/phone" 2>/dev/null
git -C "$d/phone" config user.email p@e.com; git -C "$d/phone" config user.name p
echo "their words" > "$d/phone/real.md"
git -C "$d/phone" add -A; git -C "$d/phone" commit -qm theirs; git -C "$d/phone" push -q origin HEAD:main
echo "our words" > "$d/vault/real.md"
out="$(run "$d")"
check "it stops" "$(has "pass failed at git rebase" "$out")" "$out"
check "…naming the path it would not decide" "$(has "conflict outside _triage/: real.md" "$out")" "$out"
check "…leaving no half-finished rebase" \
  "$([ -d "$d/vault/.git/rebase-merge" ] || [ -d "$d/vault/.git/rebase-apply" ] && echo 0 || echo 1)"
check "…and reporting into the vault" "$([ -f "$d/vault/_triage/BRAINDANCE PASS FAILING.md" ] && echo 1 || echo 0)"

echo "test: the alarm note accumulates, then clears itself"
d="$(new_vault alarm)"
run "$d" STUB_FAIL=propose >/dev/null
first="$(sed -n 's/^bd_since: *//p' "$d/vault/_triage/BRAINDANCE PASS FAILING.md")"
run "$d" STUB_FAIL=propose >/dev/null
n="$(sed -n 's/^bd_failures: *//p' "$d/vault/_triage/BRAINDANCE PASS FAILING.md")"
again="$(sed -n 's/^bd_since: *//p' "$d/vault/_triage/BRAINDANCE PASS FAILING.md")"
check "it counts consecutive failures" "$([ "$n" = "2" ] && echo 1 || echo 0)" "got $n"
check "…and keeps the time it STARTED failing" "$([ "$first" = "$again" ] && echo 1 || echo 0)"
check "…and names the stage" "$(has "bd_stage: propose" "$(cat "$d/vault/_triage/BRAINDANCE PASS FAILING.md")")"
check "…and pushed it, so it reaches a phone" \
  "$(git -C "$d/remote.git" cat-file -e "main:_triage/BRAINDANCE PASS FAILING.md" 2>/dev/null && echo 1 || echo 0)"
run "$d" >/dev/null
check "a good pass deletes it" "$([ -f "$d/vault/_triage/BRAINDANCE PASS FAILING.md" ] && echo 0 || echo 1)"
check "…and pushes the deletion" \
  "$(git -C "$d/remote.git" cat-file -e "main:_triage/BRAINDANCE PASS FAILING.md" 2>/dev/null && echo 0 || echo 1)"

echo "test: either half of the tool failing is named"
for stage in propose pass; do
  d="$(new_vault "stage-$stage")"
  out="$(run "$d" "STUB_FAIL=$stage")"
  check "a failing $stage says so" "$(has "pass failed at $stage" "$out")" "$out"
  check "…and carries the tool's own output" \
    "$(has "stub: $stage exploded" "$(cat "$d/vault/_triage/BRAINDANCE PASS FAILING.md")")"
done

echo "test: BD_NODE overrides how node is found"
d="$(new_vault nodepath)"
cat > "$d/mynode" <<EOF
#!/usr/bin/env bash
echo "custom node used"
exec "$(command -v node)" "\$@"
EOF
chmod +x "$d/mynode"
out="$(run "$d" BD_NODE="$d/mynode")"
check "the named binary is the one that runs" "$(has "custom node used" "$out")" "$out"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
