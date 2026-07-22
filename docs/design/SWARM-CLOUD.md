# SWARM CLOUD — canonical specification

> **Single self-contained document.** This is the canonical, consolidated specification for evolving Swarm from a single-machine coordination CLI into a small multi-human cloud service. It folds three previously separate documents into one reader-facing artifact so the whole system reads end-to-end with no external cross-references:
> - **Part I — Cloud service specification** (authority, coordination, security, phases, costs).
> - **Appendix A — Served board UI design** (Board v2), which Part I §4 references as normative.
> - **Appendix B — Doctrine backstop**, the per-repo working agreements Part I §9 P0 installs.
>
> The component files remain in the repository as the installable / code-referenced sources (`docs/design/SWARM-CLOUD-V1.md`, `docs/design/SWARM-BOARD-V2.md`, `docs/repo-backstop.md`); on any conflict this consolidated document is the reading source of truth. Full provenance and the multi-model review history are in Part I's *Design & methodology* section.
>
> **Operator gate:** nothing is provisioned (Supabase project, GitHub App, domain) until the owner reviews this document — the bill of materials (Part I §8) and the phased delivery plan (Part I §9). Each phase ships behind its own launch-blocking tests (Part I §10).

---

# Part I — Cloud service specification

Status: **agreed and security-reviewed.** Produced by a multi-model process (design/methodology at bottom): a Fable↔Codex adversarial specification loop reached mutual AGREE-EXCELLENT over three rounds; a Kimi K3 (opencode) security-only adversarial pass returned ACCEPTABLE-WITH-FIXES with 23 findings (4 launch-blocking); all 23 fixes are integrated below and mapped in the **Security fix ledger** at the end of Part I. **Revised (coordination model):** after a design conversation with an engineering colleague, the coordination layer was moved to advisory-first (soft where reversible, hard where not — §0 principle), with per-human coordinators and centralized landing (§2.10) and agent-maintained living design specs (§2.11); the diff was re-reviewed by Codex (model inversion).

> Operator gate: nothing in §9 is provisioned until the owner reviews this spec, the §8 bill of materials, and the provisioning inventory (§9 P0 / former "provisioning inventory"). Delivery is phased and each phase ships behind its own §10 launch-blocking tests.

---

## 0. Summary and guarantee

Swarm evolves from a single-machine SQLite CLI into a small server-authoritative coordination plane so 3+ humans — each driving local Claude Code/Codex agents on their own laptops — share tasks, leases, messages, and evidence across shared repos (PromptEden app + marketing first). Supabase Postgres is the sole authority for leases, closes, grants, and membership, behind a private command API. The local CLI keeps SQLite as read-model and outbox. Git/GitHub remains the code authority.

**The guarantee, stated precisely:** Swarm ensures stale or unauthorized work cannot be *accepted by Swarm* (closes, grants, handoffs) and cannot *land on protected branches unnoticed* (rulesets + server-verified evidence). Swarm cannot prevent arbitrary Git writes made with a human's own credentials on unprotected refs; human Git credentials are outside Swarm's containment boundary and agents inherit them — this is documented residual risk, mitigated by per-epoch branch registration and protected-branch policy, not eliminated.

**Governing principle — soft where reversible, hard where not.** Coordination and authority are different problems and get different enforcement, and the test that separates them is whether a collision is *cheaply reversible*. Two agents editing the same file is reversible: git merges most of it, and the real conflicts are usually cheap to reconcile — though a semantic one spanning subsystems can be substantial, so "cheap" is the common case, not a guarantee — so that layer is **advisory**, made visible and never blocked. Producing an authoritative record is not reversible: a task told "done" that wasn't, a grant double-spent, a revoked agent's write, or work landed on a protected branch cannot be un-done once a human has acted on it — so that layer is **hard**, fenced and gated. The whole design follows this line: file, area, and project coordination is advisory (§2.9); task-close, grants, landing, and revocation are authoritative (§2.2, §2.4, §2.5, §3). Both mistakes have a cost — hard-locking a reversible collision serializes work that usually would not have conflicted and stalls a fast fleet; soft-gating an irreversible one corrupts state that cannot be repaired — and drawing the line at reversibility is how the fleet moves like a basketball game while the trunk stays governed.

**What this does and does not promise.** Multi-writer collaboration on one codebase is a hard problem that predates agents: adding writers often lowers, not raises, throughput and quality once designs diverge, and agents inherit that ceiling rather than escaping it. This system *lowers the cost* of coordinating many humans and agents; it does not repeal it. The three levers are advisory reservations that make concurrent work visible (§2.9), living design specs that surface design divergence early and cheaply (§2.11), and model-inversion review that lets a human delegate trust to a process instead of reviewing every change (§2.4). Design-level incoherence — two people wanting the same component to be two different things — is not something file coordination can fix; §2.11 is the mitigation for it, and it is a mitigation, not a guarantee.

## 1. Goals and non-goals

- G1: Multi-human, multi-agent coordination with the §0 guarantee.
- G2: Onboarding: invite → first authoritative cloud command **< 10 minutes**, measured server-side; repo clone/setup measured separately.
- G3: Every command (accepted or rejected) attributable to human + agent principal + run, and auditable.
- G4: Local CLI: offline reads from labeled cache; offline intent-queueing for an allowlist only; hard-invariant commands online-only; an attached swarm never falls back to local authority.
- G5: Hosted board with per-human attention queues and honest liveness; absent-recipient warnings are advisory over durable unread state.
- G6: Launch cost ≈ $25/mo from the §8 bill of materials.

