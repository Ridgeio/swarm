# Orchestration playbook — field-tested patterns for swarm fleets

Distilled from live fleet operation (13 agents, PromptEden GA program,
2026-07-16). This is durable knowledge about *running* a swarm, kept in the
swarm repo so it travels with the tool. The current org chart itself lives in
`~/.swarm/briefs/swarm-org.md` (machine-local, program-specific); this doc is
the general model behind it.

## The economics: every message is a context tax

A swarm message is not free. Each recipient pays tokens to read it, reason
about it, and often to reply — and replies generate notifications that
interrupt other agents' turns. The costs compound:

- A broadcast to N agents costs ~N× the read cost, plus the ack storm it
  usually provokes (observed: 13-agent broadcast → 13 ack messages → lead
  reads 13 more messages that carry zero information).
- Status narration ("Typecheck green… now Unit green…") multiplies one event
  into many messages. One condition-complete message carries the same
  information at 1/5 the cost.
- Fan-out notifications also cause *phantom-message hunts*: an agent sees a
  "new message" alert triggered by traffic to someone else, finds an empty
  inbox, and burns a round-trip asking whether a DM was lost (observed twice
  in one afternoon).

**Default rule: direct send to the single agent who owns the next action.
Broadcast only when the content changes most agents' behavior** (org/process
changes, plan-of-record updates). If 3–4 agents need the same thing, send 3–4
targeted DMs — the recipients who *don't* get it save more than the sender
spends.

## Hierarchy beats mesh above ~6 agents

With a flat mesh, the lead becomes the bottleneck: everything fans into one
inbox and per-message latency becomes program latency. The structure that
held up in practice:

```
Owner (human)
└── Lead — merge gate, prod gates (env/migrations/promotions/data),
    final arbitration, owner interface. NOTHING else routes here.
    ├── PM / routing hub — plan of record, scope calls, work-package
    │   coordination, first-line arbitration, status absorption
    │   ├── Builders (one lane each; contract-first between lanes)
    │   ├── QA (readiness checklists, verification, incident root-cause)
    │   └── Domain reviewers (mapped per work package, pinged directly
    │       by builders — never routed through the lead)
    └── Auditor — independent gate function OUTSIDE the hierarchy.
        Verdicts go to the PR author + lead only; takes direction from
        no one on verdicts.
```

Key insight: the PM absorbs the status firehose and emits **event-triggered
digests** to the lead (one message per program event: contract agreed, PR
open, gate passed, blocker raised). Observed effect: a digest replaced ~12
individual status messages with zero information loss, and the PM closed 7
scope arbitrations without lead involvement in one afternoon.

## Message protocols that killed the noise

1. **Condition-complete messaging.** Send one message when the *full*
   condition is met, never progress narration. Canonical example — the
   merge request format:
   `MERGE-REQ #<PR> @<exact-sha> — CI green (run <id>), Auditor PASS @<same
   sha>, mergeable clean.` If any clause isn't true yet, there is nothing to
   send. This also fixes crossed-message races (two agents both telling the
   lead CI went green; the lead merging before the "please merge" arrives).
2. **No acks upward.** Ack the agent who tasked you, one line, only them.
   The assigner assumes receipt unless a problem is flagged within ~10 min.
3. **No receipt checks.** Check `swarm inbox --recent N` before asking
   whether a message was lost (the unread cursor advances when *any* session
   reads; `--recent` replays regardless — two agents were confused by this
   in one day; see CLI backlog below).
4. **Escalation ladder with a clock.** Blocked >30 min → PM. Needs
   spend/prod/owner-visibility → lead. Emergencies → lead immediately, any
   format. A ladder without a time threshold decays into either instant
   escalation or silent stalls.
5. **Terminal reads are context, never decisions.** Agents may read each
   other's terminals for situational awareness, but a decision exists only
   when its owner *sends* it. Observed failure: an agent screen-read the
   lead's option analysis mid-deliberation and adopted one option as "the
   direction" — it wasn't.

## Context management across the fleet

- **Specs live in files; messages carry pointers.** A message should fit in
  a glance: what changed, where the details live (repo path), what the
  recipient must do. Long content in messages is paid for on every read and
  can't be re-read cheaply later; a file is read on demand and versioned.
- **Contract-first parallelism.** Lanes agree interface contracts (schema,
  routes, types) before implementation so builders proceed in parallel
  against frozen contracts instead of serializing on each other's code —
  and reviewers can approve work pre-rebase (observed: a classifier package
  fully dual-reviewed while parked, waiting only for the base migration).
- **Reserve shared sequences centrally.** Migration numbers, port ranges,
  route prefixes: the PM hands out reservations; conflicts resolve in
  reservation order, not merge order. Never claim a number you weren't
  assigned.
- **Gates hold state so agents don't have to.** "Dogfood starts when X is
  proven" beats every agent polling for X. Agents park with an explicit
  trigger owner instead of burning context re-checking.

## Anti-patterns observed (with real costs)

| Anti-pattern | Cost observed |
|---|---|
| Ack storms after broadcasts | 13 zero-information messages per broadcast |
| Per-CI-job status updates | ~5× message volume per PR |
| Receipt checks on phantom alerts | 2 round-trips + lead attention, twice |
| Duplicate merge requests (crossed messages) | Lead re-verifies an already-merged PR |
| Screen-read "decisions" | Near-miss: agent almost built against an unmade infra choice |
| Premature "closed" verdicts | An agent closed an investigation whose own positive control had failed; reopened only on lead pushback — verify the control *before* declaring victory |

