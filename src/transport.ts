import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

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

export function sanitize(text: string): string {
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

const CHUNK_SIZE = 60;
const STDIO_OPTS: { stdio: ['pipe', 'pipe', 'pipe'] } = { stdio: ['pipe', 'pipe', 'pipe'] };
const MAX_SEND_ATTEMPTS = 5;
const SEND_BACKOFF_BASE_S = 0.3;

// A cmux send/read can fail two ways: the surface is genuinely gone, or the cmux
// server dropped the connection under load ("Broken pipe", errno 32 / EPIPE /
// connection reset). The latter is transient — the surface is alive, just busy —
// and should be retried rather than treated as a dead surface (which would let
// cleanupStale prune a live-but-busy agent).
export function isTransientCmuxError(err: any): boolean {
  const haystack = `${err?.stderr?.toString() ?? ''} ${err?.message ?? ''} ${err?.code ?? ''}`.toLowerCase();
  return (
    haystack.includes('broken pipe') ||
    haystack.includes('errno 32') ||
    haystack.includes('epipe') ||
    haystack.includes('connection reset') ||
    haystack.includes('econnreset') ||
    haystack.includes('resource temporarily unavailable') ||
    haystack.includes('eagain') ||
    haystack.includes('socket')
  );
}

export function sleep(seconds: number): void {
  execFileSync('sleep', [String(seconds)], STDIO_OPTS);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// File-based lock to prevent concurrent sends to the same surface from interleaving chunks.
// Uses mkdir atomicity: mkdir fails if the dir already exists, providing a cross-process mutex.
const LOCK_DIR = path.join(os.homedir(), '.swarm', 'locks');
const LOCK_TIMEOUT_MS = 15_000;
const LOCK_POLL_MS = 50;
const LOCK_STALE_MS = 30_000; // Force-break locks older than this (dead process)

function lockPathForSurface(surfaceId: string): string {
  return path.join(LOCK_DIR, `surface-${surfaceId.replace(/[^a-zA-Z0-9-]/g, '_')}.lock`);
}

function acquireSurfaceLock(surfaceId: string): string {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  const lockPath = lockPathForSurface(surfaceId);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      // mkdir is atomic — fails if already exists
      fs.mkdirSync(lockPath);
      // Write our PID so stale locks can be detected
      fs.writeFileSync(path.join(lockPath, 'pid'), String(process.pid));
      return lockPath;
    } catch {
      // Lock exists — check if stale
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          // Stale lock from a dead process — force remove and retry
          fs.rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Lock disappeared between our mkdir and stat — retry immediately
        continue;
      }
      // Wait and retry
      execFileSync('sleep', [String(LOCK_POLL_MS / 1000)], STDIO_OPTS);
    }
  }
  // Timed out — proceed without lock rather than blocking forever
  return '';
}

function releaseSurfaceLock(lockPath: string): void {
  if (!lockPath) return;
  try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch {}
}

export function sendToSurface(surfaceId: string, text: string, workspaceId?: string | null): void {
  const cmux = resolveCmux();
  const safe = sanitize(text);
  const wsArgs = workspaceId ? ['--workspace', workspaceId] : [];
  const lockPath = acquireSurfaceLock(surfaceId);
  try {
    // Retry once on failure to handle transient cmux errors
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // Chunk long messages to avoid Claude Code paste-bracket detection
        if (safe.length <= CHUNK_SIZE) {
          execFileSync(cmux, ['send', ...wsArgs, '--surface', surfaceId, safe], STDIO_OPTS);
        } else {
          for (let i = 0; i < safe.length; i += CHUNK_SIZE) {
            const chunk = safe.slice(i, i + CHUNK_SIZE);
            execFileSync(cmux, ['send', ...wsArgs, '--surface', surfaceId, chunk], STDIO_OPTS);
            sleep(0.015);
          }
        }
        // Let input settle before submitting
        sleep(0.1);
        execFileSync(cmux, ['send-key', ...wsArgs, '--surface', surfaceId, 'Enter'], STDIO_OPTS);
        return; // success
      } catch (err: any) {
        // A "broken pipe"/socket-reset means the cmux server dropped the connection
        // under load — the surface is alive but momentarily busy (recipient mid-turn).
        // These are transient and worth several backoff retries; a genuine "surface
        // not found" is terminal and should fail fast. (Field-measured: ~10% of sends
        // to active agents hit broken pipe, roughly independent of message length.)
        const transient = isTransientCmuxError(err);
        const lastAttempt = attempt === MAX_SEND_ATTEMPTS - 1;
        if (!lastAttempt && (transient || attempt === 0)) {
          // Escalating backoff: 0.3, 0.6, 1.2, 2.4s. Rides out brief contention
          // spikes without hammering a sustained-busy surface (the hook covers that).
          sleep(SEND_BACKOFF_BASE_S * Math.pow(2, attempt));
          continue;
        }
        throw new SurfaceGoneError(surfaceId);
      }
    }
  } finally {
    releaseSurfaceLock(lockPath);
  }
}

