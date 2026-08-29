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

## The applier — `braindance-applier.timer`

The triage loop. Every minute: `git pull --rebase`, classify anything armed
`#capture`, act on any proposal whose answer is armed, then commit and push what
changed. This is the **only writer of the vault on this box** — the api that
used to own that checkout is gone — which is why the git handling lives in
`ops/applier.sh` rather than inside the tool.

The api used to run in a container, so the host has no `node_modules` and no
build. Both are needed now — the applier runs on the host. Paths are absolute
throughout: `api/` and `ops/` are siblings, and every `cp` below reads from
`ops/`, so running them from `api/` is the obvious way to get "No such file".

```console
$ cd /srv/braindance && git pull
$ (cd api && npm ci && npm run build)
$ sudo ln -sf /srv/braindance/ops/braindance-applier.service /etc/systemd/system/
$ sudo ln -sf /srv/braindance/ops/braindance-applier.timer   /etc/systemd/system/
$ sudo mkdir -p /etc/systemd/system/braindance-applier.service.d
$ printf '[Service]\nUser=YOUR_USER\n' | sudo tee /etc/systemd/system/braindance-applier.service.d/user.conf
$ sudo systemctl daemon-reload
$ sudo systemctl enable --now braindance-applier.timer
$ systemctl list-timers braindance-applier.timer

Before enabling, check the vault checkout is clean and unowned — the api used to
drive its own rebase there, and a tree left dirty or mid-rebase makes the first
`git pull --rebase` fail:

```console
$ git -C /srv/vault status -sb
$ docker ps          # the old api container is a second writer; stop it first
```
```

### Symlink the units; put the instance-specific line in a drop-in

**`ln -sf`, not `cp`.** This used to say `cp`, and the copy is a trap that hides
for as long as nobody changes a unit. The units in `/etc/systemd/system/` then
have no relationship to the ones in the repo: `git pull` updates the repo,
`daemon-reload` re-reads the copy, and everything reports success while the box
goes on running whatever was copied there months ago. It cost six days here —
a timer interval that had been changed, landed, pulled, and reloaded, and was
still firing at the old cadence, with `systemctl cat` cheerfully printing the
stale comment that explained why.

The reason it was ever a copy is real, though: `braindance-applier.service`
ships `User=deploy`, and no box runs as `deploy`. That one line is
instance-specific, so it cannot live in the template — and editing the installed
copy is what breaks the link to the repo.

A **drop-in** is what systemd provides for exactly this. Anything in
`braindance-applier.service.d/*.conf` overrides the unit without touching it, so
the unit stays a symlink and `git pull` becomes a real deploy again:

```console
$ systemctl cat braindance-applier.service   # unit + every drop-in, in order
$ systemctl show braindance-applier.service -p User --value
```

The second command is the one to trust — it reports what systemd resolved, not
what any single file says. `ls -l /etc/systemd/system/braindance-applier.*`
answers the other half: a `->` means a unit change deploys itself, a `-rw-`
means it does not.

Knobs, all environment (`/srv/.env` via `EnvironmentFile`):

| | |
|---|---|
| `ANTHROPIC_API_KEY` | required — without it every pass fails, loudly, in the vault |
| `VAULT_PATH` | the vault checkout (default `/srv/vault`) |
| `BD_API` | where `src/cli.ts` lives (default `/srv/braindance/api`) |
| `BD_LIMIT` | captures per pass (default 10) |
| `BD_DAILY_TOKENS` | input+output tokens per UTC day (default 500000) |
| `BD_STATE_DIR` | where the spend ledger lives (default `$HOME/.local/state/braindance`) |

**Every five minutes is nearly free.** A pass with nothing armed makes no model
call — it is a filesystem scan and a `git pull`. The cadence buys latency: arm a
capture on a phone and the proposal is waiting by the time you put it down.

It used to be every minute, and this section used to say the ceiling was
`BD_LIMIT` rather than the interval, because "lengthening an interval makes a
runaway slower without making it smaller". The first half is true and the
conclusion was wrong. `BD_LIMIT` bounds a PASS, and the failure that came was
1440 passes: a write the applier could not make meant no guard could persist, so
one proposal was re-classified once a minute for 56 hours, 3189 billed calls,
stopping only when the account hit zero.

So there are two ceilings now and they do different jobs. `BD_DAILY_TOKENS`
makes a runaway **smaller** — enforced where the request leaves the process,
recorded outside the vault so it survives the vault being unwritable. The
interval makes it **slower**, which is what buys you time to notice. Neither
replaces the other.

**Tests: `bash ops/test_applier.sh`.** Throwaway repos and a stub tool — no
network, no key, no vault. Every case in it is a failure that actually happened
on a live box in one evening: the env file systemd read and a shell did not,
node missing from an empty PATH, a checkout whose tracking config a bare `git
pull` could not read, a rebase blocked by a tree the script itself had dirtied,
a root-owned directory under a user-owned vault, a push that lost a race, and a
modify/delete on a triage note resolved by hand with `rebase --skip` — which
drops the whole commit, so a correctly filed note went with it.

The loop this script wraps had 231 checks and needed no fix that evening. The
wrapper had none and needed ten. The difference was not difficulty.

**A failing pass reports into the vault, not into the journal.** It writes
`_triage/BRAINDANCE PASS FAILING.md` and pushes it, so a broken box turns up in
Obsidian on your phone like anything else — with the stage it died at, how long
it has been failing, the last 2 KB of output, and what to check. It **deletes
itself on the next good pass**, so its presence always means "broken right now".
Nothing is filed or discarded while it is failing; the loop stops rather than
guessing.

If git itself is what broke, the note cannot be pushed — it stays on the box and
rides out on the first run that can push. Check `journalctl -u
braindance-applier` when the vault says nothing and you expected it to.
