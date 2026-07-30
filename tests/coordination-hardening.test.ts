import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assignSwarmAuthority } from '../src/authority.js';
import { getDbAt, type SwarmDb } from '../src/db.js';
import { createGrant, findLiveGrant, revokeGrant } from '../src/grants.js';
import { runJanitorTick, type SwarmVersionGitRunner } from '../src/janitor.js';
import { flushMessageOutbox } from '../src/mailbox.js';
import {
  getOrCreateSwarm,
  joinA2AAgent,
  joinHeadlessAgent,
  leaveHeadlessAgent,
  type Agent,
} from '../src/registry.js';
import {
  acceptTaskHandoff,
  checkpointTask,
  getTask,
  offerTaskHandoff,
  rebindLegacyTask,
  recordDecision,
  startTask,
  sweepHandoffOffers,
} from '../src/tasks.js';

const INDEX = path.resolve(fileURLToPath(new URL('../src/index.ts', import.meta.url)));
const TSX_IMPORT = import.meta.resolve('tsx');
const roots: string[] = [];

interface Fixture {
  root: string;
  db: SwarmDb;
}

interface CliResult {
  stdout: string;
  stderr: string;
  status: number;
}

function fixture(prefix: string): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return { root, db: getDbAt(path.join(root, 'swarm.db')) };
}

function registration(db: SwarmDb, swarmId: string, name: string): Agent {
  return db.prepare(
    'SELECT * FROM agents WHERE swarm_id = ? AND name = ? COLLATE NOCASE'
  ).get(swarmId, name) as unknown as Agent;
}

function insertCurrentCheckpoint(
  value: Fixture,
  swarmId: string,
  slug: string,
  actor: Agent,
  now: number = Date.now()
): string {
  const task = getTask(value.db, swarmId, slug);
  assert.ok(task);
  const checkpointPath = path.join(value.root, `${swarmId}-${slug}-checkpoint.md`);
  const draftId = randomUUID();
  const contents = [
    `# checkpoint ${slug}`,
    `<!-- swarm-checkpoint-draft:${draftId} -->`,
    '## decisions (+why, +rejected alternatives)',
    'Bound to the exact current owner and epoch.',
    '## failed approaches (do-not-repeat)',
    '- none',
    '## next action',
    'Continue from this charter.',
    '## blockers / landmines',
    '- none',
    '',
  ].join('\n');
  fs.writeFileSync(checkpointPath, contents);
  value.db.prepare(`
    INSERT INTO task_events (
      swarm_id, task_id, epoch, kind, actor, actor_agent_id, data, created_at
    ) VALUES (?, ?, ?, 'checkpoint', ?, ?, ?, ?)
  `).run(
    swarmId,
    slug,
    task.lease_epoch,
    actor.name,
    actor.id,
    JSON.stringify({
      path: checkpointPath,
      sequence: 1,
      draft_id: draftId,
      content_sha256: createHash('sha256').update(contents, 'utf-8').digest('hex'),
    }),
    new Date(now).toISOString()
  );
  return checkpointPath;
}

function cliToken(home: string, name: string): string {
  const db = new DatabaseSync(path.join(home, '.swarm', 'swarm.db'), { readOnly: true });
  try {
    return (db.prepare('SELECT session_token FROM agents WHERE name = ? COLLATE NOCASE')
      .get(name) as { session_token: string | null } | undefined)?.session_token ?? '';
  } finally {
    db.close();
  }
}

