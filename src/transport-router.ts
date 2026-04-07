import fs from 'fs';
import path from 'path';
import os from 'os';
import { Transport, TransportAgent, TransportDeliveryResult } from './transport-interface.js';
import { CmuxTransport } from './cmux-transport.js';
import { A2ATransport } from './a2a-transport.js';
import { HeadlessTransport } from './headless-transport.js';
import { AppleScriptTransport } from './applescript-transport.js';

const cmux = new CmuxTransport();
const a2a = new A2ATransport();
const headless = new HeadlessTransport();
const applescript = new AppleScriptTransport();

function hasAppleScriptSurface(agentName: string): boolean {
  return fs.existsSync(path.join(os.homedir(), '.swarm', 'surfaces', `${agentName}.json`));
}

export function getTransport(agentType: string, agentName?: string): Transport {
  switch (agentType) {
    case 'a2a': return a2a;
    case 'headless':
      // Use AppleScript push if a surface is registered, otherwise inbox-only
      if (agentName && hasAppleScriptSurface(agentName)) return applescript;
      return headless;
    case 'cmux': return cmux;
    default: return cmux;
  }
}

export async function deliverToAgent(agent: TransportAgent, text: string): Promise<TransportDeliveryResult> {
  const transport = getTransport(agent.agent_type, agent.name);
  return transport.deliverMessage(agent, text);
}

export async function isAgentAlive(agent: TransportAgent): Promise<boolean> {
  const transport = getTransport(agent.agent_type, agent.name);
  return transport.isAlive(agent);
}
