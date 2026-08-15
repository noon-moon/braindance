# bd — parallel worktree helper for the braindance repo.
# Source from your shell rc:  source <braindance-checkout>/ctx/tools/sys/wt.sh
#
# Paths (single-root model — see CLAUDE.md `$BD_ROOT`):
#   BD_CORE   the braindance checkout itself (git ops run here). Defaults to this
#             file's own checkout, self-resolved from its path, so it's correct
#             wherever you cloned; set it only if you source a copy from outside the
#             checkout. (This is the checkout knob that BD_ROOT used to be before it
#             took on the meaning below — if you set BD_ROOT to relocate the
#             checkout, switch to BD_CORE.)
#   BD_ROOT   optional single external root holding the core + vault + repos as
#             siblings. Unset ⇒ today's nested layout (repos under <core>/repo).
#   BD_REPOS  where target repos live: REPOS_PATH, else BD_ROOT, else <core>/repo.
#             Nothing here clones into it yet — it's the shared convention the docs
#             and guard hooks resolve against; exported so tooling can reuse it.
#   BD_WT     where THIS instance's agent worktrees live — `bd new <task>` creates
#             $BD_WT/<task>. Configured per-instance by the `worktrees` key in the
#             registry conf (./configure --worktrees), which the resolver emits;
#             that value wins, so the assignment below is only the fallback for
#             when the resolver is dormant (legacy / escape-hatch mode). The
#             fallback is a `worktrees` sibling of the core, matching the default
#             configure.sh and resolve.sh compute — never inside the core or the
#             vault, so a checkout stays clean and Obsidian indexes no branches.
#
# One terminal = one worktree = one branch. Keeps the main tree (your Obsidian
# window) sacred: agents never write there, so no shared index/HEAD collisions.
# Worktrees live OUTSIDE the vault so Obsidian never indexes them.
#
#   bd new <task>   fresh worktree + branch wt/<task> off latest origin trunk, cd in
#   bd ls           list worktrees
#   bd wip [msg]    checkpoint uncommitted work in this worktree (rebasable commit)
#   bd land         rebase onto trunk, push branch, open + squash-merge a PR (audit trail)
#   bd rm <task>    remove the worktree and its local branch
#   bd repair       re-point worktrees orphaned by a moved/renamed core, then prune
#   bd use [<name>] pin this shell to instance <name> (no arg / --auto: back to auto)
#   bd where        show which instance is current for $PWD, and how it resolved
#   bd ls-instances list registered instances (* = active, marks the default)
#
# "trunk" is origin's default branch (main, master, …), resolved dynamically —
# never hardcoded — so `bd` works whatever the instance named its trunk.
#
# Landing is self-service but goes through a PR, so every session leaves a
# permanent audit record while trunk stays linear (one squash commit per PR).
#
# Freshness guarantee (multi-agent discipline R2 — see AGENTS.md): `bd new`
# always fetches and cuts the branch off the just-fetched origin trunk, and
# `bd land` re-fetches and rebases onto it BEFORE it pushes — so a branch can
# never push from a stale base, the failure mode that strands work.

# Self-resolve the checkout from this file's location (ctx/tools/sys/wt.sh → repo
# root), portable across bash and zsh, so no instance path is baked in.
_bd_self="${BASH_SOURCE[0]:-$0}"
_BD_SELF_DIR="$(cd "$(dirname "$_bd_self")" && pwd)"
BD_CORE="${BD_CORE:-$(cd "$_BD_SELF_DIR/../../.." && pwd)}"
unset _bd_self
# Repos dir: per-resource override, else the single external root, else nested.
BD_REPOS="${REPOS_PATH:-${BD_ROOT:-$BD_CORE/repo}}"
export BD_REPOS
BD_WT="${BD_WT:-$(dirname "$BD_CORE")/worktrees}"
export BD_WT

