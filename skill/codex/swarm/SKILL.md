---
name: swarm
description: Coordinate with other AI coding agents through the local swarm CLI, including joining a swarm, checking messages, sending direct messages or broadcasts, updating status, and reading other Cmux agent terminals.
---

# Swarm Coordination Protocol

Use this skill when coordinating with other AI coding agents through the local `swarm` CLI.

## Start

Check your identity and peers:

```bash
swarm whoami
swarm members
swarm inbox
```

If you are not registered, use the `$join-swarm` skill or run:

```bash
swarm join "<name>"
```

## Communicate

Send a direct message:

```bash
swarm send <agent-name> "<message>"
```

Broadcast to everyone:

```bash
swarm broadcast "<message>"
```

Read another Cmux agent's terminal:

```bash
swarm read <agent-name> --lines 30
```

Update your status:

```bash
swarm status --set "<what you are doing>"
```

## Protocol

1. Check `swarm inbox` before starting new work and after finishing a task.
2. When a terminal message starts with `[SWARM from <name>]:`, treat it as a direct request or notification.
3. Reply with `swarm send <name> "<reply>"` only for a result, decision-bearing question, or true blocker; informational messages need no receipt reply.
4. Prefer targeted messages over broadcasts.
5. Do not send secrets through swarm messages or leave secrets visible in terminals other agents can read.

## Quiet goals and inactive recipients

- One goal emits one condition-complete final evidence packet or one true blocker. Put progress in status, checkpoints, run logs, and files—not acknowledgement or per-step messages.
- After handling a message, use `swarm ack <exact-id...>` as transport metadata. Never send an acknowledgement message and never use `ack --all`.
- For an ordinary question that truly needs an answer, send it once with `swarm send <agent> "<question>" --require-reply <ttl>`. The exact recipient resolves it with `swarm send <requester> "<answer>" --reply-to <message-id>`; reading or acking alone never resolves it. Inspect pending/terminal state with `swarm replies [--history]`.
- Required ownership pickup uses `swarm handoff offer` and exact-recipient `handoff accept`; a successful push is not acceptance.
- When a recipient is quiet, use `swarm inbox --wait 60`, inspect handoff status, then `swarm read` once. Supersede changed orders; do not resend identical prompts.
- If the exact registration is inactive or pickup expires, preserve work with `swarm rescue --task <slug> --to <successor>` before Owner/Lead takeover or rebind. Same-name replacements inherit no lease, grant, message, or role.
- Re-review every changed exact head with a fresh different-family adversarial reviewer under the active provider/quota policy.

## Durable work: tasks, evidence, approvals (SWARM-NEXT)

Messaging is for coordination; WORK goes through the durable task ledger — it survives your session ending. The live, always-current command map is `swarm help --agent`; load docs by open decision via the path it prints (docs/ROUTING.md). Core loop:

1. `swarm task start <slug> --title "..." [--repo <path>] [--claim <kind>]` — claims are typed (code-merged | journey-works | deploy-healthy | analysis | decision | probe); start prints what evidence close will require. Repo tasks get a named branch + worktree under ~/.swarm/wt/.
2. Work, capturing evidence: `swarm run --task <slug> -- <cmd>` logs full output to the task's evidence dir.
3. `swarm task checkpoint <slug>` at phase boundaries — decisions/failed-approaches/next-action (gated until filled). Your death then costs minutes, not a context window.
4. Blocked or need an approval (e.g. merge)? `swarm escalate <slug> --question "..."` — approvals are expiring grants issued by the operator; NEVER self-grant, never self-merge (close-as-merged verifies the commit is actually on the default branch).
5. `swarm task close <slug> --disposition <d> --evidence <kind>:<ref> --not-established "..."` — closes are refused without matching evidence; state your evidence ceiling honestly. `swarm task reopen <slug> --reason` exists for false dispositions.

Visibility: `swarm board --tab` (live fleet board in a cmux tab) / `swarm board --graph --open` (workflow diagram) — the first agent in a swarm (Lead) opens one. Waiting on a reply: `swarm inbox --wait 60`. Superseding a stale order: resend with `--supersedes <msg-id>`. If a refusal names a doc or command, treat it as instruction — the refusals teach.
