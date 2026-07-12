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
