# Model routing — role × model × fallback, quota-aware

Supersedes the 2026-07-17 table. Grounding order unchanged: (1) field bench — our own task outcomes; (2) published benchmarks/research with calibrated skepticism (Arena is a tiebreaker and drift detector, never a decider against field results); (3) cost/harness fit. New in this revision (2026-07-19, from the cross-model research panel + field events): Gemini joins the roster, every lane pre-declares a fallback order, quota is tracked as capacity bands, and cross-family review is a RULE, not a preference.

## Standing rules

**Active review-capacity override — 2026-07-30.** Claude review capacity is
red/exhausted for the current program. New adversarial/model-inversion gates
use two fresh exact-head packets: xAI/Grok plus AGY/Gemini High. Do not launch
Claude for these reviews and do not reuse a verdict from an earlier SHA. If
the author is xAI, the Grok packet is same-family advisory and the independent
Gemini packet is the binding inversion gate. This override remains until a
phase-boundary quota note explicitly lifts it.

1. **Route by default; ensemble by exception.** Panels (alloy) are for decision gates only: architecture approval, security review, release review, contested root-cause. For throughput work, one well-routed model. (Evidence: routing retains ~95% of frontier quality at a fraction of frontier calls — RouteLLM; ensembles add ~two effective votes regardless of panel size — "Nine Judges" 2026; tests out-verify judges — CodeT.)
2. **Planning/execution split.** Frontier plans and reviews; cheaper executes against the frozen plan. (Aider architect/editor: SOTA at 14× lower cost; Claude Code opusplan.)
3. **Model inversion (enforced).** The reviewer of gate-critical work must be a different model family than the author — routed mechanically by `swarm review <slug>` (refuses same-family; audited override only). Evidence beyond the ICML correlated-errors result: Greptile's model-inversion study (500 PRs/model, 2026) found cross-model review beat same-model in BOTH directions — Claude-authored: GPT 62.0% recall vs Opus 53.7%; Codex-authored: Opus 60.0% vs GPT 50.5% — because "the types of bugs a model introduces most often are the same types it's more likely to miss during review." Review briefs carry the author-family priors: **Claude-authored → hunt missing behavior first** (GPT 69.0% vs Opus 63.3%); **Codex-authored → hunt build breakage first** (Opus 82.4% vs GPT 58.8%). Both families are weak on semantic-intent/error-handling in Codex code (27.4%/22.6%, tied) — TESTS must catch those, not reviewers. Caveat (theirs and ours): experimental; the effect may fade as models converge — the priors table is a controls.md row with a retest date, not eternal truth. Tests remain the gold verifier; inverted review the second layer; Fable judgment the third. (Source: greptile.com/blog/model-inversion.)
4. **Fable turns are the scarcest resource.** Never spend them on absorption: acks, digests, status, sweeps, journals, inventories. Mechanical digesting is a CLI feature, not a model task.
   - **Fable is never a default — always an explicit choice.** `swarm spawn --agent claude` launches **opus**; a Fable worker requires a deliberate `--model` and a reason (normally only the Lead/arbitration seat). Field origin: a reviewer spawn inherited the CLI's default model and silently burned Fable on work where family, not tier, was the requirement (2026-07-22). The same applies to headless side-reviews: never commission a frontier-tier review when a workhorse-tier same-family review satisfies the gate.
5. **Context affinity is paid capital.** Never swap a context-rich agent to a cheaper model mid-lane to save quota — rebuying its context costs more than the savings.
6. **Deterministic code beats any model** for: polling, lease renewal, diffs, schema validation, budget accounting, cleanup inventory. An LLM enumerating worktrees is a bug.

## Routing table

| Role | Primary | Fallback order | Grounding |
|---|---|---|---|
| Lead / arbitration / spec / architecture / final customer-facing copy | Fable-class (Claude) | Codex | Judgment-heavy, low-volume; strongest generalist |
| PM: digest assembly | CLI code (not a model) | — | Mechanical absorption; orchestration backlog graduated |
| PM: plan-of-record upkeep | Gemini | Codex → Fable (arbitration only) | Long-context plan maintenance; preserves Fable quota |
| Builder: spine / migrations / security surfaces | Codex (gpt-5.6-sol, xhigh) | Gemini → Fable (gate-critical only) | Field-proven primary executor; outcome evidence over Arena rank |
| Builder: frontend / marketing surfaces | Gemini (`gemini` CLI — NOT Antigravity; its wrapper is broken as of 2026-07) | Kimi → Codex | Fills roster gap; de-risks Codex cap-outs |
| Design / brand / copy drafting | Kimi K3 (opencode) | Gemini | Field: identity gate 3 days early; keep k2.7 fallback for 429 storms; Fable final pass stands |
| Adversarial reviewer (per PR) | Active override: fresh Grok + AGY/Gemini exact-head packets | Different non-author family when override lifts | Rule 3; fresh context per review, causal attacks, no prior-verdict reuse |
| QA / dogfood / smoke probes | Grok — **ON PROBATION**: 4/4 silent stub-failures in the 2026-07-19 research panels; require a completion-quality check (output length/substance gate) before trusting a Grok lane result | Kimi → Gemini | Prior field record good (BL-5 discipline); harness reliability now in question — field bench beats reputation in BOTH directions |
| Research / context mapping | Gemini | Codex synthesis → Fable reads the distillate | Long-context + search-native |
| Janitor-adjacent ops / sweeps / inventories | Deterministic code; else cheapest with quota headroom | any | Rule 6 |
| Rescue distillation (dead-agent transcript → checkpoint) | Kimi | Gemini | Mechanical summarization; the only LLM step in the rescue path, hence cheapest |

## Quota protocol (capacity bands)

Subscriptions are caps, not meters — the marginal token is free until it isn't, and the failure mode is cap exhaustion starving high-value work, not dollar burn. At every phase boundary (same clock as the periodic review), record each provider's rough remaining headroom as a band:

- **green** — route normally.
- **yellow** (~<40%) — no NEW long builder lanes on this model; in-flight lanes finish (rule 5).
- **red** (~<15%) — context-rich critical work only; new work routes to fallbacks.
- **cooldown** — 429/limit storms; treat as red until two clean checks.

Bands live in the phase-boundary note (and, once the task ledger lands, on the program task's checkpoint). Pre-declared fallback order activates on band change — no mid-sprint improvisation. `swarm stats` per-agent traffic joined against `host_agent` is the burn proxy until real telemetry earns automation.

## Update cadence

Re-verify the table at each phase boundary or ~weekly during active sprints: field outcomes first (merged-PR rate, first-pass acceptance, rework by lane), benchmark drift second. Log material changes in docs/experiments.md. New fleet members are provisioned from this table (charter rule for lead + PM). Any model failing silently (the Grok stub pattern: plausible completion, no substance) gets a probation row here — reputation never overrides a reproduced field failure.
