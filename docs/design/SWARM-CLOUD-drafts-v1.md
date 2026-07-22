# SWARM CLOUD — specification v1 (Fable draft)

Status: DRAFT for Codex critique round 1. Grounding: OUT-cloud-arch.md (architecture research), OUT-cloud-biz.md (security/ops/business research), field evidence from the 2026-07 swarm programs (Ops-seat dead-letter failure, prompteden multi-agent program, board v2 rebuild). Protocol: spec-protocol.md — iterate to mutual AGREE-EXCELLENT, then Kimi K3 security-only pass, Codex fixes, Fable verify.

## 0. One-paragraph summary

Swarm evolves from a single-machine SQLite CLI into **a small server-authoritative coordination plane** so 3+ humans — each driving their own Claude Code / Codex agents on their own laptops — share tasks, leases, messages, evidence, and a live fleet board across the PromptEden repos without trampling each other. The local CLI keeps SQLite as a durable cache and command outbox; a narrow cloud command API (Supabase Postgres) is the only authority for leases, closes, grants, and membership; Git/GitHub remains the code authority with a layered anti-trample policy; and the board v2 web UI becomes the hosted, beautiful, human-readable window into all of it.

## 1. Goals and non-goals

Goals (v1):
- G1: Two-plus humans + their agents coordinate on shared repos with zero silent trampling (task leases with fencing; branch/worktree conventions; protected branches; merge discipline).
- G2: Onboarding a new trusted collaborator takes **< 10 minutes** from invite link to first coordinated task (measured; OUT-cloud-biz benchmark: best tools hit first success < 5 min).
- G3: Every consequential action is attributable (human, agent, or human-via-agent) and auditable from day one.
- G4: The local CLI keeps working offline for reads and drafts; hard-invariant commands are online-only and say so honestly.
- G5: A hosted fleet board (board v2 lineage) shows: needs-you queue per human, roster across ALL machines, task lanes, presence, and honest liveness — solving the dead-letter class of failure (a message to an absent seat must be visible as unread-and-aging to everyone).
- G6: Total infra cost at 3–10 users: **≤ $30/month**, one dashboard.

Non-goals (v1): public SaaS, billing, SSO/SCIM, SOC 2, agent runtime hosting (agents stay on laptops), cross-org tenancy, GitLab, CRDT collaborative editing, replacing GitHub PR review. Architected-not-blocked: multi-workspace, Durable Objects migration path (§10).

## 2. Architecture (decision)

**Supabase (Postgres + Auth + Realtime) + a narrow command API, per OUT-cloud-arch's primary recommendation.** Rationale adopted in full: the dominant risk is shipping incorrect auth/tenancy, not cloud spend; one transactional Postgres eliminates the lease-correctness minefield of any client-merged sync (Turso LWW, CRDTs categorically rejected for authority state); Realtime Broadcast+Presence removes custom WebSocket infrastructure. Cloudflare DO+D1 is the documented v2 optimization path, reachable without protocol changes because clients only ever speak the command/event API.

Three planes:
1. **Command plane** (authoritative): `POST /v1/workspaces/{ws}/repos/{repo}/commands` — a Postgres transaction locks the repo head, validates membership/scopes/lease epoch/evidence, appends versioned events, updates projections, commits. Idempotency-keyed (`command_id` UUID); retry returns the original result. Implemented as Supabase Edge Functions (v1) fronting `handle_command()` SQL.
2. **Event plane** (durable): per-repo monotonic `seq`; `GET /v1/.../events?after=<seq>` replay is the delivery guarantee. Realtime Broadcast on private `repo:{id}` channels carries committed envelopes as a wake-up hint only — **a notification channel is never the record of truth**.
3. **Presence plane** (ephemeral): Supabase Presence per repo channel: principal, human-or-agent, current task, branch, coarse activity, heartbeat. TTL'd, never persisted, never authoritative.

Local plane: the existing swarm.db becomes read-model + `pending_commands` outbox + `sync_cursors`. Offline policy (adopted verbatim from research): reads serve cached-and-labeled; drafts queue as intent; lease acquire/renew, close/reopen, grant — online-only. The CLI never claims "lease acquired" from local state.

### 2.1 Data model (minimum)

```
users ──< memberships >── workspaces ──< repositories ──< events (repo-scoped seq)
                     │            ├──< invitations         ├── projections: tasks, leases,
                     │            ├──< github_installations │    messages, evidence, presence_log∅
                     │            └──< agents (principals) ─┴──< audit_log (all planes)
```

