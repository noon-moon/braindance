# Vault ontology, triage, `_ephemeral`, daily notes

On-demand detail for the vault guardrails stated tightly in [`CLAUDE.md`](../CLAUDE.md) ("don't search reflexively — triage first; `_ephemeral` is non-canonical scratch"). Read this when you are **actually working in the vault** — searching it, creating or restructuring notes, or writing scratch. The core carries the reflex-guardrails; this file carries the how.

The source of truth for how the vault is structured is **`ctx/vault/_meta/Tags.md`** (note types + tag schema) and **`ctx/vault/_meta/Agent Context.md`** (the topics-manifest + scope-grant model). Read those before creating or restructuring notes — this file recaps and points, it does not replace them.

## Triage each task before touching the vault

The vault runs to hundreds of notes; a speculative grep on *every* turn burns round-trips and bloats the context window, which compounds into slower responses across the whole session. Search only when the answer genuinely depends on the user's own notes — not for questions answerable from the conversation, from general knowledge, or from code already in front of you.

0. **Consult `ctx/vault/_meta/Topics.md` first — one cheap read.** It is the authoritative-and-generated manifest of every `scope` hub: it tells you whether the vault holds context on a topic and, if so, which MOC is its entry point. A **miss is authoritative** — if a topic isn't in the manifest, the vault has no scope for it, so **do not** fall through to a speculative grep. A hit hands you the hub to start from in step 2. (Model: `ctx/vault/_meta/Agent Context.md`; regenerate the manifest with `ctx/tools/sys/gen-topics.sh`.)
1. **Does answering require user-specific context** (their projects, decisions, notes, history)? If no — general knowledge, something already in context, a self-contained coding task — **answer directly and skip the vault.**
2. If yes, **is it about a known project or topic?** Search that term and **start from its `scope`/MOC note** — the hub that links the rest — then follow its links. Don't grep the whole vault.
3. If the topic is fuzzy, **let `ctx/vault/_meta/Tags.md` guide your keywords**, search those, and **read only the notes that actually hit.** Pull in linked notes only as the thread demands.

Keep context lean: one MOC or index note beats ten speculative reads. `TODO.md` (open work) and any `Resources`/index note are cheap, high-signal entry points — the `scope`/MOC layer *is* the vault's index, so lean on it rather than scanning notes wholesale.

**Scope grants (privacy + token guardrail).** A dispatched agent may be handed a **scope grant** — the specific scope(s) it is allowed to read. It then searches **only** that scope and the scopes transitively `Contained By` it (its sub-tree), never the whole vault, and **`scope_kind: system` scopes are excluded unless explicitly granted**. For the local orchestrator this is a token-optimization and a guardrail (consult `Topics.md`, pick the sub-tree a task needs, read only that); for a dispatched sub-agent it is *enforceable* — hand it only the granted sub-tree so it cannot read beyond its grant. See `ctx/vault/_meta/Agent Context.md`.

## Ontology in brief (full schema: `_meta/Tags.md`)

- **Every note is `scope` or `memo`** (a frontmatter tag). `scope` = a hub/MOC note that links related notes via `Contains` / `Contained By`; `memo` = a substantive note on one topic.
- **Behavioural tags stack** on top: `todo` (actionable — `status`/`due`/`completed` fields), `recurring` (a standing routine tracked by `processed`), `daily` (a dated log note in `daily/`), `reference` (a standing go-to resource for an activity).
- **The vault is flat** — notes live directly in `ctx/vault/`, not in a folder taxonomy. Do **not** reorganize notes into subfolders. Wikilinks `[[Title]]` resolve by basename across the whole flat vault.
- **Filename = note title.** A note's identity is its filename; renaming a note means renaming the file (and it will break inbound `[[wikilinks]]` — check backlinks first).
- **Frontmatter drives Dataview.** `TODO.md` and other dashboards are live Dataview queries over frontmatter. A malformed tag or field silently drops a note from a view rather than erroring — get the schema right.
- **Templates** for new notes live in `ctx/vault/_templates/`. Use them.

## Daily notes & todos

Daily notes live in `ctx/vault/daily/` named `YYYY-MM-DD`. When a `todo` flips to `done` it stays in place (the record persists) with a `completed` wikilink to the daily note where it was finished. `TODO.md` is the aggregated master view. **Convert relative dates to absolute** (`due: 2026-08-01`, not "next month") — the views and daily-note links depend on real dates.

