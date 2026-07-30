#!/usr/bin/env sh
# Compose wrapper: always feed ${VAR} interpolation from /srv/.env.
#
# docker compose interpolates ${VAR} in docker-compose.yml from the shell
# env or a project ./.env — NOT from the `env_file:` directive (that only
# sets *container* env). So every invocation must point interpolation at
# /srv/.env; this wrapper guarantees it.
#
#   ./deploy.sh up -d
#   ./deploy.sh pull api && ./deploy.sh up -d api
#   ./deploy.sh config          # render the fully-resolved compose file
#   ./deploy.sh logs -f caddy
exec docker compose --env-file /srv/.env "$@"
