---
name: swarm
description: Use when coordinating with other AI coding agents through the local swarm CLI, including checking members, reading inbox messages, sending direct messages, broadcasting, and updating swarm status.
---

# Swarm Coordination Protocol

You are part of a coordinated swarm of AI coding agents. Each swarm is scoped to one project/codebase, so the same machine can run multiple independent swarms at the same time. Agents can run in Cmux (push delivery), any terminal in headless mode (poll-based delivery via hooks), or as A2A remote agents (HTTP delivery).

## Your Identity

When you joined this swarm, you were registered with an agent name, a swarm name, and a terminal/session marker. Run `swarm whoami` to confirm your current swarm. Run `swarm members` to see who else is active in this same swarm.

Use `--swarm <name>` when joining or when you need to address a swarm explicitly:
```
swarm join Lead --swarm ridge
swarm members --swarm ridge
```

Once joined, normal commands infer the current swarm from your terminal/session.

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

On **Grok**, a normal send **queues** mid-turn (does not interrupt). Only use `--interject` / `--now` when you intentionally want send-now:
```
swarm send <agent-name> "<urgent message>" --interject
```

Send to everyone:
```
swarm broadcast "<message>"
```

Messages and broadcasts stay inside the current swarm. A `Lead` in one project will not receive messages from a different project's swarm.

### Receiving Messages
Messages are pushed directly into your terminal. When you see `[SWARM from <name>]:` followed by text, that is a message from another agent. Read it, understand it, and respond appropriately.

If you think you may have missed messages (e.g., you were busy), check your inbox:
```
swarm inbox
```

Warp terminals default to inbox/hook delivery. To opt into experimental Warp push delivery, join with `swarm join <name> --push`; macOS Accessibility access must be granted to the parent terminal binary that runs `swarm`, because delivery activates Warp, pastes through the clipboard, and presses Return with System Events.

**Warp push caveat:** Warp's accessibility tree only exposes the active tab's title at the window level — there's no API to enumerate or focus tabs by name. Phase 4's window-title lookup works reliably when each Warp agent has its own *window* (e.g., `swarm spawn --terminal warp --window`); when several agents share one window as tabs, sends fall through to "frontmost Warp tab" with a warning, and you must manually focus the target tab before sending. For multi-agent reliability without focus management, prefer Cmux, or use `--window` for each Warp agent.

### Checking on Others
See what another agent's terminal currently shows:
```
swarm read <agent-name> --lines 30
```

This lets you monitor progress without interrupting them.

### Spawning New Agents
When you need another local agent, spawn it from the lead/current agent:
```
swarm spawn --name DevA --cwd /path/to/project --swarm <swarm-name>
swarm spawn --agent grok --name Brillo --cwd /path/to/project --swarm <swarm-name>
```

Supported `--agent` values: `claude` (default), `codex`, `grok`. By default, `swarm spawn` auto-selects the terminal: Warp when running inside Warp, otherwise Cmux. Use `--terminal cmux` or `--terminal warp` to force one. Cmux opens the new agent in a new tab/surface in the current workspace and auto-joins it to the selected swarm.

In Warp:
- Default: opens a new **tab** in the active Warp window via `warp://action/new_tab`, then pastes the join+exec command via Accessibility. Compact, but tabs in one window can't be individually targeted by `swarm send` (see "Warp push caveat" above).
- `--window`: opens a separate Warp window via a Launch Configuration YAML (auto-runs the join command without keystrokes). Better for `--push` reliability since each window has a unique accessibility-visible title.
- Codex and Grok agents (`--agent codex` / `--agent grok`) receive join instructions as their initial prompt instead of auto-running `swarm join`.

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

### Swarm Selection
List known swarms:
```
swarm swarms
```

Create or update a project swarm:
```
swarm create ridge --root /path/to/codebase
```

Reset only the current swarm:
```
swarm reset
```

Reset every swarm only when explicitly asked:
```
swarm reset --all
```

