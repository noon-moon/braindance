# VPS Setup Workplan

Serialized execution plan for the Personal Virtual Private Server. Each phase depends on the previous. Check items off as you go.

**Repo model:** three repos.
- `noon-moon/braindance` — public template (generic, shareable, no personal content).
- `noon-moon/vault` — your private vault: real notes tracked flat at the repo root. The braindance instance resolves it via the single-root (`BD_ROOT`) model and the admin API commits captures into it — the private source of truth. Deployed to the VPS.
- `noon-moon/noon-moon-net` — **public** repo holding only the generated `content/` (a projection of the vault's `publish`-tagged notes) plus Quartz config. This is what builds into `noon-moon.net/garden`. `/garden` is a *separate published repo*, not a slice of this one — see `ctx/noon-moon-net.md` for the full publish-subsystem design. The isolation is structural: the public repo cannot leak a private note it never contains.

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
- [ ] Clone `braindance` into `/srv/braindance` — the serving stack + admin API:
  ```bash
  git clone https://muttzi:<PAT>@github.com/noon-moon/braindance.git /srv/braindance
  ```
- [ ] Create `/srv/.env` — the infra is now env-substituted (post template unification), so `DOMAIN` and `API_IMAGE` are **required** alongside the secrets:
  ```bash
  cat > /srv/.env <<EOF
  DOMAIN=noon-moon.net
  API_IMAGE=ghcr.io/noon-moon/braindance/api:latest
  GITHUB_TOKEN=<PAT>
  GITHUB_REPO=noon-moon/vault
  EOF
  chmod 600 /srv/.env
  ```
  > Caddy reads `$DOMAIN`; Compose interpolates `${API_IMAGE}`. Missing `API_IMAGE` aborts the run; missing `DOMAIN` breaks Caddy's TLS. If a live droplet predates this, **add these two vars to its existing `/srv/.env`** before the next deploy.
- [ ] Bring the stack up via the wrapper (never bare `docker compose` — interpolation must read `/srv/.env`):
  ```bash
  cd /srv/braindance
  ./deploy.sh up -d
  ```
- [ ] Install the self-update timer so the box tracks `main` and rolls new api
  images on its own (CI only pushes to GHCR; it never SSHes in). Full detail in
  [`ops/README.md`](../../ops/README.md):
  ```bash
  sudo sed -i "s/^User=deploy/User=$USER/" /srv/braindance/ops/braindance-sync.service
  sudo ln -sf /srv/braindance/ops/braindance-sync.{service,timer} /etc/systemd/system/
  sudo systemctl daemon-reload && sudo systemctl enable --now braindance-sync.timer
  ```

---

## Phase 2: DNS & TLS

- [ ] In Cloudflare DNS: add an `A` record for `noon-moon.net` pointing to the Droplet IP
- [ ] Add a wildcard `A` record `*.noon-moon.net` pointing to the same IP
- [ ] Enable Cloudflare proxy (orange cloud) on both records — or disable it if using Caddy's own ACME (decide: Cloudflare proxy vs direct)
- [ ] If using DNS-01 for wildcard cert: create a Cloudflare API token with `Zone:DNS:Edit` scope, add to `/srv/.env` as `CF_DNS_API_TOKEN`
- [ ] Verify Caddy obtains certs after `./deploy.sh up -d`: `./deploy.sh logs caddy`

---

## Phase 3: Repo Structure

Work done locally in `noon-moon/braindance`, then pushed. Everything's tracked directly — no gitignore split.

### docker-compose.yml
- [x] Create `docker-compose.yml` at repo root:
  ```yaml
  services:
    caddy:
      image: caddy:alpine
      ports:
        - "80:80"
        - "443:443"
      volumes:
        - ./Caddyfile:/etc/caddy/Caddyfile
        - caddy_data:/data
        - /srv/www:/srv/www:ro
        - /srv/garden:/srv/garden:ro
      restart: unless-stopped

    api:
      image: ghcr.io/noon-moon/braindance/api:latest
      ports:
        - "3000:3000"
      env_file: /srv/.env
      volumes:
        # Whole repo, READ-WRITE — the api is local-first: it commits captures
        # into this checkout and pushes to GitHub itself (needs .git, so mount
        # the repo root, not just ctx/vault). See README "Admin app & serving".
        - /srv/braindance:/srv/braindance
      restart: unless-stopped

  volumes:
    caddy_data:
  ```
- [x] Create `Caddyfile`:
  ```
  noon-moon.net {
    root * /srv/www
    handle /garden/* {
      root * /srv/garden
      file_server
    }
    handle {
      file_server
    }
  }
  ```

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

Create `.github/workflows/` in `noon-moon/braindance`. **Note:** neither the homepage nor garden ships from here — `www/` and the garden both live in `noon-moon-net` (Phase 6). This repo's only workflow builds the `api` image.

- [ ] `api.yml` — triggered on `api/**` or `docker-compose.yml` changes:
  1. Build the Docker image and push to `ghcr.io/<org>/<repo>/api:latest`.
  2. That's it — auth uses the workflow's built-in `GITHUB_TOKEN` (`packages: write`);
     **no SSH, no VPS secrets, no `GHCR_TOKEN`.** The VPS pulls the new image
     itself via the `braindance-sync` timer installed in Phase 1 (see
     [`ops/README.md`](../../ops/README.md)).

  > CI never gets access to the box. The pull-based loop (`ops/sync.sh` on the
  > timer) is what applies both a new image and a fresh vault `main`.

- [ ] `www.yml` is **not** in this repo — the homepage and garden are deployed
  from `noon-moon-net` (Phase 6), which owns the only SSH deploy in the system.
  The `VPS_SSH_KEY` / `VPS_HOST` / `VPS_USER` secrets belong on *that* repo, not
  this one.

---

## Phase 5: Publish Tool (`ctx/tools/pub/`)

The projection from private vault → `noon-moon-net`. Full design in `ctx/noon-moon-net.md`; this is the build checklist. Node/TS, run via `tsx`.

- [ ] **Select** — walk `ctx/vault/**`, collect the publish set P (`publish: true` frontmatter)
- [ ] **Gate** — parse wikilinks/transclusions per note; classify targets (public / private / asset / external). Default `--strict`: block on any link to a non-published note (privacy boundary). `--scrub`: downgrade private links to alias-or-text. Also gate `todo`/stub notes.
- [ ] **Transform** — frontmatter **whitelist** (drop everything but a safe key set; strip `Contains`/`Contained By`, todo fields); apply link scrub; rewrite asset paths
- [ ] **Mirror** — three-way sync of `noon-moon-net/content/`: add / update / **delete** (un-tagging removes from the site); copy only referenced assets
- [ ] **Commit** — provenance message (`Publish: sync N notes from vault@<sha>`); no auto-push by default (`--push` opts in)
- [ ] Optional: thin `/publish` skill in `ctx/skills/` wrapping the tool

---

## Phase 6: `noon-moon-net` + Quartz

The public repo. Created once, then fed by the publish tool.

- [ ] Create `noon-moon/noon-moon-net` repo
- [ ] Install Quartz at its root: `npx quartz create`
- [ ] Configure `quartz.config.ts`:
  - `baseUrl: "noon-moon.net/garden"` (subpath — verify Quartz relative-asset handling under `/garden`)
  - Content path: `content/`
- [ ] **Commit `content/`** (do *not* gitignore it — the public repo must be self-contained so its Action builds without touching the private repo). `content/` is generated by the publish tool and never hand-edited.
- [ ] `.github/workflows/deploy.yml` — on push to `content/**` or config: `npx quartz build --output /tmp/garden` → SSH to VPS → `rsync /tmp/garden/ /srv/garden`. Add the same VPS secrets as Phase 4 (`VPS_SSH_KEY`, `VPS_HOST`, `VPS_USER`).
- [ ] First manual publish from the vault → push `noon-moon-net` → verify build → check `noon-moon.net/garden`

---

## Phase 7: Braindance Mobile API

- [ ] Implement `GET /scopes`: read `ctx/vault/` from `/srv/braindance`, filter by `tags: [scope]` in frontmatter, return names
- [ ] Implement `POST /notes`: call the GitHub REST API against `noon-moon/vault` (per `GITHUB_REPO` in `/srv/.env`) to create a file in `inbox/` on the `inbox` branch
- [ ] Write `Dockerfile` (Node.js slim base)
- [ ] Push first image to GHCR manually to verify the pipeline
- [ ] Trigger `api.yml` deploy and verify the service is reachable on the Tailscale IP

---

## Phase 8: Homepage

- [ ] Design `www/index.html` (and any assets)
- [ ] Push to `noon-moon/braindance`, verify `www.yml` deploys it, check `noon-moon.net/`

---

## Done When

- [ ] `noon-moon.net` serves the homepage
- [ ] `noon-moon.net/garden` serves the Quartz garden built from `noon-moon-net`
- [ ] `POST /notes` from phone lands in `ctx/vault/inbox/` on the `inbox` branch
- [ ] `GET /scopes` returns current scope list
- [ ] Tagging a note `publish: true` + running the publish tool projects it into `noon-moon-net`, whose Action builds → live at `/garden`; un-tagging removes it
- [ ] GitHub sends email on `inbox` branch push
