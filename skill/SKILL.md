---
name: swarm
description: Use when coordinating with other AI coding agents through the local swarm CLI, including checking members, reading inbox messages, sending direct messages, broadcasting, and updating swarm status.
---

# Swarm Coordination Protocol

You are part of a coordinated swarm of AI coding agents. Each swarm is scoped to one project/codebase, so the same machine can run multiple independent swarms at the same time. Agents can run in Cmux (push delivery), any terminal in headless mode (poll-based delivery via hooks), or as A2A remote agents (HTTP delivery).

## Your Identity

When you joined this swarm, you were registered with an agent name, a swarm name, and a terminal/session marker. Run `swarm whoami` to confirm your current swarm. Run `swarm members` to see who else is active in this same swarm.

Use `--swarm <name>` when joining or when you need to address a swarm explicitly:
```
swarm join Lead --swarm ridge
swarm members --swarm ridge
```

Once joined, normal commands infer the current swarm from your terminal/session.

## Communication

### Sending Messages
Send a direct message to another agent:
```
swarm send <agent-name> "<message>"
```

The message appears directly in their terminal as input. They will see:
```
[SWARM from YourName]: <message>
```

Send to everyone:
```
swarm broadcast "<message>"
```

Messages and broadcasts stay inside the current swarm. A `Lead` in one project will not receive messages from a different project's swarm.

### Receiving Messages
Messages are pushed directly into your terminal. When you see `[SWARM from <name>]:` followed by text, that is a message from another agent. Read it, understand it, and respond appropriately.

If you think you may have missed messages (e.g., you were busy), check your inbox:
```
swarm inbox
```

### Checking on Others
See what another agent's terminal currently shows:
```
swarm read <agent-name> --lines 30
```

This lets you monitor progress without interrupting them.

### Spawning New Agents
When you need another local Claude Code agent, spawn it from the lead/current agent:
```
swarm spawn --name DevA --cwd /path/to/project --swarm <swarm-name>
```

By default, `swarm spawn` auto-selects the terminal: Warp when running inside Warp, otherwise Cmux. Use `--terminal cmux` or `--terminal warp` to force one. Cmux opens the new agent in a new tab/surface in the current workspace and auto-joins it to the selected swarm. Warp opens a new tab via Warp's URL scheme; named Claude agents join before launch, and Codex agents receive join instructions as their initial prompt.

## Coordination Protocol

### When to Send Messages
- When you need another agent to do something: `swarm send Bob "please review the auth PR on branch feat/auth"`
- When you finish a task that unblocks someone: `swarm send Alice "auth module is done, you can start on the API layer"`
- When you hit a blocker: `swarm broadcast "I'm blocked on the database migration, anyone know the schema?"`
- When you have a question for a specific agent: `swarm send Carol "what format should the API response use?"`

### When NOT to Send Messages
- Don't send status updates unless asked. Use `swarm status --set` instead.
- Don't send messages to yourself.
- Don't broadcast every small update. Reserve broadcast for things everyone needs to know.
- Don't send messages while mid-task unless it's urgent. Finish your current thought first.

### Status Updates
Report what you're working on:
```
swarm status --set "implementing user authentication"
```

Check what someone else is doing:
```
swarm status --agent Bob
```

### Swarm Selection
List known swarms:
```
swarm swarms
```

Create or update a project swarm:
```
swarm create ridge --root /path/to/codebase
```

Reset only the current swarm:
```
swarm reset
```

Reset every swarm only when explicitly asked:
```
swarm reset --all
```

### Workflow
1. **Before starting new work**: Run `swarm whoami` if unsure which project swarm you are in. Run `swarm inbox` to check for pending messages. Run `swarm members` to see who's active.
2. **When starting a task**: Run `swarm status --set "description of what I'm doing"`
3. **When you need help**: Send a targeted message to the right agent, or broadcast if unsure who can help.
4. **When you finish a task**: Notify anyone who was waiting on it via `swarm send`.
5. **When you receive a message**: Read it. If it requires action, do it (or explain why you can't). If it's informational, acknowledge briefly.

### Responding to Messages
When a message appears in your terminal as `[SWARM from <name>]: <text>`, treat it as a direct request or communication from that agent. Respond naturally. If you need to reply, use `swarm send <name> "your reply"`.

## Rules
- Be concise in messages. Other agents have limited context windows too.
- Don't argue over messages. If there's a disagreement, one message each, then move on.
- If an agent doesn't respond after one message, they may be busy. Check with `swarm read` before resending when that agent is a local terminal agent.
- This is a trusted environment. All agents can read each other's terminal output. Don't put secrets in your terminal that you wouldn't want other agents to see.
