import { describe, test } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { renderBoard, watchBoard } from '../src/board.js';
import { getDbAt } from '../src/db.js';

const NOW = Date.parse('2026-07-18T18:00:00.000Z');
const INDEX = path.resolve(fileURLToPath(new URL('../src/index.ts', import.meta.url)));

function iso(minutesAgo: number): string {
  return new Date(NOW - minutesAgo * 60_000).toISOString();
}

function insertAgent(db: Database.Database, name: string, host: string): void {
  db.prepare(`
    INSERT INTO agents (
      id, swarm_id, name, description, surface_id, workspace_id, ppid,
      joined_at, last_heartbeat, agent_type, endpoint_url, host_agent
    ) VALUES (?, 'default', ?, NULL, ?, NULL, 1, ?, ?, 'cmux', NULL, ?)
  `).run(`agent-${name}`, name, `surface-${name}`, iso(180), iso(1), host);
}

function insertTask(
  db: Database.Database,
  id: string,
  state: string,
  owner: string,
  epoch: number,
  createdMinutesAgo: number,
  branch: string | null = null
): void {
  db.prepare(`
    INSERT INTO tasks (
      id, swarm_id, title, state, owner_agent, lease_epoch, lease_expires_at,
      repo_path, branch, worktree_path, transcript_hint, disposition, created_at, updated_at
    ) VALUES (?, 'default', ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?, ?)
  `).run(
    id,
    `${id} title`,
    state,
    owner,
    epoch,
    iso(0),
    branch,
    iso(createdMinutesAgo),
    iso(createdMinutesAgo)
  );
}

function insertEvent(
  db: Database.Database,
  taskId: string,
  actor: string,
  kind: string,
  minutesAgo: number,
  data: unknown = null
): void {
  const task = db.prepare('SELECT lease_epoch FROM tasks WHERE swarm_id = ? AND id = ?')
    .get('default', taskId) as { lease_epoch: number };
  db.prepare(`
    INSERT INTO task_events (swarm_id, task_id, epoch, kind, actor, data, created_at)
    VALUES ('default', ?, ?, ?, ?, ?, ?)
  `).run(taskId, task.lease_epoch, kind, actor, data === null ? null : JSON.stringify(data), iso(minutesAgo));
}

function checkpointFile(root: string, name: string, quota: boolean): string {
  const filePath = path.join(root, `${name}.md`);
  const quotaSection = quota ? '\n## quota\n- codex: green\n- claude: yellow\n' : '';
  fs.writeFileSync(filePath, `# checkpoint ${name}\n## next action\nShip ${name}.${quotaSection}`);
  return filePath;
}

