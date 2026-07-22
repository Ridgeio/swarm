import { describe, test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';
import { collectBoardData } from '../src/board-data.js';
import { getDbAt, type SwarmDb } from '../src/db.js';
import { escalateTask } from '../src/escalations.js';
import {
  createGrant,
  findLiveGrant,
  grantResourceMatches,
  listGrants,
  parseGrantTtl,
  revokeGrant,
} from '../src/grants.js';
import {
  getAuthenticatedSelf,
  joinA2AAgent,
  joinHeadlessAgent,
} from '../src/registry.js';
import { closeTask, startTask } from '../src/tasks.js';

const INDEX = path.resolve(fileURLToPath(new URL('../src/index.ts', import.meta.url)));
const TSX_IMPORT = import.meta.resolve('tsx');
const NOW = Date.parse('2026-07-20T18:00:00.000Z');

interface CliResult { stdout: string; stderr: string; status: number }

function tempDb(prefix: string): { root: string; db: SwarmDb } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { root, db: getDbAt(path.join(root, 'swarm.db')) };
}

function runCli(home: string, args: string[], env: Record<string, string> = {}): CliResult {
  const childEnv: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    TMPDIR: path.join(home, 'tmp'),
    SWARM_ID: '',
    SWARM_NAME: '',
    SWARM_AGENT_NAME: '',
    SWARM_SESSION_TOKEN: '',
    CMUX_SURFACE_ID: '',
    CMUX_WORKSPACE_ID: '',
    TERM_PROGRAM: '',
    CODEX_CLI: '',
    CODEX_CI: '',
    CODEX_THREAD_ID: '',
    CODEX_MANAGED_BY_NPM: '',
    CLAUDE_CODE: '',
    GROK_AGENT: '',
    SWARM_TEST_DISABLE_BACKGROUND: '1',
    ...env,
  };
  fs.mkdirSync(childEnv.TMPDIR, { recursive: true });
  try {
    const stdout = execFileSync('node', ['--import', TSX_IMPORT, INDEX, ...args], {
      encoding: 'utf-8',
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', status: 0 };
  } catch (error: any) {
    return {
      stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? '',
      status: typeof error.status === 'number' ? error.status : 1,
    };
  }
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('T2.1 typed grants', () => {
  test('CRUD, TTL parsing, expiry, revoke, recipient scope, and custom ops', () => {
    const fixture = tempDb('swarm-t2-grants-');
    try {
      joinHeadlessAgent(fixture.db, 'default', 'Alice');
      joinHeadlessAgent(fixture.db, 'default', 'Bob');
      assert.strictEqual(parseGrantTtl('30m'), 30 * 60_000);
      assert.strictEqual(parseGrantTtl('2h'), 2 * 60 * 60_000);
      assert.strictEqual(parseGrantTtl('1d'), 24 * 60 * 60_000);
      for (const invalid of ['0m', '30', '2H', '1w', '-1h']) {
        assert.throws(() => parseGrantTtl(invalid), /Invalid --ttl/);
      }

      const grant = createGrant(fixture.db, 'default', 'Lead', {
        op: 'custom:release-window',
        resource: 'service/api',
        ttl: '30m',
        grantedTo: 'alice',
        note: 'bounded approval',
        now: NOW,
      });
      assert.strictEqual(grant.id, 1);
      assert.strictEqual(grant.granted_to, 'Alice');
      assert.strictEqual(grant.granted_by, 'Lead');
      assert.strictEqual(grant.note, 'bounded approval');
      assert.strictEqual(grant.expires_at, new Date(NOW + 30 * 60_000).toISOString());
      assert.deepStrictEqual(listGrants(fixture.db, 'default').map(row => row.id), [1]);
      assert.deepStrictEqual(listGrants(fixture.db, 'default', true, NOW).map(row => row.id), [1]);
      assert.deepStrictEqual(listGrants(fixture.db, 'default', true, NOW + 30 * 60_000), []);
      assert.ok(findLiveGrant(fixture.db, 'default', {
        op: 'custom:release-window', resources: ['service/api'], actor: 'ALICE', now: NOW,
      }));
      assert.strictEqual(findLiveGrant(fixture.db, 'default', {
        op: 'custom:release-window', resources: ['service/api'], actor: 'Bob', now: NOW,
      }), null);

      const revoked = revokeGrant(fixture.db, 'default', grant.id, NOW + 1_000);
      assert.strictEqual(revoked?.revoked_at, new Date(NOW + 1_000).toISOString());
      assert.deepStrictEqual(listGrants(fixture.db, 'default', true, NOW + 2_000), []);
      assert.strictEqual(revokeGrant(fixture.db, 'default', 999), null);
    } finally {
      fixture.db.close();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('resource matching follows the exact/star/trailing-prefix table', () => {
    const cases: Array<[string, string, boolean]> = [
      ['task-one', 'task-one', true],
      ['task-one', 'Task-One', false],
      ['task-one', 'task-one-more', false],
      ['*', 'anything/at/all', true],
      ['swarm/Foreman/*', 'swarm/Foreman/task-one', true],
      ['swarm/Foreman/*', 'swarm/Foreman/', true],
      ['swarm/Foreman/*', 'swarm/Other/task-one', false],
      ['prefix*', 'prefix-and-more', true],
      ['prefix*', 'pre', false],
    ];
    for (const [grant, requested, expected] of cases) {
      assert.strictEqual(grantResourceMatches(grant, requested), expected, `${grant} -> ${requested}`);
    }
  });

  test('grant create/list --live/revoke are wired through the CLI', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-t2-grant-cli-'));
    try {
      const joined = runCli(home, ['join', 'Alice', '--headless'], { SWARM_AGENT_NAME: 'Alice' });
      assert.strictEqual(joined.status, 0, joined.stderr || joined.stdout);
      const db = new DatabaseSync(path.join(home, '.swarm', 'swarm.db'));
      const identity = db.prepare("SELECT session_token FROM agents WHERE name = 'Alice'")
        .get() as { session_token: string };
      db.close();
      const auth = { SWARM_AGENT_NAME: 'Alice', SWARM_SESSION_TOKEN: identity.session_token };
      const created = runCli(home, [
        'grant', 'create', '--op', 'merge', '--resource', 'cli-grant', '--ttl', '2h',
        '--to', 'Alice', '--note', 'CLI fixture',
      ], auth);
      assert.strictEqual(created.status, 0, created.stderr || created.stdout);
      assert.match(created.stdout, /^Grant #1 created; expires /);
      const listed = runCli(home, ['grant', 'list', '--live']);
      assert.strictEqual(listed.status, 0, listed.stderr || listed.stdout);
      assert.match(listed.stdout, /#1 merge cli-grant -> Alice; by Alice; expires .*; note CLI fixture/);
      const revoked = runCli(home, ['grant', 'revoke', '1']);
      assert.strictEqual(revoked.status, 0, revoked.stderr || revoked.stdout);
      assert.match(revoked.stdout, /Grant #1 revoked at/);
      const empty = runCli(home, ['grant', 'list', '--live']);
      assert.strictEqual(empty.stdout, 'No live grants.\n');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('T2.2 close chokepoints', () => {
  test('merged code claim routes authorization through escalation and an operator remedy, then records grant use', async () => {
    const fixture = tempDb('swarm-t2-merge-');
    try {
      joinHeadlessAgent(fixture.db, 'default', 'Alice');
      await startTask(fixture.db, 'default', 'Alice', 'merge-gated', {
        title: 'Merge gated', noWorktree: true, claimKind: 'code-merged',
      });
      await assert.rejects(
        closeTask(fixture.db, 'default', 'Alice', 'merge-gated', {
          disposition: 'merged', notEstablished: 'none',
        }),
        (error: any) => {
          assert.match(error.message, /Request authorization: swarm escalate merge-gated --question "<one line>"/);
          assert.match(error.message, /Operator remedy: swarm grant create --op merge --resource merge-gated --ttl 2h/);
          return true;
        }
      );
      const grant = createGrant(fixture.db, 'default', 'Lead', {
        op: 'merge', resource: 'merge-gated', ttl: '2h', grantedTo: 'Alice',
      });
      const closed = await closeTask(fixture.db, 'default', 'Alice', 'merge-gated', {
        disposition: 'merged', notEstablished: 'none',
      });
      assert.strictEqual(closed.state, 'done');
      const used = fixture.db.prepare(`
        SELECT data FROM task_events WHERE task_id = 'merge-gated' AND kind = 'grant_used'
      `).get() as { data: string };
      assert.deepStrictEqual(JSON.parse(used.data), {
        grant_id: grant.id, op: 'merge', resource: 'merge-gated', actor: 'Alice',
      });

      await startTask(fixture.db, 'default', 'Alice', 'branch-gated', {
        title: 'Branch gated', noWorktree: true, claimKind: 'code-merged',
      });
      fixture.db.prepare("UPDATE tasks SET branch = 'swarm/Alice/branch-gated' WHERE id = 'branch-gated'").run();
      const branchGrant = createGrant(fixture.db, 'default', 'Lead', {
        op: 'merge', resource: 'swarm/Alice/branch-gated', ttl: '2h', grantedTo: 'Alice',
      });
      const branchClosed = await closeTask(fixture.db, 'default', 'Alice', 'branch-gated', {
        disposition: 'merged', notEstablished: 'none',
      });
      assert.strictEqual(branchClosed.state, 'done');
      const branchUse = fixture.db.prepare(`
        SELECT data FROM task_events WHERE task_id = 'branch-gated' AND kind = 'grant_used'
      `).get() as { data: string };
      assert.strictEqual(JSON.parse(branchUse.data).grant_id, branchGrant.id);
    } finally {
      fixture.db.close();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('override requires both a reason and a live slug-matching override grant', async () => {
    const fixture = tempDb('swarm-t2-override-');
    try {
      await startTask(fixture.db, 'default', 'Alice', 'override-gated', {
        title: 'Override gated', noWorktree: true, claimKind: 'analysis',
      });
      await assert.rejects(
        closeTask(fixture.db, 'default', 'Alice', 'override-gated', {
          disposition: 'archive', override: true, notEstablished: 'runtime behavior',
        }),
        /--override.*requires --reason/s
      );
      await assert.rejects(
        closeTask(fixture.db, 'default', 'Alice', 'override-gated', {
          disposition: 'archive', override: true, reason: 'approved exception',
          notEstablished: 'runtime behavior',
        }),
        (error: any) => {
          assert.match(error.message, /Request authorization: swarm escalate override-gated --question "<one line>"/);
          assert.match(error.message, /Operator remedy: swarm grant create --op override --resource override-gated --ttl 2h/);
          return true;
        }
      );
      const grant = createGrant(fixture.db, 'default', 'Lead', {
        op: 'override', resource: 'override-gated', ttl: '2h',
      });
      const closed = await closeTask(fixture.db, 'default', 'Alice', 'override-gated', {
        disposition: 'archive', override: true, reason: 'approved exception',
        notEstablished: 'runtime behavior',
      });
      assert.strictEqual(closed.state, 'done');
      const events = fixture.db.prepare(`
        SELECT kind, data FROM task_events
        WHERE task_id = 'override-gated' AND kind IN ('grant_used', 'gate_override')
        ORDER BY id ASC
      `).all() as Array<{ kind: string; data: string }>;
      assert.deepStrictEqual(events.map(event => event.kind), ['grant_used', 'gate_override']);
      assert.strictEqual(JSON.parse(events[0].data).grant_id, grant.id);
      assert.strictEqual(JSON.parse(events[1].data).reason, 'approved exception');
    } finally {
      fixture.db.close();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

describe('T2.3 escalation packets', () => {
  test('builds a populated packet, sends only its path, and moves the task to awaiting_review', async () => {
    const fixture = tempDb('swarm-t2-escalate-');
    try {
      const lead = joinHeadlessAgent(fixture.db, 'default', 'Lead');
      joinHeadlessAgent(fixture.db, 'default', 'Worker');
      fixture.db.prepare('UPDATE agents SET joined_at = ? WHERE id = ?')
        .run(new Date(0).toISOString(), lead.id);
      await startTask(fixture.db, 'default', 'Worker', 'decision-ready', {
        title: 'Decision ready', noWorktree: true, claimKind: 'analysis',
      });
      const checkpointPath = path.join(fixture.root, 'checkpoint.md');
      const checkpoint = `# checkpoint decision-ready #001
## decisions (+why, +rejected alternatives)
Use the bounded path.
## failed approaches (do-not-repeat)
- none noted
## next action
Wait for operator direction.
## blockers / landmines
May we accept the remaining rollout risk?
`;
      fs.writeFileSync(checkpointPath, checkpoint);
      const reportPath = path.join(fixture.root, 'report.md');
      fs.writeFileSync(reportPath, 'measured result\n');
      fixture.db.prepare(`
        INSERT INTO task_events (swarm_id, task_id, epoch, kind, actor, data, created_at)
        VALUES ('default', 'decision-ready', 1, 'checkpoint', 'Worker', ?, ?),
               ('default', 'decision-ready', 1, 'close_evidence', 'Worker', ?, ?),
               ('default', 'decision-ready', 1, 'run', 'Worker', ?, ?)
      `).run(
        JSON.stringify({ path: checkpointPath, sequence: 1 }), new Date(NOW - 3_000).toISOString(),
        JSON.stringify({ kind: 'report', ref: reportPath, verified: true }), new Date(NOW - 2_000).toISOString(),
        JSON.stringify({ logPath: '/tmp/run-001.log', exit: 0 }), new Date(NOW - 1_000).toISOString()
      );

      const result = await escalateTask(fixture.db, 'default', 'Worker', 'decision-ready', {
        now: new Date(NOW), homeDir: fixture.root,
      });
      assert.strictEqual(result.recipient, 'Lead');
      assert.strictEqual(result.question, 'May we accept the remaining rollout risk?');
      assert.strictEqual(
        result.briefPath,
        path.join(fixture.root, '.swarm', 'briefs', 'escalations', 'decision-ready--20260720-1800.md')
      );
      const packet = fs.readFileSync(result.briefPath, 'utf-8');
      assert.match(packet, /- state: active\n- owner: Worker\n- lease epoch: 1/);
      assert.ok(packet.includes(checkpoint), 'latest checkpoint must appear verbatim');
      assert.match(packet, new RegExp(`report:${reportPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(packet, /run \/tmp\/run-001\.log \[exit: 0\]/);
      assert.match(packet, /## git facts[\s\S]*- repo: none/);
      assert.match(packet, /## recent events[\s\S]*checkpoint by Worker/);
      assert.match(packet, /Risk: no repository is attached/);
      assert.match(packet, /## THE question\nMay we accept the remaining rollout risk\?/);

      const message = fixture.db.prepare(`
        SELECT body, kind, to_agent FROM messages WHERE id = ?
      `).get(result.messageId) as { body: string; kind: string; to_agent: string };
      assert.deepStrictEqual({ ...message }, {
        body: result.briefPath, kind: 'escalation', to_agent: 'Lead',
      });
      const task = fixture.db.prepare("SELECT state FROM tasks WHERE id = 'decision-ready'")
        .get() as { state: string };
      assert.strictEqual(task.state, 'awaiting_review');
      const event = fixture.db.prepare(`
        SELECT data FROM task_events WHERE task_id = 'decision-ready' AND kind = 'escalated'
      `).get() as { data: string };
      assert.strictEqual(JSON.parse(event.data).brief_path, result.briefPath);
    } finally {
      fixture.db.close();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('refuses an escalation without an explicit or checkpoint-derived question', async () => {
    const fixture = tempDb('swarm-t2-no-question-');
    try {
      joinHeadlessAgent(fixture.db, 'default', 'Worker');
      await startTask(fixture.db, 'default', 'Worker', 'questionless', {
        title: 'Questionless', noWorktree: true, claimKind: 'analysis',
      });
      const checkpointPath = path.join(fixture.root, 'checkpoint.md');
      fs.writeFileSync(checkpointPath, '## blockers / landmines\n- none noted\n');
      fixture.db.prepare(`
        INSERT INTO task_events (swarm_id, task_id, epoch, kind, actor, data, created_at)
        VALUES ('default', 'questionless', 1, 'checkpoint', 'Worker', ?, ?)
      `).run(JSON.stringify({ path: checkpointPath, sequence: 1 }), new Date(NOW).toISOString());
      await assert.rejects(
        escalateTask(fixture.db, 'default', 'Worker', 'questionless', {
          now: new Date(NOW), homeDir: fixture.root,
        }),
        /no question was provided.*--question "<text>"/s
      );
      assert.strictEqual(fs.existsSync(path.join(fixture.root, '.swarm', 'briefs', 'escalations')), false);
      assert.strictEqual(
        (fixture.db.prepare("SELECT state FROM tasks WHERE id = 'questionless'").get() as { state: string }).state,
        'active'
      );
    } finally {
      fixture.db.close();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('honors an explicit recipient and falls back to a manual path when no agent is active', async () => {
    const fixture = tempDb('swarm-t2-escalate-routing-');
    try {
      joinHeadlessAgent(fixture.db, 'default', 'Lead');
      joinHeadlessAgent(fixture.db, 'default', 'Reviewer');
      await startTask(fixture.db, 'default', 'Lead', 'explicit-route', {
        title: 'Explicit route', noWorktree: true, claimKind: 'analysis',
      });
      const explicit = await escalateTask(fixture.db, 'default', 'Lead', 'explicit-route', {
        question: 'Should Reviewer approve this?', to: 'Reviewer',
        now: new Date(NOW), homeDir: fixture.root,
      });
      assert.strictEqual(explicit.recipient, 'Reviewer');
      assert.strictEqual(
        (fixture.db.prepare('SELECT to_agent FROM messages WHERE id = ?').get(explicit.messageId) as { to_agent: string }).to_agent,
        'Reviewer'
      );

      const empty = tempDb('swarm-t2-escalate-manual-');
      try {
        await startTask(empty.db, 'default', 'Ghost', 'manual-route', {
          title: 'Manual route', noWorktree: true, claimKind: 'analysis',
        });
        const manual = await escalateTask(empty.db, 'default', 'Ghost', 'manual-route', {
          question: 'Who can make this decision?', now: new Date(NOW), homeDir: empty.root,
        });
        assert.strictEqual(manual.recipient, null);
        assert.strictEqual(manual.messageId, null);
        assert.ok(fs.existsSync(manual.briefPath));
        assert.strictEqual(
          (empty.db.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count,
          0
        );
      } finally {
        empty.db.close();
        fs.rmSync(empty.root, { recursive: true, force: true });
      }
    } finally {
      fixture.db.close();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

describe('T2.4 sender authentication', () => {
  test('local joins mint tokens; headless env tokens authenticate; mismatch refuses; NULL legacy and A2A remain compatible', () => {
    const fixture = tempDb('swarm-t2-auth-core-');
    const envSnapshot = {
      SWARM_ID: process.env.SWARM_ID,
      SWARM_NAME: process.env.SWARM_NAME,
      SWARM_AGENT_NAME: process.env.SWARM_AGENT_NAME,
      SWARM_SESSION_TOKEN: process.env.SWARM_SESSION_TOKEN,
      CMUX_SURFACE_ID: process.env.CMUX_SURFACE_ID,
    };
    try {
      const local = joinHeadlessAgent(fixture.db, 'default', 'Alice');
      assert.match(local.session_token ?? '', /^[0-9a-f]{32}$/);
      process.env.SWARM_ID = 'default';
      process.env.SWARM_NAME = '';
      process.env.CMUX_SURFACE_ID = '';
      process.env.SWARM_AGENT_NAME = 'Alice';
      process.env.SWARM_SESSION_TOKEN = local.session_token!;
      assert.strictEqual(getAuthenticatedSelf(fixture.db)?.name, 'Alice');
      process.env.SWARM_SESSION_TOKEN = '0'.repeat(32);
      assert.throws(
        () => getAuthenticatedSelf(fixture.db),
        /identity could not be authenticated for Alice — rejoin with swarm join Alice/
      );

      fixture.db.prepare("UPDATE agents SET session_token = NULL WHERE name = 'Alice'").run();
      delete process.env.SWARM_SESSION_TOKEN;
      assert.strictEqual(getAuthenticatedSelf(fixture.db)?.name, 'Alice');

      const a2a = joinA2AAgent(fixture.db, 'default', 'Remote', 'http://127.0.0.1:18789');
      assert.strictEqual(a2a.session_token, null);
      process.env.SWARM_AGENT_NAME = 'Remote';
      process.env.SWARM_SESSION_TOKEN = 'not-an-a2a-token';
      const authenticatedA2A = getAuthenticatedSelf(fixture.db);
      assert.strictEqual(authenticatedA2A?.agent_type, 'a2a');
      assert.strictEqual(authenticatedA2A?.endpoint_url, 'http://127.0.0.1:18789');
    } finally {
      restoreEnv(envSnapshot);
      fixture.db.close();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('CLI verbs reject a wrong headless token while the Cmux surface marker authenticates its join', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-t2-auth-cli-'));
    try {
      const joined = runCli(home, ['join', 'Alice', '--headless'], { SWARM_AGENT_NAME: 'Alice' });
      assert.strictEqual(joined.status, 0, joined.stderr || joined.stdout);
      const db = new DatabaseSync(path.join(home, '.swarm', 'swarm.db'));
      const alice = db.prepare("SELECT session_token FROM agents WHERE name = 'Alice'")
        .get() as { session_token: string };
      assert.match(alice.session_token, /^[0-9a-f]{32}$/);
      db.close();

      const mismatch = runCli(home, ['task', 'list'], {
        SWARM_AGENT_NAME: 'Alice', SWARM_SESSION_TOKEN: 'f'.repeat(32),
      });
      assert.notStrictEqual(mismatch.status, 0);
      assert.match(mismatch.stderr, /identity could not be authenticated for Alice — rejoin with swarm join Alice/);
      const authenticated = runCli(home, ['task', 'list'], {
        SWARM_AGENT_NAME: 'Alice', SWARM_SESSION_TOKEN: alice.session_token,
      });
      assert.strictEqual(authenticated.status, 0, authenticated.stderr || authenticated.stdout);

      const cmuxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-t2-auth-cmux-'));
      try {
        const cmuxJoin = runCli(cmuxHome, ['join', 'SurfaceAgent'], {
          CMUX_SURFACE_ID: 'surface-auth', CMUX_WORKSPACE_ID: 'workspace-auth',
        });
        assert.strictEqual(cmuxJoin.status, 0, cmuxJoin.stderr || cmuxJoin.stdout);
        const viaSurface = runCli(cmuxHome, ['task', 'list'], { CMUX_SURFACE_ID: 'surface-auth' });
        assert.strictEqual(viaSurface.status, 0, viaSurface.stderr || viaSurface.stdout);
      } finally {
        fs.rmSync(cmuxHome, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('T2.5 board projection', () => {
  test('surfaces direct live escalations, <15m grants, and task grant_used inspector data', async () => {
    const fixture = tempDb('swarm-t2-board-');
    try {
      joinHeadlessAgent(fixture.db, 'default', 'Lead');
      await startTask(fixture.db, 'default', 'Lead', 'board-grants', {
        title: 'Board grants', noWorktree: true, claimKind: 'analysis',
      });
      fixture.db.prepare("UPDATE tasks SET state = 'awaiting_review' WHERE id = 'board-grants'").run();
      const expiring = createGrant(fixture.db, 'default', 'Lead', {
        op: 'override', resource: 'board-grants', ttl: '14m', now: NOW,
      });
      createGrant(fixture.db, 'default', 'Lead', {
        op: 'merge', resource: 'exactly-fifteen', ttl: '15m', now: NOW,
      });
      const revoked = createGrant(fixture.db, 'default', 'Lead', {
        op: 'prod', resource: 'revoked', ttl: '10m', now: NOW,
      });
      revokeGrant(fixture.db, 'default', revoked.id, NOW + 1_000);
      createGrant(fixture.db, 'default', 'Lead', {
        op: 'spend', resource: 'expired', ttl: '1m', now: NOW - 2 * 60_000,
      });
      fixture.db.prepare(`
        INSERT INTO task_events (swarm_id, task_id, epoch, kind, actor, data, created_at)
        VALUES ('default', 'board-grants', 1, 'grant_used', 'Lead', ?, ?)
      `).run(JSON.stringify({
        grant_id: expiring.id, op: 'override', resource: 'board-grants', actor: 'Lead',
      }), new Date(NOW - 1_000).toISOString());
      const escalation = fixture.db.prepare(`
        INSERT INTO messages (swarm_id, from_agent, to_agent, body, delivered, created_at, kind)
        VALUES ('default', 'Lead', 'Lead', '/tmp/pointer-only.md', 0, ?, 'escalation')
      `).run(new Date(NOW - 500).toISOString());

      const data = collectBoardData(fixture.db, 'default', { now: NOW });
      const escalationNeed = data.needsYou.find(item => item.kind === 'escalation');
      assert.deepStrictEqual(escalationNeed, {
        kind: 'escalation',
        label: `message #${Number(escalation.lastInsertRowid)} [escalation] for Lead from Lead — /tmp/pointer-only.md`,
        refId: String(escalation.lastInsertRowid),
        target: { kind: 'agent', id: 'Lead' },
        at: new Date(NOW - 500).toISOString(),
      });
      const grantNeeds = data.needsYou.filter(item => item.kind === 'grant_expiring');
      assert.strictEqual(grantNeeds.length, 1);
      assert.strictEqual(grantNeeds[0].refId, String(expiring.id));
      assert.match(grantNeeds[0].label, /expires in 14m/);
      const task = data.tasks.find(item => item.id === 'board-grants');
      assert.ok(task);
      assert.deepStrictEqual(task.grantUsage, [{
        eventId: task.grantUsage[0].eventId,
        grantId: expiring.id,
        op: 'override',
        resource: 'board-grants',
        actor: 'Lead',
        at: new Date(NOW - 1_000).toISOString(),
      }]);
    } finally {
      fixture.db.close();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

describe('escalation self-routing guard', () => {
  test('solo-agent escalation prints manual path instead of self-delivering; --to self refused', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-esc-'));
    try {
      fs.mkdirSync(path.join(home, '.swarm'), { recursive: true });
      const db = getDbAt(path.join(home, '.swarm', 'swarm.db'));
      joinHeadlessAgent(db, 'default', 'Solo', undefined, { hostAgent: 'claude-code' });
      startTask(db, 'default', 'Solo', 'solo-esc', { title: 'T', noWorktree: true, claim: 'decision' });
      const result = await escalateTask(db, 'default', 'Solo', 'solo-esc', { question: 'ship it?', homeDir: home });
      assert.strictEqual(result.recipient, null, 'no self-delivery: recipient must be null when alone');
      assert.ok(fs.existsSync(result.briefPath), 'packet still written for manual delivery');
      await assert.rejects(
        () => escalateTask(db, 'default', 'Solo', 'solo-esc', { question: 'again?', to: 'Solo', homeDir: home }),
        /Refusing to escalate to yourself/
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
