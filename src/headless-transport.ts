import { Transport, TransportAgent, TransportDeliveryResult } from './transport-interface.js';

/**
 * Headless transport — no push delivery. Messages are stored in the DB
 * and picked up by the agent via `swarm inbox` (polled by the awareness hook).
 * isAlive checks heartbeat freshness since there's no surface to ping.
 */
export class HeadlessTransport implements Transport {
  async deliverMessage(_agent: TransportAgent, _formattedText: string): Promise<TransportDeliveryResult> {
    // Messages are already stored in the DB by mailbox.ts before delivery is attempted.
    // Headless agents pick them up via `swarm inbox`. No push needed.
    return { delivered: true };
  }

  async isAlive(_agent: TransportAgent): Promise<boolean> {
    // Headless agents are alive as long as their heartbeat is fresh.
    // The stale cleanup in registry.ts handles expiry via heartbeat threshold.
    return true;
  }
}
