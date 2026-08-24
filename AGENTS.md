# braindance — agent guide (AGENTS.md)

braindance is a **meta-repository template for agentic work**: a personal knowledge and workflow layer you carry between projects, with target repos cloned under the repos dir — resolved off a single external root `$BD_ROOT`, defaulting to the nested `repo/<project>` (see [`CLAUDE.md`](CLAUDE.md)) — and worked on alongside this context.

This file is the **cross-tool entry point** (the [AGENTS.md](https://agents.md) standard — read by Codex, Cursor, Copilot, Gemini, and others). For the vault ontology, ephemeral scratch, skills, tooling, and serving layer, read the fuller repo guide in [`CLAUDE.md`](CLAUDE.md). What lives *here*, canonically, is the slice that must reach **every** tool and **every** target project cloned under `repo/`: the **orchestration doctrine** and the **multi-agent worktree discipline** below — stated tightly as guardrails, with the full mechanics in `docs/`. `CLAUDE.md` points here for these rules rather than restating them.

## Product vs. instance — where changes go

braindance is **personal tooling** — an agent layer over a plain-markdown vault that Obsidian owns and git syncs. Not a product: there is nothing here to hand a stranger. The separation from the vault repo is a privacy boundary, not a distribution one — two instances run on one machine and one may belong to an employer — so no personal content, no hardcoded paths, no one operator's droplet in this checkout. **The test for anything new: could Obsidian, a plugin, a Shortcut or a cron do it? If yes, it is not built here.** See `docs/architecture.md`.

The old fork-and-`git merge upstream/master` model is retired — there is nothing to merge back. Rationale, the three goals every change is measured against, and the roadmap for evicting the instance content still here: [`docs/architecture.md`](docs/architecture.md).

## Orchestration — delegate by default (O1–O9)

**The main thread orchestrates, it does not do the work.** The top-level session the user talks to is a **dispatcher**, not a worker; its scarcest resource is its own responsiveness. Substantive, parallelizable work is handed to background sub-agents that run in parallel (each under the worktree discipline below); the main thread stays free to answer the user and steer the fleet. The core guardrails:

- **Delegate by default, in parallel** (O1); **fold a follow-up into the agent that already owns that scope** before spawning a new workstream (O2); **quick questions stay inline** — don't pay a spawn for a one-liner (O3).
- **Keep the main thread lean:** it never front-loads the costly `ctx/vault` context — vault work is delegated to a sub-agent that loads it, does the work, and reports back a distilled result (O4/O5).
- **Relay eagerly, never block the user;** sub-agents hand back **conclusions plus durable pointers (paths / note titles / PR links), not raw dumps** (O6/O7); **prune the orchestrator's context to pointers, but only after the detail is durably recorded** — record, then drop, so nothing is lost (O8).
- **Right-size the model to the task's risk** (O9): strongest model on code changes and deep design synthesis; a cheaper capable model on lookups, summaries, and routine research.

Full doctrine, the motivating pattern, and the topics-manifest / scope-grant model: [`docs/orchestration.md`](docs/orchestration.md).

**Topics manifest & scope grants.** Before any vault search, consult the vault's `_meta/Topics.md` — the authoritative-and-generated manifest of every `scope` hub: a **miss is decisive** (not in the vault; don't grep), a hit names the MOC to start from. It is produced by `ctx/tools/sys/gen-topics.sh`; if it is absent, the vault has simply never had it generated — say so rather than guessing. When delegating vault work, hand the sub-agent a **scope grant** (the specific scope(s) it may read); it searches only that scope and the scopes transitively `Contained By` it, never the whole vault, and **`scope_kind: system` scopes are excluded unless explicitly granted**. Full model: [`docs/vault.md`](docs/vault.md).

## Multi-agent worktree discipline (R1–R7)

**One agent session = one git worktree = one branch.** Multiple sessions must never share a single working tree: a shared index/HEAD means one session's `git add -A` sweeps another's half-written files, commits interleave, and `index.lock` contention stalls git. These rules are the **standing convention for this repo AND for any target project cloned under `repo/`**; a target repo may add its own local enforcement (e.g. a `PreToolUse` write-guard hook), but the rules hold either way. The guardrails, tightly:

- **R1 — the main checkout is READ-ONLY to agents.** It stays on `main`, is the integration point; agents never `cd` in to write, build, format, or commit. For braindance the main tree is the braindance checkout (also the Obsidian window); for a target project it is its checkout under the repos dir (`${REPOS_PATH:-$BD_ROOT}/<project>`, default nested `repo/<project>`).
- **R2 — fresh base, rebase before push.** Cut worktrees off a freshly-fetched `origin/main`; `git fetch && git rebase origin/main` immediately before every push. Never push from a stale base.
- **R3 — perf / benchmark agents run EXCLUSIVELY.** At most one at a time, no other heavy work while it measures (`ctx/tools/orchestration/loadguard.sh || exit 1`). Never fan a perf tournament N-wide on one machine.
- **R4 — checkpoint WIP before you yield.** Never stop with uncommitted work — leave a rebasable commit (`git add -A && git commit --no-verify -m "WIP(<task>): checkpoint"`; braindance: `bd wip`). Squashed at land.
- **R5 / R6 — after every merge, rebase the siblings.** A squash-merge strands every other open worktree on a stale base; fast-forward the integration checkout and rebase the open worktrees onto the new `origin/main` (`ctx/tools/orchestration/rebase-open-prs.sh`).
- **R7 — one owner per file; the orchestrator keeps a coordination ledger.** Disjoint-file sessions land without conflict only while one agent owns each file. The orchestrator is the single writer of `ctx/tools/orchestration/agent-ledger.md` and keeps declared file globs disjoint across concurrent agents — overlap means queue, don't run.
- **Address every worktree by its ABSOLUTE path** — never an ambient `cwd` or repo-relative path that could resolve into the read-only main checkout.

**Landing.** Land via a squash-merge PR so `main` stays linear and the PR is the audit trail (braindance: `bd new <task>` → work → `bd land` → `bd rm <task>`). **No internal codenames** in PR titles, descriptions, review comments, or commit messages — describe what changed functionally, in portable terms; the template's history is shared by every fork.

Full R1–R7 mechanics + rationale, the `bd` workflow, and the fleet tooling (`wt.sh`, `orchestration/`): [`docs/worktrees.md`](docs/worktrees.md).

## Active-instance discipline (C1–C4)

One machine may host several braindance clones at once, each governing a different **scope** — its own vault + repos. Which one is **current** is resolved from *where you are*, never a global default. (Registry-backed; `./configure` registers a clone, the shell resolver + `SessionStart` hook set the active instance, and a `PreToolUse` guard enforces C2. Portable across tools even where the hook doesn't run.)

- **C1 — Resolve the active instance before doing work.** Determine which instance governs your cwd — an explicit `bd use <name>` pin, else the nearest owning territory (registry longest-prefix, incl. a worktree's main checkout), else the registry `default`. Never assume a global singleton. The `SessionStart` hook surfaces it; `bd where` reports it on demand.
- **C2 — Stay inside the active instance.** Reads and writes touch only its resolved `VAULT_PATH` / `REPOS_PATH`. Never reach into another instance's vault or repos — the cross-instance `PreToolUse` guard blocks such a write.
- **C3 — Ambiguity ⇒ stop, don't guess.** If no instance resolves, or a pin disagrees with cwd, halt and surface it — never silently fall back to the checkout's empty `ctx/vault` scaffolding.
- **C4 — One command bootstraps a clone.** `./configure` registers the instance (validating the disjoint-territory invariant) and installs the resolver hook — idempotent, per-clone, so N clones coexist and none is "the" global default.

Full mechanics — the registry, the resolution ladder, `configure`, `bd use`/`where`, and the two hooks: [`docs/instances.md`](docs/instances.md).

## Output conventions

Two defaults hold for the outputs we produce:

- **Markdown, with language-hinted code fences** (universal). Format outputs as Markdown; put every span of code, console/terminal output, query, config, or structured data in a fenced code block with a language hint (```python, ```sql, ```console, ```json, …). Never paste code or command output as bare prose — in a note, in `_ephemeral`, or back to the user.
- **`_ephemeral` by default** (braindance context). When working in braindance (not a target project under `repo/`, whose skills set their own output locations), generated work products — reports, analyses, drafts, query results — go to `ctx/vault/_ephemeral/` (flat, timestamp-prefixed; see [`docs/vault.md`](docs/vault.md)), not the repo root, `/tmp`, or the vault proper.

For everything else about this repo — the vault ontology, ephemeral scratch, skills, and the serving layer — see [`CLAUDE.md`](CLAUDE.md) and the `docs/` it maps to.
