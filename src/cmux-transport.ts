import { Transport, TransportAgent, TransportDeliveryResult } from './transport-interface.js';
import { sendToSurface, SurfaceGoneError, isSurfaceAlive } from './transport.js';

// A keystroke push is reliable only for a single short send. Typing a long,
// multi-chunk message into a live Claude Code TUI silently drops chunks (the
// send reports success but only a fragment lands) and, on retry, duplicates the
// partial text — both observed in the field. So we cap the pushed payload to one
// chunk: short messages push in full; long ones push a compact NUDGE, and the
// awareness hook delivers the full body on the turn the nudge triggers (the hook
// reads the inbox regardless of what was typed). This is the "demote push to a
// notification" fix — the push wakes the recipient; the hook carries the content.
export const PUSH_MAX_CHARS = 60;

export function buildPushText(formattedText: string): string {
  if (formattedText.length <= PUSH_MAX_CHARS) return formattedText;
  const match = formattedText.match(/^\[SWARM from ([^\]]+)\]/);
  const sender = (match ? match[1] : 'a peer').slice(0, 24);
  const nudge = `[SWARM] new message from ${sender} — see inbox`;
  // Defensive: keep the nudge itself within one chunk even for a long sender name.
  return nudge.length <= PUSH_MAX_CHARS ? nudge : nudge.slice(0, PUSH_MAX_CHARS);
}

export class CmuxTransport implements Transport {
  async deliverMessage(agent: TransportAgent, formattedText: string): Promise<TransportDeliveryResult> {
    // Cmux socket only. There used to be an AppleScript clipboard-paste fallback
    // here, but it pasted into whatever tab was FOCUSED and misrouted messages
    // (the "[SWARM from Bob]" incident); it was removed. A socket failure now
    // returns delivered=false: the message stays queued in the DB (inbox/hook
    // pickup) and the redeliver worker retries the socket path.
    try {
      sendToSurface(agent.surface_id, buildPushText(formattedText), agent.workspace_id);
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
