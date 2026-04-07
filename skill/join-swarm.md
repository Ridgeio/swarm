Join the agent coordination swarm. This lets you communicate with other AI agents — works in Cmux, Terminal.app, Warp, or any terminal.

## Steps

1. First, determine your agent name.

If a name was provided as an argument, use it:
```bash
echo "$ARGUMENTS"
```

If `$ARGUMENTS` is empty or blank, check who's already in the swarm:
```bash
swarm members 2>/dev/null
```

- If the swarm is **empty** (no agents or "No agents in swarm"), join as **"Lead"** — you're the first agent, so you coordinate the team.
- If agents **already exist**, pick a creative name that's fun and unique — an adjective + noun combo works well (e.g., "SwiftFox", "IronBolt", "NeonOwl", "QuietStorm"). Don't ask the user, just pick one.

2. Join the swarm with your chosen name. The CLI auto-detects your environment — if you're in Cmux it uses push delivery, otherwise it joins in headless mode with automatic message polling.

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
- **To check on another agent** (Cmux only): `swarm read <agent> --lines 20`
- **To check inbox**: `swarm inbox`

In Cmux, messages from other agents appear directly in your terminal. In headless mode, the awareness hook automatically checks your inbox on every turn and notifies you of pending messages.

Be concise in messages. Check inbox before starting new tasks and after completing them.
