# braindance — resume context

## What's done

The repo at `/Users/tiernan/bd` is fully scaffolded across 3 commits on `main`:

- `f5d92ed` — Initial braindance scaffold (37 files)
- `58f7461` — Add RESUME.md
- `b86f4bd` — Follow-up: usr/ pattern, skill fidelity, sync expansion

### Structure

```
bd/
├── ctx/
│   ├── skills/           # 23 mattpocock skills (engineering, productivity, misc, personal)
│   │   └── usr/          # gitignored — personal skills go here in your fork
│   ├── tools/sys/
│   │   └── sync.sh       # Installs skills into claude-code, cursor, zed, or continue
│   └── vault/            # Obsidian vault root (open in Obsidian)
│       ├── .obsidian/    # app.json, core-plugins.json, templates.json
│       ├── _templates/   # scope.md, memo.md
│       ├── usr/          # gitignored — personal notes go here in your fork
│       ├── Repos.md      # seed scope
│       ├── Concepts.md   # seed scope (Contains: Obsidian, Braindance)
│       ├── Projects.md   # seed scope
│       ├── Obsidian.md   # scope (Contains: Braindance, Contained By: Concepts)
│       └── Braindance.md # scope (Contained By: Obsidian, Concepts)
├── repo/                 # gitignored — working repos go here
├── README.md
├── LICENSE (MIT)
└── .gitignore
```

### Personal fork workflow

- `ctx/vault/usr/` — private vault notes; gitignored in template via `ctx/vault/.gitignore`
- `ctx/skills/usr/` — personal skills; gitignored in template via `ctx/skills/.gitignore`
- To track these in a personal fork: remove/edit those two `.gitignore` files
- To pull template updates: `git remote add template <url> && git merge template/main`
- If those `.gitignore` files conflict on merge: resolve in favour of your fork's version

## What still needs doing

### GitHub remote (when ready)

```bash
gh repo create braindance --public --source=. --remote=origin --push
```

Or create manually and `git remote add origin <url> && git push -u origin main`.

### Git author identity

The commits were made with auto-detected identity. To fix:

```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
git commit --amend --reset-author  # fix most recent commit only
```

For all 3 commits, an interactive rebase would be needed — probably not worth it unless the repo is going public.

## Key design decisions

- Vault at `ctx/vault/` (not `ctx/`) — keeps skills/tools out of Obsidian's file explorer
- `ctx/tools/sys/` signals braindance lifecycle tooling, not user tools
- Harness artifacts (`.claude/`, `.cursor/`, etc.) are gitignored — created on install by `sync.sh`
- Skills are verbatim from mattpocock/skills; companion files (CONTEXT.md, docs/adr/, etc.) are per-project artifacts created by `/setup-matt-pocock-skills` inside target repos
- `usr/` gitignored via subdirectory `.gitignore` files (not root) so forks can cleanly remove them