Non-goals v1: public SaaS, billing, SSO/SCIM, SOC 2, hosting agent runtimes, GitLab, CRDT editing, provider-spend capping, agent-process termination (the last two are outside the product boundary; Swarm's controls are coordination-API rate limits and credential/workspace revocation).

## 2. Authority and coordination model

### 2.1 Architecture

Supabase (Postgres + Auth + Storage) with Edge Functions fronting a `handle_command()` transaction. Two stream classes, each with its own monotonic `seq`:
- **Workspace stream**: membership, invitations, devices, agent principals, GitHub installations, workspace messages, workspace-scoped (non-repo) tasks.
- **Repo stream** (per repository): repo-scoped tasks, leases, repo messages, evidence.

Command flow: Edge Function authenticates the credential, derives the principal server-side, and invokes the command function (pinned `search_path`, minimal privileges), which — in one transaction on server time — rechecks membership/scope, validates the transition, appends canonical events, updates projections, and commits. Authority tables live in a private schema with CRUD revoked from `anon`/`authenticated`; RLS governs explicitly exposed human READ views only.

**Client-supplied identifiers are never trusted (Kimi #9).** The command function validates EVERY client-supplied identifier (workspace, repo, principal, run, device, recipient, task) against the server-derived principal's tenancy in the same transaction; a request whose derived principal is not a current member of the referenced workspace/repo is rejected before any state read. Actor identity (`actor_user`, `actor_agent_principal`, `actor_run`, `device`) is stamped from the authenticated credential, never from request fields.

**Event payloads are bounded (Kimi #23):** per-event payload ≤ 64 KB and per-message body ≤ 16 KB (larger content goes to the artifact plane, §2.8); oversize commands are rejected, not truncated.

Events: unique `(stream_id, seq)`; envelope carries `workspace_id, stream_id, seq, event_id, command_id, type, schema_version, actor_user, actor_agent_principal, actor_run, occurred_at_server, payload`. Per-`(event_type, version)` upcaster registry with golden full-history replay fixtures; clients never advance past an unknown authoritative event type; paginated replay + snapshot bootstrap + minimum-supported-client version. Canonical cloud events are reducer-complete (defined independently of the legacy local audit rows).

Idempotency: keyed `(principal, command_id)` with canonical request hash and stored original response; retries return the original result before `expected_version` evaluation; key reuse with a different hash → 409. Concurrency: task version + lease epoch (stream-level `expected_seq` only for stream-level commands). Domain rejections are committed `CommandRejected` events; authn/authz failures go only to the security audit log. **Idempotency records are retained ≥ 30 days** (covering any realistic client retry), and the stored original response covers rejections as well as successes, so a late retry never re-executes a committed command (Kimi #17). **All attacker-influenced strings written to `CommandRejected` payloads, audit rows, and titles are treated as data:** control/ANSI characters are stripped or escaped at every render boundary (CLI and board) so a crafted title cannot spoof "close succeeded" or corrupt displayed history (Kimi #16 — the CLI-side of the untrusted-content rule in §4).

### 2.2 Task ownership and the lease (authority)

The lease is an **authority token, not a file lock.** Holding a task's lease at the current epoch is the right to *submit and close that task* and to be its accountable owner of record; it is fenced — stale epochs are refused — precisely because closing a task produces an authoritative record. It does **not** grant exclusive access to any file. Concurrent editing across agents and humans is coordinated by advisory reservations (§2.9), never by the lease: two agents may be editing overlapping files at the same moment, and at most one holds a given task's authority. What is exclusive here is the right to produce the task's close (an irreversible record), not the act of editing (a reversible one).

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
- **Agent capability tokens (hardened — Kimi #1, #2):** opaque, non-refreshing, one-time-displayed, hashed at rest. **Narrowest default binding: run + task + epoch** (not workspace-wide); **default TTL ≤ 1h** with an explicit re-mint path; hard max TTL still 8h. Stored by the CLI only in the OS keychain or a `0600` file (never an env var written to disk/logs); **token material is redacted in all CLI output and audit rows.** Revocation is evaluated on EVERY command (no auth caching). Instantly revocable at token, principal, and membership layers. **An agent capability token may NEVER carry scopes for: grant issuance, agent-token minting, invitations, membership/role/ownership operations, repository mapping, workspace deletion, `--force-discard`, or authoring/accepting/updating/revoking any trusted knowledge, playbook, foundational instruction file, or acceptance schema (§2.12)** — those are human-interactive-credential-only. Any token minted while presenting an agent credential is **attenuation-only** (≤ the presenting credential's scopes), closing the narrow-token→broad-token escalation path.
- **`SWARM_SERVICE_TOKEN` (CI):** subject to the same scope axes, the agent-token denylist above, a stated TTL, and a rotation procedure — it is a scoped automation credential, never a stand-in for a human refresh token (Kimi #8).
- **Coordinator capability (§2.10):** the per-human manager agent gets a distinct **read-mostly** credential class — human- and run-bound, short-lived, revocation-checked-every-command. It may read permitted fleet metadata, send messages, and place/override reservations; it may **not** submit, close, take over a lease, issue grants, mint worker tokens, or land code. This keeps a coordinator's fleet-wide visibility from becoming fleet-wide authority: a stolen coordinator token exposes coordination, not the ability to close tasks or land code.
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

Dispositions: `merged` (code-merged only; requires the reachability gate and a close grant), `pr` (artifact preserved remotely — retains its existing meaning; review transition is `task submit`, a separate verb), `archive`, `discard` (requires `--force-discard`, audited, bypasses the evidence matrix but never `--not-established`; **authorized to the task owner presenting a valid epoch, or an Owner/Admin — never an agent capability token**, Kimi #20). **Every close records `--not-established`** (the claim's stated ceiling). Forced discard, verified rescue artifacts, and audited overrides carry over with their local semantics, expressed as events. Where a task declares a **human-authored acceptance schema** (§2.12), its frozen digest is validated against the submission at close — additive to this matrix, never weakening it — and a submission either conforms to the typed contract or is refused with the exact unmet field.

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
| assign / transfer landing authority (§2.10) | ✓ | ✓ | — |
| author / accept / revoke trusted knowledge, playbooks, schemas (§2.12) | ✓ | ✓ | suggest only |
| issue grants (§2.5) | ✓ | ✓ | — |
| mint agent tokens (own principals) | ✓ | ✓ | ✓ |
| revoke any agent token | ✓ | ✓ | own only |
| task/lease/message commands | ✓ | ✓ | ✓ |
| workspace deletion | ✓ (confirmation + export) | — | — |

Capability-token scopes are a separate axis: a Member's agent token can never exceed the Member's own rights. **Landing authority is a per-repo assignment, not a role tier** — it names which human merges a given repo's protected branches (§2.10), is distinct from close authority, and is set only by the human-credential commands in this matrix; it cannot be held by an agent capability token.

### 2.7 Client sagas and offline model

Acquire → local worktree setup → work/checkpoints → evidence upload → submit → authoritative close → cleanup are distinct idempotent steps with visible `setup_failed`/`cleanup_pending` states. Machine paths stay in a device-local overlay; checkpoint bodies upload to cloud storage; handoff briefs reference cloud artifacts, never local paths.

Offline: reads serve labeled cache; the outbox allowlist is exactly {draft task create, message send} with `pending/sending/accepted/rejected` states, dependency ordering, canonical rejection details, preserved rejected drafts. Everything else is online-only with an honest refusal message.

### 2.8 Artifact plane

Supabase Storage, one private bucket per workspace, keys `artifacts/<workspace>/<sha256>`; content-addressed (canonical digest = sha256 of raw bytes, **re-computed server-side on upload completion — a mismatch is rejected**, Kimi #3); size cap 25 MB/artifact, 500 MB/workspace/month soft quota **plus a per-credential upload quota under a workspace fairness ceiling** — the same no-lockout shape as reservations (§2.9): revoking a compromised token and re-minting restores upload ability, while the ceiling still stops one member exhausting the workspace and blocking everyone's evidence (Kimi #13, aligned with coordination-review finding #6); type allowlist (text, json, log, png, pdf).

**Signed URLs are tightly scoped (Kimi #10):** the workspace is derived from the auth context, NEVER from the requested key path (so a member of workspace A cannot probe `artifacts/B/...`); GET URLs are single-object (no list); PUT URLs are issued only to **server-minted keys** and bind key + size + digest; all signed URLs TTL ≤ 15 min.

Retention: task lifetime + 180 days, then lifecycle-deleted (audit events retain digests forever, so deletion is detectable, never silent). **Residual-risk (documented, consistent with the trusted-user model — Kimi #21): any workspace member can read any workspace artifact, including checkpoints that may embed secrets; there is no upload-side secret screening in v1.** Artifact reads are per-principal audited. Verification semantics per claim kind are in §2.4. Storage is in the §8 BOM (within Pro's included 100 GB).

### 2.9 Advisory work reservations (coordination, not authority)

The primitive the field converges on for concurrent work is **advisory, not a lock** — the pattern of Linux `flock` and desktop-sync clients: make it visible that someone is working somewhere, and do not stop anyone. A reservation warns; it never blocks an edit and never gates an authoritative operation.

- **Identity and scope.** A reservation is `(workspace_id, repository_id-or-null, kind, canonical_scope)` with an opaque server-issued `reservation_id` and a monotonic `generation`. `kind ∈ {project, component, task, path}`; `project`/`task` scopes are validated against real project/task rows, and `component`/`path` scopes are canonicalized to normalized path prefixes or explicit path sets — **no arbitrary glob intersection**, so a crafted glob can never become a matching-cost attack. Overlap is computed deterministically by prefix/set containment within the same `(workspace, repository)` tuple, and across grains (`component:auth` overlaps `path:src/auth/login.ts`; identical `src/**` in two different repos do not). Both table reads and pub/sub topics are server-scoped to that tuple, so a reservation never leaks across workspaces or unrelated repos.
- **Holder, TTL, lifecycle.** The holder principal is bound server-side from the credential, never client-claimed (§2.1, §4 heartbeat rule). `reserve` sets a server-time expiry with a **short hard maximum** (≤ 2h) — a compromised token cannot request an effectively permanent reservation. `renew` and `release` are **holder-only** (a non-holder can never silently clear another principal's reservation) and bump `generation`; auto-expiry at TTL means a dead agent never leaves a permanent reservation (the local dead-letter lesson). Reservations live in the TTL soft-state table alongside heartbeats (§4), not as authoritative ledger events.
- **Event taxonomy (resolves the audit-vs-soft-state tension).** Every reservation *command* (`reserve`/`renew`/`release`/`override`) is recorded in the security audit log like all commands (§5). But only an **override** emits a durable *domain* event, because taking a reserved scope is the one socially consequential act worth a ledger record. Placement/renew/release are soft-state mutations with an audit-log line, not ledger events — so "reservations are not authoritative events" and "every command is audited" are both true.
- **Override is atomic and correctly attributed.** Another agent touching a reserved scope is **warned, not refused** — the warning surfaces to that agent and its human. It may wait, subscribe to the clear, ping the holder's coordinator to negotiate (§2.10), or `override <reservation_id> --reason <text>`. Override runs in one transaction that locks the reservation at an **exact active generation** and snapshots holder, scope, generation, and expiry into the emitted event, so an override racing an expiry-and-recreation can never mis-attribute the record to the wrong holder — it either binds the exact live generation or fails and reports current state. `--reason` and `--note` are attacker-influenceable, size-bounded, and subject to the untrusted-content rule (§4).
- **Subscription over polling.** Agents subscribe to a scope and wake on placed / cleared / overridden (pub/sub) rather than scraping a log; this rides the same Broadcast wake-up path as the board (§4), with polling the reservation table as the fallback.
- **Anti-abuse without lockout (reconciles with the security baseline).** Limits are **per-credential/run, not per-principal**, with duplicate-scope coalescing and bounded TTLs — so revoking a compromised token and re-minting immediately restores the legitimate agent's ability to reserve (a per-principal cap would have re-created the teammate-DoS Kimi #13 forbids). A higher **workspace fairness ceiling** bounds total reservations without denying any unaffected credential, and a human reset/revocation path clears a stuck bucket instantly. Because reservations never block, the worst any spam achieves is noise, never lockout.

### 2.10 Coordination topology: per-human coordinators, centralized landing

Coordination is **peer-to-peer between humans' agents, not through one central brain.** Each human operates their fleet through their own coordinator (a "manager") agent — their single interface, reflecting their goals, preferences, and memory. Coordinators negotiate work with each other over the message bus and via reservations (§2.9): *your* coordinator learns *their* coordinator holds the leads component this afternoon and routes around it or asks it to yield. There is no mandatory single Lead over everyone — a central coordinator would have to be told everything, be maintained as a component, and match divergent per-user expectations, so it is a role a human may run **for their own fleet**, never a required singleton for the workspace. (This is the multi-human generalization of the single-owner program in the local org template, which remains correct for a one-owner swarm.)

**The coordinator's credential is read-mostly (§2.3 credential class — resolves the blast-radius tension).** A manager agent needs fleet-wide *visibility* (activity, messages, reservations, notification context) but must not become a skeleton key. Its capability is human- and run-bound, short-lived, revocation-checked, and may **read permitted fleet metadata, send messages, and place/override reservations** — but may **not** submit, close, take over a lease, issue grants, mint worker tokens, or land code. Those stay human-mediated worker-credential operations. Theft of a coordinator token therefore exposes visibility and coordination, not authority.

**Landing is a single, modeled, hard authority per repo — distinct from close.** Decentralized coordination is not decentralized landing. Each repository mapping names exactly one **landing authority**: a current, eligible human member who alone may merge to that repo's protected branches (and enqueue to its merge queue). This is separate from *close* authority (§2.2/§2.4): closing a task records a disposition; landing puts code on the trunk. Assignment and transfer of landing authority are **human-credential-only** commands (Owner/Admin, §2.6); the role cannot be removed, demoted, or the repository remapped until a successor is named, and a lost or hostile authority is recovered only through the audited, time-delayed, multi-Admin break-glass (§2.6).

**A required pre-landing check binds the merge to still-valid state (closes the stale-trunk hole).** Landing is gated: before a merge to a protected branch is allowed, a required Swarm check verifies, against the exact PR head SHA — (a) it matches a **currently-valid frozen submission** (§2.2) whose epoch is not superseded and whose task is not reopened; (b) neither the author's membership nor any required token is revoked; (c) any required merge/override grant (§2.5) is live and bound to this exact SHA; and (d) the cross-family review passed at this SHA. A superseded or reopened submission fails the check, so a stale-but-green PR **cannot** reach the trunk even if the landing human clicks merge — which is what makes the §0 "cannot land on protected branches unnoticed" guarantee true rather than aspirational. (Before this, the merge grant was consumed only at *close* — i.e. after GitHub had already landed the code; the pre-landing check moves the gate ahead of the irreversible act. It is a *required* check, unlike the informational design-contradiction check of §2.11.)

**Shared-environment application is hard-gated at apply, not at edit.** The genuinely irreversible operations on shared infrastructure — applying a migration to a shared database, promoting to production — are gated at **apply time** by the landing authority or operator (the prod gate), never by locking the files that describe them. Editing a migration file is reversible and stays advisory (§2.9); applying it to the shared DB is not, and that is where the hard gate belongs. This is the §0 reversibility line applied to infrastructure: the file is soft, the apply is hard.

### 2.11 Design coherence: living component specs

Advisory reservations stop two agents from clobbering the same file; they do nothing about two humans wanting the same component to *be two different things*. That design-level divergence is the real ceiling on multi-writer work, and specs are usually skipped because they change too fast to hand-maintain. The resolution is to **let the agents maintain the spec** — then "it changes daily" stops being a cost, because the agents pay it.

- **A living design doc per component** lives in the repo (so it versions and reviews with the code it describes): `<component>/DESIGN.md` or equivalent.
- **Read-before-work, update-in-the-same-PR.** The doctrine backstop (**Appendix B**, installed at §9 P0) instructs every agent to read the component's design doc before starting and to update it in the same PR as the change it describes, which keeps upkeep low and drift small — it *reduces* the maintenance burden, it does not zero it (an agent can still update code without faithfully updating the doc, so occasional drift is expected and is itself something reviewers watch for).
- **Contradiction surfaces early, advisory not blocking.** A change that contradicts the recorded design **flags the repository's landing authority (§2.10)** — or a separately-modeled component owner where one exists — and any subscribed humans, as an advisory escalation; it does not silently diverge and does not hard-block. The contradiction detector is an **informational Swarm check that reports a neutral status and never blocks landing** (unlike the *required* pre-landing check of §2.10). Design divergence thus appears at the design layer (cheaper, earlier) instead of only at the merge layer.
- This is coherence by visibility — the same philosophy as reservations. Make divergence legible and cheaper to resolve; reserve the hard edge for the irreversible act (landing/apply), not for a disagreement about design.
- **Structural companion (§2.12).** `DESIGN.md` carries *intent* (the why); an auto-generated structural wiki carries the *what* (architecture as it actually is), queried as **untrusted tool data** (§2.12) and versioned by exact source SHA — together they close the drift gap without asking humans to maintain structural docs by hand, while keeping code-derived content on the untrusted side of the §4 line.

### 2.12 Knowledge, scoping, and structured handoffs

Four primitives adapted from Devin's Playbook / Knowledge / DeepWiki model (see *Design & methodology*), fitted to this system's advisory-first, human-authority posture. The unifying hazard — and the reason this section is mostly about trust boundaries — is that **knowledge, playbooks, schemas, and triggers are all instruction-or-instruction-selecting surfaces**, so a naive version is a prompt-injection amplifier. Each primitive below states which side of the trusted-instruction / untrusted-data line (§4) it sits on.

#### Trusted instructions — Knowledge, Playbooks, and foundational files

Shared *instruction* context has three tiers, all governed by ONE state machine and ONE authority rule:
- **Foundational** — `AGENTS.md` / `CLAUDE.md` at repo/workspace root (the doctrine backstop installs here).
- **Knowledge** — standing conventions / architectural context, each with a **trigger** scoping when it surfaces.
- **Playbooks** — procedures for a repeated kind of task, invoked when such a task is claimed.

**Trusted-content state machine.** Every trusted item — foundational files included — is an immutable record `{scope, trigger, body, version_digest}` in one of three states: `pending → accepted → revoked`.
- **Human-credential-only writes.** Authoring, accepting, updating (= a new version), and revoking trusted content are **human-interactive-credential operations only** — added to the §2.3 agent-token denylist and the §2.6 role matrix (Owner/Admin, or the repo's landing authority for repo-scoped items). An agent may only **suggest** an item (create a `pending` record); it can never make one active.
- **Pending is human-UI-only.** A `pending` item is visible ONLY in a human review surface — absent from every agent- and coordinator-facing read, search, notification, digest, and context API. This closes the "an unaccepted suggestion still reaches a model through a coordinator digest" path: unaccepted content never enters any model's context.
- **Acceptance covers body + scope + trigger together** — a human accepts *what* it says, *where* it applies, and *when* it fires; a trigger cannot change without re-acceptance.
- **Repo-backed instructions load only from an accepted default-branch commit.** Foundational/knowledge files that live in the repo activate ONLY from a server-recorded, accepted commit on the resolved default branch — **never from a feature branch**. A PR touching an instruction file requires human-only review; an agent reviewing such a PR sees the changed file as an **untrusted diff** (§4) and must not load it as instruction. This closes the "poison `AGENTS.md` on a branch, a review agent loads it before merge" path.

#### Untrusted tool data — the structural wiki

Alongside the hand-authored `DESIGN.md` (intent), a **structural map is derived from code** (module / dependency / entry-point structure), queryable on demand so agents consult it instead of re-deriving architecture each session. Its trust classification is the correction Devin's framing invites:
- **Wiki output is UNTRUSTED tool data (§4), never trusted instruction.** Filenames, import strings, comments, docstrings, generated and vendored code are all attacker-influenceable; a prompt-injection comment in landed code must never reach an agent as instruction. The wiki renders under the §4 untrusted-content boundary, exactly like reading the code itself.
- **Static, non-executing extraction only.** The generator parses; it never imports, executes, or runs the repository's build hooks (which could read secrets or trigger hostile hooks). It extracts a bounded structural allowlist — no free-form comments, string literals, or synthesized procedural advice enter any trusted surface.
- **Source stays in the boundary.** Repository source is not sent to any external / LLM processor unless a separately-reviewed, disclosed processor is explicitly provisioned; the default generator is local and static.
- **Access is source-entitlement-bound.** Each snapshot is keyed `(workspace_id, github_repository_id, installation_id, commit_sha)`; a query is authorized against the querier's **exact source-read entitlement for that repo**, not mere workspace membership. Cached results are denied immediately on repo unmap, transfer (treated as unmap per Kimi #12), installation suspension, or loss of GitHub access.
- **Versioned, honest about freshness (no false "cannot drift" claim).** Each snapshot is keyed by exact source SHA and published atomically only if it still matches the intended head; a query returns explicit `current | generating | stale | failed`. Out-of-order generation (a slow merge publishing after a newer one) and missed refreshes are surfaced, never silently served as current; stale output is advisory.

#### Structured handoffs — acceptance schemas (tightens §2.4, additive-only)

A task may carry a machine-checkable **acceptance schema** as an *additional* close gate:
- **Human-authored/accepted, frozen on submission.** An authorized human authors or accepts the schema; an agent may only *propose* one — a worker cannot define or weaken its own completion contract. The task stores an **immutable schema version + digest**, and that digest is **frozen into the submission record** (§2.2). Close validates against the *frozen* schema, never a later-mutated one; changing a schema creates a new task/schema version requiring notification and a new submission or reopen.
- **Conjunctive with built-in validators.** A schema can only **add** requirements to §2.4's claim-evidence matrix — never weaken or override it.
- **Closed, declarative subset.** No network references (remote `$ref`), no custom validators/code, no side effects/defaults/transforms; bounded bytes, nesting, field count, array size, and match complexity/time (no ReDoS or recursive-expansion vector). Canonicalize before hashing. Schema field names and validation-error text are treated as **escaped untrusted data** when shown to any agent — never an instruction channel.

#### Advisory scoping/confidence gate — NOT a spec freeze

On claiming a non-trivial task an agent produces a scoped plan and a confidence signal *before* the work; low confidence or an under-specified task **escalates to the human** (advisory — surfaces "I'm not sure what you want here" early) but **never blocks**. **The anti-Devin boundary:** this is confidence *reporting*, not scope *freezing* — the plan is a starting point, mid-flight direction changes are expected and allowed (§0 basketball model, not Devin's football model that "performs worse when you keep telling it more after it starts"). The scoped plan is always advisory; only the schema-completion and evidence checks are hard, and both live in the back-end close gate.

#### Trigger evaluation — bounded, tenant-scoped, deterministic

A trigger selects *trusted* instructions from *untrusted* inputs (a task's path/kind/tags), so it is bounded to stay non-injectable:
- **Bounded declarative matching only** — canonical path prefixes, enumerated task-kinds, exact tags. No arbitrary regex/glob, and never an instruction-following model evaluated over untrusted task text (itself injectable).
- **Server-derived tenancy first.** Matching runs only within the querier's server-derived workspace/repo; a task title cannot reach knowledge in another tenant.
- **Budgeted, deterministic precedence.** Match count, evaluation work, and injected-context bytes are capped so a broad/crafted trigger cannot exhaust context and displace foundational safety instructions; precedence is deterministic (foundational > accepted knowledge, most-specific scope first).
- **Untrusted fields recommend, they do not activate privileged playbooks.** A task's untrusted topic may *suggest* a playbook, but activating a privileged one (deploy/release) requires a **human-authoritative task kind or explicit confirmation** — a crafted task title cannot inject a deployment procedure into another worker's context.

## 3. Git discipline layer

- Branch per lease epoch, immutable once superseded: `swarm/<human>/<task>/e<epoch>`; base and head registered at acquire/submit. (Branch-per-worker is isolation, not a lock — it lets everyone work concurrently and surfaces collisions at merge, the reconcilable point, so it is the advisory-friendly move.)
- Worktree per writing agent; never two writers in one tree (a filesystem constraint, genuinely hard). All concurrent file/branch editing is coordinated by **advisory reservations (§2.9)** — visible, non-blocking. There is **no blocking file lock**, not even for migrations, lockfiles, or generated registries: editing those is reversible (git merges the branch; the real conflict resolves at merge), so per the §0 principle they stay advisory. The hard, irreversible acts live elsewhere — **landing** to a protected branch and **applying** to a shared environment — and are gated there (next bullet, and §2.10 apply gate), not by locking source files.
- **Landing authority + pre-landing check (§2.10):** each repository mapping names exactly one human as merge authority for its protected branches, and a required pre-landing check binds every merge to a still-valid frozen submission, revocation state, and any required grant at the exact head SHA — single-authority, fenced landing, even though work coordination is peer-to-peer. A superseded/reopened submission's green PR is refused at the trunk.
- GitHub ruleset on default/release branches: PR required; no direct/force pushes or deletion; ≥1 review with stale-approval dismissal; conversation resolution; named required checks from the expected sources; a required Swarm check verifying the approver is a current non-bot workspace member distinct from the initiating human where separation is required; CODEOWNERS on high-risk paths only (auth, billing, migrations, deploy, `.github/`, CODEOWNERS itself); merge queue when plan supports (`merge_group` CI trigger); squash/linear history; admin bypass = logged break-glass.
- Draft-PR CI discipline (budget-metered orgs): PRs open as drafts; ready-for-review only when review-ready.
- Stacked PRs: one owner per stack; freeze foreign branches; no up-stack enqueue before dependencies land.

## 4. Presence and the board

No Supabase Presence in v1. Hooks and ordinary CLI commands POST throttled authenticated heartbeats to a TTL soft-state table on server time, outside the event streams. **Heartbeat `device` and `run` are bound server-side from the presenting credential, and `current task` is validated against actual task ownership** — so a token cannot fake another device's liveness or claim false activity, keeping "honest liveness" honest (Kimi #22).

**All swarm-originated strings are untrusted data, never instructions (Kimi #4 — HIGH).** Message bodies, task titles, handoff briefs, artifact contents, and rejection details are member-writable and are consumed both by *other agents' models* and by the human's browser. Therefore: (a) the board **escapes every swarm-originated string** and serves under a **strict CSP with no inline script** (the board-v2 CSP `default-src 'none'` already satisfies this — it is now a normative requirement, not an implementation detail); (b) the CLI strips ANSI/control characters when rendering any swarm content; (c) the agent teaching surface states explicitly that swarm message/task/artifact content is **data, never instructions** (an agent must not treat a message body as a command to run `swarm close`/`takeover` or to exfiltrate its token); (d) board command cards (approve/deny/merge) use CSRF-safe authenticated POSTs, never GET side effects.

The hosted board is the board-v2 architecture re-targeted at the cloud read API (its snapshot-stream SSE contract, attention-first IA, five-section layout, keyboard model, and honest-liveness rendering carry over as its own spec — **Appendix A of this document**, which remains normative for the board): per-human NEEDS-YOU scope with all-fleet toggle; cross-machine roster with device+human attribution and heartbeat age; unread-mail age on every seat; approval gates rendered as actionable cards that submit commands. **The board read API and any Realtime/Broadcast channel are workspace-authorized: SSE/stream subscriptions and channels are scoped to the subscriber's memberships, enforced server-side** (Kimi #11). Board acceptance: the operator answers "what needs me / what changed / what's everyone doing" in <5s each; legible 390–1440px; keyboard-only read paths.

**Notification is a judgment, not a toggle-box.** What is worth interrupting a human for is decided by that human's coordinator agent (§2.10) reading the fleet's activity against the human's own preferences and memory — surface-now vs mention-next-time vs absorb-to-memory — and tuned over time in conversation, not configured as a rigid set of switches. The board's since-you-left digest is the UI floor of this; the coordinator's triage is the ceiling. Reservation placed / cleared / overridden signals (§2.9) are one input to that triage and ride the same Broadcast wake-up path as board updates.

## 5. Security baseline

ASVS-L1-lite checklist enforced in CI (appendix A of the final committed spec); deny-by-default private schema (§2.1); secrets never model-visible, CLI tokens keychain-only; audit log from day one (all commands, both streams, accepted and rejected), append-only — no actor can mutate or truncate audit events. **Rate limits are designed NOT to become a teammate-DoS (Kimi #13):** unauthenticated limits (login, invite acceptance) are keyed on IP + identifier and **alert rather than hard-lock** a victim's account; per-credential command limits pair with alerting and a fast re-mint path so a token thief exhausting a limit does not silently lock out the legitimate agent (re-minting restores capacity); the per-credential artifact and reservation quotas under workspace fairness ceilings (§2.8, §2.9) prevent one member starving the workspace without locking out re-minted credentials. Three-layer revocation (token/principal/membership); incident playbook (one page, 3 severities, copy-paste rotate/restore); backups: Supabase Pro daily + one PROVEN restore before any collaborator onboarding, restore drills release-gated thereafter; PITR is a priced decision if measured RPO ever demands it.

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

- **P0 — Foundations (nobody exposed):** protocol + §2.2 state machine + reducers + upcasters + property tests (idempotent retry, fencing, expiry, golden replays); GitHub rulesets + per-epoch branch convention + doctrine backstop installed on both PromptEden repos (positioned as landing-risk reduction only), including the living-design-doc convention (§2.11). The backstop's advisory-reservation rule (11) ships with a **plain social-note fallback** at P0 — a message, not the `reserve` command — because the reservation primitive itself does not arrive until P3; the command form of rule 11 activates then. Foundational instruction files (`AGENTS.md`/`CLAUDE.md`) activate only from an accepted default-branch commit, never a feature branch (§2.12 trust rule) — this control ships at **P0**, because foundational files are active from P0 and the poisoning window would otherwise be open. Read-only GitHub App installed and verified; distribution name claimed.
- **P1 — Secure authority slice (online-only):** PKCE login + keychain lifecycle; tenancy + private-schema command API; repository mapping **with a named landing authority per repo (§2.10)** and its human-only assign/transfer/no-orphan commands; tasks/leases per §2.2; audit; revocation; rate limits; daily backups + one proven restore; invitation flow + `swarm cloud init`.
- **P2 — Differentiator + acceptance:** submissions + claim-typed closes with GitHub verification (§2.4); human-authored, frozen-digest, additive-only acceptance schemas over a closed declarative subset (§2.12); grants (§2.5); the **required pre-landing check (§2.10)** binding merges to a valid frozen submission/grant/revocation state; artifact plane (§2.8); migration/attach (§6); the informational living-spec contradiction check (§2.11); **collaborator #2 onboarded as this slice's acceptance test.**
- **P3 — Coordination + visibility + knowledge:** advisory work reservations (§2.9) at all grains with pub/sub and the read-mostly coordinator credential (§2.3/§2.10); the trusted-content state machine (pending→accepted→revoked, human-credential-only, pending absent from all model-facing paths — §2.12) for knowledge/playbooks with bounded tenant-scoped triggers; the untrusted, source-entitlement-scoped structural wiki (§2.12); the advisory scoping/confidence gate (§2.12); hosted board (§4); messages (workspace+repo); heartbeats; coordinator-agent notification triage (§4); advisory dead-letter warnings.
- **P4 — Comfort:** offline outbox allowlist, `clone-setup`, funnel metrics, Broadcast wake-up optimization (also carries reservation pub/sub), incident-playbook drill.

**Each phase must pass its OWN capability's launch-blocking tests (§10) before that capability is exposed** — a phase never ships behind only the prior phase's gate. In particular, the reservation, coordinator-confinement, and pre-landing tests gate P2/P3 exposure directly, not P4. No shared cloud coordination is exposed before P2 passes.

## 10. Launch-blocking failure tests

Core: lease race → exactly one epoch wins; stale-epoch close rejected; expired-lease mutation rejected; submission survives lease expiry and supersession works; retry-after-commit returns the original result; idempotency-key reuse with a different hash → 409; dropped/reordered notifications converge via replay; unknown event type halts the client cleanly; revoked-membership agent token fails auditable; evidence-SHA mismatch rejected; grant invalidated on head change/reopen/new submit; takeover grant dies on epoch change; merge_group failure blocks; last-Owner removal refused; restore drill passes; offline allowlist behaves exactly as specified; attach import is resumable and idempotent by fingerprint.

Coordination (added from the coordination-model revision):
- **Reservations:** auto-expire at TTL with no permanent stale reservation; the server hard-maximum TTL is enforced (a token cannot request a near-permanent reservation); a non-holder cannot release or renew another principal's reservation (holder-only, server-bound); an override binds an exact active generation and, racing an expiry-and-recreation, either attributes the audit event to the correct holder or fails cleanly (never mis-attributes); a reserved scope never *blocks* a non-holder's edit (advisory only); a crafted/expensive glob is rejected or canonicalized (no matching-cost attack); reservation table reads and pub/sub topics are workspace/repo-scoped (no cross-tenant leak); an override reason/note with control characters or markup cannot spoof or inject when shown (§4).
- **No-lockout (reconciles Kimi #13):** a compromised token exhausts its *per-credential* reservation bucket; after revoke + re-mint the legitimate credential can immediately reserve again — spam never locks out a teammate.
- **Coordinator confinement:** the read-mostly coordinator credential is refused when it attempts to submit, close, take over, issue a grant, mint a worker token, or land code.
- **Landing:** a superseded or reopened submission's still-green PR is refused at the trunk by the required pre-landing check; a revoked author's PR is refused; a grant not bound to the exact head SHA is refused; a repo's single landing authority cannot be removed, demoted, or remapped without a named successor, and a second cannot be silently added; break-glass ownership/landing recovery is time-delayed, multi-Admin, and fully audited.
- **Design coherence:** a change contradicting a component `DESIGN.md` flags the repository's landing authority, and the contradiction check is informational — it never blocks landing.

Knowledge & scoping (added from the Devin-concept layer, §2.12; hardened per coordination-review round on that layer):
- **Trusted-content write path (P0 + P3):** no trusted tier — knowledge, playbooks, OR foundational `AGENTS.md`/`CLAUDE.md` — is authorable/acceptable/updatable/revocable by any agent or coordinator credential; a `pending` item is absent from EVERY model-facing read, search, notification, digest, and context API; a repo instruction file activates only from an accepted default-branch commit (never a feature branch); an agent reviewing an instruction-file PR treats it as an untrusted diff and does not load it.
- **Structural wiki (P3):** wiki output is classified untrusted — a prompt-injection comment in landed code never reaches an agent as instruction; the generator does not import/execute the repo; a query is authorized against the exact per-repo source entitlement (a workspace member lacking that repo's source access is denied); a cached wiki is denied immediately on unmap/transfer/suspension/permission-loss; out-of-order generation never serves stale-as-current (SHA-keyed atomic publish), and a failed generation returns `failed`, not silent stale.
- **Schema handoffs (P2):** a schema is human-authored/accepted (an agent cannot author or weaken it); close validates the frozen schema digest on the submission (a post-submission schema change does not alter an in-flight close); schemas are additive-only (cannot weaken §2.4 validators); a hostile schema (remote `$ref`, ReDoS regex, deep recursion, oversized) is rejected by the closed-subset limits; schema field-names/errors shown to an agent are escaped.
- **Triggers (P3):** matching is bounded declarative (no regex/glob/LLM-over-untrusted-text), server-tenancy-scoped (a task title cannot activate another tenant's knowledge), and budget-capped (cannot exhaust context or displace foundational instructions); a crafted untrusted task title cannot activate a privileged (deploy/release) playbook without a human-authoritative task kind.
- **Scoping stays advisory:** a low-confidence/under-specified claim escalates to the human but never blocks, and a mid-task direction change is accepted (the scoped plan is not a frozen contract — §0 basketball model, not Devin's football model).

Security (added from the Kimi K3 pass): **per-view AND per-channel two-tenant policy tests** — a member of workspace A gets zero rows from every exposed read view and zero frames from every SSE/Broadcast channel scoped to workspace B (replaces the weaker "missing workspace_id column" scan, Kimi #11); artifact digest mismatch on upload rejected and cross-task provenance reuse rejected (#3); agent capability token carrying a denylisted scope refused at mint (#1); two concurrent closes presenting one grant → exactly one success (#15); concurrent takeover + handoff at the same epoch → exactly one winner (#15); two concurrent acceptances of one invite → exactly one membership (#6); refresh-token replay revokes the family (#7); handoff to a non-member recipient rejected (#9); evidence check against a fork's identical SHA rejected, and a same-named check from an unexpected app rejected (#12); signed GET URL cannot list and cannot cross workspaces (#10); control-character payload cannot spoof CLI/board output (#4/#16).

## Design & methodology (how this spec was produced)

This specification is the output of a deliberate multi-model process, not a single author:

1. **Parallel research fan-out** — headless Codex (web search) and Claude subagents produced `OUT-cloud-arch.md` (architecture: Supabase-vs-Durable-Objects, local-first sync, auth, git discipline, prior art) and `OUT-cloud-biz.md` (security baseline, onboarding benchmarks, cost, governance), each ~15 cited sources.
2. **Fable↔Codex adversarial specification loop** — Fable (claude-fable-5) drafted; Codex (gpt-5.6-sol, xhigh) adversarially critiqued; iterate to mutual "excellent." Trajectory: round 1 → 22 objections (10 blocking); round 2 → 5 incompletely-resolved + 3 new; round 3 → **AGREE-EXCELLENT, zero objections**, "remaining choices are schema/endpoint/validator/UI details rather than architectural decisions."
3. **Kimi K3 security-only adversarial pass** (opencode, `moonshotai/kimi-k3`) — a THIRD model family, tasked to break it: 23 findings (4 launch-blocking HIGH), verdict ACCEPTABLE-WITH-FIXES, and ten controls positively verified.
4. **Fix integration + verification** — all 23 fixes integrated in place (ledger below); verified by Fable against the finding list. (Codex was tasked to apply the fixes but its sandbox could not write to the working directory — an environmental limit, not a review gap; the fixes are Kimi's exact prescriptions.)
5. **Coordination-model revision (post-agreement).** A design conversation with an engineering colleague — who, from a blank sheet, independently reinvented Swarm's inbox / work-queue / pub-sub primitives (confirming they are table stakes) and named the `flock`/desktop-sync advisory-lock precedent — drove a revision toward advisory-first coordination (soft where reversible, hard where not — §0 principle; §2.9), per-human coordinators with centralized landing (§2.10), and agent-maintained living design specs (§2.11), with the honest Brooks caveat in §0. The diff was re-reviewed by Codex on the model-inversion principle, which returned **REVISE (8)** — one blocking, seven major, two minor — all integrated before commit. The blocking finding closed a real hole (a superseded-but-green PR could reach the trunk because landing had no pre-landing check bound to the frozen submission — now §2.10); the review also corrected the model's own inconsistency of listing "hard hotspot serialization" for lockfiles/migrations, which contradicts the reversibility principle (editing is reversible; *applying/landing* is the hard act — §3, §2.10), and added the read-mostly coordinator credential class (§2.3) so a manager agent's visibility is not authority.
6. **Knowledge & scoping layer (Devin-concept mining).** Devin.ai was surveyed for primitives worth adopting; four were fitted to this system's posture (§2.12) — the Playbook / Knowledge / `AGENTS.md` taxonomy with triggers and human-gated agent suggestions, an auto-generated structural wiki alongside the hand-authored `DESIGN.md`, schema-typed assignment/completion contracts, and an advisory scoping/confidence gate — while Devin's core "freeze scope upfront, don't change mid-task" rigidity was **explicitly rejected** as contrary to the §0 basketball model. Codex re-reviewed the addition and returned **REVISE (7)** — 2 blocking, 5 major, 1 minor — all integrated: the trust boundary became a full `pending → accepted → revoked` state machine (human-credential-only, pending never in model-facing paths, repo instructions loaded only from accepted default-branch commits); the structural wiki was reclassified as **untrusted tool data** with static non-executing extraction and source-entitlement-bound access; acceptance schemas were made human-authored, frozen-on-submission, additive-only, over a closed declarative subset; and triggers were bounded to declarative, tenant-scoped matching. The through-line: knowledge/wiki/schemas/triggers are all instruction-or-instruction-selecting surfaces, and each is now explicitly placed on the correct side of the §4 trusted/untrusted line.

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
| 13 | MED | rate limits as teammate-DoS | §5; §2.8/§2.9 (per-credential quotas + workspace ceiling, no lockout) |
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

---

# Appendix A — Served board UI design (Board v2)

> Referenced as normative for the board by Part I §4; inlined here for self-containment. Section numbers below (P1–P9 principles, Addendum A) are local to this appendix.

Replaces the v1 served board (Cytoscape graph + right rail + ECharts timeline), which the operator judged a UI/UX failure. v1 is torn down wholesale; no incremental patching. Grounded in the 2026-07 research sweep: `OUT-ui-products.md` (16 shipped products surveyed), `OUT-ui-frontend.md` (stack), plus operator field evidence from the prompteden program.

## Why v1 failed (concrete, not aesthetic)

1. **Graph-first was the wrong primary.** A 3-agent swarm renders as a sparse Cytoscape diagram that answers no operator question. The field's consensus primary is a **status roster + attention queue** (Vercel rows, Warp badges, Claude Code agent panel); graphs are a drill-down lens, not a landing surface.
2. **No attention queue.** "NEEDS YOU" existed as a side-rail list, not as the organizing principle. The single most-documented UX failure in this product class is ambiguous attention (Devin's "falls asleep" backlash); the single most-praised pattern is an explicit inbox of blocking items.
3. **No re-entry story.** The measured cost of running agent fleets is 10–20 min/task of re-orientation (builder.io on Devin). v1 showed current state only — an operator returning after an hour reconstructed history from a timeline chart.
4. **Three disconnected surfaces** (graph / tasks table / timeline) with tab flips between structure and execution — the exact anti-pattern Airflow 3 was rebuilt to fix (merged grid+graph).
5. **Charts over answers.** ECharts mini-charts (task-state donut, debris trend) are dashboard theater: they compress numbers the operator wanted as *rows they can act on*.

## Design principles (from research synthesis)

- **P1 Attention first.** The board's job, in priority order: (1) what needs the human NOW, (2) what changed since they last looked, (3) what is everyone doing, (4) archaeology. Layout and sort order follow that priority everywhere.
- **P2 Tiny status vocabulary.** Agents have exactly four states: `working / needs-you / stale / idle` (agents have no data source for "failed"/"done" — those are TASK outcomes, which keep their own chip vocabulary). One color each, used identically in every view; status is always hue + text, never hue alone, at every width. (Amended post-review r1: the original five-state list mixed agent and task vocabularies.)
- **P3 Idle-collapse.** Idle agents collapse to one "N idle" row when >3; working/failed/selected rows never collapse (Claude Code agent-panel mechanics, copied deliberately).
- **P4 Semantic compression on timelines.** Task events group into outcome-colored spans (started→checkpoints→closed = one bar; refusals = attempt-count badge; instantaneous events = dots) — Temporal's group-span model. Raw events one click below.
- **P5 One surface, two lenses.** Structure (who owns what, handoffs) and execution (what's happening) are toggled lenses over the same selection state, never separate pages. Selecting a task in ANY lens selects it everywhere.
- **P6 Deep-linkable state.** Every filter/selection lives in the URL hash. Losing filter state on share is a documented LangSmith complaint.
- **P7 Keyboard-first.** `/` palette (jump to agent/task), `j/k` row navigation, `Enter` drill-down, `Esc` back, `?` help. Sub-100ms interactions; all rendering local.
- **P8 Re-entry digest.** On load/focus after >10 min away, a "since you left" strip: tasks that moved state, new needs-you items, closes, failures. Dismissable, one line each.
- **P9 Honest liveness.** Every agent row carries last-heartbeat age; every headless/pull-only seat shows unread-mail age. Staleness is rendered, never hidden (field evidence: the Ops seat limbo — a handoff sat unread 1.5h with no signal to anyone).

## Information architecture

Object model stays minimal: **agents, tasks, messages, events** (no new concepts — LangSmith's dense taxonomy is the named anti-pattern).

```
┌──────────────────────────────────────────────────────────────┐
│ header: swarm name · counts · freshness dot · since-you-left │
├──────────────────────────────────────────────────────────────┤
│ NEEDS YOU (attention queue — always first, hidden when empty)│
│  · one row per blocking item: kind, who, age, jump-to        │
├──────────────────────────────────────────────────────────────┤
│ AGENTS (roster)                                              │
│  · row: status-dot name task-slug last-event-summary age     │
│  · idle-collapse per P3; failed/needs-you sort to top        │
├──────────────────────────────────────────────────────────────┤
│ TASKS (swimlanes, the primary work surface)                  │
│  · one lane per active task: state chip, owner, claim kind,  │
│    checkpoint age, branch/unpushed badge, event group-spans  │
│  · lens toggle on the same selection: [flow] shows ownership │
│    /handoff/review edges as a small inline dag for the       │
│    SELECTED task only (not a fleet-wide canvas)              │
├──────────────────────────────────────────────────────────────┤
│ inspector drawer (right, slides over): selected agent/task — │
│  full event feed (virtualized), checkpoint text, evidence,   │
│  actions (focus terminal, copy slug, copy send-command)      │
└──────────────────────────────────────────────────────────────┘
```

Mobile/narrow (<700px): sections stack; roster and lanes become cards; inspector becomes full-screen sheet.

## Live updates

SSE (`/api/events`): server pushes `snapshot` (full board JSON, on connect and on reconnect) then incremental `change` events (agent heartbeat, task event, message, janitor tick). Client applies deltas; EventSource auto-reconnect gives resilience for free. Poll fallback at 5s if SSE unavailable. (Event-sourced substrate per OpenHands lesson; the task_events table is already append-only — the server tails rowids.)

## Visual language

Dark-first, terminal-adjacent: monospace numerals, high-contrast status hues on a near-black ground, generous row density (Vercel-style), zero decorative chrome, no charts unless a chart answers an operator question better than rows do. Light theme via `prefers-color-scheme`. All assets vendored (CSP unchanged: no external hosts).

## Cut from v1 (deliberately)

- Fleet-wide Cytoscape canvas (replaced by per-task inline flow lens) — cuts 480KB of vendor JS.
- ECharts (timeline group-spans render as plain DOM/SVG; debris trend becomes a janitor row) — cuts 1MB.
- Mermaid stays CLI-side only (`board --graph` file output), not in the served board.

## Stack

(From OUT-ui-frontend.md; recorded after that report landed — see Addendum A.)

## Server changes

- Keep: token+Host+CSP guard, `/api/board` snapshot, `/api/focus-agent`.
- Add: `/api/events` (SSE), `since you left` computed server-side from last-seen cursor (client sends its high-water event id).
- board-data.ts projection extended with: per-agent last-event summary, needs-you item kinds (blocking question, review request, escalation, failure, stale-heartbeat), unread-mail age per agent.

## Acceptance

- Operator answers "what needs me / what changed / what's everyone doing" in <5s each from a cold tab.
- Board legible at 1440px, 1024px, 700px, and 390px.
- No interaction >100ms; initial render <300ms on the mini.
- Keyboard-only operation possible for every read path.
- 283+ tests stay green; new tests: SSE endpoint, needs-you projection kinds, since-you-left cursor math.

## Addendum A — stack (locked 2026-07-22, per OUT-ui-frontend.md)

- **UI:** Preact 10.29.x + HTM 3.1.1, vendored browser ES modules, no build step, no JSX. One normalized store; render notifications batched to requestAnimationFrame.
- **Transport (snapshot-stream contract, amended post-review r1):** ONE SSE stream (`/api/events`), authenticated by an HttpOnly SameSite=Strict cookie minted by the `/` page (EventSource cannot set headers; the token never appears in URLs). Every frame is a FULL self-superseding board snapshot — deliberately NOT a delta/replay protocol: at fleet scale (<50 agents) a coalesced snapshot every ≥1s is smaller than the machinery to patch, and reconnect correctness is simply "adopt the next snapshot". `streamId` = server epoch (daemon restart detection); `seq` is per-connection and strictly monotonic (stale-duplicate guard only). Comment heartbeats ~12s; slow clients are disconnected rather than buffered; change detection covers every projected source (task events, messages, deliveries/acks, agent heartbeats and membership, grants, janitor ticks) and only advances its high-water mark on successful emits. Polling fallback (2s visible / 20s hidden, single generation, no overlap) engages when EventSource is missing, throws, closes, or goes silent past the 45s watchdog. The `after=<seq>` replay-ring design is the documented escalation if fleet size ever makes full snapshots expensive.
- **CSS:** hand-written dark-first tokens (Open Props borrowed as reference, not vendored wholesale); system fonts; 26px fixed rows; tabular numerals; `color-scheme`; status = hue + text/icon (never hue alone); `prefers-reduced-motion` honored.
- **Timeline:** CSS Grid swimlanes (chronology) — NOT a graph widget. Per-task flow lens: hand-laid SVG (<10 nodes, 3-column layered); d3-dag is the named escalation if topology grows.
- **Feed:** hand-rolled fixed-row virtualizer (spacer + translateY, rAF-coalesced passive scroll, keyed by event id, ring-buffer bounded); tail-follow releases when scrolled up ("N new events" resume chip); log text rendered as text nodes only (no innerHTML); TanStack Virtual is the named escalation for variable-height rows.
- **CSP (tightened from v1):** default-src 'none'; script-src 'self'; script-src-attr 'none'; style-src 'self'; style-src-attr 'none'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'. No inline anything; virtualizer positions via DOM style properties (allowed under style-src-attr 'none').
- **Vendoring:** vendor-lock manifest with upstream URL + SHA-256 per artifact; release script scans built assets for http(s):// references; no service worker.
- **Authorship (model inversion):** claude authors; codex (gpt-5.6-sol xhigh) adversarial-reviews with the claude-author prior (hunt missing behavior first).

## Known limits (accepted post-review r1, revisit if felt)

- Feed anchor preservation across head-eviction of the 200-event window is not
  implemented (appended-count tracking is): a scrolled-up reader can see a
  one-row shift when the window slides. Escalation: anchor by top-visible
  event id.
- Cursor navigation (j/k) skips the collapsed-idle row; native Tab reaches it.
- Digest scope is the 200-event window; a very long absence shows needs-you
  items plus the newest events only (truncation is not yet labeled).

---

# Appendix B — Doctrine backstop (install into each repo's AGENTS.md / CLAUDE.md)

> Referenced by Part I §2.11 and installed at Part I §9 P0. This is the drop-in text placed into each collaborative repo's agent-facing docs so every agent — swarm-coordinated or not — inherits the working agreements.

Canonical source for the "Working agreements (all agents)" section installed into
repos where multiple humans and agents collaborate (PromptEden app + marketing
first). The point of a backstop: these rules bind ANY agent working the repo —
swarm-coordinated or not, whichever human drives it — because they live in the
files every agent CLI reads. Keep this file canonical; repo copies cite it.

Install: copy the section below into the repo's `AGENTS.md` and `CLAUDE.md`
(or `@`-include it), adjusting the repo-specific list at the bottom.

---

## Working agreements (all agents) — swarm doctrine backstop

These rules apply to every AI agent in this repo, regardless of which human
runs it or which CLI it is. They are the distillation of field-tested swarm
doctrine (see swarm repo `docs/philosophy.md`); the swarm CLI enforces them
mechanically where it is installed, but they bind even without it.

1. **One writer per branch/worktree; paths are shared advisorily.** The hard
   boundary is the branch and worktree: never work in another agent's worktree
   and never push to a branch you don't own — freeze and fork instead. Editing
   files that another task also touches is ALLOWED and expected — coordinate it
   with an advisory reservation (rule 11): you are warned on overlap and may
   override with a reason. Do not treat task ownership as a file lock. Branch
   naming: `swarm/<human>/<task-slug>/e<epoch>` (or `<human>/<slug>` outside
   swarm mode).
2. **Worktree isolation.** One writing agent per checkout. Never run two
   writing agents in the same working tree.
3. **Completion claims require evidence.** "Done" means: the artifact exists
   and you cite it — commit SHA reachable from the target branch, passing test
   output, a green CI run id, a deployed URL that responds. A claim without
   its artifact is an acknowledgment, not a fact. State what you did NOT
   establish alongside what you did.
4. **Cross-family adversarial review (model inversion).** Gate-critical
   changes get reviewed by a DIFFERENT model family than the author
   (Claude-authored → GPT/Codex reviews; Codex-authored → Claude reviews) with
   fresh context. Priors: hunt missing behavior in Claude-authored code; hunt
   build breakage in Codex-authored code. "Looks good" is not a review —
   evidence required: file/line, counterexample, or failing test.
5. **No self-merge; the repo's landing authority merges.** PR → green CI →
   cross-family review → the repository's single named **landing authority**
   merges (not just any human or lead), and only when the pre-landing check
   binds the exact head SHA to a still-valid submission. No exceptions for
   small fixes; the only bypass is the audited break-glass.
6. **CI is a budget.** Open PRs as DRAFTS; flip ready-for-review only when the
   work is review-ready. Never push empty commits to retrigger CI; never loop
   CI on a red you don't understand.
7. **Secrets never enter model-visible files.** No keys, tokens, or passwords
   in code, docs, prompts, commit messages, or PR bodies. If a task touches a
   credential file, STOP and escalate to your human first.
8. **Destructive operations are operator-gated.** `git clean`, force-push,
   branch deletion, history rewrite, data deletion, prod mutations: only with
   explicit human approval, stated in the task/PR record.
9. **Externalize state continuously.** Long tasks checkpoint durable state
   (what's decided, what failed, next action) into the task ledger or PR
   description as you go — assume your session can die at any moment and a
   successor (or another human's agent) must resume from artifacts alone.
10. **When blocked, say so early.** >30 min blocked → surface it to your
    human/lead with the exact blocker. Never loop silently; never widen scope
    to route around a blocker without approval.
11. **Reserve work socially, override transparently.** Before starting
    multi-file or multi-agent work, place an advisory reservation on the
    area/files you're taking (identity + a short TTL) so others have
    situational awareness — it warns, it does not block. If you must work a
    scope someone else has reserved, override it WITH A STATED REASON and let
    the holder know; don't silently collide. Reservations are awareness, not
    permission — landing to a protected branch is still the repo's single
    landing authority's call.
12. **Read the design before you change it; keep it current.** If the
    component has a living design doc (`DESIGN.md` or equivalent), read it
    before starting and update it in the SAME PR as your change, so it never
    goes stale. If your change contradicts the recorded design, FLAG the
    component's owner/landing authority rather than silently diverging — design
    conflicts are cheapest to resolve before the work, not at merge.

Repo-specific (edit per repo):
- Protected branches, required checks, CODEOWNERS paths: see `.github/`.
- Landing authority (who merges to protected branches): name them here.
- Shared-environment apply points that are hard-gated at apply, not by file
  locks (DB migrations applied to shared databases, prod deploys): list them
  here. Editing these files stays advisory; only their *application* is gated.
- Living design docs (component → `DESIGN.md` path): list them here.
- Actions budget note if metered.
