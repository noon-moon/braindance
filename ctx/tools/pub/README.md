# ctx/tools/pub — the publish tool

Projects `publish: true` notes from your vault flat into a Quartz garden's `garden/content` (served at `/garden/<slug>`). Deterministic; run it, review the diff, commit. Full design & rationale: [`docs/publishing.md`](../../../docs/publishing.md).

**Two topologies — and the default is not the one this instance uses.** `--pub` defaults to the in-repo garden `ctx/www/garden/`, the zero-server path a fresh fork gets (GitHub Pages). **This instance publishes into the separate public repo `noon-moon/noon-moon-net`** for the stronger *structural* isolation, so **set `PUB_REPO` (or pass `--pub`)** rather than relying on the default. Both are supported and use the same code; see "Two topologies" below.

```bash
npm install                                  # first time
export VAULT_REPO=~/dev/vault                # external vault (see below)
export PUB_REPO=~/dev/noon-moon-net          # this instance's garden repo

npm run publish -- --dry                     # report what would publish, write nothing
npm run publish                              # write it
npm run publish -- --scrub                   # downgrade private links to text instead of blocking
npm run publish -- --pub /path --vault /path # or be explicit per-run

npm run verify                               # re-audit the COMMITTED projection, vault-blind
npm run verify -- --pub ~/dev/noon-moon-net  # …against the garden repo
```

Every run prints the `vault:` and `pub:` it resolved — check that line before trusting a dry run.

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
- `src/publish.ts` — CLI + orchestration + gate (projection time, vault in hand)
- `src/verify.ts` — the second gate: re-audits the committed projection, **vault-blind**

## Two topologies

**Separate garden repo — what this instance uses.** Point `--pub`/`PUB_REPO` at a public Quartz repo (`noon-moon/noon-moon-net`), review the diff there, and let that repo's own Action build and deploy it — here, rsync to the VPS behind Caddy at `/garden`. The guarantee is **structural**: a public repo cannot leak a note it never contains, and that holds even if every check fails. Cost is a second repo and a second deploy. This is the topology [`docs/publishing.md`](../../../docs/publishing.md) is designed around.

**In-repo — the tool's default, and what a fresh fork gets.** The garden lives at `ctx/www/garden/` and ships to GitHub Pages with zero servers. The repo stays private; only the built artifact is public. Isolation there is procedural, so it's enforced three ways: `pages.yml` is build-scope-isolated (no step reads `ctx/vault`), `verify` re-audits the committed projection vault-blind as the first CI step, and `disjoint-www.yml` fails any PR mixing `ctx/www/**` with anything outside it. **Its deploy is opt-in** — `pages.yml`'s deploy job is skipped unless the repo variable `ENABLE_PAGES` is `true`.

## The gate runs twice

**Projection time** (`npm run publish`, vault in hand) — blocks on a link to a note you haven't published. This is the decision point; it can tell you *what* to publish or unlink.

**Deploy time** (`npm run verify`, **vault-blind**) — re-audits the committed `garden/` on its own terms, first in `pages.yml`, before Quartz builds anything. It catches what the first pass structurally cannot: a file **hand-edited after projection**, a projection committed from a stale checkout, or a hand-edited manifest.

```console
$ npm run verify
verifying: …/ctx/www/garden/content

✗ publish gate FAILED — 1 finding(s) in the committed projection:

  Good Note.md: links to [[Private Thing]], which is not published — a dangling
  wikilink RENDERS THE TITLE, which is the leak this gate exists to stop
```

What it checks: unresolved wikilinks · missing asset embeds and local file references · frontmatter keys outside `FM_WHITELIST` · internal tags that survived · manifest entries pointing at files that don't exist. Exit `0` pass, `1` findings, `2` misuse.

Notes in `content/` that are neither manifest-owned nor a known hand-authored page (`index.md`) get a **warning**, not a failure — hand-authoring a page is legitimate — but they are checked exactly like everything else.

**It takes no `--vault` and exits 2 if given one.** That's deliberate: the value of this pass is that it holds with no access to the private side, so a failure must be fixed by re-projecting, never by pointing the check at the vault.

**What it does not do:** judge content. It cannot know that a note you tagged `publish: true` says something you'd rather it didn't. It proves the projection is self-consistent and leaks no unpublished *title*; deciding what belongs in the publish set is still yours.