function runCli(home: string, args: string[], agent?: string): CliResult {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    TMPDIR: path.join(home, 'tmp'),
    SWARM_ID: '',
    SWARM_NAME: '',
    SWARM_AGENT_NAME: agent ?? '',
    SWARM_SESSION_TOKEN: agent && fs.existsSync(path.join(home, '.swarm', 'swarm.db'))
      ? cliToken(home, agent)
      : '',
    CMUX_SURFACE_ID: '',
    CMUX_WORKSPACE_ID: '',
    TERM_PROGRAM: '',
    CODEX_CLI: '',
    CODEX_CI: '',
    CODEX_THREAD_ID: '',
    CODEX_MANAGED_BY_NPM: '',
    CLAUDE_CODE: '',
    GROK_AGENT: '',
    GEMINI_CLI: '',
    SWARM_TEST_DISABLE_BACKGROUND: '1',
  };
  fs.mkdirSync(env.TMPDIR, { recursive: true });
  try {
    const stdout = execFileSync('node', ['--import', TSX_IMPORT, INDEX, ...args], {
      encoding: 'utf-8',
      env,
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

function joinCli(home: string, name: string): void {
  const joined = runCli(home, ['join', name, '--headless'], name);
  assert.strictEqual(joined.status, 0, joined.stderr || joined.stdout);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('immutable registration and epoch authority', () => {
  test('same-name rejoin inherits neither a task lease nor Owner/Lead takeover authority', async () => {
    const value = fixture('swarm-owner-id-');
    try {
      const alice = joinHeadlessAgent(value.db, 'default', 'Alice');
      joinHeadlessAgent(value.db, 'default', 'Bob');
      assignSwarmAuthority(value.db, 'default', 'Alice', 'lead', 'Bob');
      await startTask(value.db, 'default', 'Alice', 'identity-fence', {
        title: 'Fence same-name replacement',
        noWorktree: true,
      });

      assert.strictEqual(leaveHeadlessAgent(value.db, 'default', 'Alice'), true);
      const replacement = joinHeadlessAgent(value.db, 'default', 'Alice');
      assert.notStrictEqual(replacement.id, alice.id);
      assert.throws(
        () => checkpointTask(
          value.db,
          'default',
          'Alice',
          'identity-fence',
          'A replacement must not inherit the old lease.'
        ),
        /Refused stale task authority/
      );
      await assert.rejects(
        startTask(value.db, 'default', 'Alice', 'identity-fence', {
          noWorktree: true,
          takeover: true,
        }),
        /not an active Owner\/Lead authority/
      );
      assert.strictEqual(getTask(value.db, 'default', 'identity-fence')?.owner_agent_id, alice.id);

      const recovered = await startTask(value.db, 'default', 'Bob', 'identity-fence', {
        noWorktree: true,
        takeover: true,
      });
      assert.strictEqual(recovered.task.owner_agent_id, registration(value.db, 'default', 'Bob').id);
      assert.strictEqual(recovered.task.lease_epoch, 2);
    } finally {
      value.db.close();
    }
  });

  test('legacy name-only rows are readable but require explicit Owner/Lead rebind', async () => {
    const value = fixture('swarm-legacy-rebind-');
    try {
      joinHeadlessAgent(value.db, 'default', 'Owner');
      const worker = joinHeadlessAgent(value.db, 'default', 'Worker');
      const timestamp = new Date().toISOString();
      value.db.prepare(`
        INSERT INTO tasks (
          id, swarm_id, title, state, owner_agent, owner_agent_id,
          lease_epoch, lease_expires_at, repo_path, branch, worktree_path,
          transcript_hint, disposition, claim_kind, created_at, updated_at
        ) VALUES (
          'legacy-task', 'default', 'Legacy task', 'active', 'Worker', NULL,
          5, NULL, NULL, NULL, NULL, NULL, NULL, 'analysis', ?, ?
        )
      `).run(timestamp, timestamp);

      assert.strictEqual(getTask(value.db, 'default', 'legacy-task')?.owner_agent, 'Worker');
      await assert.rejects(
        startTask(value.db, 'default', 'Worker', 'legacy-task', { noWorktree: true }),
        /legacy name-only ownership.*task rebind/s
      );
      await assert.rejects(
        rebindLegacyTask(
          value.db,
          'default',
          'Worker',
          'legacy-task',
          { target: 'Worker', reason: 'member must not self-upgrade' }
        ),
        /not an active Owner\/Lead authority/
      );
      const rebound = await rebindLegacyTask(
        value.db,
        'default',
        'Owner',
        'legacy-task',
        { target: 'Worker', reason: 'upgrade provenance' }
      );
      assert.strictEqual(rebound.owner_agent_id, worker.id);
      assert.strictEqual(rebound.lease_epoch, 6);
      const events = value.db.prepare(`
        SELECT kind, actor_agent_id FROM task_events
        WHERE task_id = 'legacy-task'
        ORDER BY id
      `).all() as Array<{ kind: string; actor_agent_id: string | null }>;
      assert.deepStrictEqual(events.map(event => event.kind), [
        'legacy_rebind_authorized',
        'legacy_rebound',
      ]);
      assert.ok(events.every(event => event.actor_agent_id !== null));
    } finally {
      value.db.close();
    }
  });

  test('a prior-epoch checkpoint cannot package a takeover charter', async () => {
    const value = fixture('swarm-checkpoint-epoch-');
    try {
      joinHeadlessAgent(value.db, 'default', 'Owner');
      const bob = joinHeadlessAgent(value.db, 'default', 'Bob');
      joinHeadlessAgent(value.db, 'default', 'Recipient');
      assignSwarmAuthority(value.db, 'default', 'Owner', 'lead', 'Bob');
      await startTask(value.db, 'default', 'Owner', 'checkpoint-fence', {
        title: 'Checkpoint epoch fence',
        noWorktree: true,
      });
      insertCurrentCheckpoint(value, 'default', 'checkpoint-fence', registration(value.db, 'default', 'Owner'));
      await startTask(value.db, 'default', 'Bob', 'checkpoint-fence', {
        noWorktree: true,
        takeover: true,
      });

      await assert.rejects(
        offerTaskHandoff(
          value.db,
          'default',
          'Bob',
          'checkpoint-fence',
          'Recipient'
        ),
        /latest checkpoint is not bound to current owner registration/
      );
      insertCurrentCheckpoint(value, 'default', 'checkpoint-fence', bob);
      const offered = await offerTaskHandoff(
        value.db,
        'default',
        'Bob',
        'checkpoint-fence',
        'Recipient'
      );
      assert.strictEqual(offered.offer.source_epoch, 2);
      assert.strictEqual(offered.offer.from_agent_id, bob.id);
      fs.rmSync(offered.briefPath, { force: true });
    } finally {
      value.db.close();
    }
  });
});

describe('Owner/Lead ACLs, grants, and decisions', () => {
  test('ordinary members cannot mint wildcard grants or program decisions; grants bind issuer and recipient IDs', async () => {
    const value = fixture('swarm-authority-acl-');
    try {
      const owner = joinHeadlessAgent(value.db, 'default', 'Owner');
      const member = joinHeadlessAgent(value.db, 'default', 'Member');
      assert.throws(
        () => createGrant(value.db, 'default', 'Member', {
          op: 'override',
          resource: '*',
          ttl: '2h',
        }),
        /not an active Owner\/Lead authority/
      );
      assert.throws(
        () => recordDecision(value.db, 'default', 'Member', 'member program decision'),
        /not an active Owner\/Lead authority/
      );
      assert.throws(
        () => assignSwarmAuthority(value.db, 'default', 'Member', 'lead', 'Member'),
        /not an active Owner\/Lead authority/
      );

      const grant = createGrant(value.db, 'default', 'Owner', {
        op: 'override',
        resource: '*',
        ttl: '2h',
        grantedTo: 'Member',
      });
      assert.strictEqual(grant.granted_by_agent_id, owner.id);
      assert.strictEqual(grant.granted_to_agent_id, member.id);
      assert.throws(
        () => revokeGrant(value.db, 'default', 'Member', grant.id),
        /not an active Owner\/Lead authority/
      );
      assert.ok(findLiveGrant(value.db, 'default', {
        op: 'override',
        resources: ['anything'],
        actor: 'Member',
      }));

      leaveHeadlessAgent(value.db, 'default', 'Member');
      const replacement = joinHeadlessAgent(value.db, 'default', 'Member');
      assert.notStrictEqual(replacement.id, member.id);
      assert.strictEqual(findLiveGrant(value.db, 'default', {
        op: 'override',
        resources: ['anything'],
        actor: 'Member',
      }), null);
    } finally {
      value.db.close();
    }
  });

  test('decision supersession requires an active predecessor, exact author ID, and one successor', () => {
    const value = fixture('swarm-decision-successor-');
    try {
      joinHeadlessAgent(value.db, 'default', 'Owner');
      joinHeadlessAgent(value.db, 'default', 'Lead');
      assignSwarmAuthority(value.db, 'default', 'Owner', 'lead', 'Lead');
      const first = recordDecision(
        value.db,
        'default',
        'Owner',
        'program decision one',
        undefined,
        undefined,
        1_800_000_000_000
      );
      const second = recordDecision(
        value.db,
        'default',
        'Owner',
        'program decision two',
        undefined,
        first.id,
        1_800_000_000_001
      );
      assert.ok(second.id > first.id);
      assert.throws(
        () => recordDecision(
          value.db,
          'default',
          'Owner',
          'program decision three',
          undefined,
          first.id,
          1_800_000_000_002
        ),
        /only an active decision may be superseded/
      );
      assert.strictEqual(
        (value.db.prepare('SELECT COUNT(*) AS n FROM decisions WHERE supersedes = ?')
          .get(first.id) as { n: number }).n,
        1
      );
      value.db.exec('DROP INDEX idx_decisions_single_successor');
      value.db.prepare("UPDATE decisions SET status = 'active' WHERE id = ?").run(first.id);
      assert.throws(
        () => recordDecision(
          value.db,
          'default',
          'Owner',
          'dirty legacy state must still refuse a second successor',
          undefined,
          first.id,
          1_800_000_000_003
        ),
        /already has successor.*single-successor slot is closed/
      );
      assert.strictEqual(
        (value.db.prepare('SELECT COUNT(*) AS n FROM decisions WHERE supersedes = ?')
          .get(first.id) as { n: number }).n,
        1
      );

      leaveHeadlessAgent(value.db, 'default', 'Owner');
      joinHeadlessAgent(value.db, 'default', 'Owner');
      assignSwarmAuthority(value.db, 'default', 'Lead', 'owner', 'Owner');
      assert.throws(
        () => recordDecision(
          value.db,
          'default',
          'Owner',
          'same display name, different author registration',
          undefined,
          second.id,
          1_800_000_000_004
        ),
        /only that exact active author registration may supersede it/
      );
    } finally {
      value.db.close();
    }
  });
});

describe('transactional handoff outbox and deadline janitor', () => {
  test('offer and acceptance survive crashes after commit but before push', async () => {
    const value = fixture('swarm-handoff-crash-');
    try {
      const alice = joinHeadlessAgent(value.db, 'default', 'Alice');
      const bob = joinHeadlessAgent(value.db, 'default', 'Bob');
      await startTask(value.db, 'default', 'Alice', 'crash-handoff', {
        title: 'Crash-safe handoff',
        noWorktree: true,
      });
      insertCurrentCheckpoint(value, 'default', 'crash-handoff', alice);

      await assert.rejects(
        offerTaskHandoff(
          value.db,
          'default',
          'Alice',
          'crash-handoff',
          'Bob',
          { failpoint: 'after-commit-before-push' }
        ),
        /Injected crash after durable handoff offer/
      );
      const offer = value.db.prepare(
        "SELECT * FROM handoff_offers WHERE task_id = 'crash-handoff'"
      ).get() as {
        id: number;
        status: string;
        message_id: number;
        brief_path: string;
      };
      assert.strictEqual(offer.status, 'pending');
      assert.strictEqual(getTask(value.db, 'default', 'crash-handoff')?.owner_agent_id, alice.id);
      assert.deepStrictEqual(
        {
          ...(value.db.prepare(`
            SELECT state, attempts FROM message_outbox
            WHERE message_id = ? AND recipient_agent_id = ?
          `).get(offer.message_id, bob.id) as object),
        },
        { state: 'pending', attempts: 0 }
      );

      await assert.rejects(
        acceptTaskHandoff(
          value.db,
          'default',
          'Bob',
          'crash-handoff',
          { offerId: offer.id, failpoint: 'after-commit-before-push' }
        ),
        /Injected crash after durable handoff acceptance/
      );
      assert.strictEqual(getTask(value.db, 'default', 'crash-handoff')?.owner_agent_id, bob.id);
      assert.strictEqual(
        (value.db.prepare('SELECT status FROM handoff_offers WHERE id = ?')
          .get(offer.id) as { status: string }).status,
        'accepted'
      );
      const acceptanceNotice = value.db.prepare(`
        SELECT m.id, o.state, o.attempts
        FROM messages m
        JOIN message_outbox o ON o.message_id = m.id
        WHERE m.kind = 'handoff' AND m.to_agent_id = ?
      `).get(alice.id) as { id: number; state: string; attempts: number };
      assert.deepStrictEqual(
        { state: acceptanceNotice.state, attempts: acceptanceNotice.attempts },
        { state: 'pending', attempts: 0 }
      );

      const flushed = await flushMessageOutbox(
        value.db,
        [offer.message_id, acceptanceNotice.id],
        async () => ({ delivered: true })
      );
      assert.deepStrictEqual(flushed, { pushed: 2, queued: 0 });
      assert.strictEqual(
        (value.db.prepare("SELECT COUNT(*) AS n FROM message_outbox WHERE state = 'pending'")
          .get() as { n: number }).n,
        0
      );
      fs.rmSync(offer.brief_path, { force: true });
    } finally {
      value.db.close();
    }
  });

  test('one janitor tick sweeps every swarm and emits exactly-once sender, Owner, and Lead escalations', async () => {
    const value = fixture('swarm-global-janitor-');
    const briefs: string[] = [];
    try {
      const offers: number[] = [];
      for (const swarmName of ['alpha', 'beta']) {
        const swarm = getOrCreateSwarm(value.db, swarmName);
        joinHeadlessAgent(value.db, swarm.id, 'Owner');
        joinHeadlessAgent(value.db, swarm.id, 'Lead');
        const source = joinHeadlessAgent(value.db, swarm.id, 'Source');
        joinHeadlessAgent(value.db, swarm.id, 'Recipient');
        assignSwarmAuthority(value.db, swarm.id, 'Owner', 'lead', 'Lead');
        const slug = `${swarmName}-handoff`;
        await startTask(value.db, swarm.id, 'Source', slug, {
          title: `Deadline ${swarmName}`,
          noWorktree: true,
        });
        insertCurrentCheckpoint(value, swarm.id, slug, source);
        const offered = await offerTaskHandoff(
          value.db,
          swarm.id,
          'Source',
          slug,
          'Recipient'
        );
        offers.push(offered.offer.id);
        briefs.push(offered.briefPath);
        value.db.prepare('UPDATE handoff_offers SET expires_at = ? WHERE id = ?')
          .run('2000-01-01T00:00:00.000Z', offered.offer.id);
      }

      const noNetwork: SwarmVersionGitRunner = () => {
        throw new Error('offline fixture');
      };
      const tickNow = Date.now() + 60_000;
      const first = runJanitorTick(value.db, {
        homeDir: value.root,
        tempScanPaths: [],
        controlsFilePath: path.join(value.root, 'missing-controls.md'),
        versionRepoDir: value.root,
        versionRunner: noNetwork,
        now: tickNow,
      });
      assert.strictEqual(first.ran, true);
      for (const offerId of offers) {
        assert.strictEqual(
          (value.db.prepare('SELECT status FROM handoff_offers WHERE id = ?')
            .get(offerId) as { status: string }).status,
          'expired'
        );
        const audiences = value.db.prepare(`
          SELECT audience FROM handoff_expiry_notifications
          WHERE offer_id = ? ORDER BY audience
        `).all(offerId) as Array<{ audience: string }>;
        assert.deepStrictEqual(audiences.map(row => row.audience), [
          'authority',
          'authority',
          'sender',
        ]);
      }
      assert.strictEqual(
        (value.db.prepare('SELECT COUNT(*) AS n FROM handoff_expiry_notifications')
          .get() as { n: number }).n,
        6
      );

      runJanitorTick(value.db, {
        homeDir: value.root,
        tempScanPaths: [],
        controlsFilePath: path.join(value.root, 'missing-controls.md'),
        versionRepoDir: value.root,
        versionRunner: noNetwork,
        now: tickNow + 1,
      });
      assert.strictEqual(
        (value.db.prepare('SELECT COUNT(*) AS n FROM handoff_expiry_notifications')
          .get() as { n: number }).n,
        6,
        'repeated fleet sweeps must not duplicate an escalation audience'
      );
      value.db.exec('DELETE FROM messages');
      assert.deepStrictEqual(
        {
          ...(value.db.prepare(`
            SELECT COUNT(*) AS total, COUNT(message_id) AS linked
            FROM handoff_expiry_notifications
          `).get() as object),
        },
        { total: 6, linked: 0 },
        'message reset may clear transport rows but must retain the exactly-once expiry audit'
      );
    } finally {
      for (const brief of briefs) fs.rmSync(brief, { force: true });
      value.db.close();
    }
  });

  test('handoff and grant deadline clocks fail closed on rollback', async () => {
    const value = fixture('swarm-clock-rollback-');
    try {
      const owner = joinHeadlessAgent(value.db, 'default', 'Owner');
      joinHeadlessAgent(value.db, 'default', 'Recipient');
      await startTask(value.db, 'default', 'Owner', 'clock-fence', {
        title: 'Clock fence',
        noWorktree: true,
      });
      insertCurrentCheckpoint(value, 'default', 'clock-fence', owner);
      const offered = await offerTaskHandoff(
        value.db,
        'default',
        'Owner',
        'clock-fence',
        'Recipient'
      );
      const created = new Date(offered.offer.created_at).getTime();
      assert.throws(
        () => sweepHandoffOffers(value.db, 'default', created - 1),
        /wall clock moved backwards/
      );
      assert.strictEqual(
        (value.db.prepare('SELECT status FROM handoff_offers WHERE id = ?')
          .get(offered.offer.id) as { status: string }).status,
        'pending'
      );

      createGrant(value.db, 'default', 'Owner', {
        op: 'override',
        resource: 'clock-fence',
        ttl: '2h',
        now: created,
      });
      assert.throws(
        () => findLiveGrant(value.db, 'default', {
          op: 'override',
          resources: ['clock-fence'],
          actor: 'Owner',
          now: created - 1,
        }),
        /wall clock moved backwards/
      );
      assert.throws(
        () => createGrant(value.db, 'default', 'Owner', {
          op: 'override',
          resource: 'clock-fence-2',
          ttl: '2h',
          now: created - 1,
        }),
        /wall clock moved backwards/
      );
      fs.rmSync(offered.briefPath, { force: true });
    } finally {
      value.db.close();
    }
  });
});

describe('CLI fail-closed parsing and privileged authentication', () => {
  test('decision --help and unknown option-like text never create a decision row', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-decision-help-'));
    roots.push(home);
    joinCli(home, 'Owner');

    const help = runCli(home, ['decision', '--help'], 'Owner');
    assert.strictEqual(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /^Usage: swarm decision/);
    const unknown = runCli(home, ['decision', '--looks-like-an-option'], 'Owner');
    assert.notStrictEqual(unknown.status, 0);
    assert.match(unknown.stderr, /Unknown decision option/);

    const db = new DatabaseSync(path.join(home, '.swarm', 'swarm.db'), { readOnly: true });
    try {
      assert.strictEqual(
        (db.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number }).n,
        0
      );
    } finally {
      db.close();
    }
  });

  test('legacy NULL-token and A2A identities may read but cannot perform privileged mutations', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-privileged-auth-'));
    roots.push(home);
    joinCli(home, 'Legacy');
    let db = new DatabaseSync(path.join(home, '.swarm', 'swarm.db'));
    db.prepare("UPDATE agents SET session_token = NULL WHERE name = 'Legacy'").run();
    db.close();

    const read = runCli(home, ['task', 'list'], 'Legacy');
    assert.strictEqual(read.status, 0, read.stderr || read.stdout);
    const legacyMutation = runCli(home, ['decision', 'must fail closed'], 'Legacy');
    assert.notStrictEqual(legacyMutation.status, 0);
    assert.match(legacyMutation.stderr, /legacy identity.*has no session token/);

    db = new DatabaseSync(path.join(home, '.swarm', 'swarm.db'));
    joinA2AAgent(db, 'default', 'Remote', 'https://remote.invalid/a2a');
    db.close();
    const a2aMutation = runCli(home, ['decision', 'remote must fail closed'], 'Remote');
    assert.notStrictEqual(a2aMutation.status, 0);
    assert.match(a2aMutation.stderr, /privileged identity is unavailable for A2A agent/);

    db = new DatabaseSync(path.join(home, '.swarm', 'swarm.db'), { readOnly: true });
    try {
      assert.strictEqual(
        (db.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number }).n,
        0
      );
    } finally {
      db.close();
    }
  });
});
