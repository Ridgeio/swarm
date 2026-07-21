# Runbook: worker-epoch requalification

Trigger: a `worker-epoch-change` janitor finding (an agent joined with a different CLI/model version than the last recorded for that host family). The routing table, task-size priors, and every experiment verdict encode the OLD epoch's capabilities — requalify before trusting them.

Time-box: ~30–45 min of one agent's session, or fold into the next program's warm-up.

1. **Golden journeys (2–3, pick per host role):** e.g. for a builder host — `task start` a small real fix, checkpoint, close with evidence; for a reviewer host — review one merged PR's diff cold and compare against its recorded review. Compare friction/quality against the previous epoch's notes (below).
2. **Revisit docs/model-routing.md:** does the table's row for this host still match observed behavior? Adjust bands/fallbacks in the same commit as your notes.
3. **Run ONE subtraction test** from docs/controls.md whose retest is nearest due — new epochs change which controls still earn their cost.
4. **Record:** append an epoch note to experiments.md (`EPOCH: <host> <from> -> <to>, date, journeys run, verdicts, routing changes`) and clear the janitor finding by rejoining/acknowledging per its detail.

Notes accumulate here per epoch so the next requalification has a baseline:

## Epoch notes
- (none yet — first entry establishes the baseline)
