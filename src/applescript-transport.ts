import childProcess from 'child_process';
import { Transport, TransportAgent, TransportDeliveryResult } from './transport-interface.js';
import { sanitize } from './transport.js';
import { DEFAULT_SWARM_ID } from './db.js';
import os from 'os';
import path from 'path';
import fs from 'fs';

/**
 * AppleScript-based transport for injecting messages into GUI terminal apps
 * (Terminal.app, iTerm2). Uses osascript to send text as simulated input.
 *
 * On join, the agent's terminal app and window/tab identifiers are stored
 * in ~/.swarm/surfaces/<swarm-id>/<agent-name>.json
 */

interface AppleScriptSurface {
  app: 'Terminal' | 'iTerm2' | 'Warp';
  windowId?: number;
  tabIndex?: number;
  ttyDevice?: string;
  pushEnabled?: boolean;
}

const WARP_PUSH_DISABLED_ERROR = 'Warp push delivery not yet implemented (Phase 3 — requires accessibility grant)';
const WARP_ACCESSIBILITY_ERROR = 'Accessibility access required for Warp push delivery. Open System Settings > Privacy & Security > Accessibility and enable the parent terminal binary, or use --no-push to disable. Falling back to inbox queue.';

function surfacesDir(): string {
  return process.env.SWARM_SURFACES_DIR || path.join(os.homedir(), '.swarm', 'surfaces');
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function surfacePath(swarmId: string, agentName: string): string {
  return path.join(surfacesDir(), safePathSegment(swarmId), `${safePathSegment(agentName)}.json`);
}

function legacySurfacePath(agentName: string): string {
  return path.join(surfacesDir(), `${agentName}.json`);
}

function ensureSurfacesDir(swarmId: string): void {
  const dir = path.join(surfacesDir(), safePathSegment(swarmId));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Detect which terminal app the current process is running in.
 */
export function detectTerminalApp(): 'Terminal' | 'iTerm2' | 'Warp' | null {
  const termProgram = process.env.TERM_PROGRAM;
  switch (termProgram) {
    case 'Apple_Terminal': return 'Terminal';
    case 'iTerm.app': return 'iTerm2';
    case 'WarpTerminal': return 'Warp';
    default: return null;
  }
}

/**
 * Get the TTY device of the current process or its parent (e.g., /dev/ttys003).
 * Claude Code's Bash tool runs without a real TTY, so we walk up the process
 * tree to find the parent shell's TTY.
 */
function getCurrentTty(): string | null {
  // Try `tty` command first (works when stdin is a real TTY)
  try {
    const result = childProcess.execFileSync('tty', { encoding: 'utf-8', stdio: ['inherit', 'pipe', 'pipe'] }).trim();
    if (result && !result.includes('not a tty')) return result;
  } catch { /* fall through */ }

  // Walk up the process tree to find a TTY
  try {
    let pid = process.ppid?.toString() || '';
    for (let i = 0; i < 5 && pid; i++) {
      const tty = childProcess.execFileSync('ps', ['-o', 'tty=', '-p', pid], { encoding: 'utf-8' }).trim();
      if (tty && tty !== '??' && tty !== '') {
        return `/dev/${tty}`;
      }
      pid = childProcess.execFileSync('ps', ['-o', 'ppid=', '-p', pid], { encoding: 'utf-8' }).trim();
    }
  } catch { /* fall through */ }

  return null;
}

/**
 * For Terminal.app: find the window ID and tab index that owns a given tty.
 */
function findTerminalWindowForTty(ttyDevice: string): { windowId: number; tabIndex: number } | null {
  // Terminal.app exposes tty per tab via AppleScript
  const script = `
    tell application "Terminal"
      repeat with w in windows
        set tabIdx to 0
        repeat with t in tabs of w
          set tabIdx to tabIdx + 1
          if tty of t is "${ttyDevice}" then
            return (id of w as text) & ":" & (tabIdx as text)
          end if
        end repeat
      end repeat
    end tell
    return "notfound"
  `;
  try {
    const result = childProcess.execFileSync('osascript', ['-e', script], { encoding: 'utf-8' }).trim();
    if (result === 'notfound' || !result.includes(':')) return null;
    const [winId, tabIdx] = result.split(':');
    return { windowId: parseInt(winId, 10), tabIndex: parseInt(tabIdx, 10) };
  } catch {
    return null;
  }
}

/**
 * Register the current terminal surface for an agent.
 * Called during `swarm join` for headless agents in supported terminals.
 */
export function registerSurface(swarmId: string, agentName: string, pushEnabled?: boolean): AppleScriptSurface | null {
  const app = detectTerminalApp();
  if (!app) return null;

  const tty = getCurrentTty();
  const surface: AppleScriptSurface = { app, ttyDevice: tty ?? undefined };
  if (app === 'Warp' && pushEnabled) {
    surface.pushEnabled = true;
  }

  if (app === 'Terminal' && tty) {
    const win = findTerminalWindowForTty(tty);
    if (win) {
      surface.windowId = win.windowId;
      surface.tabIndex = win.tabIndex;
    }
  }

  ensureSurfacesDir(swarmId);
  fs.writeFileSync(
    surfacePath(swarmId, agentName),
    JSON.stringify(surface, null, 2)
  );
  return surface;
}

/**
 * Remove the registered surface for an agent.
 */
export function removeSurface(swarmId: string, agentName: string): void {
  const scoped = surfacePath(swarmId, agentName);
  if (fs.existsSync(scoped)) fs.unlinkSync(scoped);

  // The unscoped legacy file belongs to the pre-multi-swarm (default) layout only —
  // never delete it on behalf of a non-default swarm that merely shares an agent name.
  if (swarmId === DEFAULT_SWARM_ID) {
    const legacy = legacySurfacePath(agentName);
    if (fs.existsSync(legacy)) fs.unlinkSync(legacy);
  }
}

export function hasSurface(swarmId: string, agentName: string): boolean {
  if (fs.existsSync(surfacePath(swarmId, agentName))) return true;
  return swarmId === DEFAULT_SWARM_ID && fs.existsSync(legacySurfacePath(agentName));
}

/**
 * Load the registered surface for an agent.
 */
export function loadSurface(swarmId: string, agentName: string): AppleScriptSurface | null {
  const scoped = surfacePath(swarmId, agentName);
  // Only fall back to the unscoped legacy file for the default swarm, so a same-named
  // agent in another swarm can't be delivered into the default swarm's terminal.
  const selectedPath = fs.existsSync(scoped)
    ? scoped
    : (swarmId === DEFAULT_SWARM_ID ? legacySurfacePath(agentName) : null);
  if (!selectedPath || !fs.existsSync(selectedPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(selectedPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Send text to a Terminal.app window/tab.
 */
function sendToTerminalApp(surface: AppleScriptSurface, text: string): void {
  // Escape backslashes and double quotes for AppleScript string
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  let script: string;
  if (surface.windowId && surface.tabIndex) {
    // Target specific window and tab by ID
    script = `
      tell application "Terminal"
        do script "${escaped}" in tab ${surface.tabIndex} of window id ${surface.windowId}
      end tell
    `;
  } else if (surface.ttyDevice) {
    // Fall back to finding by tty
    const win = findTerminalWindowForTty(surface.ttyDevice);
    if (win) {
      script = `
        tell application "Terminal"
          do script "${escaped}" in tab ${win.tabIndex} of window id ${win.windowId}
        end tell
      `;
    } else {
      throw new Error(`Cannot find Terminal.app window for tty ${surface.ttyDevice}`);
    }
  } else {
    throw new Error('No window/tab identifier available for Terminal.app');
  }

  childProcess.execFileSync('osascript', ['-e', script], { encoding: 'utf-8' });
}

/**
 * Send text to an iTerm2 session.
 */
function sendToITerm2(surface: AppleScriptSurface, text: string): void {
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  // Try to find session by tty
  const script = surface.ttyDevice
    ? `
      tell application "iTerm2"
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if tty of s is "${surface.ttyDevice}" then
                tell s to write text "${escaped}"
                return "ok"
              end if
            end repeat
          end repeat
        end repeat
      end tell
      return "notfound"
    `
    : `
      tell application "iTerm2"
        tell current window
          tell current session
            write text "${escaped}"
          end tell
        end tell
      end tell
    `;

  const result = childProcess.execFileSync('osascript', ['-e', script], { encoding: 'utf-8' }).trim();
  if (result === 'notfound') {
    throw new Error(`Cannot find iTerm2 session for tty ${surface.ttyDevice}`);
  }
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function focusWarpTab(swarmId: string, agentName: string): void {
  const marker = escapeAppleScriptString(`swarm/${swarmId}/${agentName}`);
  const fallbackMarker = escapeAppleScriptString(agentName);
  const script = `
    tell application "System Events"
      tell process "Warp"
        repeat with w in (every window)
          if title of w contains "${marker}" or title of w contains "${fallbackMarker}" then
            perform action "AXRaise" of w
            return "ok"
          end if
        end repeat
      end tell
    end tell
    return "notfound"
  `;

  const result = childProcess.execFileSync('osascript', ['-e', script], { encoding: 'utf-8' }).trim();
  if (result === 'notfound') {
    console.warn(`Warning: Could not find Warp tab titled swarm/${swarmId}/${agentName}; delivering to the current frontmost Warp tab.`);
  }
}

function sendToWarp(_surface: AppleScriptSurface, text: string, swarmId: string, agentName: string): void {
  const escaped = escapeAppleScriptString(text);
  const args = [
    '-e', 'tell application "Warp" to activate',
    '-e', `set the clipboard to "${escaped}"`,
    '-e', 'tell application "System Events" to keystroke "v" using command down',
    '-e', 'delay 0.1',
    '-e', 'tell application "System Events" to keystroke return',
  ];

  try {
    focusWarpTab(swarmId, agentName);
    childProcess.execFileSync('osascript', args, { encoding: 'utf-8' });
  } catch {
    throw new Error(WARP_ACCESSIBILITY_ERROR);
  }
}

export class AppleScriptTransport implements Transport {
  async deliverMessage(agent: TransportAgent, formattedText: string): Promise<TransportDeliveryResult> {
    const surface = loadSurface(agent.swarm_id, agent.name);
    if (!surface) {
      return { delivered: false, error: `No terminal surface registered for ${agent.name}` };
    }

    // Collapse newlines/tabs before they reach the osascript string literal — an embedded
    // newline would break the `do script`/`write text` line or submit prematurely (the
    // same protection the cmux socket path already applies via sanitize()).
    const safeText = sanitize(formattedText);

    try {
      switch (surface.app) {
        case 'Terminal':
          sendToTerminalApp(surface, safeText);
          break;
        case 'iTerm2':
          sendToITerm2(surface, safeText);
          break;
        case 'Warp':
          if (!surface.pushEnabled) {
            return { delivered: false, error: WARP_PUSH_DISABLED_ERROR };
          }
          sendToWarp(surface, formattedText, agent.swarm_id, agent.name);
          break;
        default:
          return { delivered: false, error: `Unsupported terminal app: ${surface.app}` };
      }
      return { delivered: true };
    } catch (err: any) {
      return { delivered: false, error: err.message };
    }
  }

  async isAlive(_agent: TransportAgent): Promise<boolean> {
    // Headless agents with AppleScript surfaces are alive as long as
    // their heartbeat is fresh (handled by registry cleanup skip)
    return true;
  }
}
