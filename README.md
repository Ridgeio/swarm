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

## Prerequisites

- **macOS** (Cmux is macOS-only)
- **[Cmux](https://cmux.dev)** installed and running
- **Node.js >= 20** (`node --version` to check)
- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** and/or **[Codex CLI](https://github.com/openai/codex)** installed

## Install

```bash
git clone https://github.com/Ridgeio/swarm.git
cd swarm
npm install
npm run build
./install.sh
```

The install script auto-detects which agents you have installed (Claude Code, Codex CLI) and configures skills for each:

- **Claude Code**: installs `/join-swarm`, `/leave-swarm`, `/reset-swarm` slash commands + a `UserPromptSubmit` hook for persistent swarm awareness
- **Codex CLI**: installs coordination instructions at `~/.codex/swarm-instructions.md`

The awareness hook automatically reminds agents of their swarm identity, active members, and available commands on every turn. This survives context compression and `/clear` — agents never forget they're in the swarm.

### Verify

Open a Cmux terminal with Claude Code and run:

```
/join-swarm TestAgent
```

You should see: `Joined swarm as "TestAgent" (surface: ...)`. Then clean up with `/leave-swarm`.

## Quick start

Open two or more Claude Code sessions in Cmux. In each one:

```
/join-swarm Alice    # in pane 1
/join-swarm Bob      # in pane 2
```

Or just `/join-swarm` with no arguments — agents will pick their own creative name.

Then from Alice's session:
```bash
swarm send Bob "please review the auth PR"
```

Bob's terminal will show: `[SWARM from Alice]: please review the auth PR`

When you're done, agents can `/leave-swarm` individually, or you can `/reset-swarm` to wipe everything and start fresh.

### Switching projects

Run `/reset-swarm` (or `swarm reset` from any terminal) to clear all agents and messages. Then have agents `/join-swarm` again for the new project.

## Slash Commands

| Command | What it does |
|---------|-------------|
| `/join-swarm [name]` | Join the swarm. Auto-picks a creative name if none given. |
| `/leave-swarm` | Leave the swarm. |
| `/reset-swarm` | Clear all agents, messages, and inbox state. |

## CLI Reference

```
Messaging:
  swarm send <agent> <message>                Push a message to an agent's terminal
  swarm broadcast <message>                   Push to all agents
  swarm inbox [--peek]                        Read pending messages

Agents:
  swarm join <name> [--description <text>]   Register this terminal as an agent
  swarm leave                                 Deregister from the swarm
  swarm members                               List active agents
  swarm status [--set <desc>] [--agent <name>] Update or query status
  swarm whoami                                Show own registration
  swarm read <agent> [--lines <n>]            Read an agent's terminal screen

Spawning:
  swarm spawn [--cwd <path>] [--autonomous]   Spawn a new Claude Code session
                                              (auto-joins the swarm after boot)

Workspace management:
  swarm rename <agent> <title>                Rename an agent's Cmux tab
  swarm move <agent> --workspace <id>         Move agent to another workspace
  swarm workspaces                            List Cmux workspaces
  swarm rename-workspace <id> <title>         Rename a workspace

Session:
  swarm reset                                 Clear all agents and messages
  swarm help                                  Show help
```

Joining the swarm auto-renames the agent's Cmux tab to their swarm name for easy visual identification.

## Example workflows

### Code review delegation

You have three agents. One is the lead, two are developers.

```
Lead:   /join-swarm Lead
Dev A:  /join-swarm Alice
Dev B:  /join-swarm Bob
```

The lead delegates work:
```bash
swarm send Alice "implement the user auth module in src/auth.ts"
swarm send Bob "write tests for the payment flow in tests/payment.test.ts"
```

Alice finishes and notifies Bob for review:
```bash
swarm send Bob "auth module done on branch feat/auth, can you review?"
```

Bob checks Alice's progress without interrupting:
```bash
swarm read Alice --lines 30
```

### Parallel feature development

Two agents working on separate features that share a dependency:

```bash
# Agent A notices a shared concern
swarm send AgentB "heads up, I'm refactoring the database client in src/db.ts. Don't touch that file for the next few minutes."

# Agent B acknowledges
swarm send AgentA "got it, I'll work on the API routes instead"

# Agent A finishes
swarm send AgentB "db refactor done and pushed. You can use the new query() method now."
```

### Monitoring a team

A lead agent checks on everyone:
```bash
swarm members                    # who's active?
swarm read Alice --lines 20      # what's Alice doing?
swarm read Bob --lines 20        # what's Bob doing?
swarm broadcast "status check — what's everyone working on?"
```

### Spawning new agents

A lead agent can spin up new Claude Code sessions directly:
```bash
swarm spawn --cwd /path/to/project --autonomous
```

This opens a new Cmux tab, launches Claude Code, and auto-sends `/join-swarm` after boot. The `--autonomous` flag enables `--dangerously-skip-permissions`.

### Organizing workspaces

A lead can reorganize agents across Cmux workspaces:
```bash
swarm workspaces                                    # list all workspaces
swarm move MrDev --workspace workspace:5            # move agent to another workspace
swarm rename MrDev "Senior Dev"                     # rename an agent's tab
swarm rename-workspace workspace:5 "Dev Team"       # rename a workspace
```

### End of session

```bash
swarm broadcast "wrapping up for now, great work team"
```

Then either each agent runs `/leave-swarm`, or you run `/reset-swarm` to clear everything.

## How agents coordinate

Messages are injected directly into the target terminal via `cmux send`. The receiving agent sees it as user input and responds naturally. This is push-based delivery — agents don't need to poll.

The skill doc (`skill/SKILL.md`) teaches agents when to check messages, how to delegate work, and how to report status. The coordination protocol is the real product; the CLI is its runtime.

## Architecture

- **`src/transport.ts`** — Cmux wrapper (`send`, `read-screen`, `spawn`, tab/workspace management, `\n` sanitization, message chunking)
- **`src/db.ts`** — SQLite with WAL mode for concurrent access
- **`src/registry.ts`** — Agent registration with surface-based stale cleanup (requires both dead surface + stale heartbeat)
- **`src/mailbox.ts`** — Message send/broadcast/inbox with cursor tracking
- **`src/index.ts`** — CLI entry point (20 commands)
- **`hooks/swarm-awareness.sh`** — UserPromptSubmit hook that injects swarm context and refreshes heartbeats

State is stored in `~/.swarm/swarm.db`. Stale agents are cleaned up when their Cmux surface is unreachable AND their heartbeat is older than 10 minutes. The awareness hook refreshes heartbeats on every prompt, so active agents are never pruned.

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
