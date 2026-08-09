# Publishing — projecting vault notes to a public site

How selected notes get from a private vault onto a public site. Companion to `ctx/vps-setup.md` (the VPS checklist) and [`serving.md`](serving.md) (the admin app); this doc owns the **projection**. The tool itself: [`ctx/tools/pub/README.md`](../ctx/tools/pub/README.md).

## The privacy problem

Publishing from a private vault has one real failure mode: a published note **linking to an unpublished one**. `[[Private Note]]` renders the note's *title* even as a dangling link, so a leak needs no note body at all. Everything below is arranged around that.

Two ways to guarantee it doesn't happen:

- **Structural** — the public artifact never *contains* the private note. You can't render a title that isn't there.
- **Procedural** — a gate runs on every publish and blocks the leak.

**braindance takes the structural route: the site is always a separate repo.** The cost is a second repo and a second deploy — but you need link-scrubbing in *any* topology, so the isolation guarantee comes for roughly the same work, and it holds even when every check below fails.

## Topology

```
noon-moon/braindance   (PRIVATE — the instance + tooling)
  ctx/tools/pub/            the publish tool
        │
noon-moon/vault        (PRIVATE — source of truth)
  *.md                      flat vault; some notes tagged `publish: true`
        │
        │  npm run publish  ── select → gate → transform → mirror
        ▼
noon-moon/noon-moon-net   (PUBLIC — generated content + Quartz)
  garden/content/<slug>.md     GENERATED flat → served at /garden/<slug>
  garden/content/<asset>       referenced assets, copied alongside the notes
  garden/content/index.md      hand-authored garden landing (never tool-owned)
  garden/.publish-manifest.json  tracks the tool-owned files (so un-tagging deletes)
  quartz.config.yaml           hand-maintained
  .github/workflows/deploy.yml on push → `npx quartz build` → rsync
        │
        ▼
VPS /srv/garden  ── Caddy ──►  /garden
```

The public repo **cannot leak a note it never contains** — that's the whole point of the split, and it holds even if every check below fails. The checks are defence in depth on top of it, not the boundary itself.

### The gate, and where it runs

- **Projection time** — `npm run publish`, vault in hand. Blocks (nonzero exit) on any link or embed to a note outside the publish set, and on any unresolvable asset. This is the decision point: publish the target, unlink, or `--scrub`.
- **Before you push** — `npm run verify` (`src/verify.ts`), **vault-blind**: re-audits the committed projection on its own terms — a wikilink to a note not in the published set, a missing asset, a disallowed frontmatter key, a surviving internal tag, a stale manifest entry. It catches what projection-time gating structurally cannot: a file **hand-edited after it was projected**, or a projection committed from a stale checkout. It reads only `<pub>/garden`, takes no `--vault`, and **exits 2 if given one** — reading the private side would convert the guarantee back into a procedural one. Run it against the garden repo before pushing; it belongs in `noon-moon-net`'s own Action too.

> **Legacy scaffolding, being removed.** This repo still carries an unused second publishing path — `ctx/www/` plus `.github/workflows/pages.yml` and `disjoint-www.yml` — that projected in-repo and deployed to GitHub Pages. It has never published a note, its deploy is gated off behind the `ENABLE_PAGES` repo variable, and it duplicates a vendored Quartz install. Ignore it; it is slated for deletion.

### Two ownership rules

1. **The tool owns the files it projects — never hand-edit those.** Notes are written flat into `garden/content/` (so a note serves at `/garden/<slug>`, no `notes/` nesting), and the tool records exactly what it wrote in `.publish-manifest.json` so a re-run deletes its stale output. Hand-authored pages living *alongside* it (e.g. `content/index.md`) are safe because they're never in the manifest. Everything *around* the content — Quartz config, layout, CSS — is hand-maintained.
2. **`content/` is committed.** The site repo must be self-contained, so its own Action can build without ever reaching into a private repo — and so the build is a pure function of already-gated content.

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
**No auto-push, by design.** Run `verify` against the garden, review the diff, then commit and push it in the public repo — that push is what makes it world-readable. Keeping a human between "tag a note" and "it's public" is the right default for a privacy gate.

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
- **Settled: the verify gate.** `src/verify.ts` is implemented. What it deliberately does *not* do is judge content — it cannot know that a note you tagged `publish: true` says something you'd rather it didn't. It checks that the projection is internally consistent and leaks no unpublished title; deciding what belongs in P is still yours.
- **Open: wire `verify` into `noon-moon-net`'s Action.** On the separate-repo path it currently runs only when a human remembers to. The public repo's own deploy workflow should run it over its committed `garden/` before building — same script, `--pub .`, no vault anywhere near it.
- **Open: assets dir** — reconcile the vault's `assets/` + `attachments/` layout with Quartz's expected static path.
