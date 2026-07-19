# Experiment log — swarm orchestration

Lab notebook for the self-improvement loop (docs/self-improvement.md).
One entry per experiment. Completed entries are never rewritten.

Template:

```
## EXP-NNN — <short name>   [status: proposed | running | merged | reverted | null-result]
- Date opened / closed:
- Hypothesis: <one falsifiable sentence: change X moves metric M from A toward B>
- Guard metric: <the quality signal this must not hurt>
- Change: <exactly what was altered, one variable>
- Baseline: <stats window + numbers before>
- Result: <stats window + numbers after; honest nulls welcome>
- Decision: <merged into orchestration.md / CLI feature / reverted, and why>
```

---

## EXP-001 — Hierarchy + messaging protocol   [status: merged]
- Date opened / closed: 2026-07-16 / 2026-07-16
- Hypothesis: routing status through a PM (digests) and banning
  acks-to-lead / incremental CI updates / receipt checks cuts messages
  reaching the lead by >50% without slowing any gate.
- Guard metric: gate latency (condition-true → lead action) and zero missed
  merge conditions.
- Change: org broadcast of ~/.swarm/briefs/swarm-org.md (hierarchy, MERGE-REQ
  format, digest pattern, escalation ladder). NOTE: predates the discipline —
  this bundled several variables; accepted because the pre-change state was
  untenable, but future experiments change one variable at a time.
- Baseline (qualitative, pre-org afternoon): ~50 messages into the lead in
  ~3h; ack storms after broadcasts (13/13); 2 receipt-check round-trips;
  duplicate merge requests from crossed messages.
