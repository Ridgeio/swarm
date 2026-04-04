# Swarm

Cross-terminal agent coordination CLI via Cmux and A2A protocol.

## Dev Commands

- `npm run build` — Compile TypeScript to `dist/`
- `npm test` — Run tests (uses tsx for direct TS execution)
- `npm run dev` — Watch mode

## How It Works

Swarm supports two transport types:

- **Cmux agents** (Claude Code, Codex) register via `swarm join <name>`, which stores their Cmux surface ID in SQLite (`~/.swarm/swarm.db`). Messages are pushed via `cmux send` + `cmux send-key Enter`.
- **A2A agents** (OpenClaw, Hermes, etc.) register via `swarm register-a2a <name> --endpoint <url>`. Messages are delivered via the A2A protocol over HTTP. This enables cross-user and cross-machine coordination.

Stale agents are cleaned up by checking liveness (Cmux surface check or A2A agent card ping) combined with a 10-minute heartbeat threshold.

## Architecture

- `src/transport-interface.ts` — Transport abstraction (`Transport`, `TransportAgent`, `AgentType`)
- `src/cmux-transport.ts` — Cmux transport implementation
- `src/a2a-transport.ts` — A2A transport implementation (uses `@a2a-js/sdk`)
- `src/transport-router.ts` — Dispatcher that routes to the correct transport by agent type
- `src/transport.ts` — Low-level Cmux utilities (send, read-screen, binary resolution)
- `src/db.ts` — SQLite init with WAL mode, schema migrations
- `src/registry.ts` — Agent CRUD, A2A registration, async stale cleanup
- `src/mailbox.ts` — Async message send/broadcast/inbox with cursor
- `src/index.ts` — CLI entry point (async main)

## Security Notes

- Messages are sanitized (strip `\n`, `\r`, `\t`) to prevent injection via `cmux send`
- Uses `execFileSync` (not `execSync`) to avoid shell injection
- `swarm read` can see any Cmux agent's terminal output — treat the swarm as a trusted environment
- A2A agents communicate over localhost HTTP — no authentication required for local-only use
