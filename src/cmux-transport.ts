import { Transport, TransportAgent, TransportDeliveryResult, DeliveryOptions } from './transport-interface.js';
import { sendToSurface, notifySurface, SurfaceGoneError, isSurfaceAlive } from './transport.js';

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

/**
 * How many Enter keypresses after typing. Grok queues mid-turn input on a single
 * Enter (Ctrl+; queue path); a second Enter is send-now/interject. Default is 1
 * so normal swarm traffic does not interrupt a running Grok turn.
 */
export function enterCountForDelivery(
  hostAgent: string | null | undefined,
  options?: DeliveryOptions
): number {
  if (options?.interject && hostAgent === 'grok') return 2;
  return 1;
}

/** Codex TUIs are fragile under keystroke injection (reasoning-level pickers, mid-turn queues). */
export function prefersNotifyDelivery(hostAgent: string | null | undefined, options?: DeliveryOptions): boolean {
  // Explicit interject still uses keystrokes so a human/lead can force-submit.
  if (options?.interject) return false;
  return hostAgent === 'codex';
}

export class CmuxTransport implements Transport {
  async deliverMessage(
    agent: TransportAgent,
    formattedText: string,
    options?: DeliveryOptions
  ): Promise<TransportDeliveryResult> {
    // Cmux socket only. There used to be an AppleScript clipboard-paste fallback
    // here, but it pasted into whatever tab was FOCUSED and misrouted messages
    // (the "[SWARM from Bob]" incident); it was removed. A socket failure now
    // returns delivered=false: the message stays queued in the DB (inbox/hook
    // pickup) and the redeliver worker retries the socket path.
    const pushText = buildPushText(formattedText);
    try {
      if (prefersNotifyDelivery(agent.host_agent, options)) {
        const match = formattedText.match(/^\[SWARM from ([^\]]+)\]/);
        const sender = match ? match[1] : 'swarm';
        notifySurface(
          agent.surface_id,
          `SWARM from ${sender}`,
          `${pushText} — run: swarm inbox`,
          agent.workspace_id
        );
        return { delivered: true };
      }

      const enterCount = enterCountForDelivery(agent.host_agent, options);
      sendToSurface(agent.surface_id, pushText, agent.workspace_id, { enterCount });
      return { delivered: true };
    } catch (err) {
      if (!(err instanceof SurfaceGoneError)) throw err;
      // Codex notify-only path: if notify fails, try one keystroke nudge as last resort
      // only when interject was requested; otherwise leave it for inbox/redeliver.
      if (prefersNotifyDelivery(agent.host_agent, options)) {
        return { delivered: false, error: `${agent.name}'s terminal is not reachable via cmux notify` };
      }
      return { delivered: false, error: `${agent.name}'s terminal is not reachable via the cmux socket` };
    }
  }

  async isAlive(agent: TransportAgent): Promise<boolean> {
    return isSurfaceAlive(agent.surface_id, agent.workspace_id);
  }
}
