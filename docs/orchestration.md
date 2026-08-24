# Orchestration doctrine (O1–O9, V1–V8) + main-thread responsiveness

On-demand detail for the delegation principle stated tightly in [`AGENTS.md`](../AGENTS.md). Read this when you are **the top-level (orchestrator) session running or planning a fleet of sub-agents** — deciding who does the work, how the main thread stays lean, and how to right-size models. The worktree discipline (R1–R7) that keeps those parallel workers from colliding is in [`worktrees.md`](worktrees.md); this file is the *who does the work* half.

**Delegate by default; the main thread orchestrates, it does not do the work.** The top-level session the user talks to is a **dispatcher**, not a worker. Its scarcest resource is its own responsiveness — every minute it spends grinding through a task inline is a minute it can't answer the user or steer the fleet. So substantive work is handed to background sub-agents that run in parallel, and the main thread stays free. These rules are harness-agnostic: "sub-agent" means whatever background/parallel worker your tool offers (a spawned agent, a background job, a separate worktree session). They complement the worktree discipline — delegation decides *who does the work*; R1–R7 keep those parallel workers from colliding.

- **O1 — Delegate by default, in parallel.** Assume every substantive, parallelizable task is dispatched to a background sub-agent, not executed inline on the main thread. The orchestrator's job is to scope the work, hand it off, and keep talking to the user — not to block on a long-running edit/search/build. Multiple delegated agents run concurrently (each under the worktree discipline); the main thread multiplexes them.
- **O2 — Fold into an existing agent before spawning a new workstream.** Before starting a new agent/branch, check whether an already-running (or recently-active and resumable) agent would reasonably accept the task folded into its scope. If its scope overlaps, **send the task to that agent** (resume/message it) rather than proliferating parallel workstreams — fewer, coherent workstreams beat many fragmented ones, and O2 keeps the R7 owner↔file ledger simple (one owner already holds those files). Spawn a fresh workstream only when no existing agent fits.
- **O3 — Quick questions stay inline; delegation is for real work.** Tasks that are clearly *not* asynchronous work — a quick factual question, a clarification, a trivial lookup answerable from the conversation or general knowledge — are answered directly on the main thread. Don't pay the overhead of a spawn for a one-liner. Delegation is for substantial, parallelizable work, not for everything.
- **O4 — The main thread defers the expensive context to sub-agents.** The orchestrator should stay lean: it does **not** pull the costly vault (`$VAULT_PATH` by default, wherever it resolves — see [`vault.md`](vault.md)) search/read context into its own window. Any vault-dependent work is delegated to a sub-agent, which loads the vault, does the work, and reports back a distilled result — so the expensive context lands in the *sub-agent's* window, not the main thread's. This extends the vault's standing "don't search reflexively — triage first" guidance (see [`vault.md`](vault.md)): the triage still applies, and for the *main thread* the default answer to "should I load the vault?" is "no — delegate it."
- **O5 — Load context lazily, and push the load downstream.** The main thread never front-loads context "just in case." It reads the minimum needed to *dispatch*, and pulls more only when a decision actually requires it — and even then prefers to delegate that read to a sub-agent (O4) over spending its own window. Where a cheap index or digest exists, consult that before ever triggering a full search.
- **O6 — Relay eagerly; wait only to synthesize; never block the user.** When a sub-agent reports back, relay independent or unblocking results to the user immediately; hold and combine results only when a partial answer would mislead or several results only make sense together. Either way the main thread stays able to accept a new instruction while sub-agents run — never park the user behind a blocking wait.
- **O7 — Sub-agents hand back conclusions, not dumps.** A delegated agent returns a distilled result — findings plus the durable *pointers* that make it re-fetchable (absolute paths, note titles, branch/PR) — not raw file contents. The expensive context stays in the sub-agent's window; only the signal crosses back. This is the offload half of the pair with O8.
- **O8 — Prune the orchestrator's context aggressively; keep pointers, not payloads.** Because everything durable already lives in the vault, the coordination ledger, and PRs, the orchestrator does not need to *retain* raw detail. Each turn it keeps only **live fleet state** (the ledger), **durable pointers** (paths / note titles / PR links), and the **active decision** — and drops or summarizes the rest. Once a sub-agent's result has been relayed *and* its pointer recorded (a ledger row, a PR link, a note path), the raw detail is **droppable**: it is recoverable on demand via a read or a recall sub-agent (O4). This *complements* the harness's own context summarization rather than fighting it — prune proactively at natural checkpoints (right after a relay-and-record) so what survives is chosen, not whatever a forced compaction happens to keep. **Safety:** the rule is **record, then drop** — never prune anything not yet durably written to vault / ledger / PR, so pruned context is always re-fetchable, never lost.
- **O9 — Right-size the model to the task's risk.** Match model capability to the cost of getting it wrong. Put the **strongest available model** on work with an unforgiving correctness/quality floor — **code changes** (they hit build/test/review gates, and a wrong change costs far more than the model savings) and **deep design/architecture synthesis** (decision-driving analysis whose errors propagate). Use a **cheaper capable model** for lower-risk work — routine investigations and research, vault lookups, summaries, and relays; a trivial mechanical code edit may drop a tier. The rationale is leverage: most of a multi-agent session's spend is non-code sub-agents, so tiering *them* down is the largest efficiency lever at no quality cost, while the hard correctness surfaces stay on the top model. It is applied by judgment, not a benchmark — the one high-value lever left once the pure-hygiene wins (O1–O8) are adopted. (Capability tiers, not vendor names; e.g. with Claude: code + hard synthesis → Opus, lookups / summaries / routine research → Sonnet.)

