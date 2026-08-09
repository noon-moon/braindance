# Skills — installing, syncing, and what ships

Skills are plain markdown files in `ctx/skills/`. Each one is a self-contained prompt command, tied to no particular LLM harness — you install them into whichever you use. They are the **source of truth**; a harness gets its own installed copy.

## Installing

```bash
./ctx/tools/sys/sync.sh claude-code   # symlinks into .claude/commands/ → /slash-commands
./ctx/tools/sys/sync.sh cursor        # copies into .cursor/rules/
./ctx/tools/sys/sync.sh zed           # copies into .zed/prompts/
./ctx/tools/sys/sync.sh continue      # copies into .continue/prompts/
```

Any other harness: copy the files from `ctx/skills/` into its prompt/commands directory. They're plain markdown — no transformation needed.

**Re-run the sync after pulling upstream changes**, so your harness's copy tracks the repo.

**Edit skills in `ctx/skills/`, never the installed copy.** With a symlinking harness you'd be editing the original by accident; with a copying one your change is silently overwritten on the next sync.

## Layout

Skills are grouped by area: `engineering/`, `productivity/`, `misc/`, `personal/`, and `usr/` for your own. `ctx/skills/usr/` is gitignored in the template but picked up by `sync.sh` automatically — to track your own skills in a fork, edit `ctx/skills/.gitignore`. That's the one file likely to conflict when you pull template updates; resolve it in favour of your fork.

## What ships

From [mattpocock/skills](https://github.com/mattpocock/skills) by [Matt Pocock](https://github.com/mattpocock), reproduced here for harness-agnostic portability.

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
| `publish` | Project `publish: true` notes into the public site ([`publishing.md`](publishing.md)) |

## Companion files

Several engineering skills (`diagnosing-bugs`, `tdd`, `domain-modeling`, `codebase-design`, `triage`, `improve-codebase-architecture`, `writing-great-skills`) reference companion files — `CONTEXT.md`, `docs/adr/` — that **don't exist in this repo and aren't meant to**. They're per-project artifacts created by `/setup-matt-pocock-skills` when you run it inside a target repo under the repos dir. A missing companion file in braindance itself is not a bug.
