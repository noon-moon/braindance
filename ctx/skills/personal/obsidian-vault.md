---
name: obsidian-vault
description: Search, create, and manage notes in the Obsidian vault with wikilinks and index notes. Use when user wants to find, create, or organize notes in Obsidian.
---

# Obsidian Vault

## Vault location

Configure this skill with your vault path. Default for braindance users: `ctx/vault/` relative to the repo root.

## Naming conventions

- **Scope notes**: hub notes that aggregate related topics — Title Case, tagged `scope`
- **Memo notes**: standard notes on a topic — Title Case, tagged `memo`
- No deep folder structures — use links and scope notes instead

## Linking

- Use Obsidian `[[wikilinks]]` syntax: `[[Note Title]]`
- Notes link to related notes at the bottom
- Scope notes list their contained notes as `[[wikilinks]]`

## Workflows

### Search for notes

```bash
# Search by filename
find "<vault-path>" -name "*.md" | grep -i "keyword"

# Search by content
grep -rl "keyword" "<vault-path>" --include="*.md"
```

Or use Grep/Glob tools directly on the vault path.

### Create a new note

1. Use **Title Case** for filename
2. Apply the appropriate template (`scope` or `memo`) from `_templates/`
3. Write content
4. Add `[[wikilinks]]` to related notes
5. If it's a scope, update parent scope's `Contains` frontmatter field

### Find related notes

Search for `[[Note Title]]` across the vault to find backlinks:

```bash
grep -rl "\\[\\[Note Title\\]\\]" "<vault-path>" --include="*.md"
```

### Find scope notes

```bash
grep -rl "tags:.*scope" "<vault-path>" --include="*.md"
```
