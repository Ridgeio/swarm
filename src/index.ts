import fs from 'fs';
import path from 'path';
import os from 'os';
import { getDb } from './db.js';
import { joinAgent, leaveAgent, getSelf, getAgent, listAgents, listAgentsSync, updateStatus, updateHeartbeat, updateWorkspace, joinA2AAgent, leaveA2AAgent, joinHeadlessAgent, leaveHeadlessAgent } from './registry.js';
import { sendMessage, broadcastMessage, getInbox } from './mailbox.js';
import { readScreen, identify, spawnWorkspace, renameTab, moveSurface, listWorkspaces, renameWorkspace, sendToSurface, sleep } from './transport.js';
import { installHook, removeHook, detectHost } from './hooks.js';

const args = process.argv.slice(2);
const command = args[0];

function requireSelf() {
  const db = getDb();
  const self = getSelf(db);
  if (!self) {
    const surfaceId = process.env.CMUX_SURFACE_ID;
    const agentName = process.env.SWARM_AGENT_NAME;
    if (!surfaceId && !agentName) {
      console.error('Error: Not in a swarm context. Set CMUX_SURFACE_ID (Cmux) or SWARM_AGENT_NAME (headless).');
    } else {
      console.error('Error: Not joined to swarm. Run "swarm join <name>" first.');
    }
    process.exit(1);
  }
  updateHeartbeat(db, self.surface_id);
  return { db, self, surfaceId: self.surface_id };
}

