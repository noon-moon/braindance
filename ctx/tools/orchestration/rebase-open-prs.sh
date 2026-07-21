#!/usr/bin/env bash
# rebase-open-prs.sh — merge-triggered rebase of a target project's open pr/* worktrees.
#
# Multi-agent discipline R6 (+ R5) — see AGENTS.md. When the human squash-merges
# a PR, every other open pr/* worktree keeps its old origin/main base and never
# learns — which strands follow-up work and breeds stale-path confusion. Run this
# right AFTER a merge: it re-fetches, safely fast-forwards the main integration
# checkout, then reports (or, with --apply, rebases) every open pr/* worktree
# onto the new origin/main, flagging branches whose content is already absorbed
# into main ("superseded — replant follow-ups on a fresh branch").
#
# Point it at your target project (the repo cloned under repo/<project>):
#   PROJECT_DIR=~/dev/braindance/repo/<project> rebase-open-prs.sh
#
# SAFE BY DEFAULT:
#   * default = REPORT ONLY (no writes to any branch).
#   * --apply rebases, but SKIPS any worktree with uncommitted changes (never
#     yanks the tree out from under a working agent) and aborts+flags on conflict.
#   * pushing is opt-in (--push, force-with-lease) and only after a clean rebase.
#   * the main checkout is only ever fast-forwarded, never rebased/reset.
#
# Usage:
#   rebase-open-prs.sh                 # report staleness of every open pr/* worktree
#   rebase-open-prs.sh --apply         # + rebase clean, stale worktrees onto origin/main
#   rebase-open-prs.sh --apply --push  # + force-with-lease push the rebased branches
#   rebase-open-prs.sh --apply pr/foo  # restrict to one branch
#
# With R1's write-guard active the main checkout never builds, so its lockfiles
# never churn and the fast-forward below stays clean (that is the R5 fix).

set -uo pipefail
PROJECT="${PROJECT_DIR:-$HOME/dev/braindance/repo/<project>}"
APPLY=0; PUSH=0; ONLY=""
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    --push)  PUSH=1 ;;
    --*)     echo "unknown flag: $a" >&2; exit 2 ;;
    *)       ONLY="$a" ;;
  esac
done

git -C "$PROJECT" rev-parse --git-dir >/dev/null 2>&1 || {
  echo "not a git repo: $PROJECT" >&2
  echo "set PROJECT_DIR to your target repo (e.g. ~/dev/braindance/repo/<project>)" >&2
  exit 2
}

echo "== fetch origin =="
git -C "$PROJECT" fetch -q -p origin || { echo "fetch failed" >&2; exit 1; }
NEW_MAIN=$(git -C "$PROJECT" rev-parse origin/main)
echo "origin/main = $(git -C "$PROJECT" log --oneline -1 origin/main)"

echo; echo "== fast-forward main integration checkout (R5) =="
MAIN_BR=$(git -C "$PROJECT" branch --show-current)
if [ "$MAIN_BR" = "main" ]; then
  if git -C "$PROJECT" merge-base --is-ancestor HEAD origin/main; then
    git -C "$PROJECT" merge --ff-only origin/main >/dev/null 2>&1 \
      && echo "  main -> $NEW_MAIN (ff)" \
      || echo "  ⚠ ff failed — main checkout likely dirty; clean it and re-run (see R5)."
  else
    echo "  ⚠ main has commits not in origin/main — resolve by hand (should not happen)."
  fi
else
  echo "  (main checkout is on '$MAIN_BR', not main — skipping ff)"
fi

echo; echo "== open pr/* worktrees =="
printf "%-26s %-8s %-8s %-9s %s\n" BRANCH AHEAD BEHIND STATE NOTE

# Iterate worktrees via porcelain: paired "worktree <path>" / "branch <ref>".
wt_path="";
git -C "$PROJECT" worktree list --porcelain | while IFS= read -r line; do
  case "$line" in
    "worktree "*) wt_path="${line#worktree }" ;;
    "branch "*)
      ref="${line#branch }"; br="${ref#refs/heads/}"
      case "$br" in pr/*) ;; *) continue ;; esac
      [ -n "$ONLY" ] && [ "$br" != "$ONLY" ] && continue
      [ "$wt_path" = "$PROJECT" ] && continue

      ahead=$(git -C "$wt_path" rev-list --count origin/main..HEAD 2>/dev/null || echo "?")
      behind=$(git -C "$wt_path" rev-list --count HEAD..origin/main 2>/dev/null || echo "?")
      dirty=""; [ -n "$(git -C "$wt_path" status --porcelain 2>/dev/null)" ] && dirty=1

      state="ok"; note=""
      if [ "$ahead" = "0" ]; then
        state="SUPERSEDED"; note="no unique commits — replant follow-ups on a fresh branch"
      elif [ "$behind" = "0" ]; then
        state="current"; note=""
      else
        state="STALE"
        if [ -n "$dirty" ]; then note="DIRTY — skipped (agent may be live); land or 'bd wip' first";
        else note="rebase onto origin/main"; fi
      fi

      if [ "$APPLY" = "1" ] && [ "$state" = "STALE" ] && [ -z "$dirty" ]; then
        if git -C "$wt_path" rebase origin/main >/dev/null 2>&1; then
          left=$(git -C "$wt_path" rev-list --count origin/main..HEAD 2>/dev/null || echo "?")
          if [ "$left" = "0" ]; then
            state="SUPERSEDED"; note="content already in main after rebase — replant on a fresh branch"
          else
            state="rebased"; note="onto $NEW_MAIN"
            if [ "$PUSH" = "1" ]; then
              git -C "$wt_path" push -q --force-with-lease >/dev/null 2>&1 \
                && note="$note; pushed (force-with-lease)" \
                || note="$note; PUSH FAILED"
            fi
          fi
        else
          git -C "$wt_path" rebase --abort >/dev/null 2>&1
          state="CONFLICT"; note="rebase conflicts — resolve by hand in $wt_path"
        fi
      fi
      printf "%-26s %-8s %-8s %-9s %s\n" "$br" "$ahead" "$behind" "$state" "$note"
      ;;
  esac
done

echo
[ "$APPLY" = "1" ] || echo "(report only — pass --apply to rebase clean stale worktrees, --push to publish)"
