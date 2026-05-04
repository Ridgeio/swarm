---
name: swarm
description: Coordinate with other AI coding agents through the local swarm CLI, including joining a swarm, checking messages, sending direct messages or broadcasts, updating status, and reading other Cmux agent terminals.
---

# Swarm Coordination Protocol

Use this skill when coordinating with other AI coding agents through the local `swarm` CLI.

## Start

Check your identity and peers:

```bash
swarm whoami
swarm members
swarm inbox
```

If you are not registered, use the `$join-swarm` skill or run:

```bash
swarm join "<name>"
```

## Communicate

Send a direct message:

```bash
swarm send <agent-name> "<message>"
```

Broadcast to everyone:

```bash
swarm broadcast "<message>"
```

Read another Cmux agent's terminal:

```bash
swarm read <agent-name> --lines 30
```

Update your status:

```bash
swarm status --set "<what you are doing>"
```

## Protocol

1. Check `swarm inbox` before starting new work and after finishing a task.
2. When a terminal message starts with `[SWARM from <name>]:`, treat it as a direct request or notification.
3. Reply with `swarm send <name> "<reply>"` when a response is useful.
4. Prefer targeted messages over broadcasts.
5. Do not send secrets through swarm messages or leave secrets visible in terminals other agents can read.
