# noon-moon-net — the publish subsystem

Design sketch for turning **"publish this braindance instance with Quartz"** into a repeatable feature. Companion to `ctx/vps-setup.md` (which owns the VPS/serving checklist); this doc owns the *projection* from private vault → public site.

## Why two repos

`/garden` is populated from a **separate public repo (`noon-moon/noon-moon-net`)**, not a curated slice of the private repo. The reason is a **structural** privacy guarantee over a **procedural** one:

- Single-repo `public/` slice → nothing private leaks *only as long as a lint script is perfect on every push.*
- Separate repo → the public repo **cannot leak what was never copied into it.** You can't render a private note's title if the private note isn't there.

The cost is building the projection tool — but you'd need link-scrubbing in *any* topology, so this buys the isolation guarantee for roughly the same work.

## Topology

```
noon-moon/braindance-usr   (PRIVATE — source of truth)
  ctx/vault/*.md               full flat vault; some notes tagged `publish: true`
  ctx/tools/pub/               the publish tool (this design)
        │
        │  publish  ── select → gate → transform → mirror → commit
        ▼
noon-moon/noon-moon-net   (PUBLIC — generated content + Quartz)
  content/<slug>.md            GENERATED flat, committed → served at /garden/<slug>
  content/<asset>              referenced assets, copied alongside the notes
  content/index.md             hand-authored garden landing page (not tool-owned)
  .publish-manifest.json       tracks the tool-owned files (so un-tagging deletes)
  quartz.config.yaml           hand-maintained (baseUrl noon-moon.net/garden)
  quartz/ layout, styles       hand-maintained
  .github/workflows/deploy.yml on push → `npx quartz build` → rsync
        │
        ▼
VPS /srv/garden  ── Caddy ──►  noon-moon.net/garden
```

Two ownership rules that keep this sane:

1. **The tool owns the files it projects — never hand-edit those.** Notes are written flat into `content/` (so a note is served at `/garden/<slug>`, no `notes/` nesting), and the tool records exactly what it wrote in `.publish-manifest.json` so a re-run deletes its stale output. Hand-authored pages that live *alongside* it in `content/` (e.g. `index.md`) are safe because they're never in the manifest. Everything *around* the content (Quartz config, layout, CSS) is hand-maintained. This ownership boundary is what avoids clobber conflicts.
2. **`content/` is committed** in `noon-moon-net` (opposite of the old single-repo plan, where `quartz/content/` was gitignored). The public repo must be self-contained so its own Action can build without ever touching the private repo.

## Selection: a `publish` frontmatter flag, not a folder

The vault is flat and tag-driven; selection follows that. A note joins the **publish set (P)** when its frontmatter carries `publish: true` (or a `publish` tag — pick one, see open questions). This matches how `/scopes` and Dataview already read frontmatter, and keeps a note's identity in one place instead of splitting it into a `public/` folder. The separate repo is the *destination*; the flag is the *selector* — orthogonal concerns.

## The projection algorithm

