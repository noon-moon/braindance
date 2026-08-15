#!/usr/bin/env bash
# configure.sh — register THIS braindance clone as an instance (the "one command
# in the root" of the multi-instance model; see docs/instances.md).
#
# Run from a clone's root:  ./configure [options]   (the root `configure` wrapper
# execs this). Records the clone's three territories into the user-global
# registry that resolve.sh reads, after validating the disjoint-territory
# invariant. Idempotent: re-running with the same --name updates in place.
#
# Options:
#   --name <name>     instance name (default: basename of core). [a-z0-9-]+
#   --core <path>     the checkout (default: $PWD)
#   --vault <path>    knowledge base (default: $VAULT_PATH | $BD_ROOT/vault | <core>/ctx/vault)
#   --repos <path>    repos dir     (default: $REPOS_PATH | $BD_ROOT | <core>/repo)
#   --worktrees <p>   agent worktrees (default: $BD_WT | $BD_ROOT/worktrees | <core>/../worktrees)
#   --default         also set this instance as the registry `default` pointer
#   --registry <dir>  registry location (default: $BD_REGISTRY | ~/.config/braindance)
#   --no-wire         register only; skip installing the hook/shell wiring
#   --settings <path> harness settings.json to wire (default: ~/.claude/settings.json)
#   --rc <path>       shell rc to source wt.sh from (default: the current shell's rc)
#
# Exit: 0 = registered/updated. Non-zero = validation failed (nothing written).
#
# Wiring (unless --no-wire) is idempotent and installs, machine-wide:
#   - SessionStart + PreToolUse (cross-instance guard) hooks into settings.json
#   - `source <core>/ctx/tools/sys/wt.sh` into the shell rc (chpwd auto-resolve)
# It NEVER edits your exported BD_ROOT/VAULT_PATH/REPOS_PATH — those keep the
# resolver dormant (escape hatch); configure warns if it finds them.
set -u

name=""; core=""; vault=""; repos=""; worktrees=""; set_default=""; no_wire=""
REG="${BD_REGISTRY:-${XDG_CONFIG_HOME:-$HOME/.config}/braindance}"
SETTINGS="${BD_SETTINGS:-$HOME/.claude/settings.json}"
RC=""

die() { printf 'configure: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --name)     name="${2:-}"; shift 2 ;;
    --core)     core="${2:-}"; shift 2 ;;
    --vault)    vault="${2:-}"; shift 2 ;;
    --repos)    repos="${2:-}"; shift 2 ;;
    --worktrees) worktrees="${2:-}"; shift 2 ;;
    --registry) REG="${2:-}"; shift 2 ;;
    --settings) SETTINGS="${2:-}"; shift 2 ;;
    --rc)       RC="${2:-}"; shift 2 ;;
    --default)  set_default=1; shift ;;
    --no-wire)  no_wire=1; shift ;;
    -h|--help)  sed -n '2,25p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

