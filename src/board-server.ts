import type Database from 'better-sqlite3';
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
import { spawnBrowserWorkspace } from './transport.js';

export const BOARD_SERVER_HOST = '127.0.0.1';
export const BOARD_SERVER_DEFAULT_PORT = 7787;
export const BOARD_SERVER_TOKEN_PLACEHOLDER = '__SWARM_BOARD_TOKEN__';
export const BOARD_SERVER_MAX_JSON_BYTES = 2 * 1024 * 1024;

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface BoardAssetRoots {
  vendor: string;
  web: string;
}

export type BoardProjection = (
  db: Database.Database | null,
  swarmId: string,
  options?: CollectBoardDataOptions
) => BoardData;

export interface StartBoardServerOptions {
  db: Database.Database | null;
  swarmId: string;
  port?: number;
  projection?: BoardProjection;
  assetRoots?: BoardAssetRoots;
  now?: () => number;
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

function defaultAssetRoots(): BoardAssetRoots {
  return {
    vendor: path.join(MODULE_ROOT, 'vendor'),
    web: path.join(MODULE_ROOT, 'web'),
  };
}

function assetAllowlist(roots: BoardAssetRoots): ReadonlyMap<string, StaticAsset> {
  return new Map([
    ['/assets/cytoscape.min.js', {
      filePath: path.join(roots.vendor, 'cytoscape.min.js'),
      contentType: 'text/javascript; charset=utf-8',
    }],
    ['/assets/cytoscape-dagre.min.js', {
      filePath: path.join(roots.vendor, 'cytoscape-dagre.min.js'),
      contentType: 'text/javascript; charset=utf-8',
    }],
    ['/assets/board.css', {
      filePath: path.join(roots.web, 'board.css'),
      contentType: 'text/css; charset=utf-8',
    }],
    ['/assets/board-elements.js', {
      filePath: path.join(roots.web, 'board-elements.js'),
      contentType: 'text/javascript; charset=utf-8',
    }],
    ['/assets/board.js', {
      filePath: path.join(roots.web, 'board.js'),
      contentType: 'text/javascript; charset=utf-8',
    }],
  ]);
}

function commonHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': "default-src 'self'",
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

function makeRequestHandler(
  options: StartBoardServerOptions,
  token: string,
  getPort: () => number
): (request: IncomingMessage, response: ServerResponse) => void {
  const roots = options.assetRoots ?? defaultAssetRoots();
  const assets = assetAllowlist(roots);
  const projection = options.projection ?? collectBoardData;
  const now = options.now ?? Date.now;

  return (request, response) => {
    if (!hostAllowed(request.headers.host, getPort())) {
      sendText(response, 403, 'Forbidden: invalid Host header.');
      return;
    }

    if (request.method !== 'GET') {
      send(response, 405, 'text/plain; charset=utf-8', 'Method not allowed.', { Allow: 'GET' });
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
      if (!tokenMatches(headerToken, token) && !tokenMatches(queryToken, token)) {
        send(response, 401, 'application/json; charset=utf-8', JSON.stringify({
          error: 'Missing or invalid swarm board token.',
        }), { 'Cache-Control': 'no-store' });
        return;
      }
    }

    if (rawPath === '/') {
      try {
        const template = fs.readFileSync(path.join(roots.web, 'board.html'), 'utf-8');
        if (!template.includes(BOARD_SERVER_TOKEN_PLACEHOLDER)) {
          throw new Error('board token placeholder is missing');
        }
        const html = template.replaceAll(BOARD_SERVER_TOKEN_PLACEHOLDER, token);
        send(response, 200, 'text/html; charset=utf-8', html, { 'Cache-Control': 'no-store' });
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
  const server = http.createServer(makeRequestHandler(options, token, () => boundPort));

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
