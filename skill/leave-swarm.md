Leave the agent coordination swarm. This disconnects you from other agents and removes any auto-installed hooks.

```bash
swarm leave
```

You are no longer part of the swarm. Other agents will no longer see you in `swarm members` and cannot send you messages. Any awareness hooks installed during join are automatically cleaned up.
