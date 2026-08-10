# Architecture — what braindance is, and the test every change has to pass

This is the north star. When a technical decision is hard, check it against the goals below rather than against local convenience; a lot of what braindance accumulated in its first months was locally sensible and didn't add up.

## The product

> A personal notes system built on plain markdown in git, with a small self-hosted app for capturing and triaging from a phone, and enough context for an agent to work in it.

Three parts, in order of durability:

1. **The vault** — flat markdown in a git repo. The actual asset. It outlives every other component here and is readable with `cat`. Nothing may compromise this.
2. **The desk** — capture → `inbox/` → review → filed. The only piece that has to be *running*.
3. **The context layer** — skills, agent guides, worktree and instance discipline. What makes the vault workable by an agent.

## The three goals

Every change is measured against these, in this order:

1. **Lightweight note access** — a thought reaches the vault in one tap, from a phone, without losing anything; and you can read the vault back the same way.
2. **A simple review flow** — an inbox item becomes a filed note in as few decisions as possible. Features that *remove* decisions (pre-filled suggestions) serve this; features that add surface do not.
3. **Portability and maintainability** — fewest moving parts, fewest schemas, fewest repos. The vault must survive the app being deleted.

**The test:** if a proposed feature doesn't serve one of these, it needs an explicit fourth goal stated out loud before it gets built. Two subsystems were built without that and cost more maintenance than everything else combined.

## The boundary that matters: product vs instance

Not app vs context — **product vs instance**.

```
braindance   THE PRODUCT — app, tooling, skills, schema, docs.
             Zero personal content. Zero hardcoded paths. This is what you hand someone.

<instance>   YOUR DATA — the vault repo, plus instance config (registry entry, /srv/.env,
             feature flags). Nothing instance-specific lives in the product repo.
```

**The fork model is retired.** braindance is not a template you fork and keep merged with `upstream/master`. You **clone and deploy** it; your data lives outside it; there is nothing to merge back. The "template vs fork — where changes go" rule disappears along with the whole class of confusion it created, in which the product and one instance were the same checkout.

**The app is not split into its own repo.** Someone deploying wants one clone that gives them skills, agent guides, and the desk together. A second remote would double their onboarding and create a cross-repo schema contract — the exact coupling that has already caused drift. The api's independence from `ctx/` is real and worth preserving as a *module* boundary, not a second repository.

## Deployment floor: Docker on any host

The target is one `docker compose up` against any host the person controls — VPS, home server, work box. **No assumption that they built the host, own a domain, or know the internals.** Phone access is Tailscale or a tunnel; the app binds a private interface and never `0.0.0.0`.

This means the deploy path must be a **generic quickstart**, not one operator's runbook. `ctx/vps-setup.md` is currently the latter and does not belong in the product.

## Feature gates

One instance config decides what a deployment even has. Everything off-by-default that costs a key or an external service.

| Gate | Turns on | Default |
|---|---|---|
| `capture` | phone capture → `inbox/` | on |
| `review` | the triage desk | on |
| `tasks` | `/todo` roll-up + `.ics` feed | on |
| `suggest` | AI pre-suggestions per capture (needs an API key) | **off** |
| `publish` | projection → public site | **off** |

Someone who wants notes-only runs with `publish` off and never learns the publish tool exists. The public garden stops being a topology decision and becomes one flag.

## Export = a deploy bundle

`bd export` takes a configured instance and emits everything needed to stand it up elsewhere: compose file, env template, feature flags, image reference. Publishing is a **gated step inside** that bundle, not a parallel pipeline.

This is what makes "give it to a friend" and "run it at work" the same operation as "deploy my own", rather than three bespoke paths.

## Schema: one module, generated docs

The vault's tag vocabulary and task-line grammar are currently encoded in four places; three had drifted, and one drift shipped a bug (an api funnel emitting a shape the vault no longer parsed).

Because this is **one repo**, the fix is cheap: a workspace module owning the constants, the frontmatter whitelist, and the task-line grammar, imported by both the api and the publish tool, with conformance tests both run. The vault's `_meta/Tags.md` is **generated** from it — the same pattern `gen-topics.sh` already uses for `Topics.md`.

What prevents drift is shared code plus tests. A schema *document* in a fifth location would just be a fifth thing to drift.

## Instances

Work and personal run side by side on one machine, each owning a `core` / `vault` / `repos` triple, resolved from where you are. This stopped being over-engineering the moment work became a real second instance: the cross-instance write guard (C2) is a genuine privacy boundary when one of the vaults belongs to an employer.

Mechanics: [`instances.md`](instances.md).

## Roadmap

Sequenced so each phase leaves the repo coherent:

1. **Evict the instance from the product.** Move `ctx/vps-setup.md`, the personal publish skill, and every hardcoded path out; replace the VPS runbook with a generic quickstart. *Precondition for showing anyone.*
2. **Feature gates.** One config, read by the app; everything that needs a key or a service defaults off.
3. **Schema module.** Extract the grammar and constants, add conformance tests, generate `_meta/Tags.md`.
4. **`bd export`.** Emit the deploy bundle.
5. **Publish as a gated feature.** Fold the projection into the bundle behind `publish`.

## What braindance is not

- Not a template to fork and merge.
- Not a website. The public site is an output of `publish`, and lives in its own repo.
- Not a general note-taking app. It assumes a flat markdown vault in git and is unapologetic about it — that assumption is what makes goal 3 achievable.
