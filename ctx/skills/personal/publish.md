---
name: publish
description: Project `publish: true` vault notes into the noon-moon-net Quartz garden and deploy them live to the VPS at /garden. Use when the user wants to publish a note to the public garden, push garden changes live, or sync what's on the garden with the vault.
---

# Publish to the garden

Projects notes tagged `publish: true` from the vault into **`noon-moon/noon-moon-net`**, the separate public Quartz repo, whose own Action builds and deploys to the VPS at `/garden`. The private vault is the source of truth; the public repo only ever contains what the tool projects — it **structurally cannot leak a private note**. Full design: `ctx/noon-moon-net.md`; tool reference: `ctx/tools/pub/README.md`.

> This instance publishes via the separate-repo topology, **not** GitHub Pages. The `ctx/www/` + `pages.yml` path in this repo is template scaffolding for forks that want a zero-server site; it is not our route, so always pass `--pub`/`PUB_REPO` rather than relying on the tool's default.

## Flow

1. **Tag notes.** A note publishes only with `publish: true` in its frontmatter. Internal scaffolding (`Created:`/`Tags:` preamble lines, `# References` sections, `dataview` blocks) is stripped automatically, and workflow frontmatter (`Contains`/`Contained By`, task fields, …) is dropped by a whitelist — so scope links never leak or block.
   - **Privacy gate:** a wikilink in real prose to a *non-published* note **blocks** the publish (strict mode). Resolve by publishing the target, unlinking, or re-running with `--scrub` (downgrades such links to plain text). A missing asset always blocks.

2. **Project.** Work in a worktree (`bd new publish-<what>`), never the main tree. Both paths are external to this repo, so set them explicitly:
   ```bash
   export VAULT_REPO=~/dev/vault           # the vault is its own repo
   export PUB_REPO=~/dev/noon-moon-net     # the public garden repo
   npm --prefix ctx/tools/pub install                 # first time in a fresh worktree
   npm --prefix ctx/tools/pub run publish -- --dry    # preview: what would publish + warnings
   npm --prefix ctx/tools/pub run publish             # write it
   ```
   Writes flat into `$PUB_REPO/garden/content/` — one note per slug, served at `/garden/<slug>`. It tracks what it wrote in `garden/.publish-manifest.json` and deletes exactly those files on the next run, so un-tagging a note removes it from the garden — deletions are automatic — while hand-authored pages like `content/index.md` are never touched.

3. **Re-audit, then review & push** in the public repo:
   ```bash
   npm --prefix ctx/tools/pub run verify -- --pub ~/dev/noon-moon-net   # vault-blind; exit 1 = do not push
   cd ~/dev/noon-moon-net
   git add -A garden/content garden/.publish-manifest.json && git diff --cached --stat
   git commit -m "Publish: <note(s)>" && git push
   ```
   The push is what makes it public — read the staged diff first. `noon-moon-net`'s Action then builds Quartz and rsyncs to the VPS; live at `/garden/<slug>` shortly after.

## Notes
- **Slugs:** filenames are lowercased and non-alphanumerics become hyphens — `"Deerhunter - Monomania"` → `deerhunter---monomania`.
- The publish tool runs on any Node; only a *local* Quartz build/preview needs Node 22 (`cd ~/dev/noon-moon-net/garden && nvm use 22.16.0`).
- **The gate runs twice** — at projection time (`publish`, vault in hand) and again over the committed projection with no vault access (`verify`). The second pass catches a file hand-edited after projection; run it before you push.
- Never hand-edit `garden/content/<slug>.md` — those are machine-owned and the next publish overwrites them.
