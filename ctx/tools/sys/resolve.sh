#!/usr/bin/env bash
# resolve.sh — resolve the ACTIVE braindance instance for a directory.
#
# Prints the instance's env contract to stdout as eval-able KEY=value lines:
#     BD_ACTIVE_INSTANCE=<name>
#     BD_CORE=<core>
#     VAULT_PATH=<vault>
#     REPOS_PATH=<repos>
# Callers apply it: `eval "$(resolve.sh)"` (shell / chphd), or the SessionStart
# hook parses it. Output is exactly the existing single-root env contract, so no
# downstream consumer (api, wt.sh, gen-topics.sh, the guard hook) changes.
#
# Usage:  resolve.sh [dir]     # resolve for `dir` (default: $PWD)
#
# The resolution ladder — frozen in docs/instances.md — stops at the first hit:
#   0. env preset & UNSTAMPED (VAULT_PATH/REPOS_PATH set, no BD_ACTIVE_INSTANCE)
#         -> honor verbatim (emit nothing).            [api / CI / one-off escape]
#   1. BD_USE pin (bd use <name>)                      [explicit; wins over cwd]
#   2. cwd under an instance's core|vault|repos; in a worktree, also its
#      `git --git-common-dir` main root. LONGEST-PREFIX match wins.       [auto]
#   3. registry `default` pointer                       [cwd=~, nowhere special]
#   4. NO instances registered -> legacy no-op (emit nothing; tools self-resolve
#      today's nested defaults, byte-for-byte).                        [compat]
#   5. otherwise -> UNRESOLVED: message on stderr, exit 3.        [ambiguous, C3]
#
# Registry: ${BD_REGISTRY:-${XDG_CONFIG_HOME:-$HOME/.config}/braindance}.
# Exit: 0 = resolved / honored / legacy. 3 = UNRESOLVED. 4 = bad pin/default.
# BD_RESOLVE_VERBOSE=1 narrates the chosen step on stderr (as `# ...`).
set -u

REG="${BD_REGISTRY:-${XDG_CONFIG_HOME:-$HOME/.config}/braindance}"
INST_DIR="$REG/instances"
target="${1:-$PWD}"

_v() { [ -n "${BD_RESOLVE_VERBOSE:-}" ] && printf '# resolve: %s\n' "$*" >&2; return 0; }

_canon() {  # canonical absolute path (resolves symlinks for existing dirs)
  local p="$1"
  if [ -d "$p" ]; then ( cd "$p" 2>/dev/null && pwd -P ); return; fi
  case "$p" in
    /*) printf '%s\n' "${p%/}" ;;
    *)  printf '%s\n' "$(pwd -P)/${p#./}" ;;
  esac
}

_under() {  # true if $1 == $2 or $1 is under $2/
  [ "$1" = "$2" ] || [ "${1#"$2"/}" != "$1" ]
}

# --- read the registry into parallel arrays (bash 3.2: indexed arrays only) ---
names=(); cores=(); vaults=(); repos=()
if [ -d "$INST_DIR" ]; then
  for f in "$INST_DIR"/*.conf; do
    [ -e "$f" ] || continue
    c=""; v=""; r=""
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in \#*|"") continue ;; esac
      key="${line%%=*}"; val="${line#*=}"
      key="${key#"${key%%[![:space:]]*}"}"; key="${key%"${key##*[![:space:]]}"}"
      val="${val#"${val%%[![:space:]]*}"}"; val="${val%"${val##*[![:space:]]}"}"
      case "$key" in core) c="$val" ;; vault) v="$val" ;; repos) r="$val" ;; esac
    done < "$f"
    names+=("$(basename "$f" .conf)"); cores+=("$c"); vaults+=("$v"); repos+=("$r")
  done
fi
n_inst=${#names[@]}

_emit() {  # $1=name -> print the instance's env contract, or return 1
  local i
  [ "$n_inst" -gt 0 ] || return 1
  for i in $(seq 0 $((n_inst-1))); do
    if [ "${names[$i]}" = "$1" ]; then
      printf 'BD_ACTIVE_INSTANCE=%s\n' "$1"
      printf 'BD_CORE=%s\n' "${cores[$i]}"
      printf 'VAULT_PATH=%s\n' "${vaults[$i]}"
      printf 'REPOS_PATH=%s\n' "${repos[$i]}"
      return 0
    fi
  done
  return 1
}

# 0. preset & unstamped -> honor verbatim
if [ -z "${BD_ACTIVE_INSTANCE:-}" ] && { [ -n "${VAULT_PATH:-}" ] || [ -n "${REPOS_PATH:-}" ]; }; then
  _v "step 0 — honoring preset env"; exit 0
fi

# 1. explicit pin
if [ -n "${BD_USE:-}" ]; then
  if _emit "$BD_USE"; then _v "step 1 — pin $BD_USE"; exit 0; fi
  printf 'braindance: bd use %s — no such instance (registry: %s)\n' "$BD_USE" "$INST_DIR" >&2
  exit 4
fi

# 2. location (longest-prefix), incl. git worktree common-dir
if [ "$n_inst" -gt 0 ]; then
  cwd="$(_canon "$target")"
  cands="$cwd"
  if gcd="$(git -C "$cwd" rev-parse --git-common-dir 2>/dev/null)"; then
    gcd="$(_canon "$gcd")"
    case "$gcd" in */.git) cands="$cands
$(_canon "$(dirname "$gcd")")" ;; esac
  fi
  best_len=-1; best_name=""
  for i in $(seq 0 $((n_inst-1))); do
    for terr in "${cores[$i]}" "${vaults[$i]}" "${repos[$i]}"; do
      [ -n "$terr" ] || continue
      tc="$(_canon "$terr")"
      while IFS= read -r cand; do
        [ -n "$cand" ] || continue
        if _under "$cand" "$tc" && [ "${#tc}" -gt "$best_len" ]; then
          best_len=${#tc}; best_name="${names[$i]}"
        fi
      done <<EOF
$cands
EOF
    done
  done
  if [ -n "$best_name" ]; then _emit "$best_name"; _v "step 2 — location $best_name"; exit 0; fi
fi

# 3. registry default pointer
if [ -f "$REG/default" ]; then
  d="$(sed -n '1{s/^[[:space:]]*//;s/[[:space:]]*$//;p;}' "$REG/default")"
  if [ -n "$d" ]; then
    if _emit "$d"; then _v "step 3 — default $d"; exit 0; fi
    printf 'braindance: default %s — no such instance (registry: %s)\n' "$d" "$INST_DIR" >&2
    exit 4
  fi
fi

# 4. no instances at all -> legacy no-op
if [ "$n_inst" -eq 0 ]; then _v "step 4 — nested legacy (no instances)"; exit 0; fi

# 5. instances exist but nothing matched -> stop, don't guess
printf 'braindance: no active instance for %s — run: bd use <name> (or set a default)\n' \
  "${cwd:-$target}" >&2
exit 3
