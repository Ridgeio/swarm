import type { SwarmDb } from './db.js';
import { execFileSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectBoardData,
  type BoardData,
  type CollectBoardDataOptions,
} from './board-data.js';
import { resolveCmux, spawnBrowserWorkspace } from './transport.js';

export const BOARD_SERVER_HOST = '127.0.0.1';
export const BOARD_SERVER_DEFAULT_PORT = 7787;
export const BOARD_SERVER_TOKEN_PLACEHOLDER = '__SWARM_BOARD_TOKEN__';
export const BOARD_SERVER_MAX_JSON_BYTES = 2 * 1024 * 1024;
export const BOARD_SERVER_MAX_BODY_BYTES = 4 * 1024;
export const BOARD_SERVER_MAX_AGENT_NAME_LENGTH = 128;

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface BoardAssetRoots {
  vendor: string;
  web: string;
}

export type BoardProjection = (
  db: SwarmDb | null,
  swarmId: string,
  options?: CollectBoardDataOptions
) => BoardData;

export type BoardCmuxRunner = (binary: string, args: string[]) => string | Buffer;

export interface StartBoardServerOptions {
  db: SwarmDb | null;
  swarmId: string;
  port?: number;
  projection?: BoardProjection;
  assetRoots?: BoardAssetRoots;
  now?: () => number;
  cmuxRunner?: BoardCmuxRunner;
  resolveCmuxBinary?: () => string;
}

export interface RunningBoardServer {
  server: http.Server;
  port: number;
  token: string;
  close: () => Promise<void>;
}

export interface BoardServerTabOptions {
  cwd?: string;
  spawn?: typeof spawnBrowserWorkspace;
  open?: (url: string) => boolean;
  writeError?: (value: string) => void;
}

interface StaticAsset {
  filePath: string;
  contentType: string;
}

interface FocusAgentRow {
  name: string;
  agent_type: string;
  surface_id: string;
  workspace_id: string | null;
}

interface FocusResult {
  status: number;
  ok: boolean;
  message: string;
}

function defaultAssetRoots(): BoardAssetRoots {
  return {
    vendor: path.join(MODULE_ROOT, 'vendor'),
    web: path.join(MODULE_ROOT, 'web'),
  };
}

const JS = 'text/javascript; charset=utf-8';

function assetAllowlist(roots: BoardAssetRoots): ReadonlyMap<string, StaticAsset> {
  return new Map([
    ['/assets/board.css', { filePath: path.join(roots.web, 'board.css'), contentType: 'text/css; charset=utf-8' }],
    ['/assets/app.js', { filePath: path.join(roots.web, 'app.js'), contentType: JS }],
    ['/assets/store.js', { filePath: path.join(roots.web, 'store.js'), contentType: JS }],
    ['/assets/api.js', { filePath: path.join(roots.web, 'api.js'), contentType: JS }],
    ['/assets/views.js', { filePath: path.join(roots.web, 'views.js'), contentType: JS }],
    ['/assets/vendor/preact-10.29.7.module.js', {
      filePath: path.join(roots.vendor, 'preact-10.29.7.module.js'), contentType: JS,
    }],
    ['/assets/vendor/preact-hooks-10.29.7.module.js', {
      filePath: path.join(roots.vendor, 'preact-hooks-10.29.7.module.js'), contentType: JS,
    }],
    ['/assets/vendor/htm-3.1.1.module.js', {
      filePath: path.join(roots.vendor, 'htm-3.1.1.module.js'), contentType: JS,
    }],
  ]);
}