_canon() {  # canonical absolute path (resolves symlinks for existing dirs)
  local p="$1"
  if [ -d "$p" ]; then ( cd "$p" 2>/dev/null && pwd -P ); return; fi
  case "$p" in
    /*) printf '%s\n' "${p%/}" ;;
    *)  printf '%s\n' "$(pwd -P)/${p#./}" ;;
  esac
}
_under() { [ "$1" = "$2" ] || [ "${1#"$2"/}" != "$1" ]; }  # $1 == $2 or under $2/

# --- resolve this instance's territories (mirrors the single-root model) ---
core="$(_canon "${core:-$PWD}")"
[ -d "$core" ] || die "core is not a directory: $core"
vault="${vault:-${VAULT_PATH:-${BD_ROOT:+$BD_ROOT/vault}}}"; vault="${vault:-$core/ctx/vault}"
repos="${repos:-${REPOS_PATH:-${BD_ROOT:-$core/repo}}}"
# Worktrees are never nested in the core (a worktree inside its own checkout) nor
# in the vault (Obsidian would index every agent branch) — so the last-resort
# default is a sibling of the core, matching resolve.sh's _wt_default.
worktrees="${worktrees:-${BD_WT:-${BD_ROOT:+$BD_ROOT/worktrees}}}"
worktrees="${worktrees:-$(dirname "$core")/worktrees}"
vault="$(_canon "$vault")"; repos="$(_canon "$repos")"; worktrees="$(_canon "$worktrees")"

name="${name:-$(basename "$core")}"
case "$name" in
  *[!a-z0-9-]*|"") die "invalid instance name '$name' — use [a-z0-9-]+" ;;
esac

INST_DIR="$REG/instances"

# --- disjointness: no territory may equal-or-nest another INSTANCE's territory ---
if [ -d "$INST_DIR" ]; then
  for f in "$INST_DIR"/*.conf; do
    [ -e "$f" ] || continue
    other="$(basename "$f" .conf)"
    [ "$other" != "$name" ] || continue          # self -> idempotent update
    oc=""; ov=""; orp=""
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in \#*|"") continue ;; esac
      k="${line%%=*}"; v="${line#*=}"
      k="${k#"${k%%[![:space:]]*}"}"; k="${k%"${k##*[![:space:]]}"}"
      v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"
      case "$k" in core) oc="$v" ;; vault) ov="$v" ;; repos) orp="$v" ;; esac
    done < "$f"
    for mine in "$core" "$vault" "$repos"; do
      for theirs in "$oc" "$ov" "$orp"; do
        [ -n "$theirs" ] || continue
        tc="$(_canon "$theirs")"
        if _under "$mine" "$tc" || _under "$tc" "$mine"; then
          die "territory overlap with instance '$other': $mine <-> $tc (territories must be disjoint)"
        fi
      done
    done
  done
fi

# Re-emit any keys in an existing conf that this build does not write itself.
# One registry is shared by every clone on the machine, and those clones can be
# at different versions: a newer configure records settings an older one has
# never heard of. A fixed template would silently drop them on the next rerun
# from the older checkout — a downgrade nobody asked for and nothing reports.
# Preserving unknown keys verbatim makes the rewrite lossless in both
# directions, so the only key configure can remove is one it deliberately owns.
#
# The owned set is declared once, here, and drives both the skip below and
# nothing else — so teaching configure a new key means adding it to the writer
# AND to this list. Keeping it as data rather than a hardcoded `case` is what
# stops the two drifting: a key written but not listed would be emitted twice,
# once by the writer and once by preservation.
_OWNED_KEYS="core vault repos worktrees"

_preserve_unknown() {
  [ -f "$1" ] || return 0
  local line k owned skip
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in \#*|"") continue ;; esac
    k="${line%%=*}"
    k="${k#"${k%%[![:space:]]*}"}"; k="${k%"${k##*[![:space:]]}"}"
    skip=""
    for owned in $_OWNED_KEYS; do
      [ "$k" = "$owned" ] && { skip=1; break; }
    done
    [ -n "$skip" ] && continue
    printf '%s\n' "$line"
  done < "$1"
}

# --- write (create or update in place) ---
mkdir -p "$INST_DIR" || die "cannot create registry: $INST_DIR"
tmp="$INST_DIR/.$name.conf.$$"
{
  printf '# braindance instance — managed by configure.sh\n'
  printf 'core  = %s\n' "$core"
  printf 'vault = %s\n' "$vault"
  printf 'repos = %s\n' "$repos"
  printf 'worktrees = %s\n' "$worktrees"
  _preserve_unknown "$INST_DIR/$name.conf"
} > "$tmp" && mv "$tmp" "$INST_DIR/$name.conf" || die "cannot write $INST_DIR/$name.conf"

[ -n "$set_default" ] && printf '%s\n' "$name" > "$REG/default"

# --- friendly warnings (non-fatal) ---
[ -d "$vault" ] || printf 'configure: note — vault does not exist yet: %s\n' "$vault" >&2
[ -d "$repos" ] || printf 'configure: note — repos dir does not exist yet: %s\n' "$repos" >&2
# `bd new` mkdir -p's the worktrees dir, so absence is normal — but a worktrees
# dir INSIDE the vault or the core is a standing hazard, not a first-run detail.
if _under "$worktrees" "$vault"; then
  printf 'configure: WARNING — worktrees is inside the vault: %s\n' "$worktrees" >&2
  printf '           Obsidian will index every agent branch. Move it outside.\n' >&2
elif _under "$worktrees" "$core"; then
  printf 'configure: WARNING — worktrees is inside the core checkout: %s\n' "$worktrees" >&2
  printf '           worktrees must live outside the repo they are cut from.\n' >&2
fi

printf "registered instance '%s'%s\n" "$name" "${set_default:+ (default)}"
printf '  core  = %s\n  vault = %s\n  repos = %s\n  worktrees = %s\n' \
  "$core" "$vault" "$repos" "$worktrees"
printf '  registry: %s\n' "$REG"

# --- wiring (idempotent; skipped with --no-wire) ---------------------------
_default_rc() {
  case "${SHELL:-}" in
    *zsh)  printf '%s\n' "$HOME/.zshrc" ;;
    *bash) printf '%s\n' "$HOME/.bashrc" ;;
    *)     printf '%s\n' "$HOME/.profile" ;;
  esac
}

_wire_settings() {  # $1=settings.json  $2=resolve cmd  $3=guard cmd
  python3 - "$1" "$2" "$3" <<'PY' || { printf '  settings: FAILED to wire %s\n' "$1" >&2; return 1; }
import json, os, shutil, sys
path, resolve_cmd, guard_cmd = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(path) as f:
        s = json.load(f)
    if not isinstance(s, dict):
        s = {}
except (FileNotFoundError, ValueError):
    s = {}
hooks = s.setdefault("hooks", {})
OURS = {"resolve-instance.py", "block-cross-instance-writes.py"}
def strip_ours(event):
    kept = []
    for g in hooks.get(event, []):
        hs = [h for h in g.get("hooks", [])
              if os.path.basename(h.get("command", "")) not in OURS]
        if hs or "hooks" not in g:
            g = dict(g)
            if "hooks" in g:
                g["hooks"] = hs
            kept.append(g)
    if kept:
        hooks[event] = kept
    elif event in hooks:
        del hooks[event]
strip_ours("SessionStart")
strip_ours("PreToolUse")
hooks.setdefault("SessionStart", []).append(
    {"hooks": [{"type": "command", "command": resolve_cmd}]})
hooks.setdefault("PreToolUse", []).append(
    {"matcher": "Write|Edit|MultiEdit|NotebookEdit|Bash",
     "hooks": [{"type": "command", "command": guard_cmd}]})
os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
if os.path.exists(path) and not os.path.exists(path + ".bak"):
    shutil.copy2(path, path + ".bak")
with open(path, "w") as f:
    json.dump(s, f, indent=2)
    f.write("\n")
PY
  printf '  settings: wired SessionStart + PreToolUse into %s\n' "$1"
}

_wire_rc() {  # $1=rc file  $2=core
  [ -n "$1" ] || return 0
  if [ -f "$1" ] && grep -q 'ctx/tools/sys/wt.sh' "$1"; then
    printf '  rc: wt.sh already sourced in %s — left as is\n' "$1"; return 0
  fi
  { printf '\n# braindance instance resolver (added by configure.sh)\n'
    printf '[ -f "%s/ctx/tools/sys/wt.sh" ] && source "%s/ctx/tools/sys/wt.sh"\n' "$2" "$2"
  } >> "$1" && printf '  rc: sourced wt.sh from %s\n' "$1"
}

if [ -z "$no_wire" ]; then
  printf 'wiring:\n'
  _wire_settings "$SETTINGS" "$core/.claude/hooks/resolve-instance.py" \
                 "$core/.claude/hooks/block-cross-instance-writes.py"
  [ -n "$RC" ] || RC="$(_default_rc)"
  _wire_rc "$RC" "$core"
  if [ -n "${BD_ROOT:-}${VAULT_PATH:-}${REPOS_PATH:-}" ]; then
    printf '  note — BD_ROOT/VAULT_PATH/REPOS_PATH are exported in your environment;\n' >&2
    printf '         they keep the resolver dormant (escape hatch). Remove those exports\n' >&2
    printf '         to hand your shells to the resolver.\n' >&2
  fi
fi
