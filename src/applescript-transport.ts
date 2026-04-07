import { execFileSync } from 'child_process';
import { Transport, TransportAgent, TransportDeliveryResult } from './transport-interface.js';
import os from 'os';
import path from 'path';
import fs from 'fs';

/**
 * AppleScript-based transport for injecting messages into GUI terminal apps
 * (Terminal.app, iTerm2). Uses osascript to send text as simulated input.
 *
 * On join, the agent's terminal app and window/tab identifiers are stored
 * in ~/.swarm/surfaces/<agent-name>.json
 */

interface AppleScriptSurface {
  app: 'Terminal' | 'iTerm2';
  windowId?: number;
  tabIndex?: number;
  ttyDevice?: string;
}

const SURFACES_DIR = path.join(os.homedir(), '.swarm', 'surfaces');

function ensureSurfacesDir(): void {
  if (!fs.existsSync(SURFACES_DIR)) {
    fs.mkdirSync(SURFACES_DIR, { recursive: true });
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
    const result = execFileSync('tty', { encoding: 'utf-8', stdio: ['inherit', 'pipe', 'pipe'] }).trim();
    if (result && !result.includes('not a tty')) return result;
  } catch { /* fall through */ }

  // Walk up the process tree to find a TTY
  try {
    let pid = process.ppid?.toString() || '';
    for (let i = 0; i < 5 && pid; i++) {
      const tty = execFileSync('ps', ['-o', 'tty=', '-p', pid], { encoding: 'utf-8' }).trim();
      if (tty && tty !== '??' && tty !== '') {
        return `/dev/${tty}`;
      }
      pid = execFileSync('ps', ['-o', 'ppid=', '-p', pid], { encoding: 'utf-8' }).trim();
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
    const result = execFileSync('osascript', ['-e', script], { encoding: 'utf-8' }).trim();
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
export function registerSurface(agentName: string): AppleScriptSurface | null {
  const app = detectTerminalApp();
  if (!app || app === 'Warp') return null;

  const tty = getCurrentTty();
  const surface: AppleScriptSurface = { app, ttyDevice: tty ?? undefined };

  if (app === 'Terminal' && tty) {
    const win = findTerminalWindowForTty(tty);
    if (win) {
      surface.windowId = win.windowId;
      surface.tabIndex = win.tabIndex;
    }
  }

  ensureSurfacesDir();
  fs.writeFileSync(
    path.join(SURFACES_DIR, `${agentName}.json`),
    JSON.stringify(surface, null, 2)
  );
  return surface;
}

/**
 * Remove the registered surface for an agent.
 */
export function removeSurface(agentName: string): void {
  const surfacePath = path.join(SURFACES_DIR, `${agentName}.json`);
  if (fs.existsSync(surfacePath)) fs.unlinkSync(surfacePath);
}

/**
 * Load the registered surface for an agent.
 */
function loadSurface(agentName: string): AppleScriptSurface | null {
  const surfacePath = path.join(SURFACES_DIR, `${agentName}.json`);
  if (!fs.existsSync(surfacePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(surfacePath, 'utf-8'));
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

  execFileSync('osascript', ['-e', script], { encoding: 'utf-8' });
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

  const result = execFileSync('osascript', ['-e', script], { encoding: 'utf-8' }).trim();
  if (result === 'notfound') {
    throw new Error(`Cannot find iTerm2 session for tty ${surface.ttyDevice}`);
  }
}

export class AppleScriptTransport implements Transport {
  async deliverMessage(agent: TransportAgent, formattedText: string): Promise<TransportDeliveryResult> {
    const surface = loadSurface(agent.name);
    if (!surface) {
      return { delivered: false, error: `No terminal surface registered for ${agent.name}` };
    }

    try {
      switch (surface.app) {
        case 'Terminal':
          sendToTerminalApp(surface, formattedText);
          break;
        case 'iTerm2':
          sendToITerm2(surface, formattedText);
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
