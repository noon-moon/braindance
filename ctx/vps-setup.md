# VPS Setup Workplan

Serialized execution plan for the Personal Virtual Private Server. Each phase depends on the previous. Check items off as you go.

**Repo model:** three repos. The `braindance-usr` fork this plan was originally written against is **retired** — its vault content was extracted into a standalone repo (v2 Slice 2), and the deploy config lives in the template repo itself.

- `noon-moon/braindance` — **this repo**: the public template *and* the deploy config (`api/`, `www/`, `Caddyfile`, `docker-compose.yml`, `deploy.sh`, `ops/`). Cloned to `/srv/braindance` on the VPS as deploy config only — it carries no vault notes.
- `noon-moon/vault` — **private**, the instance vault as its own repo (flat notes at the repo root, no `ctx/vault/` prefix). Cloned separately on the VPS and pointed at by `REPO_PATH`; the api owns that checkout as single writer. This is the **content-free clone** model: `VAULT_SUBDIR=` (empty) + `VAULT_EXTERNAL=1`. Local checkout: `/Users/tiernan/dev/vault`.
- `noon-moon/noon-moon-net` — **public**, holding only the generated `garden/content/` (a projection of the vault's `publish`-tagged notes) plus Quartz config. Its Action builds and rsyncs to `/srv/garden`, served by Caddy at `/garden`. `/garden` is a *separate published repo*, not a slice of a private one — the isolation is structural: the public repo cannot leak a note it never contains. Full design: [`ctx/noon-moon-net.md`](noon-moon-net.md).

> **Not GitHub Pages.** This repo also ships `ctx/www/` + `.github/workflows/pages.yml`, a zero-server publishing path for forks. That is **template scaffolding, not this instance's route** — its deploy job is gated on the repo variable `ENABLE_PAGES`, which is unset here, so it self-skips. Don't confuse the two `www` dirs: repo-root `www/` is the Caddy homepage (`/srv/www`); `ctx/www/` is the unused Pages source.

---

## Phase 0: Prerequisites

Work that happens before the Droplet exists.

- [x] DNS: point `noon-moon.net` apex `A` → the droplet (done via Squarespace DNS — no Cloudflare/transfer needed; the old `noonmoon.dev` domain was never registered and was dropped)
- [ ] Create a classic PAT on GitHub with `repo` + `read:packages` + `write:packages` scopes — save it somewhere secure (1Password etc.), you'll need it in Phase 1
- [ ] Generate an SSH keypair for GitHub Actions → VPS deploys: `ssh-keygen -t ed25519 -C "github-actions" -f ~/.ssh/github_actions_vps`

---

## Phase 1: Droplet Provisioning

Follow this order exactly — UFW before Docker, Tailscale before UFW enable.

- [ ] Create DigitalOcean Basic Droplet (Ubuntu LTS, $12-18/month region of choice)
- [ ] SSH in as root: `ssh root@<droplet-ip>`
- [ ] Create non-root sudo user:
  ```bash
  adduser tiernan
  usermod -aG sudo tiernan
  rsync --archive --chown=tiernan:tiernan ~/.ssh /home/tiernan
  ```
- [ ] Switch to non-root user for everything that follows: `su - tiernan`
- [ ] Lock down SSH before anything else:
  ```bash
  sudo ufw default deny incoming
  sudo ufw default allow outgoing
  sudo ufw allow 22
  ```
- [ ] Install Tailscale and enroll (second way in if UFW causes trouble later):
  ```bash
  curl -fsSL https://tailscale.com/install.sh | sh
  sudo tailscale up
  ```
  Note your Tailscale IP: `tailscale ip -4`
- [ ] Add remaining UFW rules and enable:
  ```bash
  sudo ufw allow 80
  sudo ufw allow 443
  sudo ufw allow in on tailscale0 to any port 3000
  sudo ufw enable
  sudo ufw status verbose   # verify before continuing
  ```
- [ ] Install Docker (after UFW so Docker's iptables layers on a known-good baseline):
  ```bash
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker tiernan
  newgrp docker
  ```
- [ ] Authenticate to GHCR (use PAT from Phase 0):
  ```bash
  echo "<PAT>" | docker login ghcr.io -u muttzi --password-stdin
  ```
- [ ] Add the GitHub Actions deploy key to authorized_keys:
  ```bash
  echo "<public key from github_actions_vps.pub>" >> ~/.ssh/authorized_keys
  ```
- [ ] Create host directories:
  ```bash
  sudo mkdir -p /srv/braindance /srv/www /srv/garden
  sudo chown -R tiernan:tiernan /srv
  ```
- [ ] Clone **two** repos — deploy config and vault are separate checkouts (the content-free clone model):
  ```bash
  git clone https://muttzi:<PAT>@github.com/noon-moon/braindance.git /srv/braindance
  git clone https://muttzi:<PAT>@github.com/noon-moon/vault.git      /srv/vault
  ```
  > `/srv/braindance` is deploy config only — the api never writes it, which is what makes the host-side `git pull --ff-only` in `ops/sync.sh` safe (it's gated on `VAULT_EXTERNAL=1`). `/srv/vault` is the api's read-write checkout; it is the single writer there.
- [ ] Create `/srv/.env` — the infra is env-substituted, so `DOMAIN`, `API_IMAGE` and `TAILSCALE_IP` are **required** alongside the secrets:
  ```bash
  cat > /srv/.env <<EOF
  DOMAIN=noon-moon.net
  API_IMAGE=ghcr.io/noon-moon/braindance/api:latest
  TAILSCALE_IP=<tailscale ip -4 from above>
  TZ=America/New_York
  GITHUB_TOKEN=<PAT>
  GITHUB_REPO=noon-moon/vault
  REPO_PATH=/srv/vault
  VAULT_SUBDIR=
  VAULT_EXTERNAL=1
  EOF
  chmod 600 /srv/.env
  ```
  > Caddy reads `$DOMAIN`; Compose interpolates `${API_IMAGE}`, `${TAILSCALE_IP}` and `${REPO_PATH}`. Missing `API_IMAGE` or `TAILSCALE_IP` **aborts the run** (both are `${VAR:?}`); missing `DOMAIN` breaks Caddy's TLS. `TZ` sets the `/todo` day boundary — leave it unset and the container's UTC midnight decides what "Today" means. `VAULT_SUBDIR=` must be **empty** because the vault repo's notes sit at its root, not under `ctx/vault/`. Full knob list: [`docs/serving.md`](../docs/serving.md).
- [ ] Bring the stack up via the wrapper (never bare `docker compose` — interpolation must read `/srv/.env`):
  ```bash
  cd /srv/braindance
  ./deploy.sh up -d
  ```
- [ ] Install the self-update timer so the box tracks `main` and rolls new api
  images on its own (CI only pushes to GHCR; it never SSHes in). Full detail in
  [`ops/README.md`](../ops/README.md):
  ```bash
  sudo sed -i "s/^User=deploy/User=$USER/" /srv/braindance/ops/braindance-sync.service
  sudo ln -sf /srv/braindance/ops/braindance-sync.{service,timer} /etc/systemd/system/
  sudo systemctl daemon-reload && sudo systemctl enable --now braindance-sync.timer
  ```

---

## Phase 2: DNS & TLS

DNS is at **Squarespace**, not Cloudflare — the registrar transfer this plan once assumed never happened (see Phase 0). No proxy layer, so Caddy does its own ACME over HTTP-01 and needs ports 80/443 reachable.

- [x] `A` record for `noon-moon.net` → Droplet IP (Squarespace DNS)
- [ ] Decide the apex first — **it can point at the droplet or at GitHub Pages, not both** (Phase 6). If the site goes to Pages, the droplet only needs the Tailscale-side api and this phase mostly falls away.
- [ ] Optional: wildcard `*.noon-moon.net` → same IP. A wildcard cert would need DNS-01 (a Squarespace DNS plugin for Caddy, which may not exist) — prefer per-subdomain HTTP-01 unless you actually need one.
- [ ] Verify Caddy obtains certs after `./deploy.sh up -d`: `./deploy.sh logs caddy`

---

## Phase 3: Repo Structure

Work done locally in `noon-moon/braindance` (this repo), then pushed.

These files now **exist in-repo** — read them there rather than from a snapshot here, which is how the old copies in this section drifted:

### docker-compose.yml
- [x] [`docker-compose.yml`](../docker-compose.yml) at repo root. Two things it does that the original sketch didn't: the api port binds `${TAILSCALE_IP}:3000:3000` (never `0.0.0.0` — the api has no auth, and Docker's iptables would bypass UFW), and the read-write mount follows `${REPO_PATH:-/srv/braindance}`, so pointing the api at the standalone vault repo is a pure `/srv/.env` flip with no compose edit.

### Caddyfile
- [x] [`Caddyfile`](../Caddyfile) — the site block is `{$DOMAIN}`, not a hardcoded hostname, so the template serves any instance's domain.

### Publish selection (supersedes `ctx/vault/public/`)
- [x] ~~Create `ctx/vault/public/` directory~~ — **superseded.** Selection is now a `publish: true` frontmatter flag on notes in the flat vault (keeps the vault flat, matches the tag-driven model). Remove the empty `ctx/vault/public/` folder. See `ctx/noon-moon-net.md`.

### www/
- [x] Create `www/` directory with a placeholder `index.html`, tracked directly

### api/
- [x] Scaffold `api/`:
  ```
  api/
    src/
      index.ts       # Hono or Express server
      scopes.ts      # GET /scopes handler
      notes.ts       # POST /notes handler (GitHub REST API)
    Dockerfile
    package.json
    tsconfig.json
  ```

---

## Phase 4: GitHub Actions

`.github/workflows/` in `noon-moon/braindance` (this repo). Unlike the original plan, the site *does* ship from here — via GitHub Pages, not the VPS.

- [x] `deploy-api.yml` — on push to `main`/`master` touching `api/**` or compose:
  1. Build the Docker image and push to `ghcr.io/noon-moon/braindance/api:latest`.
  2. Auth uses the workflow's built-in `GITHUB_TOKEN` (`packages: write`) —
     **no `GHCR_TOKEN`.** The VPS pulls the new image itself via the
     `braindance-sync` timer installed in Phase 1 (see
     [`ops/README.md`](../ops/README.md)).

  > The image build never touches the box. There *is* an optional SSH redeploy
  > step that makes a roll immediate, but it **self-skips while `VPS_HOST` is
  > empty**, so pushes stay green before the droplet exists — and the timer
  > applies the new image within a few minutes either way.

- [x] `pages.yml` — builds `ctx/www/` (homepage + garden) and deploys to GitHub Pages. Vault-blind by construction: no step reads `ctx/vault`. One-time repo setup: **Settings → Pages → Source = "GitHub Actions"**; optional repo variable `SITE_CUSTOM_DOMAIN`.
- [x] `disjoint-www.yml` — fails any PR touching `ctx/www/**` *and* anything outside it, so a vault edit can never ride along with a publish. Bypass for genuine infra changes: `[www-infra]` in the PR title.

---

## Phase 5: Publish Tool (`ctx/tools/pub/`)

The projection from private vault → `noon-moon-net`. Built — see [`ctx/tools/pub/README.md`](tools/pub/README.md) for the CLI (`npm run publish -- --dry` first). **Set `PUB_REPO=~/dev/noon-moon-net` and `VAULT_REPO=~/dev/vault`**: the tool's built-in defaults point at this repo's in-repo garden and placeholder vault, which are the fork path, not ours.

- [x] **Select** (`src/vault.ts`) — walk the vault, collect the publish set P (`publish: true` frontmatter)
- [x] **Gate** (`src/publish.ts`) — parse wikilinks/transclusions per note; classify targets (public / private / asset / external). Default `--strict`: block on any link to a non-published note (privacy boundary); missing assets always block. `--scrub`: downgrade private links to alias-or-text.
- [x] **Transform** (`src/transform.ts`) — strip scaffolding (`Created:`/`Tags:` preamble, `# References`, dataview blocks); frontmatter **whitelist**; apply link scrub; normalize asset embeds
- [x] **Mirror** (`src/mirror.ts`) — three-way sync of `<pub>/garden/content/`: add / update / **delete** (un-tagging removes from the site); `.publish-manifest.json` tracks tool-owned files so hand-authored pages like `index.md` are never touched
- [x] **Second gate** (`src/verify.ts`) — `npm run verify -- --pub ~/dev/noon-moon-net` re-audits the committed projection **vault-blind**; catches a file hand-edited after projection. Run it before pushing the garden repo.
- [ ] **Commit** — review the diff in `noon-moon-net` and push; that push is what makes it public
- [x] Thin `/publish` skill in `ctx/skills/personal/` wrapping the tool

---

## Phase 6: `noon-moon-net` + Quartz

The public repo. Created once, then fed by the publish tool. It exists (private today — it must be **public**, or at least its Pages/deploy path must work, before `/garden` can serve).

- [x] Create `noon-moon/noon-moon-net`
- [ ] Install Quartz at `garden/`: `npx quartz create`
- [ ] Configure `quartz.config.yaml`: `baseUrl` for the `/garden` subpath (relative asset URLs under a subpath are the classic Quartz footgun — verify), content path `garden/content/`
- [ ] **Commit `garden/content/`** (do *not* gitignore it — the public repo must be self-contained so its Action builds without ever touching a private repo). It is generated by the publish tool and never hand-edited.
- [ ] Run the vault-blind gate in that repo's own Action too — `npm run verify -- --pub .` before the build, so a bad projection can't deploy even if the human skipped it locally
- [ ] `.github/workflows/deploy.yml` — on push to `garden/**` or config: `npx quartz build --output /tmp/garden` → SSH to VPS → `rsync /tmp/garden/ /srv/garden`. This repo owns the only SSH deploy in the system, so `VPS_SSH_KEY` / `VPS_HOST` / `VPS_USER` belong **here**, not on `braindance`.
- [ ] First manual publish → push `noon-moon-net` → verify the build → check `/garden`

---

## Phase 7: Braindance Mobile API

The api has since grown well past this checklist (v2: local-first git store, `/review` proposals queue, `/todo` roll-up, `/history` revert). See [`docs/serving.md`](../docs/serving.md) for what it actually does; the items below are just the original bring-up.

- [x] Scope list: read the vault, filter by `tags: [scope]` in frontmatter, return names — surfaces as the capture form's scope dropdown (`_meta/` `scope_kind: system` scopes excluded)
- [x] Capture: `POST /ingest` (post/redirect/get) writes into the vault's `inbox/` **directly on `main`** — the api commits locally, then pulls-rebase + pushes. The **`inbox` branch is retired**: it was belt-and-suspenders from before the app sat behind Tailscale.
- [x] Write `Dockerfile` (Node.js slim base)
- [ ] Push first image to GHCR manually to verify the pipeline
- [ ] Roll via `deploy-api.yml` and verify the service is reachable **on the Tailscale IP only** (`curl` it from another tailnet device; confirm the public IP refuses)

---

## Phase 8: Homepage

- [ ] Design `www/index.html` (and any assets) — the repo-root `www/`, which Caddy serves from `/srv/www`. **Not `ctx/www/`**, which is the unused GitHub Pages source for forks.
- [ ] Push to `noon-moon/braindance`; the droplet's `braindance-sync` timer fast-forwards `/srv/braindance` (with `VAULT_EXTERNAL=1`), so the homepage ships without an SSH deploy. Check the live site.

---

## Done When

- [ ] `noon-moon.net` serves the homepage from `/srv/www`
- [ ] `noon-moon.net/garden` serves the Quartz garden built from `noon-moon-net`
- [ ] A capture from the phone lands in the vault repo's `inbox/` on `main`, and shows in the viewer
- [ ] The capture form's scope dropdown lists current scopes
- [ ] Tagging a note `publish: true` + running the publish tool projects it into `noon-moon-net`, whose Action builds → live at `/garden`; un-tagging removes it
- [ ] The api answers on the Tailscale IP and **refuses on the public IP**
