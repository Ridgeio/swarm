import { execFileSync } from 'child_process';
import { Transport, TransportAgent, TransportDeliveryResult } from './transport-interface.js';
import { sendToSurface, SurfaceGoneError, isSurfaceAlive } from './transport.js';

/**
 * Deliver a message to a Cmux tab via AppleScript clipboard paste.
 * Used as fallback when the Cmux socket is inaccessible (e.g., sender is outside Cmux).
 * Requires: cmux app is running, System Events accessibility permission.
 */
function deliverViaAppleScript(agent: TransportAgent, text: string): void {
  // Escape for AppleScript string (backslashes and quotes)
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  // Use clipboard paste: reliable for special characters, fast
  const script = `
    set oldClip to the clipboard
    set the clipboard to "${escaped}"
    tell application "cmux" to activate
    delay 0.3
    tell application "System Events"
      tell process "cmux"
        keystroke "v" using command down
        delay 0.1
        keystroke return
      end tell
    end tell
    delay 0.1
    set the clipboard to oldClip
  `;

  execFileSync('osascript', ['-e', script], { encoding: 'utf-8', timeout: 10000 });
}

export class CmuxTransport implements Transport {
  async deliverMessage(agent: TransportAgent, formattedText: string): Promise<TransportDeliveryResult> {
    // Try Cmux socket first (works when sender is inside Cmux)
    try {
      sendToSurface(agent.surface_id, formattedText, agent.workspace_id);
      return { delivered: true };
    } catch (err) {
      if (!(err instanceof SurfaceGoneError)) throw err;
    }

    // Fallback: AppleScript clipboard paste into cmux app
    try {
      deliverViaAppleScript(agent, formattedText);
      return { delivered: true };
    } catch {
      return { delivered: false, error: `${agent.name}'s terminal is no longer active` };
    }
  }

  async isAlive(agent: TransportAgent): Promise<boolean> {
    return isSurfaceAlive(agent.surface_id, agent.workspace_id);
  }
}
