import { execFileSync } from 'child_process';
import fs from 'fs';

export class SurfaceGoneError extends Error {
  constructor(public surfaceId: string) {
    super(`Surface ${surfaceId} is no longer active`);
    this.name = 'SurfaceGoneError';
  }
}

let cachedCmuxPath: string | null = null;

function resolveCmux(): string {
  if (cachedCmuxPath) return cachedCmuxPath;

  // 1. Check PATH
  try {
    cachedCmuxPath = execFileSync('which', ['cmux']).toString().trim();
    return cachedCmuxPath;
  } catch {}

  // 2. Known macOS app bundle path
  const bundled = '/Applications/cmux.app/Contents/Resources/bin/cmux';
  try {
    fs.accessSync(bundled, fs.constants.X_OK);
    cachedCmuxPath = bundled;
    return cachedCmuxPath;
  } catch {}

  throw new Error(
    'cmux not found. Install Cmux or ensure it is in your PATH.'
  );
}

function sanitize(text: string): string {
  // Strip escape sequences that cmux interprets (\n -> Enter, \t -> Tab)
  // Also strip actual newlines/tabs to prevent multi-line injection
  return text
    .replace(/\\n/g, ' ')
    .replace(/\\r/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/\r/g, ' ')
    .replace(/\t/g, ' ');
}

export function sendToSurface(surfaceId: string, text: string, workspaceId?: string | null): void {
  const cmux = resolveCmux();
  const safe = sanitize(text);
  const wsArgs = workspaceId ? ['--workspace', workspaceId] : [];
  try {
    execFileSync(cmux, ['send', ...wsArgs, '--surface', surfaceId, safe], { stdio: ['pipe', 'pipe', 'pipe'] });
    execFileSync(cmux, ['send-key', ...wsArgs, '--surface', surfaceId, 'Enter'], { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err: any) {
    throw new SurfaceGoneError(surfaceId);
  }
}

export function readScreen(surfaceId: string, lines?: number, workspaceId?: string | null): string {
  const cmux = resolveCmux();
  const wsArgs = workspaceId ? ['--workspace', workspaceId] : [];
  const args = ['read-screen', ...wsArgs, '--surface', surfaceId];
  if (lines) args.push('--lines', String(lines));
  try {
    return execFileSync(cmux, args, { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
  } catch (err: any) {
    throw new SurfaceGoneError(surfaceId);
  }
}

export function isSurfaceAlive(surfaceId: string, workspaceId?: string | null): boolean {
  try {
    readScreen(surfaceId, 1, workspaceId);
    return true;
  } catch {
    return false;
  }
}

export function identify(): { surfaceId: string | undefined; workspaceId: string | undefined } {
  return {
    surfaceId: process.env.CMUX_SURFACE_ID,
    workspaceId: process.env.CMUX_WORKSPACE_ID,
  };
}
