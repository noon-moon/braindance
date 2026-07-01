# VPS Setup Workplan

Serialized execution plan for the Personal Virtual Private Server. Each phase depends on the previous. Check items off as you go.

**Repo model:** No fork. `noon-moon/braindance` is deployed directly — you own it outright, so there's no need to keep a separate "personal fork" of a shareable template. `ctx/vault/usr/` is (and stays) a separately-cloned nested repo (`noon-moon/braindance-usr`), gitignored from `braindance`'s point of view but present on disk — same pattern locally and on the VPS.

---

## Phase 0: Prerequisites

Work that happens before the Droplet exists.

- [ ] Complete [[Transfer noonmoon.dev to Cloudflare]]
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
- [ ] Clone `braindance` into `/srv/braindance`, then nest-clone `braindance-usr` into its `ctx/vault/usr/` (same pattern as local dev — `ctx/vault/usr/` is gitignored by the outer repo, so this nests cleanly):
  ```bash
  git clone https://muttzi:<PAT>@github.com/noon-moon/braindance.git /srv/braindance
  git clone https://muttzi:<PAT>@github.com/noon-moon/braindance-usr.git /srv/braindance/ctx/vault/usr
  ```
- [ ] Create `/srv/.env`:
  ```bash
  cat > /srv/.env <<EOF
  GITHUB_TOKEN=<PAT>
  GITHUB_REPO=noon-moon/braindance-usr
  EOF
  chmod 600 /srv/.env
  ```
  Note: `GITHUB_REPO` points at `braindance-usr`, not `braindance` — that's where `ctx/vault/usr/inbox/` actually lives as its own repo (see Phase 7).
- [ ] Add `/srv/braindance/docker-compose.yml` to the repo (see Phase 3) and run:
  ```bash
  cd /srv/braindance
  docker compose up -d
  ```

---

## Phase 2: DNS & TLS

- [ ] In Cloudflare DNS: add an `A` record for `noonmoon.dev` pointing to the Droplet IP
- [ ] Add a wildcard `A` record `*.noonmoon.dev` pointing to the same IP
- [ ] Enable Cloudflare proxy (orange cloud) on both records — or disable it if using Caddy's own ACME (decide: Cloudflare proxy vs direct)
- [ ] If using DNS-01 for wildcard cert: create a Cloudflare API token with `Zone:DNS:Edit` scope, add to `/srv/.env` as `CF_DNS_API_TOKEN`
- [ ] Verify Caddy obtains certs after `docker compose up -d`: `docker compose logs caddy`

---

## Phase 3: Repo Structure

Work done locally in `noon-moon/braindance`, then pushed. No gitignore dance — these are tracked directly here.

### docker-compose.yml
- [ ] Create `docker-compose.yml` at repo root:
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
      restart: unless-stopped

  volumes:
    caddy_data:
  ```
- [ ] Create `Caddyfile`:
  ```
  noonmoon.dev {
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

### ctx/vault/public/
- [ ] Create `ctx/vault/public/` directory with a `.gitkeep`, tracked directly (no gitignore split needed)

### www/
- [ ] Create `www/` directory with a placeholder `index.html`, tracked directly

### api/
- [ ] Scaffold `api/`:
  ```
  api/
    src/
      index.ts       # Hono or Express server
      scopes.ts      # GET /scopes handler
      notes.ts       # POST /notes handler (GitHub REST API, targets braindance-usr)
    Dockerfile
    package.json
    tsconfig.json
  ```

---

## Phase 4: GitHub Actions

Create `.github/workflows/` in `noon-moon/braindance`.

- [ ] `quartz.yml` — triggered on `ctx/vault/public/**` changes:
  1. Must-block lint (`ctx/tools/sys/lint-public.sh --ci`)
  2. Copy `ctx/vault/public/` → `quartz/content/`
  3. `npx quartz build --output /tmp/garden`
  4. SSH into VPS → `rsync /tmp/garden/ /srv/garden`

- [ ] `www.yml` — triggered on `www/**` changes:
  1. SSH into VPS → `rsync www/ /srv/www`

- [ ] `api.yml` — triggered on `api/**` or `docker-compose.yml` changes:
  1. Build Docker image → `docker push ghcr.io/noon-moon/braindance/api:latest`
  2. SSH into VPS → `docker compose pull api && docker compose up -d api`

- [ ] Add secrets to `noon-moon/braindance` on GitHub:
  - `VPS_SSH_KEY` — private key from Phase 0
  - `VPS_HOST` — Droplet IP or Tailscale IP
  - `VPS_USER` — `tiernan`
  - `GHCR_TOKEN` — PAT (for `docker push` in CI)

---

## Phase 5: Lint Script

- [ ] Implement `ctx/tools/sys/lint-public.sh`:
  - Accept `--ci` flag (exit non-zero on must-block; always exit 0 on warn-tier)
  - Must-block checks: external wikilinks, external asset refs, todo-tagged notes, stub notes (<20 words)
  - Warn checks: orphaned notes, sensitive patterns, scope graph leakage
  - Strip `Contains`/`Contained By` fields (build-time, not lint)
- [ ] Update `ctx/tools/sys/sync.sh` to install it as a pre-push hook
- [ ] Re-run `sync.sh` on all machines

---

## Phase 6: Quartz

- [ ] Install Quartz in `noon-moon/braindance`: `npx quartz create` (in a `quartz/` subdirectory or repo root per Quartz docs)
- [ ] Configure `quartz.config.ts`:
  - `baseUrl: "noonmoon.dev/garden"`
  - Content path: `content/` (populated by CI copy step, not vault root)
- [ ] Add `quartz/content/` to `.gitignore`
- [ ] Do a manual first build and verify output at `noonmoon.dev/garden`

---

## Phase 7: Braindance Mobile API

- [ ] Implement `GET /scopes`: read `ctx/vault/usr/` from `/srv/braindance` (the nested `braindance-usr` clone), filter by `tags: [scope]` in frontmatter, return names
- [ ] Implement `POST /notes`: call the GitHub REST API against **`noon-moon/braindance-usr`** (per `GITHUB_REPO` in `/srv/.env`) to create a file in `inbox/` on the `inbox` branch
- [ ] Write `Dockerfile` (Node.js slim base)
- [ ] Push first image to GHCR manually to verify the pipeline
- [ ] Trigger `api.yml` deploy and verify the service is reachable on the Tailscale IP

---

## Phase 8: Homepage

- [ ] Design `www/index.html` (and any assets)
- [ ] Push to `noon-moon/braindance`, verify `www.yml` deploys it, check `noonmoon.dev/`

---

## Done When

- [ ] `noonmoon.dev` serves the homepage
- [ ] `noonmoon.dev/garden` serves the Quartz garden
- [ ] `POST /notes` from phone lands in `braindance-usr`'s `inbox/` on the `inbox` branch
- [ ] `GET /scopes` returns current scope list
- [ ] Pushing a note to `ctx/vault/public/` triggers lint → Quartz build → live at `/garden`
- [ ] GitHub (on `braindance-usr`) sends email on `inbox` branch push
