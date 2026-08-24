# braindance

Personal tooling: an agent layer over a plain-markdown vault that Obsidian owns
and git syncs. It carries skills, agent guidance, worktree discipline, and one
agent that triages what you capture.

**Not a product.** There is no version of this to hand a stranger — no
quickstart for someone else, no feature flags, no export. It is one person's
setup, written down. You are welcome to read it and take what is useful.

Three repos, each independent:

```
braindance      this repo — skills, agent guides, tooling, and the applier
<vault>         your notes. Obsidian opens it, obsidian-git syncs it
<site>          optional: a public site the publish tool projects notes into
```

## What actually runs

One systemd timer, a second or two a minute. Nothing listens; there is no
container and no port.

```
Obsidian     write a note, anywhere → arm it: #capture
   ↓ obsidian-git
the timer    classify what is armed → a proposal in _triage/
             act on proposals you have answered → the filed note
   ↓ obsidian-git
Obsidian     read the proposal, answer in it, arm it → filed
```

The marker is armed by **deleting a character** (`##capture` → `#capture`), so a
template can carry it disarmed and a note you are three words into is invisible.
Nothing files without an answer you armed by hand. Details:
[`docs/serving.md`](docs/serving.md).

## The rule

> **Could Obsidian do this? Could a community plugin? Could a Shortcut, or a
> cron? If any answer is yes, it does not get built here.**

That question, asked once, would have prevented about nine thousand lines that
were written, maintained, and then deleted — a task engine, a review desk, a
vault viewer, a daily-note editor, a calendar feed and a capture form. Obsidian
does all of it, better. Reasoning: [`docs/architecture.md`](docs/architecture.md).

## Layout

```
bd/
├── ctx/
│   ├── skills/        LLM-agnostic skill prompts (plain markdown; installed into your harness)
│   └── tools/
│       ├── sys/       Lifecycle tooling — configure, resolve, sync.sh, wt.sh (`bd`), gen-topics
│       ├── orchestration/  Multi-agent fleet helpers
│       └── pub/       Publish tool: projects `publish: true` notes into a site repo
├── api/               The classifier and the applier — no server, a CLI the timer invokes
├── ops/               The timer, the script it runs, and its tests
├── docs/              The manual (see the map below)
├── Caddyfile · docker-compose.yml · deploy.sh   Caddy only, if you serve a public site
├── CLAUDE.md · AGENTS.md    Agent directives (Claude / cross-tool)
└── repo/              Gitignored — default (nested) home for your target repos
```

## Setting up a clone

```bash
git clone <this-repo> bd
cd bd
./configure --name personal --vault ~/dev/vault --default
```

`--vault` is **required**: there is no default and no vault inside this
checkout. `configure` refuses rather than inventing one, because a plausible
wrong path is worse than none — a default pointing at a nested directory once
had the applier writing into a checkout nobody reads, for an evening, silently.

It then registers the clone and wires the machine, idempotently:

- writes `~/.config/braindance/instances/personal.conf` (its three paths)
- installs the `SessionStart` + cross-instance-guard hooks into `~/.claude/settings.json`
- appends `source <core>/ctx/tools/sys/wt.sh` to your shell rc (`~/.zshrc` / `~/.bashrc`)

Open a new shell so the rc change takes effect — that gives you the `bd` command
and automatic context resolution as you `cd`. Then:

```bash
./ctx/tools/sys/sync.sh claude-code    # install skills as /slash-commands
```

Open the vault in Obsidian and install `obsidian-git`; that is the sync, on the
desk and on a phone, and it is what replaced paying for Obsidian Sync.

Useful flags: `--repos <path>` to place the repos territory, `--worktrees <path>`
to say where agent worktrees live (`bd new <task>` creates `<worktrees>/<task>`),
`--no-wire` to register without touching your settings or rc.

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

**Escape hatch.** If you export `VAULT_PATH` / `REPOS_PATH` / `BD_ROOT` yourself, resolution stays dormant and your values win. That is how `ops/applier.sh` and one-off `VAULT_PATH=… command` invocations stay authoritative. Unset them to hand the shell back to the resolver.

Full mechanics — the resolution ladder, step semantics, worked examples: [`docs/instances.md`](docs/instances.md).

## The manual

| If you're… | Read |
|---|---|
| wondering what braindance is for, or whether a change belongs | [`docs/architecture.md`](docs/architecture.md) |
| setting the timer up on a host | [`docs/deploy.md`](docs/deploy.md) |
| installing or writing skills | [`docs/skills.md`](docs/skills.md) |
| working in the vault — conventions, triage, scratch | [`docs/vault.md`](docs/vault.md) |
| resolving or bootstrapping contexts | [`docs/instances.md`](docs/instances.md) |
| working on the classifier, the applier, or the triage loop | [`docs/serving.md`](docs/serving.md) |
| publishing vault notes to a public site | [`docs/publishing.md`](docs/publishing.md) |
| running parallel agent sessions (worktrees, landing) | [`docs/worktrees.md`](docs/worktrees.md) |
| orchestrating a fleet of sub-agents | [`docs/orchestration.md`](docs/orchestration.md) |

Agent-facing directives live in [`CLAUDE.md`](CLAUDE.md) (Claude Code) and [`AGENTS.md`](AGENTS.md) (the cross-tool [AGENTS.md](https://agents.md) standard). They state rules and point here for the explanations.

## License

MIT — see [`LICENSE`](LICENSE).
