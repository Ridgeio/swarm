import { describe, test } from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  BOARD_CMUX_GUIDANCE,
  buildBoardHtml,
  buildBoardMermaid,
  openBoardGraphTab,
  renderBoard,
  spawnBoardTab,
  watchBoard,
  watchBoardGraph,
  writeBoardGraphFile,
} from '../src/board.js';
import { getDbAt, type SwarmDb } from '../src/db.js';

const NOW = Date.parse('2026-07-18T18:00:00.000Z');
const INDEX = path.resolve(fileURLToPath(new URL('../src/index.ts', import.meta.url)));
const VENDORED_MERMAID = path.resolve(fileURLToPath(new URL('../vendor/mermaid.min.js', import.meta.url)));

function iso(minutesAgo: number): string {
  return new Date(NOW - minutesAgo * 60_000).toISOString();
}

function insertAgent(db: SwarmDb, name: string, host: string): void {
  db.prepare(`
    INSERT INTO agents (
      id, swarm_id, name, description, surface_id, workspace_id, ppid,
      joined_at, last_heartbeat, agent_type, endpoint_url, host_agent
    ) VALUES (?, 'default', ?, NULL, ?, NULL, 1, ?, ?, 'cmux', NULL, ?)
  `).run(`agent-${name}`, name, `surface-${name}`, iso(180), iso(1), host);
}