## `ctx/vault/_ephemeral` — non-persisted scratch

**`ctx/vault/_ephemeral/` is the default sink for anything we generate.** Unless the user names a destination (or a skill/task specifies otherwise), work products we produce — draft plans, reports, one-off analyses, query results, intermediate artifacts — go here, not the repo root, `/tmp`, or the vault proper. It is the workbench for anything transient — files dropped *in* for a task (screenshots, exports, clippings, data) and the work products we generate *out* alike. It is **gitignored and ephemeral**: read and write it freely, but don't rely on anything there persisting, and never treat it as canonical. It lives *inside* the vault (underscore-prefixed like `_meta`/`_templates`) so its scratch is **visible in Obsidian** without switching apps — but it is explicitly **not canonical**. **Keep transient scratch here instead of cluttering the vault with real notes.** If something is worth keeping, **promote it into a real vault note** in `ctx/vault/`. Scratch files here generally carry no frontmatter, so they stay out of Dataview queries and off to the side of the graph.

**Naming — every file here is flat-packed and timestamp-prefixed.** No subdirectories *except* `img/` (the one sanctioned exception — see the end of this paragraph), and every other file (memos, reports, queries, scratch alike) gets a leading sortable prefix derived from `YY-MM-DD-HH-MM-SS`, with each decimal digit `d` replaced by its 9's-complement `9 − d` (dashes stay put): `0→9, 1→8, 2→7, 3→6, 4→5, 5→4, 6→3, 7→2, 8→1, 9→0`. Filename shape: `<complemented-timestamp>-<descriptive-slug>.<ext>`. Worked example: `2026-07-11 14:23:05` → real timestamp `26-07-11-14-23-05` → complement each digit → `73-92-88-85-76-94-biome-analysis.md`. The map is its own inverse, so decoding is the same operation: `d = 9 − c` recovers the original timestamp from the complemented one. Because a larger (newer) digit always complements to a smaller one, this makes the flat directory sort **newest-first** under an **ascending** name sort — Obsidian's default file-explorer order — with no descending toggle needed. (A hex per-digit map, `15 − d` i.e. `0→f … 9→6`, would also reverse the order and was considered, but it trades glanceable decimal digits for hex letters with no real benefit — the decimal complement is 1:1, fixed-width, and self-inverse, so it's what we standardize on.) This applies to **new** files only — existing `_ephemeral` files are scratch, don't retro-rename them; the convention is forward-looking. A tracked `README.md` (the only tracked file — the `_ephemeral/*` contents are gitignored) carries the dir and its meaning across a clone. **Exception — generated/rendered images live in `ctx/vault/_ephemeral/img/`** under plain descriptive names (e.g. `loon-pr6-terrain.png`), *not* the timestamp scheme: images are recalled by what they depict rather than when they were made, and corralling them in one subdir keeps them from swamping the flat newest-first sort of the text scratch. (Distinct from the vault's own `assets/` and `attachments/`, which *are* persisted and embedded via `![[...]]`.)

## Skills & tools mechanics

Skills are plain-markdown prompt-commands in `ctx/skills/`, grouped by area (`engineering/`, `productivity/`, `misc/`, `personal/`, and `usr/` for personal ones). They are the **source of truth**; a harness gets its own installed copy:

- Claude Code symlinks them into `.claude/commands/` (as `/slash-commands`) via `./ctx/tools/sys/sync.sh claude-code`.
- If `.claude/commands/` is missing or looks stale, run that sync command to (re)install.
- **Edit skills in `ctx/skills/`, never in the harness copy** under `.claude/commands/` (etc.) — for symlink harnesses you'd be editing the original by accident, and for copy harnesses your change would be silently overwritten on the next sync.

`ctx/tools/sys/` holds braindance lifecycle tooling — `sync.sh` (skill install), `flatten-vault.sh`, and `gen-topics.sh` (regenerate the `_meta/Topics.md` topics manifest from scope-note frontmatter; run after adding/removing/re-linking a `scope` note, or `--check` in CI). Other subdirs are standalone tools (e.g. `music/`, a Rust utility). These are infrastructure, not vault content.
