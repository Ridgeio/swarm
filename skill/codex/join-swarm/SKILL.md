---
name: join-swarm
description: Join the local swarm so this Codex agent can communicate with other AI coding agents through the swarm CLI.
---

# Join Swarm

Join the agent coordination swarm.

If the user gave a name, use it. Otherwise inspect active members and choose a short unique name:

```bash
swarm members 2>/dev/null
```

Join:

```bash
swarm join "<name>"
```

Then check for messages and peers:

```bash
swarm inbox
swarm members
```

After joining, use `swarm send`, `swarm broadcast`, `swarm read`, and `swarm status --set` for coordination. Do not send receipt-only acknowledgements: one goal should produce one condition-complete final evidence packet or one true blocker, with progress kept in status/checkpoints.