export function spawnWorkspace(cwd: string, command: string): { workspaceRef: string; surfaceRef: string } | null {
  const cmux = resolveCmux();
  // new-workspace returns "OK workspace:N"
  const wsOut = execFileSync(cmux, ['new-workspace', '--cwd', cwd, '--command', command], STDIO_OPTS).toString().trim();
  const wsMatch = wsOut.match(/workspace:\d+/);
  if (!wsMatch) return null;
  const workspaceRef = wsMatch[0];

  // Get the surface in the new workspace
  const surfOut = execFileSync(cmux, ['list-pane-surfaces', '--workspace', workspaceRef], STDIO_OPTS).toString().trim();
  const surfMatch = surfOut.match(/surface:\d+/);
  if (!surfMatch) return null;

  return { workspaceRef, surfaceRef: surfMatch[0] };
}

export function spawnSurfaceInWorkspace(
  cwd: string,
  command: string,
  workspaceId?: string | null
): { workspaceRef: string | null; surfaceRef: string } | null {
  const cmux = resolveCmux();
  const wsArgs = workspaceId ? ['--workspace', workspaceId] : [];
  const out = execFileSync(cmux, ['new-surface', ...wsArgs], STDIO_OPTS).toString().trim();
  const surfaceMatch = out.match(/surface[:=]\d+/);
  if (!surfaceMatch) return null;

  const workspaceMatch = out.match(/workspace[:=]\d+/);
  const surfaceRef = surfaceMatch[0].replace('=', ':');
  const workspaceRef = workspaceMatch ? workspaceMatch[0].replace('=', ':') : workspaceId ?? null;
  const startCommand = `cd ${shellQuote(cwd)} && ${command}`;
  sendToSurface(surfaceRef, startCommand, workspaceRef);
  return { workspaceRef, surfaceRef };
}

export function readScreen(surfaceId: string, lines?: number, workspaceId?: string | null): string {
  const cmux = resolveCmux();
  const wsArgs = workspaceId ? ['--workspace', workspaceId] : [];
  const args = ['read-screen', ...wsArgs, '--surface', surfaceId];
  if (lines) args.push('--lines', String(lines));
  try {
    return execFileSync(cmux, args, STDIO_OPTS).toString();
  } catch (err: any) {
    const gone = new SurfaceGoneError(surfaceId);
    // Preserve the underlying cause so callers (isSurfaceAlive) can tell a genuinely
    // gone surface from a transient "busy" broken pipe.
    (gone as any).cause = err;
    throw gone;
  }
}

export function isSurfaceAlive(surfaceId: string, workspaceId?: string | null): boolean {
  // Retry a few times with backoff. Critically: a TRANSIENT socket error (broken
  // pipe from a busy surface) must NOT be read as "dead" — the surface is alive, just
  // busy. Only a genuine non-transient failure (surface not found) counts as dead,
  // so cleanupStale can never prune a live-but-busy agent.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      readScreen(surfaceId, 1, workspaceId);
      return true;
    } catch (err: any) {
      if (isTransientCmuxError(err?.cause)) return true; // busy, not gone
      if (attempt < 2) {
        execFileSync('sleep', [String(0.3 * (attempt + 1))], STDIO_OPTS);
      }
    }
  }
  return false;
}

export function renameTab(surfaceId: string, name: string, workspaceId?: string | null): void {
  const cmux = resolveCmux();
  const wsArgs = workspaceId ? ['--workspace', workspaceId] : [];
  try {
    execFileSync(cmux, ['rename-tab', ...wsArgs, '--surface', surfaceId, '--', name], STDIO_OPTS);
  } catch {}
}

export function moveSurface(surfaceId: string, targetWorkspaceId: string): void {
  const cmux = resolveCmux();
  execFileSync(cmux, ['move-surface', '--surface', surfaceId, '--workspace', targetWorkspaceId], STDIO_OPTS);
}

export function listWorkspaces(): string {
  const cmux = resolveCmux();
  return execFileSync(cmux, ['list-workspaces'], STDIO_OPTS).toString();
}

export function renameWorkspace(workspaceId: string, title: string): void {
  const cmux = resolveCmux();
  try {
    execFileSync(cmux, ['rename-workspace', '--workspace', workspaceId, '--', title], STDIO_OPTS);
  } catch (err: any) {
    // execFileSync only throws on a non-zero exit, so this is a genuine cmux failure
    // (e.g. "not_found: Workspace not found" when a Surface id is passed instead of a
    // Workspace id). The useful detail is on stderr; cmux also prints a deprecation
    // notice there even on success, so strip that line and surface the real error.
    const stderr: string = (err.stderr?.toString() ?? '').trim();
    const real = stderr
      .split('\n')
      .filter((line: string) => !/deprecat|alias for/i.test(line))
      .join(' ')
      .trim();
    throw new Error(real || err.message || `cmux rename-workspace failed for "${workspaceId}"`);
  }
}

export function identify(): { surfaceId: string | undefined; workspaceId: string | undefined } {
  return {
    surfaceId: process.env.CMUX_SURFACE_ID,
    workspaceId: process.env.CMUX_WORKSPACE_ID,
  };
}