function getFlag(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

function requireCmuxAgent(agent: { name: string; agent_type: string }, action: string): void {
  if (agent.agent_type === 'a2a') {
    console.error(`Cannot ${action} for A2A agent "${agent.name}". This command only works with Cmux agents.`);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`swarm — Cross-terminal agent coordination via Cmux, headless, and A2A

Agent Management:
  swarm join <name> [--description <text>]        Register (auto-detects Cmux or headless)
    [--headless]                                   Force headless mode (no Cmux required)
  swarm leave                                      Deregister from the swarm
  swarm register-a2a <name> --endpoint <url>       Register an A2A agent
    [--description <text>]
  swarm unregister-a2a <name>                      Remove an A2A agent
  swarm discover <url>                             Fetch and display an A2A agent card

Communication:
  swarm send <agent> <message>                     Send message (any transport)
  swarm broadcast <message>                        Send to all agents
  swarm inbox [--peek]                             Read pending messages

Status:
  swarm members                                    List active agents
  swarm status [--set <desc>] [--agent <name>]     Update or query status
  swarm whoami                                     Show own registration

Cmux-only:
  swarm read <agent> [--lines <n>]                 Read agent's terminal
  swarm spawn [--cwd <path>] [--autonomous]        Spawn a new Claude Code session
  swarm rename <agent> <title>                     Rename an agent's Cmux tab
  swarm move <agent> --workspace <id>              Move agent to another workspace
  swarm workspaces                                 List Cmux workspaces
  swarm rename-workspace <id> <title>              Rename a workspace

Admin:
  swarm reset                                      Clear all agents and messages
  swarm help                                       Show this help`);
}

async function main() {
  try {
    switch (command) {
      case 'join': {
        const name = args[1];
        if (!name) {
          console.error('Usage: swarm join <name> [--description <text>] [--headless]');
          process.exit(1);
        }
        const headless = hasFlag('--headless');
        const description = getFlag('--description');
        const db = getDb();
        const existing = getAgent(db, name);
        if (existing && existing.agent_type === 'a2a') {
          console.error(`Agent "${name}" is already registered as an A2A agent. Choose a different name or run "swarm unregister-a2a ${name}" first.`);
          process.exit(1);
        }

        if (headless) {
          const agent = joinHeadlessAgent(db, name, description);
          // Auto-install awareness hook
          const host = detectHost();
          if (host) {
            installHook(host, name);
            console.log(`Joined swarm as "${agent.name}" (headless, ${host} hook installed)`);
          } else {
            console.log(`Joined swarm as "${agent.name}" (headless)`);
            console.log('Tip: Run "swarm inbox" periodically to check for messages.');
          }
        } else {
          const { surfaceId, workspaceId } = identify();
          if (!surfaceId) {
            // Auto-detect: if not in Cmux, fall back to headless
            const agent = joinHeadlessAgent(db, name, description);
            const host = detectHost();
            if (host) {
              installHook(host, name);
              console.log(`Joined swarm as "${agent.name}" (headless, ${host} hook installed)`);
            } else {
              console.log(`Joined swarm as "${agent.name}" (headless — not in Cmux)`);
              console.log('Tip: Run "swarm inbox" periodically to check for messages.');
            }
          } else {
            const agent = joinAgent(db, name, surfaceId, workspaceId, process.ppid, description);
            renameTab(surfaceId, name, workspaceId);
            console.log(`Joined swarm as "${agent.name}" (surface: ${agent.surface_id})`);
          }
        }
        break;
      }

      case 'leave': {
        const { db, self } = requireSelf();
        if (self.agent_type === 'headless') {
          leaveHeadlessAgent(db, self.name);
          const host = detectHost();
          if (host) {
            removeHook(host, self.name);
          }
        } else {
          leaveAgent(db, self.surface_id);
        }
        console.log(`Left swarm (was "${self.name}")`);
        break;
      }

      case 'register-a2a': {
        const name = args[1];
        const endpoint = getFlag('--endpoint');
        if (!name || !endpoint) {
          console.error('Usage: swarm register-a2a <name> --endpoint <url> [--description <text>]');
          process.exit(1);
        }

        // Validate endpoint URL
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(endpoint);
        } catch {
          console.error(`Invalid endpoint URL: "${endpoint}". Must be a valid URL (e.g., http://localhost:18789).`);
          process.exit(1);
        }
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
          console.error(`Unsupported protocol "${parsedUrl.protocol}". Endpoint must use http:// or https://.`);
          process.exit(1);
        }

        // Probe agent — try agent card, then fall back to basic reachability
        let agentDescription = getFlag('--description');
        let reachable = false;
        try {
          const resp = await fetch(`${endpoint}/.well-known/agent-card.json`, {
            signal: AbortSignal.timeout(5000),
          });
          reachable = true;
          if (resp.ok && !agentDescription) {
            const card = await resp.json() as { description?: string };
            agentDescription = card.description;
          }
        } catch {
          // Agent card not available — try basic reachability
          try {
            await fetch(endpoint, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
            reachable = true;
          } catch {
            // Endpoint not reachable
          }
        }
        if (!reachable) {
          console.warn(`Warning: endpoint ${endpoint} is not reachable. Registering anyway.`);
        }

        const db = getDb();
        const agent = joinA2AAgent(db, name, endpoint, agentDescription);
        console.log(`Registered A2A agent "${agent.name}" @ ${endpoint}`);
        break;
      }

      case 'unregister-a2a': {
        const name = args[1];
        if (!name) {
          console.error('Usage: swarm unregister-a2a <name>');
          process.exit(1);
        }
        const db = getDb();
        const removed = leaveA2AAgent(db, name);
        if (removed) {
          console.log(`Removed A2A agent "${name}"`);
        } else {
          console.error(`A2A agent "${name}" not found.`);
          process.exit(1);
        }
        break;
      }

      case 'discover': {
        const url = args[1];
        if (!url) {
          console.error('Usage: swarm discover <url>');
          process.exit(1);
        }
        try {
          const resp = await fetch(`${url}/.well-known/agent-card.json`, {
            signal: AbortSignal.timeout(5000),
          });
          if (!resp.ok) {
            console.error(`Agent card not found at ${url} (HTTP ${resp.status})`);
            process.exit(1);
          }
          const card = await resp.json();
          console.log(JSON.stringify(card, null, 2));
        } catch (err: any) {
          console.error(`Failed to fetch agent card: ${err.message}`);
          process.exit(1);
        }
        break;
      }

      case 'send': {
        const { db, self } = requireSelf();
        const targetName = args[1];
        const message = args.slice(2).join(' ');
        if (!targetName || !message) {
          console.error('Usage: swarm send <agent> <message>');
          process.exit(1);
        }
        if (targetName.toLowerCase() === self.name.toLowerCase()) {
          console.error('Cannot send a message to yourself.');
          process.exit(1);
        }
        const result = await sendMessage(db, self.name, targetName, message);
        console.log(result.message);
        break;
      }

      case 'broadcast': {
        const { db, self } = requireSelf();
        const message = args.slice(1).join(' ');
        if (!message) {
          console.error('Usage: swarm broadcast <message>');
          process.exit(1);
        }
        const result = await broadcastMessage(db, self.name, message);
        console.log(`Broadcast to ${result.sent} agent(s)${result.failed > 0 ? `, ${result.failed} failed` : ''}`);
        break;
      }

      case 'inbox': {
        const { db, self } = requireSelf();
        const peek = hasFlag('--peek');
        const messages = getInbox(db, self.name, peek);
        if (messages.length === 0) {
          console.log('No new messages.');
        } else {
          for (const msg of messages) {
            const from = msg.from_agent;
            const time = new Date(msg.created_at).toLocaleTimeString();
            console.log(`[${time}] ${from}: ${msg.body}`);
          }
          console.log(`\n${messages.length} message(s)${peek ? ' (peek mode, not marked as read)' : ''}`);
        }
        break;
      }

      case 'members': {
        const db = getDb();
        const agents = await listAgents(db);
        if (agents.length === 0) {
          console.log('No agents in swarm.');
        } else {
          const db2 = getDb();
          const self = getSelf(db2);
          for (const agent of agents) {
            const you = self && agent.name.toLowerCase() === self.name.toLowerCase() ? ' (you)' : '';
            const desc = agent.description ? ` — ${agent.description}` : '';
            const type = agent.agent_type === 'a2a' ? ` [a2a] @ ${agent.endpoint_url}` : agent.agent_type === 'headless' ? ' [headless]' : ' [cmux]';
            console.log(`  ${agent.name}${type}${you}${desc}`);
          }
          console.log(`\n${agents.length} agent(s)`);
        }
        break;
      }

      case 'status': {
        const setDesc = getFlag('--set');
        const agentName = getFlag('--agent');

        if (setDesc) {
          const { db, self } = requireSelf();
          updateStatus(db, self.surface_id, setDesc);
          console.log(`Status updated: ${setDesc}`);
        } else if (agentName) {
          const db = getDb();
          const agent = getAgent(db, agentName);
          if (!agent) {
            console.error(`Agent "${agentName}" not found.`);
            process.exit(1);
          }
          console.log(`${agent.name}: ${agent.description ?? '(no status set)'}`);
        } else {
          const { self } = requireSelf();
          console.log(`${self.name}: ${self.description ?? '(no status set)'}`);
        }
        break;
      }

      case 'whoami': {
        const { self } = requireSelf();
        console.log(`Name: ${self.name}`);
        console.log(`Type: ${self.agent_type}`);
        console.log(`Surface: ${self.surface_id}`);
        console.log(`Workspace: ${self.workspace_id ?? 'N/A'}`);
        console.log(`Joined: ${self.joined_at}`);
        if (self.description) console.log(`Status: ${self.description}`);
        if (self.endpoint_url) console.log(`Endpoint: ${self.endpoint_url}`);
        break;
      }

      case 'read': {
        requireSelf(); // ensure we're in the swarm
        const targetName = args[1];
        if (!targetName) {
          console.error('Usage: swarm read <agent> [--lines <n>]');
          process.exit(1);
        }
        const db = getDb();
        const target = getAgent(db, targetName);
        if (!target) {
          console.error(`Agent "${targetName}" not found.`);
          process.exit(1);
        }
        requireCmuxAgent(target, 'read terminal');
        const lines = getFlag('--lines');
        const screen = readScreen(target.surface_id, lines ? parseInt(lines, 10) : undefined, target.workspace_id);
        console.log(`--- ${target.name}'s terminal ---`);
        console.log(screen);
        break;
      }

      case 'spawn': {
        const name = getFlag('--name');
        const cwd = getFlag('--cwd') || process.cwd();
        const autonomous = hasFlag('--autonomous');

        const perms = autonomous ? ' --dangerously-skip-permissions' : '';
        const claudeCmd = `claude${perms}`;

        const result = spawnWorkspace(cwd, claudeCmd);
        if (!result) {
          console.error('Failed to spawn workspace');
          process.exit(1);
        }

        const joinArg = name || '';
        console.log(`Spawned new Claude Code session in ${cwd} (${result.workspaceRef}, ${result.surfaceRef})`);

        // Wait for Claude Code to boot, then send /join-swarm
        console.log('Waiting for Claude Code to initialize...');
        sleep(8);

        try {
          sendToSurface(result.surfaceRef, `/join-swarm ${joinArg}`, result.workspaceRef);
          console.log(`Sent /join-swarm ${joinArg} to new session`);
        } catch {
          console.log(`Could not auto-join. Run /join-swarm ${joinArg} manually in the new tab.`);
        }
        break;
      }

      case 'rename': {
        const targetName = args[1];
        const title = args.slice(2).join(' ');
        if (!targetName || !title) {
          console.error('Usage: swarm rename <agent> <title>');
          process.exit(1);
        }
        const db = getDb();
        const target = getAgent(db, targetName);
        if (!target) {
          console.error(`Agent "${targetName}" not found.`);
          process.exit(1);
        }
        requireCmuxAgent(target, 'rename tab');
        renameTab(target.surface_id, title, target.workspace_id);
        console.log(`Renamed ${targetName}'s tab to "${title}"`);
        break;
      }

      case 'move': {
        const targetName = args[1];
        const targetWorkspace = getFlag('--workspace');
        if (!targetName || !targetWorkspace) {
          console.error('Usage: swarm move <agent> --workspace <id>');
          process.exit(1);
        }
        const db = getDb();
        const target = getAgent(db, targetName);
        if (!target) {
          console.error(`Agent "${targetName}" not found.`);
          process.exit(1);
        }
        requireCmuxAgent(target, 'move');
        try {
          moveSurface(target.surface_id, targetWorkspace);
          updateWorkspace(db, target.surface_id, targetWorkspace);
          console.log(`Moved ${targetName} to workspace ${targetWorkspace}`);
        } catch (err: any) {
          console.error(`Failed to move ${targetName}: ${err.message}`);
          process.exit(1);
        }
        break;
      }

      case 'workspaces': {
        const output = listWorkspaces();
        console.log(output);
        break;
      }

      case 'rename-workspace': {
        const wsId = args[1];
        const title = args.slice(2).join(' ');
        if (!wsId || !title) {
          console.error('Usage: swarm rename-workspace <workspace-id> <title>');
          process.exit(1);
        }
        try {
          renameWorkspace(wsId, title);
          console.log(`Renamed workspace ${wsId} to "${title}"`);
        } catch (err: any) {
          console.error(`Failed to rename workspace: ${err.message}`);
          process.exit(1);
        }
        break;
      }

      case 'reset': {
        const db = getDb();
        const agents = listAgentsSync(db);
        // Clean up hooks for any headless agents before wiping the DB
        const headlessAgents = agents.filter(a => a.agent_type === 'headless');
        if (headlessAgents.length > 0) {
          const host = detectHost();
          if (host) {
            for (const a of headlessAgents) {
              removeHook(host, a.name);
            }
          }
        }
        db.exec('DELETE FROM agents');
        db.exec('DELETE FROM messages');
        db.exec('DELETE FROM inbox_cursors');
        // Clean up headless marker file
        const markerPath = path.join(os.homedir(), '.swarm', 'headless-self');
        if (fs.existsSync(markerPath)) fs.unlinkSync(markerPath);
        console.log(`Swarm reset. Cleared ${agents.length} agent(s) and all messages.`);
        break;
      }

      case 'help':
      case '--help':
      case '-h':
      case undefined:
        printHelp();
        break;

      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
