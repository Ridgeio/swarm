#!/usr/bin/env bash
set -euo pipefail

SWARM_DIR="$(cd "$(dirname "$0")" && pwd)"
SWARM_BIN="${SWARM_DIR}/bin/swarm"
SKILL_DIR="${SWARM_DIR}/skill"

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
  CLAUDE_SKILLS="$HOME/.claude/skills"
  mkdir -p "$CLAUDE_SKILLS"

  # Remove old command-style installs if they exist
  rm -f ~/.claude/commands/join-swarm.md ~/.claude/commands/leave-swarm.md ~/.claude/commands/reset-swarm.md 2>/dev/null

  # Symlink each skill — git pull automatically updates them
  for skill in swarm join-swarm leave-swarm reset-swarm; do
    skill_dir="${CLAUDE_SKILLS}/${skill}"
    mkdir -p "$skill_dir"
    if [ "$skill" = "swarm" ]; then
      src="${SKILL_DIR}/SKILL.md"
    else
      src="${SKILL_DIR}/${skill}.md"
    fi
    ln -sf "$src" "${skill_dir}/SKILL.md"
    echo "  Linked: /${skill} → ${src}"
  done

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

# ── swarm CLI in PATH ────────────────────────────────────────────────────────

if ! command -v swarm &>/dev/null; then
  echo ""
  echo "Adding swarm to PATH..."
  if [ -d /opt/homebrew/bin ] && [ -w /opt/homebrew/bin ]; then
    ln -sf "${SWARM_BIN}" /opt/homebrew/bin/swarm
    echo "  Linked: /opt/homebrew/bin/swarm"
  elif [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
    ln -sf "${SWARM_BIN}" /usr/local/bin/swarm
    echo "  Linked: /usr/local/bin/swarm"
  else
    mkdir -p "$HOME/.local/bin"
    ln -sf "${SWARM_BIN}" "$HOME/.local/bin/swarm"
    echo "  Linked: ~/.local/bin/swarm (add to PATH if needed)"
  fi
fi

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
if [ $installed -eq 0 ]; then
  echo "No supported agents found (checked: claude, codex)."
  echo "You can still use the CLI directly: ${SWARM_BIN} help"
else
  echo "Done. ${installed} agent platform(s) configured."
  echo "Skills are symlinked — git pull automatically updates them."
  echo ""
  echo "To test: open a Claude Code or Codex session and run /join-swarm"
fi
