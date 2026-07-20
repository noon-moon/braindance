# ops/ — VPS self-update

The box keeps itself current by **pulling**, not by CI pushing to it. CI
(`.github/workflows/api.yml`) only builds and pushes the api image to GHCR; it
never gets SSH or Docker access to the server. This is the whole update loop:

- **`sync.sh`** — `git pull --ff-only` the repo (so the admin API's read-only
  vault mount tracks `main`) and `./deploy.sh pull api && up -d api` (rolls the
  container only if a newer image exists). `flock`-guarded against overlap.
- **`braindance-sync.service`** — a `oneshot` unit that runs `sync.sh`.
- **`braindance-sync.timer`** — fires the service ~2 min after boot and every
  ~5 min after. Tune `OnUnitActiveSec` for how fast the box adopts a new push.

## Install (on the VPS, after the stack is up)

Assumes the repo is cloned at `/srv/braindance` (per `ctx/vps-setup.md`).

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
