---
name: reset-swarm
description: Reset the current local swarm by clearing its agents, messages, inbox state, and per-session awareness state.
---

Reset the current swarm. This clears agents, messages, and inbox state only for the selected/current project swarm. It does not affect other active project swarms.

```bash
swarm reset
```

The current swarm is now empty. Agents in this project will need to `/join-swarm` again.

Only use the global reset when the user explicitly asks to wipe every swarm:

```bash
swarm reset --all
```
