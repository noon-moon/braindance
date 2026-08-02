# ctx/tools/pub — the publish tool

Projects `publish: true` notes from your vault flat into a Quartz garden's `garden/content` (served at `/garden/<slug>`). Deterministic; run it, review the diff, commit. Full design & rationale: [`ctx/noon-moon-net.md`](../../noon-moon-net.md).

**The default target is the in-repo garden, `ctx/www/garden/`**, which `.github/workflows/pages.yml` builds and deploys to GitHub Pages. Point `--pub` at a separate garden repo instead if you want the stronger *structural* isolation of a public repo that never contains a private note (see "Two topologies" below).

```bash
npm install                                  # first time
npm run publish -- --dry                     # report what would publish, write nothing
npm run publish                              # project into ctx/www (→ ctx/www/garden/content)
npm run publish -- --scrub                   # downgrade private links to text instead of blocking
npm run publish -- --pub /path --vault /path
```

`--pub` names the directory *containing* `garden/`, not the garden itself.

**Paths resolve in this order:** flag → env var → default.

| What | Flag | Env | Default |
|---|---|---|---|
| Vault to read | `--vault` | `VAULT_REPO` | `ctx/vault` (in-repo) |
| Garden to write | `--pub` | `PUB_REPO` | `ctx/www` (in-repo) |

If your vault is **external** (`BD_ROOT` / `VAULT_PATH` — the usual case for a real instance), the in-repo default is a gitignored placeholder and will select nothing. Set `VAULT_REPO` to the real vault, or pass `--vault`.

Pipeline (per note): `stripScaffolding` (drop `Created:`/`Tags:` preamble, `# References`, `dataview` blocks) → `normalizeAssetEmbeds` → `classifyLinks` → **gate** (strict: block any link to a non-published note — the privacy boundary; missing assets always block) → `whitelistFrontmatter` (drop everything but a safe key set) → `regenerate` (writes flat into `garden/content`; a `.publish-manifest.json` records the tool-owned files so deletes are automatic and hand-authored pages like `index.md` are untouched).

- `src/vault.ts` — walk / index / select / asset resolution
- `src/transform.ts` — scaffolding strip, link classify, frontmatter whitelist
- `src/mirror.ts` — write flat into `garden/content` + maintain `.publish-manifest.json`
- `src/publish.ts` — CLI + orchestration + gate

## Two topologies

**In-repo (default).** The garden lives at `ctx/www/garden/` and ships to GitHub Pages. The repo stays private; only the built artifact is public. Isolation is enforced by three checks rather than by construction: `pages.yml` is build-scope-isolated (no step reads `ctx/vault`), the publish gate re-audits the committed projection vault-blind, and `disjoint-www.yml` fails any PR mixing `ctx/www/**` with anything outside it. Zero servers, nothing to provision.

**Separate garden repo.** Point `--pub`/`PUB_REPO` at a public Quartz repo, review the diff there, and let that repo's own Action build and deploy it. The guarantee is structural — a public repo cannot leak a note it never contains — at the cost of a second repo and its deploy. This is the topology `ctx/noon-moon-net.md` was originally designed around.

## Known gap

`pages.yml` invokes `npm run verify` (the vault-blind re-audit, enforcement point (b)), but **no `verify` script exists** in `package.json` and there is no `src/verify.ts` — that step will fail the workflow. Until it is written, the gate runs only at projection time, inside `npm run publish`, and the CI re-audit the privacy model describes is not actually in place.