# --- active-instance resolution (the multi-instance model; docs/instances.md) -
# Which braindance is "current" is resolved from where you are, per-shell. The
# resolver (resolve.sh) walks the ladder and prints the env contract on a hit;
# _bd_apply exports it. Resolution is STICKY for the shell: a hit switches the
# active instance, but wandering into neutral dirs (no match) leaves the last one
# in place — the strict "stop, don't guess" is enforced for agents by the guard
# hook, not by nagging every prompt. `bd use` pins/overrides explicitly.
# Locate the resolver beside THIS file, not under BD_CORE. BD_CORE is inherited
# when already exported, so deriving the resolver from it means a shell holding a
# pre-move BD_CORE aims at a resolver that no longer exists — _bd_apply then
# silently exports nothing and every `bd` subcommand reports pre-move paths. The
# resolver ships next to wt.sh, so its location is knowable without any env.
BD_RESOLVE="$_BD_SELF_DIR/resolve.sh"

_bd_apply() {  # resolve for $PWD and export what the resolver emits (if any)
  [ -x "$BD_RESOLVE" ] || return 0
  local out rc line
  out="$("$BD_RESOLVE" "$PWD" 2>/dev/null)"; rc=$?
  [ "$rc" -eq 0 ] && [ -n "$out" ] || return 0
  while IFS= read -r line; do
    [ -n "$line" ] && export "${line%%=*}=${line#*=}"
  done <<EOF
$out
EOF
}

_bd_chpwd() {  # cheap: only re-resolve when the directory actually changed
  [ "$PWD" = "${_BD_LAST_PWD:-}" ] && return 0
  _BD_LAST_PWD="$PWD"
  _bd_apply
}

# Resolve origin's default branch (main, master, …) — never assume `main`, so
# `bd` works on master-based instances too. Try local origin/HEAD first (no
# network), then ask the remote, then probe main-else-master as a last resort.
_bd_trunk() {
  local ref
  ref="$(git -C "$BD_CORE" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null)"
  [ -n "$ref" ] && { echo "${ref#origin/}"; return; }
  ref="$(git -C "$BD_CORE" ls-remote --symref origin HEAD 2>/dev/null \
         | sed -n 's#^ref: refs/heads/\([^[:space:]]*\).*#\1#p')"
  [ -n "$ref" ] && { echo "$ref"; return; }
  if git -C "$BD_CORE" ls-remote --exit-code --heads origin main >/dev/null 2>&1; then
    echo main
  else
    echo master
  fi
}

# `bd where` reports paths, and the failure that actually bites is a path that
# no longer exists — a moved core, a deleted worktree root. Printing it plain
# reads as healthy, so mark it: a dead path should look dead.
_bd_flag() {
  [ -n "$1" ] || { printf '<unset>\n'; return 0; }
  if [ -d "$1" ]; then printf '%s\n' "$1"; else printf '%s  (MISSING)\n' "$1"; fi
}

# In escape-hatch mode the exported env wins and the registry is never consulted,
# which looks exactly like a stale registry. Re-run the resolver with the
# shadowing vars stripped to show what the registry would have said.
_bd_shadowed_by_registry() {
  [ -x "$BD_RESOLVE" ] || return 0
  local _reg_out _name _core
  _reg_out="$(env -u VAULT_PATH -u REPOS_PATH -u BD_CORE -u BD_WT \
                  -u BD_ACTIVE_INSTANCE "$BD_RESOLVE" "$PWD" 2>/dev/null)" || return 0
  [ -n "$_reg_out" ] || return 0
  _name="$(printf '%s\n' "$_reg_out" | sed -n 's/^BD_ACTIVE_INSTANCE=//p')"
  _core="$(printf '%s\n' "$_reg_out" | sed -n 's/^BD_CORE=//p')"
  [ -n "$_name" ] || return 0
  printf "  registry here says: %s (core = %s)\n" "$_name" "$_core"
  printf "  unset VAULT_PATH REPOS_PATH BD_CORE BD_WT to hand this shell back to it.\n"
}

