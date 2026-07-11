# braindance — agent guide

braindance is a **meta-repository for agentic work**: a personal knowledge and workflow layer you carry between projects. This file orients an agent working *inside* the repo. Human-facing setup and deploy details live in [`README.md`](README.md); read that for anything this file only summarizes.

**This is the canonical, fuller agent guide.** [`AGENTS.md`](AGENTS.md) at the repo root is the cross-tool entry point (the [AGENTS.md](https://agents.md) standard, read by non-Claude harnesses); it is the **canonical home of the portable multi-agent worktree discipline (R1–R7)** that reaches every tool and every target project cloned under `repo/`. This file does not restate those rules — the worktree section below covers the braindance-specific `bd` workflow and points to AGENTS.md for the discipline. Keep the two complementary, not duplicated.

**Template vs. fork — where changes go.** This repo is a template. Generic changes — guidelines, conventions, tooling, skills, docs, this file, AGENTS.md — belong in the **core template repo** (`noon-moon/braindance`, branch `master`) and NEVER get committed to a personal fork/instance. A fork holds only instance-specific content (real vault notes, its own homepage/`www`, `/srv` deploy specifics) and **consumes template updates via `git merge upstream/master`**. If you find yourself about to commit a generic improvement to a fork, stop and land it on the core template instead. (See AGENTS.md for the same rule stated for every tool.)

## Layout

```
ctx/
  vault/     Obsidian vault — your knowledge base and working context (see below)
    _ephemeral/  Non-persisted scratch — transient inputs & outputs; gitignored but Obsidian-visible (see below)
  skills/    LLM-agnostic skill prompts; installed into a harness via ctx/tools/sys/sync.sh
  tools/     Lifecycle tooling (sys/), pub/ (vault→garden publish tool), orchestration/ (fleet helpers), + standalone tools
  www/       Published website — homepage + static pages + Quartz garden → GitHub Pages (see below)
api/         Admin app: mobile note-capture API + read-only vault viewer (Hono/Node)
www/         Static homepage served at your domain (advanced VPS path — distinct from ctx/www)
Caddyfile, docker-compose.yml, deploy.sh   Serving stack (see README "Admin app & serving")
repo/        Gitignored — target repos you're working on get cloned here
```

## Start here: `ctx/vault` is the working context

The vault is the canonical knowledge base — the ontology this repo exists to hold. It is the ground truth about the user's world, projects, and decisions, so **when a task depends on that context, search `ctx/vault` before acting and treat what you find there as authoritative.** In a personal instance the vault is full of notes; in the bare template it's just scaffolding (`_meta/`, `_templates/`, `TODO.md`) because notes are gitignored.

But **don't search reflexively.** The vault runs to hundreds of notes; a speculative grep on *every* turn burns round-trips and bloats the context window, which compounds into slower responses across the whole session. Search only when the answer genuinely depends on the user's own notes — not for questions answerable from the conversation, from general knowledge, or from code already in front of you.

**Triage each task before touching the vault:**

1. **Does answering require user-specific context** (their projects, decisions, notes, history)? If no — general knowledge, something already in context, a self-contained coding task — **answer directly and skip the vault.**
2. If yes, **is it about a known project or topic?** Search that term and **start from its `scope`/MOC note** — the hub that links the rest — then follow its links. Don't grep the whole vault.
3. If the topic is fuzzy, **let `ctx/vault/_meta/Tags.md` guide your keywords**, search those, and **read only the notes that actually hit.** Pull in linked notes only as the thread demands.

Keep context lean: one MOC or index note beats ten speculative reads. `TODO.md` (open work) and any `Resources`/index note are cheap, high-signal entry points — the `scope`/MOC layer *is* the vault's index, so lean on it rather than scanning notes wholesale.

The source of truth for how the vault is structured is **`ctx/vault/_meta/Tags.md`** — read it before creating or restructuring notes. In brief:

- **Every note is `scope` or `memo`** (a frontmatter tag). `scope` = a hub/MOC note that links related notes via `Contains` / `Contained By`; `memo` = a substantive note on one topic.
- **Behavioural tags stack** on top: `todo` (actionable — `status`/`due`/`completed` fields), `recurring` (a standing routine tracked by `processed`), `daily` (a dated log note in `daily/`), `reference` (a standing go-to resource for an activity).
- **The vault is flat** — notes live directly in `ctx/vault/`, not in a folder taxonomy. Do **not** reorganize notes into subfolders. Wikilinks `[[Title]]` resolve by basename across the whole flat vault.
- **Filename = note title.** A note's identity is its filename; renaming a note means renaming the file (and it will break inbound `[[wikilinks]]` — check backlinks first).
- **Frontmatter drives Dataview.** `TODO.md` and other dashboards are live Dataview queries over frontmatter. A malformed tag or field silently drops a note from a view rather than erroring — get the schema right.
- **Templates** for new notes live in `ctx/vault/_templates/`. Use them.

### Daily notes & todos

Daily notes live in `ctx/vault/daily/` named `YYYY-MM-DD`. When a `todo` flips to `done` it stays in place (the record persists) with a `completed` wikilink to the daily note where it was finished. `TODO.md` is the aggregated master view. **Convert relative dates to absolute** (`due: 2026-08-01`, not "next month") — the views and daily-note links depend on real dates.

## `ctx/vault/_ephemeral` — non-persisted scratch

`ctx/vault/_ephemeral/` is the workbench for anything transient — files dropped *in* for a task (screenshots, exports, clippings, data) and work products you generate *out* (draft plans, reports, one-off analyses, intermediate artifacts) alike. It is **gitignored and ephemeral**: read and write it freely, but don't rely on anything there persisting, and never treat it as canonical. It lives *inside* the vault (underscore-prefixed like `_meta`/`_templates`) so its scratch is **visible in Obsidian** without switching apps — but it is explicitly **not canonical**. **Keep transient scratch here instead of cluttering the vault with real notes.** If something is worth keeping, **promote it into a real vault note** in `ctx/vault/`. Scratch files here generally carry no frontmatter, so they stay out of Dataview queries and off to the side of the graph. **Every file here is flat-packed and timestamp-prefixed** — no subdirectories, and everything (memos, images, reports, scratch alike) gets a leading sortable timestamp: `YY-MM-DD-HH-MM-SS-<descriptive-slug>.<ext>` (e.g. `26-07-11-14-23-05-biome-analysis.md`). Date-then-24h-time keeps the flat directory in chronological name order and shows **latest-first** when it's sorted by name descending. Existing files are scratch — don't retro-rename them; the convention is forward-looking. A tracked `README.md` (the only tracked file — the `_ephemeral/*` contents are gitignored) carries the dir and its meaning across a clone. (Distinct from the vault's own `assets/` and `attachments/`, which *are* persisted and embedded via `![[...]]`.)

## Skills

Skills are plain-markdown prompt-commands in `ctx/skills/`, grouped by area (`engineering/`, `productivity/`, `misc/`, `personal/`, and `usr/` for personal ones). They are the **source of truth**; a harness gets its own installed copy:

- Claude Code symlinks them into `.claude/commands/` (as `/slash-commands`) via `./ctx/tools/sys/sync.sh claude-code`.
- If `.claude/commands/` is missing or looks stale, run that sync command to (re)install.
- **Edit skills in `ctx/skills/`, never in the harness copy** under `.claude/commands/` (etc.) — for symlink harnesses you'd be editing the original by accident, and for copy harnesses your change would be silently overwritten on the next sync.

## Tools

`ctx/tools/sys/` holds braindance lifecycle tooling — `sync.sh` (skill install) and `flatten-vault.sh`. Other subdirs are standalone tools (e.g. `music/`, a Rust utility). These are infrastructure, not vault content.

## repo/

`repo/` is gitignored; clone the repos you're actively working on into it so their code sits alongside this context. Each may carry its own `CLAUDE.md` — defer to it for work inside that repo.

**`repo/` can be tens of GB** (full checkouts, build artifacts, worktrees). **Never run an unscoped shell search from the repo root** — no `grep -r`, `find .`, `du .`, or `ls -R` over `.` — it will crawl `repo/` and stall the session. **Scope every shell command to the path you actually mean** (`ctx/`, `api/`, …). The Grep/Glob tools are safe (they honour `.gitignore`, which excludes `repo/`); this rule is specifically about raw shell commands, which do not.

## Serving / deploy layer

`api/`, `www/`, `Caddyfile`, `docker-compose.yml`, and `deploy.sh` are the optional admin-app + public-serving stack, not vault content. The `api` captures notes to an `inbox` branch and serves a read-only vault viewer; on a personal instance the desk-side `Process Inbox` routine triages captures onto the working branch. Full configuration, the `/srv/.env` mechanics, and `./deploy.sh` usage are documented in `README.md` — consult it before changing anything here, and note the api has **no built-in auth** (it must sit behind a VPN/tunnel).

## Publishing to GitHub Pages (`ctx/www`)

`ctx/www/` is the **out-of-the-box public website** — a homepage, arbitrary static pages, and a Quartz digital garden at `/garden` — deployed to **GitHub Pages** by `.github/workflows/pages.yml` (the Pages *artifact*, no `gh-pages` branch, no VPS). It sits **beside `ctx/vault`** and is the single source for the deployed site; see `ctx/www/README.md` for the layout and authoring rules (chiefly: author **relative** URLs). This is the recommended default; the `Caddyfile`/`docker-compose`/`deploy.sh` VPS stack remains an **advanced** option (server-side compute, the structural two-repo privacy model). One-time repo setup: Settings → Pages → Source = "GitHub Actions"; optional repo variable `SITE_CUSTOM_DOMAIN` for a custom domain (unset → `https://<owner>.github.io/<repo>/`).

**Publishing a note is manual and local**, then committed: `npm --prefix ctx/tools/pub run publish` selects `publish: true` vault notes and projects them (gated, scrubbed, frontmatter-whitelisted) into `ctx/www/garden/content/<slug>.md` (machine-owned; delete-on-untag via a manifest). Review `git diff ctx/www/garden/content` and commit — that commit *is* the reviewable "exactly what's going public" changeset. CI only builds already-committed content.

**Co-locating the vault and the published site trades a structural privacy guarantee for a procedural one, so the boundary is enforced fail-closed at three points — do not weaken any of them:**

- **(a) Build-scope isolation** — `pages.yml` builds ONLY from `ctx/www` (+ the pub tool); it has **no step that reads `ctx/vault`**. The vault is never an input to the deployed artifact.
- **(b) Fail-closed publish gate** — the projector (`ctx/tools/pub`, default `--strict`) blocks on any link **or embed/transclusion** to an unpublished note (`[[x]]` **and** `![[x]]`) and on any unresolvable asset embed; only referenced, resolvable assets are carried. `pages.yml` additionally runs `npm run verify` — a **vault-blind** re-audit of the committed `ctx/www/garden/content` that **breaks the deploy** (nonzero exit) on a leaked link/embed, a dangling asset, or a non-whitelisted frontmatter key.
- **(c) Disjoint-`www` PR check** — `.github/workflows/disjoint-www.yml` **fails any PR that touches `ctx/www/**` AND anything outside it**, so a publish stays isolated and a vault edit can never be swept into it. The rare Pages-infrastructure PR bypasses with `[www-infra]` in the title. (Guardrail rule also stated in `AGENTS.md`.)

## Parallel work with worktrees

Multiple agent sessions must **never share the one working tree** — a shared index/HEAD means one session's `git add -A` sweeps another's half-written files, commits interleave on `main`, and `index.lock` contention stalls git. The rule: **one terminal = one git worktree = one branch.** The full portable discipline (R1–R7 — read-only main checkout, fresh-base worktrees, rebase-before-push, WIP checkpoints, one-owner-per-file, post-merge sibling rebase, exclusive perf agents) is canonical in [`AGENTS.md`](AGENTS.md) and applies to any target project cloned under `repo/` too. This section is the braindance-repo operational layer:

- The main tree (the braindance checkout, e.g. `~/dev/braindance-usr`) is sacred: it stays on `main`, it's the Obsidian window and the integration point. **Agents don't write here.** Occasionally `git pull --ff-only` it.
- Agent sessions work in sibling worktrees under `~/dev/bd-wt/<task>` — **outside** the vault, so Obsidian never indexes them. Helper `bd` (in `ctx/tools/sys/wt.sh`, sourced from your shell rc):
  - `bd new <task>` — worktree + branch `wt/<task>` off **freshly-fetched** `origin/main`, cd in
  - `bd wip [msg]` — checkpoint uncommitted work in the worktree (a rebasable commit; squashed at land) — leave one before you yield so a stop/crash never loses work (R4)
  - `bd land` — **re-fetch + rebase onto `origin/main` before pushing** (R2), then open + squash-merge a PR (self-land; the PR is the audit trail, `main` stays linear)
  - `bd rm <task>` — remove the worktree + local branch
- **Always address a worktree by its ABSOLUTE path** (`~/dev/bd-wt/<task>/…`); never rely on an ambient `cwd` or repo-relative paths that could resolve into the sacred main tree.
- A session is: `bd new fix-tags` → work → `bd land` → `bd rm fix-tags`. Because the flat vault is file-per-note, disjoint-file sessions rebase and land with no conflict.
- Orthogonal path: VPS/`api` writes go to the `inbox` branch (funnel-shaped, desk-triaged) — not this flow, which governs local sessions landing on `main`.

**Fleets of parallel agents in a target project** (`repo/<project>`) additionally use the orchestration tooling in `ctx/tools/orchestration/` — the owner↔branch coordination ledger (`agent-ledger.md`, R7), post-merge `rebase-open-prs.sh` (R5/R6), and perf `loadguard.sh` (R3) — plus whatever local guard hooks that target repo installs (R1 blocks writes to its main checkout; R4 checkpoints worktree WIP). See `ctx/tools/orchestration/README.md`.

## Conventions

- **Commits** — imperative summaries. On a personal instance, vault edits are conventionally prefixed `Vault: <summary — detail>`; keep that prefix scheme (`Skills:`, `Tools:`, `Docs:`, `Deploy:`) for other areas.
- **Template, not fork** — generic/guideline/tooling/skill/doc changes land on the core template (`noon-moon/braindance`, `master`); a fork carries only instance-specific content and pulls the rest via `git merge upstream/master`. See the note at the top of this file.
- **Don't touch** `.obsidian/` config unless explicitly asked (it's the Obsidian workspace, easy to corrupt).
- **Don't** fold the flat vault into folders, mass-rewrite existing notes, or edit installed skill copies under `.claude/`.
