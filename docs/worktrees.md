# Multi-agent worktree discipline (R1–R7) + the `bd` workflow

On-demand detail for the worktree guardrails stated tightly in [`AGENTS.md`](../AGENTS.md) and [`CLAUDE.md`](../CLAUDE.md). Read this when you are **running a worktree session, landing a PR, or coordinating a fleet** — the core docs carry the one-line rules; this file carries the mechanics and the rationale.

**One agent session = one git worktree = one branch.** Multiple sessions must never share a single working tree: a shared index/HEAD means one session's `git add -A` sweeps another's half-written files, commits interleave, and `index.lock` contention stalls git. These rules are distilled from a real multi-agent retro (agents edited the integration checkout by mistake and stranded work on stale bases) and are the **standing convention for this repo AND for any target project cloned under `repo/`** — not just the project the retro came from. A target repo may bolt on its own local enforcement (e.g. a `PreToolUse` write-guard hook); these rules hold whether or not it does.

## R1–R7, in full

- **R1 — the main checkout is READ-ONLY to agents.** It stays on `main`, is the integration point, and agents never `cd` into it to write, build, format, or commit. Keeping it current is the human's job (`git pull --ff-only`, or the post-merge rebase tool below). Because agents never build there, its lockfiles never churn, so fast-forwards stay clean. For braindance itself the main tree is the braindance checkout (e.g. `~/dev/braindance`, also the Obsidian window); for a target project it is its checkout under the repos dir (`${REPOS_PATH:-$BD_ROOT}/<project>`, default nested `repo/<project>`; see [`CLAUDE.md`](../CLAUDE.md)).
- **R2 — cut worktrees off a FRESHLY-FETCHED `origin/main`, and rebase before every push.** Always `git fetch origin` immediately before creating a worktree, and `git fetch origin && git rebase origin/main` immediately before pushing — never push from a stale base (the failure mode that stranded follow-up commits on already-merged branches). For braindance the `bd` helper bakes this in (`bd new` / `bd land`, below).
- **R3 — perf / A-B / benchmark agents run EXCLUSIVELY.** At most one at a time, with no other heavy work spawned while it measures — a benchmark can't hold a baseline on a contended machine. Gate the measurement on a quiet box and abort rather than quote a bad number (`ctx/tools/orchestration/loadguard.sh || exit 1`). Never fan a perf tournament out N-wide on one machine.
- **R4 — checkpoint WIP before you yield.** Never stop with uncommitted work — leave a rebasable commit so a stop / crash / timeout loses nothing: `git add -A && git commit --no-verify -m "WIP(<task>): checkpoint"` (for braindance: `bd wip`). Squashed away at land.
- **R5 / R6 — after every merge, rebase the siblings.** A squash-merge leaves every other open `pr/*` (or `wt/*`) worktree on a stale base and none of them learn. Right after a merge, fast-forward the integration checkout and rebase the open worktrees onto the new `origin/main`, flagging any branch whose content already landed (replant its follow-ups on a fresh branch): `ctx/tools/orchestration/rebase-open-prs.sh` (report) then `--apply`.
- **R7 — one owner per file; the orchestrator keeps a coordination ledger.** Disjoint-file sessions rebase and land with no conflict **only as long as one agent owns each file.** The orchestrator (the top-level session that spawns the fleet) is the single writer of `ctx/tools/orchestration/agent-ledger.md` (owner ↔ branch ↔ worktree ↔ base-SHA ↔ owned globs ↔ status) and must keep declared file globs disjoint across concurrently-running agents — overlap means queue, don't run.
- **Address every worktree by its ABSOLUTE path.** Never rely on an ambient `cwd` or a repo-relative path that could resolve into the read-only main checkout — that single slip caused the most rework.

**Landing.** Land via a squash-merge PR so `main` stays linear and the PR is the audit trail. A braindance session is `bd new <task>` → work → `bd land` → `bd rm <task>`.

**Portable audit trail — no internal codenames.** PR titles, descriptions, review comments, and commit messages must describe **what changed functionally**, in general portable terms — never by an instance-specific internal codename (e.g. a project's private name). The template is generic and its history is shared by every fork; leaking one instance's codename into PR/commit text couples that shared history to a single project and reads as unprofessional out of context.

## The `bd` braindance worktree workflow

The braindance main tree (the braindance checkout, e.g. `~/dev/braindance`) is sacred: it stays on `main`, it's the Obsidian window and the integration point. **Agents don't write here.** Occasionally `git pull --ff-only` it.

Agent sessions work in sibling worktrees under `~/dev/bd-wt/<task>` — **outside** the vault, so Obsidian never indexes them. Helper `bd` (in `ctx/tools/sys/wt.sh`, sourced from your shell rc):

- `bd new <task>` — worktree + branch `wt/<task>` off **freshly-fetched** `origin/main`, cd in
- `bd wip [msg]` — checkpoint uncommitted work in the worktree (a rebasable commit; squashed at land) — leave one before you yield so a stop/crash never loses work (R4)
- `bd land` — **re-fetch + rebase onto `origin/main` before pushing** (R2), then open + squash-merge a PR (self-land; the PR is the audit trail, `main` stays linear)
- `bd rm <task>` — remove the worktree + local branch

**Always address a worktree by its ABSOLUTE path** (`~/dev/bd-wt/<task>/…`); never rely on an ambient `cwd` or repo-relative paths that could resolve into the sacred main tree. A session is: `bd new fix-tags` → work → `bd land` → `bd rm fix-tags`. Because the flat vault is file-per-note, disjoint-file sessions rebase and land with no conflict.

Orthogonal ingress: VPS/`api` captures land directly on `main` in `ctx/vault/inbox/` (funnel-shaped, triaged in-vault at the desk) — a separate ingress from this worktree flow, but now sharing `main` as the target. See [`serving.md`](serving.md).

## Tooling (source of truth for the rules above)

- `ctx/tools/sys/wt.sh` — the `bd` helpers for braindance-repo sessions: `bd new` (fresh-base worktree under `~/dev/bd-wt/<task>`), `bd wip` (R4 checkpoint), `bd land` (R2 rebase-before-push + squash-merge PR), `bd rm`. Source it from your shell rc.
- `ctx/tools/orchestration/` — fleet tooling for parallel agents in a target project: `rebase-open-prs.sh` (R5/R6), `loadguard.sh` (R3), `agent-ledger.md` (R7 template), and `README.md` describing the post-merge ritual and perf policy. It lives in the **braindance core** — a separate git repo from any target project, located via `$BD_ROOT` rather than by being a parent dir of a nested `repo/<project>` — so a target project's own write-guard (scoped to *its* checkout) never blocks the orchestrator from running or updating it, whether repos are nested or external siblings under `$BD_ROOT`.
- A target repo's local guards (e.g. a `PreToolUse` hook blocking writes to its main checkout, or a `Stop` hook that checkpoints worktree WIP) live in that harness's config (e.g. `.claude/hooks/`) and enforce R1 / R4 mechanically.

**Fleets of parallel agents in a target project** (`repo/<project>`) additionally use the orchestration tooling above — the owner↔branch coordination ledger (`agent-ledger.md`, R7), post-merge `rebase-open-prs.sh` (R5/R6), and perf `loadguard.sh` (R3) — plus whatever local guard hooks that target repo installs. The delegation doctrine that decides *who does the work* (O1–O9) is in [`orchestration.md`](orchestration.md).
