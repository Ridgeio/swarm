import { describe, test, type TestContext } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BoardData } from '../src/board-data.js';
import {
  BOARD_SERVER_DEFAULT_PORT,
  boardServerUrl,
  startBoardServer,
  type RunningBoardServer,
  type StartBoardServerOptions,
} from '../src/board-server.js';
import { getDbAt } from '../src/db.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function boardFixture(): BoardData {
  return {
    generatedAt: '2026-07-19T12:00:00.000Z',
    swarm: { id: 'default', name: 'Ridge Fleet' },
    agents: [],
    tasks: [],
    edges: { ownership: [], handoffs: [], claims: [] },
    needsYou: [],
    debris: {
      tickAgeMin: 2,
      counters: {
        worktrees: 0,
        detachedHeads: 0,
        orphanedWorktrees: 0,
        unpushedCommits: 0,
        goneUpstreamBranches: 0,
        tempStrays: 0,
        junkDirs: 0,
        reposScanned: 1,
        tickMs: 4,
      },
      findings: [],
    },
    timeline: [],
    quota: null,
    unavailable: [],
  };
}

async function startOrSkip(
  context: TestContext,
  options: StartBoardServerOptions
): Promise<RunningBoardServer | null> {
  try {
    return await startBoardServer({ ...options, port: options.port ?? 0 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      context.skip('sandbox denies loopback listen with EPERM');
      return null;
    }
    throw error;
  }
}

function request(
  running: RunningBoardServer,
  requestPath: string,
  options: { host?: string; token?: string } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Host: options.host ?? `127.0.0.1:${running.port}`,
    };
    if (options.token) headers['X-Swarm-Token'] = options.token;
    const outgoing = http.request({
      hostname: '127.0.0.1',
      port: running.port,
      path: requestPath,
      method: 'GET',
      headers,
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf-8'),
      }));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

