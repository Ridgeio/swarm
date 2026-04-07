import { Transport, TransportAgent, TransportDeliveryResult } from './transport-interface.js';
import { CmuxTransport } from './cmux-transport.js';
import { A2ATransport } from './a2a-transport.js';
import { HeadlessTransport } from './headless-transport.js';

const cmux = new CmuxTransport();
const a2a = new A2ATransport();
const headless = new HeadlessTransport();

export function getTransport(agentType: string): Transport {
  switch (agentType) {
    case 'a2a': return a2a;
    case 'headless': return headless;
    case 'cmux': return cmux;
    default: return cmux;
  }
}

export async function deliverToAgent(agent: TransportAgent, text: string): Promise<TransportDeliveryResult> {
  const transport = getTransport(agent.agent_type);
  return transport.deliverMessage(agent, text);
}

export async function isAgentAlive(agent: TransportAgent): Promise<boolean> {
  const transport = getTransport(agent.agent_type);
  return transport.isAlive(agent);
}
