# Org template — roles, gates, and messaging rules for a swarm program

Versioned successor to the machine-local `~/.swarm/briefs/swarm-org.md` (2026-07-16), which bound a specific 13-agent roster that no longer exists. Doctrine lives here, in the repo, roster-free: **the live roster is runtime state (`swarm members`), not doctrine.** A program instantiates this template by naming who holds each role in its kickoff message and (once the task ledger lands) on the program task.

Rules here are the prompt-space layer. Wherever a rule has a code enforcement (marked ⚙), the code is authoritative; the prose is explanation.

## Roles

- **Owner (human).** The only merge-to-main, prod, and spend authority. Everything below exists to spend the owner's attention well: approvals upstream (plans/specs), decisions surfaced with evidence, alerts only when a decision is needed.
- **Lead.** Merge-gate operator, prod gates, final arbitration, owner interface. NOTHING else routes here. Fable-class per routing table.
- **PM / routing hub.** Plan of record, scope calls, work-package coordination, first-line arbitration. Absorbs status; emits event-triggered digests to the lead. Plan upkeep routes to Gemini-class; digest assembly is CLI work, not model work.
- **Builders (1 lane each, 4–6 max).** One writer per repo-area — writes are single-threaded per lane; contracts frozen between lanes before parallel start. Model per routing table by lane type.
- **Reviewers.** Fresh-context, different model family than the lane's author (⚙ aspiration: enforced at MERGE-REQ validation once sender auth lands). Evidence required: file/line, counterexample, or failing test — "looks good" is not a review.
- **QA.** Readiness checklists, verification, incident root-cause. Evidence-first triage: Sentry/logs before hypotheses.
- **Auditor.** Independent gate function OUTSIDE the hierarchy; verdicts to the PR author + lead only; takes direction from no one on verdicts.
- **Janitor.** Not a role — a deterministic tick (⚙ WI-5). Agents never do cleanup-by-vibes; they file findings.

## Fleet size

1 PM + 4–6 builders, hard cap, regardless of available subscriptions. Concurrency is bounded by independent work packages and by the owner's review bandwidth — surplus agents become coordination load (field: 259 msgs/6h into the PM at 13 agents). Scaling up requires the plan to name the independent lanes first.

## The gates

- **Merge gate:** PR → green CI → cross-family review → Auditor where warranted → exact-SHA MERGE-REQ to lead → lead merges. No self-merge, no exceptions for small fixes.
- **MERGE-REQ format** (send ONLY when every clause is already true):
  `MERGE-REQ #<PR> @<exact-sha> — CI green (run <id>), review PASS @<same-sha>, mergeable clean.`
- **Prod gate:** migrations, env, promotions, data mutations — lead executes, owner-visible.
- **Task gate (⚙ WI-3):** `swarm task close` refuses while unpushed/dirty/untracked work exists. A completion claim without its artifact is an ack, not a fact.

## Messaging rules (the bus is small — P4)

1. **Status goes to the ledger, not the bus.** `swarm task checkpoint` / `swarm decision` — the PM and lead read state on demand. One message per program EVENT (contract agreed, PR open, gate passed, blocker), not per activity.
2. **Direct send to the single agent who owns the next action.** Multi-send for 2–4 recipients. Broadcast: lead/PM only, and only for content that changes most agents' behavior.
3. **No acks as messages.** Delivery state is transport metadata (⚙ WI-2 `swarm ack`). Ack your assigner one line ONLY when assignment acceptance itself is the information.
4. **No receipt checks.** `swarm inbox --recent N` first; escalate only when a REQUIRED response is >30 min overdue.
5. **Supersede, don't correct-by-append** (⚙ WI-1): a corrected SHA/order replaces the stale message via `--supersedes`; never leave both live.
6. **Messages carry pointers, not content.** Specs, checkpoints, handoffs live in files; the message says what changed, where it lives, what the recipient must do.
7. **Terminal reads are context, never decisions.** A decision exists when its owner sends it (or journals it via `swarm decision`).
8. **Escalation ladder:** blocked >30 min → PM. Needs spend/prod/owner → lead. Emergencies → lead immediately, any format.
9. **Zombie protocol** (orchestration.md): detect via progress-evidence, quiet-zone the agent, `swarm rescue` the work (⚙ WI-4), reassign on a named clock. Nudging a looped agent makes it worse.

## Onboarding a new agent (mid-program)

New joiners see NO historical broadcasts (⚙ WI-1 fence). Their orientation is: this file + docs/philosophy.md + the routing table + their spawn packet (assignment message with task slug, objective, acceptance tests, contracts, do-not-repeat list — composed by the assigner from the task ledger, ⚙ WI-3 handoff for successions). If a joiner needs history, `--recent` exists — deliberately, as archaeology, not as doctrine.

## Program lifecycle

Declare phases explicitly (exploration vs squeeze — orchestration.md). At every phase boundary: quota bands recorded (model-routing.md), experiments measured (experiments.md due-dates), janitor debris counters reviewed, this template's fit reviewed. Programs end with a retro that prunes negative-ROI roles/models and promotes proven lessons into doctrine through the owner's review — never auto-written.
