# Active-instance resolution (C1–C4) — the multi-instance model

> **Status: NORMATIVE.** The mechanism described here is built and tested — the
> resolver (`ctx/tools/sys/resolve.sh`), `./configure`, `bd use`/`where`, and the
> `SessionStart` + cross-instance `PreToolUse` hooks all exist. The C1–C4 rule
> family lives canonically in [`AGENTS.md`](../AGENTS.md); this file is its
> mechanics. Wiring is installed per-clone by `./configure` (settings.json is
> fork-local). One caveat remains: while `BD_ROOT`/`VAULT_PATH`/`REPOS_PATH` are
> exported in your shell, resolution stays in **escape-hatch mode** (dormant) —
> remove those exports to hand a shell to the resolver.

On-demand detail for the **active-instance discipline** — how one machine hosts
several braindance clones at once, each governing a different scope, and how any
tool, shell, or agent resolves *which one is current* from where it is. Read this
when you are building or reasoning about instance resolution, writing
`./configure`, or wiring the resolver hook. The single-root model it builds on
(`$BD_ROOT` / `VAULT_PATH` / `REPOS_PATH` / `BD_CORE`) is in
[`CLAUDE.md`](../CLAUDE.md) and `README.md`.

## The working model this enables

Clone braindance more than once — a `work` instance (work vault, work repos) and
a `personal` instance (personal vault, personal repos) — on one machine, and have
the right one be **current** automatically when you work in its territory, with an
explicit override when you need it. One command in a clone's root registers it;
clones coexist and none is a hardcoded global default. The story:

```console
$ cd ~/work/braindance && ./configure --name work
$ cd ~/dev/braindance  && ./configure --name personal --default
$ cd ~/work/repo/app                 # -> work instance current
$ cd ~/dev/repo/loon                 # -> personal instance current
$ bd use work                        # pin this shell to work regardless of cwd
```

Today a single instance is configured globally by hand-editing shell dotfiles
(`export BD_ROOT=...`), so exactly one braindance is current system-wide. This
model replaces that global singleton with **per-context resolution**.

## Definitions

An **instance** is one scope, identified by a `name` (`[a-z0-9-]+`, unique) that
owns three **territories**:

| Territory | What | The env knob it becomes |
|---|---|---|
| `core` | the braindance checkout (git ops, `CLAUDE.md`, `ctx/`) | `BD_CORE` |
| `vault` | its knowledge base; `_ephemeral/` scratch rides here | `VAULT_PATH` |
| `repos` | where its target repos live (a repo is `<repos>/<name>`) | `REPOS_PATH` |

"Which braindance is current" ≡ "which instance's territory is my cwd in."

**Key continuity:** the resolver's output is *exactly* the existing env contract
(`BD_CORE` / `VAULT_PATH` / `REPOS_PATH`). Every current consumer already reads
those — the `api`, `wt.sh`, `gen-topics.sh`, the `block-loon-main-writes.py`
guard — so **none of them change**. The resolver is only a front-end that chooses
*which* values to export, per-context, instead of a human setting them once.

## The registry — single source of truth

Resolution keys off a user-global registry, **not** files scattered in working
trees (nothing to gitignore, nothing to drift, one place to read):

```
${XDG_CONFIG_HOME:-~/.config}/braindance/
  instances/
    work.conf         core  = /Users/you/work/braindance
                      vault = /Users/you/work/vault
                      repos = /Users/you/work/repo
    personal.conf     core  = /Users/you/dev/braindance
                      vault = /Users/you/dev/vault
                      repos = /Users/you/dev/repo
  default             personal            # optional: one instance name
```

`*.conf` is `key = value`, one absolute path per territory. `default` holds a
single instance name (optional). The registry is user-global on purpose: it is
the index across a user's instances, and `bd use <name>` resolves by name against
it. It is **never committed** to any clone — it is per-machine, per-user state.

## The resolution ladder

A single resolver (`ctx/tools/sys/resolve.sh`, reused by the `SessionStart` hook,
the shell `chpwd` hook, `bd`, and callable by agents for C1) walks this ladder
top-to-bottom and stops at the first hit:

