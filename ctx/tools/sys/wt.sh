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
BD_CORE="${BD_CORE:-$(cd "$(dirname "$_bd_self")/../../.." && pwd)}"
unset _bd_self
# Repos dir: per-resource override, else the single external root, else nested.
BD_REPOS="${REPOS_PATH:-${BD_ROOT:-$BD_CORE/repo}}"
export BD_REPOS
BD_WT="${BD_WT:-$HOME/dev/bd-wt}"

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
    *)
      echo "usage: bd {new <task>|ls|wip [msg]|land|rm <task>}"
      ;;
  esac
}
