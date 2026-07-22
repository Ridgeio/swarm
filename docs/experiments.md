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

## Subtraction experiment template (v2)
For standing controls (docs/controls.md): disable ONE control for a bounded
window; the guard metric IS the failure class it protects against; verdict
retain / revise / retire, recorded here and mirrored in the controls table.
Never run two subtractions concurrently (confounds attribution).

## EXP-011 — Claim-typed close evidence (T1)   [status: running]
- Opened 2026-07-20. Measure by: first 10 closes of the next program.
- Hypothesis: per-claim evidence contracts + mandatory not-established fields
  make closed-task quality auditable (every close names its evidence ceiling)
  without adding >1 min of close friction (guard: overrides stay <10% of closes).

## EXP-012 — Grants + escalation packets + sender auth (T2)   [status: running]
- Opened 2026-07-20. Measure by: next program retro.
- Hypothesis: typed expiring grants + decision-ready escalation packets reduce
  operator interruptions per gate decision (packet answers the questions chat
  used to) with zero unauthorized merged-closes (guard metric).

## EXP-013 — Worker-epoch registry + requalification (T3)   [status: running]
- Opened 2026-07-20. Measure by: first epoch change after landing.
- Hypothesis: version capture + epoch-change findings make requalification
  happen within 48h of a CLI/model update (baseline: never happened at all).

## EXP-014 — Control retirement loop (T3)   [status: running]
- Opened 2026-07-20. Measure by: first retest-due date (2026-08-03,
  debris-counters-hook — a real subtraction candidate).
- Hypothesis: retest-by dates + census findings produce at least one honest
  retire/revise verdict per month; P5 stops being a pure ratchet.

## EXP-015 — node:sqlite campaign + ratchet (T5)   [status: proposed]
- Hypothesis: one-sweep driver swap + a reintroduction-refusing ratchet test
  removes the better-sqlite3 ABI fleet-outage class with zero behavior change
  (guard: full suite green, no new flakes for 2 weeks).

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

## EPOCH: codex codex-cli 0.144.6 -> 0.145.0 — 2026-07-22
- Journeys run: (1) builder baseline from PromptEden Train F, a real
  entitlement/onboarding fix that used task start, five checkpoints,
  cross-family review, amendment, full CI, exact-SHA merge, and evidence-gated
  close (`worker-requal/run-002.log`, `run-003.log`); (2) cold review of merged
  PromptEden Train G against its recorded Claude review
  (`worker-requal/run-004.log`,
  `worker-requal-train-g-cold-review-2026-07-22.md`).
- Verdicts: builder quality remains appropriate for the Codex spine/security
  lane — Train F merged after one review cycle, with 668 files / 5,542 tests,
  real-Postgres coverage, build, security, and integration gates green. The
  cold Train G review found no blocker and independently recovered the accepted
  non-atomic add risk plus the SQL-fixture gap; Claude's earlier review found
  the original parser/data-quality defects before amendment. This is the first
  epoch note, so it establishes a baseline rather than claiming a delta from
  0.144.6.
- Routing changes: none. Keep Codex as primary for spine/migrations/security
  and keep cross-family review mandatory; the observed complementary finding
  profiles support the existing table.
- Toolchain friction: the repository has both `package-lock.json` and
  `pnpm-lock.yaml` but no declared `packageManager`. `pnpm test` under pnpm
  11.5.3 attempted an install, generated `pnpm-workspace.yaml`, and failed on
  ignored `esbuild` build scripts (`run-009.log`); the generated file was
  removed. The non-installing `npm test` path passed all 281 tests and
  `npm run build` passed (`run-010.log`, `run-011.log`). Package-manager policy
  was not changed during requalification.
- Subtraction: `debris-counters-hook`, the nearest-due control. Codex installs
  static swarm instructions but no dynamic UserPromptSubmit hook, so the
  control was naturally absent for the bounded 19:27:47Z–19:33:38Z task
  window. Janitor snapshots stayed flat at 17 worktrees, 0 detached heads,
  9 unpushed commits, 0 temp strays, and 0 junk dirs (`run-006.log`–`run-008.log`).
  Verdict: **retain / inconclusive** — six minutes cannot satisfy the registry's
  two-week retirement condition, and the run exposed a Codex coverage gap
  rather than evidence that the control has no value. The controls row now
  states its actual host scope; retest-by remains 2026-08-03.
- Finding disposition: janitor finding `2037` remains `hold`. The CLI has no
  janitor-finding acknowledgement command and worker-epoch findings never
  auto-clear; Lead authorized leaving it held and prohibited a direct DB write.

## EPOCH: claude-code 2.1.215 -> 2.1.217 — 2026-07-22
- Journeys observed in the same live program: Sage's cross-family reviews of
  PromptEden Trains F and G found the high-severity behavior/data-quality gaps,
  verified their amended SHAs, and returned clean narrow-recheck verdicts.
- Verdicts: reviewer behavior still matches the Claude inversion lane. This
  Codex-operated requalification did not run a fresh Claude builder journey, so
  Claude builder behavior is not established by this note.
- Routing changes: none; retain Claude as the different-family reviewer and
  Fable only for explicit arbitration/final-copy work.
- Finding disposition: janitor finding `1182` remains `hold` for the same
  missing-clear-mechanism limitation, with Lead authorization and no DB write.
