# Serving / deploy layer + capture pipeline

On-demand detail for the serving stack, referenced compactly from [`CLAUDE.md`](../CLAUDE.md). Read this when you are **working on the api, the homepage, the serving stack, or the note-capture pipeline**. Full human-facing configuration — the `/srv/.env` mechanics and `./deploy.sh` usage — lives in [`README.md`](../README.md) under "Admin app & serving"; consult it before changing anything here.

`api/`, `www/`, `Caddyfile`, `docker-compose.yml`, and `deploy.sh` are the optional admin-app + public-serving stack, not vault content:

- `api/` — a mobile note-capture API + read-only vault viewer (Hono/Node).
- `www/` — the static homepage served at your domain.
- `Caddyfile`, `docker-compose.yml`, `deploy.sh` — the serving stack.

## Capture pipeline

The `api` captures notes **directly to `main`**, into `ctx/vault/inbox/` (so they show up in Obsidian and the read-only vault viewer immediately, no merge step); the desk-side `Process Inbox` routine then triages each capture in-vault — an `inbox/` → flat-vault file move, no git. Writing `main` directly is safe because the api is **Tailscale-only** with no public exposure and **no built-in auth** (it must sit behind a VPN/tunnel); the old `inbox`-branch isolation was belt-and-suspenders and is now retired.

This capture ingress is orthogonal to the worktree landing flow ([`worktrees.md`](worktrees.md)): both now target `main`, but captures arrive funnel-shaped and are triaged in-vault at the desk, while agent work lands via squash-merge PRs.

**No built-in auth** — the api must sit behind a VPN/tunnel (Tailscale). Do not expose it publicly.

## v2 — local-first git, pluggable persistence, review & versioning

The api is a **local-first git store**: a capture writes a file + commits it to a working checkout *locally* (instant), then an async worker `pull --rebase`s and pushes to the remote. It owns that checkout as the **single writer**; on a rebase conflict it aborts and pauses sync rather than clobber. All of the below is config-driven and off/at-default unless set, so the default behaviour is exactly the "capture → `ctx/vault/inbox/`" pipeline above.

- **Pluggable persistence (portability).** The vault is a `VaultAdapter` (`api/src/adapter.ts`) over a backend: a **git repo** (`git.ts`) or an **object store / S3** (`objectstore.ts` + `objectadapter.ts`), interchangeable — `migrate.ts` moves a vault between them. Each operation is one atomic changeset = one version (git commit / S3 manifest), with `history()` + `revert()`.
- **Vault location is configurable** (`VAULT_SUBDIR`, default `ctx/vault`). Point `REPO_PATH` at a **standalone vault repo** and set `VAULT_SUBDIR=` (empty) to run the vault as its own repo at the checkout root — the "content-free clone" model, where the deploy config and the vault are separate repos.
- **Single-writer lease** (`REQUIRE_LEASE=1`): the api acquires + renews a TTL-fenced lease and refuses to write if fenced out; `/health` reports `holdsLease`.
- **Review model.** Agents don't write the vault directly — they POST self-contained **proposals** (`POST /proposals`) that surface in the **`/review`** queue (approve → applied via one atomic op, or edit / reject / send-back-with-feedback). Capture stays ungated → `inbox/` (de-duplicated). **`/history`** is the operation log with one-click revert.
- **Self-updating deploy.** CI (`.github/workflows/deploy-api.yml`) builds + pushes the api image to GHCR on every `api/**` / compose change; the droplet's `ops/braindance-sync.timer` pulls the new image (and, with `VAULT_EXTERNAL=1`, `git pull`s the deploy config) every few minutes — the box updates itself, CI never SSHes in.

Key `/srv/.env` knobs: `REPO_PATH`, `VAULT_SUBDIR`, `GITHUB_REPO`, `GITHUB_TOKEN`, `REQUIRE_LEASE`, `VAULT_EXTERNAL`, `PROPOSALS_DIR`, `DEDUP_TTL_MS`, `API_IMAGE`, `TAILSCALE_IP`.
