import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CLAIM_EVIDENCE_KINDS, CLAIM_KINDS } from './tasks.js';

const ROUTING_DOC_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'docs',
  'ROUTING.md'
);

export const AGENT_HELP_GROUPS = [
  'identity',
  'messaging',
  'tasks+evidence',
  'grants+escalation',
  'board',
  'janitor',
  'rescue',
] as const;

export type AgentHelpGroup = typeof AGENT_HELP_GROUPS[number];

export interface AgentHelpEntry {
  command: string;
  group: AgentHelpGroup;
  line: string;
}

export const AGENT_HELP_ENTRIES: readonly AgentHelpEntry[] = [
  { command: 'create', group: 'identity', line: 'create — create or update a swarm' },
  { command: 'swarms', group: 'identity', line: 'swarms — list known swarms' },
  { command: 'delete', group: 'identity', line: 'delete — delete a non-default swarm' },
  { command: 'join', group: 'identity', line: 'join — register this terminal' },
  { command: 'leave', group: 'identity', line: 'leave — deregister this terminal' },
  { command: 'register-a2a', group: 'identity', line: 'register-a2a — register a remote agent' },
  { command: 'unregister-a2a', group: 'identity', line: 'unregister-a2a — remove a remote agent' },
  { command: 'discover', group: 'identity', line: 'discover — inspect an A2A agent card' },
  { command: 'serve', group: 'identity', line: 'serve — expose an A2A inbox endpoint' },
  { command: 'members', group: 'identity', line: 'members — list active agents' },
  { command: 'status', group: 'identity', line: 'status — read or set agent status' },
  { command: 'whoami', group: 'identity', line: 'whoami — show current identity' },
  { command: 'version', group: 'identity', line: 'version [--check] — build SHA; --check compares to origin' },
  { command: 'spawn', group: 'identity', line: 'spawn --split | --new-workspace <name> — local worker' },
  { command: 'read', group: 'identity', line: 'read — inspect a local agent screen' },
  { command: 'rename', group: 'identity', line: 'rename — rename an agent tab' },
  { command: 'move', group: 'identity', line: 'move — move an agent tab' },
  { command: 'workspaces', group: 'identity', line: 'workspaces — list cmux workspaces' },
  { command: 'rename-workspace', group: 'identity', line: 'rename-workspace — rename a workspace' },
  { command: 'hook-context', group: 'identity', line: 'hook-context — emit prompt-time context' },
  { command: 'help', group: 'identity', line: 'help — show command help' },

  { command: 'send', group: 'messaging', line: 'send — message named agents' },
  { command: 'broadcast', group: 'messaging', line: 'broadcast — message the swarm' },
  { command: 'ack', group: 'messaging', line: 'ack — acknowledge deliveries' },
  { command: 'inbox', group: 'messaging', line: 'inbox — read queued messages' },
  { command: 'redeliver', group: 'messaging', line: 'redeliver — retry pending pushes' },

  { command: 'task', group: 'tasks+evidence', line: 'task — start, checkpoint, show, list, close, reopen' },
  { command: 'run', group: 'tasks+evidence', line: 'run — capture a task evidence log' },
  { command: 'handoff', group: 'tasks+evidence', line: 'handoff — transfer task authority' },
  { command: 'decision', group: 'tasks+evidence', line: 'decision — record a durable decision' },
  { command: 'harness-review', group: 'tasks+evidence', line: 'harness-review — review a task handoff loop' },

  { command: 'grant', group: 'grants+escalation', line: 'grant — create, list, or revoke authority' },
  { command: 'escalate', group: 'grants+escalation', line: 'escalate — create a decision packet' },
  { command: 'review', group: 'grants+escalation', line: 'review — route a cross-family gate review' },

  { command: 'board', group: 'board', line: 'board — render fleet state or graph (splits beside you; --own-workspace for program setup)' },
  { command: 'stats', group: 'board', line: 'stats — show fleet metrics' },

  { command: 'janitor', group: 'janitor', line: 'janitor — census debris and controls' },

  { command: 'rescue', group: 'rescue', line: 'rescue — preserve stranded work' },
  { command: 'reap', group: 'rescue', line: 'reap — prune dead agents' },
  { command: 'reset', group: 'rescue', line: 'reset — clear ephemeral swarm state' },
] as const;

export const CANONICAL_CLI_COMMANDS: readonly string[] = AGENT_HELP_ENTRIES.map(entry => entry.command);

export function renderAgentHelp(): string {
  const lines: string[] = [];
  for (const group of AGENT_HELP_GROUPS) {
    lines.push(`[${group}]`);
    lines.push(...AGENT_HELP_ENTRIES.filter(entry => entry.group === group).map(entry => entry.line));
    if (group === 'tasks+evidence') {
      lines.push(...CLAIM_KINDS.map(claimKind => {
        const required = claimKind === 'code-merged'
          ? 'git gates only'
          : CLAIM_EVIDENCE_KINDS[claimKind].join(', ');
        return `claim ${claimKind} → ${required}`;
      }));
      lines.push('claim change: task start <slug> --claim <kind> [--takeover]');
      lines.push('close records a disposition; it never performs a merge — landing happens via your operator/gates');
    }
  }
  if (fs.existsSync(ROUTING_DOC_PATH)) lines.push(ROUTING_DOC_PATH);
  return lines.join('\n');
}
