---
tags:
  - scope
scope_kind: system
Contains:
  - "[[Topics]]"
  - "[[Tags]]"
---

The **system-scope hub** for how an agent orients in this repo — the meta layer *about* the vault rather than a topic *in* it. It is itself a `scope` with `scope_kind: system`, and it lists itself in [[Topics]] under System scopes (self-hosting).

## The topics manifest

[[Topics]] is the **authoritative-and-generated** manifest of every `scope` hub in the vault: the one-stop "does the repo have context on this topic, and where's its hub?" lookup. Two properties make it worth a single cheap read before any vault search:

- **Authoritative** — it is generated mechanically from every scope note's frontmatter, so it is complete by construction. A **miss is decisive**: if a topic isn't in the manifest, the vault has no scope for it, so **don't** fan out a speculative grep — the answer is "not here."
- **Generated** — never hand-edit it. Regenerate with `ctx/tools/sys/gen-topics.sh` (run it after adding, removing, or re-linking any `scope` note; `--check` fails if it's stale, for a pre-commit / CI gate). Output is a pure, deterministic function of scope frontmatter, so regen diffs stay clean.

Each entry is a hub `[[wikilink]]`, a one-line purpose, and its `Contains` children — so from the manifest you jump straight to the right MOC and follow its links, instead of scanning notes wholesale.

## Content vs. system scopes

`scope_kind` (a frontmatter field on `scope` notes; absent ⇒ `content`) splits the manifest in two:

- **Content scopes** — the user's actual topics (projects, media, knowledge): [[GameDev]], [[Music]], and the rest.
- **System scopes** (`scope_kind: system`) — the agent / infrastructure / meta layer: this note, [[Topics]] (the manifest), and [[Tags]] (the vault's tag + note-type schema). They describe *how the repo works*, not what it's *about*.

## Privacy / scope-grant model

A dispatched agent may be handed a **scope grant** — one or more scopes it is allowed to read. It then searches **only** that scope and the scopes transitively `Contained By` it (its sub-tree), never the whole vault. **`scope_kind: system` scopes are excluded from a content grant unless explicitly granted** — infra/meta context isn't pulled into content work by default.

- For the **local orchestrator** the grant is a token-optimization and a guardrail: consult [[Topics]] first, decide which sub-tree a task needs, and read only that.
- For a **dispatched sub-agent** it is enforceable: hand the agent only the granted sub-tree, so it *cannot* read beyond its grant.

## Doctrine entry points

The full agent doctrine lives in the repo root, not the vault (so it reaches every harness): `CLAUDE.md` is the canonical, fuller agent guide; `AGENTS.md` is the portable cross-tool entry point (the [AGENTS.md](https://agents.md) standard). Both carry the vault-triage tree (step 0 = consult [[Topics]] first) and the scope-grant rule summarized above. They are repo files rather than notes, so they are referenced here by path rather than by `[[wikilink]]`.
