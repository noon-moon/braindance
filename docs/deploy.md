# Deploy — standing up the desk on a host you control

The floor is **Docker on any host**: a VPS, a home server, a work box. Nothing here assumes you built the machine, own a domain, or know braindance's internals. Budget 30–45 minutes for a fresh Linux host; much less if it already runs Docker.

What you need before starting:

- A host you can SSH into, with sudo.
- **A vault repo** — a git repo of markdown notes. It can be empty; the app will start filing into `inbox/`.
- **A GitHub token** with `repo` scope (the app commits captures) and `read:packages` (to pull the image).
- **A private network path** — [Tailscale](https://tailscale.com) is the easy one. The app has no authentication, so it must never be reachable from the public internet.

> **Read that last point twice.** The api binds a single private interface and the compose file refuses to start without one. Everything below is arranged so that stays true.

## 1. Prepare the host

Skip anything already done. **Order matters** — UFW before Docker, so Docker's iptables rules layer onto a known-good baseline; Tailscale before enabling UFW, so you keep a second way in.

```bash
# A non-root sudo user, if you're still root
adduser <you> && usermod -aG sudo <you>
rsync --archive --chown=<you>:<you> ~/.ssh /home/<you>
su - <you>

# Deny-by-default, keeping SSH
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22

# Tailscale, and note the IP it gives you
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale ip -4

# Open the public web ports, and the app port ONLY on the tailnet
sudo ufw allow 80
sudo ufw allow 443
sudo ufw allow in on tailscale0 to any port 3000
sudo ufw enable
sudo ufw status verbose      # verify before continuing

# Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker <you> && newgrp docker
```

## 2. Get the image

The api ships as a container image built by `.github/workflows/deploy-api.yml` in your own clone — push to `main`/`master` and it publishes `ghcr.io/<owner>/<repo>/api:latest`. Authenticate the host to pull it:

```bash
echo "<your GitHub token>" | docker login ghcr.io -u <your-github-username> --password-stdin
```

## 3. Lay out `/srv` and clone

Two checkouts, deliberately: the deploy config and your vault are separate repos, so the app never writes the config it runs from.

```bash
sudo mkdir -p /srv/braindance /srv/www /srv/garden
sudo chown -R $USER:$USER /srv

git clone https://<user>:<token>@github.com/<owner>/braindance.git /srv/braindance
git clone https://<user>:<token>@github.com/<owner>/<your-vault>.git /srv/vault
```

`/srv/braindance` is config only — the api never writes it, which is what makes the host-side `git pull --ff-only` in `ops/sync.sh` safe. `/srv/vault` is the api's read-write checkout and it is the single writer there.

`/srv/www` and `/srv/garden` are what Caddy serves. They stay empty unless you publish a site into them ([`publishing.md`](publishing.md)).

## 4. Configure

```bash
cat > /srv/.env <<'EOF'
DOMAIN=example.com                       # Caddy's TLS hostname
API_IMAGE=ghcr.io/<owner>/<repo>/api:latest
TAILSCALE_IP=100.x.y.z                   # from `tailscale ip -4`
TZ=America/New_York                      # decides what "today" means for tasks
GITHUB_TOKEN=<token>
GITHUB_REPO=<owner>/<your-vault>
REPO_PATH=/srv/vault
VAULT_SUBDIR=                            # empty: notes at the vault repo's root
VAULT_EXTERNAL=1
EOF
chmod 600 /srv/.env
```

`API_IMAGE` and `TAILSCALE_IP` are `${VAR:?}` in the compose file — **missing either aborts the run**, on purpose. A missing `DOMAIN` breaks Caddy's TLS. Leave `TZ` unset and the container's UTC midnight decides your day boundary. Full knob list: [`serving.md`](serving.md).

## 5. Start it

```bash
cd /srv/braindance
./deploy.sh up -d
```

Always go through `./deploy.sh` — it passes `--env-file /srv/.env`, and bare `docker compose` resolves every `${VAR}` empty.

## 6. Keep it current

The box updates itself: a systemd timer pulls new images (and, with `VAULT_EXTERNAL=1`, fast-forwards the deploy config). CI never SSHes in.

```bash
sudo sed -i "s/^User=deploy/User=$USER/" /srv/braindance/ops/braindance-sync.service
sudo ln -sf /srv/braindance/ops/braindance-sync.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now braindance-sync.timer
```

Detail in [`ops/README.md`](../ops/README.md).

## 7. Verify

```bash
curl http://<tailscale-ip>:3000/health      # from another device on your tailnet
curl --max-time 5 http://<public-ip>:3000/  # MUST fail — refused or timeout
```

`/health` reports the running build SHA and the resolved knobs, so you can confirm a deploy landed without SSHing in. **The second check matters more than the first** — if the public IP answers, stop and fix the binding before you capture anything.

Then open `http://<tailscale-ip>:3000` on your phone and capture a note. It should appear in `inbox/` in your vault repo within a minute.
