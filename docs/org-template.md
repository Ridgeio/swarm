# Org template — roles, gates, and messaging rules for a swarm program

Versioned successor to the machine-local `~/.swarm/briefs/swarm-org.md` (2026-07-16), which bound a specific 13-agent roster that no longer exists. Doctrine lives here, in the repo, roster-free: **the live roster is runtime state (`swarm members`), not doctrine.** A program instantiates this template by naming who holds each role in its kickoff message and (once the task ledger lands) on the program task.

Rules here are the prompt-space layer. Wherever a rule has a code enforcement (marked ⚙), the code is authoritative; the prose is explanation.

## Roles

- **Owner (human).** The only merge-to-main, prod, and spend authority. Everything below exists to spend the owner's attention well: approvals upstream (plans/specs), decisions surfaced with evidence, alerts only when a decision is needed.
- **Lead.** Merge-gate operator, prod gates, final arbitration, owner interface. NOTHING else routes here. Fable-class per routing table. As the first agent to join, open BOTH fleet boards so the operator has a window into the swarm from turn one: `swarm board --tab` (live text board split beside the current surface) AND `swarm board --graph --open` (the served HTML board — graph, timeline, task drilldowns). Keep both running for the program's duration; the text board alone is not compliant.
- **PM / routing hub.** Plan of record, scope calls, work-package coordination, first-line arbitration. Absorbs status; emits event-triggered digests to the lead. Plan upkeep routes to Gemini-class; digest assembly is CLI work, not model work.
- **Builders (1 lane each, 4–6 max).** One writer per repo-area — writes are single-threaded per lane; contracts frozen between lanes before parallel start. Model per routing table by lane type.
- **Reviewers.** Fresh-context, different model family than the lane's author (⚙ aspiration: enforced at MERGE-REQ validation once sender auth lands). Evidence required: file/line, counterexample, or failing test — "looks good" is not a review.
- **QA.** Readiness checklists, verification, incident root-cause. Evidence-first triage: Sentry/logs before hypotheses.
- **Auditor.** Independent gate function OUTSIDE the hierarchy; verdicts to the PR author + lead only; takes direction from no one on verdicts.
- **Janitor.** Not a role — a deterministic tick (⚙ WI-5). Agents never do cleanup-by-vibes; they file findings.

## Fleet layout in cmux

Containers carry meaning — don't create them casually:

- **One workspace per program.** Named (never anonymous), created by the Lead at kickoff; the program's agents, board, and drilldowns all live in it. A new workspace means a new CONTEXT (another program, a separate repo cluster) — never a side effect of "show something."
- **Swarmmates join as tabs** (new surfaces) in the program workspace — switching to the workspace shows the whole fleet.
- **Seeing two+ things at once = a tiled split in the current workspace**, not a new workspace: the board beside your work, watching another agent, comparing outputs. 2–3 panes max; past that, tabs. (`swarm board --tab` splits beside you by default; `--own-workspace` is for the program-workspace setup.)
- **Spawned workers run permission-dialog-free by default** (`--dangerously-skip-permissions` / `--yolo` / `--always-approve` per CLI — an unattended agent cannot click "allow", so dialogs are stalls, not safeguards, on this trusted machine). `swarm spawn --interactive-permissions` opts back in for supervised sessions.
- **Model tier is an explicit choice, never an inheritance.** `swarm spawn --agent claude` launches **opus** — the frontier tier (Fable) requires an explicit `--model`, and is normally reserved for the Lead seat. Family satisfies the inversion gate; tier is a cost decision.

### Visible vs headless — the decision rule

**Ownership is visible; execution may be headless.** Every task's owner is a visible cmux tab the operator can watch and interrupt — that never changes. Whether the owner does the work in-tab or dispatches it matters less than whether the work can be seen and steered:

Dispatch **headless** (`codex exec`, a workflow, `join --headless`) when ALL of these hold:
- the job is fully specified upfront (a written spec/prompt — no judgment calls expected mid-flight),
- it is bounded (ends on its own, roughly ≤30 min),
- it produces an artifact (diff, report, verdict file) that outlives the process,
- its dispatch is **recorded on the owning task** (`swarm run <slug> -- <cmd>` so the command, exit, and log land in the ledger and on the board).

