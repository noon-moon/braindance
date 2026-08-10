# braindance — agent guide

braindance is a **meta-repository for agentic work**: a personal knowledge and workflow layer you carry between projects. This file is the lean always-on core — it carries every load-bearing guardrail plus a **map to on-demand detail docs** you pull only when a task needs them. Human-facing setup and deploy details live in [`README.md`](README.md).

**This is the canonical, fuller agent guide.** [`AGENTS.md`](AGENTS.md) is the cross-tool entry point (the [AGENTS.md](https://agents.md) standard, read by non-Claude harnesses) and the **canonical home of the multi-agent worktree discipline (R1–R7) and orchestration doctrine (O1–O9)**. This file states the vault, repo, and serving guardrails and points to `docs/` for the mechanics.

**This repo is the PRODUCT; your data is an instance.** Everything here must be generic enough to hand to someone else — tooling, skills, docs, the app. Instance-specific content (real vault notes, one operator's domain or droplet, `/srv` specifics) belongs to an *instance*: the vault repo plus its machine-local config, never this checkout. Before committing, ask whether a stranger cloning this repo would want the change; if not, it belongs in your instance.

> The old fork-and-`git merge upstream/master` model is **retired** — braindance is cloned and deployed, not forked, so there is nothing to merge back. Eviction of the instance content still in this repo is phase 1 of the roadmap in [`docs/architecture.md`](docs/architecture.md).

## Layout

```
ctx/
  vault/     Obsidian vault — your knowledge base and working context (see below)
    _ephemeral/  Non-persisted scratch — transient inputs & outputs; gitignored but Obsidian-visible
  skills/    LLM-agnostic skill prompts; installed into a harness via ctx/tools/sys/sync.sh
  tools/     Lifecycle tooling (sys/), orchestration/ (multi-agent fleet helpers), pub/ (the publish tool), + standalone tools (e.g. music/)
api/         Admin app: mobile note-capture API + read-only vault viewer (Hono/Node)
Caddyfile, docker-compose.yml, deploy.sh, ops/   Serving stack — the public site itself lives in a SEPARATE repo
repo/        Default (nested) home for target repos you're working on — gitignored
docs/        On-demand detail this core points to (see map below)
```

**Single external root (`$BD_ROOT`).** The vault and the repos dir are *external resources* the core resolves off one optional knob. Unset ⇒ today's nested layout, byte-for-byte: vault at `<core>/ctx/vault`, repos at `<core>/repo/<name>`. Set `BD_ROOT` and the core, `vault/`, and repos become siblings under it (vault → `$BD_ROOT/vault`, repos → `$BD_ROOT/<name>`); `VAULT_PATH` / `REPOS_PATH` are explicit per-resource overrides. Scratch (`$vault/_ephemeral/`) always rides with the vault so it stays Obsidian-visible. Below, `ctx/vault` and `repo/` name the **default** locations — read them as "the resolved vault / repos dir."

**Multiple instances on one machine.** When several braindance clones coexist (each a different scope), which one is *current* is resolved **per-context, not globally** — from where you are, via a registry `./configure` writes. Manually-exported `BD_ROOT`/`VAULT_PATH`/`REPOS_PATH` are the escape hatch that pins resolution (and keep the resolver dormant). Follow the active-instance discipline (C1–C4) in [`AGENTS.md`](AGENTS.md); mechanics in [`docs/instances.md`](docs/instances.md).

## Map — pull detail only when the task needs it

The common path (a coding task, a vault lookup, a worktree session) is fully served by this core. Read the matching `docs/` file **only** when you're actually doing that thing:

| When you are… | Read |
|---|---|
| making a design call, or wondering whether a feature belongs here at all | [`docs/architecture.md`](docs/architecture.md) — the product definition and the three goals every change is measured against |
| running a worktree session, landing a PR, coordinating a fleet (full R1–R7 + the `bd` workflow) | [`docs/worktrees.md`](docs/worktrees.md) |
| orchestrating a fleet of sub-agents (delegation doctrine O1–O9, model right-sizing) | [`docs/orchestration.md`](docs/orchestration.md) |
| searching/creating/restructuring vault notes, or writing scratch (what braindance requires of a vault, triage tree, `_ephemeral` naming, daily notes) | [`docs/vault.md`](docs/vault.md) |
| working on the api / serving stack / capture pipeline | [`docs/serving.md`](docs/serving.md) |
| publishing vault notes to the public site, or touching the publish tool | [`docs/publishing.md`](docs/publishing.md) |
| installing or writing skills | [`docs/skills.md`](docs/skills.md) |
| resolving which braindance instance is current, or bootstrapping a clone (`./configure`, `bd use`/`where`, the resolver + guard hooks; C1–C4) | [`docs/instances.md`](docs/instances.md) |

The index is [`docs/README.md`](docs/README.md). Those files are the **manual** — explanation written for a person, which agents read too. This file and [`AGENTS.md`](AGENTS.md) hold the **directives**; they point there rather than restating.

## `ctx/vault` is the working context

The vault is the canonical knowledge base — ground truth about the user's world, projects, and decisions. It resolves at `${VAULT_PATH:-${BD_ROOT:+$BD_ROOT/vault}}`, defaulting to `ctx/vault` inside the checkout when neither is set (external is opt-in). When a task depends on that context, search the vault before acting and treat what you find there as authoritative. In a personal instance the vault is full of notes; in the bare template it's just scaffolding (`_meta/`, `_templates/`, `TODO.md`) because notes are gitignored.

But **don't search reflexively.** The vault runs to hundreds of notes; a speculative grep on every turn burns round-trips and bloats the context window. Search only when the answer genuinely depends on the user's own notes — not for questions answerable from the conversation, from general knowledge, or from code already in front of you. **Triage first:**

- **Consult the vault's `_meta/Topics.md` first** — the authoritative-and-generated manifest of every `scope` hub (generated by `ctx/tools/sys/gen-topics.sh`; the template ships none). A **miss is decisive**: if a topic isn't in the manifest, the vault has no scope for it, so **do not** fall through to a speculative grep. A hit hands you the MOC to start from; follow its links rather than scanning notes wholesale.
- **Does answering even require user-specific context?** If no — general knowledge, something already in context, a self-contained coding task — **answer directly and skip the vault.**
- **Scope grants (privacy + token guardrail).** A dispatched agent may be handed a **scope grant** — the specific scope(s) it may read; it then searches only that scope and the scopes transitively `Contained By` it, never the whole vault, and **`scope_kind: system` scopes are excluded unless explicitly granted**.

Full triage tree, `_ephemeral` naming, daily notes, skills mechanics, and **what braindance actually requires of a vault** — the short list, each item paired with the code that enforces it: [`docs/vault.md`](docs/vault.md). **A vault's tag vocabulary is its own**: the source of truth is that vault's `_meta/Tags.md`, which this template deliberately does not ship and cannot keep in sync.

**`ctx/vault/_ephemeral/` is non-canonical scratch and the default sink for generated outputs** — gitignored and ephemeral. **Unless the user names a destination, write work products (reports, analyses, drafts, query results) here** rather than the repo root or `/tmp`; read and write it freely for transient inputs/outputs, but never treat it as canonical, and if something is worth keeping, **promote it into a real vault note** in `ctx/vault/`. (Naming convention in [`docs/vault.md`](docs/vault.md).)

## The repos dir

Target repos you're actively working on resolve under `${REPOS_PATH:-$BD_ROOT}/<name>`, defaulting to the gitignored nested `repo/<name>` when `BD_ROOT`/`REPOS_PATH` are unset. Clone the repos you're working on there so their code sits alongside this context; each may carry its own `CLAUDE.md` — defer to it for work inside that repo.

**The repos dir can be tens of GB** (full checkouts, build artifacts, worktrees) — nested inside the checkout or an external sibling, the hazard is the same. **Never run an unscoped shell search from the checkout root (or the repos dir)** — no `grep -r`, `find .`, `du .`, or `ls -R` over `.` — it will crawl the repos and stall the session. **Scope every shell command to the path you actually mean** (`ctx/`, `api/`, …). The Grep/Glob tools are safe (they honour `.gitignore`, which excludes the nested `repo/`); this rule is specifically about raw shell commands, which do not.

## Parallel work — never share a working tree

Multiple agent sessions must **never share the one working tree** — a shared index/HEAD means one session's `git add -A` sweeps another's half-written files, commits interleave, and `index.lock` contention stalls git. The rule: **one terminal = one git worktree = one branch.**

- The main tree (the braindance checkout — wherever you cloned it; `bd where` reports it) is **sacred and read-only to agents**: it stays on `main`, it's the Obsidian window and the integration point. **Agents don't write here.**
- Agent sessions work in sibling worktrees under `~/dev/bd-wt/<task>` (outside the vault, so Obsidian never indexes them), cut off **freshly-fetched `origin/main`** and **rebased before every push**. Helper `bd` (in `ctx/tools/sys/wt.sh`) bakes this in: `bd new <task>` → work → `bd land` → `bd rm <task>`.
- **Always address a worktree by its ABSOLUTE path**; never rely on an ambient `cwd` that could resolve into the sacred main tree.

Full discipline (R1–R7), the `bd` workflow, and fleet tooling: [`AGENTS.md`](AGENTS.md) + [`docs/worktrees.md`](docs/worktrees.md). Orchestrating a fleet of sub-agents: [`docs/orchestration.md`](docs/orchestration.md). Orthogonal ingress: VPS/`api` captures land directly on `main` in `ctx/vault/inbox/`, triaged in-vault at the desk ([`docs/serving.md`](docs/serving.md)).

## Conventions

- **Commits** — imperative summaries. On a personal instance, vault edits are conventionally prefixed `Vault: <summary — detail>`; keep that prefix scheme (`Skills:`, `Tools:`, `Docs:`, `Deploy:`) for other areas.
- **Product, not instance** — everything committed here must be generic enough to hand to a stranger; instance-specific content lives in the vault repo and machine-local config. (See the note at the top of this file, and [`docs/architecture.md`](docs/architecture.md).)
- **Output format** — write Markdown, and put every span of code, console/terminal output, query, config, or structured data in a fenced code block with a language hint (```python, ```sql, ```console, ```json, …). This holds for what we write to `_ephemeral`, to vault notes, and back to the user — never paste code or command output as bare prose.
- **Edit skills in `ctx/skills/`, never the installed harness copy** under `.claude/commands/` — the change would be lost or hit the wrong file. (Mechanics: [`docs/vault.md`](docs/vault.md).)
- **Publishing goes to a separate site repo.** `publish: true` notes are projected into the public site repo, which serves them at `/garden`. **The publish tool has no default target** — pass `--pub` or set `PUB_REPO`; it exits rather than guess, because a wrong guess writes private notes somewhere nobody is watching. Never hand-edit `garden/content/<slug>.md`: machine-owned by `ctx/tools/pub`, overwritten on the next run. That the site is a different repo *is* the privacy guarantee — it cannot leak a note it was never given. (Detail: [`docs/publishing.md`](docs/publishing.md).)
- **Don't touch** `.obsidian/` config unless explicitly asked (it's the Obsidian workspace, easy to corrupt).
- **Don't** fold the flat vault into folders, or mass-rewrite existing notes.
