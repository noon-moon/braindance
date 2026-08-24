# Architecture — what braindance is, and the test every change has to pass

This is the north star. When a technical decision is hard, check it against the
test below rather than against local convenience.

Rewritten 2026-08-23, after a day that deleted 8,723 lines of it. The previous
version described a self-hosted web app — capture form, triage desk, task
roll-up, vault viewer — with three goals, two of which that app existed to
serve. All of it is gone. What follows is derived from what survived and why,
not from what would be nice.

## What this is

> **Personal tooling: an agent layer over a plain-markdown vault that Obsidian
> owns and git syncs.**

Not a product. There is no version of this to hand a stranger, no quickstart, no
feature flags, no export bundle. That was a real ambition once and it is
withdrawn — it cost a product/instance boundary, a template vault, a gated
deploy story, and a roadmap, all of which existed to serve users who do not
exist. Genericity remains as *hygiene* — no hardcoded paths, no personal content
in this repo — because two instances run on one machine and one of them may
belong to an employer. That is a privacy boundary, not a distribution strategy.

Three parts, in order of durability:

1. **The vault** — flat markdown in a git repo. The actual asset. It outlives
   every other component here and is readable with `cat`. Nothing may compromise
   this.
2. **The context layer** — skills, agent guides, worktree and instance
   discipline. What makes the vault workable by an agent, and the half of this
   repo that has never been deleted.
3. **The agents** — processes that read the vault, propose, and act on an answer.
   The applier (triage) is the first. It is the only part that has to be
   *running*, and that is a cost rather than a feature.

## The goals

Every change is measured against these, in this order:

1. **The vault outlives everything here.** Plain markdown in git, readable with
   `cat`, and correct after every tool in this repo is deleted. This was third
   on the old list and it is the one that paid: removing an entire web app cost
   nothing, because the asset was never inside it.
2. **Obsidian is the interface, and braindance never competes with it.** Reading,
   writing, searching, linking, tasks, calendars, mobile — all of it belongs to
   Obsidian and its plugins. Everything built here that duplicated one of those
   was deleted within weeks.
3. **Agents propose; you dispose.** Nothing an agent decides reaches the vault
   without an answer you armed by hand, on any device, in the vault itself. What
   it does is legible where you will see it and reversible through git.
4. **Fewest running things.** A convention beats a document beats a script you
   invoke beats a service. Anything that must be live needs saying out loud.

## The test

**Could Obsidian do this? Could a community plugin? Could a Shortcut, or a
cron?** If any answer is yes, it does not get built here.

That question, asked once, would have prevented the task engine, the review desk,
the vault viewer, the Today tab, the calendar feed, and the capture form —
roughly nine thousand lines, every one of them written, maintained, and then
deleted. It is not a rule of thumb; it is the summary of what actually happened.

The old test — *a feature serving none of the goals needs an explicit fourth goal
stated out loud* — **worked**, and is kept as the second gate. It correctly
flagged the task system as unratified, and the task system is precisely what got
deleted. The mechanism was sound; the goals underneath it were stale.

## The protocol

Agents share one shape, and the applier is its first implementation rather than
a special case:

```
you arm a marker  →  the agent proposes, in a note, in the vault
                  →  you answer in that note and arm it
                  →  the agent acts, and the proposal disappears
```

Everything that makes this safe is in the shape, not in the model:

- **The marker is armed by deleting a character** (`##capture` → `#capture`), so
  a template can carry it disarmed and nothing is ever read mid-writing.
- **Only the answer is an instruction.** The captured text is data, fenced; the
  reply region is bounded by a rule the model cannot forge (`safe()` guarantees
  no model-derived string reaching a note body contains a newline).
- **Nothing the model returns is taken at its word** — every value is checked
  against the live vault, and anything ambiguous asks again rather than guessing.
- **A failure reports where you will see it**, in the vault, and clears itself.

A second agent — a weekly review, a publish pass, a link-rot check — should reuse
that shape. But it must pass the test first: **this protocol is not a licence to
add agents.** It is how an agent behaves *once it has justified existing*, and
the way the last system accreted was one plausible feature at a time.

Extraction follows a second implementation, not the anticipation of one. There is
no protocol module today because there is one caller.

## The boundary that remains

Not product vs instance — **the tooling repo vs the vault repo**, and it is a
privacy boundary rather than a distribution one:

```
braindance   tooling, skills, agent guides, the applier. No personal content.
<vault>      your notes. Its own repo, its own remote, its own sync.
```

Publishing keeps its own version of the same line: `publish: true` notes are
projected into a **separate site repo**, and that separateness *is* the
guarantee — a repo cannot leak a note it was never given.

Instances (work and personal side by side, resolved from where you are) stay for
the same reason. The cross-instance write guard is a genuine boundary when one
vault belongs to an employer. Mechanics: [`instances.md`](instances.md).

## Deployment

One systemd timer running a shell script for a second or two a minute. Nothing
listens; there is no container, no port, no private network to arrange. See
[`deploy.md`](deploy.md) and [`../ops/README.md`](../ops/README.md).

The previous version of this document specified "one `docker compose up` against
any host", Tailscale, a public container image, and a CI deploy that SSHed in.
That was the deployment story of a web app.

## Schema drift

The vault's vocabulary is defined in its own `_meta/Tags.md` and read at runtime;
the publish tool carries a frontmatter whitelist. Those two can still drift, and
have. The old fix — one module owning the grammar, importing into both, with
conformance tests — is still the right shape and is still unbuilt. It is smaller
now: the task-line grammar it was mostly about no longer exists, TaskNotes owns
that and its config is read from the plugin.

## What braindance is not

- **Not a product.** See above. No quickstart, no gates, no export.
- **Not a note-taking app.** Obsidian is. Anything here that starts to look like
  one is a mistake with a deletion date.
- **Not a website.** The public site is an output of `publish` and lives in its
  own repo.
- **Not a home for domain-specific tools.** Braindance encodes *how you work*,
  never *what you are into*. A utility that knows about a hobby, a service, or a
  media library belongs in a separate repo and takes the vault as an argument.
  The `music/` tools were extracted on exactly this line.
- **Not a task manager.** That was tried, ratified as a fourth goal, and reversed
  inside a day. TaskNotes owns tasks; this repo reads its configuration and
  otherwise stays out of the way.