- `workspace_id` (immutable internal key) on every durable row, token, channel topic, and rate-limit key. Never equate workspace with GitHub org.
- Tasks/leases carry `lease_epoch` fencing exactly as the local swarm does today (WI-3 semantics lift to the server unchanged: acquire increments epoch; every protected mutation presents it; stale epoch → typed rejection event, never silent).
- Events: `(workspace_id, repo_id, seq, event_id, command_id, type, schema_version, actor_human, actor_agent, occurred_at_server, payload)`. Tolerant readers; never rewrite history.
- Roles: `owner`, `admin`, `member`, `viewer` + action scopes (`task:write`, `lease:acquire`, `task:close`, `message:send`, `grant:create`, `agent:mint`). Two-role RBAC-lite is enough at this scale (OUT-cloud-biz §4) but scopes exist from day one because agent tokens need them.

### 2.2 Identity and auth (decision)

- **Human login: Swarm-owned RFC 8628 device flow** (`swarm login` prints code, opens browser; browser side authenticates via Supabase GitHub OAuth or magic-link fallback; approval binds the device). CLI receives only Swarm tokens — never the GitHub token. Access token 15 min in memory; rotating refresh token (30 d, family reuse-detection) in the OS keychain; `SWARM_TOKEN` env for CI.
- **Agents are child principals, never the human.** `swarm agent mint --repo X [--task T] --ttl 4h` creates an opaque token (hashed at rest, instantly revocable) scoped to exact actions + repo (+ optionally task/lease epoch), recording `initiated_by`, agent type/version, device. Agents cannot mint agents. Possessing `message:send` never implies `task:write`.
- Threat model (lethal trifecta, OUT-cloud-biz): agent tokens are the blast radius — so they are short-lived, least-privilege, revocable at three layers (token, agent row, workspace membership), and **never grant GitHub access**; agents use the human's normal git credentials for their own branches only.
- **GitHub App** (separate from login): installed on selected repos, least privilege (Metadata:r, Contents:r, PR:rw only if needed, Checks:rw if we publish a gate), webhooks for PR/CI events, 1-hour installation tokens server-side only. Used to VERIFY evidence (head SHA reachable, CI green) — agent prose is metadata, not proof.

### 2.3 Git anti-trample layer (decision)

