#!/usr/bin/env bash
set -euo pipefail

SWARM_DIR="$(cd "$(dirname "$0")" && pwd)"
SWARM_BIN="${SWARM_DIR}/bin/swarm"
SKILL_DIR="${SWARM_DIR}/skill"
SKILLS=(swarm join-swarm leave-swarm reset-swarm)

skill_source() {
  local skill="$1"
  if [ "$skill" = "swarm" ]; then
    echo "${SKILL_DIR}/SKILL.md"
  else
    echo "${SKILL_DIR}/${skill}.md"
  fi
}

echo "swarm installer"
echo "Binary: ${SWARM_BIN}"
echo ""

# Build if needed
needs_build=0
if [ ! -f "${SWARM_DIR}/dist/index.js" ]; then
  needs_build=1
elif find "${SWARM_DIR}/src" -type f -newer "${SWARM_DIR}/dist/index.js" | grep -q .; then
  needs_build=1
fi

if [ "$needs_build" -eq 1 ]; then
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
  for skill in "${SKILLS[@]}"; do
    skill_dir="${CLAUDE_SKILLS}/${skill}"
    mkdir -p "$skill_dir"
    src="$(skill_source "$skill")"
    ln -sf "$src" "${skill_dir}/SKILL.md"
    echo "  Linked: /${skill} → ${src}"
  done

  installed=$((installed + 1))
fi

# ── Codex CLI ────────────────────────────────────────────────────────────────

if command -v codex &>/dev/null; then
  echo "Found: Codex CLI"
  CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
  CODEX_SKILLS="${CODEX_HOME}/skills"
  mkdir -p "$CODEX_HOME" "$CODEX_SKILLS"

  # Materialize skill files instead of symlinking SKILL.md. Some Codex builds
  # skip file-level symlinked SKILL.md entries during skill discovery.
  for skill in "${SKILLS[@]}"; do
    skill_dir="${CODEX_SKILLS}/${skill}"
    mkdir -p "$skill_dir"
    if [ -L "${skill_dir}/SKILL.md" ]; then
      rm "${skill_dir}/SKILL.md"
    fi
    src="$(skill_source "$skill")"
    cp "$src" "${skill_dir}/SKILL.md"
    echo "  Installed: ${CODEX_SKILLS/#$HOME/~}/${skill}/SKILL.md"
  done

  cat > "${CODEX_HOME}/swarm-instructions.md" << SKILL
# Swarm Coordination

You can coordinate with other AI agents running in nearby terminals using the swarm CLI.

## Skills

