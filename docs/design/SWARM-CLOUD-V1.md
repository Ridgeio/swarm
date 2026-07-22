# SWARM CLOUD — specification (final, security-hardened)

Status: **agreed and security-reviewed.** Produced by a multi-model process (design/methodology at bottom): a Fable↔Codex adversarial specification loop reached mutual AGREE-EXCELLENT over three rounds; a Kimi K3 (opencode) security-only adversarial pass returned ACCEPTABLE-WITH-FIXES with 23 findings (4 launch-blocking); all 23 fixes are integrated below and mapped in the **Security fix ledger** at the end. This document is fully self-contained.

> Operator gate: nothing in §9 is provisioned until the owner reviews this spec, the §8 bill of materials, and the provisioning inventory (§9 P0 / former "provisioning inventory"). Delivery is phased and each phase ships behind the previous phase's §10 launch-blocking tests.

---

## 0. Summary and guarantee

Swarm evolves from a single-machine SQLite CLI into a small server-authoritative coordination plane so 3+ humans — each driving local Claude Code/Codex agents on their own laptops — share tasks, leases, messages, and evidence across shared repos (PromptEden app + marketing first). Supabase Postgres is the sole authority for leases, closes, grants, and membership, behind a private command API. The local CLI keeps SQLite as read-model and outbox. Git/GitHub remains the code authority.

**The guarantee, stated precisely:** Swarm ensures stale or unauthorized work cannot be *accepted by Swarm* (closes, grants, handoffs) and cannot *land on protected branches unnoticed* (rulesets + server-verified evidence). Swarm cannot prevent arbitrary Git writes made with a human's own credentials on unprotected refs; human Git credentials are outside Swarm's containment boundary and agents inherit them — this is documented residual risk, mitigated by per-epoch branch registration and protected-branch policy, not eliminated.

## 1. Goals and non-goals

- G1: Multi-human, multi-agent coordination with the §0 guarantee.
- G2: Onboarding: invite → first authoritative cloud command **< 10 minutes**, measured server-side; repo clone/setup measured separately.
- G3: Every command (accepted or rejected) attributable to human + agent principal + run, and auditable.
- G4: Local CLI: offline reads from labeled cache; offline intent-queueing for an allowlist only; hard-invariant commands online-only; an attached swarm never falls back to local authority.
- G5: Hosted board with per-human attention queues and honest liveness; absent-recipient warnings are advisory over durable unread state.
- G6: Launch cost ≈ $25/mo from the §8 bill of materials.