describe('V1-B served board', () => {
  test('requires the session token for the board API', async context => {
    const running = await startOrSkip(context, {
      db: null,
      swarmId: 'default',
      projection: () => boardFixture(),
    });
    if (!running) return;
    try {
      const response = await request(running, '/api/board');
      assert.strictEqual(response.status, 401);
      assert.strictEqual(response.headers['cache-control'], 'no-store');
      assert.strictEqual(response.headers['content-security-policy'], "default-src 'self'");
      assert.strictEqual(response.headers['x-content-type-options'], 'nosniff');
    } finally {
      await running.close();
    }
  });

  test('rejects a bad Host header before routing', async context => {
    const running = await startOrSkip(context, {
      db: null,
      swarmId: 'default',
      projection: () => boardFixture(),
    });
    if (!running) return;
    try {
      const response = await request(running, '/api/board', {
        host: 'board.attacker.test',
        token: running.token,
      });
      assert.strictEqual(response.status, 403);
      assert.strictEqual(response.headers['content-security-policy'], "default-src 'self'");
    } finally {
      await running.close();
    }
  });

  test('serves only explicitly allowlisted assets', async context => {
    const running = await startOrSkip(context, {
      db: null,
      swarmId: 'default',
      projection: () => boardFixture(),
    });
    if (!running) return;
    try {
      const known = await request(running, '/assets/board.js');
      const traversal = await request(running, '/assets/../../package.json');
      const encodedTraversal = await request(running, '/assets/%2e%2e/%2e%2e/package.json');
      const unknown = await request(running, '/assets/unknown.js');
      assert.strictEqual(known.status, 200);
      assert.match(String(known.headers['content-type']), /^text\/javascript/);
      assert.strictEqual(traversal.status, 404);
      assert.strictEqual(encodedTraversal.status, 404);
      assert.strictEqual(unknown.status, 404);
      assert.doesNotMatch(traversal.body, /"name"\s*:\s*"swarm"/);
    } finally {
      await running.close();
    }
  });

  test('templates the token into offline HTML and returns the injected projection shape', async context => {
    const fixture = boardFixture();
    const running = await startOrSkip(context, {
      db: null,
      swarmId: 'default',
      projection: () => fixture,
    });
    if (!running) return;
    try {
      assert.match(running.token, /^[a-f0-9]{64}$/);
      assert.strictEqual(
        boardServerUrl(running),
        `http://127.0.0.1:${running.port}/#token=${running.token}`
      );
      const page = await request(running, '/');
      assert.strictEqual(page.status, 200);
      assert.match(String(page.headers['content-type']), /^text\/html/);
      assert.ok(page.body.includes(running.token));
      assert.doesNotMatch(page.body, /https?:\/\//);

      const api = await request(running, '/api/board', { token: running.token });
      assert.strictEqual(api.status, 200);
      assert.match(String(api.headers['content-type']), /^application\/json/);
      assert.deepStrictEqual(JSON.parse(api.body), fixture);

      const queryAuth = await request(
        running,
        `/api/board?token=${encodeURIComponent(running.token)}`
      );
      assert.strictEqual(queryAuth.status, 200);
    } finally {
      await running.close();
    }
  });

  test('performs zero SQLite writes across a page, asset, and API request sequence', async context => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-board-server-db-'));
    const dbPath = path.join(root, 'swarm.db');
    const writable = getDbAt(dbPath);
    writable.close();
    const before = fs.readFileSync(dbPath);
    const readOnly = new Database(dbPath, { readonly: true, fileMustExist: true });
    readOnly.pragma('query_only = ON');
    const running = await startOrSkip(context, { db: readOnly, swarmId: 'default' });
    if (!running) {
      readOnly.close();
      fs.rmSync(root, { recursive: true, force: true });
      return;
    }
    try {
      assert.strictEqual((await request(running, '/')).status, 200);
      assert.strictEqual((await request(running, '/assets/board.css')).status, 200);
      assert.strictEqual((await request(running, '/api/board', { token: running.token })).status, 200);
      assert.deepStrictEqual(fs.readFileSync(dbPath), before);
    } finally {
      await running.close();
      readOnly.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('port-in-use refusal names the actionable --port flag', async context => {
    const blocker = http.createServer();
    let ownsPort = false;
    try {
      await new Promise<void>((resolve, reject) => {
        blocker.once('error', error => reject(error));
        blocker.listen(BOARD_SERVER_DEFAULT_PORT, '127.0.0.1', () => {
          ownsPort = true;
          resolve();
        });
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM') {
        context.skip('sandbox denies loopback listen with EPERM');
        return;
      }
      if (code !== 'EADDRINUSE') throw error;
    }

    try {
      await assert.rejects(
        startBoardServer({ db: null, swarmId: 'default' }),
        error => {
          assert.match((error as Error).message, new RegExp(`Port ${BOARD_SERVER_DEFAULT_PORT} is already in use`));
          assert.match((error as Error).message, /--port N/);
          return true;
        }
      );
    } finally {
      if (ownsPort) await new Promise<void>(resolve => blocker.close(() => resolve()));
    }
  });
});

describe('V1-B static board assets', () => {
  test('all web files are local-only and HTML references only the asset route', () => {
    const expected = ['board.html', 'board.css', 'board.js', 'board-elements.js'];
    for (const name of expected) {
      const contents = fs.readFileSync(path.join(ROOT, 'web', name), 'utf-8');
      assert.doesNotMatch(contents, /https?:\/\//, `${name} contains an external URL`);
    }
    const html = fs.readFileSync(path.join(ROOT, 'web', 'board.html'), 'utf-8');
    const references = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]);
    assert.ok(references.length > 0);
    assert.ok(references.every(reference => reference.startsWith('./assets/')));
    assert.doesNotMatch(html, /type="module"/);
    assert.doesNotMatch(html, /echarts/i);
    assert.doesNotMatch(
      fs.readFileSync(path.join(ROOT, 'web', 'board.js'), 'utf-8'),
      /innerHTML/
    );
  });
});