function createFixture(quota: boolean = true): {
  root: string;
  dbPath: string;
  db: Database.Database;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-board-next-'));
  const dbPath = path.join(root, 'swarm.db');
  const db = getDbAt(dbPath);
  insertAgent(db, 'Alice', 'codex');
  insertAgent(db, 'Bob', 'claude-code');

  insertTask(db, 'review-task', 'awaiting_review', 'Alice', 1, 20);
  insertTask(db, 'stale-task', 'active', 'Bob', 2, 120, 'swarm/Bob/stale-task');
  insertTask(db, 'program-capacity', 'active', 'Alice', 3, 30);
  insertEvent(db, 'review-task', 'Alice', 'started', 20);
  const stalePath = checkpointFile(root, 'stale-task', false);
  insertEvent(db, 'stale-task', 'Bob', 'checkpoint', 91, { path: stalePath, sequence: 1 });
  const programPath = checkpointFile(root, 'program-capacity', quota);
  insertEvent(db, 'program-capacity', 'Alice', 'checkpoint', 5, { path: programPath, sequence: 1 });

  const gate = db.prepare(`
    INSERT INTO messages (
      swarm_id, from_agent, to_agent, body, delivered, created_at, kind, superseded_by
    ) VALUES ('default', 'Bob', 'Alice', 'approve the release', 1, ?, 'gate', NULL)
  `).run(iso(1));
  db.prepare(`
    INSERT INTO message_deliveries (
      message_id, swarm_id, recipient, status, first_injected_at, inject_count, acked_at
    ) VALUES (?, 'default', 'Alice', 'delivered', ?, 1, NULL)
  `).run(Number(gate.lastInsertRowid), iso(1));

  const acknowledged = db.prepare(`
    INSERT INTO messages (
      swarm_id, from_agent, to_agent, body, delivered, created_at, kind, superseded_by
    ) VALUES ('default', 'Lead', 'Alice', 'older status', 1, ?, 'status', NULL)
  `).run(iso(3));
  db.prepare(`
    INSERT INTO message_deliveries (
      message_id, swarm_id, recipient, status, first_injected_at, inject_count, acked_at
    ) VALUES (?, 'default', 'Alice', 'acked', ?, 1, ?)
  `).run(Number(acknowledged.lastInsertRowid), iso(3), iso(2));

  // A recent message sent by Bob must not count as Bob's progress evidence.
  db.prepare(`
    INSERT INTO messages (
      swarm_id, from_agent, to_agent, body, delivered, created_at, kind, superseded_by
    ) VALUES ('default', 'Bob', 'Alice', 'recent words are not progress', 1, ?, 'status', NULL)
  `).run(iso(0));

  db.prepare(`
    INSERT INTO janitor_status (id, last_tick_at, last_duration_ms, counters)
    VALUES (1, ?, 12, ?)
  `).run(iso(31), JSON.stringify({
    worktrees: 4,
    detachedHeads: 1,
    orphanedWorktrees: 0,
    unpushedCommits: 7,
    goneUpstreamBranches: 0,
    tempStrays: 2,
    junkDirs: 1,
    reposScanned: 3,
    tickMs: 12,
  }));
  return { root, dbPath, db };
}

function databaseSnapshot(db: Database.Database): string {
  const tables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string }>;
  return JSON.stringify(tables.map(({ name }) => ({
    name,
    rows: db.prepare(`SELECT * FROM ${name}`).all(),
  })));
}

function fileSnapshot(root: string): string {
  const visit = (dir: string): unknown[] => fs.readdirSync(dir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(entry => {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) return [entry.name, visit(filePath)];
      const stat = fs.statSync(filePath);
      return [entry.name, stat.size, stat.mtimeMs, fs.readFileSync(filePath).toString('base64')];
    });
  return JSON.stringify(visit(root));
}

