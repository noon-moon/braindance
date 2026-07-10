# ctx/tools/pub — the publish tool

Projects `publish: true` notes from `ctx/vault` flat into `ctx/www/garden/content`
(served at `/garden/<slug>`). Deterministic; run it, review the diff, commit. The
GitHub Pages workflow then builds and deploys the committed projection.

```bash
npm install                        # first time
npm run publish -- --dry           # report what would publish, write nothing
npm run publish                    # project into ctx/www (default) — strict, fail-closed
npm run publish -- --scrub         # downgrade private links/embeds + drop unresolvable assets
npm run publish -- --pub /path --vault /path   # override targets
npm run verify                     # CI gate: re-audit ctx/www/garden/content (vault-blind)
```

## The privacy boundary (fail-closed)

**`publish.ts` (default `--strict`)** — the projector, run locally against the vault.
Pipeline per note: `stripScaffolding` (drop `Created:`/`Tags:` preamble, `# References`,
`dataview` blocks) → `normalizeAssetEmbeds` → `classifyLinks` → **gate** →
`whitelistFrontmatter` → `regenerate` (flat write + `.publish-manifest.json` so
un-tagging deletes and hand-authored pages like `index.md` are untouched).

The gate is **fail-closed** — it exits nonzero and writes nothing when a published
note would leak:

- a **link** `[[private note]]` **or embed/transclusion** `![[private note]]` to a
  non-published vault note (both forms — `classifyLinks` treats a note transclusion
  as a note link; only `![[x.ext]]` is an asset),
- an **asset embed** `![[secret.png]]` whose file can't be resolved under the vault's
  `assets/`/`attachments/` (a reference outside the carried set).

Only assets a published note **actually references** are copied (per-note, by
basename), so a private asset never rides along unless a published note embeds it.

`--scrub` is the opt-in escape hatch: it downgrades private links **and embeds** to
plain text and drops unresolvable asset embeds, so a bulk publish proceeds. `--strict`
and `--scrub` are mutually exclusive. Frontmatter is always whitelisted
(`FM_WHITELIST`) — a new private field can never leak by omission.

**`verify.ts`** — the CI-side re-check. It reads **only** `ctx/www/garden/content`
(never the vault), so the Pages workflow stays vault-blind, and fails the deploy if
the committed projection contains a link/embed to an absent note, an embed of an
absent asset, or a disallowed frontmatter key. Defense-in-depth: even a bad
projection committed by hand is caught before it goes public.

## Layout

- `src/vault.ts` — walk / index / select / asset resolution
- `src/transform.ts` — scaffolding strip, link classify, scrub (links + embeds + assets), frontmatter whitelist, ref extraction
- `src/mirror.ts` — write flat into `garden/content` + maintain `.publish-manifest.json` (delete-on-untag)
- `src/publish.ts` — CLI + orchestration + strict/scrub gate (reads the vault)
- `src/verify.ts` — CI gate re-auditing the committed projection (vault-blind)

## Advanced: target a separate repo (VPS / two-repo model)

The default `--pub` is this repo's `ctx/www`. To keep the older structural
two-repo model (a separate public repo, e.g. served from a VPS), point the tool
elsewhere: `npm run publish -- --pub /path/to/other-repo` or set `PUB_REPO`. The
tool writes `<pub>/garden/content` regardless of where that is.