bd() {
  case "$1" in
    new)
      [ -n "$2" ] || { echo "usage: bd new <task>"; return 1; }
      local trunk; trunk="$(_bd_trunk)"
      git -C "$BD_CORE" fetch -q origin "$trunk" || return 1
      mkdir -p "$BD_WT"
      git -C "$BD_CORE" worktree add -b "wt/$2" "$BD_WT/$2" "origin/$trunk" || return 1
      cd "$BD_WT/$2"
      ;;
    ls)
      git -C "$BD_CORE" worktree list
      ;;
    wip)
      # R4: leave a rebasable checkpoint instead of loose files before you yield.
      case "$(git branch --show-current)" in wt/*) ;; *) echo "not on a wt/* branch — run from a worktree"; return 1;; esac
      git add -A || return 1
      git diff --cached --quiet && { echo "nothing to checkpoint"; return 0; }
      git commit --no-verify -m "${2:-WIP: checkpoint}" && echo "checkpointed — squash at land"
      ;;
    land)
      local br slug trunk; br="$(git branch --show-current)"
      case "$br" in wt/*) ;; *) echo "not on a wt/* branch (on '$br') — run from a worktree"; return 1;; esac
      trunk="$(_bd_trunk)"
      # Pin the PR to origin. gh otherwise treats the `upstream` remote (the
      # braindance template) as the base repo and diffs a nonexistent upstream trunk.
      slug="$(git config --get remote.origin.url | sed -E 's#^(git@github.com:|https://github.com/)##; s#\.git$##')"
      # R2: re-fetch and rebase onto the latest origin trunk right before pushing,
      # so we never push from a stale base.
      git fetch -q origin "$trunk" || return 1
      git rebase "origin/$trunk" || { echo "⚠ conflicts — resolve, 'git rebase --continue', then: bd land"; return 1; }
      git push -qu origin "$br" || return 1
      gh pr create -R "$slug" --base "$trunk" --head "$br" --fill || { echo "pr create failed"; return 1; }
      gh pr merge -R "$slug" "$br" --squash --delete-branch || {
        echo "PR opened but not auto-merged (approval / branch protection). Merge it:"
        gh pr view -R "$slug" "$br" --web
        return 0
      }
      echo "landed $br → $trunk. clean up with: bd rm ${br#wt/}"
      ;;
    rm)
      [ -n "$2" ] || { echo "usage: bd rm <task>"; return 1; }
      cd "$BD_CORE" || return 1
      git worktree remove "$BD_WT/$2" && git branch -D "wt/$2" 2>/dev/null
      ;;
    repair)
      # A linked worktree stores an ABSOLUTE gitdir pointer, and the admin dir
      # under .git/worktrees/<id> stores an absolute path back. Moving or
      # renaming the core breaks every worktree at once, in both directions.
      # `git worktree repair` rewrites both wherever the admin dir survives.
      local _d _bad _fixed
      _bad=0; _fixed=0
      [ -d "$BD_WT" ] || { printf 'no worktrees dir: %s\n' "$BD_WT"; return 0; }
      for _d in "$BD_WT"/*; do
        [ -d "$_d" ] || continue
        [ -e "$_d/.git" ] || continue          # never was a worktree — not ours
        git -C "$BD_CORE" worktree repair "$_d" >/dev/null 2>&1
        if git -C "$_d" rev-parse --git-dir >/dev/null 2>&1; then
          _fixed=$((_fixed+1)); printf '  ok            %s\n' "$_d"
        else
          # Admin dir (and possibly the branch) is gone: the directory is now
          # just files. Only the user knows whether they matter, and they are
          # NOT reproducible from git — so report and keep hands off.
          _bad=$((_bad+1))
          printf '  UNRECOVERABLE %s — files only, left untouched\n' "$_d"
        fi
      done
      # Prune LAST. Pruning first would delete the very admin dirs repair needs
      # to re-point a worktree whose directory moved, converting a fixable
      # worktree into an unrecoverable one.
      git -C "$BD_CORE" worktree prune
      printf 'repaired %d, unrecoverable %d (root: %s)\n' "$_fixed" "$_bad" "$BD_WT"
      [ "$_bad" -eq 0 ]
      ;;
    use)
      # bd use <name>  -> pin this shell to <name> (wins over location)
      # bd use --auto  -> clear the pin; resume location-based resolution
      case "${2:-}" in
        ""|--auto|-a)
          unset BD_USE
          _bd_apply
          bd where
          ;;
        *)
          export BD_USE="$2"
          _bd_apply
          if [ "${BD_ACTIVE_INSTANCE:-}" = "$2" ]; then
            bd where
          else
            printf "bd: could not activate '%s'.\n" "$2" >&2
            if [ -z "${BD_ACTIVE_INSTANCE:-}" ] && { [ -n "${VAULT_PATH:-}" ] || [ -n "${REPOS_PATH:-}" ]; }; then
              printf "    a manual VAULT_PATH/REPOS_PATH is set — resolver is in escape-hatch mode.\n" >&2
              printf "    unset it (or migrate this shell to the registry) to hand control to the resolver.\n" >&2
            else
              printf "    no such instance — see: bd ls-instances\n" >&2
            fi
            unset BD_USE
            return 1
          fi
          ;;
      esac
      ;;
    where)
      # report the instance current for $PWD (and how it was resolved)
      local _rc _out
      _out="$("$BD_RESOLVE" "$PWD" 2>&1)"; _rc=$?
      if [ "$_rc" -eq 3 ]; then
        printf "instance: (none — no match for %s)\n" "$PWD"
        printf "  %s\n" "$_out"
        return 0
      fi
      if [ -n "${BD_ACTIVE_INSTANCE:-}" ]; then
        printf "instance: %s%s\n" "$BD_ACTIVE_INSTANCE" "${BD_USE:+ (pinned)}"
        printf "  core  = %s\n" "$(_bd_flag "${BD_CORE:-}")"
        printf "  vault = %s\n" "$(_bd_flag "${VAULT_PATH:-}")"
        printf "  repos = %s\n" "$(_bd_flag "${REPOS_PATH:-}")"
        printf "  worktrees = %s\n" "$(_bd_flag "${BD_WT:-}")"
      elif [ -n "${VAULT_PATH:-}${REPOS_PATH:-}" ]; then
        # Step 0. Values here came from the environment, not the registry, and a
        # shell that exported them BEFORE a core move goes on reporting the old
        # paths forever. Indistinguishable from a stale registry at the point of
        # use — so say which it is, and show what the registry actually holds.
        printf "instance: (none — manual VAULT_PATH/REPOS_PATH shadow the registry)\n"
        printf "  vault = %s\n" "$(_bd_flag "${VAULT_PATH:-}")"
        printf "  repos = %s\n" "$(_bd_flag "${REPOS_PATH:-}")"
        printf "  worktrees = %s\n" "$(_bd_flag "${BD_WT:-}")"
        _bd_shadowed_by_registry
      else
        printf "instance: (none — legacy nested defaults)\n"
        printf "  worktrees = %s\n" "$(_bd_flag "${BD_WT:-}")"
      fi
      ;;
    ls-instances)
      local _reg _f _n _def
      _reg="${BD_REGISTRY:-${XDG_CONFIG_HOME:-$HOME/.config}/braindance}"
      if [ -d "$_reg/instances" ]; then
        _def="$(cat "$_reg/default" 2>/dev/null)"
        for _f in "$_reg/instances"/*.conf; do
          [ -e "$_f" ] || continue
          _n="$(basename "$_f" .conf)"
          printf "%s%s%s\n" "$_n" \
            "$([ "$_n" = "${BD_ACTIVE_INSTANCE:-}" ] && printf ' *')" \
            "$([ "$_n" = "$_def" ] && printf ' (default)')"
        done
      else
        printf "(no instances registered — run ./configure in a clone root)\n"
      fi
      ;;
    *)
      echo "usage: bd {new <task>|ls|wip [msg]|land|rm <task>|repair|use [<name>|--auto]|where|ls-instances}"
      ;;
  esac
}

# Auto-resolve the active instance on cd, without clobbering existing hooks.
# Non-disruptive: in escape-hatch/legacy mode the resolver emits nothing, so this
# is a no-op until you register instances and hand control to the resolver.
if [ -n "${ZSH_VERSION:-}" ]; then
  autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook chpwd _bd_chpwd
elif [ -n "${BASH_VERSION:-}" ]; then
  case "${PROMPT_COMMAND:-}" in
    *_bd_chpwd*) ;;
    "")  PROMPT_COMMAND="_bd_chpwd" ;;
    *)   PROMPT_COMMAND="_bd_chpwd;${PROMPT_COMMAND}" ;;
  esac
fi
_BD_LAST_PWD=""; _bd_chpwd   # resolve once for the shell's starting directory
