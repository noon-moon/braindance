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
#   --default         also set this instance as the registry `default` pointer
#   --registry <dir>  registry location (default: $BD_REGISTRY | ~/.config/braindance)
#
# Exit: 0 = registered/updated. Non-zero = validation failed (nothing written).
#
# NOTE: installing the shell/hook wiring (SessionStart + chpwd) is a later step
# in the model — this command currently does registration + validation only.
set -u

name=""; core=""; vault=""; repos=""; set_default=""
REG="${BD_REGISTRY:-${XDG_CONFIG_HOME:-$HOME/.config}/braindance}"

die() { printf 'configure: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --name)     name="${2:-}"; shift 2 ;;
    --core)     core="${2:-}"; shift 2 ;;
    --vault)    vault="${2:-}"; shift 2 ;;
    --repos)    repos="${2:-}"; shift 2 ;;
    --registry) REG="${2:-}"; shift 2 ;;
    --default)  set_default=1; shift ;;
    -h|--help)  sed -n '2,20p' "$0"; exit 0 ;;
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
vault="$(_canon "$vault")"; repos="$(_canon "$repos")"

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

# --- write (create or update in place) ---
mkdir -p "$INST_DIR" || die "cannot create registry: $INST_DIR"
tmp="$INST_DIR/.$name.conf.$$"
{
  printf '# braindance instance — managed by configure.sh\n'
  printf 'core  = %s\n' "$core"
  printf 'vault = %s\n' "$vault"
  printf 'repos = %s\n' "$repos"
} > "$tmp" && mv "$tmp" "$INST_DIR/$name.conf" || die "cannot write $INST_DIR/$name.conf"

[ -n "$set_default" ] && printf '%s\n' "$name" > "$REG/default"

# --- friendly warnings (non-fatal) ---
[ -d "$vault" ] || printf 'configure: note — vault does not exist yet: %s\n' "$vault" >&2
[ -d "$repos" ] || printf 'configure: note — repos dir does not exist yet: %s\n' "$repos" >&2

printf "registered instance '%s'%s\n" "$name" "${set_default:+ (default)}"
printf '  core  = %s\n  vault = %s\n  repos = %s\n' "$core" "$vault" "$repos"
printf '  registry: %s\n' "$REG"
