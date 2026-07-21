import { describe, test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'child_process';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { collectBoardData } from '../src/board-data.js';
import { getDbAt } from '../src/db.js';

const NOW = Date.parse('2026-07-18T18:00:00.000Z');

function iso(minutesAgo: number): string {
  return new Date(NOW - minutesAgo * 60_000).toISOString();
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

function checkpointFile(root: string, name: string, quota: boolean = false): string {
  const filePath = path.join(root, `${name}.md`);
  const quotaSection = quota ? '\n## quota\n- codex: green\n- claude: yellow\n' : '';
  fs.writeFileSync(
    filePath,
    `# ${name}\n\n## next action\nShip it.\n${quotaSection}`
  );
  return filePath;
}

function insertAgent(
  db: Database.Database,
  name: string,
  agentType: string,
  host: string | null,
  surface: string
): void {
  db.prepare(`
    INSERT INTO agents (
      id, swarm_id, name, description, surface_id, workspace_id, ppid,
      joined_at, last_heartbeat, agent_type, endpoint_url, host_agent
    ) VALUES (?, 'default', ?, NULL, ?, NULL, 1, ?, ?, ?, NULL, ?)
  `).run(`agent-${name}`, name, surface, iso(180), iso(1), agentType, host);
}

function insertTask(
  db: Database.Database,
  id: string,
  state: string,
  owner: string | null,
  epoch: number,
  ageMin: number,
  gitFacts: { repoPath: string; branch: string; worktreePath: string } | null = null
): void {
  db.prepare(`
    INSERT INTO tasks (
      id, swarm_id, title, state, owner_agent, lease_epoch, lease_expires_at,
      repo_path, branch, worktree_path, transcript_hint, disposition, created_at, updated_at
    ) VALUES (?, 'default', ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, ?, ?)
  `).run(
    id,
    `${id} title`,
    state,
    owner,
    epoch,
    gitFacts?.repoPath ?? null,
    gitFacts?.branch ?? null,
    gitFacts?.worktreePath ?? null,
    iso(ageMin),
    iso(ageMin)
  );
}

function insertEvent(
  db: Database.Database,
  taskId: string,
  epoch: number,
  kind: string,
  actor: string | null,
  ageMin: number,
  data: unknown = null
): void {
  db.prepare(`
    INSERT INTO task_events (swarm_id, task_id, epoch, kind, actor, data, created_at)
    VALUES ('default', ?, ?, ?, ?, ?, ?)
  `).run(
    taskId,
    epoch,
    kind,
    actor,
    data === null ? null : JSON.stringify(data),
    iso(ageMin)
  );
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

function createFixture(): { root: string; db: Database.Database; gateId: number; checkpointPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-board-data-'));
  const db = getDbAt(path.join(root, 'swarm.db'));
  db.prepare("UPDATE swarms SET name = 'Ridge Fleet' WHERE id = 'default'").run();
  insertAgent(db, 'Alice', 'cmux', 'codex', 'surface-alice');
  insertAgent(db, 'Bob', 'headless', null, '');

  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'board@example.com']);
  git(repo, ['config', 'user.name', 'Board Test']);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base\n');
  git(repo, ['add', 'tracked.txt']);
  git(repo, ['commit', '-m', 'base']);
  const branch = git(repo, ['branch', '--show-current']);
  fs.appendFileSync(path.join(repo, 'tracked.txt'), 'dirty\n');
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new\n');

  insertTask(db, 'review-task', 'awaiting_review', 'Bob', 1, 20);
  insertTask(db, 'stale-task', 'active', 'Bob', 2, 120);
  insertTask(db, 'fresh-task', 'active', 'alice', 3, 10, {
    repoPath: repo,
    branch,
    worktreePath: repo,
  });
  insertTask(db, 'open-task', 'open', null, 0, 8);
  insertTask(db, 'program-capacity', 'active', 'Alice', 4, 30);
  insertTask(db, 'recent-done', 'done', 'Alice', 5, 30);
  insertTask(db, 'old-done', 'done', 'Bob', 6, 25 * 60);
  db.prepare("UPDATE tasks SET claim_kind = 'decision' WHERE id = 'recent-done'").run();

  const stalePath = checkpointFile(root, 'stale');
  const checkpointPath = checkpointFile(root, 'fresh');
  const quotaPath = checkpointFile(root, 'quota', true);
  insertEvent(db, 'stale-task', 2, 'checkpoint', 'Bob', 91, { path: stalePath, sequence: 1 });
  insertEvent(db, 'fresh-task', 3, 'checkpoint', 'Alice', 5, { path: checkpointPath, sequence: 7 });
  insertEvent(db, 'program-capacity', 4, 'checkpoint', 'Alice', 6, { path: quotaPath, sequence: 2 });
  insertEvent(db, 'stale-task', 3, 'handoff', 'Alice', 4, { to: 'Bob', brief_path: '/tmp/brief' });
  insertEvent(db, 'stale-task', 4, 'claimed', 'Bob', 3, { previous_owner: 'Alice' });
  insertEvent(db, 'recent-done', 5, 'close_evidence', 'Alice', 2, {
    kind: 'decision', ref: '42', verified: true,
  });
  insertEvent(db, 'recent-done', 5, 'gate_override', 'Alice', 2, {
    reason: 'operator-approved exception', bypassed_gates: ['evidence-required'],
  });
  insertEvent(db, 'recent-done', 5, 'closed', 'Alice', 2, {
    disposition: 'archive', claim_kind: 'decision', not_established: 'runtime behavior',
  });

  const gate = db.prepare(`
    INSERT INTO messages (
      swarm_id, from_agent, to_agent, body, delivered, created_at, kind, superseded_by
    ) VALUES ('default', 'Bob', 'Alice', ?, 1, ?, 'gate', NULL)
  `).run('approve\nthis release', iso(20));
  const gateId = Number(gate.lastInsertRowid);
  db.prepare(`
    INSERT INTO message_deliveries (
      message_id, swarm_id, recipient, status, first_injected_at, inject_count, acked_at
    ) VALUES (?, 'default', 'alice', 'delivered', ?, 1, NULL)
  `).run(gateId, iso(15));

  const acknowledged = db.prepare(`
    INSERT INTO messages (
      swarm_id, from_agent, to_agent, body, delivered, created_at, kind, superseded_by
    ) VALUES ('default', 'Lead', 'Alice', 'done', 1, ?, 'status', NULL)
  `).run(iso(3));
  db.prepare(`
    INSERT INTO message_deliveries (
      message_id, swarm_id, recipient, status, first_injected_at, inject_count, acked_at
    ) VALUES (?, 'default', 'Alice', 'acked', ?, 1, ?)
  `).run(Number(acknowledged.lastInsertRowid), iso(3), iso(2));

  db.prepare(`
    INSERT INTO janitor_status (id, last_tick_at, last_duration_ms, counters)
    VALUES (1, ?, 12, ?)
  `).run(iso(31), JSON.stringify({
    worktrees: 4,
    detachedHeads: 1,
    orphanedWorktrees: 2,
    unpushedCommits: 7,
    goneUpstreamBranches: 3,
    tempStrays: 2,
    junkDirs: 1,
    reposScanned: 5,
    tickMs: 12,
  }));
  db.prepare(`
    INSERT INTO janitor_findings (
      first_seen_at, last_seen_at, kind, path, detail, state
    ) VALUES (?, ?, 'unpushed-commits', ?, ?, 'hold')
  `).run(iso(60), iso(31), repo, JSON.stringify({ count: 2, note: 'held' }));

  for (let index = 0; index < 52; index += 1) {
    db.prepare(`
      INSERT INTO janitor_snapshots (tick_at, counters)
      VALUES (?, ?)
    `).run(iso(52 - index), JSON.stringify({
      unpushedCommits: index,
      orphanedWorktrees: index % 3,
      tickMs: index + 1,
    }));
  }

  for (let index = 0; index < 205; index += 1) {
    insertEvent(
      db,
      'open-task',
      0,
      'note',
      null,
      204 - index,
      { note: `event ${index}\ncontinued` }
    );
  }

  return { root, db, gateId, checkpointPath };
}

describe('V1-A shared board data projection', () => {
  test('projects every BoardData field family from one populated read-only fixture', () => {
    const fixture = createFixture();
    try {
      const before = databaseSnapshot(fixture.db);
      fixture.db.pragma('query_only = ON');
      const data = collectBoardData(fixture.db, 'default', { now: NOW });

      assert.strictEqual(data.generatedAt, '2026-07-18T18:00:00.000Z');
      assert.deepStrictEqual(data.swarm, { id: 'default', name: 'Ridge Fleet' });
      assert.deepStrictEqual(data.unavailable, []);

      assert.strictEqual(data.agents.length, 2);
      assert.deepStrictEqual(data.agents[0], {
        name: 'Alice',
        agentType: 'cmux',
        host: 'codex',
        joinedAt: iso(180),
        lastHeartbeat: iso(1),
        surfaceKnown: true,
        currentTaskId: 'fresh-task',
        progressEvidenceAt: iso(2),
        unackedCount: 1,
        unackedMaxAgeMin: 15,
      });
      assert.strictEqual(data.agents[1].host, 'headless');
      assert.strictEqual(data.agents[1].surfaceKnown, false);
      assert.strictEqual(data.agents[1].currentTaskId, 'stale-task');
      assert.strictEqual(data.agents[1].progressEvidenceAt, iso(3));
      assert.strictEqual(data.agents[1].unackedCount, 0);
      assert.strictEqual(data.agents[1].unackedMaxAgeMin, null);

      assert.ok(data.tasks.some(task => task.id === 'recent-done'));
      assert.ok(!data.tasks.some(task => task.id === 'old-done'));
      const fresh = data.tasks.find(task => task.id === 'fresh-task');
      assert.ok(fresh);
      assert.deepStrictEqual(fresh.checkpoint, {
        seq: 7,
        ageMin: 5,
        nextAction: 'Ship it.',
        path: fixture.checkpointPath,
      });
      assert.strictEqual(fresh.title, 'fresh-task title');
      assert.strictEqual(fresh.owner, 'alice');
      assert.strictEqual(fresh.leaseEpoch, 3);
      assert.strictEqual(fresh.repoPath, path.join(fixture.root, 'repo'));
      assert.strictEqual(fresh.worktreePath, path.join(fixture.root, 'repo'));
      assert.strictEqual(fresh.createdAt, iso(10));
      assert.strictEqual(fresh.stale, false);
      assert.deepStrictEqual(fresh.git, { dirty: true, untracked: 1, unpushed: 1 });
      const stale = data.tasks.find(task => task.id === 'stale-task');
      assert.ok(stale?.stale);
      assert.strictEqual(stale.checkpoint?.ageMin, 91);
      assert.strictEqual(data.tasks.find(task => task.id === 'review-task')?.checkpoint, null);
      assert.strictEqual(fresh.claimKind, 'code-merged', 'legacy NULL claims project as code-merged');
      assert.deepStrictEqual(fresh.evidence, []);
      assert.strictEqual(fresh.notEstablished, null);
      assert.deepStrictEqual(fresh.overrides, []);
      const recentDone = data.tasks.find(task => task.id === 'recent-done');
      assert.ok(recentDone);
      assert.strictEqual(recentDone.claimKind, 'decision');
      assert.deepStrictEqual(recentDone.evidence, [{ kind: 'decision', ref: '42', verified: true }]);
      assert.strictEqual(recentDone.notEstablished, 'runtime behavior');
      assert.deepStrictEqual(recentDone.overrides, [{
        eventId: recentDone.overrides[0].eventId,
        reason: 'operator-approved exception',
        bypassedGates: ['evidence-required'],
        actor: 'Alice',
        at: iso(2),
      }]);

      assert.ok(data.edges.ownership.some(edge => edge.agent === 'alice' && edge.taskId === 'fresh-task'));
      assert.deepStrictEqual(data.edges.handoffs, [{
        from: 'Alice',
        to: 'Bob',
        taskId: 'stale-task',
        at: iso(4),
      }]);
      assert.deepStrictEqual(data.edges.claims, [{
        from: 'Alice',
        to: 'Bob',
        taskId: 'stale-task',
        at: iso(3),
      }]);

      assert.deepStrictEqual(data.needsYou.map(item => item.kind), [
        'gate', 'awaiting_review', 'stalled', 'janitor_stale',
      ]);
      assert.deepStrictEqual(data.needsYou.map(item => item.refId), [
        String(fixture.gateId), 'review-task', 'stale-task', 'janitor',
      ]);
      assert.match(data.needsYou[0].label, /approve this release/);
      assert.strictEqual(data.needsYou[2].label, 'task stale-task stalled \u2014 checkpoint 91m ago');

      assert.strictEqual(data.debris.tickAgeMin, 31);
      assert.deepStrictEqual(data.debris.counters, {
        worktrees: 4,
        detachedHeads: 1,
        orphanedWorktrees: 2,
        unpushedCommits: 7,
        goneUpstreamBranches: 3,
        tempStrays: 2,
        junkDirs: 1,
        reposScanned: 5,
        tickMs: 12,
      });
      assert.deepStrictEqual(data.debris.findings, [{
        kind: 'unpushed-commits',
        path: path.join(fixture.root, 'repo'),
        state: 'hold',
        firstSeenAt: iso(60),
        lastSeenAt: iso(31),
        detail: { count: 2, note: 'held' },
      }]);
      assert.strictEqual(data.debrisTrend?.length, 50);
      assert.deepStrictEqual(data.debrisTrend?.[0], {
        tickAt: iso(50),
        counters: {
          worktrees: 0,
          detachedHeads: 0,
          orphanedWorktrees: 2,
          unpushedCommits: 2,
          goneUpstreamBranches: 0,
          tempStrays: 0,
          junkDirs: 0,
          reposScanned: 0,
          tickMs: 3,
        },
      });
      assert.strictEqual(data.debrisTrend?.at(-1)?.tickAt, iso(1));
      assert.strictEqual(data.debrisTrend?.at(-1)?.counters.unpushedCommits, 51);
      assert.strictEqual(data.quota, 'codex: green | claude: yellow');

      assert.strictEqual(data.timeline.length, 200);
      assert.deepStrictEqual(data.timeline[0], {
        taskId: 'open-task',
        epoch: 0,
        kind: 'note',
        actor: null,
        at: iso(199),
        summary: 'note=event 5 continued',
      });
      assert.strictEqual(data.timeline.at(-1)?.at, iso(0));
      assert.strictEqual(data.timeline.at(-1)?.summary, 'note=event 204 continued');
      assert.ok(data.timeline.every(event => !/[\r\n]/.test(event.summary)));
      assert.strictEqual(databaseSnapshot(fixture.db), before);
    } finally {
      fixture.db.close();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('missing tables yield a useful partial projection and unavailable names, never a throw', () => {
    const fixture = createFixture();
    try {
      fixture.db.exec(`
        DROP TABLE task_events;
        DROP TABLE message_deliveries;
        DROP TABLE janitor_findings;
        DROP TABLE janitor_snapshots;
      `);
      const data = collectBoardData(fixture.db, 'default', { now: NOW });
      assert.deepStrictEqual(data.unavailable, [
        'message_deliveries', 'task_events', 'janitor_findings', 'janitor_snapshots',
      ]);
      assert.strictEqual(data.swarm.name, 'Ridge Fleet');
      assert.strictEqual(data.agents.length, 2);
      assert.ok(data.tasks.length > 0);
      assert.ok(data.tasks.every(task => task.checkpoint === null));
      assert.ok(data.edges.ownership.length > 0);
      assert.deepStrictEqual(data.edges.handoffs, []);
      assert.deepStrictEqual(data.edges.claims, []);
      assert.deepStrictEqual(data.timeline, []);
      assert.deepStrictEqual(data.debris.findings, []);
      assert.ok(!Object.hasOwn(data, 'debrisTrend'));
      assert.strictEqual(data.debris.tickAgeMin, 31);
      assert.strictEqual(data.quota, null);
    } finally {
      fixture.db.close();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }

    const empty = new Database(':memory:');
    try {
      const data = collectBoardData(empty, 'legacy', { now: NOW });
      assert.deepStrictEqual(data.unavailable, [
        'swarms', 'agents', 'messages', 'message_deliveries', 'tasks',
        'task_events', 'janitor_status', 'janitor_findings', 'janitor_snapshots',
      ]);
      assert.deepStrictEqual(data.swarm, { id: 'legacy', name: 'legacy' });
      assert.deepStrictEqual(data.agents, []);
      assert.deepStrictEqual(data.tasks, []);
      assert.deepStrictEqual(data.timeline, []);
      assert.ok(!Object.hasOwn(data, 'debrisTrend'));
    } finally {
      empty.close();
    }
  });
});
