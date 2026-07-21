# bd — parallel worktree helper for the braindance repo.
# Source from your shell rc:  source ~/dev/braindance-usr/ctx/tools/sys/wt.sh
#
# Paths (single-root model — see CLAUDE.md `$BD_ROOT`):
#   BD_CORE   the braindance checkout itself (git ops run here). Defaults to
#             ~/dev/braindance-usr; override if you cloned elsewhere. (This is the
#             checkout knob that BD_ROOT used to be before it took on the meaning
#             below — if you set BD_ROOT to relocate the checkout, switch to BD_CORE.)
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
#   bd new <task>   fresh worktree + branch wt/<task> off latest origin/main, cd in
#   bd ls           list worktrees
#   bd wip [msg]    checkpoint uncommitted work in this worktree (rebasable commit)
#   bd land         rebase onto main, push branch, open + squash-merge a PR (audit trail)
#   bd rm <task>    remove the worktree and its local branch
#
# Landing is self-service but goes through a PR, so every session leaves a
# permanent audit record while main stays linear (one squash commit per PR).
#
# Freshness guarantee (multi-agent discipline R2 — see AGENTS.md): `bd new`
# always fetches and cuts the branch off the just-fetched origin/main, and
# `bd land` re-fetches and `git rebase origin/main` BEFORE it pushes — so a
# branch can never push from a stale base, the failure mode that strands work.

BD_CORE="${BD_CORE:-$HOME/dev/braindance-usr}"
# Repos dir: per-resource override, else the single external root, else nested.
BD_REPOS="${REPOS_PATH:-${BD_ROOT:-$BD_CORE/repo}}"
export BD_REPOS
BD_WT="${BD_WT:-$HOME/dev/bd-wt}"

bd() {
  case "$1" in
    new)
      [ -n "$2" ] || { echo "usage: bd new <task>"; return 1; }
      git -C "$BD_CORE" fetch -q origin main || return 1
      mkdir -p "$BD_WT"
      git -C "$BD_CORE" worktree add -b "wt/$2" "$BD_WT/$2" origin/main || return 1
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
      local br slug; br="$(git branch --show-current)"
      case "$br" in wt/*) ;; *) echo "not on a wt/* branch (on '$br') — run from a worktree"; return 1;; esac
      # Pin the PR to origin. gh otherwise treats the `upstream` remote (the
      # braindance template) as the base repo and diffs a nonexistent upstream/main.
      slug="$(git config --get remote.origin.url | sed -E 's#^(git@github.com:|https://github.com/)##; s#\.git$##')"
      # R2: re-fetch and rebase onto the latest origin/main right before pushing,
      # so we never push from a stale base.
      git fetch -q origin main || return 1
      git rebase origin/main || { echo "⚠ conflicts — resolve, 'git rebase --continue', then: bd land"; return 1; }
      git push -qu origin "$br" || return 1
      gh pr create -R "$slug" --base main --head "$br" --fill || { echo "pr create failed"; return 1; }
      gh pr merge -R "$slug" "$br" --squash --delete-branch || {
        echo "PR opened but not auto-merged (approval / branch protection). Merge it:"
        gh pr view -R "$slug" "$br" --web
        return 0
      }
      echo "landed $br → main. clean up with: bd rm ${br#wt/}"
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
