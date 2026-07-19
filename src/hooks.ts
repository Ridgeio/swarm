import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

export type HostAgent = 'claude-code' | 'codex' | 'grok';

const SWARM_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_SCRIPT = path.join(SWARM_DIR, 'hooks', 'swarm-awareness-headless.sh');
const AWARENESS_HOOK_SCRIPT = path.join(SWARM_DIR, 'hooks', 'swarm-awareness.sh');
const CODEX_BASE_MARKER = '<!-- swarm-instructions -->';

/**
 * Detect which AI coding agent is running in this environment.
 */
export function detectHost(): HostAgent | null {
  // Runtime environment is authoritative. Config files can coexist on one machine.
  if (process.env.CODEX_CLI || process.env.CODEX_CI || process.env.CODEX_THREAD_ID || process.env.CODEX_MANAGED_BY_NPM) {
    return 'codex';
  }
  if (process.env.CLAUDE_CODE) return 'claude-code';
  // Grok sets GROK_AGENT (often "1") in interactive sessions; Cmux labels launch kind.
  if (process.env.CMUX_AGENT_LAUNCH_KIND === 'grok' || process.env.GROK_AGENT) {
    return 'grok';
  }

  const hasCodexConfig = fs.existsSync(path.join(getCodexHome(), 'config.toml'));
  const hasClaudeConfig = fs.existsSync(path.join(os.homedir(), '.claude', 'settings.json'));
  const hasGrokConfig = fs.existsSync(path.join(getGrokHome(), 'config.toml'));

  const matches: HostAgent[] = [];
  if (hasCodexConfig) matches.push('codex');
  if (hasClaudeConfig) matches.push('claude-code');
  if (hasGrokConfig) matches.push('grok');

  // Only fall back to config when a single host is unambiguous.
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Install the swarm awareness hook for the given host agent.
 */
export function installHook(host: HostAgent, agentName: string, swarmId: string, swarmName: string): void {
  // Ensure the headless awareness hook script exists
  ensureHeadlessHook();

  switch (host) {
    case 'claude-code':
      installClaudeCodeHook();
      break;
    case 'codex':
      installCodexHook(agentName, swarmId, swarmName);
      break;
    case 'grok':
      installGrokHook();
      break;
  }
}

/**
 * Remove the swarm awareness hook for the given host agent.
 */
export function removeHook(host: HostAgent, agentName: string, swarmId?: string): void {
  switch (host) {
    case 'claude-code':
      removeClaudeCodeHook(agentName, swarmId);
      break;
    case 'codex':
      removeCodexHook(agentName, swarmId);
      break;
    case 'grok':
      // Durable global hook stays installed (same model as Claude Code installer hook).
      break;
  }
}

function ensureHeadlessHook(): void {
  if (fs.existsSync(HOOK_SCRIPT)) return;

  const swarmBin = path.join(SWARM_DIR, 'bin', 'swarm');
  const quotedSwarmBin = shellDoubleQuote(swarmBin);
  const script = `#!/usr/bin/env bash
# Swarm awareness hook (headless) — runs on UserPromptSubmit
# \`|| true\` keeps it a clean no-op after leaving the swarm (hook-context exits 1 when
# this session isn't joined).
${quotedSwarmBin} hook-context 2>/dev/null || true
`;

  fs.writeFileSync(HOOK_SCRIPT, script, { mode: 0o755 });
}

function getClaudeSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function getGrokHome(): string {
  return process.env.GROK_HOME || path.join(os.homedir(), '.grok');
}

function getGrokAwarenessHookPath(): string {
  return path.join(getGrokHome(), 'hooks', 'swarm-awareness.json');
}

function getCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function getCodexInstructionsPath(): string {
  return path.join(getCodexHome(), 'instructions.md');
}

function getCodexBaseInstructionsPath(): string {
  return path.join(getCodexHome(), 'swarm-instructions.md');
}

function getCodexSessionPath(): string {
  return path.join(getCodexHome(), 'swarm-session.md');
}

function shellDoubleQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, '\\$1').replace(/\r?\n/g, ' ')}"`;
}

function ensureInstructionsReference(marker: string, line: string): void {
  const instructionsPath = getCodexInstructionsPath();
  fs.mkdirSync(path.dirname(instructionsPath), { recursive: true });
  const existing = fs.existsSync(instructionsPath) ? fs.readFileSync(instructionsPath, 'utf-8') : '';
  if (existing.includes(marker)) return;

  const addition = `${marker}\n${line}\n`;
  const next = existing.trimEnd() ? `${existing.trimEnd()}\n\n${addition}` : addition;
  fs.writeFileSync(instructionsPath, next);
}

function removeInstructionsReference(marker: string): void {
  const instructionsPath = getCodexInstructionsPath();
  if (!fs.existsSync(instructionsPath)) return;

  const lines = fs.readFileSync(instructionsPath, 'utf-8').split(/\r?\n/);
  const next: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === marker) {
      i += 1;
      continue;
    }
    next.push(lines[i]);
  }
  fs.writeFileSync(instructionsPath, `${next.join('\n').trimEnd()}\n`);
}

function installClaudeCodeHook(): void {
  const settingsPath = getClaudeSettingsPath();
  let settings: any = {};
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  if (fs.existsSync(settingsPath)) {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  }

  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];

  const hookCommand = HOOK_SCRIPT;

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

