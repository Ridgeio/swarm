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
