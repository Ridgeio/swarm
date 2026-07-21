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
  BOARD_SERVER_MAX_BODY_BYTES,
  BOARD_SERVER_DEFAULT_PORT,
  boardServerUrl,
  focusAgentTerminal,
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
  options: { host?: string; token?: string; method?: string; body?: string } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Host: options.host ?? `127.0.0.1:${running.port}`,
    };
    if (options.token) headers['X-Swarm-Token'] = options.token;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(options.body));
    }
    const outgoing = http.request({
      hostname: '127.0.0.1',
      port: running.port,
      path: requestPath,
      method: options.method ?? 'GET',
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
    outgoing.end(options.body);
  });
}

function insertFocusAgent(
  db: Database.Database,
  name: string,
  agentType: string,
  surfaceId: string,
  workspaceId: string | null
): void {
  const now = '2026-07-19T12:00:00.000Z';
  db.prepare(`
    INSERT INTO agents (
      id, swarm_id, name, description, surface_id, workspace_id, ppid,
      joined_at, last_heartbeat, agent_type, endpoint_url, host_agent
    ) VALUES (?, 'default', ?, NULL, ?, ?, 1, ?, ?, ?, NULL, ?)
  `).run(`focus-${name}`, name, surfaceId, workspaceId, now, now, agentType, agentType);
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
      const echarts = await request(running, '/assets/echarts.min.js');
      const traversal = await request(running, '/assets/../../package.json');
      const encodedTraversal = await request(running, '/assets/%2e%2e/%2e%2e/package.json');
      const unknown = await request(running, '/assets/unknown.js');
      assert.strictEqual(known.status, 200);
      assert.match(String(known.headers['content-type']), /^text\/javascript/);
      assert.strictEqual(echarts.status, 200);
      assert.match(String(echarts.headers['content-type']), /^text\/javascript/);
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

describe('V1-C focus-agent endpoint', () => {
  test('registry focus invokes the injected binary and exact surface-focus args', () => {
    const db = getDbAt(':memory:');
    insertFocusAgent(db, 'Alice', 'cmux', 'surface-registered', 'workspace-registered');
    const calls: Array<{ binary: string; args: string[] }> = [];
    try {
      const result = focusAgentTerminal(db, 'default', 'alice', {
        resolveCmuxBinary: () => '/test/bin/cmux',
        cmuxRunner: (binary, args) => {
          calls.push({ binary, args: [...args] });
          return args.includes('identify')
            ? JSON.stringify({ caller: { pane_ref: 'pane-resolved' } })
            : '';
        },
      });
      assert.deepStrictEqual(result, {
        status: 200,
        ok: true,
        message: 'Focused terminal for "Alice".',
      });
      assert.deepStrictEqual(calls, [
        {
          binary: '/test/bin/cmux',
          args: ['--json', 'identify', '--surface', 'surface-registered'],
        },
        {
          binary: '/test/bin/cmux',
          args: [
            'focus-panel', '--panel', 'surface-registered',
            '--workspace', 'workspace-registered',
          ],
        },
      ]);
    } finally {
      db.close();
    }
  });

  test('requires the session token before reading a focus request', async context => {
    const running = await startOrSkip(context, { db: null, swarmId: 'default' });
    if (!running) return;
    try {
      const response = await request(running, '/api/focus-agent', {
        method: 'POST',
        body: JSON.stringify({ agent: 'Alice' }),
      });
      assert.strictEqual(response.status, 401);
    } finally {
      await running.close();
    }
  });

  test('rejects a bad Host before reading a focus request', async context => {
    const running = await startOrSkip(context, { db: null, swarmId: 'default' });
    if (!running) return;
    try {
      const response = await request(running, '/api/focus-agent', {
        method: 'POST',
        host: 'board.attacker.test',
        token: running.token,
        body: JSON.stringify({ agent: 'Alice' }),
      });
      assert.strictEqual(response.status, 403);
    } finally {
      await running.close();
    }
  });

  test('returns 404 for an unknown agent in the served swarm', async context => {
    const db = getDbAt(':memory:');
    const running = await startOrSkip(context, { db, swarmId: 'default' });
    if (!running) {
      db.close();
      return;
    }
    try {
      const response = await request(running, '/api/focus-agent', {
        method: 'POST',
        token: running.token,
        body: JSON.stringify({ agent: 'Nobody' }),
      });
      assert.strictEqual(response.status, 404);
      assert.deepStrictEqual(JSON.parse(response.body).ok, false);
      assert.match(JSON.parse(response.body).message, /Unknown agent/);
    } finally {
      await running.close();
      db.close();
    }
  });

  test('returns 400 for a registered non-cmux agent', async context => {
    const db = getDbAt(':memory:');
    insertFocusAgent(db, 'Remote', 'a2a', 'a2a:default:Remote', null);
    const running = await startOrSkip(context, { db, swarmId: 'default' });
    if (!running) {
      db.close();
      return;
    }
    try {
      const response = await request(running, '/api/focus-agent', {
        method: 'POST',
        token: running.token,
        body: JSON.stringify({ agent: 'remote' }),
      });
      assert.strictEqual(response.status, 400);
      assert.match(JSON.parse(response.body).message, /no cmux terminal/i);
    } finally {
      await running.close();
      db.close();
    }
  });

  test('focuses only the registry-resolved surface and ignores extra body fields', async context => {
    const db = getDbAt(':memory:');
    insertFocusAgent(db, 'Alice', 'cmux', 'surface-registered', 'workspace-registered');
    const calls: Array<{ binary: string; args: string[] }> = [];
    const running = await startOrSkip(context, {
      db,
      swarmId: 'default',
      resolveCmuxBinary: () => '/test/bin/cmux',
      cmuxRunner: (binary, args) => {
        calls.push({ binary, args: [...args] });
        if (args.includes('identify')) {
          return JSON.stringify({
            caller: {
              surface_ref: 'surface-registered',
              workspace_ref: 'workspace-from-cmux',
              pane_ref: 'pane-resolved',
            },
          });
        }
        return '';
      },
    });
    if (!running) {
      db.close();
      return;
    }
    try {
      const response = await request(running, '/api/focus-agent', {
        method: 'POST',
        token: running.token,
        body: JSON.stringify({
          agent: 'alice',
          surface: 'surface-attacker',
          workspace: 'workspace-attacker',
          command: 'open-something',
        }),
      });
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(JSON.parse(response.body), {
        ok: true,
        message: 'Focused terminal for "Alice".',
      });
      assert.deepStrictEqual(calls, [
        {
          binary: '/test/bin/cmux',
          args: ['--json', 'identify', '--surface', 'surface-registered'],
        },
        {
          binary: '/test/bin/cmux',
          args: [
            'focus-panel', '--panel', 'surface-registered',
            '--workspace', 'workspace-registered',
          ],
        },
      ]);
    } finally {
      await running.close();
      db.close();
    }
  });

  test('rejects an oversized JSON body without invoking cmux', async context => {
    let runnerCalled = false;
    const running = await startOrSkip(context, {
      db: null,
      swarmId: 'default',
      cmuxRunner: () => {
        runnerCalled = true;
        return '';
      },
    });
    if (!running) return;
    try {
      const response = await request(running, '/api/focus-agent', {
        method: 'POST',
        token: running.token,
        body: JSON.stringify({ agent: 'A'.repeat(BOARD_SERVER_MAX_BODY_BYTES) }),
      });
      assert.strictEqual(response.status, 413);
      assert.strictEqual(JSON.parse(response.body).ok, false);
      assert.strictEqual(runnerCalled, false);
    } finally {
      await running.close();
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
    assert.match(html, /assets\/echarts\.min\.js/);
    const boardScript = fs.readFileSync(path.join(ROOT, 'web', 'board.js'), 'utf-8');
    assert.doesNotMatch(boardScript, /innerHTML/);
    assert.match(boardScript, /'Claim kind'/);
    assert.match(boardScript, /'Not established'/);
    assert.match(boardScript, /'Close evidence'/);
    assert.match(boardScript, /'GATE OVERRIDES'/);
    assert.match(boardScript, /'Grant usage'/);
  });
});
