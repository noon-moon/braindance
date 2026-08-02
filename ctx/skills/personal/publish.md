---
name: publish
description: Project `publish: true` vault notes into the in-repo Quartz garden at ctx/www/garden and deploy them live via GitHub Pages. Use when the user wants to publish a note to the public garden, push garden changes live, or sync what's on the garden with the vault.
---

# Publish to the garden

Projects notes tagged `publish: true` from the vault into the **in-repo** Quartz garden at `ctx/www/garden/`, which `.github/workflows/pages.yml` builds and deploys to **GitHub Pages**. The vault is the source of truth. Full design: `ctx/noon-moon-net.md`; tool reference: `ctx/tools/pub/README.md`.

The repo is private — only the built Pages artifact is public. Isolation is enforced, not structural: CI never reads the vault, and `disjoint-www.yml` fails any PR mixing `ctx/www/**` with anything else. **So a publish must be its own changeset.**

## Flow

1. **Tag notes.** A note publishes only with `publish: true` in its frontmatter. Internal scaffolding (`Created:`/`Tags:` preamble lines, `# References` sections, `dataview` blocks) is stripped automatically, and workflow frontmatter (`Contains`/`Contained By`, task fields, …) is dropped by a whitelist — so scope links never leak or block.
   - **Privacy gate:** a wikilink in real prose to a *non-published* note **blocks** the publish (strict mode). Resolve by publishing the target, unlinking, or re-running with `--scrub` (downgrades such links to plain text). A missing asset always blocks.

2. **Project.** Work in a worktree (`bd new publish-<what>`), never the main tree. The vault is **external**, so point the tool at it:
   ```bash
   export VAULT_REPO=~/dev/vault
   npm --prefix ctx/tools/pub install                 # first time in a fresh worktree
   npm --prefix ctx/tools/pub run publish -- --dry    # preview: what would publish + warnings
   npm --prefix ctx/tools/pub run publish             # write it
   ```
   Writes flat into `ctx/www/garden/content/` — one note per slug, served at `/garden/<slug>`. It tracks what it wrote in `garden/.publish-manifest.json` and deletes exactly those files on the next run, so un-tagging a note removes it from the garden — deletions are automatic — while hand-authored pages like `content/index.md` are never touched.

3. **Review & land — `ctx/www/**` and nothing else:**
   ```bash
   git add ctx/www && git diff --cached --stat        # exactly what is going public
   git commit -m "Publish: <note(s)>"
   bd land
   ```
   Do **not** sweep a vault or tooling edit into this commit — `disjoint-www.yml` will fail the PR, and that check is a privacy control, not a nuisance. Once merged, `pages.yml` builds and deploys; live in a couple of minutes.

## Notes
- **Slugs:** filenames are lowercased and non-alphanumerics become hyphens — `"Deerhunter - Monomania"` → `deerhunter---monomania`.
- The publish tool runs on any Node; only a *local* Quartz build/preview needs Node 22 (`cd ctx/www/garden && nvm use 22.16.0`).
- Always review the staged diff before landing — the merge is what makes it public.
- **Known gap:** there is no CI re-audit of the committed projection — the gate runs only at projection time, inside `npm run publish`. So the staged diff is the last line of defence: read it. Never hand-edit anything under `ctx/www/garden/content/`; nothing re-checks it.