function commonHeaders(): Record<string, string> {
  return {
    // v2 tightened from default-src 'self': no inline anything, no eval, no
    // remote hosts, no framing. The virtualizer positions rows via DOM style
    // PROPERTIES, which style-src-attr 'none' still allows.
    'Content-Security-Policy': [
      "default-src 'none'",
      "script-src 'self'",
      "script-src-attr 'none'",
      "style-src 'self'",
      "style-src-attr 'none'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
  };
}

function send(
  response: ServerResponse,
  statusCode: number,
  contentType: string,
  body: string | Buffer,
  headers: Record<string, string> = {}
): void {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf-8');
  response.writeHead(statusCode, {
    ...commonHeaders(),
    ...headers,
    'Content-Type': contentType,
    'Content-Length': String(payload.byteLength),
  });
  response.end(payload);
}

function sendText(response: ServerResponse, statusCode: number, body: string): void {
  send(response, statusCode, 'text/plain; charset=utf-8', body);
}

function hostAllowed(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.trim().toLowerCase();
  return new Set([
    BOARD_SERVER_HOST,
    'localhost',
    `${BOARD_SERVER_HOST}:${port}`,
    `localhost:${port}`,
  ]).has(host);
}

function tokenMatches(candidate: string | null | undefined, expected: string): boolean {
  if (!candidate) return false;
  const supplied = Buffer.from(candidate, 'utf-8');
  const wanted = Buffer.from(expected, 'utf-8');
  return supplied.byteLength === wanted.byteLength && timingSafeEqual(supplied, wanted);
}

function requestPath(request: IncomingMessage): string {
  return (request.url ?? '').split('?', 1)[0];
}

function defaultCmuxRunner(binary: string, args: string[]): string {
  return execFileSync(binary, args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5_000,
  });
}

function parseFocusLocation(raw: string | Buffer): { pane: string; workspace: string | null } | null {
  try {
    const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
    const candidates = [parsed.caller, parsed.focused, parsed.active, parsed];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const location = candidate as Record<string, unknown>;
      if (typeof location.pane_ref !== 'string' || location.pane_ref.length === 0) continue;
      return {
        pane: location.pane_ref,
        workspace: typeof location.workspace_ref === 'string' && location.workspace_ref.length > 0
          ? location.workspace_ref
          : null,
      };
    }
  } catch {
    // A stale surface may make older cmux versions return plain text.
  }
  return null;
}

/** Resolve a registered agent and best-effort focus its exact cmux surface. */
export function focusAgentTerminal(
  db: SwarmDb | null,
  swarmId: string,
  agentName: string,
  options: Pick<StartBoardServerOptions, 'cmuxRunner' | 'resolveCmuxBinary'> = {}
): FocusResult {
  let agent: FocusAgentRow | undefined;
  try {
    agent = db?.prepare(`
      SELECT name, agent_type, surface_id, workspace_id
      FROM agents
      WHERE swarm_id = ? AND name = ? COLLATE NOCASE
      LIMIT 1
    `).get(swarmId, agentName) as FocusAgentRow | undefined;
  } catch {
    return {
      status: 503,
      ok: false,
      message: 'Agent registry is unavailable; reopen the board after the swarm database is restored.',
    };
  }

  if (!agent) {
    return {
      status: 404,
      ok: false,
      message: `Unknown agent "${agentName}" in this swarm. Refresh the board and try again.`,
    };
  }
  if (agent.agent_type !== 'cmux') {
    return {
      status: 400,
      ok: false,
      message: `Agent "${agent.name}" is ${agent.agent_type}, so it has no cmux terminal to focus.`,
    };
  }
  if (!agent.surface_id) {
    return {
      status: 400,
      ok: false,
      message: `Agent "${agent.name}" has no registered cmux surface. Rejoin it and try again.`,
    };
  }

  const runner = options.cmuxRunner ?? defaultCmuxRunner;
  try {
    const binary = (options.resolveCmuxBinary ?? resolveCmux)();
    const identified = runner(binary, ['--json', 'identify', '--surface', agent.surface_id]);
    const location = parseFocusLocation(identified);
    if (!location) {
      return {
        status: 502,
        ok: false,
        message: `cmux could not locate the registered surface for "${agent.name}". Rejoin the agent and try again.`,
      };
    }
    const workspace = agent.workspace_id ?? location.workspace;
    if (!workspace) {
      return {
        status: 502,
        ok: false,
        message: `cmux could not resolve a workspace for "${agent.name}". Rejoin the agent and try again.`,
      };
    }
    runner(binary, [
      'focus-panel',
      '--panel', agent.surface_id,
      '--workspace', workspace,
    ]);
    return { status: 200, ok: true, message: `Focused terminal for "${agent.name}".` };
  } catch {
    return {
      status: 502,
      ok: false,
      message: `Could not focus "${agent.name}". Confirm cmux is running and the agent is still joined.`,
    };
  }
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const contentLength = Number(request.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > BOARD_SERVER_MAX_BODY_BYTES) {
      request.resume();
      reject(new Error('too-large'));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    request.on('data', chunk => {
      const buffer = Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > BOARD_SERVER_MAX_BODY_BYTES) {
        oversized = true;
        chunks.length = 0;
        return;
      }
      if (!oversized) chunks.push(buffer);
    });
    request.on('error', reject);
    request.on('end', () => {
      if (oversized) {
        reject(new Error('too-large'));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown);
      } catch {
        reject(new Error('invalid-json'));
      }
    });
  });
}

