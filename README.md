# braindance

A meta-repository for agentic development. Clone it once, maintain it as your personal knowledge and workflow layer, then plug any repository into `repo/` to bring that context to bear.

```
bd/
├── ctx/
│   ├── skills/           # LLM-agnostic skill definitions (plain markdown prompts)
│   │   ├── engineering/
│   │   ├── misc/
│   │   ├── personal/
│   │   ├── productivity/
│   │   └── usr/          # Your personal skills (gitignored in template)
│   ├── tools/
│   │   ├── sys/          # Braindance lifecycle tooling
│   │   │   ├── sync.sh   # Installs skills into your LLM harness
│   │   │   └── wt.sh     # `bd` parallel-worktree helper (source from your shell rc)
│   │   ├── pub/          # Publish tool: projects `publish: true` notes → ctx/www/garden
│   │   └── orchestration/ # Multi-agent fleet helpers (rebase-open-prs, loadguard, ledger)
│   ├── vault/            # Obsidian vault — open this directory in Obsidian
│   │   │                 # Only .obsidian/, _templates/, _meta/, _ephemeral/README are tracked;
│   │   │                 # your notes are gitignored (personal, per-machine)
│   │   └── _ephemeral/   # Non-persisted scratch (gitignored; Obsidian-visible,
│   │                     # never canonical — promote keepers to real notes)
│   └── www/              # Published website → GitHub Pages (homepage + static + /garden)
│       ├── index.html    #   your homepage (edit freely; author RELATIVE links)
│       └── garden/       #   vendored Quartz v5 garden; content/<slug>.md is machine-owned
├── .github/workflows/    # pages.yml (build+deploy ctx/www) · disjoint-www.yml (publish-isolation check)
├── api/                  # Admin app: mobile note-capture API + vault viewer  (advanced/VPS)
├── www/                  # Static homepage for the VPS path (distinct from ctx/www)  (advanced/VPS)
├── Caddyfile             # Reverse proxy / TLS (uses {$DOMAIN})                 (advanced/VPS)
├── docker-compose.yml    # caddy + api services                                (advanced/VPS)
├── deploy.sh             # Compose wrapper (feeds /srv/.env interpolation)      (advanced/VPS)
└── repo/                 # Gitignored — clone the repos you're working on here
```

## Quick start

```bash
git clone <this-repo> bd
cd bd
mkdir repo

# Install skills into your LLM harness (see "Skills" below)
./ctx/tools/sys/sync.sh claude-code
```

Open `ctx/vault/` as a vault in Obsidian.

---

## Skills

Skills are plain markdown files in `ctx/skills/`. Each file is a self-contained prompt command — not tied to any LLM harness. You install them into whichever harness you use.

### Installing skills

**Claude Code** — symlinks skills into `.claude/commands/` so they become `/slash-commands`:
```bash
./ctx/tools/sys/sync.sh claude-code
```

**Cursor** — copies skills into `.cursor/rules/`:
```bash
./ctx/tools/sys/sync.sh cursor
```

**Zed** — copies skills into `.zed/prompts/`:
```bash
./ctx/tools/sys/sync.sh zed
```

**Continue** — copies skills into `.continue/prompts/`:
```bash
./ctx/tools/sys/sync.sh continue
```

**Any other harness** — copy the files from `ctx/skills/` into your harness's prompt/commands directory. Skills are plain markdown; no transformation needed.

### Keeping skills in sync

After pulling upstream changes to this repo, re-run the sync script to update your harness's copy.

---

## Skills included

