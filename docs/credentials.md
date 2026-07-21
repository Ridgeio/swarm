# Credential hygiene — the minimum that matters

Scope: this machine runs a single-operator, trusted-environment swarm. We deliberately do NOT build a credential broker/sidecar (harness-engineering review verdict: right diagnosis, wrong scale). These are the minimums that address the real, audited hazard (plaintext credential files in the workspace — 2026-06-09 audit) without new infrastructure.

1. **Keys never in model-visible files.** No credentials in repos, briefs, checkpoints, task evidence, or messages — the mailbox, ledger, and briefs are all model-readable surfaces by design. If a command needs a secret, it reads it from the keychain/env at execution time; the *value* never enters a trajectory. (`swarm run` logs full command output to evidence dirs — treat those as model-visible too; don't run `env`-dumping commands through it.)
2. **Per-seat scoped tokens where providers allow.** `gh`: prefer fine-grained PATs scoped to the repos a program touches, over the account-wide oauth. One token per concern beats one god-token; revocation is then a boundary, not an incident.
3. **Read-only by default for observers.** Anything that only inspects (dashboards, census, review lanes) uses read-only credentials/identities where the provider distinguishes them.
4. **Rotation is a janitor-visible date, not a memory.** Long-lived tokens get a row in docs/controls.md with a retest-by date — the census nags when rotation is due.
5. **Known plaintext hazards** (from the workspace audit): BACKLINK-CREDENTIALS.md and ROTATED-KEYS-*.md patterns at the Ridge.io root are outside this repo's authority but inside the fleet's reach — agents must never copy their contents anywhere, and any task touching them escalates first (`swarm escalate`).

What we intentionally skip until scale demands it: broker daemons, per-action credential resolution, endpoint-bound revocation proxies. The trust boundary here is the machine; these rules keep secrets out of *model context*, which is the boundary that actually leaks.
