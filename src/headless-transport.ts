import { Transport, TransportAgent, TransportDeliveryResult } from './transport-interface.js';

/**
 * Headless transport — no push delivery. Messages are stored in the DB
 * and picked up by the agent via `swarm inbox` (polled by the awareness hook).
 * There is no surface to ping, so isAlive always returns true and headless agents
 * are never auto-pruned by registry.cleanupStale.
 */
export class HeadlessTransport implements Transport {
  async deliverMessage(_agent: TransportAgent, _formattedText: string): Promise<TransportDeliveryResult> {
    // Messages are already stored in the DB by mailbox.ts before delivery is attempted.
    // Headless agents pick them up via `swarm inbox`. No push needed.
    return { delivered: true };
  }

  async isAlive(_agent: TransportAgent): Promise<boolean> {
    // Headless agents have no probeable surface, so they are treated as alive and are
    // never auto-pruned by registry.cleanupStale (which skips agent_type === 'headless').
    // Stale headless rows are cleared only by an explicit reap or a same-name re-join.
    return true;
  }
}
