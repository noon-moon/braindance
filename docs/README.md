# The braindance manual

Explanation and reference, written to be read by a person. Agents read the same files — [`CLAUDE.md`](../CLAUDE.md) and [`AGENTS.md`](../AGENTS.md) hold the *directives* and point here for the *why*, so nothing is written twice.

Onboarding — cloning, wiring your shell, switching contexts — is in the [root README](../README.md).

| Doc | What it covers |
|---|---|
| [`instances.md`](instances.md) | Contexts in full: the registry, the resolution ladder, `configure`, `bd use`/`where`, the guard hooks |
| [`vault.md`](vault.md) | What braindance requires of a vault (and what it doesn't), search triage, `_ephemeral` scratch, daily notes |
| [`skills.md`](skills.md) | Installing skills into a harness, keeping them synced, what ships |
| [`worktrees.md`](worktrees.md) | Parallel agent sessions: the R1–R7 discipline, the `bd` workflow, landing |
| [`orchestration.md`](orchestration.md) | Delegation doctrine (O1–O9). The one file here written *at* agents rather than about the system |
| [`serving.md`](serving.md) | The admin app: the container model, `/srv/.env`, deploy, the capture pipeline |
| [`publishing.md`](publishing.md) | Projecting `publish: true` notes onto a public site, and the privacy gates |

Instance-specific planning docs live outside this directory in `ctx/` — e.g. `ctx/vps-setup.md`, one deployment's checklist rather than template documentation.
