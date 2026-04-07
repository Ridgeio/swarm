# swarm

Cross-terminal and cross-agent coordination for AI coding agents. Supports local agents running in [Cmux](https://cmux.dev) and remote agents via the [A2A (Agent-to-Agent) protocol](https://google.github.io/A2A/).

Send messages between Claude Code sessions, OpenClaw, Hermes, and any A2A-compatible agent — monitor what other agents are working on and coordinate multi-agent workflows from the terminal.

## How it works

```
┌─────────────┐          ┌─────────────┐
│ Claude Code  │  swarm   │ Claude Code  │
│ (Agent A)    │◄────────►│ (Agent B)    │
└──────┬───────┘  send    └──────┬───────┘
       │                         │
       └────────┬────────────────┘
                │
         ~/.swarm/swarm.db        ┌──────────────┐
         (shared SQLite)          │ OpenClaw     │
                │                 │ (A2A agent)  │
                └────── A2A ─────►└──────────────┘
                │                 ┌──────────────┐
                └────── A2A ─────►│ Hermes       │
                                  │ (A2A agent)  │
                                  └──────────────┘
```

**Cmux agents** (Claude Code, Codex CLI) register with `swarm join` and receive messages pushed directly into their terminal via Cmux's native `send` command.

**A2A agents** (OpenClaw, Hermes, or any agent with an A2A-compatible endpoint) register with `swarm register-a2a` and receive messages delivered over HTTP via the A2A protocol. This enables cross-user and cross-machine coordination.

## Prerequisites

- **macOS** (Cmux is macOS-only; A2A agents can run on any platform)
- **[Cmux](https://cmux.dev)** installed and running (for local terminal agents)
- **Node.js >= 20** (`node --version` to check)
- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** and/or **[Codex CLI](https://github.com/openai/codex)** for Cmux agents
- Any A2A-compatible agent (e.g., OpenClaw, Hermes) for remote coordination

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

Cmux Agents (local terminal sessions):
  swarm join <name> [--description <text>]   Register this terminal as an agent
  swarm leave                                 Deregister from the swarm
  swarm whoami                                Show own registration
  swarm read <agent> [--lines <n>]            Read an agent's terminal screen

A2A Agents (remote/cross-user agents):
  swarm register-a2a <name> --endpoint <url>  Register an A2A agent
        [--description <text>]
  swarm unregister-a2a <name>                 Remove an A2A agent
  swarm discover <url>                        Fetch and display an A2A agent card

Shared:
  swarm members                               List active agents (Cmux + A2A)
  swarm status [--set <desc>] [--agent <name>] Update or query status

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

Joining the swarm auto-renames the agent's Cmux tab to their swarm name for easy visual identification. A2A agents are shown with their endpoint URL in `swarm members`.

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

### Coordinating with A2A agents

Register external agents (OpenClaw, Hermes, or any A2A-compatible agent) by their endpoint:

```bash
swarm register-a2a Cooper --endpoint http://localhost:3100/.well-known/agent.json
swarm register-a2a Hermes --endpoint http://localhost:3200/.well-known/agent.json
```

Discover an agent's capabilities before registering:
```bash
swarm discover http://localhost:3100/.well-known/agent.json
```

Once registered, A2A agents participate in the swarm just like Cmux agents:
```bash
swarm send Cooper "review the auth PR on branch feat/auth"
swarm broadcast "status check — what's everyone working on?"
swarm members   # shows both [cmux] and [a2a] agents
```

Messages to A2A agents are delivered via HTTP POST. Messages to Cmux agents are pushed into their terminal. The routing is transparent — `swarm send` figures out the right transport.

### Mixed swarm (Cmux + A2A)

A typical setup with local Claude Code sessions and remote agents:

```bash
# Local Cmux agents
/join-swarm Lead          # in Cmux pane 1
/join-swarm DevA          # in Cmux pane 2

# Remote A2A agents
swarm register-a2a Cooper --endpoint http://localhost:3100/.well-known/agent.json
swarm register-a2a Hermes --endpoint http://localhost:3200/.well-known/agent.json

# Now coordinate across all of them
swarm send Cooper "research the best auth library for our stack"
swarm send DevA "implement the API routes while Cooper researches auth"
swarm send Hermes "draft the user-facing docs for the new auth flow"
```

### End of session

```bash
swarm broadcast "wrapping up for now, great work team"
```

Then either each agent runs `/leave-swarm`, or you run `/reset-swarm` to clear everything.

## How agents coordinate

**Cmux agents**: Messages are injected directly into the target terminal via `cmux send`. The receiving agent sees it as user input and responds naturally. This is push-based delivery — agents don't need to poll.

**A2A agents**: Messages are delivered via HTTP POST to the agent's registered endpoint using the [A2A protocol](https://google.github.io/A2A/). The agent processes the message and can respond through the same channel.

The skill doc (`skill/SKILL.md`) teaches agents when to check messages, how to delegate work, and how to report status. The coordination protocol is the real product; the CLI is its runtime.

## Architecture

- **`src/transport-interface.ts`** — Transport abstraction (`Transport`, `TransportAgent`, `AgentType`)
- **`src/cmux-transport.ts`** — Cmux transport: terminal push via `cmux send`
- **`src/a2a-transport.ts`** — A2A transport: HTTP delivery via `@a2a-js/sdk`
- **`src/transport-router.ts`** — Dispatcher that routes `send`/`broadcast` to the correct transport by agent type
- **`src/transport.ts`** — Low-level Cmux utilities (`send`, `read-screen`, `spawn`, tab/workspace management, `\n` sanitization, message chunking)
- **`src/db.ts`** — SQLite with WAL mode for concurrent access
- **`src/registry.ts`** — Agent CRUD, A2A registration, async stale cleanup
- **`src/mailbox.ts`** — Message send/broadcast/inbox with cursor tracking
- **`src/index.ts`** — CLI entry point
- **`hooks/swarm-awareness.sh`** — UserPromptSubmit hook that injects swarm context and refreshes heartbeats

State is stored in `~/.swarm/swarm.db`. Stale Cmux agents are cleaned up when their surface is unreachable AND their heartbeat is older than 10 minutes. A2A agents are cleaned up when their endpoint fails to respond to an agent card ping AND their heartbeat is stale. The awareness hook refreshes heartbeats on every prompt, so active agents are never pruned.

## Security

- Messages are sanitized (strips `\n`, `\r`, `\t`) to prevent injection via `cmux send`
- Uses `execFileSync` (not `execSync`) to avoid shell injection
- `swarm read` can see any Cmux agent's terminal output — the swarm is a trusted environment
- A2A agents communicate over localhost HTTP — no authentication required for local-only use. For remote endpoints, consider running behind a reverse proxy with TLS

## Requirements

- [Cmux](https://cmux.dev) terminal multiplexer (for local Cmux agents)
- Node.js >= 20
- macOS (Cmux is macOS-only; A2A agents can run on any platform)

## License

MIT
