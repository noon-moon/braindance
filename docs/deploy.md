# Standing it up on a host

Almost nothing runs. There is no container to deploy, no port to open, no image
to pull, and no private network to arrange — **nothing listens**. What runs is a
systemd timer executing a shell script for a second or two a minute.

That is a recent and deliberate shrinking. This document used to describe
deploying a Hono app behind Tailscale on port 3000, with a public container
image, a CI deploy that SSHed in, and a `/health` endpoint to gate the roll.
All of that existed to serve a web UI — capture, triage, a task roll-up, a vault
viewer. Obsidian does those now, on the phone as well as the desk, and the box
was left with one job: classify what you armed, and file what you answered.

## What the host needs

- **A vault checkout** it can read and write, on the branch your clients push to.
- **node**, and the tool built once (`npm ci && npm run build`).
- **`ANTHROPIC_API_KEY`** in `/srv/.env`.
- **Git push credentials** for the vault remote.

No Docker, unless you also serve a public site — Caddy is the only container
left in `docker-compose.yml`, and it is unrelated to this loop.

## Layout

```
/srv/vault          the vault checkout — the applier is the only writer here
/srv/braindance     this repo: ops/applier.sh, and api/ built to api/dist
/srv/.env           ANTHROPIC_API_KEY, and any BD_* overrides
```

Both checkouts must be **owned by the user the timer runs as**. A root-owned
directory under a user-owned vault is a real failure mode and cost an evening:
every pass died inside a rebase with one buried "Permission denied". The script
checks writability on its first line now and says exactly what is wrong, but the
cheaper fix is not creating the situation — never run `applier.sh`, or git in
these checkouts, with `sudo`.

## Install

```console
$ git clone <this repo> /srv/braindance
$ git clone <your vault> /srv/vault
$ (cd /srv/braindance/api && npm ci && npm run build)
$ printf 'ANTHROPIC_API_KEY=sk-ant-…\n' | sudo tee -a /srv/.env
$ /srv/braindance/ops/applier.sh          # once, by hand
```

That manual run is the whole smoke test. It prints which vault it resolved,
finds nothing armed, and exits — proving the key, the paths, the build, and the
git configuration in one line each. **Run it before enabling the timer**: the
script reads `/srv/.env` itself precisely so that a hand run and a timer run are
the same program, which they were not until it did.

Then the timer: [`../ops/README.md`](../ops/README.md).

## Updating

The box no longer updates itself. `braindance-sync.timer` rolled the api image
and is obsolete; disable it. To take a new version:

```console
$ cd /srv/braindance && git pull
$ (cd api && npm ci && npm run build)      # only when api/ changed
```

The timer picks up a changed `ops/applier.sh` on its next firing with no restart
— it is a script, not a daemon.

## Failure

A pass that cannot complete writes `_triage/BRAINDANCE PASS FAILING.md` into the
vault and pushes it, so a broken host reaches your phone. It clears itself on the
next good pass. `journalctl -u braindance-applier` is the fallback for the case
the note cannot cover: when git itself is what broke, and the report cannot be
pushed.

## What is gone, and why you may still find references

The api's container image, `api/Dockerfile`, and
`.github/workflows/deploy-api.yml` are deleted. If a host still has
`braindance-api-1` running it is a second writer of your vault and will fight
the applier — stop it and set `--restart=no`, or it returns on the next Docker
daemon restart.
