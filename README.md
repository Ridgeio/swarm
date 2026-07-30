# swarm

Cross-terminal and cross-agent coordination for AI coding agents. Supports local agents running in [Cmux](https://cmux.dev) and remote agents via the [A2A (Agent-to-Agent) protocol](https://google.github.io/A2A/).

Send messages between Claude Code, Codex, Grok CLI, OpenClaw, Hermes, and any A2A-compatible agent — monitor what other agents are working on and coordinate multi-agent workflows from the terminal. Swarm can run multiple independent project swarms at the same time, so each codebase can have its own Lead and agent set.

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

**Cmux agents** (Claude Code, Codex CLI, Grok CLI) register with `swarm join`. Messages are durable SQLite rows; terminal delivery is an immediate nudge, while the awareness hook peeks at pending deliveries until the recipient explicitly acknowledges them.

**A2A agents** (OpenClaw, Hermes, or any agent with an A2A-compatible endpoint) register with `swarm register-a2a` and receive messages delivered over HTTP via the A2A protocol. This enables cross-user and cross-machine coordination.

**Named swarms** isolate project teams. Agent names are unique per swarm, so `Lead` can exist in several codebases without message leakage.

## Prerequisites

- **macOS** (Cmux is macOS-only; A2A agents can run on any platform)
- **[Cmux](https://cmux.dev)** installed and running (for local terminal agents)
- **Node.js >= 20** (`node --version` to check)
- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)**, **[Codex CLI](https://github.com/openai/codex)**, and/or **[Grok CLI](https://x.ai/cli)** for Cmux agents
- Any A2A-compatible agent (e.g., OpenClaw, Hermes) for remote coordination

## Install

```bash
git clone https://github.com/Ridgeio/swarm.git
cd swarm
npm install
npm run build
./install.sh
```

The install script auto-detects which agents you have installed (Claude Code, Codex CLI, Grok CLI, Gemini) and configures skills for each:

- **Claude Code**: installs `/swarm`, `/join-swarm`, `/leave-swarm`, `/reset-swarm` skills as symlinks + a `UserPromptSubmit` hook for persistent swarm awareness
- **Codex CLI**: installs `swarm`, `join-swarm`, `leave-swarm`, `reset-swarm` skills into `~/.codex/skills` + durable coordination instructions at `~/.codex/swarm-instructions.md`
- **Grok CLI**: installs the same skills as symlinks under `~/.grok/skills` + a global `UserPromptSubmit` hook at `~/.grok/hooks/swarm-awareness.json`

The awareness hook automatically reminds joined agents of their swarm identity, active members, and available commands on every turn where the host supports hooks. Codex stores durable install instructions separately from session hints in `~/.codex/swarm-session.md`; the CLI resolves the actual current identity from the terminal/session marker.

### Verify

Open a fresh Claude Code, Codex, or Grok session in Cmux. In Claude Code or Grok, run:

```
/join-swarm TestAgent --swarm test
```

In Codex, invoke the `join-swarm` skill or ask Codex to use `join-swarm` with `TestAgent --swarm test`. You should see: `Joined swarm "test" as "TestAgent" ...`. Then clean up with `/leave-swarm` (Claude/Grok) or the `leave-swarm` skill (Codex).

## Quick start

Create a project swarm, then open two or more Claude Code sessions in Cmux. In each one:

```bash
swarm create ridge --root /path/to/ridge
```

```
/join-swarm Alice --swarm ridge    # in pane 1
/join-swarm Bob --swarm ridge      # in pane 2
```

Or just `/join-swarm` with no arguments — agents will pick their own creative name.

Then from Alice's session:
```bash
swarm send Bob "please review the auth PR"
```

Bob's terminal will show: `[SWARM from Alice]: please review the auth PR`

When you're done, agents can `/leave-swarm` individually, or you can `/reset-swarm` to clear only the current swarm.

### Switching projects

Create one swarm per project and join the relevant one:

```bash
swarm create ridge --root /Users/tom/Developer/Ridge.io/app
swarm create docs --root /Users/tom/Developer/docs-site
/join-swarm Lead --swarm ridge
```

`swarm reset` clears only the selected/current swarm. Use `swarm reset --all` only when you explicitly want to wipe every swarm.

## Task-based operation

Use the durable task ledger for work that must survive context loss, agent replacement, or fleet resets. `task start --claim` declares what completion means; checkpoints preserve mechanical Git facts plus decisions, failed approaches, next action, and blockers; `handoff offer` creates a digest-bound transfer that moves the lease only after the named recipient runs `handoff accept`; and `task close` requires matching evidence plus an explicit `--not-established` ceiling. Repo-backed tasks retain the Git preservation gates for every claim kind. Tasks, task events, handoff offers, decisions, run logs, and audited overrides survive as durable evidence across agent replacement; ledger rows survive `swarm reset`.

For asynchronous work, use the two-phase path:

```bash
swarm handoff offer auth-refresh --to Bob --ttl 15m
swarm handoff status auth-refresh
# Bob, after reading the exact charter:
swarm handoff accept auth-refresh --offer 7
```

The source owner retains the current lease and epoch until acceptance. The offer stores the source epoch, charter SHA-256, pickup deadline, pointer message ID, and delivery/ack state. An expired offer becomes a durable dead letter and does not transfer authority. The older `swarm handoff <slug> --to <agent>` form remains for compatibility but transfers immediately and is unsafe when recipient pickup is uncertain.

`task close` only records a disposition; it never performs a merge. For a `code-merged` task, `--disposition merged` verifies that the task commit is reachable from origin's default branch (`origin/HEAD`, then `origin/main` or `origin/master`).
With a local `file://` remote, the operator merges in the default-branch checkout and pushes that branch; fetch it in the task repository if needed, then retry close. Pushing only the feature branch is enough for `pr`, never for `merged`.

Claim kinds are `code-merged`, `journey-works`, `deploy-healthy`, `analysis`, `decision`, and `probe`. Evidence uses repeatable `--evidence <kind>:<ref>` flags. `swarm run` executes an argv array without a shell, stores the full combined log under `~/.swarm/evidence/<swarm>/<task>/`, prints a bounded summary, and returns the child exit code. `--override --reason <text>` also requires a live matching `override` grant and records both grant use and the bypassed gates.

## Grants and escalations

Use typed grants for time-bounded authority and `swarm escalate` for the decision-ready request. A `code-merged` task closing with `--disposition merged` needs a live `merge` grant matching its slug or branch. Resources match exactly, globally with `*`, or by a trailing-prefix wildcard such as `swarm/Foreman/*`.

```bash
swarm grant create --op merge --resource my-task --ttl 2h --to Alice
swarm grant list --live
swarm grant revoke 12
swarm escalate my-task --question "May this branch merge?" --to Lead
```

Escalation packets are written under `~/.swarm/briefs/escalations/`; the mailbox carries only the packet path. Future production and spending commands must enforce the same live, matching `prod` or `spend` grant check; no such command exists yet. See [docs/ROUTING.md](docs/ROUTING.md) for when to grant or escalate, and keep credentials out of notes, packets, and evidence as required by [docs/credentials.md](docs/credentials.md).

Use `swarm review <task-slug>` to route gate review to a live reviewer from a different model family; same-family exceptions require `--same-family-ok --reason "<text>"` and are audited.

Trust model: on this trusted, single-operator machine, grants and session tokens add records, expiry, scope, and audit; they do not create cryptographic separation from a malicious local process. Local joins mint a session token and identity-resolving mutation verbs verify the matching session marker. Legacy NULL-token rows remain usable until rejoin. A2A identity remains endpoint-based.

The operating principles are in [docs/philosophy.md](docs/philosophy.md), the ledger contracts are in [docs/design/SWARM-NEXT-V1.md](docs/design/SWARM-NEXT-V1.md), and the claim/evidence contracts are in [docs/design/SWARM-NEXT-V2.md](docs/design/SWARM-NEXT-V2.md).

### Agent-facing command catalog

Run `swarm help --agent` for the compact, lifecycle-grouped command map. The catalog stays intentionally terse and points agents to [docs/ROUTING.md](docs/ROUTING.md) for doctrine.

### Harness reviews

Run `swarm harness-review <task-slug>` to render the full task timeline, checkpoints, and evidence into a dated review brief. Fill every `<FILL>` section before rerunning; completion directs the intervention into a due-dated EXP entry.

## Skills

| Command | What it does |
|---------|-------------|
| `/swarm` / `swarm` | Load the coordination protocol and command reference. |
| `/join-swarm [name] [--swarm <name>]` | Join a project swarm. Auto-picks a creative name if none given. |
| `/leave-swarm` | Leave the current swarm. |
| `/reset-swarm` | Clear the current swarm's agents, messages, and inbox state. |

Claude Code and Grok CLI expose these as slash commands (`/join-swarm`, etc.). Codex loads them as skills from `~/.codex/skills`; invoke the matching skill name, for example `join-swarm`.

## CLI Reference

```
Swarm selection:
  --swarm <name>, -s <name>                  Run the command in a named swarm

Swarm management:
  swarm create <name> [--root <path>]        Create/update a named swarm
        [--description <text>]
  swarm swarms                               List known swarms
  swarm delete <name>                        Delete a non-default swarm

Messaging:
  swarm send <agent>[,<agent>...] <message>   Send to one or more agents
        [--kind <kind>] [--supersedes <id>]
        [--interject|--now]
  swarm broadcast <message>                   Send to every agent in this swarm
        [--kind <kind>] [--supersedes <id>]
        [--interject|--now]
  swarm inbox [--peek|--unread|--recent [N]]  Read pending or historical messages
        [--wait <seconds>]
        [--kind <kind>]
  swarm ack <msg-id...>                       Acknowledge exact pending deliveries
  swarm redeliver [--dry-run]                 Retry eligible push notifications

Task ledger:
  swarm task start <slug> --title <text>       Create or claim a fenced task lease
        [--repo <path>] [--no-worktree] [--takeover] [--claim <kind>]
  swarm task checkpoint <slug> [--notes <text>] Record a numbered durable checkpoint
  swarm task close <slug> --disposition <kind> Close with pr|merged|archive|discard evidence
        --not-established <text> [--evidence <kind>:<ref>]
        [--outcome inconclusive] [--force-discard]
        [--override --reason <text>]
  swarm task reopen <slug> --reason <text>      Reactivate done/abandoned work
        [--takeover]
  swarm run [--task <slug>] -- <cmd> [args...] Capture a full task evidence log
  swarm harness-review <task-slug>             Review a task's handoff loop
  swarm grant create --op <op> --resource <r>   Create an expiring scoped grant
        --ttl <30m|2h|1d> [--to <agent>] [--note <text>]
  swarm grant list [--live]                     List grants
  swarm grant revoke <id>                       Revoke a grant
  swarm escalate <slug> [--question <text>]     Write and send an escalation packet
        [--to <agent>]
  swarm review <slug> [--to <agent>]            Route a cross-family gate review
        [--same-family-ok --reason <text>]
  swarm task list                              List the durable task ledger
  swarm task show <slug>                       Show task facts, events, and decisions
  swarm handoff offer <slug> --to <agent>      Offer a digest-bound transfer
        [--ttl <15m|2h|1d>] [--stale-ok]
  swarm handoff accept <slug> [--offer <id>]   Accept and atomically transfer the lease
  swarm handoff decline <slug> [--offer <id>]  Decline without transferring
  swarm handoff cancel <slug> [--offer <id>]   Cancel your pending offer
  swarm handoff status [slug]                  Show pickup/dead-letter state
  swarm decision <text> [--task <slug>]        Record a durable decision
        [--supersedes <decision-id>]

Recovery and hygiene:
  swarm rescue --worktree <path>               Create and verify a rescue artifact
        | --task <slug> | --agent <name>
  swarm rescue --list                          List rescue manifests and verification state
  swarm rescue --verify <artifact-dir>         Re-verify an existing rescue artifact
  swarm janitor tick --observe                 Run the observe-only debris census
  swarm janitor roots list                     List census roots
  swarm janitor roots add|remove <path>        Manage census roots
  swarm janitor install|uninstall              Manage the launchd schedule

Operator visibility:
  swarm board [--watch [N]] [--tab]            Render fleet state or split it beside you
        [--own-workspace]                        Create the named board program workspace instead
  swarm board --graph [--out <path>] [--open]  Write and print a Mermaid workflow graph
  swarm board --serve [--port N] [--tab|--open|--print-url]
                                                Serve the live graph on 127.0.0.1
        [--watch [N]] [--tab]                    (--tab: browser pane, workspace fallback, then open)
  swarm stats [--hours <N>]                    Show messaging and debris metrics
  swarm help --agent                           Show the compact agent command catalog

Cmux Agents (local terminal sessions):
  swarm join <name> [--description <text>]   Register this terminal as an agent
        [--headless] [--push] [--force] [--force-surface] [--swarm <name>]
  swarm leave                                 Deregister from the current swarm
  swarm whoami                                Show own registration
  swarm read <agent> [--lines <n>]            Read an agent's terminal screen

A2A Agents (remote/cross-user agents):
  swarm register-a2a <name> --endpoint <url>  Register an A2A agent
        [--description <text>]
  swarm unregister-a2a <name>                 Remove an A2A agent
  swarm discover <url>                        Fetch and display an A2A agent card

Shared:
  swarm members                               List active agents in this swarm
  swarm status [--set <desc>] [--agent <name>] Update or query status

Spawning:
  swarm spawn [--cwd <path>] [--autonomous]   Spawn Claude/Codex/Grok in a new tab
    [--agent claude|codex|grok] [--name <n>]
    [--split [left|right|up|down] | --new-workspace <name>]
                                              (auto-joins the swarm after boot)

Workspace management:
  swarm rename <agent> <title>                Rename an agent's Cmux tab
  swarm move <agent> --workspace <id>         Move agent to another workspace
  swarm workspaces                            List Cmux workspaces
  swarm rename-workspace <id> <title>         Rename a workspace

Session:
  swarm reap [--name <agent>] [--force]       Prune dead agents after liveness probe
        [--all]
  swarm reset [--all]                         Clear current swarm, or every swarm
  swarm help                                  Show help
```

Joining a swarm auto-renames the agent's Cmux tab to `<swarm>/<agent>` for visual identification. A2A agents are shown with their endpoint URL in `swarm members`.

### New command examples

| Command | One-line example |
|---|---|
| Acknowledge delivery | `swarm ack 41 42` after handling those exact messages |
| Supersede an instruction | `swarm send Bob "use the revised migration plan" --kind gate --supersedes 41` |
| Start or take over a task | `swarm task start auth-refresh --title "Refresh auth" --repo . --claim code-merged --takeover` |
| Checkpoint a task | `swarm task checkpoint auth-refresh --notes "Token rotation works; next run integration tests"` |
| Capture a task run | `swarm run --task auth-refresh -- npm test` |
| Close a task | `swarm task close auth-refresh --disposition pr --not-established "production health"` |
| Close an analysis | `swarm task close design-audit --disposition archive --evidence report:/path/audit.md --not-established "runtime behavior"` |
| Audit an override | `swarm task close auth-refresh --disposition archive --not-established "none" --override --reason "operator-approved recovery"` |
| List tasks | `swarm task list` |
| Show task history | `swarm task show auth-refresh` |
| Offer a safe handoff | `swarm handoff offer auth-refresh --to Bob --ttl 15m` |
| Accept a handoff | `swarm handoff accept auth-refresh --offer 7` |
| Record a decision | `swarm decision "DECISION: keep JWT BECAUSE clients depend on it" --task auth-refresh` |
| Create a rescue | `swarm rescue --task auth-refresh` |
| List rescues | `swarm rescue --list` |
| Verify a rescue | `swarm rescue --verify ~/.swarm/archive/rescue/20260718-auth-refresh` |
| Run the janitor | `swarm janitor tick --observe` |
| Manage janitor roots | `swarm janitor roots list`, `swarm janitor roots add /path/to/projects`, or `swarm janitor roots remove /path/to/projects` |
| Install or remove scheduling | `swarm janitor install` or `swarm janitor uninstall` |
| Render once | `swarm board` |
| Keep a live board | `swarm board --watch 5` |
| Split a live board beside your work | `swarm board --tab --watch 5` |
| Create the board's named program workspace | `swarm board --tab --own-workspace` |
| Generate the workflow graph | `swarm board --graph --out ~/.swarm/board.html --open` |
| Keep the graph live in cmux | `swarm board --graph --tab --watch 5` |

Graph mode writes HTML to `~/.swarm/board.html` by default, prints raw Mermaid to stdout, and prints the file path to stderr. `--graph --tab` prefers a browser pane in the current cmux workspace, then the existing browser-workspace path, and finally the macOS system browser. Mermaid is vendored for offline use, and the raw diagram source remains as a fallback.

```bash
swarm board --serve
swarm board --serve --tab
swarm board --serve --port 7790 --print-url
```

Served mode prints a token-bearing loopback URL and stays in the foreground until Ctrl-C. `--tab` prefers a cmux browser workspace and falls back to the system browser; `--open` uses the system browser directly.
The served board includes a theme-aware fleet dashboard, a task-event timeline coordinated with graph selection, and an “Only what needs me” view. Agent inspectors can focus the agent's registered cmux terminal without accepting browser-provided surface IDs or commands.
Use the Graph | Tasks toggle to switch between the live ownership map and a sortable, filterable task table without losing the current selection.

## Example workflows

### Code review delegation

You have three agents. One is the lead, two are developers.

```
Lead:   /join-swarm Lead --swarm ridge
Dev A:  /join-swarm Alice --swarm ridge
Dev B:  /join-swarm Bob --swarm ridge
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

A lead agent can spin up new Claude Code, Codex, or Grok sessions directly. By default, `swarm spawn` opens Warp tabs when run inside Warp and Cmux surfaces otherwise:
```bash
swarm spawn --cwd /path/to/project --swarm ridge --autonomous
swarm spawn --split right --agent codex --cwd /path/to/project --swarm ridge
swarm spawn --new-workspace ridge --name Lead --cwd /path/to/project --swarm ridge
swarm spawn --agent grok --name Brillo --cwd /path/to/project --swarm ridge
swarm spawn --terminal warp --name DevA --cwd /path/to/project --swarm ridge
```

In Cmux, the default opens a new tab in the current workspace. `--split [direction]` tiles the worker beside the caller (right by default), while `--new-workspace <name>` creates an explicitly named program context; a bare `--new-workspace` is refused. The agent launches there and Claude receives `/join-swarm --swarm ridge` after boot. In Warp, the default opens a new tab via Warp's URL scheme; named Claude agents join before launch, and Codex/Grok agents receive join instructions as their initial prompt. The cmux layout flags require `--terminal cmux`. The `--autonomous` flag enables `--dangerously-skip-permissions` for Claude, `--yolo` for Codex, and `--always-approve` for Grok.

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
swarm register-a2a Cooper --swarm ridge --endpoint http://localhost:3100/.well-known/agent.json
swarm register-a2a Hermes --swarm ridge --endpoint http://localhost:3200/.well-known/agent.json
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
/join-swarm Lead --swarm ridge          # in Cmux pane 1
/join-swarm DevA --swarm ridge          # in Cmux pane 2

# Remote A2A agents
swarm register-a2a Cooper --swarm ridge --endpoint http://localhost:3100/.well-known/agent.json
swarm register-a2a Hermes --swarm ridge --endpoint http://localhost:3200/.well-known/agent.json

# Now coordinate across all of them
swarm send Cooper "research the best auth library for our stack"
swarm send DevA "implement the API routes while Cooper researches auth"
swarm send Hermes "draft the user-facing docs for the new auth flow"
```

### End of session

```bash
swarm broadcast "wrapping up for now, great work team"
```

Then either each agent runs `/leave-swarm`, or you run `/reset-swarm` to clear the current swarm. Use `swarm reset --all` only to clear every swarm.

## How agents coordinate

**Cmux/headless agents**: SQLite is the source of truth. The awareness hook peeks without consuming, records injection attempts, and keeps a delivery pending until `swarm ack <id>` (or a plain `swarm inbox` read) acknowledges it. Cmux/AppleScript push remains a best-effort nudge, not proof that work was seen or completed.

**A2A agents**: Messages are delivered via HTTP POST to the agent's registered endpoint using the [A2A protocol](https://google.github.io/A2A/). The agent processes the message and can respond through the same channel.

The skill doc (`skill/SKILL.md`) teaches agents when to check messages, how to delegate work, and how to report status. The coordination protocol is the real product; the CLI is its runtime.

## Architecture

- **`src/transport-interface.ts`** — Transport abstraction (`Transport`, `TransportAgent`, `AgentType`)
- **`src/cmux-transport.ts`** — Cmux transport: terminal push via `cmux send`
- **`src/a2a-transport.ts`** — A2A transport: HTTP delivery via `@a2a-js/sdk`
- **`src/transport-router.ts`** — Dispatcher that routes `send`/`broadcast` to the correct transport by agent type
- **`src/transport.ts`** — Low-level Cmux utilities (`send`, `read-screen`, `spawn`, tab/workspace management, `\n` sanitization, message chunking)
- **`src/db.ts`** — SQLite with WAL mode for concurrent access
- **`src/registry.ts`** — Swarm + agent CRUD, A2A registration, async stale cleanup
- **`src/mailbox.ts`** — Swarm-scoped message send/broadcast/inbox with cursor tracking
- **`src/tasks.ts`** — Fenced task leases, checkpoints, evidence-gated close, handoff, and decisions
- **`src/rescue.ts`** — Verified preservation artifacts and manifest verification
- **`src/janitor.ts`** — Observe-only debris census, heartbeat, hook trigger, and launchd schedule
- **`src/board.ts`** — Read-only fleet/task/debris/quota rendering, watch loops, and Mermaid graph/HTML output
- **`src/index.ts`** — CLI entry point
- **`hooks/swarm-awareness.sh`** — Claude Code UserPromptSubmit hook that injects swarm context and refreshes heartbeats
- **`hooks/swarm-awareness-headless.sh`** — Headless awareness hook used where a host can poll inbox messages

State is stored in `~/.swarm/swarm.db`. Swarm-scoped tables include agents, messages, per-recipient deliveries, inbox cursors, tasks, task events, and decisions; janitor status, findings, and snapshots provide machine-level debris history. Legacy installs are migrated into the `default` swarm. Stale Cmux agents are cleaned up when their surface is unreachable AND their heartbeat is older than 30 minutes. A2A agents are cleaned up when their endpoint fails to respond to an agent card ping AND their heartbeat is stale. The awareness hook refreshes heartbeats on every prompt, so active agents are never pruned.

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
