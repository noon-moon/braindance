# ctx/tools/pub — the publish tool

Projects `publish: true` notes from your vault flat into a Quartz garden's `garden/content` (served at `/garden/<slug>`). Deterministic; run it, review the diff, commit. Full design & rationale: [`docs/publishing.md`](../../../docs/publishing.md).

**The target is your public site repo, and there is no default.** Both tools exit non-zero unless `--pub` (or `PUB_REPO`) names it. That the site is a *different repo* is the whole privacy guarantee — it cannot leak a note it was never given — and a default would quietly undo it by writing private notes into whatever directory happened to be there.

```bash
npm install                                  # first time
export VAULT_REPO=~/dev/vault                # your vault, if not already resolved
export PUB_REPO=<your site repo>            # required — no default

npm run publish -- --dry                     # report what would publish, write nothing
npm run publish                              # write it
npm run publish -- --scrub                   # downgrade private links to text instead of blocking
npm run publish -- --pub /path --vault /path # or be explicit per-run

npm run verify                               # re-audit the COMMITTED projection, vault-blind
```

Every run prints the `vault:` and `pub:` it resolved — check that line before trusting a dry run.

`--pub` names the directory *containing* `garden/`, not the garden itself.

**Paths resolve in this order:** flag → env var → default.

| What | Flag | Env | Default |
|---|---|---|---|
| Vault to read | `--vault` | `VAULT_REPO`, then `VAULT_PATH` | `ctx/vault` (in-repo placeholder) |
| Site to write | `--pub` | `PUB_REPO` | **none — required** |

`VAULT_PATH` is in the chain because the instance resolver exports it, so inside a configured context the right vault is already named. The in-repo `ctx/vault` fallback is a gitignored placeholder and will select nothing on a real instance.

Pipeline (per note): `stripScaffolding` (drop `Created:`/`Tags:` preamble, `# References`, `dataview` blocks) → `normalizeAssetEmbeds` → `classifyLinks` → **gate** (strict: block any link to a non-published note — the privacy boundary; missing assets always block) → `whitelistFrontmatter` (drop everything but a safe key set) → `regenerate` (writes flat into `garden/content`; a `.publish-manifest.json` records the tool-owned files so deletes are automatic and hand-authored pages like `index.md` are untouched).

- `src/vault.ts` — walk / index / select / asset resolution
- `src/transform.ts` — scaffolding strip, link classify, frontmatter whitelist
- `src/mirror.ts` — write flat into `garden/content` + maintain `.publish-manifest.json`
- `src/publish.ts` — CLI + orchestration + gate (projection time, vault in hand)
- `src/verify.ts` — the second gate: re-audits the committed projection, **vault-blind**

## The topology

Point `--pub`/`PUB_REPO` at a public Quartz repo, review the diff there, and let that repo's own Action build and deploy it — rsync to a VPS, GitHub Pages from that repo, or whatever it prefers. The guarantee is **structural**: a public repo cannot leak a note it never contains, and that holds even if every check below fails. Cost is a second repo and a second deploy. Full rationale: [`docs/publishing.md`](../../../docs/publishing.md).

## The gate runs twice

**Projection time** (`npm run publish`, vault in hand) — blocks on a link to a note you haven't published. This is the decision point; it can tell you *what* to publish or unlink.

**Deploy time** (`npm run verify`, **vault-blind**) — re-audits the committed `garden/` on its own terms. Run it before pushing the site repo, and ideally as a step in that repo's own Action before it builds. It catches what the first pass structurally cannot: a file **hand-edited after projection**, a projection committed from a stale checkout, or a hand-edited manifest.

```console
$ npm run verify -- --pub "$PUB_REPO"
verifying: …/<your site repo>/garden/content

✗ publish gate FAILED — 1 finding(s) in the committed projection:

  Good Note.md: links to [[Private Thing]], which is not published — a dangling
  wikilink RENDERS THE TITLE, which is the leak this gate exists to stop
```

What it checks: unresolved wikilinks · missing asset embeds and local file references · frontmatter keys outside `FM_WHITELIST` · internal tags that survived · manifest entries pointing at files that don't exist. Exit `0` pass, `1` findings, `2` misuse.

Notes in `content/` that are neither manifest-owned nor a known hand-authored page (`index.md`) get a **warning**, not a failure — hand-authoring a page is legitimate — but they are checked exactly like everything else.

**It takes no `--vault` and exits 2 if given one.** That's deliberate: the value of this pass is that it holds with no access to the private side, so a failure must be fixed by re-projecting, never by pointing the check at the vault.

**What it does not do:** judge content. It cannot know that a note you tagged `publish: true` says something you'd rather it didn't. It proves the projection is self-consistent and leaks no unpublished *title*; deciding what belongs in the publish set is still yours.
