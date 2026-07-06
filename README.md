# braindance

A meta-repository for agentic development. Clone it once, maintain it as your personal knowledge and workflow layer, then plug any repository into `repo/` to bring that context to bear.

```
bd/
├── ctx/
│   ├── skills/           # LLM-agnostic skill definitions (plain markdown prompts)
│   │   ├── engineering/
│   │   ├── misc/
│   │   ├── personal/
│   │   ├── productivity/
│   │   └── usr/          # Your personal skills (gitignored in template)
│   ├── tools/
│   │   └── sys/          # Braindance lifecycle tooling
│   │       └── sync.sh   # Installs skills into your LLM harness
│   └── vault/            # Obsidian vault — open this directory in Obsidian
│       │                 # Only .obsidian/, _templates/, _meta/ are tracked;
│       │                 # your notes are gitignored (personal, per-machine)
└── repo/                 # Gitignored — clone the repos you're working on here
```

## Quick start

```bash
git clone <this-repo> bd
cd bd
mkdir repo

# Install skills into your LLM harness (see "Skills" below)
./ctx/tools/sys/sync.sh claude-code
```

Open `ctx/vault/` as a vault in Obsidian.

---

## Skills

Skills are plain markdown files in `ctx/skills/`. Each file is a self-contained prompt command — not tied to any LLM harness. You install them into whichever harness you use.

### Installing skills

**Claude Code** — symlinks skills into `.claude/commands/` so they become `/slash-commands`:
```bash
./ctx/tools/sys/sync.sh claude-code
```

**Cursor** — copies skills into `.cursor/rules/`:
```bash
./ctx/tools/sys/sync.sh cursor
```

**Zed** — copies skills into `.zed/prompts/`:
```bash
./ctx/tools/sys/sync.sh zed
```

**Continue** — copies skills into `.continue/prompts/`:
```bash
./ctx/tools/sys/sync.sh continue
```

**Any other harness** — copy the files from `ctx/skills/` into your harness's prompt/commands directory. Skills are plain markdown; no transformation needed.

### Keeping skills in sync

After pulling upstream changes to this repo, re-run the sync script to update your harness's copy.

---

## Skills included

Skills from [mattpocock/skills](https://github.com/mattpocock/skills) by [Matt Pocock](https://github.com/mattpocock), reproduced here for harness-agnostic portability. Some skills reference companion files (e.g. `CONTEXT.md`, `docs/adr/`) that are created per-project by the setup skills.

### Productivity
| Skill | Description |
|---|---|
| `grill-me` | Relentless interview to sharpen a plan or design |
| `grilling` *(model-invoked)* | The underlying grilling discipline |
| `handoff` | Compact a conversation into a document for another agent |
| `teach` | Multi-session, stateful teaching workspace |
| `writing-great-skills` | Reference for writing effective skills |

### Engineering
| Skill | Description |
|---|---|
| `ask-matt` | Router over all engineering skills and flows |
| `codebase-design` | Vocabulary and principles for deep modules |
| `diagnosing-bugs` | Disciplined bug diagnosis loop |
| `domain-modeling` *(model-invoked)* | Build and maintain a project domain model |
| `grill-with-docs` | Grilling that updates `CONTEXT.md` and ADRs inline |
| `improve-codebase-architecture` | Scan codebase for deepening opportunities |
| `prototype` | Throwaway code to answer a design question |
| `setup-matt-pocock-skills` | Configure the engineering skills for a repo (run once) |
| `tdd` *(model-invoked)* | Test-driven development with vertical slices |
| `to-issues` | Break a plan into independently-grabbable issues |
| `to-prd` | Turn a conversation into a PRD on the issue tracker |
| `triage` | Move issues through a triage state machine |

### Misc
| Skill | Description |
|---|---|
| `git-guardrails-claude-code` | Claude Code hooks to block dangerous git operations |
| `migrate-to-shoehorn` | Replace `as` type assertions in test files |
| `scaffold-exercises` | Create exercise directory structures |
| `setup-pre-commit` | Configure Husky + lint-staged pre-commit hooks |

### Personal
| Skill | Description |
|---|---|
| `edit-article` | Edit and improve article drafts |
| `obsidian-vault` | Search and manage notes in an Obsidian vault |

---

## Personal content

**Vault notes** — `ctx/vault/.gitignore` ignores everything in the vault except the base scaffolding (`.obsidian/`, `_templates/`, `_meta/`). Any notes you write live only on your machine; the template never tracks them, in this repo or a fork.

**Skills** — `ctx/skills/usr/` is gitignored in this template but intended for use in your personal fork. `sync.sh` picks these up automatically alongside the template skills. To track them in your fork, remove or edit `ctx/skills/.gitignore` — when you pull template updates, that's the one likely conflict point; resolve it in favour of your fork's version.

---

## Vault

Open `ctx/vault/` as a vault in Obsidian.

The vault uses two note types, enforced by frontmatter tags:

- **`scope`** — a hub note (MOC) for a topic. Has `Contains` and `Contained By` frontmatter linking to related scopes. The relationship is intentionally loose — it covers "owns / owned by", "contains / contained by", and similar dual relationships.
- **`memo`** — a standard note on a specific topic.

On top of a note type, behavioural tags can stack: **`todo`** (actionable, with `status`/`due`/`completed` fields — aggregated in `TODO.md`, powered by the Dataview plugin), **`recurring`** (a standing routine tracked by a `processed` date), and **`daily`** (a dated log note in `daily/`, created via the core Daily Notes plugin). Full definitions live in `ctx/vault/_meta/Tags.md`.

Templates live in `ctx/vault/_templates/`. `TODO.md` ships as scaffolding (the only tracked note); Dataview and Daily Notes are pre-enabled in the Obsidian config, but you install the Dataview community plugin yourself via Obsidian's UI.

### Companion files

Some engineering skills (`diagnosing-bugs`, `tdd`, `domain-modeling`, `codebase-design`, `triage`, `improve-codebase-architecture`, `writing-great-skills`) reference companion files that don't exist in this repo. These are per-project artifacts created by `/setup-matt-pocock-skills` when you run it inside a target repo. They're not part of braindance itself.

---

## License

MIT — see [LICENSE](LICENSE).