export const BOARD_SERVER_MAX_SSE_CLIENTS = 8;
const SSE_HEARTBEAT_MS = 12_000;
const SSE_POLL_MS = 1_000;
const SSE_FORCED_SNAPSHOT_MS = 30_000;

/** One value per projected source; any table absence degrades to a constant. */
function changeStamp(db: SwarmDb | null, swarmId: string): string | null {
  const scalar = (sql: string, ...params: string[]): string => {
    try {
      const row = db?.prepare(sql).get(...params) as Record<string, unknown> | undefined;
      return String(row ? Object.values(row)[0] : '');
    } catch {
      return '';
    }
  };
  if (!db) return null;
  const parts = [
    scalar('SELECT COALESCE(MAX(id), 0) FROM task_events WHERE swarm_id = ?', swarmId),
    scalar('SELECT COALESCE(MAX(id), 0) FROM messages WHERE swarm_id = ?', swarmId),
    scalar('SELECT COALESCE(MAX(last_heartbeat), \'\') FROM agents WHERE swarm_id = ?', swarmId),
    scalar('SELECT COUNT(*) FROM agents WHERE swarm_id = ?', swarmId),
    scalar('SELECT COALESCE(MAX(acked_at), \'\') FROM message_deliveries WHERE swarm_id = ?', swarmId),
    scalar('SELECT COALESCE(MAX(id), 0) || \':\' || COALESCE(MAX(revoked_at), \'\') FROM grants WHERE swarm_id = ?', swarmId),
    scalar('SELECT COALESCE(MAX(last_tick_at), \'\') FROM janitor_status'),
  ];
  return parts.join('|');
}

