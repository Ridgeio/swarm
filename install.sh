#!/usr/bin/env bash
set -euo pipefail

SWARM_DIR="$(cd "$(dirname "$0")" && pwd)"
SWARM_BIN="${SWARM_DIR}/bin/swarm"

echo "swarm installer"
echo "Binary: ${SWARM_BIN}"
echo ""

# Build if needed
if [ ! -d "${SWARM_DIR}/dist" ]; then
  echo "Building..."
  cd "${SWARM_DIR}" && npm install && npm run build
  echo ""
fi

installed=0

# ── Claude Code ──────────────────────────────────────────────────────────────

if command -v claude &>/dev/null; then
  echo "Found: Claude Code"
  mkdir -p ~/.claude/commands

  cat > ~/.claude/commands/join-swarm.md << SKILL
Join the agent coordination swarm. This lets you communicate with other Claude Code sessions running in Cmux.

## Steps

1. First, pick your agent name. If a name was provided as an argument, use it:

\`\`\`bash
echo "\$ARGUMENTS"
\`\`\`

If \$ARGUMENTS is empty or blank, you MUST invent your own short, creative name. Pick something fun and unique — an adjective + noun combo works well (e.g., "SwiftFox", "IronBolt", "NeonOwl", "QuietStorm"). Don't ask the user, just pick one.

2. Join the swarm with your chosen name:

\`\`\`bash
${SWARM_BIN} join "<your-chosen-name>"
\`\`\`

3. Check for pending messages and see who else is active:

\`\`\`bash
${SWARM_BIN} inbox
${SWARM_BIN} members
\`\`\`

4. After joining, follow these coordination rules:

- **Before starting new work**: Run \`${SWARM_BIN} inbox\` to check for pending messages
- **When you receive a message** (text starting with \`[SWARM from <name>]:\`): Read it and respond appropriately. Reply with \`${SWARM_BIN} send <name> "<reply>"\`
- **To see who's active**: \`${SWARM_BIN} members\`
- **To update your status**: \`${SWARM_BIN} status --set "what you're working on"\`
- **To send a message**: \`${SWARM_BIN} send <agent> "<message>"\`
- **To broadcast to all**: \`${SWARM_BIN} broadcast "<message>"\`
- **To check on another agent**: \`${SWARM_BIN} read <agent> --lines 20\`
- **To check inbox**: \`${SWARM_BIN} inbox\`

Messages from other agents will appear directly in your terminal as input. When you see \`[SWARM from <name>]: <text>\`, that's a coordination message — read it and act on it.

Be concise in messages. Check inbox before starting new tasks and after completing them.
SKILL

  cat > ~/.claude/commands/leave-swarm.md << SKILL
Leave the agent coordination swarm. This disconnects you from other agents.

\`\`\`bash
${SWARM_BIN} leave
\`\`\`

You are no longer part of the swarm. Other agents will no longer see you in \`swarm members\` and cannot send you messages.
SKILL

  cat > ~/.claude/commands/reset-swarm.md << SKILL
Reset the swarm. Clears all agents, messages, and inbox state. Use when switching projects or starting fresh.

\`\`\`bash
${SWARM_BIN} reset
\`\`\`

The swarm is now empty. All agents will need to \`/join-swarm\` again.
SKILL

  echo "  Installed: /join-swarm, /leave-swarm, /reset-swarm"
  installed=$((installed + 1))
fi

# ── Codex CLI ────────────────────────────────────────────────────────────────

if command -v codex &>/dev/null; then
  echo "Found: Codex CLI"
  mkdir -p ~/.codex

  cat > ~/.codex/swarm-instructions.md << SKILL
# Swarm Coordination

You can coordinate with other AI agents running in nearby terminals using the swarm CLI.

## Joining

To join the swarm, pick a short creative name and run:
\`\`\`bash
${SWARM_BIN} join "<name>"
\`\`\`

## Commands

- \`${SWARM_BIN} send <agent> "<message>"\` — send a direct message
- \`${SWARM_BIN} broadcast "<message>"\` — send to all agents
- \`${SWARM_BIN} inbox\` — check for pending messages
- \`${SWARM_BIN} members\` — list active agents
- \`${SWARM_BIN} status --set "<description>"\` — update your status
- \`${SWARM_BIN} read <agent> --lines 20\` — read another agent's terminal
- \`${SWARM_BIN} leave\` — leave the swarm
- \`${SWARM_BIN} reset\` — clear all agents and messages

## Protocol

- Check inbox before starting new work and after completing tasks
- When you see \`[SWARM from <name>]: <text>\` in your terminal, that's a message from another agent. Read and respond.
- Send a message when you finish work that unblocks someone else
- Be concise — other agents have limited context too
SKILL

  # Append to global instructions if they exist, or note the file location
  if [ -f ~/.codex/instructions.md ]; then
    if ! grep -q "swarm-instructions" ~/.codex/instructions.md 2>/dev/null; then
      echo "" >> ~/.codex/instructions.md
      echo "<!-- swarm-instructions -->" >> ~/.codex/instructions.md
      echo "Also read and follow the instructions in ~/.codex/swarm-instructions.md for agent coordination." >> ~/.codex/instructions.md
      echo "  Installed: ~/.codex/swarm-instructions.md (appended reference to instructions.md)"
    else
      echo "  Already referenced in ~/.codex/instructions.md"
    fi
  else
    cat > ~/.codex/instructions.md << EOF
<!-- swarm-instructions -->
Read and follow the instructions in ~/.codex/swarm-instructions.md for agent coordination.
EOF
    echo "  Installed: ~/.codex/instructions.md + ~/.codex/swarm-instructions.md"
  fi
  installed=$((installed + 1))
fi

# ── Swarm awareness hook ─────────────────────────────────────────────────────

HOOK_SCRIPT="${SWARM_DIR}/hooks/swarm-awareness.sh"
if command -v claude &>/dev/null && [ -f "$HOOK_SCRIPT" ]; then
  echo ""
  echo "Installing swarm awareness hook..."

  # Update the SWARM_BIN path in the hook script
  sed -i '' "s|SWARM_BIN=.*|SWARM_BIN=\"${SWARM_BIN}\"|" "$HOOK_SCRIPT"

  SETTINGS_FILE="$HOME/.claude/settings.json"
  if [ -f "$SETTINGS_FILE" ]; then
    # Check if hooks already configured
    if grep -q "swarm-awareness" "$SETTINGS_FILE" 2>/dev/null; then
      echo "  Hook already configured in settings.json"
    else
      # Use node to safely merge the hook into settings.json
      node -e "
        const fs = require('fs');
        const settings = JSON.parse(fs.readFileSync('$SETTINGS_FILE', 'utf8'));
        if (!settings.hooks) settings.hooks = {};
        if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];
        settings.hooks.UserPromptSubmit.push({
          matcher: '',
          hooks: [{
            type: 'command',
            command: '$HOOK_SCRIPT',
            timeout: 5
          }]
        });
        fs.writeFileSync('$SETTINGS_FILE', JSON.stringify(settings, null, 2));
      "
      echo "  Installed: UserPromptSubmit hook for swarm awareness"
    fi
  fi
fi

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
if [ $installed -eq 0 ]; then
  echo "No supported agents found (checked: claude, codex)."
  echo "You can still use the CLI directly: ${SWARM_BIN} help"
else
  echo "Done. ${installed} agent platform(s) configured."
  echo ""
  echo "To test: open a Claude Code or Codex session in Cmux and run /join-swarm"
fi
