# Multi-agent orchestration tooling

Standalone helpers implementing the multi-agent worktree discipline (R1–R7 in
[`AGENTS.md`](../../../AGENTS.md)). They govern a **fleet of parallel worktree
agents** working a target project cloned under `repo/<project>/` and landing
squash-merge PRs. They live in the braindance repo (outside `repo/<project>`) so
a target project's R1 write-guard never blocks the orchestrator from running or
updating them.

| file | rule | what it does |
|---|---|---|
| `rebase-open-prs.sh` | **R6** (+**R5**) | Post-merge: fast-forwards the target project's main integration checkout, then reports (or `--apply` rebases) every open `pr/*` worktree onto the new `origin/main`, flagging `SUPERSEDED` branches whose content already landed. Skips dirty worktrees; never auto-pushes. Point it via `PROJECT_DIR`. |
| `loadguard.sh` | **R3** | Exit 0/1 on whether 1-min load average is under a threshold (default = CPU count). A perf/A-B agent calls it to abort a measurement when the box is contended. |
| `agent-ledger.md` | **R7** | Single-writer owner↔branch↔files↔base-SHA map (template) the orchestrator keeps current to enforce single-owner-per-file and surface stale bases. |

## Companion pieces

- **R2** — baked into `../sys/wt.sh` (the `bd` helper: `bd new` fetches + cuts off
  fresh `origin/main`; `bd land` rebases before push; `bd wip` checkpoints). That
  governs braindance-repo sessions; a target project's fleet follows the same R2
  rule via `git fetch origin && git rebase origin/main` before every push.
- **R1 / R4** — a target repo enforces these mechanically with its own local
  harness hooks (e.g. a `PreToolUse` write-guard that makes its main checkout
  unwritable to agents, and a `Stop` hook that checkpoints worktree WIP). Those
  live in that repo's harness config (e.g. `.claude/hooks/`), not here.

## Post-merge ritual (do this after the human squash-merges a target-project PR)

```sh
export PROJECT_DIR=~/dev/braindance-usr/repo/<project>
# 1. sync + see what drifted
ctx/tools/orchestration/rebase-open-prs.sh
# 2. rebase the clean, stale worktrees (dirty ones are skipped — land/'bd wip' them first)
ctx/tools/orchestration/rebase-open-prs.sh --apply           # add --push to publish
# 3. update the ledger: flip the merged row, prune superseded/removed worktrees
$EDITOR ctx/tools/orchestration/agent-ledger.md
```

## Perf-measurement policy (R3)

Perf / A-B / benchmark agents are **exclusive**: run at most one at a time, and
pause spawning other heavy work while it measures. Each such agent should gate
its measurement on the machine being quiet:

```sh
ctx/tools/orchestration/loadguard.sh || { echo "machine loaded — aborting, retry later"; exit 1; }
```

Never fan a perf tournament out N-wide on one machine — a benchmark can't hold a
baseline on a contended box.
