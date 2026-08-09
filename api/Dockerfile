FROM node:22-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
# `git` is required at runtime: the api is local-first and drives a read-write
# working checkout of the repo via simple-git (commit/pull --rebase/push).
# `ca-certificates` is REQUIRED too — with --no-install-recommends it is NOT
# pulled in as a git dependency, and without a CA bundle git-over-HTTPS to
# GitHub fails with "server certificate verification failed. CAfile: none".
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY public ./public
# The commit this image was built from, surfaced at /health. Without it there is
# no way to tell from outside the box whether a deploy actually rolled — the two
# failure modes (stale image, unapplied env) look identical from a client.
ARG BUILD_SHA=dev
ENV BUILD_SHA=$BUILD_SHA
EXPOSE 3000
CMD ["node", "dist/index.js"]
