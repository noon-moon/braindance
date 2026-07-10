# ctx/www — the published site

Everything under `ctx/www/` is the source for your public website. The GitHub
Pages workflow (`.github/workflows/pages.yml`) assembles it into one site and
deploys it; nothing else in the repo — **and never `ctx/vault/`** — is an input.

```
ctx/www/
  index.html          your homepage (edit freely; author links RELATIVE)
  <static pages>       any HTML/CSS/JS/img you drop in → served verbatim at its path
  garden/              the Quartz digital garden → served at /garden
    content/
      index.md           hand-authored garden landing (yours)
      <slug>.md          MACHINE-OWNED — written by ctx/tools/pub, never hand-edit
      <asset>            assets a published note references, copied flat
    .publish-manifest.json   tool-owned file tracker (drives delete-on-untag)
    quartz.config.yaml       garden config (CI rewrites baseUrl at build time)
    quartz.lock.json  quartz/  package.json  ...   vendored Quartz v5 runtime
```

## Ownership

- **Yours:** `index.html`, any static page/asset you add, and
  `garden/content/index.md`. Design them however you like.
- **Machine-owned:** every `garden/content/<slug>.md` and the assets beside them,
  plus `garden/.publish-manifest.json`. These are regenerated on each
  `npm --prefix ctx/tools/pub run publish` — don't hand-edit; your edits are lost
  on the next publish. The manifest records exactly which files the tool owns, so
  un-tagging a note deletes only its file and leaves `index.md` untouched.

## Adding a static page

Drop a file or folder under `ctx/www/` and commit it — no build step:

- `ctx/www/about.html` → `https://<site>/about` (Pages resolves `/about`→`/about.html`).
- `ctx/www/blog/index.html` → `https://<site>/blog/`.
- `ctx/www/assets/…`, CSS, JS, images → served verbatim at their path.

The only reserved name is `garden/` (the Quartz project → `/garden`).

## The one authoring rule: use relative URLs

A project Pages site lives under `https://<owner>.github.io/<repo>/`, so an
absolute-root link like `/garden/` or `/style.css` 404s. Author **relative**
links (`./garden/`, `assets/x.png`) and your pages work under both a project path
and a custom domain. (Quartz handles its own asset URLs via the `baseUrl` CI
computes — this rule is for your hand-written pages.)

## Publishing garden notes

From a repo checkout: `npm --prefix ctx/tools/pub run publish` (see
`ctx/tools/pub/README.md`). It selects `publish: true` vault notes, gates on
privacy, and writes them here. Review the diff (`git diff ctx/www/garden/content`)
and commit — that commit is the reviewable "exactly what's going public" changeset.

## Build artifacts (gitignored)

`garden/public/`, `garden/node_modules/`, `garden/.quartz*` are build output and
are never committed.
