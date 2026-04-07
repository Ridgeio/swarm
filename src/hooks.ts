import fs from 'fs';
import path from 'path';
import os from 'os';

export type HostAgent = 'claude-code' | 'codex';

const SWARM_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HOOK_SCRIPT = path.join(SWARM_DIR, 'hooks', 'swarm-awareness-headless.sh');

/**
 * Detect which AI coding agent is running in this environment.
 */
export function detectHost(): HostAgent | null {
  // Claude Code sets CLAUDE_CODE=1 or has ~/.claude/
  if (process.env.CLAUDE_CODE || fs.existsSync(path.join(os.homedir(), '.claude', 'settings.json'))) {
    return 'claude-code';
  }
  // Codex CLI
  if (process.env.CODEX_CLI || fs.existsSync(path.join(os.homedir(), '.codex', 'config.toml'))) {
    return 'codex';
  }
  return null;
}

/**
 * Install the swarm awareness hook for the given host agent.
 */
export function installHook(host: HostAgent, agentName: string): void {
  // Ensure the headless awareness hook script exists
  ensureHeadlessHook();

  switch (host) {
    case 'claude-code':
      installClaudeCodeHook(agentName);
      break;
    case 'codex':
      installCodexHook(agentName);
      break;
  }
}

/**
 * Remove the swarm awareness hook for the given host agent.
 */
export function removeHook(host: HostAgent, agentName: string): void {
  switch (host) {
    case 'claude-code':
      removeClaudeCodeHook();
      break;
    case 'codex':
      removeCodexHook();
      break;
  }
}

function ensureHeadlessHook(): void {
  if (fs.existsSync(HOOK_SCRIPT)) return;

  const swarmBin = path.join(SWARM_DIR, 'bin', 'swarm');
  const script = `#!/usr/bin/env bash
# Swarm awareness hook (headless) — runs on UserPromptSubmit
# Injects swarm context for headless agents that poll via inbox.

AGENT_NAME="\${SWARM_AGENT_NAME:-}"
[ -z "$AGENT_NAME" ] && exit 0

DB="$HOME/.swarm/swarm.db"
[ -f "$DB" ] || exit 0

# Verify agent is still registered
REGISTERED=$(sqlite3 "$DB" "SELECT name FROM agents WHERE name='$AGENT_NAME' COLLATE NOCASE AND agent_type='headless'" 2>/dev/null)
[ -z "$REGISTERED" ] && exit 0

# Refresh heartbeat
sqlite3 "$DB" "UPDATE agents SET last_heartbeat='$(date -u +%Y-%m-%dT%H:%M:%S.000Z)' WHERE name='$AGENT_NAME' COLLATE NOCASE" 2>/dev/null

MEMBERS=$(sqlite3 "$DB" "SELECT name FROM agents ORDER BY joined_at" 2>/dev/null | tr '\\n' ', ' | sed 's/,$//')

# Check for unread messages
INBOX=$(SWARM_AGENT_NAME="$AGENT_NAME" ${swarmBin} inbox --peek 2>/dev/null)

if echo "$INBOX" | grep -q "No new messages"; then
  INBOX_LINE=""
else
  INBOX_LINE="\\nPending messages — run: swarm inbox"
fi

cat <<SWARM_EOF
You are "$AGENT_NAME" in a coordination swarm. Active agents: \${MEMBERS}.
Commands: swarm send <agent> "<msg>" | broadcast "<msg>" | inbox | members | status --set "<desc>"
When you see [SWARM from <name>]: treat it as a message from another agent and respond.\${INBOX_LINE}
SWARM_EOF
`;

  fs.writeFileSync(HOOK_SCRIPT, script, { mode: 0o755 });
}

function getClaudeSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function installClaudeCodeHook(agentName: string): void {
  const settingsPath = getClaudeSettingsPath();
  let settings: any = {};

  if (fs.existsSync(settingsPath)) {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  }

  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];

  const hookCommand = `SWARM_AGENT_NAME="${agentName}" ${HOOK_SCRIPT}`;

  // Check if swarm hook already exists (search in both old and new format)
  for (const entry of settings.hooks.UserPromptSubmit) {
    // New format: { matcher, hooks: [...] }
    if (entry.hooks && Array.isArray(entry.hooks)) {
      const existing = entry.hooks.find((h: any) => h.command?.includes('swarm-awareness'));
      if (existing) {
        existing.command = hookCommand;
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        return;
      }
    }
    // Old format: { type, command } — migrate it
    if (entry.command?.includes('swarm-awareness')) {
      // Replace old format entry with new format
      const idx = settings.hooks.UserPromptSubmit.indexOf(entry);
      settings.hooks.UserPromptSubmit[idx] = {
        matcher: '',
        hooks: [{ type: 'command', command: hookCommand }],
      };
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      return;
    }
  }

  // Add new hook in correct format
  settings.hooks.UserPromptSubmit.push({
    matcher: '',
    hooks: [{ type: 'command', command: hookCommand }],
  });

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

function removeClaudeCodeHook(): void {
  const settingsPath = getClaudeSettingsPath();
  if (!fs.existsSync(settingsPath)) return;

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  if (!settings.hooks?.UserPromptSubmit) return;

  // Filter out swarm hooks (handles both old and new format)
  settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit.filter((entry: any) => {
    // New format: { matcher, hooks: [...] }
    if (entry.hooks && Array.isArray(entry.hooks)) {
      entry.hooks = entry.hooks.filter((h: any) => !h.command?.includes('swarm-awareness'));
      return entry.hooks.length > 0;
    }
    // Old format: { type, command }
    if (entry.command?.includes('swarm-awareness')) return false;
    return true;
  });

  // Clean up empty arrays
  if (settings.hooks.UserPromptSubmit.length === 0) {
    delete settings.hooks.UserPromptSubmit;
  }
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

function installCodexHook(agentName: string): void {
  const instructionsPath = path.join(os.homedir(), '.codex', 'swarm-instructions.md');
  const swarmBin = path.join(SWARM_DIR, 'bin', 'swarm');
  const content = `# Swarm Coordination

You are "${agentName}" in a coordination swarm. Check for messages regularly.

Before starting any task, run:
\`\`\`bash
SWARM_AGENT_NAME="${agentName}" ${swarmBin} inbox
\`\`\`

To send messages:
\`\`\`bash
SWARM_AGENT_NAME="${agentName}" ${swarmBin} send <agent> "<message>"
\`\`\`

To see active agents:
\`\`\`bash
${swarmBin} members
\`\`\`
`;
  fs.mkdirSync(path.dirname(instructionsPath), { recursive: true });
  fs.writeFileSync(instructionsPath, content);
}

function removeCodexHook(): void {
  const instructionsPath = path.join(os.homedir(), '.codex', 'swarm-instructions.md');
  if (fs.existsSync(instructionsPath)) {
    fs.unlinkSync(instructionsPath);
  }
}