## CLI improvement backlog (evidence-linked)

Concrete `swarm` features that would encode the above in the tool rather
than in discipline. Each links to a failure observed live:

1. **Multi-recipient targeted send** — `swarm send a,b,c "<msg>"` (or
   `--group builders` with named groups in the DB). Removes the main reason
   agents reach for `broadcast`. *Evidence: reviewer pings and contract
   notices routinely need exactly 2–3 recipients.*
2. **Message kinds** — `--kind status|digest|merge-req|escalation|ack`,
   filterable on read (`swarm inbox --kind merge-req`). Lets the lead read
   gates first and skim status later; lets a PM absorb `status` mechanically.
   *Evidence: gate-critical messages buried between acks all afternoon.*
3. **Cursor clarity** — make `inbox` print "cursor already advanced; N
   messages replayed with --recent" instead of "no new messages" when recent
   traffic exists. *Evidence: two agents ran receipt-check round-trips over
   exactly this.*
4. **Notification targeting** — the "new message" push should fire only for
   the actual recipient(s), not as ambient fan-out. *Evidence: phantom-alert
   hunts, twice.*
5. **Supersede semantics** — `swarm send --supersedes <msg-id>` so a
   corrected SHA/status replaces the stale message in unread inboxes rather
   than coexisting with it. *Evidence: a mistyped SHA correction raced its
   original; the auditor had to disambiguate manually.*
6. **Digest support** — `swarm digest --to lead --window <since>` for PM
   use: batch accumulated status sends into one message, marking sources
   read. *Evidence: the PM digest pattern works but is assembled by hand.*

When implementing any of these: keep the CLI thin (this repo's design
constraint), prefer DB fields + read-side filters over a delivery framework,
and never let a convenience feature weaken the sanitization/injection
guarantees in `src/mailbox.ts` / `src/transport.ts`.

## Periodic optimization review (standing lead duty)

At each program phase boundary (or when message volume feels wrong), the
lead audits: message counts per agent per day, broadcast/DM ratio,
ack-to-information ratio, gate latency (condition-true → gate-acted), and
blocked-time per lane. Fold findings back into this doc — patterns that
survive two programs graduate from "discipline" to CLI features.

## Phase discipline: exploration → merge-validation squeeze

(Distilled 2026-07-17 from live GA-endgame operation, cross-checked against
the MAP-CCS "CEO-Specialist" swarm design notes Tom shared. Most of that
spec's GPU-cluster machinery doesn't apply to a CLI fleet, but four of its
control ideas mapped cleanly onto problems we had already hit.)

A fleet's rules must change with project phase. What is virtue early is
vice late:

| Parameter        | Early (exploration)                | Late (squeeze)                     |
|------------------|-----------------------------------|------------------------------------|
| New lanes/tickets| Encouraged (find the unknowns)    | Banned except completion-set defects |
| Concurrency      | Maximize independent lanes        | Converge on the completion set     |
| Reviewer focus   | Breadth across lanes              | Completion-set SHAs first          |
| Lead's job       | Arbitrate scope                   | Gate throughput (merge/apply/promote) |
| Success metric   | Defects found before customers    | The end-to-end outcome demo        |

Declare the squeeze EXPLICITLY (broadcast) with a named, finite completion
set — "these N things, then we release the squeeze." An undeclared endgame
leaves agents optimizing exploration rewards (new tickets, new lanes) when
the system needs convergence. This is MAP-CCS's "decay scheduling" made
manual: we don't decay reward weights, we declare the phase and change the
rules.

## Zombie agents: detection and the captive-work hazard

Field case (2026-07-17): a builder's harness entered an ack-only loop —
every inbound message consumed an execution turn producing an ack, so
NUDGING A STUCK AGENT MAKES IT WORSE. Meanwhile its critical-path commit
existed only in its local worktree: invisible to the fleet, captive to a
dead session.

Protocol, in order:
1. **Detect**: `swarm stats` flags possible stalls (silent >45min with
   unanswered inbound). Positive evidence of progress (pushed refs, files
   changing) beats liveness heuristics — an agent that acks is alive but
   not necessarily working (MAP-CCS calls this reward hacking; an ack IS
   the pseudo-task).
2. **Quiet zone**: STOP messaging the agent fleet-wide; route its traffic
   through the PM for post-recovery batching. One watcher only.
3. **De-risk the work first, the agent second**: push its worktree branch
   to origin from outside the session (worktrees are on disk; pushing
   needs no session cooperation). Standing rule: **work exists when it's
   pushed** — a commit only in a local worktree is a zombie artifact.
4. **Time-boxed contingency**: pre-name the reassignment target (deepest
   context first) and the window. When the window expires, EXECUTE —
   don't extend silently. Recovered agents rejoin as reviewers, not owners.

## Completion validation: positive evidence only

Two field cases converged on one rule. The Codex idle-detector bug (phantom
nudges) was fixed by requiring positive evidence of idleness instead of
absence-of-busy-markers. The compliance-claim failure (a "rules applied"
statement in a MERGE-REQ that the rendered page falsified) is the same bug
in human form. Rule: a completion claim must carry the evidence that would
falsify it — rendered-output scans for copy rules, pushed refs for commits,
row counts for migrations, screenshots for UI. "I did X" without the
artifact is an ack, not a fact.