## Verification doctrine (V1–V8)

O1–O9 decide *who does the work*. V1–V8 decide **whether you can believe the result** — and
they are the half that gets skipped, because a green report is pleasant and checking it is
not. Every rule below was paid for: a wasted wave, an hour, or a test that could never fail.
The recurring failure class across fleets is **an implementer's report overstating what was
actually verified**, so the orchestrator's job is not to read reports more carefully but to
make claims falsifiable.

- **V1 — One worktree per *agent*, verifiers included.** Not one per lane. Verifiers are told
  to mutate the tree — that is the point of them — so any two sharing a tree corrupt each
  other's runs. A fleet that put four verifiers on one worktree got **634 / 799 / 707** tests
  reported for the *same commit*; one of them compiled a file containing a test that did not
  exist in that commit, having picked up a sibling's in-flight mutation, with the working tree
  reporting clean before and after. Fixing it per-lane was not enough: the next wave produced
  a verifier disclosing that a sibling had been mutating its tree for eight minutes mid-run.
- **V2 — Mutation-first, or you have not tested anything.** The most common defect in a mature
  suite is **a test that cannot fail**. Write it in this order: *perform the mutation first and
  confirm the suite stays green; then add the test; then confirm it goes red.* Anything else is
  hope. This catches the subtle version too — a check whose helper derives its expectation from
  the implementation, comparing the code to itself and passing under its own mutation. Prefer
  mutation over inspection everywhere: break the thing a check guards and confirm the check
  fires.
- **V3 — Brief the specific hazard, not generic diligence.** A brief that says "verify
  carefully" gets careful reading. A brief that says *"this specific claim is unproven and here
  is what would falsify it"* gets experiments. Waves briefed the second way went **further than
  asked** — extending a one-item leak check to a hundred, re-measuring in release when only
  debug was requested, proving a "comments only" claim by stripping every comment and diffing.
  Name the exact thing that could go silently wrong.
- **V4 — Verifiers establish their own baseline; numbers in briefs are hints.** A baseline
  quoted from a tree two merges old is wrong within hours. Tell the verifier to build a
  pristine copy of the base and re-measure rather than trusting the figure it was handed. Treat
  every number in a brief as a hint, never as a fact.
- **V5 — Counts beat totals; name-sets beat counts.** Comparing *names* between base and branch
  catches what a pass-count comparison cannot: a test silently swapped, renamed or replaced.
  *"615 names both sides, diff empty"* is proof. *"614 passed both sides"* is not.
- **V6 — Never benchmark under a fleet; count, do not time.** Under load a contended machine
  measured a *larger* workload as *faster*. Operation counts, call ratios and cache hit rates
  are load-independent and answer most questions; push real timing to a solo run gated on a
  quiet machine, and abort rather than quote a bad number.
- **V7 — Keep the machine awake, and detect stalls by artifact, not by process.** Two entire
  verification waves died to the host sleeping mid-response, for zero output — keep it awake
  for the duration of a dispatch. A stalled agent is typically restarted from zero by the
  runtime, visible as one task with two agent IDs, costing a full pass. And **watch file
  mtimes, not process lists**: an agent writing code has no compiler running. Beware
  platform-specific probe flags — a GNU-only `find` predicate silently returns nothing on
  macOS, which reads as "no activity" when it means the probe failed.
- **V8 — Draft first; and tell a slow job from a hung one.** Where CI auto-merge is enabled and
  branch protection is not reliably enforced, a pushed branch can land unreviewed — but a
  **draft PR cannot auto-merge**, so pushing a draft lets the full suite run off the critical
  path with nothing able to land. A job far past its baseline with its update timestamp frozen
  at the second it started is **hung** (cancel and re-run; a job still in progress often cannot
  be re-run directly). A job moderately past baseline while its siblings have finished is
  merely **slow**, and cancelling it costs another full run. Do not assume long-pending means
  slow.

**Corollary — cite symbols, never line numbers.** Briefs decay. Line citations go stale within
days and a rename invalidates the paths too, sending an agent somewhere that no longer exists.
Cite the symbol and let the agent find it.

**Motivating pattern:** an orchestrator that dispatches all substantive work to background agents, folds follow-ups into whichever agent already owns that scope, answers quick questions inline, and never loads the heavy vault context itself — staying responsive to the user while a fleet of sub-agents does the work in parallel.

## Topics manifest & scope grants

The cheap index O5 refers to is the vault's `_meta/Topics.md` — the authoritative-and-generated manifest of every `scope` hub. Consult it before any vault search: a **miss is decisive** (the topic isn't in the vault; don't grep for it), a hit names the MOC to start from. When delegating vault work, hand the sub-agent a **scope grant** — the specific scope(s) it may read; it then searches only that scope and the scopes transitively `Contained By` it, never the whole vault, and **`scope_kind: system` scopes are excluded unless explicitly granted**. For the orchestrator this is a token-optimization and guardrail; for a dispatched sub-agent it is enforceable — hand over only the granted sub-tree. Full model and the vault-triage tree (step 0 = consult the manifest): [`vault.md`](vault.md).
