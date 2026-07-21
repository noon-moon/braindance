# braindance — agent guide

braindance is a **meta-repository for agentic work**: a personal knowledge and workflow layer you carry between projects. This file is the lean always-on core — it carries every load-bearing guardrail plus a **map to on-demand detail docs** you pull only when a task needs them. Human-facing setup and deploy details live in [`README.md`](README.md).

**This is the canonical, fuller agent guide.** [`AGENTS.md`](AGENTS.md) is the cross-tool entry point (the [AGENTS.md](https://agents.md) standard, read by non-Claude harnesses) and the **canonical home of the multi-agent worktree discipline (R1–R7) and orchestration doctrine (O1–O9)**. This file states the vault, repo, and serving guardrails and points to `docs/` for the mechanics.

**Template vs. fork — where changes go.** This repo is a template. Generic changes — guidelines, conventions, tooling, skills, docs, this file, AGENTS.md — belong in the **core template repo** (`noon-moon/braindance`, branch `master`) and NEVER get committed to a personal fork/instance. A fork holds only instance-specific content (real vault notes, its own homepage/`www`, `/srv` deploy specifics) and **consumes template updates via `git merge upstream/master`**. If you find yourself about to commit a generic improvement to a fork, stop and land it on the core template instead.

## Layout

```
ctx/
  vault/     Obsidian vault — your knowledge base and working context (see below)
    _ephemeral/  Non-persisted scratch — transient inputs & outputs; gitignored but Obsidian-visible
  skills/    LLM-agnostic skill prompts; installed into a harness via ctx/tools/sys/sync.sh
  tools/     Lifecycle tooling (sys/), orchestration/ (multi-agent fleet helpers), + standalone tools (e.g. music/)
api/         Admin app: mobile note-capture API + read-only vault viewer (Hono/Node)
www/         Static homepage served at your domain
Caddyfile, docker-compose.yml, deploy.sh   Serving stack
repo/        Default (nested) home for target repos you're working on — gitignored
docs/        On-demand detail this core points to (see map below)
```

**Single external root (`$BD_ROOT`).** The vault and the repos dir are *external resources* the core resolves off one optional knob. Unset ⇒ today's nested layout, byte-for-byte: vault at `<core>/ctx/vault`, repos at `<core>/repo/<name>`. Set `BD_ROOT` and the core, `vault/`, and repos become siblings under it (vault → `$BD_ROOT/vault`, repos → `$BD_ROOT/<name>`); `VAULT_PATH` / `REPOS_PATH` are explicit per-resource overrides. Scratch (`$vault/_ephemeral/`) always rides with the vault so it stays Obsidian-visible. Below, `ctx/vault` and `repo/` name the **default** locations — read them as "the resolved vault / repos dir."

## Map — pull detail only when the task needs it

The common path (a coding task, a vault lookup, a worktree session) is fully served by this core. Read the matching `docs/` file **only** when you're actually doing that thing:

| When you are… | Read |
|---|---|
| running a worktree session, landing a PR, coordinating a fleet (full R1–R7 + the `bd` workflow) | [`docs/worktrees.md`](docs/worktrees.md) |
| orchestrating a fleet of sub-agents (delegation doctrine O1–O9, model right-sizing) | [`docs/orchestration.md`](docs/orchestration.md) |
| searching/creating/restructuring vault notes, or writing scratch (ontology, triage tree, `_ephemeral` naming, daily notes, skills mechanics) | [`docs/vault.md`](docs/vault.md) |
| working on the api / homepage / serving stack / capture pipeline | [`docs/serving.md`](docs/serving.md) |

## `ctx/vault` is the working context

The vault is the canonical knowledge base — ground truth about the user's world, projects, and decisions. It resolves at `${VAULT_PATH:-${BD_ROOT:+$BD_ROOT/vault}}`, defaulting to `ctx/vault` inside the checkout when neither is set (external is opt-in). When a task depends on that context, search the vault before acting and treat what you find there as authoritative. In a personal instance the vault is full of notes; in the bare template it's just scaffolding (`_meta/`, `_templates/`, `TODO.md`) because notes are gitignored.

But **don't search reflexively.** The vault runs to hundreds of notes; a speculative grep on every turn burns round-trips and bloats the context window. Search only when the answer genuinely depends on the user's own notes — not for questions answerable from the conversation, from general knowledge, or from code already in front of you. **Triage first:**

- **Consult `ctx/vault/_meta/Topics.md` first** — the authoritative-and-generated manifest of every `scope` hub. A **miss is decisive**: if a topic isn't in the manifest, the vault has no scope for it, so **do not** fall through to a speculative grep. A hit hands you the MOC to start from; follow its links rather than scanning notes wholesale.
- **Does answering even require user-specific context?** If no — general knowledge, something already in context, a self-contained coding task — **answer directly and skip the vault.**
- **Scope grants (privacy + token guardrail).** A dispatched agent may be handed a **scope grant** — the specific scope(s) it may read; it then searches only that scope and the scopes transitively `Contained By` it, never the whole vault, and **`scope_kind: system` scopes are excluded unless explicitly granted**.

Full triage tree, ontology, `_ephemeral` naming, daily notes, and skills mechanics: [`docs/vault.md`](docs/vault.md). Schema source of truth: `ctx/vault/_meta/Tags.md`; scope-grant model: `ctx/vault/_meta/Agent Context.md`.

**`ctx/vault/_ephemeral/` is non-canonical scratch and the default sink for generated outputs** — gitignored and ephemeral. **Unless the user names a destination, write work products (reports, analyses, drafts, query results) here** rather than the repo root or `/tmp`; read and write it freely for transient inputs/outputs, but never treat it as canonical, and if something is worth keeping, **promote it into a real vault note** in `ctx/vault/`. (Naming convention in [`docs/vault.md`](docs/vault.md).)

## The repos dir

Target repos you're actively working on resolve under `${REPOS_PATH:-$BD_ROOT}/<name>`, defaulting to the gitignored nested `repo/<name>` when `BD_ROOT`/`REPOS_PATH` are unset. Clone the repos you're working on there so their code sits alongside this context; each may carry its own `CLAUDE.md` — defer to it for work inside that repo.

**The repos dir can be tens of GB** (full checkouts, build artifacts, worktrees) — nested inside the checkout or an external sibling, the hazard is the same. **Never run an unscoped shell search from the checkout root (or the repos dir)** — no `grep -r`, `find .`, `du .`, or `ls -R` over `.` — it will crawl the repos and stall the session. **Scope every shell command to the path you actually mean** (`ctx/`, `api/`, …). The Grep/Glob tools are safe (they honour `.gitignore`, which excludes the nested `repo/`); this rule is specifically about raw shell commands, which do not.

## Parallel work — never share a working tree

Multiple agent sessions must **never share the one working tree** — a shared index/HEAD means one session's `git add -A` sweeps another's half-written files, commits interleave, and `index.lock` contention stalls git. The rule: **one terminal = one git worktree = one branch.**

- The main tree (the braindance checkout, e.g. `~/dev/braindance`) is **sacred and read-only to agents**: it stays on `main`, it's the Obsidian window and the integration point. **Agents don't write here.**
- Agent sessions work in sibling worktrees under `~/dev/bd-wt/<task>` (outside the vault, so Obsidian never indexes them), cut off **freshly-fetched `origin/main`** and **rebased before every push**. Helper `bd` (in `ctx/tools/sys/wt.sh`) bakes this in: `bd new <task>` → work → `bd land` → `bd rm <task>`.
- **Always address a worktree by its ABSOLUTE path**; never rely on an ambient `cwd` that could resolve into the sacred main tree.

Full discipline (R1–R7), the `bd` workflow, and fleet tooling: [`AGENTS.md`](AGENTS.md) + [`docs/worktrees.md`](docs/worktrees.md). Orchestrating a fleet of sub-agents: [`docs/orchestration.md`](docs/orchestration.md). Orthogonal ingress: VPS/`api` captures land directly on `main` in `ctx/vault/inbox/`, triaged in-vault at the desk ([`docs/serving.md`](docs/serving.md)).

## Conventions

- **Commits** — imperative summaries. On a personal instance, vault edits are conventionally prefixed `Vault: <summary — detail>`; keep that prefix scheme (`Skills:`, `Tools:`, `Docs:`, `Deploy:`) for other areas.
- **Template, not fork** — generic/guideline/tooling/skill/doc changes land on the core template (`noon-moon/braindance`, `master`); a fork carries only instance-specific content and pulls the rest via `git merge upstream/master`. (See the note at the top of this file.)
- **Output format** — write Markdown, and put every span of code, console/terminal output, query, config, or structured data in a fenced code block with a language hint (```python, ```sql, ```console, ```json, …). This holds for what we write to `_ephemeral`, to vault notes, and back to the user — never paste code or command output as bare prose.
- **Edit skills in `ctx/skills/`, never the installed harness copy** under `.claude/commands/` — the change would be lost or hit the wrong file. (Mechanics: [`docs/vault.md`](docs/vault.md).)
- **Don't touch** `.obsidian/` config unless explicitly asked (it's the Obsidian workspace, easy to corrupt).
- **Don't** fold the flat vault into folders, or mass-rewrite existing notes.