Adopted in full from research §5, as both server policy and repo rulesets:
1. Lease = ownership: one writing agent per lane; branch `swarm/<human>/<task-slug>`; worktree per agent; advisory path-intents warn on overlap; hard serialization for named hotspots (migrations, lockfiles, registries).
2. GitHub ruleset on main: PR required; no direct/force push; ≥1 review with stale-approval dismissal; conversation resolution; named CI checks; CODEOWNERS on high-risk paths only; admin bypass = logged break-glass.
3. **Server-verified close**: `task:close` requires the evidence bundle (lease_epoch, base/head SHA, branch, changed paths, test results, PR URL, check-run ids) and the GitHub App confirms head-reachability + CI. Stale epoch or diverged branch → `CloseRejected` with reasons. (This is the cloud lift of the swarm's existing claim-typed close gates — the differentiator per prior-art table.)
4. Merge queue when plan supports it (with `merge_group` CI trigger); squash/linear history.
5. Draft-PR CI discipline carries over (PromptEden Actions budget is a live constraint).

### 2.4 Web UI (decision)

The hosted board is **board v2, re-targeted**: same Preact/HTM/SSE architecture and design language (attention-first, five-state vocabulary, idle-collapse, group-spans, palette, since-you-left, honest liveness), served by the cloud with three additions:
- **Per-human needs-you**: the queue is scoped to the signed-in human (my approvals, my agents' blocking questions, mail addressed to me), with an all-fleet toggle.
- **Cross-machine roster**: every agent on every laptop, with device + human attribution and presence freshness; dead-letter prevention rendered directly (unread-mail age on every seat, sender-visible).
- **Approval gates as objects**: grants/escalations render as actionable cards (approve/deny with reason), writing commands through the same API — approvals are hard runtime gates, not chat etiquette (research anti-pattern #3).
Deep-links (`#task:...`) become shareable URLs — the board is the collaboration lingua franca.

## 3. Onboarding flow (G2, scripted)

1. Owner: `swarm cloud invite tom@x.com --role member` → magic-link invite (or link relay via chat).
2. Collaborator: `npm i -g @ridgeio/swarm && swarm login` (device flow, <60 s) → auto-joins workspace from the invite.
3. `swarm clone-setup prompteden` → clones repos they can see, installs hooks/skills for their agent CLIs, writes branch/worktree conventions, verifies `swarm doctor` (device, auth, repo access, agent CLIs detected).
4. `swarm agent mint` for their Claude/Codex sessions (or automatic on `swarm join` from a known CLI).
5. First task: `swarm task start ...` — the board shows them live to everyone. Target: invite→first task < 10 min, measured and logged as an onboarding funnel event.

## 4. Security baseline (adopted from OUT-cloud-biz, sized to scale)

- ASVS-L1-lite one-page checklist enforced in CI (the list is an appendix of this spec when finalized).
- Deny-by-default: every table RLS'd on workspace membership (defense in depth UNDER the command API — CRUD endpoints are not exposed for authority state).
- Secrets: server env via Supabase config; nothing model-visible; CLI tokens keychain-only; no plaintext creds in repos (standing Ridge.io hazard).
- Audit log from day one: every command (accepted AND rejected) with actor chain.
- Spend governance: per-human and per-agent rate limits in the request path; kill switches at token/agent/workspace layers; provider budget alerts are advisory only.
- Incident playbook: one page, 3 severities, copy-paste rotate/restore commands (appendix).
- Backups: Supabase PITR at Pro tier; weekly restore drill scripted (`swarm cloud restore-drill` against a scratch project).

## 5. Migration path (local → cloud)

- Phase-gated, no big bang: the local CLI gains a `--cloud` mode per swarm; `swarm cloud attach <workspace>` migrates a local swarm's open tasks/agents (events re-based, epochs preserved); local-only mode remains supported indefinitely (solo/offline use).
- Wire compatibility: local commands map 1:1 to cloud commands; the CLI abstracts the authority (local SQLite transaction vs cloud command) behind the same verbs, so agent teaching surfaces (skills, hooks, refusal strings) stay identical — agents should not need to know which mode they're in except where offline policy bites.

## 6. Delivery phases (each shippable)

- **P0 — Repo discipline now (pre-cloud, ships this week):** branch/worktree conventions + GitHub rulesets + CODEOWNERS on both PromptEden repos + doctrine-backstop AGENTS.md/CLAUDE.md sections. Two humans can already coexist safely with zero new infra.
- **P1 — Cloud core:** Supabase project; users/workspaces/memberships/agents; device-flow login; command+event API for tasks/leases/messages with fencing; CLI `--cloud` mode; property tests for the §7 failure set.
- **P2 — Board hosted:** board v2 served from the cloud with per-human needs-you, presence, cross-machine roster; invite flow; onboarding script (`clone-setup`, `doctor`).
- **P3 — Evidence verification:** GitHub App installed; server-verified closes; approval-gate cards; audit views.
- **P4 — Hardening:** rate limits, kill switches, restore drill, incident playbook, onboarding funnel metrics; Kimi-K3-findings retest; collaborator #2 onboarded as the acceptance test.

## 7. Failure tests that block launch (adopted verbatim from research §7 + field additions)

Research set: lease race → one epoch wins; stale-epoch close rejected; command retry idempotent; dropped/reordered Realtime converges via replay; revoked-membership agent token fails auditable; missing workspace_id caught by cross-tenant tests; evidence-SHA mismatch rejected; merge_group failure blocks.
Field additions: **dead-letter test** (message to an absent principal surfaces as unread-with-age on the board AND warns the sender at send time — the Ops-seat failure, made impossible); **skill-hijack test** (headless agent dispatch with hostile/foreign skill files present must not execute them — instruction isolation verified); **offline-honesty test** (CLI offline claims exactly what policy says: cached reads labeled, hard commands refused with the online-only message).

## 8. Costs (point-in-time, from research)

Dev: Supabase Free ($0). Launch: Supabase Pro $25/mo + domain/email ≈ $30/mo total at 3–10 users. No Redis, no Kafka, no sync-engine vendors. Board hosting rides the same project (static + Edge Function). Uptime target 99.0–99.5%, free pinger, no on-call theater.

## 9. Provisioning inventory (for operator approval before P1)

- Supabase project (Free → Pro at launch) — new.
- GitHub App "Swarm Cloud" on Ridge-io org, selected repos only — new; least-privilege per §2.2.
- Domain: `swarm.<owned-domain>` for the device-flow activation page + board — reuse an owned domain.
- Optional later (P2+): Cloudflare in front (static caching only). Vercel/Railway NOT needed in v1.

## 10. Revisit triggers (from research, kept as living table)

DO+D1 when: per-repo write serialization cost is measurable, a repo becomes a Postgres hot aggregate, or edge latency matters. Electric/Zero when: the board's live queries outgrow hand projections. PowerSync: only if large offline relational subsets become a promise. Y.js: only for a specific collaborative artifact, never the ledger.

## Open questions for Codex round 1

1. Edge Functions vs a small always-on API service (Railway/Fly) for the command plane — cold-start latency vs ops surface: which do you pick and why?
2. Event schema versioning discipline: per-event `schema_version` + tolerant readers enough, or do we need an explicit upcaster registry from day one?
3. Presence: Supabase Presence vs periodic command-plane heartbeats — is a second liveness mechanism (with different failure modes) worth it, or should presence derive from the event stream alone?
4. The CLI abstraction (§5): same verbs for local and cloud — do you see a verb whose semantics CANNOT be preserved across modes (and should therefore be renamed rather than silently differ)?
5. Anything in §6 phasing you'd reorder for risk?

VERDICT REQUEST: reply with numbered critiques + AGREE-EXCELLENT or OBJECTIONS per spec-protocol.md.
