# Model routing — task type → model, benchmark-grounded

Tom's rule (2026-07-17): route each task to the right model type. There is a
cost-benefit tradeoff, but the default bias is **best possible output**; cheap
models are for mechanical work, not for anything customers see or that gates
production.

## Evidence sources, in order of authority

1. **Field bench** — our own task outcomes (e.g. the fable-subagent bench;
   this sprint's per-lane performance). Outcome-based beats preference-based.
2. **Arena.ai leaderboards** — refreshed periodically (see cadence below).
   Treat with calibrated skepticism (Tom, 2026-07-17: "not sure how much
   they're to be trusted, but worth considering"): preference-vote Elo
   measures what raters LIKE, not task success — it is style-biased,
   gameable by labs tuning for votes, and blind to harness/duration effects
   that dominate real agent work. A wide ±CI means unstable rank (young
   model). Arena is a tiebreaker and a drift detector, never a decider
   against field results.
3. **Cost/harness fit** — a model's CLI harness matters as much as the model
   (repo tooling, session durability, rate-limit exposure).

## Current routing table (Arena snapshot 2026-07-16; field notes 2026-07-17)

| Task type | Route to | Grounding |
|---|---|---|
| Lead / PM / arbitration / synthesis | claude (Fable-class) | Arena creative #1, coding #2; judgment-heavy work needs the strongest generalist |
| Hard engineering execution (spine, migrations, security surfaces) | codex (gpt-5.6-sol xhigh) | Field bench: primary executor, sustained multi-hour lanes; Arena coding #14 UNDERSTATES field results — outcome evidence wins |
| Design / creative / brand / copy drafting | kimi-k3 (opencode) | Arena creative #6 (1479±27) at a fraction of Fable cost; field: delivered identity gate 3 days early. Copy FINAL PASS still reviewed by claude-class (Fable #1 creative) |
| QA / watchdog / checklist execution / smoke | grok | Field: excellent at bounded evidence-first probes (BL-5 discipline); Arena coding #22 — do not route build work here |
| Mechanical sweeps (renames, inventories, log greps) | cheapest available harness | Output quality ceiling irrelevant |
| Copy/messaging FINAL review (customer-facing) | claude (Fable-class) | Arena creative #1; also the lead's gate anyway |

Notes:
- kimi-k3's ±27 CI is wide (new model) — recheck rank next refresh; its
  OpenRouter capacity is currently saturated at peak (429 storms): keep the
  k2.7-code fallback configured and expect throughput dips.
- grok absent from Arena creative top-12 and coding #22: never route
  customer-facing prose or spine code to grok lanes.
- Arena coding shows claude-class dominating 1–7; we still route bulk
  engineering to codex harnesses on cost + field-outcome grounds. If field
  quality ever dips, this is the first table row to revisit.

## Update cadence

- Refresh Arena snapshots (creative-writing + coding) at each phase boundary
  or ~weekly during active sprints, whichever comes first — same rhythm as
  the periodic orchestration review (docs/orchestration.md). Log material
  rank changes in docs/experiments.md and update the table.
- New fleet member provisioning MUST consult this table first (charter rule
  for the lead + PMs).
