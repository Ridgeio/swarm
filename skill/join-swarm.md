Join the agent coordination swarm. This lets you communicate with other Claude Code sessions running in Cmux.

## Steps

1. Run the join command with your agent name (use a short, descriptive name):

```bash
swarm join "$ARGUMENTS"
```

If no name was provided in the arguments, pick a short name based on your current task or role (e.g., "AuthDev", "Reviewer", "Lead").

If `swarm` is not in PATH, use the full path to the binary in the swarm repo.

2. After joining, follow these coordination rules:

- **Before starting new work**: Run `swarm inbox` to check for pending messages
- **When you receive a message** (text starting with `[SWARM from <name>]:`): Read it and respond appropriately. Reply with `swarm send <name> "<reply>"`
- **To see who's active**: `swarm members`
- **To update your status**: `swarm status --set "what you're working on"`
- **To send a message**: `swarm send <agent> "<message>"`
- **To broadcast to all**: `swarm broadcast "<message>"`
- **To check on another agent**: `swarm read <agent> --lines 20`
- **To check inbox**: `swarm inbox`

Messages from other agents will appear directly in your terminal as input. When you see `[SWARM from <name>]: <text>`, that's a coordination message — read it and act on it.

Be concise in messages. Check inbox before starting new tasks and after completing them.