describe('WI-7 swarm board', () => {
  test('renders NEEDS YOU, TASKS, FLEET, and DEBRIS + QUOTA in urgency order', () => {
    const fixture = createFixture(true);
    try {
      const output = renderBoard(fixture.db, 'default', { now: NOW });
      const headings = ['NEEDS YOU', 'TASKS', 'FLEET', 'DEBRIS + QUOTA'];
      assert.deepStrictEqual(
        headings.map(heading => output.indexOf(heading)),
        [...headings.map(heading => output.indexOf(heading))].sort((left, right) => left - right)
      );

      assert.match(output, /message #\d+ \[gate\] for Alice from Bob \u2014 approve the release/);
      assert.match(output, /task review-task awaits review \u2014 Alice\(1\)/);
      assert.match(output, /task stale-task stalled \u2014 checkpoint 91m ago/);
      assert.match(output, /janitor heartbeat stale \u2014 tick 31m ago/);

      assert.match(output, /review-task \| awaiting_review \| Alice\(1\)/);
      assert.match(output, /stale-task \| active \| Bob\(2\) \| -\/claude-code \| 91m/);
      assert.match(output, /program-capacity \| active \| Alice\(3\) \| -\/codex \| 5m/);
      assert.strictEqual((output.match(/\u2502 review-task \|/g) ?? []).length, 1);
      assert.strictEqual((output.match(/\u2502 stale-task \|/g) ?? []).length, 1);
      assert.strictEqual((output.match(/\u2502 program-capacity \|/g) ?? []).length, 1);

      assert.match(output, /Alice \| codex \| program-capacity \| progress 2m \| 1 unacked/);
      assert.match(output, /Bob \| claude-code \| stale-task \| progress 91m \| 0 unacked/);
      assert.strictEqual((output.match(/\u2502 Alice \|/g) ?? []).length, 1);
      assert.strictEqual((output.match(/\u2502 Bob \|/g) ?? []).length, 1);

      assert.match(output, /debris: worktrees 4 \(1 detached\) \| unpushed 7 \| strays 2 \| junk 1 \| tick 31m ago/);
      assert.match(output, /quota: codex: green \| claude: yellow/);
    } finally {
      fixture.db.close();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('renders the exact quiet NEEDS YOU line when no item requires attention', () => {
    const fixture = createFixture(true);
    try {
      fixture.db.prepare("UPDATE message_deliveries SET status = 'acked', acked_at = ? WHERE acked_at IS NULL")
        .run(iso(0));
      fixture.db.prepare("UPDATE tasks SET state = 'done' WHERE id IN ('review-task', 'stale-task')").run();
      fixture.db.prepare('UPDATE janitor_status SET last_tick_at = ? WHERE id = 1').run(iso(0));
      const output = renderBoard(fixture.db, 'default', { now: NOW });
      assert.match(output, /\u2502 nothing needs you\s+\u2502/);
    } finally {
      fixture.db.close();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('falls back to quota: not recorded when the latest program checkpoint has no quota section', () => {
    const fixture = createFixture(false);
    try {
      assert.match(renderBoard(fixture.db, 'default', { now: NOW }), /quota: not recorded/);
    } finally {
      fixture.db.close();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('watch mode clears and renders twice with injected clock, wait, and exit', async () => {
    let clock = 100;
    const output: string[] = [];
    const waits: number[] = [];
    let clears = 0;
    const count = await watchBoard({
      intervalMs: 1,
      render: () => `snapshot ${clock++}`,
      clear: () => { clears += 1; },
      write: value => { output.push(value); },
      wait: async milliseconds => { waits.push(milliseconds); },
      shouldContinue: renders => renders < 2,
    });
    assert.strictEqual(count, 2);
    assert.strictEqual(clears, 2);
    assert.deepStrictEqual(output, ['snapshot 100\n', 'snapshot 101\n']);
    assert.deepStrictEqual(waits, [1]);
  });

  test('renders every section as not available against a fresh empty database', () => {
    const db = new Database(':memory:');
    try {
      const output = renderBoard(db, 'default', { now: NOW });
      assert.ok(output.indexOf('NEEDS YOU') < output.indexOf('TASKS'));
      assert.ok(output.indexOf('TASKS') < output.indexOf('FLEET'));
      assert.ok(output.indexOf('FLEET') < output.indexOf('DEBRIS + QUOTA'));
      assert.strictEqual((output.match(/not available/g) ?? []).length, 4);
    } finally {
      db.close();
    }
  });

  test('the CLI gracefully reads a pre-migration empty DB without migrating or creating files', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-board-empty-cli-'));
    const swarmDir = path.join(home, '.swarm');
    const dbPath = path.join(swarmDir, 'swarm.db');
    fs.mkdirSync(swarmDir);
    new Database(dbPath).close();
    try {
      const before = fileSnapshot(home);
      const output = execFileSync('node', ['--import', 'tsx', INDEX, 'board'], {
        encoding: 'utf-8',
        env: {
          ...process.env,
          HOME: home,
          SWARM_ID: '',
          SWARM_NAME: '',
          SWARM_AGENT_NAME: '',
          CMUX_SURFACE_ID: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert.strictEqual((output.match(/not available/g) ?? []).length, 4);
      assert.strictEqual(fileSnapshot(home), before);
      assert.deepStrictEqual(fs.readdirSync(swarmDir), ['swarm.db']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('a render performs zero database mutations and zero filesystem writes', () => {
    const fixture = createFixture(true);
    try {
      const beforeDb = databaseSnapshot(fixture.db);
      const beforeFiles = fileSnapshot(fixture.root);
      fixture.db.pragma('query_only = ON');
      const output = renderBoard(fixture.db, 'default', { now: NOW });
      assert.match(output, /NEEDS YOU/);
      assert.strictEqual(databaseSnapshot(fixture.db), beforeDb);
      assert.strictEqual(fileSnapshot(fixture.root), beforeFiles);
    } finally {
      fixture.db.close();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
