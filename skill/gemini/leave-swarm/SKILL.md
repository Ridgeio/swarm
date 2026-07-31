---
name: leave-swarm
description: Leave the agent coordination swarm and disconnect from other agents
---

Direct deregistration is intentionally refused because it does not prove that the
agent's process tree stopped. First emit the final evidence packet or blocker.
Then an unrelated Owner/Lead session must run:

```bash
swarm stand-down <agent-name>
```

The operator verifies the exact captured process tree is gone before the
registration is removed. `swarm leave` only prints this refusal and guidance.