Non-goals v1: public SaaS, billing, SSO/SCIM, SOC 2, hosting agent runtimes, GitLab, CRDT editing, provider-spend capping, agent-process termination (the last two are outside the product boundary; Swarm's controls are coordination-API rate limits and credential/workspace revocation).

## 2. Authority model

### 2.1 Architecture

Supabase (Postgres + Auth + Storage) with Edge Functions fronting a `handle_command()` transaction. Two stream classes, each with its own monotonic `seq`:
- **Workspace stream**: membership, invitations, devices, agent principals, GitHub installations, workspace messages, workspace-scoped (non-repo) tasks.
- **Repo stream** (per repository): repo-scoped tasks, leases, repo messages, evidence.

Command flow: Edge Function authenticates the credential, derives the principal server-side, and invokes the command function (pinned `search_path`, minimal privileges), which — in one transaction on server time — rechecks membership/scope, validates the transition, appends canonical events, updates projections, and commits. Authority tables live in a private schema with CRUD revoked from `anon`/`authenticated`; RLS governs explicitly exposed human READ views only.

**Client-supplied identifiers are never trusted (Kimi #9).** The command function validates EVERY client-supplied identifier (workspace, repo, principal, run, device, recipient, task) against the server-derived principal's tenancy in the same transaction; a request whose derived principal is not a current member of the referenced workspace/repo is rejected before any state read. Actor identity (`actor_user`, `actor_agent_principal`, `actor_run`, `device`) is stamped from the authenticated credential, never from request fields.

**Event payloads are bounded (Kimi #23):** per-event payload ≤ 64 KB and per-message body ≤ 16 KB (larger content goes to the artifact plane, §2.8); oversize commands are rejected, not truncated.

Events: unique `(stream_id, seq)`; envelope carries `workspace_id, stream_id, seq, event_id, command_id, type, schema_version, actor_user, actor_agent_principal, actor_run, occurred_at_server, payload`. Per-`(event_type, version)` upcaster registry with golden full-history replay fixtures; clients never advance past an unknown authoritative event type; paginated replay + snapshot bootstrap + minimum-supported-client version. Canonical cloud events are reducer-complete (defined independently of the legacy local audit rows).

Idempotency: keyed `(principal, command_id)` with canonical request hash and stored original response; retries return the original result before `expected_version` evaluation; key reuse with a different hash → 409. Concurrency: task version + lease epoch (stream-level `expected_seq` only for stream-level commands). Domain rejections are committed `CommandRejected` events; authn/authz failures go only to the security audit log. **Idempotency records are retained ≥ 30 days** (covering any realistic client retry), and the stored original response covers rejections as well as successes, so a late retry never re-executes a committed command (Kimi #17). **All attacker-influenced strings written to `CommandRejected` payloads, audit rows, and titles are treated as data:** control/ANSI characters are stripped or escaped at every render boundary (CLI and board) so a crafted title cannot spoof "close succeeded" or corrupt displayed history (Kimi #16 — the CLI-side of the untrusted-content rule in §4).

### 2.2 Task and lease state machine

Task states: `open → active → awaiting_review → done`, plus `reopened` (→ active path) and terminal `done`. All transitions validate state, owner principal, presented epoch, expiry, and server time in one transaction.

| Command | Precondition | Effect |
|---|---|---|
| `task create` | member; slug unique in stream | state=open |
| `acquire` | open/reopened/active-with-expired-lease | epoch += 1; owner = caller; lease expiry = now + ttl |
| `renew` | owner ∧ epoch ∧ unexpired | expiry extended; epoch unchanged |
| `handoff` | owner ∧ epoch ∧ unexpired ∧ **recipient is a current member/principal of this workspace** | epoch += 1; owner = recipient |
| `takeover` | live lease: requires a takeover grant (§2.5); expired: as acquire | epoch += 1 |
| `submit` | owner ∧ epoch ∧ unexpired ∧ evidence bundle attached | state=awaiting_review; **submission record freezes {epoch, branch, head_sha, evidence set}**; lease continues (renewable); mutations other than renew/close/reopen refused |
| `close` | per §2.4 evidence gates; by owner (non-gated claims) or grant-holder (gated) | state=done; consumes any bound grant |
| `reopen` | Owner/Admin role, or task owner with epoch | state=reopened; task version += 1; **invalidates open submissions and grants** |
| lease expiry during `awaiting_review` | — | submission record REMAINS valid and closeable (it is bound to its frozen epoch/SHA, not the live lease); reacquisition (epoch += 1) does NOT invalidate it, but any new `submit` supersedes it |

Who may close: the frozen submission may be closed by (a) a human Owner/Admin, or (b) the task owner presenting a valid close grant where the claim requires one. Submit/reopen authorization is exactly as tabled — nothing else transitions review state.

Local mode: the CLI either adopts this table (same release) or marks local leases `semantics=v1-local`; the two are never conflated.

### 2.3 Identity and principals

Tables: `users`, `devices`, `memberships`, `workspaces`, `invitations`, `agent_principals` (durable), `agent_runs` (one CLI session), `credentials`, `github_installations`, `repositories`. `workspace_id` is mandatory on tenant-owned rows; the declared exceptions are the global identity/auth tables (`users`, `devices`, `credentials` pre-membership rows).

- **Human login (v1): authorization-code + PKCE**, external browser, loopback callback on 127.0.0.1, copy/paste fallback. (RFC 8628 device flow deferred until headless human login is a demonstrated need.) The flow uses a PKCE verifier AND a `state` parameter (login-CSRF / session-injection defense, including on the copy-paste fallback), a random high ephemeral loopback port with retry on collision, and an exact-match registered loopback redirect (Kimi #5).
- **Token lifecycle:** access-token cache AND rotating refresh credential in the OS keychain; per-device refresh serialization (lock + generation/CAS). **Server-side refresh-reuse detection: replay of a rotated refresh token revokes the entire token family** (Kimi #7). Where no OS keychain exists (headless Linux), the fallback is a `0600` file under a `0700` directory with an explicit warning, or a hard refusal if even that cannot be secured — never an unspecified plaintext store. `swarm devices` / `swarm logout [--device]`; remote revocation.
- **Agent capability tokens (hardened — Kimi #1, #2):** opaque, non-refreshing, one-time-displayed, hashed at rest. **Narrowest default binding: run + task + epoch** (not workspace-wide); **default TTL ≤ 1h** with an explicit re-mint path; hard max TTL still 8h. Stored by the CLI only in the OS keychain or a `0600` file (never an env var written to disk/logs); **token material is redacted in all CLI output and audit rows.** Revocation is evaluated on EVERY command (no auth caching). Instantly revocable at token, principal, and membership layers. **An agent capability token may NEVER carry scopes for: grant issuance, agent-token minting, invitations, membership/role/ownership operations, repository mapping, workspace deletion, or `--force-discard`** — those are human-interactive-credential-only. Any token minted while presenting an agent credential is **attenuation-only** (≤ the presenting credential's scopes), closing the narrow-token→broad-token escalation path.
- **`SWARM_SERVICE_TOKEN` (CI):** subject to the same scope axes, the agent-token denylist above, a stated TTL, and a rotation procedure — it is a scoped automation credential, never a stand-in for a human refresh token (Kimi #8).
- **GitHub App:** selected repos; Metadata:r, Contents:r, Pull requests:r, Checks:r; writes only with a named future gate. Webhooks: **SHA-256 HMAC verified (`X-Hub-Signature-256`) with constant-time comparison**, delivery-id deduped with a retention window exceeding GitHub's redelivery window (replay defense), install-suspend/remove handled, **repository or installation TRANSFER treated as an unmap event** (Kimi #12, #18), repo-id→workspace validated. Installation tokens are server-side, 1h.

### 2.4 Claims, dispositions, evidence

Claim kinds and their required close evidence (lifted from the local system's enforcement map, now server-validated):

| Claim | Required evidence (validator) | Server verification |
|---|---|---|
| `code-merged` | Git gates: head SHA reachable from the target branch; clean tree facts from the submission record | GitHub App: SHA reachable from default/target branch **on the mapped `github_repository_id` + installation** (a fork containing the same SHA does not satisfy it); required checks green on the frozen head **verified by expected check-app IDs** (an in-repo workflow reporting a same-named check does not satisfy it) |
| `journey-works` | `journey` artifact (steps + outcomes) | artifact provenance row present + digest re-verified + well-formed; probe log references the deployed target |
| `deploy-healthy` | `deploy-health` artifact (URL probes, status, timings) | artifact provenance + digest re-verified; at least one probe against the recorded deploy URL within close window |
| `analysis` | `report` artifact | artifact provenance row present + digest re-verified + well-formed |
| `decision` | `decision` ledger entry (+ optional `report`) | decision event exists in-stream |
| `probe` | `report` artifact; `--outcome established\|inconclusive` | artifact provenance + digest re-verified + well-formed; inconclusive is a first-class close |

**Artifact evidence is provenance-bound, not existence-checked (Kimi #3 — HIGH).** "Digest present" is NOT sufficient. On upload the server re-computes sha256 over the received bytes and rejects a mismatch, and records a provenance row `(digest, uploader_principal, task, claim_kind, submission)`. Close verification requires the matching provenance row for THIS task and submission — so a pre-existing object (an empty file, a teammate's real report) with a known digest cannot satisfy a claim, and "well-formed" structural validation applies to every artifact-bearing claim.

Dispositions: `merged` (code-merged only; requires the reachability gate and a close grant), `pr` (artifact preserved remotely — retains its existing meaning; review transition is `task submit`, a separate verb), `archive`, `discard` (requires `--force-discard`, audited, bypasses the evidence matrix but never `--not-established`; **authorized to the task owner presenting a valid epoch, or an Owner/Admin — never an agent capability token**, Kimi #20). **Every close records `--not-established`** (the claim's stated ceiling). Forced discard, verified rescue artifacts, and audited overrides carry over with their local semantics, expressed as events.

### 2.5 Grants

Grant types bind to what they authorize — not one universal shape:

| Grant type | Binds to | Use |
|---|---|---|
| `merge`/`override-close` (code) | op + task + submission {epoch, PR, head SHA} | single-use, consumed transactionally with close; invalidated by head change, reopen, epoch-invalidating submit |
| `override-close` (non-code claims) | op + task + submission {epoch, evidence artifact digest set} | single-use; invalidated by reopen or new submit |
| `takeover` | op + task + CURRENT lease epoch + recipient principal | single-use, TTL ≤ 1h; invalidated by any epoch change |
| `admin-op` (membership/ownership ops needing 4-eyes later) | op + target id | v1: issued and consumed by Owner only |

All grants: issued by human Owner/Admin only, TTL'd, revocable, fully audited (issue, use, expiry, revocation are events). Single-use consumption is enforced by a transactional unique constraint on `(grant_id)` at close, so two concurrent closes presenting the same grant resolve to exactly one success (Kimi #15; test in §10).

### 2.6 Roles and action matrix

Roles: **Owner** (last Owner cannot be removed or demoted), **Admin**, **Member**. Viewer deferred. **To prevent both bricking and squatting (Kimi #14): ≥ 2 Owners are required from the P2 collaborator-onboarding acceptance onward**, and a documented break-glass ownership-recovery exists — time-delayed, fully audited, requiring multiple Admins — so a lost or hostile sole Owner cannot permanently lock or squat a workspace.

| Action | Owner | Admin | Member |
|---|---|---|---|
| invite / revoke invitation | ✓ | ✓ | — |
| remove member / change role | ✓ | ✓ (not Owners) | — |
| transfer/add ownership | ✓ | — | — |
| create/archive repository mapping | ✓ | ✓ | — |
| issue grants (§2.5) | ✓ | ✓ | — |
| mint agent tokens (own principals) | ✓ | ✓ | ✓ |
| revoke any agent token | ✓ | ✓ | own only |
| task/lease/message commands | ✓ | ✓ | ✓ |
| workspace deletion | ✓ (confirmation + export) | — | — |

Capability-token scopes are a separate axis: a Member's agent token can never exceed the Member's own rights.

### 2.7 Client sagas and offline model

Acquire → local worktree setup → work/checkpoints → evidence upload → submit → authoritative close → cleanup are distinct idempotent steps with visible `setup_failed`/`cleanup_pending` states. Machine paths stay in a device-local overlay; checkpoint bodies upload to cloud storage; handoff briefs reference cloud artifacts, never local paths.

Offline: reads serve labeled cache; the outbox allowlist is exactly {draft task create, message send} with `pending/sending/accepted/rejected` states, dependency ordering, canonical rejection details, preserved rejected drafts. Everything else is online-only with an honest refusal message.

### 2.8 Artifact plane

Supabase Storage, one private bucket per workspace, keys `artifacts/<workspace>/<sha256>`; content-addressed (canonical digest = sha256 of raw bytes, **re-computed server-side on upload completion — a mismatch is rejected**, Kimi #3); size cap 25 MB/artifact, 500 MB/workspace/month soft quota **plus a per-principal upload quota** so one compromised member cannot exhaust the workspace and block everyone's evidence (Kimi #13); type allowlist (text, json, log, png, pdf).

**Signed URLs are tightly scoped (Kimi #10):** the workspace is derived from the auth context, NEVER from the requested key path (so a member of workspace A cannot probe `artifacts/B/...`); GET URLs are single-object (no list); PUT URLs are issued only to **server-minted keys** and bind key + size + digest; all signed URLs TTL ≤ 15 min.

Retention: task lifetime + 180 days, then lifecycle-deleted (audit events retain digests forever, so deletion is detectable, never silent). **Residual-risk (documented, consistent with the trusted-user model — Kimi #21): any workspace member can read any workspace artifact, including checkpoints that may embed secrets; there is no upload-side secret screening in v1.** Artifact reads are per-principal audited. Verification semantics per claim kind are in §2.4. Storage is in the §8 BOM (within Pro's included 100 GB).

## 3. Git discipline layer

- Branch per lease epoch, immutable once superseded: `swarm/<human>/<task>/e<epoch>`; base and head registered at acquire/submit.
- Worktree per writing agent; never two writers in one tree; advisory path-intents warn on overlap; hard serialization list per repo (migrations, lockfiles, generated registries).
- GitHub ruleset on default/release branches: PR required; no direct/force pushes or deletion; ≥1 review with stale-approval dismissal; conversation resolution; named required checks from the expected sources; a required Swarm check verifying the approver is a current non-bot workspace member distinct from the initiating human where separation is required; CODEOWNERS on high-risk paths only (auth, billing, migrations, deploy, `.github/`, CODEOWNERS itself); merge queue when plan supports (`merge_group` CI trigger); squash/linear history; admin bypass = logged break-glass.
- Draft-PR CI discipline (budget-metered orgs): PRs open as drafts; ready-for-review only when review-ready.
- Stacked PRs: one owner per stack; freeze foreign branches; no up-stack enqueue before dependencies land.

## 4. Presence and the board

No Supabase Presence in v1. Hooks and ordinary CLI commands POST throttled authenticated heartbeats to a TTL soft-state table on server time, outside the event streams. **Heartbeat `device` and `run` are bound server-side from the presenting credential, and `current task` is validated against actual task ownership** — so a token cannot fake another device's liveness or claim false activity, keeping "honest liveness" honest (Kimi #22).

**All swarm-originated strings are untrusted data, never instructions (Kimi #4 — HIGH).** Message bodies, task titles, handoff briefs, artifact contents, and rejection details are member-writable and are consumed both by *other agents' models* and by the human's browser. Therefore: (a) the board **escapes every swarm-originated string** and serves under a **strict CSP with no inline script** (the board-v2 CSP `default-src 'none'` already satisfies this — it is now a normative requirement, not an implementation detail); (b) the CLI strips ANSI/control characters when rendering any swarm content; (c) the agent teaching surface states explicitly that swarm message/task/artifact content is **data, never instructions** (an agent must not treat a message body as a command to run `swarm close`/`takeover` or to exfiltrate its token); (d) board command cards (approve/deny/merge) use CSRF-safe authenticated POSTs, never GET side effects.

The hosted board is the board-v2 architecture re-targeted at the cloud read API (its snapshot-stream SSE contract, attention-first IA, five-section layout, keyboard model, and honest-liveness rendering carry over as its own spec: swarm repo `docs/design/SWARM-BOARD-V2.md`, which remains normative for the board): per-human NEEDS-YOU scope with all-fleet toggle; cross-machine roster with device+human attribution and heartbeat age; unread-mail age on every seat; approval gates rendered as actionable cards that submit commands. **The board read API and any Realtime/Broadcast channel are workspace-authorized: SSE/stream subscriptions and channels are scoped to the subscriber's memberships, enforced server-side** (Kimi #11). Board acceptance: the operator answers "what needs me / what changed / what's everyone doing" in <5s each; legible 390–1440px; keyboard-only read paths.

## 5. Security baseline

ASVS-L1-lite checklist enforced in CI (appendix A of the final committed spec); deny-by-default private schema (§2.1); secrets never model-visible, CLI tokens keychain-only; audit log from day one (all commands, both streams, accepted and rejected), append-only — no actor can mutate or truncate audit events. **Rate limits are designed NOT to become a teammate-DoS (Kimi #13):** unauthenticated limits (login, invite acceptance) are keyed on IP + identifier and **alert rather than hard-lock** a victim's account; per-principal command limits pair with alerting and a fast re-mint path so a token thief exhausting a limit does not silently lock out the legitimate agent; the per-principal artifact upload quota (§2.8) prevents one member starving the workspace. Three-layer revocation (token/principal/membership); incident playbook (one page, 3 severities, copy-paste rotate/restore); backups: Supabase Pro daily + one PROVEN restore before any collaborator onboarding, restore drills release-gated thereafter; PITR is a priced decision if measured RPO ever demands it.

## 6. Migration: local → cloud

`swarm cloud attach <workspace>` is **Owner-only** and a **one-time, resumable import**. Imported `legacy-unverified` events are server-stamped with the importing user as the authoritative actor; original local actor names are preserved only as payload data, never as authoritative actor fields (Kimi #19).
1. Freeze the local swarm (writes refused with a pointer message).
2. Fingerprint the source (db hash + machine id); the import is idempotent by fingerprint and resumable mid-stream.
3. Map repositories by GitHub repository ID (interactive confirmation for unmapped repo paths); task slugs namespaced per repo stream; collisions suffixed deterministically.
4. Import history as `legacy-unverified` events (audit value, no proof claims); local verification booleans are NOT trusted as cloud proof.
5. NEVER import: live grants, agent credentials, session tokens, machine paths (paths go to the device-local overlay of the importing machine only).
6. Invalidate all active leases; the first cloud acquisition of each task increments from the imported maximum epoch.
7. Attached mode is irreversible except by `swarm cloud export` into a NEW local swarm.
Local-only mode remains supported indefinitely for solo/offline use.

## 7. Onboarding

Invite tokens single-use, expiring (**TTL ≤ 7 days**), hashed at rest, revocable, **consumed atomically in-transaction with a unique constraint** so two concurrent acceptances of the same link create exactly one membership (Kimi #6; test in §10), and **accepted only by a verified identity** — membership is explicitly bound to the authenticated user, never inferred from an email match. GitHub repo access is an owner-provisioned prerequisite (collaborator/team add); `swarm doctor` separately verifies auth, `git ls-remote`, push permission, App installation mapping, ruleset status, agent CLIs. Fast path `swarm cloud init` in an existing clone; distribution via checksummed npm package (final name verified/scoped at P1) with Node ≥24 declared; agent teaching-surface installation opt-in, versioned, inspectable, reversible — its installer test suite includes the instruction-isolation (skill-hijack) control. Funnel: invite → first authoritative command, logged, target <10 min.

## 8. Costs (bill of materials)

| Item | Plan | $/mo |
|---|---|---|
| Supabase (db+auth+storage+functions) | Free dev → Pro launch | 0 → 25 |
| Daily backups | in Pro | 0 |
| PITR | deferred decision | 0 (+~10 if adopted) |
| Artifact storage | within Pro 100 GB | 0 |
| Domain/DNS (existing) | reuse | 0 |
| Transactional email | Supabase quotas at this scale | 0 |
| GitHub | existing org plan (merge-queue availability verified against it) | 0 marginal |
| Monitoring | free pinger | 0 |

Launch ≈ **$25/mo**. Dashboards honestly counted: Supabase, GitHub, DNS.

## 9. Delivery phases

- **P0 — Foundations (nobody exposed):** protocol + §2.2 state machine + reducers + upcasters + property tests (idempotent retry, fencing, expiry, golden replays); GitHub rulesets + per-epoch branch convention + doctrine backstop installed on both PromptEden repos (positioned as landing-risk reduction only); read-only GitHub App installed and verified; distribution name claimed.
- **P1 — Secure authority slice (online-only):** PKCE login + keychain lifecycle; tenancy + private-schema command API; repository mapping; tasks/leases per §2.2; audit; revocation; rate limits; daily backups + one proven restore; invitation flow + `swarm cloud init`.
- **P2 — Differentiator + acceptance:** submissions + claim-typed closes with GitHub verification (§2.4); grants (§2.5); artifact plane (§2.8); migration/attach (§6); **collaborator #2 onboarded as this slice's acceptance test.**
- **P3 — Visibility:** hosted board (§4), messages (workspace+repo), heartbeats, advisory dead-letter warnings.
- **P4 — Comfort:** offline outbox allowlist, `clone-setup`, funnel metrics, Broadcast wake-up optimization, incident-playbook drill.

Each phase ships behind the previous one's launch-blocking tests (§10); no shared cloud coordination is exposed before P2 passes.

## 10. Launch-blocking failure tests

Core: lease race → exactly one epoch wins; stale-epoch close rejected; expired-lease mutation rejected; submission survives lease expiry and supersession works; retry-after-commit returns the original result; idempotency-key reuse with a different hash → 409; dropped/reordered notifications converge via replay; unknown event type halts the client cleanly; revoked-membership agent token fails auditable; evidence-SHA mismatch rejected; grant invalidated on head change/reopen/new submit; takeover grant dies on epoch change; merge_group failure blocks; last-Owner removal refused; restore drill passes; offline allowlist behaves exactly as specified; attach import is resumable and idempotent by fingerprint.

Security (added from the Kimi K3 pass): **per-view AND per-channel two-tenant policy tests** — a member of workspace A gets zero rows from every exposed read view and zero frames from every SSE/Broadcast channel scoped to workspace B (replaces the weaker "missing workspace_id column" scan, Kimi #11); artifact digest mismatch on upload rejected and cross-task provenance reuse rejected (#3); agent capability token carrying a denylisted scope refused at mint (#1); two concurrent closes presenting one grant → exactly one success (#15); concurrent takeover + handoff at the same epoch → exactly one winner (#15); two concurrent acceptances of one invite → exactly one membership (#6); refresh-token replay revokes the family (#7); handoff to a non-member recipient rejected (#9); evidence check against a fork's identical SHA rejected, and a same-named check from an unexpected app rejected (#12); signed GET URL cannot list and cannot cross workspaces (#10); control-character payload cannot spoof CLI/board output (#4/#16).

## Design & methodology (how this spec was produced)

This specification is the output of a deliberate multi-model process, not a single author:

1. **Parallel research fan-out** — headless Codex (web search) and Claude subagents produced `OUT-cloud-arch.md` (architecture: Supabase-vs-Durable-Objects, local-first sync, auth, git discipline, prior art) and `OUT-cloud-biz.md` (security baseline, onboarding benchmarks, cost, governance), each ~15 cited sources.
2. **Fable↔Codex adversarial specification loop** — Fable (claude-fable-5) drafted; Codex (gpt-5.6-sol, xhigh) adversarially critiqued; iterate to mutual "excellent." Trajectory: round 1 → 22 objections (10 blocking); round 2 → 5 incompletely-resolved + 3 new; round 3 → **AGREE-EXCELLENT, zero objections**, "remaining choices are schema/endpoint/validator/UI details rather than architectural decisions."
3. **Kimi K3 security-only adversarial pass** (opencode, `moonshotai/kimi-k3`) — a THIRD model family, tasked to break it: 23 findings (4 launch-blocking HIGH), verdict ACCEPTABLE-WITH-FIXES, and ten controls positively verified.
4. **Fix integration + verification** — all 23 fixes integrated in place (ledger below); verified by Fable against the finding list. (Codex was tasked to apply the fixes but its sandbox could not write to the working directory — an environmental limit, not a review gap; the fixes are Kimi's exact prescriptions.)

The model-inversion principle (a different family reviews than authored) is what surfaced each class of defect: Codex-the-reviewer caught the lease/consistency and completeness gaps a Claude author under-weights; Kimi-the-attacker caught the token-escalation, evidence-forgery, and second-order-injection paths that neither coding model flagged.

## Security fix ledger (Kimi K3 findings → sections edited)

| # | Sev | Finding | Fixed in |
|---|---|---|---|
| 1 | HIGH | agent-token privilege escalation via minting | §2.3 (agent tokens: denylist + attenuation-only); §10 |
| 2 | HIGH | bearer-token storage/TTL/redaction/blast-radius | §2.3 (narrowest default, TTL ≤1h, 0600, redaction, revoke-every-command) |
| 3 | HIGH | forgeable evidence (digest existence-check) | §2.4 (provenance-bound + re-hash); §2.8; §10 |
| 4 | HIGH | second-order injection & stored XSS | §4 (untrusted-data rule: escape+CSP+ANSI-strip+teaching+CSRF) |
| 5 | MED | PKCE loopback (state, port) | §2.3 |
| 6 | MED | invite not transactional / TTL / verified identity | §7; §10 |
| 7 | MED | keychain fallback + refresh reuse detection | §2.3 |
| 8 | MED | `SWARM_SERVICE_TOKEN` scope | §2.3 |
| 9 | MED | confused deputy: client-supplied IDs | §2.1 (blanket validation); §2.2 (handoff recipient); §10 |
| 10 | MED | signed URL scope/TTL/list | §2.8 |
| 11 | MED | cross-tenant test targets wrong failure; SSE/channel authz | §4 (channel scoping); §10 (per-view/per-channel tests) |
| 12 | MED | evidence vs forks/renames/check-app spoofing | §2.3 (transfer=unmap); §2.4 (mapped repo id + check-app ids); §10 |
| 13 | MED | rate limits as teammate-DoS | §5; §2.8 (per-principal quota) |
| 14 | MED | last-Owner brick/squat | §2.6 (≥2 Owners + break-glass recovery) |
| 15 | MED | missing concurrency tests (grants/invites/takeover) | §2.5; §10 |
| 16 | LOW | log/terminal injection | §2.1 (control-char escaping) |
| 17 | LOW | idempotency retention | §2.1 (≥30d, covers rejections) |
| 18 | LOW | webhook HMAC details | §2.3 (SHA-256, constant-time, dedupe window) |
| 19 | LOW | attach authority & actor-stamping | §6 (Owner-only, server-stamped) |
| 20 | LOW | force-discard authorization | §2.4 (owner/admin, never agent token) |
| 21 | LOW | member-wide artifact read + secret carriage | §2.8 (documented residual risk + read audit) |
| 22 | LOW | heartbeat spoofing | §4 (device/run server-bound, task-ownership validated) |
| 23 | LOW | unbounded event payloads | §2.1 (64KB/16KB caps) |