- Result: first PM digest replaced ~12 individual status messages; PM closed
  7 arbitrations without lead involvement; merge requests arrived
  condition-complete. Formal before/after `swarm stats` windows not captured
  (instrument didn't exist yet — EXP-002).
- Decision: merged; patterns recorded in docs/orchestration.md.

## EXP-002 — Measurement instrument (`swarm stats`)   [status: merged]
- Date opened / closed: 2026-07-16 / 2026-07-16
- Hypothesis: none (instrumentation, not intervention) — future experiments
  need baseline windows cheaper than hand-counting an inbox.
- Guard metric: n/a; read-only command.
- Change: `swarm stats [--hours N]` — direct/broadcast split, estimated
  recipient reads, ack-like ratio, per-agent traffic, top pairs (src/stats.ts).
- Decision: merged. First live baseline (6h window ending 2026-07-16
  ~22:00Z, spanning the org transition): 751 messages, 747 direct / 4
  broadcast (1%), est. 799 recipient reads, ack-like 164 (22%), avg body
  517 chars. Topology matched the org design: Atlas top receive hub
  (139 recv), busiest pair Foreman→Yulan 43 (merge-gate traffic), heavy
  peer lanes (Usher↔Foreman 45) NOT routed through the lead. Ack ratio
  22% is the first obvious EXP target.

## EXP-003 — (next) candidate hypotheses, unopened
- Message kinds (`--kind`) let the lead batch-read status without missing
  gates → gate-message time-to-action drops; guard: nothing gate-critical
  misfiled. (Needs CLI feature from the backlog first.)
- Notification targeting removes phantom-alert hunts entirely → zero
  receipt-check round-trips; guard: no missed real notifications.

## EXP-001 follow-up measurement (2026-07-16 late evening)
- Window: 6h post-org-adoption (20:48–02:48Z), `swarm stats --hours 6`.
- Ack-like ratio: **22% → 14%** vs the transition-spanning baseline; broadcasts
  3/759 (<1%). Volume steady (~750/6h) — the fleet talks as much, but more of
  it is information.
- Topology fully inverted per design: busiest pairs are now builder→Atlas
  (Foreman→Atlas 47, Ledger→Atlas 41, Usher→Atlas 36); the lead appears in no
  top pair (was #1: Foreman→Yulan 43). Digest absorption is working.
- NEW WATCH ITEM → next hypothesis: Atlas received 259 msgs/6h (2× the top
  builder). PM saturation is now the system's most likely failure point.
  Candidate EXP: deputy PM or per-lane sub-digests when Atlas receive-rate
  exceeds ~50/h sustained. Deputy authorization already exists (Tom).
- Also observed live: provenance challenge worked (Atlas refused to assign an
  unannounced agent until the lead confirmed it) — codify "new agents are
  announced by lead before first assignment" in the org doc next revision.

## EXP-004 — Stall telemetry in `swarm stats`   [status: merged]
- Date opened / closed: 2026-07-17 / 2026-07-17
- Hypothesis: surfacing send-recency + unanswered-inbound per agent detects
  zombie/ack-looped agents before they cost critical-path hours (the Foreman
  ack-loop cost ~1h of 015 time and was noticed by accident).
- Guard metric: false-positive rate low enough that flags stay meaningful
  (threshold 45min; requires unanswered inbound, not mere silence).
- Change: `swarm stats` gains POSSIBLE STALLS section (src/stats.ts;
  all-time send recency + inbound-after-last-send).
- Result: first live run flagged 2 candidates (Herald 58min/8 inbound,
  Rivet 46min/5) — both routed to PM for surface checks. Detection went
  from accidental to systematic. Watch false-positive rate over next days.
- Decision: merged. Companion doctrine in orchestration.md (phase squeeze,
  zombie protocol, positive-evidence completion) from the MAP-CCS review.

## EXP-006 — Broadcast backfill fence + supersession (WI-1)   [status: running]
- Date opened: 2026-07-19. Measure by: first phase boundary of the next PromptEden program.
- Hypothesis: fencing new joiners' cursors and adding --supersedes tombstones
  reduces stale-doctrine incidents (agent acting on an expired order) to zero
  without any joiner missing live doctrine (guard: onboarding gaps reported).
- Change: spec WI-1 (docs/design/SWARM-NEXT-V1.md).
- Baseline: 25 historical broadcasts replayed to each of 2 new joiners on
  2026-07-18 (Sweeper, Broom), several containing expired squeezes/holds.

## EXP-007 — Pull/ack delivery (WI-2)   [status: running]
- Date opened: 2026-07-19. Measure by: next program phase boundary.
- Hypothesis: peek-only hook reads + explicit ack eliminate silent message loss
  (headless consume-on-inject) with re-injection backoff keeping per-turn hook
  context under ~15 lines (guard: no gate-critical message unacked >45 min
  without a visible summary line).
- Change: spec WI-2. New instrument: unacked-age section in swarm stats.

## EXP-008 — Task ledger + checkpoints (WI-3)   [status: running]
- Date opened: 2026-07-19. Measure by: first agent death/replacement in the next program.
- Hypothesis: with task rows, fenced epochs, and phase-boundary checkpoints,
  a dead agent's lane resumes in <10 min of successor time (vs ~1 day of
  forensic cleanup on 2026-07-18), and zero stale-epoch writes land.
- Guard metric: checkpoint overhead stays <2% of session tokens (spot-check).
- Change: spec WI-3.

## EXP-009 — Verified rescue artifacts (WI-4)   [status: running]
- Date opened: 2026-07-19. Measure by: first rescue in anger.
- Hypothesis: swarm rescue preserves 100% of committed+dirty+untracked state
  (test-restore proof) vs the manual 2026-07-18 procedure which preserved
  commits but had no restore verification.
- Change: spec WI-4. Note: bundles alone were proven insufficient (no
  dirty/untracked) — panel correction, codified.

## EXP-010 — Observe-only janitor census (WI-5)   [status: running]
- Date opened: 2026-07-19. Measure by: one week of ticks during the next program.
- Hypothesis: hook-piggyback + launchd ticks produce a continuous debris
  baseline (worktrees, unpushed, temp strays, junk) with zero false-destruction
  risk (nothing destructive is implemented) and <5s tick cost; debris counters
  in hook context change agent behavior (guard: counters trend flat-or-down
  during the program, vs +28 worktrees last program).
- Change: spec WI-5. This baseline gates any future destructive phase.

## EXP-005 — Messaging dividends: multi-send, kinds, cursor clarity   [status: merged]
- Date opened / closed: 2026-07-17 / 2026-07-17
- Hypothesis: at ~640 msgs/3h fleet volume, (a) multi-recipient send removes
  the last legitimate broadcast temptation and PM repeat-sends, (b) kind
  tagging lets gate traffic (--kind merge-req/gate) never drown in status,
  (c) cursor-clarity output kills receipt-check round-trips entirely.
- Guard metric: zero delivery-path regressions (adversarially verified:
  push/notify byte-identical when flags unused).
- Change: swarm send A,B,C; --kind on send/broadcast + inbox --kind filter
  (cursor never advances on filtered reads — enforced in mailbox library);
  empty-inbox output explains the cursor and points at --recent.
- Built via build+adversarial-verify workflow (worktree isolation); SHIP
  verdict, 127/127 tests (16 new), two disclosed LOW findings accepted
  (flag-token stripping matches --interject convention; peek-zero hint line).
- Measure by next review: broadcast count (expect ~0), receipt-check
  round-trips (expect 0), Atlas repeat-send pairs, gate-message latency.
