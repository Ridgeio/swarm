import { Transport, TransportAgent, TransportDeliveryResult } from './transport-interface.js';
import { sendToSurface, SurfaceGoneError, isSurfaceAlive } from './transport.js';

export class CmuxTransport implements Transport {
  async deliverMessage(agent: TransportAgent, formattedText: string): Promise<TransportDeliveryResult> {
    // Cmux socket only. There used to be an AppleScript clipboard-paste fallback here,
    // but it could not target a surface — it activated the cmux app and pasted into
    // whatever tab was FOCUSED (its Cmd+N workspace switch only understood legacy
    // "workspace:N" refs, never UUIDs), stole focus, clobbered the clipboard, and
    // falsely reported delivered=true. Field-observed misrouting messages into the
    // user's active tab (the "[SWARM from Bob]: ping" incident — the test suite's
    // fake-surface sends fell back to it and pasted into the frontmost terminal).
    // A socket failure is handled gracefully instead: the message stays queued in the
    // DB (inbox/hook pickup) and the redeliver worker retries the socket path.
    try {
      sendToSurface(agent.surface_id, formattedText, agent.workspace_id);
      return { delivered: true };
    } catch (err) {
      if (!(err instanceof SurfaceGoneError)) throw err;
      return { delivered: false, error: `${agent.name}'s terminal is not reachable via the cmux socket` };
    }
  }

  async isAlive(agent: TransportAgent): Promise<boolean> {
    return isSurfaceAlive(agent.surface_id, agent.workspace_id);
  }
}