### Workflow
1. **Before starting new work**: Run `swarm whoami` if unsure which project swarm you are in. Run `swarm inbox` to check for pending messages. Run `swarm members` to see who's active.
2. **When starting a task**: Run `swarm status --set "description of what I'm doing"`
3. **When you need help**: Send a targeted message to the right agent, or broadcast if unsure who can help.
4. **When you finish a task**: Notify anyone who was waiting on it via `swarm send`.
5. **When you receive a message**: Read it. If it requires action, act. If it is informational, do not send a receipt-only reply; delivery acknowledgement is metadata.

### Responding to Messages
When a message appears in your terminal as `[SWARM from <name>]: <text>`, treat it as a direct request or communication from that agent. Reply only with a result, a decision-bearing question, or a true blocker. If a reply is needed, use `swarm send <name> "your reply"`.

## Rules
- Be concise in messages. Other agents have limited context windows too.
- Don't argue over messages. If there's a disagreement, one message each, then move on.
- If an agent doesn't respond after one message, they may be busy. Check with `swarm read` before resending when that agent is a local terminal agent.
- This is a trusted environment. All agents can read each other's terminal output. Don't put secrets in your terminal that you wouldn't want other agents to see.

## Quiet goals and inactive recipients

- One goal produces one condition-complete final evidence packet or one true blocker. Put progress in `swarm status`, task checkpoints, run logs, and files; do not send “received,” “starting,” per-test, or waiting updates.
- Do not send acknowledgement messages. After actually handling a delivery, use `swarm ack <exact-id...>`; `ack --all` is unsafe and refused.
- For an ordinary question that truly needs an answer, send it once with `swarm send <agent> "<question>" --require-reply <ttl>`. The exact recipient resolves it with `swarm send <requester> "<answer>" --reply-to <message-id>`; reading or acking alone never resolves it. Inspect pending/terminal state with `swarm replies [--history]`.
- Push is only a nudge. For required ownership pickup, use `swarm handoff offer <slug> --to <agent> --ttl <t>` and treat only exact-recipient `handoff accept` as acceptance.
- If an expected action is quiet, run `swarm inbox --wait 60`, inspect `swarm handoff status`, then use `swarm read <agent>` once before sending anything again. Supersede a changed order with `--supersedes`; never duplicate it to provoke a receipt.
- If the exact registration is inactive or an offer expires, the source keeps the lease. Preserve stranded work with `swarm rescue --task <slug> --to <successor>` before an Owner/Lead reaps, takes over, or explicitly rebinds it. A same-name rejoin is a new identity and inherits nothing.
- Gate-critical changes require fresh exact-head adversarial review from a different model family. Any source or doctrine change invalidates the old verdict; follow the active provider/quota routing policy.

## Durable work: tasks, evidence, approvals (SWARM-NEXT)

Messaging is for coordination; WORK goes through the durable task ledger — it survives your session ending. The live, always-current command map is `swarm help --agent`; load docs by open decision via the path it prints (docs/ROUTING.md). Core loop:

1. `swarm task start <slug> --title "..." [--repo <path>] [--claim <kind>]` — claims are typed (code-merged | journey-works | deploy-healthy | analysis | decision | probe); start prints what evidence close will require. Repo tasks get a named branch + worktree under ~/.swarm/wt/.
2. Work, capturing evidence: `swarm run --task <slug> -- <cmd>` logs full output to the task's evidence dir.
3. `swarm task checkpoint <slug>` at phase boundaries — decisions/failed-approaches/next-action (gated until filled). Your death then costs minutes, not a context window.
4. Blocked or need an approval (e.g. merge)? `swarm escalate <slug> --question "..."` — approvals are expiring grants issued by the operator; NEVER self-grant, never self-merge (close-as-merged verifies the commit is actually on the default branch).
5. `swarm task close <slug> --disposition <d> --evidence <kind>:<ref> --not-established "..."` — closes are refused without matching evidence; state your evidence ceiling honestly. `swarm task reopen <slug> --reason` exists for false dispositions.

Visibility: `swarm board --tab` (live fleet board in a cmux tab) / `swarm board --graph --open` (workflow diagram) — the first agent in a swarm (Lead) opens one. Waiting on a reply: `swarm inbox --wait 60`. Superseding a stale order: resend with `--supersedes <msg-id>`. If a refusal names a doc or command, treat it as instruction — the refusals teach.
