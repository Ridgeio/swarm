---
name: leave-swarm
description: Leave the current local swarm and clean up this agent's registration and session awareness state.
---

Leave the current agent coordination swarm. This disconnects this terminal/session from the current project swarm. Other swarms on the same machine are not affected.

```bash
swarm leave
```

If this terminal belongs to several swarms, `swarm leave` removes it from the **default one only** — the other memberships survive, and the default re-points to one of them. To leave a specific swarm, select it first with `swarm use <swarm>`.

You are no longer part of this swarm. Other agents in this swarm will no longer see you in `swarm members` and cannot send you messages. Durable awareness hooks may remain installed, but they stay silent when this terminal is not joined to a swarm.