function isSwarmHookCommand(command: string | undefined, agentName?: string, swarmId?: string): boolean {
  if (!command?.includes('swarm-awareness')) return false;
  if (!agentName) return true;
  if (!command.includes(`SWARM_AGENT_NAME="${agentName}"`)) return false;
  return !swarmId || command.includes(`SWARM_ID="${swarmId}"`) || !command.includes('SWARM_ID=');
}

function removeClaudeCodeHook(agentName?: string, swarmId?: string): void {
  const settingsPath = getClaudeSettingsPath();
  if (!fs.existsSync(settingsPath)) return;

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  if (!settings.hooks?.UserPromptSubmit) return;

  // Filter out swarm hooks (handles both old and new format)
  settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit.filter((entry: any) => {
    // New format: { matcher, hooks: [...] }
    if (entry.hooks && Array.isArray(entry.hooks)) {
      entry.hooks = entry.hooks.filter((h: any) => !isSwarmHookCommand(h.command, agentName, swarmId));
      return entry.hooks.length > 0;
    }
    // Old format: { type, command }
    if (isSwarmHookCommand(entry.command, agentName, swarmId)) return false;
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

function installCodexHook(agentName: string, swarmId: string, swarmName: string): void {
  const codexHome = getCodexHome();
  const basePath = getCodexBaseInstructionsPath();
  const swarmBin = path.join(SWARM_DIR, 'bin', 'swarm');
  const quotedSwarmId = shellDoubleQuote(swarmId);
  const quotedSwarmBin = shellDoubleQuote(swarmBin);

  fs.mkdirSync(codexHome, { recursive: true });

  if (!fs.existsSync(basePath)) {
    const baseContent = `# Swarm Coordination

You can coordinate with other AI agents using the swarm CLI.

Common commands:
- ${swarmBin} join "<name>" --swarm <swarm>
- ${swarmBin} send <agent> "<message>"
- ${swarmBin} broadcast "<message>"
- ${swarmBin} inbox
- ${swarmBin} members
- ${swarmBin} status --set "<description>"
- ${swarmBin} leave

Fleet UI (open it if you are the first/Lead agent so the operator can see the swarm):
- ${swarmBin} board                 one-shot fleet view (NEEDS YOU / TASKS / FLEET / DEBRIS)
- ${swarmBin} board --tab           live board in its own cmux tab (keep it open)
- ${swarmBin} board --graph --open  visual workflow diagram (agents by model, tasks by state)

Your current identity is resolved by the swarm CLI from the terminal/session marker. Run ${swarmBin} whoami to confirm which swarm you are in.
`;
    fs.writeFileSync(basePath, baseContent);
  }

  ensureInstructionsReference(
    CODEX_BASE_MARKER,
    `Read and follow the instructions in ${basePath} for agent coordination.`
  );

  const sessionPath = path.join(codexHome, 'swarm-session.md');
  // Do NOT inject SWARM_AGENT_NAME=… — that only resolves headless rows and will
  // mis-identify a Cmux Codex session that reuses a stale session file.
  // Identity comes from CMUX_SURFACE_ID (auto) or `swarm whoami`.
  const sessionContent = `# Swarm Session

This Codex terminal most recently joined swarm "${swarmName}" as "${agentName}".

**Identity:** Always resolve from the live CLI (do not trust this file if multiple Codex tabs are open):

\`\`\`bash
${quotedSwarmBin} whoami
${quotedSwarmBin} inbox
${quotedSwarmBin} members
\`\`\`

When you see a Cmux **notification** titled \`SWARM from …\`, or a terminal nudge, run \`${swarmBin} inbox\` — full message bodies live in the inbox (Codex delivery uses notifications to avoid corrupting the TUI).

To communicate:
\`\`\`bash
${quotedSwarmBin} send <agent> "<message>"
${quotedSwarmBin} broadcast "<message>"
${quotedSwarmBin} status --set "<what you are doing>"
\`\`\`

Swarm id if needed: SWARM_ID=${quotedSwarmId}
`;
  fs.writeFileSync(sessionPath, sessionContent);
  ensureInstructionsReference(
    '<!-- swarm-session -->',
    `If ${sessionPath} exists, read and follow it for your current swarm session identity.`
  );
}

function removeCodexHook(agentName?: string, swarmId?: string): void {
  const sessionPath = getCodexSessionPath();
  if (!fs.existsSync(sessionPath)) return;

  const content = fs.readFileSync(sessionPath, 'utf-8');
  const matchesAgent = !agentName || content.includes(`as "${agentName}"`);
  const matchesSwarm = !swarmId || content.includes(`SWARM_ID="${swarmId}"`) || content.includes(`SWARM_ID=${swarmId}`);
  if (matchesAgent && matchesSwarm) {
    fs.unlinkSync(sessionPath);
    removeInstructionsReference('<!-- swarm-session -->');
  }
}

/**
 * Install a durable global Grok UserPromptSubmit hook.
 * Grok discovers hooks from ~/.grok/hooks/*.json (always trusted).
 */
function installGrokHook(): void {
  const hookPath = getGrokAwarenessHookPath();
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });

  // Prefer the durable awareness script; fall back to the generated headless one.
  const command = fs.existsSync(AWARENESS_HOOK_SCRIPT) ? AWARENESS_HOOK_SCRIPT : HOOK_SCRIPT;
  const payload = {
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command,
              timeout: 5,
            },
          ],
        },
      ],
    },
  };
  fs.writeFileSync(hookPath, `${JSON.stringify(payload, null, 2)}\n`);
}
