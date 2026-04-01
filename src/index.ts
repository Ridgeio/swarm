import { getDb } from './db.js';
import { joinAgent, leaveAgent, getSelf, getAgent, listAgents, updateStatus, updateHeartbeat } from './registry.js';
import { sendMessage, broadcastMessage, getInbox } from './mailbox.js';
import { readScreen, identify } from './transport.js';

const args = process.argv.slice(2);
const command = args[0];

function requireSelf() {
  const surfaceId = process.env.CMUX_SURFACE_ID;
  if (!surfaceId) {
    console.error('Error: CMUX_SURFACE_ID is not set. Are you running inside Cmux?');
    process.exit(1);
  }
  const db = getDb();
  const self = getSelf(db);
  if (!self) {
    console.error('Error: Not joined to swarm. Run "swarm join <name>" first.');
    process.exit(1);
  }
  updateHeartbeat(db, surfaceId);
  return { db, self, surfaceId };
}

function getFlag(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

function printHelp() {
  console.log(`swarm — Cross-terminal agent coordination via Cmux

Commands:
  swarm join <name> [--description <text>]   Register this terminal
  swarm leave                                 Deregister
  swarm send <agent> <message>                Send message to agent
  swarm broadcast <message>                   Send to all agents
  swarm inbox [--peek]                        Read pending messages
  swarm members                               List active agents
  swarm status [--set <desc>] [--agent <name>] Update or query status
  swarm whoami                                Show own registration
  swarm read <agent> [--lines <n>]            Read agent's terminal
  swarm reset                                 Clear all agents and messages
  swarm help                                  Show this help`);
}

try {
  switch (command) {
    case 'join': {
      const name = args[1];
      if (!name) {
        console.error('Usage: swarm join <name> [--description <text>]');
        process.exit(1);
      }
      const { surfaceId, workspaceId } = identify();
      if (!surfaceId) {
        console.error('Error: CMUX_SURFACE_ID is not set. Are you running inside Cmux?');
        process.exit(1);
      }
      const description = getFlag('--description');
      const db = getDb();
      const agent = joinAgent(db, name, surfaceId, workspaceId, process.ppid, description);
      console.log(`Joined swarm as "${agent.name}" (surface: ${agent.surface_id})`);
      break;
    }

    case 'leave': {
      const { db, self } = requireSelf();
      leaveAgent(db, self.surface_id);
      console.log(`Left swarm (was "${self.name}")`);
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
      const result = sendMessage(db, self.name, targetName, message);
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
      const result = broadcastMessage(db, self.name, message);
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
      const agents = listAgents(db);
      if (agents.length === 0) {
        console.log('No agents in swarm.');
      } else {
        const surfaceId = process.env.CMUX_SURFACE_ID;
        for (const agent of agents) {
          const you = agent.surface_id === surfaceId ? ' (you)' : '';
          const desc = agent.description ? ` — ${agent.description}` : '';
          console.log(`  ${agent.name}${you}${desc}`);
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
      console.log(`Surface: ${self.surface_id}`);
      console.log(`Workspace: ${self.workspace_id ?? 'N/A'}`);
      console.log(`Joined: ${self.joined_at}`);
      if (self.description) console.log(`Status: ${self.description}`);
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
      const lines = getFlag('--lines');
      const screen = readScreen(target.surface_id, lines ? parseInt(lines, 10) : undefined, target.workspace_id);
      console.log(`--- ${target.name}'s terminal ---`);
      console.log(screen);
      break;
    }

    case 'reset': {
      const db = getDb();
      const agents = listAgents(db);
      db.exec('DELETE FROM agents');
      db.exec('DELETE FROM messages');
      db.exec('DELETE FROM inbox_cursors');
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
