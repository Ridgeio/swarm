---
name: swarm
description: Swarm coordination protocol — communicate with other AI agents running in nearby terminals via the swarm CLI
---

# Swarm Coordination Protocol

You are part of a coordinated swarm of AI coding agents. Each agent can communicate with other agents via the `swarm` CLI. Agents can run in Cmux (push delivery), any terminal in headless mode (poll-based delivery via hooks), or as A2A remote agents (HTTP delivery).

## Your Identity

When you joined this swarm, you were registered with a name and a terminal surface ID. Run `swarm whoami` to see your registration. Run `swarm members` to see who else is active.

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

### Workflow
1. **Before starting new work**: Run `swarm inbox` to check for pending messages. Run `swarm members` to see who's active.
2. **When starting a task**: Run `swarm status --set "description of what I'm doing"`
3. **When you need help**: Send a targeted message to the right agent, or broadcast if unsure who can help.
4. **When you finish a task**: Notify anyone who was waiting on it via `swarm send`.
5. **When you receive a message**: Read it. If it requires action, act. If it is informational, do not send a receipt-only reply; delivery acknowledgement is metadata.

### Responding to Messages
When a message appears in your terminal as `[SWARM from <name>]: <text>`, treat it as a direct request or communication from that agent. Reply only with a result, a decision-bearing question, or a true blocker. If a reply is needed, use `swarm send <name> "your reply"`.

## Rules
- Be concise in messages. Other agents have limited context windows too.
- Don't argue over messages. If there's a disagreement, one message each, then move on.
- If an agent doesn't respond after one message, they may be busy. Check with `swarm read` before resending.
- This is a trusted environment. All agents can read each other's terminal output. Don't put secrets in your terminal that you wouldn't want other agents to see.

## Quiet goals and inactive recipients

- One goal produces one condition-complete final evidence packet or one true blocker. Put progress in `swarm status`, task checkpoints, run logs, and files; do not send receipt, start, per-test, or waiting updates.
- After handling a delivery, use `swarm ack <exact-id...>` as transport metadata. Never send an acknowledgement message and never use `ack --all`.
- For an ordinary question that truly needs an answer, send it once with `swarm send <agent> "<question>" --require-reply <ttl>`. The exact recipient resolves it with `swarm send <requester> "<answer>" --reply-to <message-id>`; reading or acking alone never resolves it. Inspect pending/terminal state with `swarm replies [--history]`.
- Required ownership pickup uses `swarm handoff offer` and exact-recipient `handoff accept`; push success is not acceptance.
- If an expected action is quiet, use `swarm inbox --wait 60`, inspect handoff status, then `swarm read` once. Supersede changed orders instead of duplicating them.
- If the exact registration is inactive or pickup expires, preserve work with `swarm rescue --task <slug> --to <successor>` before Owner/Lead takeover or rebind. Same-name replacements inherit nothing.
- Re-review every changed exact head with a fresh different-family adversarial reviewer under the active provider/quota policy.

## Durable work: tasks, evidence, approvals (SWARM-NEXT)

Messaging is for coordination; WORK goes through the durable task ledger — it survives your session ending. The live, always-current command map is `swarm help --agent`; load docs by open decision via the path it prints (docs/ROUTING.md). Core loop:

1. `swarm task start <slug> --title "..." [--repo <path>] [--claim <kind>]` — claims are typed (code-merged | journey-works | deploy-healthy | analysis | decision | probe); start prints what evidence close will require. Repo tasks get a named branch + worktree under ~/.swarm/wt/.
2. Work, capturing evidence: `swarm run --task <slug> -- <cmd>` logs full output to the task's evidence dir.
3. `swarm task checkpoint <slug>` at phase boundaries — decisions/failed-approaches/next-action (gated until filled). Your death then costs minutes, not a context window.
4. Blocked or need an approval (e.g. merge)? `swarm escalate <slug> --question "..."` — approvals are expiring grants issued by the operator; NEVER self-grant, never self-merge (close-as-merged verifies the commit is actually on the default branch).
5. `swarm task close <slug> --disposition <d> --evidence <kind>:<ref> --not-established "..."` — closes are refused without matching evidence; state your evidence ceiling honestly. `swarm task reopen <slug> --reason` exists for false dispositions.

Visibility: `swarm board --tab` (live fleet board in a cmux tab) / `swarm board --graph --open` (workflow diagram) — the first agent in a swarm (Lead) opens one. Waiting on a reply: `swarm inbox --wait 60`. Superseding a stale order: resend with `--supersedes <msg-id>`. If a refusal names a doc or command, treat it as instruction — the refusals teach.
