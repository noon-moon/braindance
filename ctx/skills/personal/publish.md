---
name: publish
description: Project `publish: true` vault notes into the public site repo and deploy them. Use when the user wants to publish a note to the public garden, push garden changes live, or sync what's on the garden with the vault.
---

# Publish to the garden

Projects notes tagged `publish: true` from the vault into the **public site repo**, whose own Action builds and deploys it. The private vault is the source of truth; the public repo only ever contains what the tool projects — it **structurally cannot leak a private note**. Full design: `docs/publishing.md`; tool reference: `ctx/tools/pub/README.md`.

> The tool has **no default target** — it exits unless you pass `--pub` or set `PUB_REPO`. Deliberate: the target is per-instance, and a wrong default would write private notes somewhere nobody is watching.

**Before you start**, resolve the two paths for *this* instance and use them throughout:

- **vault** — `bd where` reports it, and the resolver exports it as `VAULT_PATH`.
- **site repo** — the instance's public site checkout. If `PUB_REPO` isn't already exported, ask; don't guess a path.

## Flow

1. **Tag notes.** A note publishes only with `publish: true` in its frontmatter. Internal scaffolding (`Created:`/`Tags:` preamble lines, `# References` sections, `dataview` blocks) is stripped automatically, and workflow frontmatter (`Contains`/`Contained By`, task fields, …) is dropped by a whitelist — so scope links never leak or block.
   - **Privacy gate:** a wikilink in real prose to a *non-published* note **blocks** the publish (strict mode). Resolve by publishing the target, unlinking, or re-running with `--scrub` (downgrades such links to plain text). A missing asset always blocks.

2. **Project.** Work in a worktree (`bd new publish-<what>`), never the main tree:
   ```bash
   export VAULT_REPO="$VAULT_PATH"        # or the vault `bd where` reported
   export PUB_REPO=<the site repo>
   npm --prefix ctx/tools/pub install                 # first time in a fresh worktree
   npm --prefix ctx/tools/pub run publish -- --dry    # preview: what would publish + warnings
   npm --prefix ctx/tools/pub run publish             # write it
   ```
   Check the `vault:` and `pub:` lines it prints before trusting the run. It writes flat into `$PUB_REPO/garden/content/` — one note per slug, served at `/garden/<slug>` — and records what it wrote in `garden/.publish-manifest.json`, deleting exactly those files next run. So un-tagging a note removes it from the garden automatically, while hand-authored pages like `content/index.md` are never touched.

3. **Re-audit, then review & push** in the site repo:
   ```bash
   npm --prefix ctx/tools/pub run verify -- --pub "$PUB_REPO"   # vault-blind; exit 1 = do not push
   cd "$PUB_REPO"
   git add garden/content garden/.publish-manifest.json && git diff --cached --stat
   git commit -m "Publish: <note(s)>" && git push
   ```
   The push is what makes it public — read the staged diff first. The site repo's Action then builds and deploys it.

## Notes
- **Slugs:** filenames are lowercased and non-alphanumerics become hyphens — `"Some Note - Title"` → `some-note---title`.
- The publish tool runs on any Node; only a *local* Quartz build/preview needs the version pinned in the site repo's `garden/.node-version`.
- **The gate runs twice** — at projection time (`publish`, vault in hand) and again over the committed projection with no vault access (`verify`). The second pass catches a file hand-edited after projection; run it before you push.
- Never hand-edit `garden/content/<slug>.md` — machine-owned, overwritten on the next run.