`publish` is a **deterministic script** (so it's reproducible and CI-runnable), not an LLM step. Given the private vault and a checkout of `noon-moon-net`:

### 1. Select
Walk `ctx/vault/**/*.md`, parse frontmatter, collect P = notes with `publish: true`. Build `publishedBasenames` (for link resolution) from P.

### 2. Gate (the privacy boundary)
For each note in P, parse every `[[wikilink]]`, `[[Title#heading]]`, `[[Title|alias]]`, and `![[transclusion]]`. Classify each target:

| Class | Condition | Action |
|---|---|---|
| **internal-public** | basename ∈ P | keep the link — Quartz resolves it inside `content/` |
| **internal-private** | resolves to a vault note ∉ P | **LEAK RISK** → block by default (see policy) |
| **asset** | `![[img.png]]`, attachment | add to asset copy-set |
| **external / unresolved** | not a vault basename | leave as-is |

Also gate on quality (carried over from the old `lint-public.sh` plan): `todo`-tagged notes, stub notes (< ~20 words) → block or warn.

**Link-scrub policy (the crux — this is the whole feature).** The leak vector is that `[[Private Note]]` renders the note's *title* even as a dangling link. Default behavior:

- **`--strict` (default): block.** Publishing a note that links to a non-published note is an error: *"`Foo` links to private `Bar` — publish Bar or unlink."* Forces a conscious decision at the boundary.
- **`--scrub` (opt-in): downgrade.** Rewrite the private link to plain text — prefer the alias when present (`[[Bar|the thing]]` → `the thing`), else drop to the bare title. Note that bare-title scrub *still* surfaces the title as prose, so scrub means "I've accepted this text is fine to show." Reserve for bulk publishes where you trust the aliases.

### 3. Transform
Produce each note's published form:

- **Frontmatter whitelist** — emit only a known-safe key set (e.g. `title`, public `tags`, `date`, `description`). Everything else is dropped. Whitelist, not blacklist, so a new private field (`people:`, `source:`, `status`) can never leak by omission. Explicitly strips Dataview scaffolding (`Contains` / `Contained By`) and todo machinery (`status`/`due`/`completed`/`processed`).
- **Link scrub** applied per policy above.
- **Asset paths** rewritten to Quartz's static location if they differ.

### 4. Mirror (sync, not append)
The tool-owned slice of `content/` is a **pure function of P**, so publishing is a three-way sync, not a copy. The `.publish-manifest.json` from the last run is the delete-set:

- **Add** notes newly in P.
- **Update** notes whose projected content changed.
- **Delete** notes no longer in P (any file in the previous manifest, minus the new set) — *un-tagging a note removes it from the public site.* This is the step a naive "copy public notes" approach forgets.
- Copy only the **referenced** assets flat into `content/` (never the whole vault `assets/` — it may hold private images).

Idempotent: re-running with an unchanged vault produces an empty diff.

### 5. Commit
Commit the projected diff in `noon-moon-net` with provenance — `Publish: sync <N> notes from braindance-usr@<sha>`. **Do not auto-push by default.** A human reviews the `noon-moon-net` diff before it goes public (appropriate for a privacy boundary); `--push` opts into automation later.

## Where it runs

**Manual/local first.** You run `publish` on a machine that has both repos, review the diff, push `noon-moon-net`. Its Action then builds + deploys. Keeping a human between "tag a note" and "it's world-readable" is the right default for a privacy gate. A CI-driven publish-on-tag in `braindance-usr` is a possible later automation, but auto-pushing to a public repo is exactly the thing to be conservative about — defer it.

## Tech choice

Node/TypeScript in `ctx/tools/pub/`, run via `tsx` (matches `api/`'s toolchain and Quartz's own Node/remark stack). Markdown work — frontmatter via `gray-matter`, wikilink parsing, transclusion resolution — is far more maintainable in TS than the bash used in `ctx/tools/sys/`. A thin `/publish` skill in `ctx/skills/` can wrap it for ergonomics, but the core is the deterministic script.

```
ctx/tools/pub/
  publish.ts        # entry: select → gate → transform → mirror → commit
  links.ts          # wikilink/transclusion parse + classify
  frontmatter.ts    # whitelist + strip
  mirror.ts         # three-way sync of content/ + assets
```

## Open questions

- **Flag spelling** — `publish: true` field vs. a `publish` entry in `tags`. Tag composes with the existing tag vocabulary in `_meta/Tags.md`; a dedicated boolean field is unambiguous for a machine. Lean: `publish: true` field.
- **`baseUrl` / path** — served at `noon-moon.net/garden` (subpath). Confirm Quartz subpath hosting + Caddy `handle /garden/*` interplay (relative asset URLs under a subpath are a classic Quartz footgun).
- **Scoped index (MOC) notes** — a published `scope` note's `Contains`/`Contained By` get stripped; do we regenerate a public index from P's link graph, or let Quartz's own graph/backlinks stand in? Lean: let Quartz's graph handle it, don't hand-build indexes.
- **Assets dir** — reconcile vault `ctx/vault/assets/` + `attachments/` layout with Quartz's expected static path.
