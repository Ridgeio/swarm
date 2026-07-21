# Doc routing — load by unresolved decision, not by topic

Rule (from the harness-engineering review): **an agent loads one doc per unresolved decision, none by default.** The hook and `swarm help --agent` give you operational state and commands; these docs exist for the moment a *decision* is open. Find your decision, load exactly that section.

| Unresolved decision | Load |
| --- | --- |
| Who may merge / touch prod / spend? | org-template.md §The gates |
| Should this be a message or a file/ledger write? | philosophy.md §P4 |
| Which model/agent for this work? Quota tight? | model-routing.md (table + quota bands) |
| How do I split work across agents? | org-template.md §Fleet size + orchestration.md §task shapes |
| Is this task done? What evidence do I need? | design/SWARM-NEXT-V2.md §T1 (claim-typed close) |
| I need an approval / am blocked on a human decision | design/SWARM-NEXT-V2.md §T2 (`swarm escalate`, grants) |
| An agent died / work is stranded | orchestration.md §zombie protocol + `swarm rescue` (README) |
| Should I add a new standing rule/check? | philosophy.md §P5 (enforcement ladder) + controls.md (register it with a retest date) |
| A recurring correction keeps happening | runbooks in `swarm harness-review` + feedback doctrine in philosophy.md §P5 |
| The CLI/model version changed | runbooks/requalify-worker.md |
| Is this experiment/tuning change justified? | experiments.md (template + subtraction class) |
| How do I onboard / what commands exist? | `swarm help --agent` first; org-template.md §Onboarding second |

Everything else (history, design rationale, research provenance) lives in docs/design/ — read it when *changing the system*, never as task context.
