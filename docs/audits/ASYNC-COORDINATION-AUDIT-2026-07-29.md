# Deterministic asynchronous coordination audit — 2026-07-29

Scope: the hardening successor to `0dadc34`, evaluated against the operator's asynchronous-control requirements and the blocking adversarial findings. Delivery, pickup, acceptance, and authority transfer are distinct states: a successful terminal/A2A push is never treated as acceptance.

## Closed blocking findings

| Control | Landed invariant |
| --- | --- |
| Immutable authority | Tasks, task events, direct deliveries, roles, grants, decisions, and handoff parties bind immutable registration IDs. A same-name rejoin receives a new ID and inherits none of them. |
| Legacy ownership | A task with a NULL owner ID refuses privileged mutation. `task rebind --to --reason` is an explicit Owner/Lead-only recovery that bumps the epoch and records authorization plus rebound events. |
| Current checkpoint | Every draft carries a random generation marker durably bound to its creating owner registration and lease epoch. Reuse requires that exact marker; a successor preserves but never adopts a prior-owner or overwritten draft. A completed event binds the final content digest, and handoff revalidates marker+digest before copying bytes into a charter. |
| Owner/Lead ACL | The first privileged local registration bootstraps Owner and Lead for its exact ID. Only an active Owner/Lead may assign those roles, create/revoke grants, take over/recover another registration's task, or make program-scope decisions. |
| Grant provenance | Grant issuer and recipient IDs are durable. Expiry checks use a persisted monotonic scope clock. Same-name replacements cannot consume old grants. |
| Decision provenance | Task decisions require the exact current task owner+epoch; program decisions require Owner/Lead. Only the exact original active author may supersede an active decision at the same scope, and an immediate transaction plus unique fence permits one successor. |
| Safe handoff only | Immediate handoff is removed. The only transfer path is offer → exact named-registration acceptance. |
| Commit-before-push | Offer, accept, decline, takeover, review, escalation, and expiry notifications enqueue their canonical message, exact-recipient delivery, and durable outbox row in the same immediate transaction as the state/event change. Push happens only after commit. |
| Crash recovery | Failpoints after commit/before push prove that canonical state and a pending outbox row survive. The outbox retry path can finish delivery without reconstructing the transition. |
| Fleet deadline sweep | Every janitor tick sweeps every registered swarm. Expiry transitions once and creates exactly one durable notification row per source/authority audience, deduplicating an agent that holds both roles. |
| Clock rollback | Handoff and grant deadline scopes persist their last observed wall time. A rollback fails closed instead of extending or reviving authority. |
| Privileged identity | Privileged mutations require an active local registration with a non-NULL token matching the session marker. Legacy NULL-token and A2A identities retain read/messaging compatibility but cannot mutate privileged coordination state. |
| Reset generation | Reset revokes every live in-scope grant, terminally expires pending required replies, and clears role bindings before removing agents. The next token-bound local join can bootstrap fresh Owner/Lead IDs; surviving task leases remain fenced until authorized takeover/rebind. |
| Exact acknowledgement | `ack --all` is refused and the former library bulk-ack helper is removed. Only explicit message IDs can be acknowledged. |
| Quiet message doctrine | User-authored `--kind ack` is refused. Skills, hooks, and operator doctrine require one final packet or blocker, with delivery acknowledgement kept as exact-ID metadata. |
| Required ordinary replies | `send --require-reply <ttl>` atomically binds requester ID, recipient ID, message ID, and deadline. Reading/acking does not resolve it; only the exact directed `--reply-to <message-id>` does. Late replies and rollback fail closed. |
| Inactive-party escalation | The fleet janitor expires required replies when either exact party is inactive or the deadline passes, suppresses the stale live request, and queues exactly-once requester/Owner/Lead audience rows. |
| Rescue delivery | `rescue ... --to` re-verifies the artifact, records its manifest digest and exact successor ID in the task event, and queues a digest-bound pointer to only that registration. Same-name replacements cannot inherit it. |
| Parser no-op | `decision --help`, unknown options, missing values, and misspelled coordination-shaped send/broadcast options exit before durable mutation. Regression tests assert row counts stay unchanged. |

## Handoff state machine

1. The current ID+epoch owner creates a current checkpoint.
2. `handoff offer` composes and hashes the immutable charter.
3. One immediate transaction inserts the pending offer, its audit event, pointer message, exact-recipient delivery, and outbox row. The source lease remains unchanged.
4. Push is attempted after commit. Failure changes delivery state only; it cannot erase the offer.
5. Only the offer's exact recipient registration may accept. Acceptance re-hashes the charter and verifies source ID, source epoch, recipient ID, deadline, and monotonic clock.
6. One immediate transaction transfers owner name+ID, increments the epoch, resolves the offer, records the acceptance event, and queues the source notification.
7. Expiry or invalidation never transfers authority. The janitor records expiry and durable escalation; late acceptance independently fails closed even if the janitor has not run.

## Adversarial negative controls

The hardening suite exercises:

- same-name rejoin cannot inherit task, Owner/Lead role, grant, direct-recipient message, or decision-author authority;
- a member cannot create/revoke grants, make a program decision, or recover another owner's task;
- a prior-owner incomplete draft and a delayed prior-owner overwrite are preserved but cannot be adopted or authorize handoff after takeover; post-record byte changes also fail digest verification;
- a second decision successor and supersession by a reassigned same-name registration both fail;
- crashes after offer/accept commit but before push leave atomic durable state and retryable outbox rows;
- one janitor tick expires offers in multiple swarms and repeated ticks create no duplicate audience rows;
- handoff, grant, and required-response clocks reject rollback;
- legacy NULL-token and A2A identities can read but cannot perform privileged mutations;
- help, unknown options, missing values, and a misspelled `--require-reply` create no durable rows;
- exact acknowledgement leaves every unlisted STOP/gate/handoff delivery live;
- inbox acknowledgement cancels its exact queued push but leaves a required-response obligation pending;
- late replies and same-name replacements cannot resolve another registration's request;
- repeated required-response sweeps create no duplicate requester/Owner/Lead audience rows;
- a rescue pointer carries a verified manifest digest and remains invisible to a same-name successor replacement.

The release gate is the full TypeScript build and test suite on the exact candidate SHA, followed by a fresh cross-family adversarial review. Verdicts from `0dadc34` or earlier are not reusable.

## Honest residual boundaries

1. **Push transport is at-least-once, durable state is exactly-once.** The SQLite transition/outbox and expiry-audience rows are uniqueness-fenced. A process can still crash after an external push succeeds but before marking the outbox row pushed, so a retry may duplicate the terminal nudge. Consumers must continue treating the inbox row/ID as canonical.
2. **Required-response deadlines are deliberately direct-message only.** A broadcast cannot create an ambiguous N-party response contract. Use one direct `--require-reply` per accountable registration or a task handoff for ownership pickup.
3. **The local-machine trust boundary remains.** These controls stop stale, unauthenticated, A2A, and ordinary member actions through supported APIs. They do not defend against a malicious same-user process that edits SQLite or steals a live session token.
4. **Wall-clock rollback fails closed; forward jumps expire early.** This is the conservative authority-safety choice until a trusted time source exists.
5. **Filesystem cleanup remains observe-only.** The janitor mutates only coordination-ledger deadline/audit/outbox state; it still never deletes repositories, worktrees, or artifacts.
