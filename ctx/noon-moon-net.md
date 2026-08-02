# The publish subsystem

How **"publish this braindance instance with Quartz"** works. Companion to `ctx/vps-setup.md` (which owns the VPS/serving checklist); this doc owns the *projection* from private vault → public site. The tool itself: [`ctx/tools/pub/README.md`](tools/pub/README.md).

> **Naming note.** This file is called `noon-moon-net.md` because the design originally targeted a separate public repo of that name. The shipped default is now an in-repo garden deployed to GitHub Pages; the separate-repo topology survives as a supported option, below.

## The privacy problem

Publishing from a private vault has one real failure mode: a published note **linking to an unpublished one**. `[[Private Note]]` renders the note's *title* even as a dangling link, so a leak needs no note body at all. Everything below is arranged around that.

Two ways to guarantee it doesn't happen:

- **Structural** — the public artifact never *contains* the private note. You can't render a title that isn't there.
- **Procedural** — a gate runs on every publish and blocks the leak.

The original design chose structural (a separate public repo). The shipped default is procedural, but with the enforcement points arranged so that no single check failing opens the boundary. Pick per instance; the projection tool is identical either way.

## Topology (default: in-repo → GitHub Pages)

```
noon-moon/braindance   (PRIVATE repo — only the built artifact is public)
  <vault>/*.md              flat vault; some notes tagged `publish: true`
                            (external — $BD_ROOT/vault; ctx/vault in-repo is a placeholder)
  ctx/tools/pub/            the publish tool
        │
        │  npm run publish  ── select → gate → transform → mirror
        ▼
  ctx/www/                  THE PUBLISHED SITE (committed)
    index.html                 homepage + any static pages you drop in
    garden/
      content/<slug>.md        GENERATED flat → served at /garden/<slug>
      content/<asset>          referenced assets, copied alongside the notes
      content/index.md         hand-authored garden landing (never tool-owned)
      .publish-manifest.json   tracks the tool-owned files (so un-tagging deletes)
      quartz/ quartz.config.yaml   vendored Quartz v5; CI rewrites baseUrl at build
        │
        │  .github/workflows/pages.yml  (on push to ctx/www/**)
        ▼
GitHub Pages ──►  https://<owner>.github.io/<repo>/  (or $SITE_CUSTOM_DOMAIN)
```

No servers, no rsync, no deploy keys. The VPS stack (`api/`, Caddy) is orthogonal and optional — see [`docs/serving.md`](../docs/serving.md).

### Three enforcement points

Because the repo holds both the vault and the public site, isolation is enforced rather than structural. Each of these is independent:

- **(a) Build-scope isolation** — `pages.yml` reads only `ctx/www` and `ctx/tools/pub`. **No step reads the vault.** The vault is never an input to the deployed artifact, so CI cannot leak what it never opens.
- **(b) Vault-blind re-audit** — CI re-runs the gate over the *committed projection* alone. A leaked link, a dangling asset, or a disallowed frontmatter key fails the deploy before anything is built. ⚠️ **Not yet implemented** — `pages.yml` calls `npm run verify`, which doesn't exist in `ctx/tools/pub`. Until it does, the gate runs only at projection time.
- **(c) Disjoint changesets** — `disjoint-www.yml` fails any PR touching `ctx/www/**` *and* anything outside it. Every publish is an isolated, reviewable "exactly what's going public" diff, and a vault edit can never be swept into one. Genuine infra changes bypass with `[www-infra]` in the PR title.

### Alternative: a separate garden repo

Point `--pub` / `PUB_REPO` at a public Quartz repo and let its own Action deploy. You get the structural guarantee — the public repo cannot leak a note it never contains — at the cost of a second repo, a second deploy, and a second place to review. `noon-moon/noon-moon-net` was that repo; it still exists but is no longer the target.

### Two ownership rules that keep either topology sane

1. **The tool owns the files it projects — never hand-edit those.** Notes are written flat into `garden/content/` (so a note serves at `/garden/<slug>`, no `notes/` nesting), and the tool records exactly what it wrote in `.publish-manifest.json` so a re-run deletes its stale output. Hand-authored pages living *alongside* it (e.g. `content/index.md`) are safe because they're never in the manifest. Everything *around* the content — Quartz config, layout, CSS — is hand-maintained.
2. **`content/` is committed.** The build is a pure function of committed, already-gated content — which is exactly what makes (a) and (b) possible.

