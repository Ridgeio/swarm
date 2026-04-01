# Swarm

Cross-terminal agent coordination CLI via Cmux.

## Dev Commands

- `npm run build` — Compile TypeScript to `dist/`
- `npm test` — Run tests (uses tsx for direct TS execution)
- `npm run dev` — Watch mode

## How It Works

Agents register via `swarm join <name>`, which stores their Cmux surface ID and parent shell PID in SQLite (`~/.swarm/swarm.db`). Messages are pushed to other terminals via `cmux send` + `cmux send-key Enter`. Stale agents are cleaned up by checking if their parent shell PID is still alive.

## Architecture

- `src/transport.ts` — Cmux wrapper (send, read-screen, binary resolution)
- `src/db.ts` — SQLite init with WAL mode
- `src/registry.ts` — Agent CRUD and stale cleanup
- `src/mailbox.ts` — Message send/broadcast/inbox with cursor
- `src/index.ts` — CLI entry point

## Security Notes

- Messages are sanitized (strip `\n`, `\r`, `\t`) to prevent injection via `cmux send`
- Uses `execFileSync` (not `execSync`) to avoid shell injection
- `swarm read` can see any agent's terminal output — treat the swarm as a trusted environment