```
0. Env already set & UNSTAMPED  (VAULT_PATH/REPOS_PATH set, no BD_ACTIVE_INSTANCE)
      -> honor verbatim, resolve nothing.        [escape hatch: api, CI, one-offs]
1. bd use <name> pin for this shell  (BD_USE set)
      -> instance = BD_USE.                        [explicit; wins over location]
2. Location: realpath(cwd) is under some instance's core|vault|repos.
   In a git worktree? also test `git rev-parse --git-common-dir`.
   LONGEST-PREFIX match wins.                      [auto — the "in a repo" story]
3. Registry `default` pointer is set
      -> instance = default.                        [cwd=~, nowhere in particular]
4. NO instances registered at all
      -> nested legacy default (today's behavior, byte-for-byte).  [compat]
5. Otherwise
      -> UNRESOLVED -> stop & surface (rule C3).     [ambiguous multi-instance]
```

On a hit at 1–3, the resolver exports from the instance's registry entry:

```
BD_ACTIVE_INSTANCE=<name>     # the stamp — step 0 checks it
BD_CORE=<core>
VAULT_PATH=<vault>
REPOS_PATH=<repos>
```

The stamp is what makes re-resolution idempotent: a fresh `cd` re-runs the ladder
and re-exports; a manually pre-set `VAULT_PATH`/`REPOS_PATH` (no stamp) is left
untouched at step 0, so the `api` and one-off overrides keep working.

### Step semantics, precisely

- **Step 0 — the escape hatch.** If `VAULT_PATH` or `REPOS_PATH` is already
  exported and `BD_ACTIVE_INSTANCE` is not, the resolver assumes a human/CI/api
  set it deliberately and does nothing. This is how the served `api` and any
  `FOO_PATH=… command` one-off stay authoritative over the resolver.
- **Step 1 — the explicit pin.** `bd use <name>` sets `BD_USE=<name>` for the
  current shell (sticky, like `nvm use`); `bd use --auto` (or `bd use` with no
  arg) clears it and restores location-based resolution. The pin wins over cwd so
  you can sit anywhere and still target an instance.
- **Step 2 — location, longest-prefix.** `realpath(cwd)` is tested against every
  registered instance's three territory paths; the **longest** matching prefix
  wins (so a repo nested deep under `repos` resolves to that instance, not to a
  shorter-prefix sibling). When cwd is inside a git worktree, the worktree's
  `--git-common-dir` (its main checkout) is *also* tested — so a braindance-core
  worktree under `~/dev/bd-wt/<task>` resolves through its common dir back to the
  core's territory, and a target-repo worktree resolves through to that repo.
- **Step 3 — the default pointer.** Only consulted when the pin is unset and cwd
  matched nothing. Convenience for `cwd=~`; opt-in per registry.
- **Step 4 — legacy compat.** With **zero** instances registered, the resolver
  produces today's nested defaults exactly (`BD_CORE` self-resolved from the
  tooling's own location, `VAULT_PATH=<core>/ctx/vault`, `REPOS_PATH=<core>/repo`).
  The bare template and any single-instance user who never runs `./configure`
  behave identically to now — this model is purely additive.
- **Step 5 — stop, don't guess.** Instances *are* registered, but cwd maps to
  none and no pin/default applies → the resolver exits non-zero with a message
  (`no active instance for this location; run: bd use <name>`). The
  `SessionStart` hook surfaces this rather than silently falling back to empty
  `ctx/vault` scaffolding — the footgun that once left a real vault unused.

## Invariants

- **Distinct instances have disjoint territories.** No instance's `core`,
  `vault`, or `repos` may nest inside a *different* instance's. `./configure`
  refuses a registration that would overlap. This guarantees the longest-prefix
  match at step 2 is unique. *Nesting within one instance is legal* — the legacy
  nested layout (`repos = <core>/repo`, `vault = <core>/ctx/vault`) is exactly
  that, and walk-up there only ever meets the one instance.
- **The legacy path is untouched.** See step 4. Zero-instance behavior is
  byte-for-byte today's behavior.
- **The registry is machine-local and uncommitted.** Instance identity is
  per-machine state, never template or fork content.

## `./configure` (the one-command bootstrap)

Run in a clone's root. It:

