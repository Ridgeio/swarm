# Standing controls registry

Every standing control (hook injection, collapse rule, census check, doctrine line that constrains agents every turn) is listed here with a **retest-by date** and a **retirement condition**. The janitor parses this table and files a `control-retest-due` finding for any row past its date — P5 applied to P5 itself: enforcement is a loop with retirement conditions, not a ratchet.

Row format is machine-parsed (strict): `| id | mechanism | guards-against | YYYY-MM-DD | retirement condition |`. Keep ids kebab-case and stable. To retest: run a **subtraction experiment** (disable the control for a bounded window; watch the failure class it guards; verdict retain/revise/retire recorded in experiments.md).

| id | mechanism | guards-against | retest-by | retirement condition |
| --- | --- | --- | --- | --- |
| debris-counters-hook | per-turn debris counters in hook context | silent debris accumulation between census looks | 2026-08-03 | retire if a 2-week subtraction shows census findings flat without them |
| unacked-collapse-3-45 | 3-show/45-min message collapse in hook | context bloat from re-injected unacked messages | 2026-08-17 | retire only if ack discipline makes re-injection rare (<1/day) |
| backfill-fence | new-joiner cursor fence at MAX(id) | stale-doctrine replay to new agents | 2026-09-01 | permanent until message TTLs exist; then reassess |
| janitor-hook-piggyback | hook spawns janitor tick when >10 min stale | idle-fleet census gaps between launchd ticks | 2026-08-17 | retire if launchd alone keeps tick age <15 min for 2 weeks |
| checkpoint-stale-nag-90m | 90-min stale-checkpoint nag in hook | context loss from unexternalized work | 2026-09-01 | threshold retune allowed; mechanism permanent while P2 stands |
| close-git-gates | unpushed/dirty/untracked refusal at task close | stranded-work loss at task end | 2026-10-01 | permanent (founding failure class); overrides are audited, not exempted |
| review-priors-greptile | model-inversion priors in swarm review briefs | reviewers hunting the wrong bug classes | 2026-10-01 | retire/refresh when a newer cross-model study or field data supersedes the Greptile 2026 numbers |
