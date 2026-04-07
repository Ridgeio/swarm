import { execFileSync } from 'child_process';
import { Transport, TransportAgent, TransportDeliveryResult } from './transport-interface.js';
import { sendToSurface, SurfaceGoneError, isSurfaceAlive } from './transport.js';

/**
 * Deliver a message to a Cmux tab via AppleScript clipboard paste.
 * Used as fallback when the Cmux socket is inaccessible (e.g., sender is outside Cmux).
 *
 * Uses the workspace_id (e.g., "workspace:2") to switch to the correct tab
 * via Cmd+<number> before pasting. Requires: cmux app running, System Events access.
 */
function deliverViaAppleScript(agent: TransportAgent, text: string): void {
  // Escape for AppleScript string (backslashes and quotes)
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  // Parse workspace index from workspace_id (e.g., "workspace:2" → 2)
  let switchTabScript = '';
  if (agent.workspace_id) {
    const match = agent.workspace_id.match(/workspace:(\d+)/);
    if (match) {
      const wsIndex = parseInt(match[1], 10);
      // Cmux uses Cmd+1 through Cmd+9 for workspace switching
      if (wsIndex >= 1 && wsIndex <= 9) {
        switchTabScript = `
        keystroke "${wsIndex}" using command down
        delay 0.3`;
      }
    }
  }

  const script = `
    set oldClip to the clipboard
    set the clipboard to "${escaped}"
    tell application "cmux" to activate
    delay 0.3
    tell application "System Events"
      tell process "cmux"${switchTabScript}
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
