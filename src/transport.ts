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

export function sendToSurface(surfaceId: string, text: string): void {
  const cmux = resolveCmux();
  const safe = sanitize(text);
  try {
    execFileSync(cmux, ['send', '--surface', surfaceId, safe]);
    execFileSync(cmux, ['send-key', '--surface', surfaceId, 'Enter']);
  } catch (err: any) {
    if (err.status !== 0) {
      throw new SurfaceGoneError(surfaceId);
    }
    throw err;
  }
}

export function readScreen(surfaceId: string, lines?: number): string {
  const cmux = resolveCmux();
  const args = ['read-screen', '--surface', surfaceId];
  if (lines) args.push('--lines', String(lines));
  try {
    return execFileSync(cmux, args).toString();
  } catch (err: any) {
    if (err.status !== 0) {
      throw new SurfaceGoneError(surfaceId);
    }
    throw err;
  }
}

export function identify(): { surfaceId: string | undefined; workspaceId: string | undefined } {
  return {
    surfaceId: process.env.CMUX_SURFACE_ID,
    workspaceId: process.env.CMUX_WORKSPACE_ID,
  };
}
