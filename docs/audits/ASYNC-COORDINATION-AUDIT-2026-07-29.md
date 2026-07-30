# Deterministic asynchronous coordination audit — 2026-07-29

Scope: the local Swarm CLI at `ef91f8f`, evaluated against five operator requirements:

1. offer → named-recipient acceptance → fenced lease transfer;
2. sender-visible pickup deadline, watchdog, and dead-letter/escalation;
3. durable delivery state bound to charter digest and lease epoch;
4. no unsafe `ack --all`;
5. ACL/provenance for lead and decision authority.

This audit distinguishes **delivery**, **pickup**, **acceptance**, and **authority transfer**. A successful terminal push proves only delivery attempt. It is not acceptance.

## Findings before this slice

| Requirement | Prior state | Evidence / consequence |
| --- | --- | --- |
| Two-phase handoff | Failed | `handoffTask` changed owner and incremented the epoch before sending the pointer. An inactive/missing recipient could strand the only active lease. |
| Pickup deadline / dead letter | Partial | Push retry had a bounded 30-minute window, but the sender had no message-specific pickup deadline or terminal state. Handoffs had no dead-letter state. |
| Digest + epoch binding | Failed | Handoff briefs were files referenced by a message; acceptance did not re-hash a charter, and no durable row tied the pointer to the source epoch. |
| Unsafe bulk ack | Failed | `swarm ack --all` acknowledged every live row, including unseen STOP/gate/handoff messages. |
| ACL / provenance | Partial | Session tokens authenticated several verbs, but `handoff` and `decision` used unauthenticated self-resolution. Task decisions stored only a mutable display name and any agent could supersede another agent's decision. There was no explicit lead role ACL. |

## Landed in this slice

### Handoff safety

- `swarm handoff offer <slug> --to <agent> [--ttl 15m]` writes a durable `handoff_offers` row and leaves the source owner/epoch unchanged.
- The row binds:
  - source task epoch;
  - source and recipient names plus exact agent-registration IDs;
  - immutable charter path and SHA-256;
  - pickup deadline;
  - pointer message ID and its per-recipient delivery/ack projection.
- `swarm handoff accept <slug> --offer <id>` is named-recipient-only. In one immediate SQLite transaction it:
  - refuses expired/non-pending offers;
  - verifies the exact recipient registration;
  - verifies unchanged source owner + epoch;
  - re-hashes the charter;
  - transfers the task and increments the epoch exactly once;
  - records `handoff_accepted` at the accepted epoch.
- A recipient can checkpoint/close at the accepted epoch without an extra `task start`.
- Digest mismatch, changed task authority, or changed recipient registration invalidates the offer without transferring the source lease.
- Deadline sweeps are idempotent. Expiry records `handoff_offer_expired`; hook/status output calls it a **DEAD LETTER** and explicitly says the source lease was not transferred.
- `swarm handoff status [slug]` exposes `queued`, `pushed-unconfirmed`, `pending`, `injected`, or `acked` pickup separately from offer resolution.

### Message and decision safety

- CLI `swarm ack --all` is refused with the recovery path: peek, handle, then acknowledge exact IDs.
- Handoff, decision, and grant-revoke mutations now require authenticated self-resolution.
- Task-bound decisions require the current fenced task owner and record both `actor_agent_id` and `task_epoch`.
- A decision can be superseded only by its original authenticated author and only at the same task/program scope.

## Verified invariants

The dedicated tests prove:

- offer does not change source owner or epoch;
- ordinary inbox pickup becomes sender-visible as `acked`;
- exact-recipient acceptance transfers epoch 1 → 2;
- the former owner is fenced and the recipient can checkpoint at epoch 2;
- charter mutation invalidates without transfer;
- same-name recipient rejoin cannot accept an offer bound to the prior registration;
- expiry is idempotent and late acceptance cannot transfer;
- `ack --all` leaves an injected gate live;
- task decision provenance stores exact agent ID + epoch and rejects non-owner writes/foreign supersession.

## Honest residual gaps

This is a coherent high-value slice, not the complete coordination control plane:

1. **The watchdog is opportunistic, not a daemon.** Acceptance always fails closed after the deadline, so authority safety is deterministic. The visible `pending → expired` row is materialized on hook, status, a new offer, or acceptance. No long-lived process currently wakes the sender at the deadline.
2. **Deadlines are handoff-specific.** General STOP, gate, blocking-question, and required-reply messages retain durable per-recipient rows and hook injection, but a sender cannot yet declare `response_required_by` or an escalation target.
3. **No lead ACL exists.** Any authenticated agent can still create grants and record program-scope decisions. The database has no explicit immutable Owner/Lead role assignment or authority-transfer event.
4. **Legacy compatibility remains a bypass.** `swarm handoff <slug> --to <agent>` still transfers immediately and now emits a warning. New asynchronous workflows must use `handoff offer`; making the safe path the only/default path is a deliberate compatibility-breaking follow-up.
5. **Trust-model caveats remain.** Legacy NULL-token rows and A2A endpoint identity are grandfathered. A malicious same-user local process can read SQLite/session material.
6. **Library-only bulk ack remains.** The exported `acknowledgeAllMessages` helper remains for source compatibility, while the operator-facing CLI refuses it. It should be removed after downstream-call inventory.

## Next bounded slice

Add a generalized durable `required_actions` envelope:

- kind: STOP / gate / question / reply / handoff;
- exact sender/recipient agent IDs and source task epoch;
- payload/charter digest;
- `required_by`, pickup state, response state, supersession lineage;
- one per-host watchdog that transitions overdue rows to dead-letter exactly once and emits a routed escalation;
- explicit swarm roles (`owner`, `lead`, `member`, `auditor`) with authenticated, event-logged role transfer;
- ACL enforcement for grant creation/revocation, program decisions, and escalation resolution;
- make two-phase handoff the default and put immediate transfer behind a separately granted recovery verb;
- remove the library bulk-ack helper after call-site inventory.
