# braindance — agent guide (AGENTS.md)

braindance is a **meta-repository template for agentic work**: a personal knowledge and workflow layer you carry between projects, with target repos cloned under `repo/` and worked on alongside this context.

This file is the **cross-tool entry point** (the [AGENTS.md](https://agents.md) standard — read by Codex, Cursor, Copilot, Gemini, and others). For the vault ontology, ephemeral scratch, skills, tooling, and serving layer, read the fuller repo guide in [`CLAUDE.md`](CLAUDE.md). What lives *here*, canonically, is the one slice that must reach **every** tool and **every** target project cloned under `repo/`: the multi-agent worktree discipline below. `CLAUDE.md` points here for these rules rather than restating them, so the two stay complementary — edit the discipline in this file.

## Template vs. fork — where changes go

braindance is a **template**. Generic, reusable changes — guidelines, conventions, tooling, skills, docs, this file, `CLAUDE.md` — belong in the **core template repo** (`noon-moon/braindance`, branch `master`) and must **never** be committed to a personal fork/instance. A fork holds only instance-specific content (real vault notes, its own homepage, `/srv` deploy specifics) and **consumes the template via `git merge upstream/master`**. If you catch yourself about to commit a generic improvement to a fork, stop and land it on the core template instead — a fresh fork must inherit every generic improvement cleanly.

## Multi-agent worktree discipline

**One agent session = one git worktree = one branch.** Multiple sessions must never share a single working tree: a shared index/HEAD means one session's `git add -A` sweeps another's half-written files, commits interleave, and `index.lock` contention stalls git. These rules are distilled from a real multi-agent retro (agents edited the integration checkout by mistake and stranded work on stale bases) and are the **standing convention for this repo AND for any target project cloned under `repo/`** — not just the project the retro came from. A target repo may bolt on its own local enforcement (e.g. a `PreToolUse` write-guard hook); these rules hold whether or not it does.

- **R1 — the main checkout is READ-ONLY to agents.** It stays on `main`, is the integration point, and agents never `cd` into it to write, build, format, or commit. Keeping it current is the human's job (`git pull --ff-only`, or the post-merge rebase tool below). Because agents never build there, its lockfiles never churn, so fast-forwards stay clean. For braindance itself the main tree is the braindance checkout (e.g. `~/dev/braindance-usr`, also the Obsidian window); for a target project it is `repo/<project>`.
- **R2 — cut worktrees off a FRESHLY-FETCHED `origin/main`, and rebase before every push.** Always `git fetch origin` immediately before creating a worktree, and `git fetch origin && git rebase origin/main` immediately before pushing — never push from a stale base (the failure mode that stranded follow-up commits on already-merged branches). For braindance the `bd` helper bakes this in (`bd new` / `bd land`, below).
- **R3 — perf / A-B / benchmark agents run EXCLUSIVELY.** At most one at a time, with no other heavy work spawned while it measures — a benchmark can't hold a baseline on a contended machine. Gate the measurement on a quiet box and abort rather than quote a bad number (`ctx/tools/orchestration/loadguard.sh || exit 1`). Never fan a perf tournament out N-wide on one machine.
- **R4 — checkpoint WIP before you yield.** Never stop with uncommitted work — leave a rebasable commit so a stop / crash / timeout loses nothing: `git add -A && git commit --no-verify -m "WIP(<task>): checkpoint"` (for braindance: `bd wip`). Squashed away at land.
- **R5 / R6 — after every merge, rebase the siblings.** A squash-merge leaves every other open `pr/*` (or `wt/*`) worktree on a stale base and none of them learn. Right after a merge, fast-forward the integration checkout and rebase the open worktrees onto the new `origin/main`, flagging any branch whose content already landed (replant its follow-ups on a fresh branch): `ctx/tools/orchestration/rebase-open-prs.sh` (report) then `--apply`.
- **R7 — one owner per file; the orchestrator keeps a coordination ledger.** Disjoint-file sessions rebase and land with no conflict **only as long as one agent owns each file.** The orchestrator (the top-level session that spawns the fleet) is the single writer of `ctx/tools/orchestration/agent-ledger.md` (owner ↔ branch ↔ worktree ↔ base-SHA ↔ owned globs ↔ status) and must keep declared file globs disjoint across concurrently-running agents — overlap means queue, don't run.
- **Address every worktree by its ABSOLUTE path.** Never rely on an ambient `cwd` or a repo-relative path that could resolve into the read-only main checkout — that single slip caused the most rework.

**Landing.** Land via a squash-merge PR so `main` stays linear and the PR is the audit trail. A braindance session is `bd new <task>` → work → `bd land` → `bd rm <task>`.

**Portable audit trail — no internal codenames.** PR titles, descriptions, review comments, and commit messages must describe **what changed functionally**, in general portable terms — never by an instance-specific internal codename (e.g. a project's private name). The template is generic and its history is shared by every fork; leaking one instance's codename into PR/commit text couples that shared history to a single project and reads as unprofessional out of context.

## Tooling (source of truth for the rules above)

- `ctx/tools/sys/wt.sh` — the `bd` helpers for braindance-repo sessions: `bd new` (fresh-base worktree under `~/dev/bd-wt/<task>`), `bd wip` (R4 checkpoint), `bd land` (R2 rebase-before-push + squash-merge PR), `bd rm`. Source it from your shell rc.
- `ctx/tools/orchestration/` — fleet tooling for parallel agents in a target project: `rebase-open-prs.sh` (R5/R6), `loadguard.sh` (R3), `agent-ledger.md` (R7 template), and `README.md` describing the post-merge ritual and perf policy. It lives in braindance (outside `repo/`) so a target project's own write-guard never blocks the orchestrator from running or updating it.
- A target repo's local guards (e.g. a `PreToolUse` hook blocking writes to its main checkout, or a `Stop` hook that checkpoints worktree WIP) live in that harness's config (e.g. `.claude/hooks/`) and enforce R1 / R4 mechanically.

## Publish isolation — `ctx/www` is a fenced-off changeset

`ctx/www/` is the public website (homepage + static pages + Quartz garden) deployed to GitHub Pages; `ctx/vault/` is the private knowledge base. They co-locate in one repo, so the privacy boundary is **procedural and fail-closed** — respect it:

- **Never mix a publish with anything else in one commit/PR.** A change that touches `ctx/www/**` must touch **nothing outside** `ctx/www/**`. CI enforces this (`.github/workflows/disjoint-www.yml` fails a mixed PR); the point is that every publish is a self-contained, reviewable "exactly what's going public" changeset and **no vault edit is ever swept into a publish**. A genuine Pages-*infrastructure* change (the workflow, the pub tool, docs) bypasses with `[www-infra]` in the PR title — that is not a content publish.
- **Publishing is manual + gated.** Project notes with `npm --prefix ctx/tools/pub run publish` (default `--strict`, fail-closed on any link/embed to an unpublished note and any unresolvable asset), review `git diff ctx/www/garden/content`, commit. The Pages workflow builds **only** `ctx/www` — it never reads `ctx/vault` — and re-audits the committed projection vault-blind (`npm run verify`) so a leak breaks the deploy. Full rationale in [`CLAUDE.md`](CLAUDE.md) ("Publishing to GitHub Pages").

For everything else about this repo — the vault ontology, ephemeral scratch, skills, and the serving layer — see [`CLAUDE.md`](CLAUDE.md).
