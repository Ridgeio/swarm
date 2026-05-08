import { DEFAULT_SWARM_ID } from './db.js';
import { getDb } from './db.js';
import {
  Agent,
  Swarm,
  deleteSwarm,
  findSwarmForCwd,
  forceReap,
  getAgent,
  getOrCreateSwarm,
  getSelf,
  getSwarm,
  getSwarmById,
  joinA2AAgent,
  joinAgent,
  joinHeadlessAgent,
  leaveA2AAgent,
  leaveAgent,
  leaveHeadlessAgent,
  listAgents,
  listAgentsSync,
  listSwarms,
  reapAll,
  reapIfDead,
  updateHeartbeat,
  updateStatus,
  updateWorkspace,
} from './registry.js';
import { sendMessage, broadcastMessage, getInbox } from './mailbox.js';
import { readScreen, identify, spawnSurfaceInWorkspace, spawnWorkspace, renameTab, moveSurface, listWorkspaces, renameWorkspace, sendToSurface, sleep } from './transport.js';
import { installHook, removeHook, detectHost } from './hooks.js';
import { registerSurface, removeSurface } from './applescript-transport.js';

const rawArgs = process.argv.slice(2);

function parseGlobalFlags(input: string[]): { args: string[]; swarmName: string | undefined } {
  const stripped: string[] = [];
  let swarmName: string | undefined;

  for (let i = 0; i < input.length; i += 1) {
    const arg = input[i];
    if (arg === '--swarm' || arg === '-s') {
      swarmName = input[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--swarm=')) {
      swarmName = arg.slice('--swarm='.length);
      continue;
    }
    stripped.push(arg);
  }

  return { args: stripped, swarmName };
}

const parsed = parseGlobalFlags(rawArgs);
const args = parsed.args;
const command = args[0];
const explicitSwarmName = parsed.swarmName;

function getFlag(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

function resolveSelectedSwarm(db: ReturnType<typeof getDb>, create: boolean = false): Swarm {
  if (explicitSwarmName) {
    const existing = getSwarm(db, explicitSwarmName);
    if (existing) return existing;
    if (create) return getOrCreateSwarm(db, explicitSwarmName);
    throw new Error(`Swarm "${explicitSwarmName}" not found. Run "swarm create ${explicitSwarmName}" first.`);
  }

  if (process.env.SWARM_ID) {
    const byId = getSwarmById(db, process.env.SWARM_ID);
    if (byId) return byId;
  }

  if (process.env.SWARM_NAME) {
    const byName = getSwarm(db, process.env.SWARM_NAME);
    if (byName) return byName;
    if (create) return getOrCreateSwarm(db, process.env.SWARM_NAME);
  }

  const self = getSelf(db);
  if (self) {
    const swarm = getSwarmById(db, self.swarm_id);
    if (swarm) return swarm;
  }

  const cwdSwarm = findSwarmForCwd(db);
  if (cwdSwarm) return cwdSwarm;

  return getOrCreateSwarm(db);
}

function requireSelf(): { db: ReturnType<typeof getDb>; self: Agent; swarm: Swarm; surfaceId: string } {
  const db = getDb();
  const explicitSwarm = explicitSwarmName ? getSwarm(db, explicitSwarmName) : null;
  if (explicitSwarmName && !explicitSwarm) {
    console.error(`Error: Swarm "${explicitSwarmName}" not found.`);
    process.exit(1);
  }

  const self = getSelf(db, explicitSwarm?.id);
  if (!self) {
    const surfaceId = process.env.CMUX_SURFACE_ID;
    const agentName = process.env.SWARM_AGENT_NAME;
    const target = explicitSwarm ? ` "${explicitSwarm.name}"` : '';
    if (!surfaceId && !agentName) {
      console.error(`Error: Not in a swarm context${target}. Set CMUX_SURFACE_ID (Cmux) or join headless with "swarm join <name>".`);
    } else {
      console.error(`Error: Not joined to swarm${target}. Run "swarm join <name>${explicitSwarm ? ` --swarm ${explicitSwarm.name}` : ''}" first.`);
    }
    process.exit(1);
  }

  updateHeartbeat(db, self.swarm_id, self.surface_id);
  const swarm = getSwarmById(db, self.swarm_id) ?? getOrCreateSwarm(db);
  return { db, self, swarm, surfaceId: self.surface_id };
}

function requireCmuxAgent(agent: { name: string; agent_type: string }, action: string): void {
  if (agent.agent_type === 'a2a') {
    console.error(`Cannot ${action} for A2A agent "${agent.name}". This command only works with Cmux/headless terminal agents.`);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`swarm — Cross-terminal agent coordination via Cmux, headless, and A2A

Swarm Selection:
  --swarm <name>, -s <name>                       Run the command in a named swarm

Swarm Management:
  swarm create <name> [--root <path>]             Create or update a named swarm
    [--description <text>]
  swarm swarms                                    List known swarms
  swarm delete <name>                             Delete a non-default swarm

Agent Management:
  swarm join <name> [--description <text>]        Register in the selected swarm
    [--headless] [--root <path>]                  Force headless / set swarm root on create
  swarm leave                                      Deregister from the current swarm
  swarm register-a2a <name> --endpoint <url>       Register an A2A agent
    [--description <text>]
  swarm unregister-a2a <name>                      Remove an A2A agent
  swarm discover <url>                             Fetch and display an A2A agent card

Communication:
  swarm send <agent> <message>                     Send message within the current swarm
  swarm broadcast <message>                        Send to all agents in the current swarm
  swarm inbox [--peek]                             Read pending messages

Status:
  swarm members                                    List agents in the current swarm
  swarm status [--set <desc>] [--agent <name>]     Update or query status
  swarm whoami                                     Show own registration

Cmux-only:
  swarm read <agent> [--lines <n>]                 Read agent's terminal
  swarm spawn [--cwd <path>] [--autonomous]        Spawn an agent in a new tab
    [--agent claude|codex] [--name <name>]           (default: claude; --autonomous adds
                                                      --dangerously-skip-permissions for claude
                                                      and --yolo for codex)
  swarm rename <agent> <title>                     Rename an agent's Cmux tab
  swarm move <agent> --workspace <id>              Move agent to another workspace
  swarm workspaces                                 List Cmux workspaces
  swarm rename-workspace <id> <title>              Rename a workspace

Admin:
  swarm reap [--name <agent>] [--force] [--all]    Prune dead agents after liveness probe
  swarm reset [--all]                              Clear current swarm, or all swarms
  swarm help                                       Show this help`);
}

function joinAsHeadless(db: ReturnType<typeof getDb>, swarm: Swarm, name: string, description?: string): void {
  const agent = joinHeadlessAgent(db, swarm.id, name, description);
  const parts: string[] = [`swarm: ${swarm.name}`, 'headless'];

  const surface = registerSurface(swarm.id, name);
  if (surface) {
    parts.push(`${surface.app} push`);
  }

  const host = detectHost();
  if (host) {
    installHook(host, name, swarm.id, swarm.name);
    parts.push(`${host} hook`);
  }

  console.log(`Joined swarm "${swarm.name}" as "${agent.name}" (${parts.join(', ')})`);
  if (!surface && !host) {
    console.log('Tip: Run "swarm inbox" periodically to check for messages.');
  }
}

function printHookContext(): void {
  const { db, self, swarm } = requireSelf();
  const agents = listAgentsSync(db, self.swarm_id);
  const members = agents.map(agent => agent.name).join(', ');
  const inbox = getInbox(db, self.swarm_id, self.name);
  const inboxSection = inbox.length === 0
    ? ''
    : `\nNEW MESSAGES (respond to these):\n${inbox.map(msg => {
      const time = new Date(msg.created_at).toLocaleTimeString();
      return `[${time}] ${msg.from_agent}: ${msg.body}`;
    }).join('\n')}`;

  const readCommand = self.agent_type === 'a2a' ? '' : ' | read <agent> --lines 20';
  console.log(`You are "${self.name}" in swarm "${swarm.name}". Active agents: ${members || '(none)'}.
Commands: swarm send <agent> "<msg>" | broadcast "<msg>" | inbox | members | status --set "<desc>"${readCommand}
When you see [SWARM from <name>]: treat it as a message from another agent and respond.${inboxSection}`);
}

async function main() {
  try {
    switch (command) {
      case 'create': {
        const name = args[1];
        if (!name) {
          console.error('Usage: swarm create <name> [--root <path>] [--description <text>]');
          process.exit(1);
        }
        const db = getDb();
        const swarm = getOrCreateSwarm(db, name, getFlag('--root'), getFlag('--description'));
        console.log(`Swarm "${swarm.name}" ready${swarm.root_path ? ` (root: ${swarm.root_path})` : ''}.`);
        break;
      }

      case 'swarms': {
        const db = getDb();
        const current = getSelf(db);
        const swarms = listSwarms(db);
        for (const swarm of swarms) {
          const marker = current?.swarm_id === swarm.id ? ' (current)' : '';
          const root = swarm.root_path ? ` — ${swarm.root_path}` : '';
          console.log(`  ${swarm.name}${marker}${root}`);
        }
        console.log(`\n${swarms.length} swarm(s)`);
        break;
      }

      case 'delete': {
        const name = args[1];
        if (!name) {
          console.error('Usage: swarm delete <name>');
          process.exit(1);
        }
        const db = getDb();
        const swarm = deleteSwarm(db, name);
        if (!swarm) {
          console.error(`Swarm "${name}" not found.`);
          process.exit(1);
        }
        console.log(`Deleted swarm "${swarm.name}".`);
        break;
      }

      case 'join': {
        const name = args[1];
        if (!name) {
          console.error('Usage: swarm join <name> [--description <text>] [--headless] [--swarm <name>]');
          process.exit(1);
        }
        const headless = hasFlag('--headless');
        const description = getFlag('--description');
        const db = getDb();
        const swarm = explicitSwarmName
          ? getOrCreateSwarm(db, explicitSwarmName, getFlag('--root'))
          : resolveSelectedSwarm(db, true);

        const reaped = await reapIfDead(db, swarm.id, name);
        if (reaped) {
          console.log(`Reaped stale "${reaped.name}" (${reaped.agent_type}) from swarm "${swarm.name}" — surface was dead.`);
        }

        const existing = getAgent(db, swarm.id, name);
        if (existing && existing.agent_type === 'a2a') {
          console.error(`Agent "${name}" is already registered as a live A2A agent in swarm "${swarm.name}". Choose a different name or run "swarm unregister-a2a ${name} --swarm ${swarm.name}" first.`);
          process.exit(1);
        }

        if (headless) {
          joinAsHeadless(db, swarm, name, description);
        } else {
          const { surfaceId, workspaceId } = identify();
          if (!surfaceId) {
            joinAsHeadless(db, swarm, name, description);
          } else {
            const agent = joinAgent(db, swarm.id, name, surfaceId, workspaceId, process.ppid, description);
            renameTab(surfaceId, `${swarm.name}/${name}`, workspaceId);
            console.log(`Joined swarm "${swarm.name}" as "${agent.name}" (surface: ${agent.surface_id})`);
          }
        }
        break;
      }

      case 'leave': {
        const { db, self, swarm } = requireSelf();
        if (self.agent_type === 'headless') {
          leaveHeadlessAgent(db, self.swarm_id, self.name);
          removeSurface(self.swarm_id, self.name);
          const host = detectHost();
          if (host) {
            removeHook(host, self.name, self.swarm_id);
          }
        } else {
          leaveAgent(db, self.swarm_id, self.surface_id);
        }
        console.log(`Left swarm "${swarm.name}" (was "${self.name}")`);
        break;
      }

      case 'register-a2a': {
        const name = args[1];
        const endpoint = getFlag('--endpoint');
        if (!name || !endpoint) {
          console.error('Usage: swarm register-a2a <name> --endpoint <url> [--description <text>] [--swarm <name>]');
          process.exit(1);
        }

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
        const swarm = resolveSelectedSwarm(db, true);
        const reaped = await reapIfDead(db, swarm.id, name);
        if (reaped) {
          console.log(`Reaped stale "${reaped.name}" (${reaped.agent_type}) from swarm "${swarm.name}" — surface was dead.`);
        }
        const agent = joinA2AAgent(db, swarm.id, name, endpoint, agentDescription);
        console.log(`Registered A2A agent "${agent.name}" in swarm "${swarm.name}" @ ${endpoint}`);
        break;
      }

      case 'unregister-a2a': {
        const name = args[1];
        if (!name) {
          console.error('Usage: swarm unregister-a2a <name> [--swarm <name>]');
          process.exit(1);
        }
        const db = getDb();
        const swarm = resolveSelectedSwarm(db);
        const removed = leaveA2AAgent(db, swarm.id, name);
        if (removed) {
          console.log(`Removed A2A agent "${name}" from swarm "${swarm.name}"`);
        } else {
          console.error(`A2A agent "${name}" not found in swarm "${swarm.name}".`);
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
        const result = await sendMessage(db, self.swarm_id, self.name, targetName, message);
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
        const result = await broadcastMessage(db, self.swarm_id, self.name, message);
        console.log(`Broadcast to ${result.sent} agent(s)${result.failed > 0 ? `, ${result.failed} failed` : ''}`);
        break;
      }

      case 'inbox': {
        const { db, self } = requireSelf();
        const peek = hasFlag('--peek');
        const messages = getInbox(db, self.swarm_id, self.name, peek);
        if (messages.length === 0) {
          console.log('No new messages.');
        } else {
          for (const msg of messages) {
            const time = new Date(msg.created_at).toLocaleTimeString();
            console.log(`[${time}] ${msg.from_agent}: ${msg.body}`);
          }
          console.log(`\n${messages.length} message(s)${peek ? ' (peek mode, not marked as read)' : ''}`);
        }
        break;
      }

      case 'members': {
        const db = getDb();
        const swarm = resolveSelectedSwarm(db);
        const agents = await listAgents(db, swarm.id);
        if (agents.length === 0) {
          console.log(`No agents in swarm "${swarm.name}".`);
        } else {
          const self = getSelf(db, swarm.id);
          console.log(`Swarm: ${swarm.name}`);
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
          updateStatus(db, self.swarm_id, self.surface_id, setDesc);
          console.log(`Status updated: ${setDesc}`);
        } else if (agentName) {
          const db = getDb();
          const swarm = resolveSelectedSwarm(db);
          const agent = getAgent(db, swarm.id, agentName);
          if (!agent) {
            console.error(`Agent "${agentName}" not found in swarm "${swarm.name}".`);
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
        const { self, swarm } = requireSelf();
        console.log(`Name: ${self.name}`);
        console.log(`Swarm: ${swarm.name}`);
        console.log(`Swarm ID: ${self.swarm_id}`);
        console.log(`Type: ${self.agent_type}`);
        console.log(`Surface: ${self.surface_id}`);
        console.log(`Workspace: ${self.workspace_id ?? 'N/A'}`);
        console.log(`Joined: ${self.joined_at}`);
        if (self.description) console.log(`Status: ${self.description}`);
        if (self.endpoint_url) console.log(`Endpoint: ${self.endpoint_url}`);
        break;
      }

      case 'read': {
        const { db, self } = requireSelf();
        const targetName = args[1];
        if (!targetName) {
          console.error('Usage: swarm read <agent> [--lines <n>]');
          process.exit(1);
        }
        const target = getAgent(db, self.swarm_id, targetName);
        if (!target) {
          console.error(`Agent "${targetName}" not found in this swarm.`);
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
        const db = getDb();
        const swarm = resolveSelectedSwarm(db, true);
        const name = getFlag('--name');
        const cwd = getFlag('--cwd') || process.cwd();
        const autonomous = hasFlag('--autonomous');
        const agentFlag = (getFlag('--agent') || 'claude').toLowerCase();
        const { workspaceId } = identify();

        let agentCmd: string;
        let agentLabel: string;
        if (agentFlag === 'claude') {
          agentCmd = autonomous ? 'claude --dangerously-skip-permissions' : 'claude';
          agentLabel = 'Claude Code';
        } else if (agentFlag === 'codex') {
          agentCmd = autonomous ? 'codex --yolo' : 'codex';
          agentLabel = 'Codex CLI';
        } else {
          console.error(`Unknown --agent "${agentFlag}". Supported: claude, codex.`);
          process.exit(1);
        }

        let result: { workspaceRef: string | null; surfaceRef: string } | null = null;
        let spawnedInCurrentWorkspace = false;

        if (workspaceId) {
          try {
            result = spawnSurfaceInWorkspace(cwd, agentCmd, workspaceId);
            spawnedInCurrentWorkspace = !!result;
          } catch {
            result = null;
          }
        }

        if (!result) {
          result = spawnWorkspace(cwd, agentCmd);
        }

        if (!result) {
          console.error(`Failed to spawn ${agentLabel} session`);
          process.exit(1);
        }

        const joinArg = name || '';
        const swarmArg = `--swarm ${swarm.name}`;
        const location = spawnedInCurrentWorkspace ? 'new tab' : 'new workspace';
        console.log(`Spawned new ${agentLabel} session in ${cwd} (${location}: ${result.workspaceRef ?? 'current workspace'}, ${result.surfaceRef})`);

        console.log(`Waiting for ${agentLabel} to initialize...`);
        sleep(8);

        try {
          sendToSurface(result.surfaceRef, `/join-swarm ${joinArg} ${swarmArg}`.trim(), result.workspaceRef);
          console.log(`Sent /join-swarm ${joinArg} ${swarmArg}`.trim());
        } catch {
          console.log(`Could not auto-join. Run /join-swarm ${joinArg} ${swarmArg}`.trim());
        }
        break;
      }

      case 'rename': {
        const { db, self } = requireSelf();
        const targetName = args[1];
        const title = args.slice(2).join(' ');
        if (!targetName || !title) {
          console.error('Usage: swarm rename <agent> <title>');
          process.exit(1);
        }
        const target = getAgent(db, self.swarm_id, targetName);
        if (!target) {
          console.error(`Agent "${targetName}" not found in this swarm.`);
          process.exit(1);
        }
        requireCmuxAgent(target, 'rename tab');
        renameTab(target.surface_id, title, target.workspace_id);
        console.log(`Renamed ${targetName}'s tab to "${title}"`);
        break;
      }

      case 'move': {
        const { db, self } = requireSelf();
        const targetName = args[1];
        const targetWorkspace = getFlag('--workspace');
        if (!targetName || !targetWorkspace) {
          console.error('Usage: swarm move <agent> --workspace <id>');
          process.exit(1);
        }
        const target = getAgent(db, self.swarm_id, targetName);
        if (!target) {
          console.error(`Agent "${targetName}" not found in this swarm.`);
          process.exit(1);
        }
        requireCmuxAgent(target, 'move');
        try {
          moveSurface(target.surface_id, targetWorkspace);
          updateWorkspace(db, target.swarm_id, target.surface_id, targetWorkspace);
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

      case 'reap': {
        const db = getDb();
        const name = getFlag('--name');
        const force = hasFlag('--force');
        const all = hasFlag('--all');
        const swarm = all ? null : resolveSelectedSwarm(db);

        if (force && !name) {
          console.error('Usage: swarm reap --name <agent> --force  (--force requires --name)');
          process.exit(1);
        }

        if (name) {
          if (!swarm) {
            console.error('Usage: swarm reap --name <agent> [--force] [--swarm <name>]  (--name cannot be used with --all)');
            process.exit(1);
          }
          if (force) {
            const removed = forceReap(db, swarm.id, name);
            if (removed) {
              if (removed.agent_type === 'headless') {
                removeSurface(removed.swarm_id, removed.name);
                const host = detectHost();
                if (host) removeHook(host, removed.name, removed.swarm_id);
              }
              console.log(`Force-reaped "${removed.name}" (${removed.agent_type}) from swarm "${swarm.name}".`);
            } else {
              console.error(`No agent named "${name}" found in swarm "${swarm.name}".`);
              process.exit(1);
            }
          } else {
            const removed = await reapIfDead(db, swarm.id, name);
            if (removed) {
              console.log(`Reaped "${removed.name}" (${removed.agent_type}) from swarm "${swarm.name}" — surface confirmed dead.`);
            } else {
              const still = getAgent(db, swarm.id, name);
              if (!still) {
                console.error(`No agent named "${name}" found in swarm "${swarm.name}".`);
                process.exit(1);
              } else if (still.agent_type === 'headless') {
                console.error(`"${name}" is a headless agent; has no probeable surface. Use --force to remove.`);
                process.exit(1);
              } else {
                console.log(`"${name}" is alive; not reaped. Use --force to remove anyway.`);
              }
            }
          }
        } else {
          const removed = await reapAll(db, swarm?.id);
          if (removed.length === 0) {
            console.log('No dead agents found.');
          } else {
            console.log(`Reaped ${removed.length} agent(s):`);
            for (const a of removed) console.log(`  ${a.name} (${a.agent_type})${swarm ? '' : ` from ${getSwarmById(db, a.swarm_id)?.name ?? a.swarm_id}`}`);
          }
        }
        break;
      }

      case 'reset': {
        const db = getDb();
        const all = hasFlag('--all');
        const agents = listAgentsSync(db, all ? undefined : resolveSelectedSwarm(db).id);
        const host = detectHost();
        for (const a of agents.filter(agent => agent.agent_type === 'headless')) {
          removeSurface(a.swarm_id, a.name);
          if (host) removeHook(host, a.name, a.swarm_id);
        }

        if (all) {
          db.exec('DELETE FROM agents');
          db.exec('DELETE FROM messages');
          db.exec('DELETE FROM inbox_cursors');
          db.prepare('DELETE FROM swarms WHERE id != ?').run(DEFAULT_SWARM_ID);
          console.log(`Swarm reset. Cleared ${agents.length} agent(s), all messages, and all non-default swarms.`);
        } else {
          const swarm = resolveSelectedSwarm(db);
          db.prepare('DELETE FROM agents WHERE swarm_id = ?').run(swarm.id);
          db.prepare('DELETE FROM messages WHERE swarm_id = ?').run(swarm.id);
          db.prepare('DELETE FROM inbox_cursors WHERE swarm_id = ?').run(swarm.id);
          console.log(`Swarm "${swarm.name}" reset. Cleared ${agents.length} agent(s) and its messages.`);
        }
        break;
      }

      case 'hook-context':
        printHookContext();
        break;

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