function makeRequestHandler(
  options: StartBoardServerOptions,
  token: string,
  getPort: () => number,
  sseClients: Set<ServerResponse>
): (request: IncomingMessage, response: ServerResponse) => void {
  const roots = options.assetRoots ?? defaultAssetRoots();
  const assets = assetAllowlist(roots);
  const projection = options.projection ?? collectBoardData;
  const now = options.now ?? Date.now;
  const streamId = randomBytes(8).toString('hex');

  return async (request, response) => {
    if (!hostAllowed(request.headers.host, getPort())) {
      sendText(response, 403, 'Forbidden: invalid Host header.');
      return;
    }

    const rawPath = requestPath(request);
    let parsed: URL;
    try {
      parsed = new URL(request.url ?? '/', `http://${BOARD_SERVER_HOST}:${getPort()}`);
    } catch {
      sendText(response, 400, 'Bad request URL.');
      return;
    }

    if (rawPath.startsWith('/api/')) {
      const header = request.headers['x-swarm-token'];
      const headerToken = Array.isArray(header) ? null : header;
      const queryToken = parsed.searchParams.get('token');
      // Cookie auth exists for EventSource, which cannot set headers; the
      // cookie is minted by the / page (HttpOnly, SameSite=Strict) so the
      // token stays out of stream URLs and network diagnostics.
      const cookieHeader = request.headers.cookie ?? '';
      const cookieToken = /(?:^|;\s*)swarm_board=([a-f0-9]+)/.exec(cookieHeader)?.[1] ?? null;
      if (!tokenMatches(headerToken, token) && !tokenMatches(queryToken, token) &&
          !tokenMatches(cookieToken, token)) {
        send(response, 401, 'application/json; charset=utf-8', JSON.stringify({
          error: 'Missing or invalid swarm board token.',
        }), { 'Cache-Control': 'no-store' });
        return;
      }
    }

    if (rawPath === '/api/events') {
      if (request.method !== 'GET') {
        sendText(response, 405, 'Method not allowed.');
        return;
      }
      if (sseClients.size >= BOARD_SERVER_MAX_SSE_CLIENTS) {
        send(response, 503, 'application/json; charset=utf-8', JSON.stringify({
          error: `Too many live board connections (max ${BOARD_SERVER_MAX_SSE_CLIENTS}).`,
        }), { 'Cache-Control': 'no-store' });
        return;
      }
      response.writeHead(200, {
        ...commonHeaders(),
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store',
        Connection: 'keep-alive',
      });
      sseClients.add(response);

      // Snapshot-stream contract (design Addendum A): every frame is a FULL
      // self-superseding snapshot, so there is no replay ring and no `after`
      // cursor — reconnect correctness is "adopt the next snapshot". seq is
      // per-connection (ordering within this stream only); streamId is the
      // server epoch so clients can detect a daemon restart.
      let seq = 0;
      const emitSnapshot = (): boolean => {
        try {
          const board = projection(options.db, options.swarmId, { now: now() });
          const frame = JSON.stringify({ streamId, seq: seq + 1, board });
          if (Buffer.byteLength(frame, 'utf-8') > BOARD_SERVER_MAX_JSON_BYTES) return false;
          seq += 1;
          // A slow client that cannot drain gets disconnected rather than
          // buffered without bound (research: SSE backpressure is ours to own).
          const writable = response.write(`id: ${seq}\nevent: snapshot\ndata: ${frame}\n\n`);
          if (!writable && response.writableLength > BOARD_SERVER_MAX_JSON_BYTES * 2) {
            response.destroy();
            return false;
          }
          return true;
        } catch {
          // Projection failures are transient (e.g. mid-migration); returning
          // false leaves the change pending so the next tick retries.
          return false;
        }
      };

      let lastStamp: string | null = null;
      let lastEmit = 0;
      if (emitSnapshot()) {
        lastStamp = changeStamp(options.db, options.swarmId);
        lastEmit = Date.now();
      }

      const poller = setInterval(() => {
        const stamp = changeStamp(options.db, options.swarmId);
        const forced = Date.now() - lastEmit >= SSE_FORCED_SNAPSHOT_MS;
        if (forced || stamp === null || stamp !== lastStamp) {
          // Advance the high-water marks only when the emit succeeded, so a
          // transient projection failure retries instead of losing the change.
          if (emitSnapshot()) {
            lastStamp = stamp;
            lastEmit = Date.now();
          }
        }
      }, SSE_POLL_MS);
      const heartbeat = setInterval(() => {
        try {
          response.write(`: heartbeat ${seq}\n\n`);
        } catch {
          response.destroy();
        }
      }, SSE_HEARTBEAT_MS);

      const cleanup = (): void => {
        clearInterval(poller);
        clearInterval(heartbeat);
        sseClients.delete(response);
      };
      request.on('close', cleanup);
      response.on('close', cleanup);
      return;
    }

    if (rawPath === '/api/focus-agent') {
      if (request.method !== 'POST') {
        send(response, 405, 'application/json; charset=utf-8', JSON.stringify({
          ok: false,
          message: 'Method not allowed; POST an agent name.',
        }), { Allow: 'POST', 'Cache-Control': 'no-store' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        const tooLarge = (error as Error).message === 'too-large';
        send(response, tooLarge ? 413 : 400, 'application/json; charset=utf-8', JSON.stringify({
          ok: false,
          message: tooLarge
            ? `Request body exceeds ${BOARD_SERVER_MAX_BODY_BYTES} bytes.`
            : 'Request body must be valid JSON.',
        }), { 'Cache-Control': 'no-store' });
        return;
      }
      const agent = body !== null && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>).agent
        : null;
      if (typeof agent !== 'string' || agent.length === 0 ||
          agent.length > BOARD_SERVER_MAX_AGENT_NAME_LENGTH) {
        send(response, 400, 'application/json; charset=utf-8', JSON.stringify({
          ok: false,
          message: `Agent must be a non-empty string of at most ${BOARD_SERVER_MAX_AGENT_NAME_LENGTH} characters.`,
        }), { 'Cache-Control': 'no-store' });
        return;
      }
      const result = focusAgentTerminal(options.db, options.swarmId, agent, options);
      send(response, result.status, 'application/json; charset=utf-8', JSON.stringify({
        ok: result.ok,
        message: result.message,
      }), { 'Cache-Control': 'no-store' });
      return;
    }

    if (request.method !== 'GET') {
      send(response, 405, 'text/plain; charset=utf-8', 'Method not allowed.', { Allow: 'GET' });
      return;
    }

    if (rawPath === '/') {
      try {
        const template = fs.readFileSync(path.join(roots.web, 'board.html'), 'utf-8');
        if (!template.includes(BOARD_SERVER_TOKEN_PLACEHOLDER)) {
          throw new Error('board token placeholder is missing');
        }
        const html = template.replaceAll(BOARD_SERVER_TOKEN_PLACEHOLDER, token);
        send(response, 200, 'text/html; charset=utf-8', html, {
          'Cache-Control': 'no-store',
          // EventSource cannot set headers; this cookie authenticates the
          // stream without putting the token in the URL.
          'Set-Cookie': `swarm_board=${token}; HttpOnly; SameSite=Strict; Path=/`,
        });
      } catch {
        sendText(response, 500, 'Board page is unavailable. Reinstall or rebuild swarm.');
      }
      return;
    }

    const asset = assets.get(rawPath);
    if (asset) {
      try {
        send(response, 200, asset.contentType, fs.readFileSync(asset.filePath));
      } catch {
        sendText(response, 500, 'Board asset is unavailable. Reinstall or rebuild swarm.');
      }
      return;
    }

    if (rawPath === '/api/board') {
      try {
        const json = JSON.stringify(projection(options.db, options.swarmId, { now: now() }));
        if (Buffer.byteLength(json, 'utf-8') > BOARD_SERVER_MAX_JSON_BYTES) {
          send(response, 503, 'application/json; charset=utf-8', JSON.stringify({
            error: 'Board projection exceeds the served response limit.',
          }), { 'Cache-Control': 'no-store' });
          return;
        }
        send(response, 200, 'application/json; charset=utf-8', json, {
          'Cache-Control': 'no-store',
        });
      } catch {
        send(response, 500, 'application/json; charset=utf-8', JSON.stringify({
          error: 'Board projection is unavailable.',
        }), { 'Cache-Control': 'no-store' });
      }
      return;
    }

    sendText(response, 404, 'Not found.');
  };
}

/** Start the read-only board server on loopback and return its testable lifecycle. */
export async function startBoardServer(
  options: StartBoardServerOptions
): Promise<RunningBoardServer> {
  const requestedPort = options.port ?? BOARD_SERVER_DEFAULT_PORT;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new Error('Board port must be an integer from 0 through 65535.');
  }

  const token = randomBytes(32).toString('hex');
  let boundPort = requestedPort;
  const sseClients = new Set<ServerResponse>();
  const server = http.createServer(makeRequestHandler(options, token, () => boundPort, sseClients));

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      if (error.code === 'EADDRINUSE') {
        reject(new Error(
          `Port ${requestedPort} is already in use; choose another with --port N.`
        ));
        return;
      }
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Board server did not bind a TCP port.'));
        return;
      }
      boundPort = address.port;
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(requestedPort, BOARD_SERVER_HOST);
  });

  let closePromise: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = new Promise<void>((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }
      // Live SSE streams never end on their own; destroy them or close() hangs.
      for (const client of sseClients) client.destroy();
      sseClients.clear();
      server.close(error => error ? reject(error) : resolve());
    });
    return closePromise;
  };

  return { server, port: boundPort, token, close };
}

