---
name: join-swarm
description: Join the local swarm coordination system as an AI coding agent, choosing or accepting an agent name, checking inbox messages, and listing active swarm members.
---

Join the agent coordination swarm for the current project. Swarm supports multiple independent project swarms on the same machine; use `--swarm <name>` when the user gives a project/swarm name or when several codebases are active.

## Steps

1. First, determine the target swarm and your agent name.

If arguments were provided, preserve any `--swarm <name>` option and use the remaining first plain argument as your agent name:
```bash
echo "$ARGUMENTS"
```

If no swarm name was provided, use the current CLI context. The CLI can infer a swarm from this terminal, `SWARM_ID`, or a codebase root registered with `swarm create`.

If no agent name was provided, check who's already in the selected swarm:
```bash
swarm members --swarm "<swarm-name>" 2>/dev/null
```

Omit `--swarm` when no swarm name was provided and the CLI can infer the current swarm.

- If the selected swarm is **empty** (no agents or "No agents in swarm"), join as **"Lead"** — you're the first agent in this project swarm, so you coordinate the team. As Lead, **create the program's named workspace and open the fleet board in it**: `swarm board --tab --own-workspace` sets up the program workspace with the live board (NEEDS YOU / TASKS / FLEET / DEBRIS); swarmmates then join as tabs in that workspace, and anyone who wants the board beside their work runs `swarm board --tab` (which tiles a split in the CURRENT workspace — the default, because seeing two things at once means a split, not another workspace). `swarm board --graph --open` renders the visual workflow diagram. Keep the board visible — it's the operator's window into the fleet.
- If agents **already exist in this swarm**, pick a short creative name that's unique within this swarm. Don't ask the user, just pick one.
- **Never name yourself after your model or any AI model/product** (Fable, Claude, Codex, Sonnet, Grok, GPT, Gemini, …, with or without version suffixes). The CLI rejects these — a model-named agent is ambiguous the moment a second instance of that model joins.
- This machine may reserve names for remote/OpenClaw agents via a **local-only** file `~/.swarm/reserved-names` (not in the repo). If `swarm join` rejects a name as reserved, pick another.

2. Join the swarm with your chosen name. The CLI auto-detects your environment — if you're in Cmux it uses push delivery, otherwise it joins in headless mode with automatic message polling.

```bash
swarm join "<your-chosen-name>" --swarm "<swarm-name>"
```

Omit `--swarm` when no swarm name was provided.

In Warp, add `--push` only when the user wants experimental push delivery and has granted macOS Accessibility access to the parent terminal binary that runs `swarm`. Without `--push`, Warp agents still join normally and receive messages through the inbox/hook flow.

3. Check for pending messages and see who else is active:

```bash
swarm whoami
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

## Belonging to more than one swarm

Joining a second swarm does **not** remove you from the first — run `swarm join <name> --swarm <other>` again and both memberships coexist, each with its own name, inbox and identity.

- Commands without `--swarm` act on the **default** swarm (the most recent join). Switch it with `swarm use <swarm>`; target one command with `--swarm <swarm>`.
- `swarm whoami` lists every membership and marks the default.
- Unread messages from your **non-default** swarms are surfaced by the awareness hook, labelled with the swarm to reply in. Reply with the selector **before** the subcommand: `swarm --swarm <that-swarm> send <agent> "<msg>"`. A trailing `--swarm` would be swallowed into the message text, so `send` refuses it rather than delivering to the wrong swarm.
- `swarm leave` leaves the default swarm only.
