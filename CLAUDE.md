# Swarm

Cross-terminal agent coordination CLI via Cmux and A2A protocol.

## Dev Commands

- `npm run build` — Compile TypeScript to `dist/`
- `npm test` — Run tests (uses tsx for direct TS execution)
- `npm run dev` — Watch mode

## How It Works

Swarm supports three registration/delivery modes:

- **Cmux agents** (Claude Code, Codex, Grok CLI) register via `swarm join <name>`, which stores their Cmux surface ID in SQLite (`~/.swarm/swarm.db`). Messages are pushed via `cmux send` + `cmux send-key Enter`.
- **Headless/Warp agents** register with terminal metadata. Warp push is optional; otherwise messages wait in the durable inbox.
- **A2A agents** (OpenClaw, Hermes, etc.) register via `swarm register-a2a <name> --endpoint <url>`. Messages are delivered via the A2A protocol over HTTP. This enables cross-user and cross-machine coordination.

SQLite is authoritative for delivery. The prompt hook peeks at pending rows without consuming them; explicit `swarm ack` or a normal inbox read marks per-recipient delivery rows acknowledged, cancels that exact queued push, and advances the legacy cursor. Acknowledgement is transport state, not a conversational message or completion claim. `send --require-reply <ttl>` creates an ID-bound response deadline; only `send <requester> ... --reply-to <request-id>` from the exact recipient registration resolves it, and `swarm replies [--history]` exposes its state. Superseded and expired messages remain historical but are excluded from live reads.

Tasks are durable, fenced leases bound to immutable registration IDs plus epochs and backed by append-only task events and checkpoint files. Asynchronous ownership changes use digest-bound handoff offers: the source keeps the lease until the exact named registration accepts, while expiry/tamper dead-letters without transfer. Offer/accept state and durable notifications commit before push. `swarm rescue ... --to <successor>` re-verifies the artifact, journals task provenance, and queues a manifest-digest pointer to that exact registration; it never transfers authority. Stale agents are cleaned up by liveness plus heartbeat checks; headless agents are never auto-pruned. The janitor keeps filesystem/repository inspection observe-only while sweeping handoff and required-response deadlines across every swarm and durably escalating expiry to the requester plus active Owner/Lead registrations.

## Architecture

- `src/transport-interface.ts` — Transport abstraction (`Transport`, `TransportAgent`, `AgentType`)
- `src/cmux-transport.ts` — Cmux transport implementation
- `src/a2a-transport.ts` — A2A transport implementation (uses `@a2a-js/sdk`)
- `src/transport-router.ts` — Dispatcher that routes to the correct transport by agent type
- `src/transport.ts` — Low-level Cmux utilities (send, read-screen, binary resolution)
- `src/db.ts` — SQLite init with WAL mode, schema migrations
- `src/registry.ts` — Agent CRUD, worker-version capture, A2A registration, async stale cleanup
- `src/authority.ts` — Immutable Owner/Lead registration roles and privileged authorization
- `src/clock.ts` — Persisted monotonic wall-clock fences for deadline-sensitive mutations
- `src/mailbox.ts` — Exact-recipient delivery rows, durable push outbox, required-response deadlines, supersession, inbox reads, and cursor compatibility
- `src/tasks.ts` — Fenced task epochs, checkpoints, evidence-gated close, two-phase handoff offers, and decisions
- `src/harness-review.ts` — Gated task-timeline review briefs for harness interventions
- `src/rescue.ts` — Verified preservation artifacts, manifests, and digest-bound exact-successor pointers
- `src/janitor.ts` — Observe-only debris census plus fleet-wide durable coordination-deadline enforcement
- `src/board.ts` — Read-only fleet board/watch loop plus Mermaid graph and fallback-safe HTML output
- `src/board-data.ts` — Shared read-only projection for text and served boards, including task history and debris trends
- `src/board-server.ts` + `web/` — Token/Host-guarded loopback graph, dashboard, timeline, inspector, and registry-resolved cmux focus action
- `src/index.ts` — CLI entry point (async main)

Core tables are `swarms`, `agents`, `swarm_authorities`, `messages`, `message_deliveries`, `message_outbox`, `required_message_responses`, `required_response_expiry_notifications`, `inbox_cursors`, `tasks`, `task_events`, `handoff_offers`, `handoff_expiry_notifications`, `decisions`, `grants`, `coordination_clocks`, `janitor_status`, `janitor_findings`, `janitor_snapshots`, and `janitor_kv`.

## Security Notes

- Messages are sanitized (strip `\n`, `\r`, `\t`) to prevent injection via `cmux send`
- Uses `execFileSync` (not `execSync`) to avoid shell injection
- `swarm read` can see any Cmux agent's terminal output — treat the swarm as a trusted environment
- A2A agents communicate over localhost HTTP — no authentication required for local-only message delivery, but A2A identities cannot perform privileged coordination mutations
