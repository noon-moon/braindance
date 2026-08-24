# braindance

A meta-repository for agentic development. Clone it once, keep it as your personal knowledge and workflow layer, then plug any repository into the repos dir to bring that context to bear.

braindance is the **system**, not your data. It carries the tooling, skills, agent guidance, and an optional admin container you deploy to your own infrastructure. Your notes live in a separate vault; anything you publish lives in a separate site repo:

```
braindance      this repo — tooling, skills, agent guides, and the admin app (→ container → your infra)
vault           your knowledge base; the container owns a checkout of it and syncs periodically
<site>          optional: a public site repo the publish tool projects notes into
```

Each is independent. You can use braindance with nothing but a vault and never deploy anything.

## Layout

```
bd/
├── ctx/
│   ├── skills/        LLM-agnostic skill prompts (plain markdown; installed into your harness)
│   ├── tools/
│   │   ├── sys/       Lifecycle tooling — configure, resolve, sync.sh, wt.sh (`bd`), gen-topics
│   │   ├── orchestration/  Multi-agent fleet helpers
│   │   └── pub/       Publish tool: projects `publish: true` notes into a site repo
│   └── vault/         Default (nested) vault location — Obsidian config + templates only
├── docs/              The manual (see the map below)
├── api/               Admin app: mobile capture + review desk + read-only vault viewer
├── Caddyfile · docker-compose.yml · deploy.sh · ops/     Serving stack
├── CLAUDE.md · AGENTS.md    Agent directives (Claude / cross-tool)
└── repo/              Gitignored — default (nested) home for your target repos
```

## Quick start

```bash
git clone <this-repo> bd
cd bd
./configure --name personal --default
```

`./configure` registers this clone and wires your machine, idempotently:

- writes `~/.config/braindance/instances/personal.conf` (its three paths)
- installs the `SessionStart` + cross-instance-guard hooks into `~/.claude/settings.json`
- appends `source <core>/ctx/tools/sys/wt.sh` to your shell rc (`~/.zshrc` / `~/.bashrc`)

Open a new shell so the rc change takes effect — that gives you the `bd` command and automatic context resolution as you `cd`. Then:

```bash
./ctx/tools/sys/sync.sh claude-code    # install skills as /slash-commands
```

Open your vault directory in Obsidian. By default that's `$VAULT_PATH/`; point `--vault` at somewhere else if you keep it outside the checkout (most people do — see Contexts).

Useful flags: `--vault <path>` and `--repos <path>` to place those territories, `--worktrees <path>` to say where agent worktrees live (`bd new <task>` creates `<worktrees>/<task>`; defaults to a `worktrees` sibling of this clone), `--no-wire` to register without touching your settings or rc.

## Contexts — running more than one braindance

A **context** (an *instance*) is one braindance clone governing one scope, and it owns three territories:

| Territory | What it is | Env var |
|---|---|---|
| `core` | the checkout itself | `BD_CORE` |
| `vault` | its knowledge base | `VAULT_PATH` |
| `repos` | where its target repos live (`<repos>/<name>`) | `REPOS_PATH` |

You can have several — a `work` context with a work vault and work repos, and a `personal` one — and **which is current is resolved from where you are**, not from a global setting.

**Which context am I in?**

```console
$ bd where
instance: personal
  core  = /Users/you/bd
  vault = /Users/you/dev/vault
  repos = /Users/you/dev/repo

$ bd ls-instances
personal * (default)
work
```

`*` marks the active one, `(default)` the registry's fallback. Claude Code also prints the active context at the start of every session, so an agent knows which vault it may touch.

**Switching.** Three ways, in precedence order:

```bash
bd use work        # pin THIS shell to work, regardless of directory
bd use --auto      # release the pin, back to resolving by location
cd ~/work/repo/app # just being in a territory resolves to its context
```

Location resolution is automatic on `cd` (via the shell hook `configure` installed) and uses longest-prefix matching, so a repo deep under `work`'s repos dir resolves to `work`. Git worktrees resolve through their main checkout. If you're nowhere in particular (`cd ~`), the registry `default` applies; if nothing matches and there's no default, resolution **stops rather than guessing** — a wrong guess would point an agent at the wrong vault.

**Adding a second context:**

```bash
cd ~/work/braindance
./configure --name work --vault ~/work/vault --repos ~/work/repo
```

Territories must be **disjoint** — no context's core, vault, or repos may sit inside another's. `configure` refuses a registration that would overlap, and changes nothing when it does.

**The registry** lives at `~/.config/braindance/` — one `instances/<name>.conf` per context plus an optional `default`. It's machine-local and never committed.

**Escape hatch.** If you export `VAULT_PATH` / `REPOS_PATH` / `BD_ROOT` yourself, resolution stays dormant and your values win. That's how the deployed app and one-off `VAULT_PATH=… command` invocations stay authoritative. Unset them to hand the shell back to the resolver.

Full mechanics — the resolution ladder, step semantics, worked examples: [`docs/instances.md`](docs/instances.md).

## The manual

| If you're… | Read |
|---|---|
| wondering what braindance is for, or whether a change belongs | [`docs/architecture.md`](docs/architecture.md) |
| deploying the capture/review app to a host | [`docs/deploy.md`](docs/deploy.md) |
| installing or writing skills | [`docs/skills.md`](docs/skills.md) |
| working in the vault — conventions, triage, scratch | [`docs/vault.md`](docs/vault.md) |
| resolving or bootstrapping contexts | [`docs/instances.md`](docs/instances.md) |
| running the admin app or the serving stack | [`docs/serving.md`](docs/serving.md) |
| publishing vault notes to a public site | [`docs/publishing.md`](docs/publishing.md) |
| running parallel agent sessions (worktrees, landing) | [`docs/worktrees.md`](docs/worktrees.md) |
| orchestrating a fleet of sub-agents | [`docs/orchestration.md`](docs/orchestration.md) |

Agent-facing directives live in [`CLAUDE.md`](CLAUDE.md) (Claude Code) and [`AGENTS.md`](AGENTS.md) (the cross-tool [AGENTS.md](https://agents.md) standard). They state rules and point here for the explanations.

## License

MIT — see [`LICENSE`](LICENSE).
