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

export function resolveCmux(): string {
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

export type CmuxLivenessRunner = (
  binary: string,
  args: string[],
  options: typeof STDIO_OPTS
) => string | Buffer;

export interface CmuxLivenessObserver {
  /**
   * Whether this process can reach the Cmux control socket. The result is
   * memoized by the observer, so one CLI invocation performs at most one ping.
   */
  isCompetent(): boolean;
  /** null means the observer is blind, not that the subject is dead. */
  isSurfaceAlive(surfaceId: string, workspaceId?: string | null): boolean | null;
}

export interface CmuxLivenessObserverOptions {
  runner?: CmuxLivenessRunner;
  resolveBinary?: () => string;
  wait?: (seconds: number) => void;
}

export const CMUX_LIVENESS_UNKNOWN_MESSAGE = 'cmux unreachable from this process — liveness unknown';

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

export interface SendToSurfaceOptions {
  /**
   * How many times to press Enter after typing. Grok's TUI queues interjected
   * input on a single Enter and only submits on the second; Claude/Codex submit
   * on the first. Default 1.
   */
  enterCount?: number;
  /**
   * Optional fail-closed screen predicate evaluated while the per-surface lock
   * is held. The predicate must pass twice, separated by confirmDelaySeconds,
   * before any keystrokes are sent. This makes a readiness check atomic with
   * the send and filters transient TUI frames.
   */
  screenGuard?: (screen: string) => boolean;
  screenGuardLines?: number;
  confirmDelaySeconds?: number;
}

/**
 * Non-invasive surface wake-up via Cmux notifications (no keystrokes into the TUI).
 * Preferred for Codex: typing into the prompt can open reasoning-level pickers or
 * queue mid-turn and leave the agent stuck. Callers still store the full message
 * in the DB for `swarm inbox`.
 */
export function notifySurface(
  surfaceId: string,
  title: string,
  body: string,
  workspaceId?: string | null
): void {
  const cmux = resolveCmux();
  const safeTitle = sanitize(title).slice(0, 80) || 'SWARM';
  const safeBody = sanitize(body).slice(0, 200) || 'New message — run: swarm inbox';
  const args = ['notify', '--title', safeTitle, '--body', safeBody, '--surface', surfaceId];
  if (workspaceId) args.push('--workspace', workspaceId);
  try {
    execFileSync(cmux, args, STDIO_OPTS);
  } catch (err: any) {
    if (isTransientCmuxError(err)) {
      // One quick retry for flaky sockets.
      sleep(0.2);
      try {
        execFileSync(cmux, args, STDIO_OPTS);
      } catch {
        // Still failing (busy surface under load). Surface as "gone" so the
        // caller reports delivered=false and the message stays queued for the
        // redeliver worker — a raw throw here crashed the whole CLI with the
        // message already inserted, making successful queueing look like a
        // failed send (field-observed on notify-path recipients under load).
        throw new SurfaceGoneError(surfaceId);
      }
      return;
    }
    throw new SurfaceGoneError(surfaceId);
  }
}

export function sendToSurface(
  surfaceId: string,
  text: string,
  workspaceId?: string | null,
  options?: SendToSurfaceOptions
): boolean {
  const cmux = resolveCmux();
  const safe = sanitize(text);
  const enterCount = Math.max(1, options?.enterCount ?? 1);
  const wsArgs = workspaceId ? ['--workspace', workspaceId] : [];
  const lockPath = acquireSurfaceLock(surfaceId);
  try {
    if (options?.screenGuard) {
      // Unguarded sends may retain the historical timeout fallback, but a
      // readiness-conditional send must never race another writer.
      if (!lockPath) return false;
      try {
        const lines = options.screenGuardLines ?? 30;
        const first = readScreen(surfaceId, lines, workspaceId);
        if (!options.screenGuard(first)) return false;
        sleep(options.confirmDelaySeconds ?? 0.25);
        const second = readScreen(surfaceId, lines, workspaceId);
        if (!options.screenGuard(second)) return false;
      } catch {
        // A guard is advisory wake-up logic. If the screen cannot be proven
        // safe, leave the durable inbox row for the recipient's next check.
        return false;
      }
    }

    for (let attempt = 0; attempt < MAX_SEND_ATTEMPTS; attempt++) {
      try {
        // Before a RETRY, clear the input line: a prior attempt may have typed
        // part of the text before failing, and re-typing from the start would
        // duplicate or garble it in the recipient's prompt buffer (field-observed
        // "…STREAM…STREAM" duplication). ctrl+u clears the current line.
        if (attempt > 0) {
          try { execFileSync(cmux, ['send-key', ...wsArgs, '--surface', surfaceId, 'ctrl+u'], STDIO_OPTS); } catch {}
        }
        // Chunk long text to avoid Claude Code paste-bracket detection. (Message
        // delivery caps payloads to a single chunk upstream — see cmux-transport's
        // nudge — so multi-chunk sends here are spawn commands to fresh surfaces.)
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
        for (let e = 0; e < enterCount; e++) {
          execFileSync(cmux, ['send-key', ...wsArgs, '--surface', surfaceId, 'Enter'], STDIO_OPTS);
          if (e + 1 < enterCount) sleep(0.05);
        }
        return true; // success
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
    return false;
  } finally {
    releaseSurfaceLock(lockPath);
  }
}

export function spawnWorkspace(
  cwd: string,
  command: string,
  title?: string
): { workspaceRef: string; surfaceRef: string } | null {
  const cmux = resolveCmux();
  // new-workspace returns "OK workspace:N"
  const args = ['new-workspace'];
  if (title) args.push('--name', title);
  args.push('--cwd', cwd, '--command', command);
  const wsOut = execFileSync(cmux, args, STDIO_OPTS).toString().trim();
  const wsMatch = wsOut.match(/workspace:\d+/);
  if (!wsMatch) return null;
  const workspaceRef = wsMatch[0];

  // Get the surface in the new workspace
  const surfOut = execFileSync(cmux, ['list-pane-surfaces', '--workspace', workspaceRef], STDIO_OPTS).toString().trim();
  const surfMatch = surfOut.match(/surface:\d+/);
  if (!surfMatch) return null;

  return { workspaceRef, surfaceRef: surfMatch[0] };
}

export function spawnBrowserWorkspace(
  cwd: string,
  url: string,
  title: string
): { workspaceRef: string; surfaceRef: string } | null {
  const cmux = resolveCmux();
  const wsOut = execFileSync(
    cmux,
    ['new-workspace', '--name', title, '--cwd', cwd],
    STDIO_OPTS
  ).toString().trim();
  const wsMatch = wsOut.match(/workspace[:=]\d+/);
  if (!wsMatch) return null;
  const workspaceRef = wsMatch[0].replace('=', ':');

  const surfaceOut = execFileSync(
    cmux,
    ['new-surface', '--type', 'browser', '--workspace', workspaceRef, '--url', url],
    STDIO_OPTS
  ).toString().trim();
  const surfaceMatch = surfaceOut.match(/surface[:=]\d+/);
  if (!surfaceMatch) return null;
  return { workspaceRef, surfaceRef: surfaceMatch[0].replace('=', ':') };
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

export function createCmuxLivenessObserver(
  options: CmuxLivenessObserverOptions = {}
): CmuxLivenessObserver {
  const runner = options.runner ?? execFileSync;
  const resolveBinary = options.resolveBinary ?? resolveCmux;
  const wait = options.wait ?? sleep;
  let competent: boolean | undefined;
  let cmuxPath: string | undefined;

  const isCompetent = (): boolean => {
    if (competent !== undefined) return competent;
    try {
      cmuxPath = resolveBinary();
      runner(cmuxPath, ['ping'], STDIO_OPTS);
      competent = true;
    } catch {
      competent = false;
    }
    return competent;
  };

  return {
    isCompetent,
    isSurfaceAlive(surfaceId: string, workspaceId?: string | null): boolean | null {
      // Observer blindness is not evidence about any subject. In particular, do
      // not even issue a surface-specific call until the process has proven it
      // can reach the socket with the trivially true ping above.
      if (!isCompetent()) return null;

      const wsArgs = workspaceId ? ['--workspace', workspaceId] : [];
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          runner(cmuxPath!, ['read-screen', ...wsArgs, '--surface', surfaceId, '--lines', '1'], STDIO_OPTS);
          return true;
        } catch (err: any) {
          // A busy socket is positive evidence that Cmux is present, while a
          // non-transient subject-specific failure may mean the surface is gone.
          if (isTransientCmuxError(err)) return true;
          if (attempt < 2) wait(0.3 * (attempt + 1));
        }
      }
      return false;
    },
  };
}

/** One competence probe per short-lived CLI process, shared by every subject. */
export const processCmuxLivenessObserver = createCmuxLivenessObserver();

export function isCmuxObserverCompetent(): boolean {
  return processCmuxLivenessObserver.isCompetent();
}

export function isSurfaceAlive(surfaceId: string, workspaceId?: string | null): boolean | null {
  return processCmuxLivenessObserver.isSurfaceAlive(surfaceId, workspaceId);
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
