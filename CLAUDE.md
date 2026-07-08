# braindance — agent guide

braindance is a **meta-repository for agentic work**: a personal knowledge and workflow layer you carry between projects. This file orients an agent working *inside* the repo. Human-facing setup and deploy details live in [`README.md`](README.md); read that for anything this file only summarizes.

## Layout

```
ctx/
  vault/     Obsidian vault — your knowledge base and working context (see below)
  skills/    LLM-agnostic skill prompts; installed into a harness via ctx/tools/sys/sync.sh
  tools/     Lifecycle tooling (sys/) + standalone tools (e.g. music/)
  inputs/    Non-persisted inputs for consideration (gitignored; see below)
  outputs/   Non-persisted outputs — disposable work products, kept out of the vault (gitignored)
api/         Admin app: mobile note-capture API + read-only vault viewer (Hono/Node)
www/         Static homepage served at your domain
Caddyfile, docker-compose.yml, deploy.sh   Serving stack (see README "Admin app & serving")
repo/        Gitignored — target repos you're working on get cloned here
```

## Start here: `ctx/vault` is the working context

The vault is the canonical knowledge base — the ontology this repo exists to hold. **Before answering a question or acting on a task, search `ctx/vault` for relevant notes** and treat what you find there as ground truth about the user's world, projects, and decisions. In a personal instance the vault is full of notes; in the bare template it's just scaffolding (`_meta/`, `_templates/`, `TODO.md`) because notes are gitignored.

The source of truth for how the vault is structured is **`ctx/vault/_meta/Tags.md`** — read it before creating or restructuring notes. In brief:

- **Every note is `scope` or `memo`** (a frontmatter tag). `scope` = a hub/MOC note that links related notes via `Contains` / `Contained By`; `memo` = a substantive note on one topic.
- **Behavioural tags stack** on top: `todo` (actionable — `status`/`due`/`completed` fields), `recurring` (a standing routine tracked by `processed`), `daily` (a dated log note in `daily/`), `reference` (a standing go-to resource for an activity).
- **The vault is flat** — notes live directly in `ctx/vault/`, not in a folder taxonomy. Do **not** reorganize notes into subfolders. Wikilinks `[[Title]]` resolve by basename across the whole flat vault.
- **Filename = note title.** A note's identity is its filename; renaming a note means renaming the file (and it will break inbound `[[wikilinks]]` — check backlinks first).
- **Frontmatter drives Dataview.** `TODO.md` and other dashboards are live Dataview queries over frontmatter. A malformed tag or field silently drops a note from a view rather than erroring — get the schema right.
- **Templates** for new notes live in `ctx/vault/_templates/`. Use them.

### Daily notes & todos

Daily notes live in `ctx/vault/daily/` named `YYYY-MM-DD`. When a `todo` flips to `done` it stays in place (the record persists) with a `completed` wikilink to the daily note where it was finished. `TODO.md` is the aggregated master view. **Convert relative dates to absolute** (`due: 2026-08-01`, not "next month") — the views and daily-note links depend on real dates.

## `ctx/inputs` & `ctx/outputs` — non-persisted scratch

A symmetric pair of gitignored, ephemeral drop-zones. Neither is canonical — the vault is. Each ships with a tracked `README.md` (the only tracked file) so the dir and its meaning survive a clone.

- **`ctx/inputs/`** — files dropped *in* for a specific task (screenshots, exports, clippings, data). Read them as context for the work at hand, but don't rely on them persisting or treat them as canonical.
- **`ctx/outputs/`** — disposable work products you generate *out* (draft plans, generated reports, one-off analyses, intermediate artifacts). **Write transient output here instead of cluttering the vault with it.**

If anything in either dir is worth keeping, **promote it into a vault note** (`ctx/vault/`) rather than leaving it in scratch. (Both are distinct from the vault's own `assets/` and `attachments/`, which *are* persisted and are embedded in notes via `![[...]]`.)

## Skills

Skills are plain-markdown prompt-commands in `ctx/skills/`, grouped by area (`engineering/`, `productivity/`, `misc/`, `personal/`, and `usr/` for personal ones). They are the **source of truth**; a harness gets its own installed copy:

- Claude Code symlinks them into `.claude/commands/` (as `/slash-commands`) via `./ctx/tools/sys/sync.sh claude-code`.
- If `.claude/commands/` is missing or looks stale, run that sync command to (re)install.
- **Edit skills in `ctx/skills/`, never in the harness copy** under `.claude/commands/` (etc.) — for symlink harnesses you'd be editing the original by accident, and for copy harnesses your change would be silently overwritten on the next sync.

## Tools

`ctx/tools/sys/` holds braindance lifecycle tooling — `sync.sh` (skill install) and `flatten-vault.sh`. Other subdirs are standalone tools (e.g. `music/`, a Rust utility). These are infrastructure, not vault content.

## repo/

`repo/` is gitignored; clone the repos you're actively working on into it so their code sits alongside this context. Each may carry its own `CLAUDE.md` — defer to it for work inside that repo.

## Serving / deploy layer

`api/`, `www/`, `Caddyfile`, `docker-compose.yml`, and `deploy.sh` are the optional admin-app + public-serving stack, not vault content. The `api` captures notes to an `inbox` branch and serves a read-only vault viewer; on a personal instance the desk-side `Process Inbox` routine triages captures onto the working branch. Full configuration, the `/srv/.env` mechanics, and `./deploy.sh` usage are documented in `README.md` — consult it before changing anything here, and note the api has **no built-in auth** (it must sit behind a VPN/tunnel).

## Conventions

- **Commits** — imperative summaries. On a personal instance, vault edits are conventionally prefixed `Vault: <summary — detail>`; keep that prefix scheme (`Skills:`, `Tools:`, `Docs:`, `Deploy:`) for other areas.
- **Don't touch** `.obsidian/` config unless explicitly asked (it's the Obsidian workspace, easy to corrupt).
- **Don't** fold the flat vault into folders, mass-rewrite existing notes, or edit installed skill copies under `.claude/`.
