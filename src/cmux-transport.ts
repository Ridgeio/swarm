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

/**
 * A cmux notification alone does NOT wake an idle Codex agent — nothing starts
 * a turn, so the message sits queued until a human prompts the TUI (field-
 * observed 2026-07-14: assignments went undelivered until Tom manually nudged).
 * Keystroke injection is only dangerous MID-turn (pickers, queued input); when
 * the composer is idle, typing a one-line nudge + Enter is safe and starts a
 * turn whose awareness hook reads the inbox. Absence of "esc to interrupt" is
 * not sufficient proof of idleness: Codex can briefly omit that status between
 * tool/status frames. Require the completed-turn boundary immediately above
 * the composer plus the Codex model footer so ambiguous frames fail closed.
 */
export function isCodexScreenIdle(screen: string): boolean {
  if (/esc to interrupt|^\s*•\s+Working\b/im.test(screen)) return false;

  const lines = screen.replace(/\r/g, '').split('\n');
  let promptIndex = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^\s*›(?:\s|$)/u.test(lines[i])) {
      promptIndex = i;
      break;
    }
  }
  if (promptIndex < 0) return false;

  const hasModelFooter = lines.slice(promptIndex + 1).some(line => /\bgpt-[\w.-]+\b/i.test(line));
  if (!hasModelFooter) return false;

  let previous = promptIndex - 1;
  while (previous >= 0 && lines[previous].trim() === '') previous -= 1;
  if (previous < 0) return false;

  return /^\s*─(?:─+| Worked for\b.*─+)\s*$/u.test(lines[previous]);
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
        // The notification alone can't wake an idle Codex agent (no turn starts).
        // If the surface looks idle, follow with a one-line keystroke nudge to
        // start a turn; if it's mid-turn (or the read fails), the notify + the
        // agent's own task-boundary inbox checks cover it.
        try {
          sendToSurface(agent.surface_id, pushText, agent.workspace_id, {
            enterCount: 1,
            screenGuard: isCodexScreenIdle,
            screenGuardLines: 30,
          });
        } catch {
          // Best-effort wake only — notify already succeeded, message is queued.
        }
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
