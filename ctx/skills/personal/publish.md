---
name: publish
description: Project `publish: true` vault notes into the noon-moon-net garden and deploy them live to noon-moon.net/garden. Use when the user wants to publish a note to the public garden, push garden changes live, or sync what's on noon-moon.net/garden with the vault.
---

# Publish to the garden

Projects notes tagged `publish: true` from this vault into `noon-moon-net`'s Quartz garden, then deploys to `noon-moon.net/garden`. The private vault is the source of truth; the public repo only ever contains what the tool projects — it structurally cannot leak a private note. Full design: `ctx/noon-moon-net.md`.

## Flow

1. **Tag notes.** A note publishes only with `publish: true` in its frontmatter. Internal scaffolding (`Created:`/`Status:`/`Tags:` preamble lines, `# References` / `# Connections` backlinks sections, `dataview` blocks) is stripped automatically, and workflow frontmatter (`Contains`/`Contained By`, todo fields, `year`, …) is dropped by a whitelist — so scope links never leak or block.
   - **Privacy gate:** a wikilink in real prose to a *non-published* note **blocks** the publish (strict mode). Resolve by publishing the target, unlinking, or re-running with `--scrub` (downgrades such links to plain text).

2. **Project** (from a `braindance-usr` checkout):
   ```bash
   npm --prefix ctx/tools/pub run publish -- --dry   # preview: what would publish + warnings
   npm --prefix ctx/tools/pub run publish            # write it
   ```
   Writes flat into `~/dev/noon-moon-net/garden/content/` — one note per slug, served at `/garden/<slug>` (override the repo with `--pub <path>` or `PUB_REPO`). It tracks the files it wrote in `garden/.publish-manifest.json` and deletes exactly those on the next run, so un-tagging a note removes it from the garden — deletions are automatic — while hand-authored pages like `content/index.md` are never touched.

3. **Review & deploy** in the public repo:
   ```bash
   cd ~/dev/noon-moon-net
   git add -A garden/content garden/.publish-manifest.json && git diff --cached --stat
   git commit -m "Publish: <note(s)>" && git push
   ```
   The `noon-moon-net` Action builds Quartz and rsyncs to the VPS. Live at `noon-moon.net/garden/<slug>` in ~2 min.

## Notes
- **Slugs:** filenames are lowercased and non-alphanumerics become hyphens — `"Deerhunter - Monomania"` → `deerhunter---monomania`.
- The publish tool runs on any Node; only a *local* Quartz build/preview needs Node 22 (`cd ~/dev/noon-moon-net/garden && nvm use 22.16.0`).
- Always review the diff in `noon-moon-net` before pushing — the push is what makes it public.
