# braindance — agent guide (AGENTS.md)

braindance is a **meta-repository template for agentic work**: a personal knowledge and workflow layer you carry between projects, with target repos cloned under `repo/` and worked on alongside this context.

This file is the **cross-tool entry point** (the [AGENTS.md](https://agents.md) standard — read by Codex, Cursor, Copilot, Gemini, and others). For the vault ontology, ephemeral scratch, skills, tooling, and serving layer, read the fuller repo guide in [`CLAUDE.md`](CLAUDE.md). What lives *here*, canonically, is the slice that must reach **every** tool and **every** target project cloned under `repo/`: the **orchestration doctrine** and the **multi-agent worktree discipline** below — stated tightly as guardrails, with the full mechanics in `docs/`. `CLAUDE.md` points here for these rules rather than restating them.

## Template vs. fork — where changes go

braindance is a **template**. Generic, reusable changes — guidelines, conventions, tooling, skills, docs, this file, `CLAUDE.md` — belong in the **core template repo** (`noon-moon/braindance`, branch `master`) and must **never** be committed to a personal fork/instance. A fork holds only instance-specific content (real vault notes, its own homepage, `/srv` deploy specifics) and **consumes the template via `git merge upstream/master`**. If you catch yourself about to commit a generic improvement to a fork, stop and land it on the core template instead — a fresh fork must inherit every generic improvement cleanly.

## Orchestration — delegate by default (O1–O9)

**The main thread orchestrates, it does not do the work.** The top-level session the user talks to is a **dispatcher**, not a worker; its scarcest resource is its own responsiveness. Substantive, parallelizable work is handed to background sub-agents that run in parallel (each under the worktree discipline below); the main thread stays free to answer the user and steer the fleet. The core guardrails:

- **Delegate by default, in parallel** (O1); **fold a follow-up into the agent that already owns that scope** before spawning a new workstream (O2); **quick questions stay inline** — don't pay a spawn for a one-liner (O3).
- **Keep the main thread lean:** it never front-loads the costly `ctx/vault` context — vault work is delegated to a sub-agent that loads it, does the work, and reports back a distilled result (O4/O5).
- **Relay eagerly, never block the user;** sub-agents hand back **conclusions plus durable pointers (paths / note titles / PR links), not raw dumps** (O6/O7); **prune the orchestrator's context to pointers, but only after the detail is durably recorded** — record, then drop, so nothing is lost (O8).
- **Right-size the model to the task's risk** (O9): strongest model on code changes and deep design synthesis; a cheaper capable model on lookups, summaries, and routine research.

Full doctrine, the motivating pattern, and the topics-manifest / scope-grant model: [`docs/orchestration.md`](docs/orchestration.md).

**Topics manifest & scope grants.** Before any vault search, consult `ctx/vault/_meta/Topics.md` — the authoritative-and-generated manifest of every `scope` hub: a **miss is decisive** (not in the vault; don't grep), a hit names the MOC to start from. When delegating vault work, hand the sub-agent a **scope grant** (the specific scope(s) it may read); it searches only that scope and the scopes transitively `Contained By` it, never the whole vault, and **`scope_kind: system` scopes are excluded unless explicitly granted**. Full model: `ctx/vault/_meta/Agent Context.md`.

## Multi-agent worktree discipline (R1–R7)

**One agent session = one git worktree = one branch.** Multiple sessions must never share a single working tree: a shared index/HEAD means one session's `git add -A` sweeps another's half-written files, commits interleave, and `index.lock` contention stalls git. These rules are the **standing convention for this repo AND for any target project cloned under `repo/`**; a target repo may add its own local enforcement (e.g. a `PreToolUse` write-guard hook), but the rules hold either way. The guardrails, tightly:

- **R1 — the main checkout is READ-ONLY to agents.** It stays on `main`, is the integration point; agents never `cd` in to write, build, format, or commit. For braindance the main tree is the braindance checkout (also the Obsidian window); for a target project it is `repo/<project>`.
- **R2 — fresh base, rebase before push.** Cut worktrees off a freshly-fetched `origin/main`; `git fetch && git rebase origin/main` immediately before every push. Never push from a stale base.
- **R3 — perf / benchmark agents run EXCLUSIVELY.** At most one at a time, no other heavy work while it measures (`ctx/tools/orchestration/loadguard.sh || exit 1`). Never fan a perf tournament N-wide on one machine.
- **R4 — checkpoint WIP before you yield.** Never stop with uncommitted work — leave a rebasable commit (`git add -A && git commit --no-verify -m "WIP(<task>): checkpoint"`; braindance: `bd wip`). Squashed at land.
- **R5 / R6 — after every merge, rebase the siblings.** A squash-merge strands every other open worktree on a stale base; fast-forward the integration checkout and rebase the open worktrees onto the new `origin/main` (`ctx/tools/orchestration/rebase-open-prs.sh`).
- **R7 — one owner per file; the orchestrator keeps a coordination ledger.** Disjoint-file sessions land without conflict only while one agent owns each file. The orchestrator is the single writer of `ctx/tools/orchestration/agent-ledger.md` and keeps declared file globs disjoint across concurrent agents — overlap means queue, don't run.
- **Address every worktree by its ABSOLUTE path** — never an ambient `cwd` or repo-relative path that could resolve into the read-only main checkout.

**Landing.** Land via a squash-merge PR so `main` stays linear and the PR is the audit trail (braindance: `bd new <task>` → work → `bd land` → `bd rm <task>`). **No internal codenames** in PR titles, descriptions, review comments, or commit messages — describe what changed functionally, in portable terms; the template's history is shared by every fork.

Full R1–R7 mechanics + rationale, the `bd` workflow, and the fleet tooling (`wt.sh`, `orchestration/`): [`docs/worktrees.md`](docs/worktrees.md).

For everything else about this repo — the vault ontology, ephemeral scratch, skills, and the serving layer — see [`CLAUDE.md`](CLAUDE.md) and the `docs/` it maps to.