Codex skills installed by swarm:
- \`swarm\` — coordination protocol and command reference
- \`join-swarm\` — join the swarm and check initial messages
- \`leave-swarm\` — leave the swarm and clean up session state
- \`reset-swarm\` — clear the current swarm's agents and messages

Swarm supports multiple independent project swarms on the same machine. If \`${CODEX_HOME}/swarm-session.md\` exists, use it as a hint, then run \`${SWARM_BIN} whoami\` to confirm the current terminal identity.

## Joining

To join a project swarm, pick a short creative name and run:
\`\`\`bash
${SWARM_BIN} join "<name>" --swarm <project-swarm>
\`\`\`

## Commands

- \`${SWARM_BIN} create <swarm> --root <path>\` — create/update a project swarm
- \`${SWARM_BIN} swarms\` — list known swarms
- \`${SWARM_BIN} send <agent> "<message>"\` — send a direct message
- \`${SWARM_BIN} broadcast "<message>"\` — send to all agents in the current swarm
- \`${SWARM_BIN} inbox\` — check for pending messages
- \`${SWARM_BIN} members\` — list active agents
- \`${SWARM_BIN} status --set "<description>"\` — update your status
- \`${SWARM_BIN} read <agent> --lines 20\` — read another agent's terminal
- \`${SWARM_BIN} spawn --name <agent> --cwd <path> --swarm <swarm>\` — spawn Claude in a new Cmux tab in the current workspace
- \`${SWARM_BIN} leave\` — leave the swarm
- \`${SWARM_BIN} reset\` — clear the current swarm
- \`${SWARM_BIN} reset --all\` — clear every swarm only when explicitly requested

## Protocol

- Confirm the current project swarm with \`${SWARM_BIN} whoami\` when unsure
- Check inbox before starting new work and after completing tasks
- When you see \`[SWARM from <name>]: <text>\` in your terminal, that's a message from another agent. Read and respond.
- Send a message when you finish work that unblocks someone else
- Be concise — other agents have limited context too
SKILL

  # Append to global instructions if they exist, or note the file location
  if [ -f "${CODEX_HOME}/instructions.md" ]; then
    if ! grep -q "swarm-instructions" "${CODEX_HOME}/instructions.md" 2>/dev/null; then
      echo "" >> "${CODEX_HOME}/instructions.md"
      echo "<!-- swarm-instructions -->" >> "${CODEX_HOME}/instructions.md"
      echo "Also read and follow the instructions in ${CODEX_HOME}/swarm-instructions.md for agent coordination." >> "${CODEX_HOME}/instructions.md"
      echo "  Installed: ${CODEX_HOME/#$HOME/~}/swarm-instructions.md (appended reference to instructions.md)"
    else
      echo "  Already referenced in ${CODEX_HOME/#$HOME/~}/instructions.md"
    fi
  else
    cat > "${CODEX_HOME}/instructions.md" << EOF
<!-- swarm-instructions -->
Read and follow the instructions in ${CODEX_HOME}/swarm-instructions.md for agent coordination.
EOF
    echo "  Installed: ${CODEX_HOME/#$HOME/~}/instructions.md + ${CODEX_HOME/#$HOME/~}/swarm-instructions.md"
  fi
  installed=$((installed + 1))
fi

# ── Gemini CLI ──────────────────────────────────────────────────────────────

if command -v gemini &>/dev/null; then
  echo "Found: Gemini CLI"
  GEMINI_SKILLS="$HOME/.gemini/skills"
  GEMINI_SKILL_DIR="${SWARM_DIR}/skill/gemini"
  mkdir -p "$GEMINI_SKILLS"

  # Symlink each skill directory into ~/.gemini/skills/
  for skill_name in swarm join-swarm leave-swarm reset-swarm; do
    ln -sf "${GEMINI_SKILL_DIR}/${skill_name}" "${GEMINI_SKILLS}/${skill_name}"
    echo "  Linked: ${skill_name} → ${GEMINI_SKILL_DIR}/${skill_name}"
  done

  installed=$((installed + 1))
fi

# ── Swarm awareness hook ─────────────────────────────────────────────────────

HOOK_SCRIPT="${SWARM_DIR}/hooks/swarm-awareness.sh"
if command -v claude &>/dev/null && [ -f "$HOOK_SCRIPT" ]; then
  echo ""
  echo "Installing swarm awareness hook..."

  SETTINGS_FILE="$HOME/.claude/settings.json"
  if [ -f "$SETTINGS_FILE" ]; then
    # Use node to safely upsert the hook. Older installs used per-agent
    # SWARM_AGENT_NAME commands; the multi-swarm hook resolves identity from
    # the current terminal/session, so replace old swarm-awareness entries.
    node -e "
      const fs = require('fs');
      const settings = JSON.parse(fs.readFileSync('$SETTINGS_FILE', 'utf8'));
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];
      let updated = false;
      for (const entry of settings.hooks.UserPromptSubmit) {
        if (Array.isArray(entry.hooks)) {
          const existing = entry.hooks.find(h => h.command && h.command.includes('swarm-awareness'));
          if (existing) {
            existing.type = 'command';
            existing.command = '$HOOK_SCRIPT';
            existing.timeout = 5;
            updated = true;
          }
        } else if (entry.command && entry.command.includes('swarm-awareness')) {
          entry.matcher = '';
          entry.hooks = [{ type: 'command', command: '$HOOK_SCRIPT', timeout: 5 }];
          delete entry.command;
          delete entry.type;
          updated = true;
        }
      }
      if (!updated) {
        settings.hooks.UserPromptSubmit.push({
          matcher: '',
          hooks: [{ type: 'command', command: '$HOOK_SCRIPT', timeout: 5 }]
        });
      }
      fs.writeFileSync('$SETTINGS_FILE', JSON.stringify(settings, null, 2));
    "
    echo "  Installed/updated: UserPromptSubmit hook for swarm awareness"
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
  echo "No supported agents found (checked: claude, codex, gemini)."
  echo "You can still use the CLI directly: ${SWARM_BIN} help"
else
  echo "Done. ${installed} agent platform(s) configured."
  echo "Claude skills are symlinked. Codex skills are copied; rerun ./install.sh after pulling swarm updates."
  echo ""
  echo "To test: open a fresh Claude Code or Codex session and invoke join-swarm."
fi
