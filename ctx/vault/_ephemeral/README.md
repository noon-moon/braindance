# _ephemeral

**Non-persisted scratch — where transient things live.**

Anything that shouldn't be saved to the knowledge base goes here: files dropped
in for an agent to consider (screenshots, exports, clippings, data) and work
products generated back out (draft plans, reports, one-off analyses,
intermediate artifacts) alike. Everything in this directory is **gitignored and
ephemeral** (only this README is tracked).

This folder lives *inside* the vault (`ctx/vault/_ephemeral/`) so its scratch is
**visible in Obsidian** without switching apps — the underscore prefix groups it
with the vault's other non-note dirs (`_meta`, `_templates`) and flags it as
clearly non-canonical. Scratch files here generally carry no frontmatter, so
they stay out of Dataview queries and sit off to the side in the graph.

- Read from it and write to it freely — but don't rely on anything here
  lasting, and never treat it as canonical.
- If something turns out to be worth keeping, **promote it into a real vault
  note** in `ctx/vault/` rather than leaving it in scratch.

Distinct from the vault's own `assets/` and `attachments/`, which *are*
persisted and are embedded in notes via `![[...]]`. The vault is the record;
this is the workbench.
