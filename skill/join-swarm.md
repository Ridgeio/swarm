Join the agent coordination swarm. This lets you communicate with other Claude Code sessions running in Cmux.

## Steps

1. First, pick your agent name. If a name was provided as an argument, use it:

```bash
echo "$ARGUMENTS"
```

If `$ARGUMENTS` is empty or blank, you MUST invent your own short, creative name. Pick something fun and unique — an adjective + noun combo works well (e.g., "SwiftFox", "IronBolt", "NeonOwl", "QuietStorm"). Don't ask the user, just pick one.

2. Join the swarm with your chosen name. If `swarm` is not in PATH, use the full path to the binary in the swarm repo.

```bash
swarm join "<your-chosen-name>"
```

3. Check for pending messages and see who else is active:

```bash
swarm inbox
swarm members
```

4. After joining, follow these coordination rules:

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