## Selection: a `publish` frontmatter flag, not a folder

The vault is flat and tag-driven; selection follows that. A note joins the **publish set (P)** when its frontmatter carries `publish: true`. This matches how the scope list and Dataview already read frontmatter, and keeps a note's identity in one place instead of splitting it into a `public/` folder. The destination is a *path*; the flag is the *selector* — orthogonal concerns.

## The projection algorithm

`publish` is a **deterministic script** (reproducible and CI-runnable), not an LLM step.

### 1. Select — `src/vault.ts`
Walk the vault, parse frontmatter, collect P = notes with `publish: true`. Build the published-basename set for link resolution.

### 2. Gate (the privacy boundary) — `src/publish.ts`
For each note in P, parse every `[[wikilink]]`, `[[Title#heading]]`, `[[Title|alias]]`, and `![[transclusion]]`. Classify each target:

| Class | Condition | Action |
|---|---|---|
| **internal-public** | basename ∈ P | keep the link — Quartz resolves it inside `content/` |
| **internal-private** | resolves to a vault note ∉ P | **LEAK RISK** → block by default |
| **asset** | `![[img.png]]`, attachment | add to asset copy-set (missing asset always blocks) |
| **external / unresolved** | not a vault basename | leave as-is |

**Link-scrub policy:**

- **`--strict` (default): block.** Publishing a note that links to a non-published note is an error: *"`Foo` links to private `Bar` — publish Bar or unlink."* Forces a conscious decision at the boundary.
- **`--scrub` (opt-in): downgrade.** Rewrite the private link to plain text — prefer the alias when present (`[[Bar|the thing]]` → `the thing`), else the bare title. Bare-title scrub *still* surfaces the title as prose, so scrub means "I've accepted this text is fine to show." Reserve it for bulk publishes where you trust the aliases.

### 3. Transform — `src/transform.ts`

- **Strip scaffolding** — the `Created:` / `Tags:` preamble, `# References`, `dataview` blocks.
- **Frontmatter whitelist** — emit only a known-safe key set. Whitelist, not blacklist, so a new private field can never leak by omission. Strips Dataview scaffolding (`Contains` / `Contained By`) and task machinery.
- **Link scrub** per the policy above; **asset embeds** normalized.

### 4. Mirror (sync, not append) — `src/mirror.ts`
The tool-owned slice of `content/` is a **pure function of P**, so publishing is a three-way sync. The previous `.publish-manifest.json` is the delete-set:

- **Add** notes newly in P.
- **Update** notes whose projected content changed.
- **Delete** notes no longer in P — *un-tagging a note removes it from the public site.* This is the step a naive "copy the public notes" approach forgets.
- Copy only the **referenced** assets flat into `content/` (never the whole vault `assets/` — it may hold private images).

Idempotent: re-running against an unchanged vault produces an empty diff.

### 5. Commit
**No auto-push, by design.** Review the diff, then commit `ctx/www/**` on its own — `disjoint-www.yml` enforces that isolation, and the push is what makes it public. Keeping a human between "tag a note" and "it's world-readable" is the right default for a privacy gate.

## Tech

Node/TypeScript in `ctx/tools/pub/`, run via `tsx` (matches `api/`'s toolchain and Quartz's own Node/remark stack).

```
ctx/tools/pub/
  src/vault.ts       # walk / index / select / asset resolution
  src/transform.ts   # scaffolding strip, link classify, frontmatter whitelist
  src/mirror.ts      # three-way sync of garden/content + .publish-manifest.json
  src/publish.ts     # CLI + orchestration + gate
```

The `/publish` skill in `ctx/skills/` wraps it for ergonomics; the core is the deterministic script.

## Settled / open

- **Flag spelling** — settled: a `publish: true` frontmatter field, unambiguous for a machine.
- **`baseUrl`** — settled: CI computes it at build time (custom domain, user-site, or project path) and rewrites `quartz.config.yaml`, so the subpath footgun is handled centrally. Author site links **relative**.
- **Scoped index (MOC) notes** — a published `scope` note's `Contains`/`Contained By` are stripped; Quartz's own graph and backlinks stand in rather than a hand-built index.
- **Open: the verify gate.** Enforcement point (b) is referenced by CI but unwritten — see the warning above. Until it lands, a bad projection is caught only if the human notices it in the diff.
- **Open: assets dir** — reconcile the vault's `assets/` + `attachments/` layout with Quartz's expected static path.