Skills from [mattpocock/skills](https://github.com/mattpocock/skills) by [Matt Pocock](https://github.com/mattpocock), reproduced here for harness-agnostic portability. Some skills reference companion files (e.g. `CONTEXT.md`, `docs/adr/`) that are created per-project by the setup skills.

### Productivity
| Skill | Description |
|---|---|
| `grill-me` | Relentless interview to sharpen a plan or design |
| `grilling` *(model-invoked)* | The underlying grilling discipline |
| `handoff` | Compact a conversation into a document for another agent |
| `teach` | Multi-session, stateful teaching workspace |
| `writing-great-skills` | Reference for writing effective skills |

### Engineering
| Skill | Description |
|---|---|
| `ask-matt` | Router over all engineering skills and flows |
| `codebase-design` | Vocabulary and principles for deep modules |
| `diagnosing-bugs` | Disciplined bug diagnosis loop |
| `domain-modeling` *(model-invoked)* | Build and maintain a project domain model |
| `grill-with-docs` | Grilling that updates `CONTEXT.md` and ADRs inline |
| `improve-codebase-architecture` | Scan codebase for deepening opportunities |
| `prototype` | Throwaway code to answer a design question |
| `setup-matt-pocock-skills` | Configure the engineering skills for a repo (run once) |
| `tdd` *(model-invoked)* | Test-driven development with vertical slices |
| `to-issues` | Break a plan into independently-grabbable issues |
| `to-prd` | Turn a conversation into a PRD on the issue tracker |
| `triage` | Move issues through a triage state machine |

### Misc
| Skill | Description |
|---|---|
| `git-guardrails-claude-code` | Claude Code hooks to block dangerous git operations |
| `migrate-to-shoehorn` | Replace `as` type assertions in test files |
| `scaffold-exercises` | Create exercise directory structures |
| `setup-pre-commit` | Configure Husky + lint-staged pre-commit hooks |

### Personal
| Skill | Description |
|---|---|
| `edit-article` | Edit and improve article drafts |
| `obsidian-vault` | Search and manage notes in an Obsidian vault |

---

## Personal content

**Vault notes** — `ctx/vault/.gitignore` ignores everything in the vault except the base scaffolding (`.obsidian/`, `_templates/`, `_meta/`). Any notes you write live only on your machine; the template never tracks them, in this repo or a fork.

**Ephemeral** — `ctx/vault/_ephemeral/` is a gitignored scratch dir (only its `README.md` is tracked) for anything transient: files an agent should consider for a task and disposable work products alike. It sits *inside* the vault so it's visible in Obsidian, but it's never canonical — nothing there persists, so promote anything worth keeping into a real vault note. See [`CLAUDE.md`](CLAUDE.md).

**Skills** — `ctx/skills/usr/` is gitignored in this template but intended for use in your personal fork. `sync.sh` picks these up automatically alongside the template skills. To track them in your fork, remove or edit `ctx/skills/.gitignore` — when you pull template updates, that's the one likely conflict point; resolve it in favour of your fork's version.

---

## Vault

Open `ctx/vault/` as a vault in Obsidian.

The vault uses two note types, enforced by frontmatter tags:

- **`scope`** — a hub note (MOC) for a topic. Has `Contains` and `Contained By` frontmatter linking to related scopes. The relationship is intentionally loose — it covers "owns / owned by", "contains / contained by", and similar dual relationships.
- **`memo`** — a standard note on a specific topic.

On top of a note type, behavioural tags can stack: **`todo`** (actionable, with `status`/`due`/`completed` fields — aggregated in `TODO.md`, powered by the Dataview plugin), **`recurring`** (a standing routine tracked by a `processed` date), and **`daily`** (a dated log note in `daily/`, created via the core Daily Notes plugin). Full definitions live in `ctx/vault/_meta/Tags.md`.

Templates live in `ctx/vault/_templates/`. `TODO.md` ships as scaffolding (the only tracked note); Dataview and Daily Notes are pre-enabled in the Obsidian config, but you install the Dataview community plugin yourself via Obsidian's UI.

### Companion files

Some engineering skills (`diagnosing-bugs`, `tdd`, `domain-modeling`, `codebase-design`, `triage`, `improve-codebase-architecture`, `writing-great-skills`) reference companion files that don't exist in this repo. These are per-project artifacts created by `/setup-matt-pocock-skills` when you run it inside a target repo. They're not part of braindance itself.

---

## Publishing to GitHub Pages (out of the box)

A fresh fork ships a complete public website in **`ctx/www/`** — a homepage, any
static pages you drop in, and a [Quartz](https://quartz.jzhao.xyz) digital garden at
`/garden` — deployed to **GitHub Pages** with zero servers. This is the recommended
default; the VPS/Caddy stack below is the advanced alternative.

**One-time setup:** in the repo, **Settings → Pages → Source = "GitHub Actions"**.
That's it — push and `.github/workflows/pages.yml` builds `ctx/www` and deploys it to
`https://<owner>.github.io/<repo>/`. For a custom domain, set the repo **variable**
`SITE_CUSTOM_DOMAIN` (e.g. `example.com`); the workflow computes Quartz's `baseUrl` and
emits a `CNAME` for you. (Pages auto-resolves `/about` → `/about.html`, so no rewrite
shim is needed.)

**Design your site:** edit `ctx/www/index.html`, and drop any static file/folder under
`ctx/www/` to add a page (`ctx/www/about.html` → `/about`). The one authoring rule: use
**relative** URLs (`./garden/`, `assets/x.png`) so pages work under both a project path
and a custom domain. See [`ctx/www/README.md`](ctx/www/README.md).

**Publish garden notes** (manual, reviewed, then committed):

```bash
npm --prefix ctx/tools/pub install          # first time
npm --prefix ctx/tools/pub run publish -- --dry   # preview what would publish
npm --prefix ctx/tools/pub run publish            # project publish:true notes → ctx/www/garden/content
git diff ctx/www/garden/content                   # review exactly what's going public
```

Then commit; the Pages workflow deploys on push. Un-tag a note (`publish: false` /
remove) and re-run to delete it.

### Privacy — the vault stays private, only the built site is public

The repo is **private**; only the deployed **Pages artifact** is public. Because the
vault and the site live in one repo, the boundary is enforced fail-closed at three
points (see [`CLAUDE.md`](CLAUDE.md) for the full rationale):

1. **Build-scope isolation** — `pages.yml` builds only from `ctx/www`; **no step reads
   `ctx/vault`**.
2. **Fail-closed publish gate** — the publish tool blocks (nonzero exit) on any link or
   embed/transclusion to an unpublished note and any unresolvable asset, and CI re-audits
   the committed projection *vault-blind* (`npm run verify`) so a leak breaks the deploy.
3. **Disjoint-`www` PR check** — `disjoint-www.yml` fails any PR that mixes `ctx/www/**`
   with changes outside it, keeping every publish an isolated, reviewable changeset.

For maximal *structural* isolation you can instead keep the garden in a **separate
public repo** and point the tool at it (`--pub /path` or `PUB_REPO`), serving it via the
VPS stack below — see [`ctx/tools/pub/README.md`](ctx/tools/pub/README.md).

## Admin app & serving (optional, advanced — VPS path)

Braindance ships an optional admin app — a mobile-friendly interface for capturing notes into your vault and browsing it — plus the static-site plumbing to serve a public homepage and a published knowledge garden. It's a stack of two Docker services:

- **`caddy`** — TLS + routing for the public surface: your homepage at `/` (from `/srv/www`) and, if you publish a [Quartz](https://quartz.jzhao.xyz) garden, static output at `/garden` (from `/srv/garden`).
- **`api`** — the admin surface (`api/`): a small Hono/Node service for on-the-go note capture and a read-only vault viewer. It reads the vault (mounted read-only) and commits captures **directly to `main`**, into `ctx/vault/inbox/`, via the GitHub Contents API — so they appear in the vault (and the viewer) with no branch to merge. Each capture is a unique timestamped file, so the atomic write is safe against concurrent commits on `main` (it retries the rare racing ref update); triage is then a plain in-vault file move (`inbox/` → the flat vault). The old `inbox`-*branch* isolation is retired — it was belt-and-suspenders from before the app was locked behind a private network (see the hosting note below).

**Bring your own secure hosting.** The `api` service binds a plain HTTP port and has **no built-in authentication** — exposing it safely is *your* responsibility. Put it behind Tailscale/a VPN, an authenticating reverse proxy, or an SSH tunnel. Do not expose it to the public internet as-is.

### Configuration

All instance-specific values live in `/srv/.env` on the host (`chmod 600`, never committed). Copy [`.env.example`](.env.example) and fill it in:

| Var | Used by | Purpose |
|---|---|---|
| `DOMAIN` | Caddy (`{$DOMAIN}`) | Public hostname for TLS + routing |
| `API_IMAGE` | Compose interpolation | Your GHCR image, e.g. `ghcr.io/you/your-repo/api:latest` |
| `GITHUB_REPO` | api | `owner/repo` the api commits captures to |
| `GITHUB_TOKEN` | api | PAT with `repo` scope for capture commits |

Two different env mechanisms are in play, which is easy to trip over:
- `${VAR}` in `docker-compose.yml` is **interpolation**, resolved from `--env-file /srv/.env`. Always run compose through **`./deploy.sh`** (which passes that flag) — bare `docker compose` won't see `/srv/.env` and will resolve those vars empty.
- `env_file: /srv/.env` on each service injects **container runtime** env (Caddy's `$DOMAIN`, the api's `GITHUB_*`).

### Deploy

Expects the repo cloned to `/srv/braindance`, plus host dirs `/srv/www` and `/srv/garden`:

```bash
./deploy.sh up -d          # start the stack
./deploy.sh config         # render the fully-resolved compose file (sanity check)
./deploy.sh pull api && ./deploy.sh up -d api   # roll a new api image
```

---

## License

MIT — see [LICENSE](LICENSE).
