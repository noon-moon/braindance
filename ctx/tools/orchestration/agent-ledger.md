# Agent coordination ledger (template)

Single-writer coordination map for a fleet of parallel worktree agents in a
target project — multi-agent discipline **R7** (see `AGENTS.md`). One row per
live agent: owner ↔ branch ↔ worktree ↔ base-SHA ↔ owned file globs ↔ status.
It exists to kill the "two agents silently editing the same file" failure and to
make stale bases visible at a glance, so `rebase-open-prs.sh` (R6) has something
to drive from.

> This is a **template**. Copy it (or keep one per active fleet) and fill in the
> live snapshot; the checked-in version stays as the blank schema + example so a
> fresh fork inherits the shape, not one project's transient state.

## Conventions (keep this current)

- **The ORCHESTRATOR owns this file** — the top-level session that spawns the
  worktree agents is the *single writer*. Parallel agents never edit it (that
  would just recreate the same-file collision on the ledger itself). It lives in
  the braindance repo (outside `repo/<project>`), so a target project's R1
  write-guard never blocks the orchestrator from updating it.
- **Before spawning an agent**, check its declared `files` globs are **disjoint**
  from every `active` row. Overlap → queue the new agent, don't run it
  (single-owner-per-file).
- **On spawn**: add a row with the fresh `base` (the `origin/main` SHA the
  worktree was cut from) and `status: active`.
- **On land/merge**: flip to `merged`, then run `rebase-open-prs.sh --apply` so
  siblings rebase onto the new `origin/main`; prune `superseded`/`merged` rows
  once their worktrees are removed (`git worktree remove`).
- **Winner == what merges**: when a tournament picks a winner, the row you flip
  to `merged` must be the branch actually merged (avoids the won-one-merged-
  another drift).

## Schema

`owner` short task/track name · `branch` `pr/<name>` · `worktree` absolute path
under `repo/<project>/.claude/worktrees/<task>` · `base` `origin/main` SHA at cut
· `files` crate/dir globs this agent may write (single-owner) · `status`
`active` | `merged` | `superseded` | `idle`.

## Live snapshot (example — replace with your fleet)

origin/main = `<sha>` (`#<pr>`). Regenerate the drift columns with
`rebase-open-prs.sh`.

| owner | branch | worktree (…/.claude/worktrees/) | base | files (owned globs) | status |
|---|---|---|---|---|---|
| _example-a_ | `pr/example-a` | `example-a` | `<sha>` | `pkg-a/**` | active |
| _example-b_ | `pr/example-b` | `example-b` | `<sha>` | `pkg-b/**`, `.github/workflows/**` | active |

> ⚠ Overlap watch: never let two `active` rows claim the same file glob — that is
> the same-file collision R7 exists to prevent. Serialize the rest.
