# Philosophy — why the swarm is built this way

This is the durable "why" behind the SWARM-NEXT architecture (docs/design/SWARM-NEXT-V1.md). It exists so that a future maintainer — human or model — changing the system understands which properties are load-bearing and what evidence put them there. The experiments log (docs/experiments.md) tracks whether reality keeps agreeing.

Provenance: distilled 2026-07-19 from a week of live 13-agent fleet operation on PromptEden, the forensic cleanup of what it left behind, and a two-round cross-model research panel (Codex gpt-5.6-sol + an independent Claude instance, repo-blind literature research then repo-grounded gap analysis). Where a claim has a source, it's cited; where it's field experience, it says so.

## The founding failure

The swarm's first self-improvement wave (2026-07-16/17) measurably fixed messaging — ack ratio 22%→14%, topology inverted as designed — and left resource lifecycle untouched. The same week produced ~28 orphaned worktrees, ~129 unpushed commits stranded in them (six on a detached HEAD, one GC sweep from oblivion), immortal dead registrations, and a message archive that replayed weeks of expired orders to every new joiner as live doctrine. The self-improvement process itself left its build worktree behind after merging.

The lesson is not "agents are sloppy." It is: **prompt-space convention decays; only code boundaries and scheduled reconciliation hold under agent death, forgetfulness, and context resets.** Messaging pain is felt every turn, so it got fixed; lifecycle debt is invisible until someone pays a day of archaeology. A long-running system must make the invisible visible (debris counters in every turn's hook context) and make the default safe (nothing persists without a record; nothing is deleted without a verified artifact).

## The five principles

### P1 — Tasks, not agents, are the durable unit

An agent is a process wearing a name. The unit that must survive is the assignment: its objective, lease, decisions, checkpoints, and evidence. These live in SQLite rows and files, not in any context window. A dead agent's open tasks ARE its handoff — succession is a query, not archaeology.

Evidence: this is the workflow/worker split every durable-execution system converged on (Temporal's event-sourced histories survive worker death; Kubernetes leases outlive kubelets). Field: when Foreman's harness entered its ack-loop, its critical-path commit existed only in its worktree — the work was captive to a process. Under P1 that cannot happen: the task row points at the branch, the checkpoint says what's next, and any agent can claim the epoch.

### P2 — Context is externalized continuously, or it never existed

The expensive thing an agent accumulates is not code — it's understanding: which approaches failed, why the design is shaped this way, what the next action is. That understanding dies with the context window unless it is written down as it forms. So: decisions are journaled when made (`swarm decision`), checkpoints are written at phase boundaries (300–600 tokens: state, decisions+why, failed approaches, next action), and handoffs are composed from checkpoints, not from memory. A fresh context reorients in minutes. Killing an agent loses minutes, not a context window of paid tokens.

Evidence: the single most-replicated pattern in production agent systems — Anthropic's long-running-agent harness (progress files + git history as the memory; fresh sessions orient and continue), Manus (filesystem as unlimited context), Amp (retired compaction in favor of structured handoff files), the Ralph pattern (fresh context every loop, state entirely on disk). Panel addendum: a dead agent's raw transcript already persists on disk (harness JSONLs) — the missing pieces were only the index (task → transcript path) and the distillation (checkpoint). We build both; we do not dump transcripts into context.

Cost discipline: checkpoint when expected reconstruction loss exceeds checkpoint cost — phase boundaries yes, per-turn narration never. Per-turn status prose is furnace behavior wearing a safety costume.

### P3 — Authority is fenced, not assumed

Liveness mechanisms (TTL, heartbeat, reap) detect death. They cannot prevent a paused-but-alive agent from waking after its authority lapsed and pushing stale work over its successor's. Authority is therefore an epoch: every task lease carries a monotonically increasing integer; takeover increments it; every correctness-sensitive mutation presents it and is refused when stale. The refusal is logged, not silent.

Evidence: Kleppmann's fencing-token argument (distributed locking without fencing is broken by construction); Kubernetes resourceVersion optimistic concurrency. Field: zombie agents that were alive by every liveness metric — acking, heartbeating — while doing no work. An ack IS a pseudo-task. Liveness must never be inferred from communication; progress is proven by artifacts (commits, checkpoints, test runs), which is also why `task close` demands evidence, not claims.

### P4 — The bus shrinks; files and the ledger carry coordination state

The strongest cross-source research finding, and the one that most changed our direction: successful long-running fleets nearly eliminate agent-to-agent messaging. Anthropic's 16-agent compiler swarm coordinated through git and task-lock files with no message bus at all. Cognition's revised doctrine: writes stay single-threaded; additional agents contribute intelligence (reading, judging), not actions. Berkeley's MAST taxonomy attributes ~37% of multi-agent failures to inter-agent misalignment — more messages create more surface for it. AgentTaxo measured the communication tax directly.

Our first wave made messages cleaner. This wave makes them fewer and structural: status goes to journals (readable on demand, paid for once), acks become delivery metadata (transport state, not LLM turns), polling becomes deterministic watchers, doctrine becomes versioned files served at spawn, and messages carry pointers to files, not content. What remains on the bus is what genuinely needs attention NOW: dispatch, gates, escalations, handoff pointers.

Corollary — parallelism has a shape. Fan out breadth (research, review, migration sweeps, independent lanes against frozen contracts); never parallelize deep sequential design or shared mutable files. Default to one strong agent; a swarm must state its parallelization case. (MAST failure rates 41–87%; equal-compute studies showing single agents beating swarms on sequential reasoning; the field's honest fleet sizes are single digits, bounded by human review bandwidth — the METR RCT stands as the warning that felt productivity and measured productivity diverge.)

### P5 — Enforcement is deterministic; convention is a bug report waiting to happen

Every rule that matters is enforced at a code boundary (CLI refusal, schema constraint, fenced epoch) or mechanically re-injected every turn (hook context). Rules that live only in documents are wishes. The proof is local: this repo's own playbook said "work exists when it's pushed" while 129 commits sat unpushed, and the CI-budget rule that contradicted it won because both were prompt-space and the cheaper one was newer.

Deterministic enforcement has a hierarchy of trust:
1. **Refuse at the boundary** (best): `task close` refuses with unpushed commits; `send --supersedes` refuses non-owners; worktree verbs refuse /private/tmp.
2. **Reconcile on a clock** (census): assume agents and harnesses will create resources out-of-band; enumerate reality, diff against the ledger, hold what's unknown. Never require reporting for the system to know what exists.
3. **Re-inject every turn** (hook): debris counters, unacked-message age, checkpoint staleness, janitor heartbeat. Nobody has to remember to check anything.
4. **Convention** (last resort): acceptable only for what code cannot see, and then written in exactly one versioned place.

And the destruction discipline: observe → hold → rescue (verified artifact: bundle + patches + untracked archive + test-restore) → quarantine → delete. Every step reversible for a window. A janitor that deletes a stranded commit converts hygiene debt into destroyed paid-for work — the one failure mode strictly worse than the mess.

## What we deliberately do not build

- **Vector memory for code.** Grep over files won (Anthropic removed embeddings from Claude Code; Cursor and Devin converged). Files + git + the ledger are the brain.
- **Auto-written doctrine.** Automatic memory accumulation underperforms human-gated curation (Cursor shipped and killed auto-Memories), and memory write-paths are an injection surface (MemGhost). Lessons are journaled freely but promoted to doctrine only through review.
- **Debate loops.** Multi-agent debate fails to beat self-consistency at equal compute; a confident wrong voice drags panels. Cross-model review is bounded: tests are the gold verifier, one fresh-context different-family reviewer is the silver, frontier judgment the bronze.
- **Big fleets.** 1 PM + 4–6 builders. The binding constraint is the human's review bandwidth; agents beyond it produce coordination load, not throughput (observed: 259 messages into the PM in 6 hours at 13 agents).
- **A daemon empire.** One janitor tick, triggered by the hook when the fleet is active and launchd when idle, observe-only until a measured baseline justifies each destructive phase. Everything else is refusal-at-boundary or reconciliation — no supervisors supervising supervisors.
- **Per-token frugality theater.** On subscription plans the marginal token is free until the cap; the real economics are cap-headroom allocation (protect frontier quota for judgment work) and human-minutes per merged PR. Measure cost per merged outcome, not tokens per day.

## Reading list (the load-bearing sources)

- Anthropic, *Effective harnesses for long-running agents* — the progress-file/git pattern P2 is built on.
- Anthropic, *Building a C compiler with 16 parallel Claudes* — file/lock coordination, no bus (P4).
- Cognition, *Don't Build Multi-Agents* and its 2026 revision — single-threaded writes; agents as intelligence, not actions.
- Berkeley, *MAST: Multi-Agent System failure Taxonomy* (arXiv:2503.13657) — failures are organizational-design failures.
- Kleppmann, *How to do distributed locking* — fencing tokens (P3).
- Manus, *Context engineering lessons* — filesystem as context; KV-cache economics.
- METR, *Early-2025 experienced-OSS-developer RCT* — measured vs felt productivity.
- ICML 2025, *Correlated Errors in LLMs* — cross-provider error correlation bounds ensemble gains.
- Aider architect/editor benchmarks; Claude Code `opusplan` — the planning/execution split's cost evidence.
- STALE (arXiv:2605.06527) — implicit supersession fails; it must be explicit metadata (WI-1).
