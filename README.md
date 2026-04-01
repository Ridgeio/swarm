# swarm

Cross-terminal agent coordination for AI coding agents running in [Cmux](https://cmux.dev).

Send messages between Claude Code sessions, monitor what other agents are working on, and coordinate multi-agent workflows — all from the terminal.

## How it works

```
┌─────────────┐          ┌─────────────┐
│ Claude Code  │  swarm   │ Claude Code  │
│ (Agent A)    │◄────────►│ (Agent B)    │
└──────┬───────┘  send    └──────┬───────┘
       │                         │
       └────────┬────────────────┘
                │
         ~/.swarm/swarm.db
         (shared SQLite)
```

Agents register with `swarm join`, then communicate via `swarm send`. Messages are pushed directly into the target agent's terminal using Cmux's native `send` command — the same push-based delivery that made [AgentSwarm](https://github.com/tlangridge/agent-swarm) work, but without a web UI.

## Install

```bash
git clone https://github.com/tlangridge/swarm.git
cd swarm
npm install
npm run build
```

Then either add the `bin/` directory to your PATH, or use the absolute path to `bin/swarm`.

## Quick start

In Cmux, open two Claude Code sessions. In each one:

```
/join-swarm Alice    # in pane 1
/join-swarm Bob      # in pane 2
```

Then from Alice's session:
```bash
swarm send Bob "please review the auth PR"
```

Bob's terminal will show: `[SWARM from Alice]: please review the auth PR`

## CLI Reference

```
swarm join <name> [--description <text>]   Register this terminal as an agent
swarm leave                                 Deregister from the swarm
swarm send <agent> <message>                Push a message to an agent's terminal
swarm broadcast <message>                   Push to all agents
swarm inbox [--peek]                        Read pending messages
swarm members                               List active agents
swarm status [--set <desc>] [--agent <name>] Update or query status
swarm whoami                                Show own registration
swarm read <agent> [--lines <n>]            Read an agent's terminal screen
swarm help                                  Show help
```

## Claude Code skill

The `/join-swarm` command is a Claude Code custom slash command. To install it, copy `skill/join-swarm.md` to your Claude Code commands directory:

```bash
mkdir -p ~/.claude/commands
cp skill/join-swarm.md ~/.claude/commands/join-swarm.md
```

Edit the file to update the path to `bin/swarm` for your machine.

When any Claude Code session runs `/join-swarm AgentName`, it joins the swarm and gets the coordination protocol instructions.

## How agents coordinate

Messages are injected directly into the target terminal via `cmux send`. The receiving agent sees it as user input and responds naturally. This is push-based delivery — agents don't need to poll.

The skill doc (`skill/SKILL.md`) teaches agents when to check messages, how to delegate work, and how to report status. The coordination protocol is the real product; the CLI is its runtime.

## Architecture

- **`src/transport.ts`** — Cmux wrapper (`send`, `read-screen`, binary resolution, `\n` sanitization)
- **`src/db.ts`** — SQLite with WAL mode for concurrent access
- **`src/registry.ts`** — Agent registration with surface-based stale cleanup
- **`src/mailbox.ts`** — Message send/broadcast/inbox with cursor tracking
- **`src/index.ts`** — CLI entry point

State is stored in `~/.swarm/swarm.db`. Stale agents are automatically cleaned up by checking if their Cmux surface still exists.

## Security

- Messages are sanitized (strips `\n`, `\r`, `\t`) to prevent injection via `cmux send`
- Uses `execFileSync` (not `execSync`) to avoid shell injection
- `swarm read` can see any agent's terminal output — the swarm is a trusted environment

## Requirements

- [Cmux](https://cmux.dev) terminal multiplexer
- Node.js >= 20
- macOS (Cmux is macOS-only)

## License

MIT
