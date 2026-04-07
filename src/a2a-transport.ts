import { randomUUID } from 'crypto';
import { Transport, TransportAgent, TransportDeliveryResult } from './transport-interface.js';

export class A2ATransport implements Transport {
  async deliverMessage(agent: TransportAgent, formattedText: string): Promise<TransportDeliveryResult> {
    if (!agent.endpoint_url) {
      return { delivered: false, error: `No endpoint URL for A2A agent ${agent.name}` };
    }
    try {
      const { ClientFactory } = await import('@a2a-js/sdk/client');
      const factory = new ClientFactory();
      const client = await factory.createFromUrl(agent.endpoint_url);
      await client.sendMessage({
        message: {
          kind: 'message',
          messageId: randomUUID(),
          role: 'user',
          parts: [{ kind: 'text', text: formattedText }],
        },
      }, { signal: AbortSignal.timeout(15000) });
      return { delivered: true };
    } catch (err: any) {
      return { delivered: false, error: `A2A delivery failed: ${err.message}` };
    }
  }

  async isAlive(agent: TransportAgent): Promise<boolean> {
    if (!agent.endpoint_url) return true; // No endpoint = manually registered, assume alive
    try {
      const resp = await fetch(`${agent.endpoint_url}/.well-known/agent-card.json`, {
        signal: AbortSignal.timeout(3000),
      });
      if (resp.ok) return true;
      // Non-2xx (e.g. 404) means server is up but doesn't serve agent cards — fall through
    } catch {
      // Network error — fall through to HEAD check
    }
    // Fallback: any HTTP response from the endpoint means the server is alive
    try {
      await fetch(agent.endpoint_url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(3000),
      });
      return true;
    } catch {
      return false;
    }
  }
}
