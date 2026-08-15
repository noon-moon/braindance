# ops/ — VPS fallback self-update

**CI is the primary deploy path.** `.github/workflows/deploy-api.yml` builds the
image, SSHes to the box, pulls the deploy config, rolls the container, and then
gates on `/health` reporting the commit it just built — so a green run means the
code is serving, not merely that it compiled.

What lives here is the **fallback**: a timer that converges the box when CI
didn't run, wasn't configured, or failed. Both paths are idempotent, so having
both costs nothing but a slow poll.

- **`sync.sh`** — `git pull --ff-only` the deploy config (guarded on
  `VAULT_EXTERNAL`, since pre-cutover the api owns this checkout) and
  `./deploy.sh pull api && up -d api`. `flock`-guarded against overlap.
- **`braindance-sync.service`** — a `oneshot` unit that runs `sync.sh`.
- **`braindance-sync.timer`** — fires ~2 min after boot, then every ~30 min.

> **Two failure modes this loop cannot see, and one it now shouts about.**
> The config pull needs the checkout to be **writable by the unit's `User=`** and
> its history to **fast-forward onto origin**. A root-owned `/srv/braindance`
> fails the first; a force-pushed/re-rooted default branch fails the second. Both
> have happened, together, and because the pull ended in `2>/dev/null || true`
> the box ran a month-old `docker-compose.yml` while every check stayed green.
> `sync.sh` now logs the failure to stderr (so `journalctl -u braindance-sync`
> shows it) and the CI deploy fails the run outright. If you hit the re-rooted
> case, `git fetch && git reset --hard origin/<branch>` is the repair — the
> config is machine-owned, so there is nothing local to preserve.

## Install (on the VPS, after the stack is up)

Assumes the repo is cloned at `/srv/braindance` (per `docs/deploy.md`).

```bash
# 1. Point the service at your deploy user (the one in the `docker` group):
sudo sed -i 's/^User=deploy/User=YOUR_USER/' /srv/braindance/ops/braindance-sync.service

# 2. Symlink the units into systemd and enable the timer:
sudo ln -sf /srv/braindance/ops/braindance-sync.service /etc/systemd/system/
sudo ln -sf /srv/braindance/ops/braindance-sync.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now braindance-sync.timer
```

## Verify

```bash
systemctl list-timers braindance-sync.timer   # next/last fire
journalctl -u braindance-sync -n 50 --no-pager  # last run's output
sudo systemctl start braindance-sync.service   # force a run now
```
