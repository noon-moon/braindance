#!/usr/bin/env bash
# VPS sync — runs on a systemd timer (braindance-sync). Rolls the api container
# when a new image is pushed to GHCR (by api.yml). CI never SSHes in; the VPS
# pulls itself. flock avoids overlapping runs.
#
# NOTE (Slice 1, local-first api): the repo `git pull` is NO LONGER done here.
# The api container now owns a read-write working checkout of /srv/braindance
# and drives `git pull --rebase`/push itself under a single lock. A host-side
# `git pull` would race the container's commits and index — so it is retired,
# and the in-api reconcile (GIT_PULL_INTERVAL_MS) is the single owner of the
# inbound pull. This script only rolls the image; the working tree (compose,
# ops, vault) is refreshed by the api's own pull. If you ever need a manual
# host refresh, stop the api first, then `git pull --rebase`.
set -uo pipefail

exec 9>/tmp/braindance-sync.lock
flock -n 9 || exit 0

cd /srv/braindance || exit 0

# Deploy-config self-update (compose / ops / Caddyfile).
# Pre-cutover the local-first api owns THIS checkout and drives its own
# git pull --rebase, so a host-side pull would race it — so it's skipped.
# Post-cutover the vault lives in a SEPARATE checkout (VAULT_EXTERNAL=1 in
# /srv/.env; REPO_PATH points there), so /srv/braindance is deploy-config only
# and the api never writes it — then it's safe to fast-forward here so compose/
# ops changes ship automatically (not just image rolls). Best-effort: a failed
# pull (auth/diverged) no-ops and the next run retries.
VAULT_EXTERNAL=$(awk -F= '$1=="VAULT_EXTERNAL"{gsub(/["'"'"' ]/,"",$2); print $2}' /srv/.env 2>/dev/null)
case "$VAULT_EXTERNAL" in
  1 | true | yes) git pull --ff-only 2>/dev/null || true ;;
esac

./deploy.sh pull -q api 2>/dev/null || true   # no-op until GHCR has an image
./deploy.sh up -d api 2>/dev/null || true      # recreates only if the image changed