export function boardServerUrl(running: Pick<RunningBoardServer, 'port' | 'token'>): string {
  return `http://${BOARD_SERVER_HOST}:${running.port}/#token=${encodeURIComponent(running.token)}`;
}

export function openBoardServerUrl(url: string): boolean {
  try {
    execFileSync('open', [url], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Prefer the existing cmux browser-workspace path, falling back to macOS open. */
export function openBoardServerTab(
  url: string,
  options: BoardServerTabOptions = {}
): { workspaceRef: string; surfaceRef: string } | null {
  const spawn = options.spawn ?? spawnBrowserWorkspace;
  const open = options.open ?? openBoardServerUrl;
  const writeError = options.writeError ?? (value => console.error(value));
  try {
    const result = spawn(options.cwd ?? process.cwd(), url, 'swarm board');
    if (result) return result;
  } catch {
    // The documented system-browser fallback keeps the served page reachable.
  }
  if (open(url)) {
    writeError('cmux browser unavailable; opened the served board with the system browser instead.');
  } else {
    writeError(`Could not open the served board automatically; open ${url} in a browser.`);
  }
  return null;
}

/** Keep the CLI in the foreground and close cleanly on Ctrl-C or termination. */
export async function waitForBoardServerStop(running: RunningBoardServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stopping = false;
    const cleanup = (): void => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      running.server.off('close', onClose);
    };
    const onClose = (): void => {
      cleanup();
      resolve();
    };
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      running.close().catch(error => {
        cleanup();
        reject(error);
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    running.server.once('close', onClose);
  });
}