function insertTask(
  db: SwarmDb,
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
  db: SwarmDb,
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
  db: SwarmDb;
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

function databaseSnapshot(db: SwarmDb): string {
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
    const db = new DatabaseSync(':memory:');
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
    new DatabaseSync(dbPath).close();
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
      fixture.db.exec('PRAGMA query_only = ON');
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

describe('WI-7b board cmux tab', () => {
  test('spawns the exact watch command with a round-tripped interval and workspace title', () => {
    let invocation: { cwd: string; command: string; title?: string } | null = null;
    const output: string[] = [];
    const result = spawnBoardTab({
      cwd: '/tmp/swarm board cwd',
      watchSeconds: 17,
      spawn: (cwd, command, title) => {
        invocation = { cwd, command, title };
        return { workspaceRef: 'workspace:7', surfaceRef: 'surface:8' };
      },
      write: value => { output.push(value); },
    });

    assert.deepStrictEqual(invocation, {
      cwd: '/tmp/swarm board cwd',
      command: 'swarm board --watch 17',
      title: 'swarm board',
    });
    assert.deepStrictEqual(result, { workspaceRef: 'workspace:7', surfaceRef: 'surface:8' });
    assert.deepStrictEqual(output, ['Opened swarm board: workspace:7 surface:8']);
  });

  test('cmux absence exits 1 with the exact guidance message instead of throwing', () => {
    const errors: string[] = [];
    let exitCode: number | null = null;
    const result = spawnBoardTab({
      spawn: () => { throw new Error('cmux not found'); },
      writeError: value => { errors.push(value); },
      exit: code => { exitCode = code; },
    });
    assert.strictEqual(result, null);
    assert.strictEqual(exitCode, 1);
    assert.deepStrictEqual(errors, [BOARD_CMUX_GUIDANCE]);
  });
});

describe('WI-7c board Mermaid graph', () => {
  test('populated graph renders host/state classes, ownership, distinct handoff/claim edges, and debris counts', () => {
    const fixture = createFixture(true);
    try {
      insertTask(fixture.db, 'open-task', 'open', 'Alice', 1, 10);
      insertEvent(fixture.db, 'stale-task', 'Alice', 'handoff', 85, { to: 'Bob' });
      insertEvent(fixture.db, 'stale-task', 'Bob', 'claimed', 80, { previous_owner: 'Alice' });
      insertEvent(fixture.db, 'stale-task', 'Bob', 'claimed', 70, { previous_owner: 'Alice' });
      const mermaid = buildBoardMermaid(fixture.db, 'default', { now: NOW });

      assert.match(mermaid, /^flowchart LR$/m);
      for (const className of [
        'hostClaude', 'hostCodex', 'hostGrok', 'hostGemini', 'hostA2A', 'hostHeadless', 'hostUnknown',
        'stActive', 'stAwaiting', 'stStale', 'stOpen', 'stDone',
        'debrisWarn', 'debrisOk', 'debrisStale',
      ]) {
        assert.match(mermaid, new RegExp(`classDef ${className} `), className);
      }
      assert.match(mermaid, /agent0\("Alice<br\/>codex"\):::hostCodex/);
      assert.match(mermaid, /agent1\("Bob<br\/>claude-code"\):::hostClaude/);
      assert.match(mermaid, /task\d+\["open-task<br\/>\[open\] · no ckpt"\]:::stOpen/);
      assert.match(mermaid, /task\d+\["review-task<br\/>\[awaiting_review\] · no ckpt"\]:::stAwaiting/);
      assert.match(mermaid, /task\d+\["stale-task<br\/>\[active\] · ckpt 91m"\]:::stStale/);
      assert.match(mermaid, /agent1 -->\|owns\| task\d+/);
      assert.strictEqual((mermaid.match(/agent0 -\.->\|handoff\| agent1/g) ?? []).length, 1);
      assert.strictEqual((mermaid.match(/agent0 -\.->\|claimed\| agent1/g) ?? []).length, 1);
      assert.match(mermaid, /linkStyle \d+ stroke-dasharray:8 4;/);
      assert.match(mermaid, /linkStyle \d+ stroke-dasharray:2 3;/);
      assert.match(mermaid, /debris0\["debris<br\/>4 worktrees \(1 detached\)<br\/>7 unpushed<br\/>tick 31m ago"\]/);
      assert.match(mermaid, /class debris0 debrisWarn,debrisStale/);
      assert.doesNotMatch(mermaid, /task\d+ -\.-> debris0/);
      assert.match(mermaid, /subgraph legend\["Legend"\]/);
      assert.match(mermaid, /solid owns · dashed handoff · dotted claimed/);
      assert.match(mermaid, /2 agents/);
      assert.match(mermaid, /4 tasks/);
    } finally {
      fixture.db.close();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('includes recently done tasks dimmed and omits done tasks older than 24 hours', () => {
    const fixture = createFixture(true);
    try {
      insertTask(fixture.db, 'recent-done', 'done', 'Alice', 1, 30);
      insertTask(fixture.db, 'old-done', 'done', 'Bob', 1, 25 * 60);
      const mermaid = buildBoardMermaid(fixture.db, 'default', { now: NOW });
      assert.match(mermaid, /recent-done<br\/>\[done\] · no ckpt"\]:::stDone/);
      assert.doesNotMatch(mermaid, /old-done/);
    } finally {
      fixture.db.close();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('empty swarm remains a valid graph with idle and debris nodes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-board-graph-empty-'));
    const db = getDbAt(path.join(root, 'swarm.db'));
    try {
      const mermaid = buildBoardMermaid(db, 'default', { now: NOW });
      assert.match(mermaid, /^flowchart LR$/m);
      assert.match(mermaid, /idle\["idle swarm"\]:::note/);
      assert.match(mermaid, /debris0\["debris<br\/>0 worktrees \(0 detached\)<br\/>0 unpushed<br\/>tick never"\]/);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('missing tables return a minimal clear graph instead of throwing', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const mermaid = buildBoardMermaid(db, 'legacy', { now: NOW });
      assert.match(mermaid, /^flowchart LR$/m);
      assert.match(mermaid, /board graph not available/);
      assert.match(mermaid, /missing tables: agents, tasks, task_events, janitor_status/);
    } finally {
      db.close();
    }
  });

  test('labels cannot inject Mermaid syntax and node ids never derive from names or slugs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-board-graph-labels-'));
    const db = getDbAt(path.join(root, 'swarm.db'));
    try {
      insertAgent(db, 'Agent "One `', 'codex');
      insertTask(db, 'task-with-hyphens', 'active', 'Agent "One `', 1, 5);
      const mermaid = buildBoardMermaid(db, 'default', { now: NOW });
      const agentLine = mermaid.split('\n').find(line => line.startsWith('agent0('));
      const taskLine = mermaid.split('\n').find(line => line.startsWith('task0['));
      assert.strictEqual(agentLine, 'agent0("Agent #quot;One #96;<br/>codex"):::hostCodex');
      assert.ok(taskLine?.startsWith('task0["task-with-hyphens<br/>[active] · no ckpt"]:::stActive'));
      assert.strictEqual((agentLine?.match(/"/g) ?? []).length, 2, 'only the label delimiters remain as quotes');
      assert.doesNotMatch(mermaid, /^Agent/m);
      assert.doesNotMatch(mermaid, /^task-with-hyphens/m);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('HTML preserves raw Mermaid, uses the offline classic asset, and has no external URLs', () => {
    const mermaid = 'flowchart LR\nagent0("Alice<br/>codex"):::hostCodex';
    const html = buildBoardHtml(mermaid, { watchSeconds: 9 });
    assert.ok(html.includes(`<pre class="mermaid">${mermaid}</pre>`));
    assert.match(html, /<script src="\.\/board-assets\/mermaid\.min\.js"><\/script>/);
    assert.doesNotMatch(html, /https?:\/\//);
    assert.doesNotMatch(html, /type="module"/);
    assert.match(html, /mermaid\.initialize\(\{ startOnLoad: true, theme:/);
    assert.match(html, /Mermaid unavailable; leaving raw diagram source visible\./);
    assert.match(html, /<meta http-equiv="refresh" content="9">/);
    assert.match(html, /prefers-color-scheme: dark/);
  });

  test('graph writer copies the vendored Mermaid asset and skips an unchanged re-copy', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-board-assets-'));
    const outputPath = path.join(root, 'output', 'board.html');
    // The page references ./board-assets/ relative to itself, so the asset must
    // land beside the HTML — including under a custom --out directory.
    const assetPath = path.join(root, 'output', 'board-assets', 'mermaid.min.js');
    try {
      writeBoardGraphFile(outputPath, 'flowchart LR\na --> b');
      assert.deepStrictEqual(fs.readFileSync(assetPath), fs.readFileSync(VENDORED_MERMAID));
      const fixedTime = new Date('2020-01-02T03:04:05.000Z');
      fs.utimesSync(assetPath, fixedTime, fixedTime);
      const before = fs.statSync(assetPath).mtimeMs;
      writeBoardGraphFile(outputPath, 'flowchart LR\na --> c');
      assert.strictEqual(fs.statSync(assetPath).mtimeMs, before);
      const html = fs.readFileSync(outputPath, 'utf-8');
      assert.match(html, /\.\/board-assets\/mermaid\.min\.js/);
      assert.doesNotMatch(html, /https?:\/\//);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('graph watch regenerates twice without mutating the database', async () => {
    const fixture = createFixture(true);
    const outputPath = path.join(fixture.root, 'output', 'board.html');
    try {
      const beforeDb = databaseSnapshot(fixture.db);
      fixture.db.exec('PRAGMA query_only = ON');
      let clock = NOW;
      const waits: number[] = [];
      const count = await watchBoardGraph({
        intervalMs: 3,
        regenerate: () => {
          const mermaid = buildBoardMermaid(fixture.db, 'default', { now: clock });
          clock += 60_000;
          writeBoardGraphFile(outputPath, mermaid, { watchSeconds: 3 });
        },
        wait: async milliseconds => { waits.push(milliseconds); },
        shouldContinue: renders => renders < 2,
      });
      assert.strictEqual(count, 2);
      assert.deepStrictEqual(waits, [3]);
      assert.match(fs.readFileSync(outputPath, 'utf-8'), /2026-07-18T18:01:00\.000Z/);
      assert.strictEqual(databaseSnapshot(fixture.db), beforeDb);
    } finally {
      fixture.db.close();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('graph tab falls back to the system browser when cmux is unavailable', () => {
    const opened: string[] = [];
    const errors: string[] = [];
    const result = openBoardGraphTab('/tmp/swarm graph.html', {
      spawn: () => { throw new Error('no cmux'); },
      open: filePath => { opened.push(filePath); return true; },
      writeError: value => { errors.push(value); },
    });
    assert.strictEqual(result, null);
    assert.deepStrictEqual(opened, ['/tmp/swarm graph.html']);
    assert.deepStrictEqual(errors, ['cmux browser unavailable; opened the graph with the system browser instead.']);
  });

  test('graph tab passes an encoded file URL and the required workspace title to cmux', () => {
    let invocation: { cwd: string; url: string; title: string } | null = null;
    const result = openBoardGraphTab('/tmp/swarm graph.html', {
      cwd: '/tmp/project',
      spawn: (cwd, url, title) => {
        invocation = { cwd, url, title };
        return { workspaceRef: 'workspace:3', surfaceRef: 'surface:4' };
      },
      open: () => { throw new Error('fallback should not run'); },
    });
    assert.deepStrictEqual(invocation, {
      cwd: '/tmp/project',
      url: 'file:///tmp/swarm%20graph.html',
      title: 'swarm graph',
    });
    assert.deepStrictEqual(result, { workspaceRef: 'workspace:3', surfaceRef: 'surface:4' });
  });

  test('CLI writes HTML, prints raw Mermaid to stdout and the path to stderr without DB writes', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-board-graph-cli-'));
    const swarmDir = path.join(home, '.swarm');
    const dbPath = path.join(swarmDir, 'swarm.db');
    fs.mkdirSync(swarmDir);
    const db = getDbAt(dbPath);
    insertAgent(db, 'Alice', 'codex');
    db.close();
    const beforeDb = fs.readFileSync(dbPath).toString('base64');
    const outputPath = path.join(home, 'rendered', 'board.html');
    const stderrPath = path.join(home, 'board.stderr');
    try {
      const stderrFd = fs.openSync(stderrPath, 'w');
      let result: string;
      try {
        result = execFileSync(
          'node',
          ['--import', 'tsx', INDEX, 'board', '--graph', '--out', outputPath],
          {
            encoding: 'utf-8',
            env: {
              ...process.env,
              HOME: home,
              SWARM_ID: 'default',
              SWARM_NAME: '',
              SWARM_AGENT_NAME: '',
              CMUX_SURFACE_ID: '',
            },
            stdio: ['ignore', 'pipe', stderrFd],
          }
        );
      } finally {
        fs.closeSync(stderrFd);
      }
      const mermaid = result.trimEnd();
      const html = fs.readFileSync(outputPath, 'utf-8');
      assert.match(mermaid, /^flowchart LR$/m);
      assert.ok(html.includes(`<pre class="mermaid">${mermaid}</pre>`));
      assert.ok(fs.existsSync(path.join(path.dirname(outputPath), 'board-assets', 'mermaid.min.js')));
      assert.doesNotMatch(html, /https?:\/\//);
      assert.strictEqual(fs.readFileSync(stderrPath, 'utf-8').trim(), path.resolve(outputPath));
      assert.strictEqual(fs.readFileSync(dbPath).toString('base64'), beforeDb);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
