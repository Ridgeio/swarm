import { Transport, TransportAgent, TransportDeliveryResult } from './transport-interface.js';
import { sendToSurface, SurfaceGoneError, isSurfaceAlive } from './transport.js';

export class CmuxTransport implements Transport {
  async deliverMessage(agent: TransportAgent, formattedText: string): Promise<TransportDeliveryResult> {
    try {
      sendToSurface(agent.surface_id, formattedText, agent.workspace_id);
      return { delivered: true };
    } catch (err) {
      if (err instanceof SurfaceGoneError) {
        return { delivered: false, error: `${agent.name}'s terminal is no longer active` };
      }
      throw err;
    }
  }

  async isAlive(agent: TransportAgent): Promise<boolean> {
    return isSurfaceAlive(agent.surface_id, agent.workspace_id);
  }
}