1. Resolves this clone's territories: `core = $PWD`; `vault`/`repos` from
   `--vault`/`--repos` flags, else the current `$BD_ROOT`/`VAULT_PATH`/
   `REPOS_PATH` env, else the nested defaults.
2. Derives `--name` (default: basename of `core`, or a `--name` flag); validates
   it is unique and its territories are **disjoint** from every registered
   instance (else it errors and changes nothing).
3. Writes `instances/<name>.conf`; sets `default` if `--default` is passed.
4. Installs the resolver wiring **once, idempotently**: the `SessionStart` hook
   entry in the harness settings, and the `chpwd`/rc shim that sources the shell
   integration. Re-running `./configure` updates the entry in place.

It is per-clone and idempotent, so N clones each register themselves and none is
"the" global default.

## Enforcement — two layers that must agree

Instruction files cannot *auto*-enforce; they state doctrine agents self-apply.
The automatic half is hooks. Same split braindance already uses for R1.

- **Portable doctrine (`AGENTS.md` C1–C4).** Reaches every tool (Codex, Cursor,
  Gemini, Claude) — the canonical rules **live in [`AGENTS.md`](../AGENTS.md)**:
  C1 resolve the active instance before working; C2 stay inside it (reads/writes
  only its `VAULT_PATH`/`REPOS_PATH`); C3 ambiguity ⇒ stop, don't guess; C4 one
  command (`./configure`) bootstraps a clone. Agents self-apply these even where
  no hook runs.
- **Mechanical backstop (Claude Code hooks).** The auto part, Claude-Code-specific:
  - **`SessionStart`** (`.claude/hooks/resolve-instance.py`) — resolves the
    active instance for the session cwd and injects it as `additionalContext`
    (C1 awareness), or notes that none is active. Informational only — a
    SessionStart hook cannot block. The shell integration (`wt.sh`) is what
    actually exports the env for Bash tool calls.
  - **`PreToolUse`** (`.claude/hooks/block-cross-instance-writes.py`, C2) —
    blocks a mutation whose target lands in another instance's `vault`/`repos`
    than the one active for the tool's cwd (for Bash, the effective cwd after a
    leading `cd`). Narrow + fail-open like `block-loon-main-writes.py`; a no-op
    with no registry. The hook **scripts** are template-tracked; the settings.json
    **wiring** is installed per-clone by `./configure` (and stays fork-local).

## Worked examples

```
cwd = ~/dev/repo/loon             -> step 2: under personal.repos          -> personal
cwd = ~/dev/bd-wt/some-task       -> step 2 via common-dir -> ~/dev/braindance (personal.core) -> personal
cwd = ~/work/repo/app  (no pin)   -> step 2: under work.repos              -> work
cwd = ~/work/repo/app  + bd use personal -> step 1 (pin)                   -> personal
cwd = ~  + default=personal       -> step 3                                -> personal
cwd = ~  + no default             -> step 5                                -> STOP
cwd = anywhere, VAULT_PATH preset by api -> step 0: honored, no resolve
(no instances registered anywhere) -> step 4: nested legacy default (unchanged)
```

## Non-goals / open edges

- **Auto-adopting arbitrary target repos.** A repo cloned *outside* any
  instance's `repos` dir is not owned by that instance; work in it resolves via
  the ladder (likely step 3/5). Ownership is by territory, not by "it's a git
  repo I opened."
- **Cross-shell parity.** The `chpwd` re-resolve is specified for zsh (`chpwd`)
  and bash (`PROMPT_COMMAND`); other shells get `bd use` / manual resolve only.
- **The VPS `api`'s own `VAULT_PATH`.** The served vault is configured
  independently (step 0 keeps it authoritative) — see [`serving.md`](serving.md).

## Fit with what exists

- Builds directly on the single-root model (PR #34): the resolver just *chooses*
  `BD_CORE`/`VAULT_PATH`/`REPOS_PATH` per-context; the override chain
  (`VAULT_PATH` → `BD_ROOT/vault` → nested) is unchanged.
- `bd` already resolves its trunk branch dynamically (PR #37), so instances on
  different default branches coexist.
- `gen-topics.sh` already honors the resolved vault (PR #36), so per-instance
  topic manifests regenerate against the right vault once the resolver sets it.