Spawn a **visible tab** (`swarm spawn`) when ANY of these hold:
- the work is open-ended or needs judgment/steering as it unfolds (most authoring),
- it will hold a task lease or converse on the bus,
- it runs long or the operator will plausibly want to watch or interrupt it,
- a headless attempt at the same job already failed once (don't loop invisibly).

A headless child never owns a task, never joins the bus as a peer, and never respawns itself — its visible owner answers for its output. Silent headless failures are the failure mode this rule exists to prevent: no ledger record, no board presence → it didn't happen.

## Fleet size

1 PM + 4–6 builders, hard cap, regardless of available subscriptions. Concurrency is bounded by independent work packages and by the owner's review bandwidth — surplus agents become coordination load (field: 259 msgs/6h into the PM at 13 agents). Scaling up requires the plan to name the independent lanes first.

## The gates

- **Merge gate:** PR → green CI → cross-family review → Auditor where warranted → exact-SHA MERGE-REQ to lead → lead merges. No self-merge, no exceptions for small fixes.
- **MERGE-REQ format** (send ONLY when every clause is already true):
  `MERGE-REQ #<PR> @<exact-sha> — CI green (run <id>), review PASS @<same-sha>, mergeable clean.`
- **Prod gate:** migrations, env, promotions, data mutations — lead executes, owner-visible.
- **Task gate (⚙ WI-3, T1):** `swarm task close` refuses while unpushed/dirty/untracked work exists, and refuses evidence that doesn't match the task's claim kind; every close states its evidence ceiling (`--not-established`). A completion claim without its artifact is an ack, not a fact.
- **Handoff gate:** asynchronous ownership changes use `swarm handoff offer` → named-recipient `accept`. The source keeps the fenced lease until acceptance of the exact charter digest and source epoch. Expiry dead-letters the offer; it never guesses that a push meant pickup. The legacy immediate form is compatibility-only.
- **Grant gate (⚙ T2):** closing as *merged* and any `--override` require a live, expiring grant (`swarm grant create --op merge|override --resource <task|branch> --ttl <t>`); every use is audited. Approvals are records with scope and expiry, not chat memories. Request one with `swarm escalate <task>` — the packet carries the state, evidence, and the one question, so the operator decides without reconstructing your trajectory.

## Messaging rules (the bus is small — P4)

1. **Status goes to the ledger, not the bus.** `swarm task checkpoint` / `swarm decision` — the PM and lead read state on demand. One message per program EVENT (contract agreed, PR open, gate passed, blocker), not per activity.
2. **Direct send to the single agent who owns the next action.** Multi-send for 2–4 recipients. Broadcast: lead/PM only, and only for content that changes most agents' behavior.
3. **No acks as messages.** Delivery state is transport metadata (⚙ WI-2 `swarm ack`). Acknowledge exact IDs only; `ack --all` is refused because it can erase an unseen STOP, gate, question, or handoff. Assignment acceptance is `swarm handoff accept`, not chat.
4. **No receipt-check chatter.** For a required pickup, use a handoff offer with a deadline and inspect `swarm handoff status`; expiry is the deterministic dead letter. For non-handoff replies, `swarm inbox --recent N` first and escalate only when the required response is overdue.
5. **Supersede, don't correct-by-append** (⚙ WI-1): a corrected SHA/order replaces the stale message via `--supersedes`; never leave both live.
6. **Messages carry pointers, not content.** Specs, checkpoints, handoffs live in files; the message says what changed, where it lives, what the recipient must do.
7. **Terminal reads are context, never decisions.** A decision exists when its owner sends it (or journals it via `swarm decision`).
8. **Escalation ladder:** blocked >30 min → PM. Needs spend/prod/owner → lead. Emergencies → lead immediately, any format.
9. **Zombie protocol** (orchestration.md): detect via progress-evidence, quiet-zone the agent, `swarm rescue` the work (⚙ WI-4), reassign on a named clock. Nudging a looped agent makes it worse.

## Onboarding a new agent (mid-program)

New joiners see NO historical broadcasts (⚙ WI-1 fence). Their orientation is: this file + docs/philosophy.md + the routing table + their spawn packet (assignment message with task slug, objective, acceptance tests, contracts, do-not-repeat list — composed by the assigner from the task ledger, ⚙ WI-3 handoff for successions). If a joiner needs history, `--recent` exists — deliberately, as archaeology, not as doctrine.

## Program lifecycle

Declare phases explicitly (exploration vs squeeze — orchestration.md). At every phase boundary: quota bands recorded (model-routing.md), experiments measured (experiments.md due-dates), janitor debris counters reviewed, this template's fit reviewed. Programs end with a retro that prunes negative-ROI roles/models and promotes proven lessons into doctrine through the owner's review — never auto-written.
