# Self-improvement loop — auto-research for the swarm itself

Intent (Tom, 2026-07-16): the swarm should improve its own orchestration the
way a research lab improves a model — an empirical loop in the spirit of
Karpathy's auto-research framing: **hypothesize → experiment → measure →
merge only what beats baseline**, with everything written down. Not vibes,
not one-off cleanups: a standing, instrumented practice.

## The loop

1. **Observe.** Run `swarm stats [--hours N]` (the built-in instrument) and
   the lead's qualitative review (docs/orchestration.md → "Periodic
   optimization review"). Collect: message volume, direct/broadcast split,
   estimated recipient reads, ack ratio, per-agent traffic, busiest pairs —
   plus program-side signals (gate latency, rework rate, blocked time).
2. **Hypothesize.** Write a falsifiable claim in the experiment log
   (docs/experiments.md): "X change will move metric M from A toward B
   without hurting guard metric G." Sources of hypotheses: the anti-patterns
   table, the CLI backlog in docs/orchestration.md, and anything that felt
   expensive during operation.
3. **Experiment.** Change ONE variable — a protocol rule, an org edge, or a
   CLI feature — scoped and reversible. Record the start time so `stats`
   windows can bracket it.
4. **Measure.** Compare the metric windows before/after (same duration,
   comparable program phase — a merge-heavy afternoon is not a design
   morning). Honest nulls are results; write them down.
5. **Merge or revert.** Wins graduate: protocol wins go into
   docs/orchestration.md, tool wins become swarm CLI features (normal PR
   gate). Losses revert and the log says why. Patterns that survive two
   different programs graduate from discipline to code.

## Instruments

- `swarm stats [--hours N]` — messaging metrics from the messages table
  (src/stats.ts). Cheap enough to run at every review.
- `docs/experiments.md` — the lab notebook. Append-only in spirit: never
  rewrite a completed experiment's record.
- Program-side metrics (gate latency, rework, blocked time) are read from
  the day's PR/message history by the lead until they earn automation.

## Ground rules

- **One variable at a time.** A bundled change that helps can't tell you
  which part helped, and a bundled change that hurts can't be partially
  reverted.
- **Guard metrics are mandatory.** Every efficiency hypothesis names the
  quality metric it must NOT hurt (e.g. "fewer messages" guarded by "no gate
  waits on information that existed but wasn't sent"). Token savings that
  cost a missed defect are a loss.
- **Broadcasts are not the enemy.** The org broadcast that fixed the noise
  cost 13 reads and was worth 10× that. The metric to optimize is
  information-per-read, not messages-sent.
- **The loop applies to itself.** If the review cadence or this process
  wastes more than it saves, that is itself a finding — log it and change
  the process.
