# ctx/tools/pub — the publish tool

Projects `publish: true` notes from this vault flat into `noon-moon-net/garden/content` (served at `/garden/<slug>`). Deterministic; run it, review the diff in `noon-moon-net`, commit. Full design & rationale: [`ctx/noon-moon-net.md`](../../noon-moon-net.md).

```bash
npm install                        # first time
npm run publish -- --dry           # report what would publish, write nothing
npm run publish                    # project into ~/dev/noon-moon-net (or $PUB_REPO)
npm run publish -- --scrub         # downgrade private links to text instead of blocking
npm run publish -- --pub /path --vault /path
```

Pipeline (per note): `stripScaffolding` (drop `Created:`/`Tags:` preamble, `# References`, `dataview` blocks) → `normalizeAssetEmbeds` → `classifyLinks` → **gate** (strict: block any link to a non-published note — the privacy boundary; missing assets always block) → `whitelistFrontmatter` (drop everything but a safe key set) → `regenerate` (writes flat into `garden/content`; a `.publish-manifest.json` records the tool-owned files so deletes are automatic and hand-authored pages like `index.md` are untouched).

- `src/vault.ts` — walk / index / select / asset resolution
- `src/transform.ts` — scaffolding strip, link classify, frontmatter whitelist
- `src/mirror.ts` — write flat into `garden/content` + maintain `.publish-manifest.json`
- `src/publish.ts` — CLI + orchestration + gate
