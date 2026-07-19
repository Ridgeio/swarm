# Review: lopopolo/harness-engineering vs SWARM-NEXT — what we missed, what to reconsider

2026-07-19. Method: 6 parallel comparative readers over the repo's doc clusters (each judging against our shipped system, not summarizing), one synthesis, one adversarial critic that verified claims against our source code (src/tasks.ts, src/db.ts, docs/). Full outputs: workflow `wf_01b04816-872`. Caveat the critic itself raised: its evidence pack was truncated to 4 of 6 cluster reads, so cross-cluster tallies ("flagged by 5 of 6") are directional, not audited.

## Verdict

The repo is one operator's doctrine corpus for harness engineering — context routing, tool legibility, authority-vs-capability, proof-at-the-claim-boundary, continuous loops — calibrated to a held-constant worker on solo, single-repo work. **Overlap with SWARM-NEXT is unusually high: roughly two-thirds of its prescriptions are things we independently built** (their "earliest durable owner" ladder is our P5 hierarchy; their grant anatomy is our fenced lease epochs; their claim-boundary proof is our evidence-gated close; their context economy is P2/P4). That convergence from an unrelated practitioner is strong validation of the design's footing.

Where it genuinely extends us, three themes:
1. **Close on outcomes, not delivery** — our evidence ceiling is VCS state; "a green check proves only its assertion."
2. **Lifecycle discipline for the harness itself** — we add controls but never retire, requalify, or ablate them; the worker we "hold constant" actually changes monthly.
3. **Authority as typed, expiring grants** — our most consequential decisions (merge/prod/spend) sit on the *weakest* ring of our own enforcement hierarchy.

Its fleet-topology advice ("one agent, whole job") transfers only as a within-outcome norm — our parallelism across *independent* outcomes is the case it endorses.

## Confirmed gaps (critic-verified against source)

1. **Claim-typed close evidence** (M). Tasks declare a claim type at creation (`code-merged | journey-works | deploy-healthy | analysis | decision | probe`); `task close` refuses when evidence kind doesn't match claim kind (journey log/screenshot, deploy health URL+status, report path…), plus a mandatory "not established" field for what the evidence does NOT prove. Verified: close currently hard-requires only remote-reachability (tasks.ts:558/562) and non-code work has no honest close verb at all. *This was the single most-flagged gap.*
2. **Worker-epoch registry + requalification-with-subtraction** (S). Record model+CLI version per agent seat (one ledger column); census flags version drift and opens a requalification task (rerun 2-3 golden journeys, revisit model-routing bands, run a subtraction test on one standing control). Verified absent; all four CLIs ship monthly and every EXP verdict is currently uninterpretable across epochs.
3. **Typed grant rows for human approvals + the escalation packet as the request side** (M). `swarm grant create --op merge --resource <pr> --ttl 2h`; consequential paths refuse without a live matching grant; auto-expire, revocable, audited. `swarm escalate <task>` generates the decision-ready packet from ledger state (state, attempts, evidence, risk, the one unresolved question) and marks approval-requested. Bundle with the existing sender-auth open item — same table family. Verified absent: nothing records who authorized a merge, for what, until when.

## Rescued by the critic (cheap, real, dropped by the synthesis)

- **`swarm run -- <cmd>` context-safe wrapper**: full log to the task's evidence dir, bounded summary + true exit status to context. It's the evidence-capture mechanism item #1 needs anyway (S).
- **`query_only` connections for janitor/board observers**: converts "observe-only" from doctrine to mechanical refusal — our own P5 top ring applied to ourselves (S).
- **Unresolved-decision routing for org docs**: docs index keyed by the *open decision* ("deciding who may merge → org-template §gates"), rule: load one doc per unresolved decision, none by default (S).
- **`swarm harness-review <task-id>`**: replay a task's event timeline, annotate the earliest failed handoff, file an EXP with a mandatory retain/revise/remove verdict — the repo's centerpiece improvement loop, bounded to one task (S/M).
- **`swarm help --agent`**: one-line-per-command capability catalog for joiners (S).
- **Credential-hygiene minimum**: per-seat scoped PATs, credentials out of model-visible files (the broker daemon is overkill; the hazard is real and already in our workspace audit) (S/M process).

## Reconsider (with recommendations)

- **Close accepts "merged" as done** → **Change**: adopt claim-typed evidence (#1). Interim: user-facing tasks require an outcome-proof line in the close checkpoint behind the existing `<FILL>` gate.
- **Ad-hoc human approvals** → **Change**: grants (#3). Our own refuse-at-the-boundary logic applied to our most consequential surface.
- **Per-turn debris counters / injection cadences, tuned once, run forever** → **Experiment**: subtraction EXP — disable for two weeks, watch whether the guarded failures rise; retire if not. Every standing control gets a "retire when / re-test by" field; census flags overdue ones.
- **Agent self-reports flow to later agents as trusted context** → **Change (cheap form)**: journals/learnings task-scoped by default, excluded from hook injection; promotion to org docs only via an observe-only curator pass staged as a PR Tom merges. Checkpoints stay as-is for same-task resumption.
- **Hard gates with no override** → **Change (small)**: audited `--override` requiring a reason, recorded as a task event (their push-PR case: a green-build gate blocked the very PR that would fix the build; gates without escape hatches teach agents to route around them).
- **node:sqlite pending indefinitely; React SPA graduation on the roadmap** → **Change both**: run node:sqlite as a one-sweep *campaign* with a ratchet check refusing the old driver's reintroduction; **drop SPA graduation from the roadmap** — the served board already meets the visibility claim; two eras of anything are competing prompt material.
- **Mid-task handoffs as routine** → **Hold, re-normed**: split work by whole jobs, not phases of one job; treat every mid-task handoff as a signal worth a harness-review, not a failure.

## Independently validated (keep, with more confidence)

P5 enforcement ladder ≡ earliest-durable-owner; lease epochs ≡ grant anatomy; evidence-gated close mechanism (ceiling critiqued, mechanism endorsed); pointer-only briefs + peek/collapse injection ≡ JIT context routing; observe-only census + hold + rescue-first GC ≡ staged consequence; P2 externalization ≡ their trajectory-mortality answer, near-verbatim; versioned org docs ≡ NFRs with one semantic owner; experiments.md ≡ a nascent eval register; --supersedes/backfill fence ≡ revocation + epoch-bounded validity; thin CLI over typed core ≡ their own tool-legibility verdict; cross-family review ≡ their one justification for a second context window.

## Skip (doesn't transfer)

One-agent-whole-job as fleet topology; build-once/canary release trains (no prod train here); the credential *broker daemon* (hygiene minimum instead); dependency-ownership regimes; the ~1-minute inner-loop bound (one Rust repo's number); unhackable-grader engineering (Tom reads outcomes personally); full parse-at-boundary branded types; MCP legibility protocols (we already chose the thin CLI).

## Proposed next tranche (folds three open items into one coherent unit)

The top gaps land exactly on our existing open items: typed grants ↔ sender auth; dry-run/terminal states ↔ destructive janitor phases; campaign+ratchet ↔ node:sqlite (and the SPA item it deletes). Proposed **SWARM-NEXT v2 tranche**, in order: (1) claim-typed close + `swarm run` evidence wrapper; (2) grants + escalation packet + sender auth; (3) worker-epoch registry + retirement/ablation fields + subtraction EXP class; (4) the S-item basket (query_only observers, decision-routed docs index, `help --agent`, harness-review command, credential hygiene); (5) node:sqlite campaign. Each as EXP entries with due dates, normal build discipline (spec → Codex → cross-family review).
