import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDbAt, type SwarmDb } from '../src/db.js';
import {
  assignSwarmAuthority,
} from '../src/authority.js';
import { createGrant } from '../src/grants.js';
import {
  acknowledgeMessages,
  getInbox,
} from '../src/mailbox.js';
import {
  reserveMigrationResource,
} from '../src/migration-leases.js';
import {
  recordReviewerQualification,
} from '../src/qualifications.js';
import {
  joinHeadlessAgent,
  leaveHeadlessAgent,
  type Agent,
} from '../src/registry.js';
import {
  requestTaskReview,
  submitReviewVerdict,
} from '../src/reviews.js';
import {
  parseProcessSnapshot,
  standDownAgent,
  type ProcessIdentity,
  type ProcessTreeController,
} from '../src/stand-down.js';
import {
  acceptTaskHandoff,
  checkpointTask,
  closeTask,
  getTask,
  offerTaskHandoff,
  recordDecision,
  startTask,
  sweepHandoffOffers,
} from '../src/tasks.js';

const INDEX = path.resolve(fileURLToPath(new URL('../src/index.ts', import.meta.url)));
const TSX_IMPORT = import.meta.resolve('tsx');
const OWNER_BINARY = 'a'.repeat(64);
const REVIEWER_BINARY = 'b'.repeat(64);
const HARNESS_SHA = 'c'.repeat(64);
const PROMPT_SHA = 'd'.repeat(64);
const TOOLS_SHA = 'e'.repeat(64);

interface Fixture {
  root: string;
  home: string;
  db: SwarmDb;
}

interface CliResult {
  stdout: string;
  stderr: string;
  status: number;
}

const cleanupRoots: string[] = [];

afterEach(() => {
  while (cleanupRoots.length > 0) {
    fs.rmSync(cleanupRoots.pop()!, { recursive: true, force: true });
  }
});

function fixture(prefix: string): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.swarm'), { recursive: true });
  cleanupRoots.push(root);
  return {
    root,
    home,
    db: getDbAt(path.join(home, '.swarm', 'swarm.db')),
  };
}

function join(
  db: SwarmDb,
  name: string,
  host: 'codex' | 'claude-code' | 'gemini' = 'codex',
  binary: string = OWNER_BINARY
): Agent {
  return joinHeadlessAgent(db, 'default', name, undefined, {
    hostAgent: host,
    versionRunner: () => `fixture-${host}\n`,
    workerBinarySha256: binary,
    processFingerprint: 'f'.repeat(64),
  });
}

function runCli(home: string, agent: Agent, args: string[]): CliResult {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    TMPDIR: path.join(home, 'tmp'),
    SWARM_ID: 'default',
    SWARM_NAME: '',
    SWARM_AGENT_NAME: agent.name,
    SWARM_SESSION_TOKEN: agent.session_token ?? '',
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

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createPushedRepo(label: string): { root: string; repo: string; remote: string } {
  const root = fs.mkdtempSync(path.join(process.cwd(), `.hardening-v2-${label}-`));
  const repo = path.join(root, 'repo');
  const remote = path.join(root, 'remote.git');
  cleanupRoots.push(root);
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  git(repo, ['config', 'user.name', 'Hardening Test']);
  git(repo, ['config', 'user.email', 'hardening@example.test']);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base\n');
  git(repo, ['add', 'tracked.txt']);
  git(repo, ['commit', '-m', 'base']);
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-u', 'origin', 'main']);
  return { root, repo, remote };
}

function insertCodeTask(
  db: SwarmDb,
  owner: Agent,
  slug: string,
  repoPath: string,
  worktreePath: string | null = null
): { head: string; tree: string } {
  const head = git(repoPath, ['rev-parse', 'main']);
  const tree = git(repoPath, ['rev-parse', `${head}^{tree}`]);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO tasks (
      id, swarm_id, title, state, owner_agent, owner_agent_id,
      lease_epoch, lease_expires_at, repo_path, branch, worktree_path,
      transcript_hint, disposition, claim_kind, head_sha, tree_sha,
      author_family, created_at, updated_at
    ) VALUES (?, 'default', ?, 'active', ?, ?, 1, ?, ?, 'main', ?,
      'fixture', NULL, 'code-merged', ?, ?, 'openai', ?, ?)
  `).run(
    slug,
    slug,
    owner.name,
    owner.id,
    new Date(Date.now() + 60 * 60_000).toISOString(),
    repoPath,
    worktreePath,
    head,
    tree,
    now,
    now
  );
  db.prepare(`
    INSERT INTO task_events (
      swarm_id, task_id, epoch, kind, actor, actor_agent_id, data, created_at
    ) VALUES ('default', ?, 1, 'started', ?, ?, '{}', ?)
  `).run(slug, owner.name, owner.id, now);
  return { head, tree };
}

function qualifyReviewer(
  db: SwarmDb,
  operator: Agent,
  reviewer: Agent,
  now: number = Date.now()
) {
  return recordReviewerQualification(db, 'default', operator.name, {
    agent: reviewer.name,
    binarySha256: REVIEWER_BINARY,
    modelId: 'claude-opus-fixture',
    harnessSha256: HARNESS_SHA,
    promptSha256: PROMPT_SHA,
    toolsSha256: TOOLS_SHA,
    ttl: '1d',
    now,
  });
}

describe('SWARM AUTHORITY+DELIVERY HARDENING V2 causal gates', () => {
  test('workers cannot self-grant protected authority or self-supersede a decision', async () => {
    const value = fixture('swarm-v2-acl-');
    const owner = join(value.db, 'Owner');
    const worker = join(value.db, 'Worker');
    try {
      const protectedOps = ['merge', 'prod', 'release', 'spend', 'migration', 'override'];
      for (const op of protectedOps) {
        assert.throws(
          () => createGrant(value.db, 'default', worker.name, {
            op,
            resource: '*',
            ttl: '30m',
            grantedTo: worker.name,
          }),
          /not an active Owner\/Lead authority/
        );
      }
      assert.strictEqual(
        (value.db.prepare('SELECT COUNT(*) AS n FROM grants').get() as { n: number }).n,
        0
      );
      const decision = recordDecision(value.db, 'default', owner.name, 'operator baseline');
      const before = (value.db.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number }).n;
      assert.throws(
        () => recordDecision(
          value.db,
          'default',
          worker.name,
          'worker hostile successor',
          undefined,
          decision.id
        ),
        /not an active Owner\/Lead authority/
      );
      assert.strictEqual(
        (value.db.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number }).n,
        before
      );
    } finally {
      value.db.close();
    }
  });

  test('crash/dead-recipient handoff preserves source ownership and durable urgent mail', async () => {
    const value = fixture('swarm-v2-handoff-');
    const owner = join(value.db, 'Owner');
    const recipient = join(value.db, 'Recipient', 'claude-code', REVIEWER_BINARY);
    const previousHome = process.env.HOME;
    process.env.HOME = value.home;
    try {
      await startTask(value.db, 'default', owner.name, 'dead-recipient', {
        title: 'Dead recipient',
        noWorktree: true,
        claimKind: 'analysis',
      });
      checkpointTask(value.db, 'default', owner.name, 'dead-recipient', 'Exact charter');
      const now = Date.now();
      await assert.rejects(
        offerTaskHandoff(
          value.db,
          'default',
          owner.name,
          'dead-recipient',
          recipient.name,
          { ttl: '30m', now, failpoint: 'after-commit-before-push' }
        ),
        /Injected crash after durable handoff offer/
      );
      const offer = value.db.prepare(
        "SELECT * FROM handoff_offers WHERE task_id = 'dead-recipient'"
      ).get() as any;
      assert.strictEqual(getTask(value.db, 'default', 'dead-recipient')?.owner_agent_id, owner.id);
      assert.strictEqual(
        (value.db.prepare('SELECT state FROM message_outbox WHERE message_id = ?').get(offer.message_id) as any).state,
        'pending'
      );
      leaveHeadlessAgent(value.db, 'default', recipient.name);
      const swept = sweepHandoffOffers(value.db, 'default', now + 31 * 60_000);
      assert.deepStrictEqual(swept.expired.map(row => row.id), [offer.id]);
      assert.strictEqual(getTask(value.db, 'default', 'dead-recipient')?.owner_agent_id, owner.id);
      assert.ok(
        (value.db.prepare(`
          SELECT COUNT(*) AS n FROM messages
          WHERE kind = 'escalation' AND to_agent_id = ?
        `).get(owner.id) as { n: number }).n >= 1
      );
      assert.ok(
        (value.db.prepare(`
          SELECT COUNT(*) AS n FROM message_outbox o
          JOIN messages m ON m.id = o.message_id
          WHERE m.kind = 'escalation' AND o.state = 'pending'
        `).get() as { n: number }).n >= 1
      );
      fs.rmSync(offer.brief_path, { force: true });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      value.db.close();
    }
  });

  test('inbox display and bulk ack leave every message pending; one exact ack clears one row', () => {
    const value = fixture('swarm-v2-inbox-');
    const owner = join(value.db, 'Owner');
    const worker = join(value.db, 'Worker');
    try {
      const insert = value.db.prepare(`
        INSERT INTO messages (
          swarm_id, from_agent, from_agent_id, to_agent, to_agent_id,
          body, delivered, created_at, kind
        ) VALUES ('default', ?, ?, ?, ?, ?, 1, ?, 'gate')
      `);
      const first = Number(insert.run(
        owner.name, owner.id, worker.name, worker.id, 'STOP one', new Date().toISOString()
      ).lastInsertRowid);
      const second = Number(insert.run(
        owner.name, owner.id, worker.name, worker.id, 'STOP two', new Date().toISOString()
      ).lastInsertRowid);
      const inbox = runCli(value.home, worker, ['inbox']);
      assert.strictEqual(inbox.status, 0, inbox.stderr || inbox.stdout);
      assert.match(inbox.stdout, /display only.*pending until exact ack/);
      const all = runCli(value.home, worker, ['ack', '--all']);
      assert.notStrictEqual(all.status, 0);
      const many = runCli(value.home, worker, ['ack', String(first), String(second)]);
      assert.notStrictEqual(many.status, 0);
      assert.deepStrictEqual(
        (value.db.prepare(`
          SELECT message_id, status FROM message_deliveries
          WHERE recipient = 'Worker' COLLATE NOCASE ORDER BY message_id
        `).all() as Array<{ message_id: number; status: string }>).map(row => ({ ...row })),
        [
          { message_id: first, status: 'pending' },
          { message_id: second, status: 'pending' },
        ]
      );
      assert.deepStrictEqual(getInbox(value.db, 'default', worker.name).map(row => row.id), [first, second]);
      assert.deepStrictEqual(acknowledgeMessages(value.db, 'default', worker.name, [first]), [first]);
      assert.deepStrictEqual(getInbox(value.db, 'default', worker.name).map(row => row.id), [second]);
    } finally {
      value.db.close();
    }
  });

  test('code tasks bind mandatory source identity and handoff cannot launder author family', async () => {
    const value = fixture('swarm-v2-family-');
    const owner = join(value.db, 'Owner', 'codex', OWNER_BINARY);
    const recipient = join(value.db, 'Recipient', 'claude-code', REVIEWER_BINARY);
    const sameAsAuthor = join(value.db, 'SameAsAuthor', 'codex', OWNER_BINARY);
    const previousHome = process.env.HOME;
    process.env.HOME = value.home;
    try {
      await assert.rejects(
        startTask(value.db, 'default', owner.name, 'identity-missing', {
          title: 'Missing identity',
          noWorktree: true,
          claimKind: 'code-merged',
        }),
        /requires --repo and an isolated named worktree/
      );
      const source = createPushedRepo('identity');
      const started = await startTask(value.db, 'default', owner.name, 'identity-code', {
        title: 'Identity code',
        repoPath: source.repo,
        claimKind: 'code-merged',
      });
      assert.ok(started.task.repo_path);
      assert.ok(started.task.branch);
      assert.match(started.task.head_sha ?? '', /^[0-9a-f]{40,64}$/);
      assert.match(started.task.tree_sha ?? '', /^[0-9a-f]{40,64}$/);
      assert.strictEqual(started.task.author_family, 'openai');
      await closeTask(value.db, 'default', owner.name, 'identity-code', {
        disposition: 'discard',
        forceDiscard: true,
        notEstablished: 'discarded fixture',
      });

      await startTask(value.db, 'default', owner.name, 'family-handoff', {
        title: 'Immutable author family',
        noWorktree: true,
        claimKind: 'analysis',
      });
      checkpointTask(value.db, 'default', owner.name, 'family-handoff', 'Preserve provenance');
      const offered = await offerTaskHandoff(
        value.db,
        'default',
        owner.name,
        'family-handoff',
        recipient.name
      );
      await acceptTaskHandoff(value.db, 'default', recipient.name, 'family-handoff', {
        offerId: offered.offer.id,
      });
      const transferred = getTask(value.db, 'default', 'family-handoff')!;
      assert.strictEqual(transferred.owner_agent_id, recipient.id);
      assert.strictEqual(transferred.author_family, 'openai');
      recordReviewerQualification(value.db, 'default', owner.name, {
        agent: sameAsAuthor.name,
        binarySha256: OWNER_BINARY,
        modelId: 'codex-fixture',
        harnessSha256: HARNESS_SHA,
        promptSha256: PROMPT_SHA,
        toolsSha256: TOOLS_SHA,
        ttl: '1d',
      });
      await assert.rejects(
        requestTaskReview(value.db, 'default', recipient.name, 'family-handoff', {
          to: sameAsAuthor.name,
          homeDir: value.home,
        }),
        /Refused same-family review.*model inversion requires/
      );
      recordReviewerQualification(value.db, 'default', owner.name, {
        agent: recipient.name,
        binarySha256: REVIEWER_BINARY,
        modelId: 'claude-owner-fixture',
        harnessSha256: HARNESS_SHA,
        promptSha256: PROMPT_SHA,
        toolsSha256: TOOLS_SHA,
        ttl: '1d',
      });
      await assert.rejects(
        requestTaskReview(value.db, 'default', recipient.name, 'family-handoff', {
          to: recipient.name,
          homeDir: value.home,
        }),
        /exact current task owner registration and cannot review its own task/
      );
      fs.rmSync(offered.briefPath, { force: true });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      value.db.close();
    }
  });

  test('binding review rejects expired, dirty, unpushed, unknown, moved, drifted, and stale identity', async () => {
    const value = fixture('swarm-v2-review-');
    const owner = join(value.db, 'Owner', 'codex', OWNER_BINARY);
    const reviewer = join(value.db, 'Reviewer', 'claude-code', REVIEWER_BINARY);
    const successor = join(value.db, 'Successor', 'gemini', OWNER_BINARY);
    const previousHome = process.env.HOME;
    process.env.HOME = value.home;
    try {
      const expiredRepo = createPushedRepo('expired').repo;
      insertCodeTask(value.db, owner, 'expired-head', expiredRepo);
      recordReviewerQualification(value.db, 'default', owner.name, {
        agent: reviewer.name,
        binarySha256: REVIEWER_BINARY,
        modelId: 'claude-opus-fixture',
        harnessSha256: HARNESS_SHA,
        promptSha256: PROMPT_SHA,
        toolsSha256: TOOLS_SHA,
        ttl: '30m',
        now: 1_000_000,
      });
      await assert.rejects(
        requestTaskReview(value.db, 'default', owner.name, 'expired-head', {
          to: reviewer.name,
          now: new Date(1_000_000 + 31 * 60_000),
          homeDir: value.home,
        }),
        /no live qualification/
      );
      const qualification = qualifyReviewer(value.db, owner, reviewer);

      const dirtyRepo = createPushedRepo('dirty').repo;
      insertCodeTask(value.db, owner, 'dirty-head', dirtyRepo);
      fs.appendFileSync(path.join(dirtyRepo, 'tracked.txt'), 'dirty\n');
      await assert.rejects(
        requestTaskReview(value.db, 'default', owner.name, 'dirty-head', {
          to: reviewer.name,
          homeDir: value.home,
        }),
        /is dirty/
      );

      const unpushedRepo = createPushedRepo('unpushed').repo;
      insertCodeTask(value.db, owner, 'unpushed-head', unpushedRepo);
      fs.appendFileSync(path.join(unpushedRepo, 'tracked.txt'), 'local\n');
      git(unpushedRepo, ['add', 'tracked.txt']);
      git(unpushedRepo, ['commit', '-m', 'local only']);
      await assert.rejects(
        requestTaskReview(value.db, 'default', owner.name, 'unpushed-head', {
          to: reviewer.name,
          homeDir: value.home,
        }),
        /unpushed or not remotely reachable/
      );

      const unknownRepo = createPushedRepo('unknown').repo;
      insertCodeTask(value.db, owner, 'unknown-head', unknownRepo);
      value.db.prepare("UPDATE tasks SET repo_path = '/definitely/missing/repo' WHERE id = 'unknown-head'").run();
      await assert.rejects(
        requestTaskReview(value.db, 'default', owner.name, 'unknown-head', {
          to: reviewer.name,
          homeDir: value.home,
        }),
        /unknown live head\/tree/
      );

      const movedRepo = createPushedRepo('moved').repo;
      insertCodeTask(value.db, owner, 'moved-head', movedRepo, movedRepo);
      git(movedRepo, ['checkout', '-b', 'moved']);
      await assert.rejects(
        requestTaskReview(value.db, 'default', owner.name, 'moved-head', {
          to: reviewer.name,
          homeDir: value.home,
        }),
        /moved from recorded branch main to moved/
      );

      const liveRepo = createPushedRepo('live').repo;
      insertCodeTask(value.db, owner, 'live-head', liveRepo);
      const liveRequest = await requestTaskReview(
        value.db,
        'default',
        owner.name,
        'live-head',
        { to: reviewer.name, homeDir: value.home }
      );
      const reportPath = path.join(value.home, 'review.md');
      fs.writeFileSync(reportPath, '# exact review\nPASS\n');
      value.db.prepare('UPDATE agents SET worker_binary_sha256 = ? WHERE id = ?')
        .run('9'.repeat(64), reviewer.id);
      await assert.rejects(
        Promise.resolve().then(() => submitReviewVerdict(
          value.db,
          'default',
          reviewer.name,
          'live-head',
          {
            requestId: liveRequest.requestId,
            qualificationId: qualification.id,
            verdict: 'pass',
            headSha: liveRequest.task.head_sha!,
            treeSha: liveRequest.task.tree_sha!,
            reportPath,
            modelId: 'claude-opus-fixture',
            harnessSha256: HARNESS_SHA,
            promptSha256: PROMPT_SHA,
            toolsSha256: TOOLS_SHA,
          }
        )),
        /expired, revoked, binary-drifted, or invocation-mismatched/
      );
      value.db.prepare('UPDATE agents SET worker_binary_sha256 = ? WHERE id = ?')
        .run(REVIEWER_BINARY, reviewer.id);
      assert.throws(
        () => submitReviewVerdict(value.db, 'default', reviewer.name, 'live-head', {
          requestId: liveRequest.requestId,
          qualificationId: qualification.id,
          verdict: 'pass',
          headSha: liveRequest.task.head_sha!,
          treeSha: liveRequest.task.tree_sha!,
          reportPath,
          modelId: 'wrong-model',
          harnessSha256: HARNESS_SHA,
          promptSha256: PROMPT_SHA,
          toolsSha256: TOOLS_SHA,
        }),
        /invocation-mismatched/
      );
      const pass = submitReviewVerdict(value.db, 'default', reviewer.name, 'live-head', {
        requestId: liveRequest.requestId,
        qualificationId: qualification.id,
        verdict: 'pass',
        headSha: liveRequest.task.head_sha!,
        treeSha: liveRequest.task.tree_sha!,
        reportPath,
        modelId: 'claude-opus-fixture',
        harnessSha256: HARNESS_SHA,
        promptSha256: PROMPT_SHA,
        toolsSha256: TOOLS_SHA,
      });
      const closed = await closeTask(value.db, 'default', owner.name, 'live-head', {
        disposition: 'pr',
        evidence: [`verdict:${pass.id}`],
        notEstablished: 'none',
      });
      assert.strictEqual(closed.state, 'done');

      const staleRepo = createPushedRepo('stale').repo;
      insertCodeTask(value.db, owner, 'stale-head', staleRepo);
      const staleRequest = await requestTaskReview(
        value.db,
        'default',
        owner.name,
        'stale-head',
        { to: reviewer.name, homeDir: value.home }
      );
      fs.appendFileSync(path.join(staleRepo, 'tracked.txt'), 'new head\n');
      git(staleRepo, ['add', 'tracked.txt']);
      git(staleRepo, ['commit', '-m', 'move head']);
      git(staleRepo, ['push', 'origin', 'main']);
      assert.throws(
        () => submitReviewVerdict(value.db, 'default', reviewer.name, 'stale-head', {
          requestId: staleRequest.requestId,
          qualificationId: qualification.id,
          verdict: 'pass',
          headSha: staleRequest.task.head_sha!,
          treeSha: staleRequest.task.tree_sha!,
          reportPath,
          modelId: 'claude-opus-fixture',
          harnessSha256: HARNESS_SHA,
          promptSha256: PROMPT_SHA,
          toolsSha256: TOOLS_SHA,
        }),
        /not bound to the unchanged live request head\/tree/
      );

      const epochRepo = createPushedRepo('stale-epoch').repo;
      insertCodeTask(value.db, owner, 'stale-epoch', epochRepo);
      const epochRequest = await requestTaskReview(
        value.db,
        'default',
        owner.name,
        'stale-epoch',
        { to: reviewer.name, homeDir: value.home }
      );
      const epochPass = submitReviewVerdict(value.db, 'default', reviewer.name, 'stale-epoch', {
        requestId: epochRequest.requestId,
        qualificationId: qualification.id,
        verdict: 'pass',
        headSha: epochRequest.task.head_sha!,
        treeSha: epochRequest.task.tree_sha!,
        reportPath,
        modelId: 'claude-opus-fixture',
        harnessSha256: HARNESS_SHA,
        promptSha256: PROMPT_SHA,
        toolsSha256: TOOLS_SHA,
      });
      checkpointTask(value.db, 'default', owner.name, 'stale-epoch', 'Verdict precedes transfer.');
      const epochOffer = await offerTaskHandoff(
        value.db,
        'default',
        owner.name,
        'stale-epoch',
        successor.name
      );
      await acceptTaskHandoff(value.db, 'default', successor.name, 'stale-epoch', {
        offerId: epochOffer.offer.id,
      });
      await assert.rejects(
        closeTask(value.db, 'default', successor.name, 'stale-epoch', {
          disposition: 'pr',
          evidence: [`verdict:${epochPass.id}`],
          notEstablished: 'none',
        }),
        /verdict.*stale/
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      value.db.close();
    }
  });

  test('a fake nonempty report, even with override authority, cannot close a code task', async () => {
    const value = fixture('swarm-v2-fake-report-');
    const owner = join(value.db, 'Owner');
    try {
      const repo = createPushedRepo('fake-report').repo;
      insertCodeTask(value.db, owner, 'fake-report', repo);
      const report = path.join(value.home, 'fake.md');
      fs.writeFileSync(report, 'looks convincing but is not a typed verdict\n');
      createGrant(value.db, 'default', owner.name, {
        op: 'override',
        resource: 'fake-report',
        ttl: '30m',
        grantedTo: owner.name,
      });
      await assert.rejects(
        closeTask(value.db, 'default', owner.name, 'fake-report', {
          disposition: 'pr',
          evidence: [`report:${report}`],
          notEstablished: 'none',
          override: true,
          reason: 'attempted operator bypass',
        }),
        /expects evidence kind\(s\): verdict; received "report"/
      );
      assert.strictEqual(getTask(value.db, 'default', 'fake-report')?.state, 'active');
      assert.strictEqual(
        (value.db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE kind = 'closed'").get() as { n: number }).n,
        0
      );
    } finally {
      value.db.close();
    }
  });

  test('concurrent migration reservations have exactly one winner', async () => {
    const value = fixture('swarm-v2-migration-');
    const owner = join(value.db, 'Owner');
    const lead = join(value.db, 'Lead', 'claude-code', REVIEWER_BINARY);
    const worker = join(value.db, 'Worker');
    try {
      assignSwarmAuthority(value.db, 'default', owner.name, 'lead', lead.name);
      await startTask(value.db, 'default', owner.name, 'migration-one', {
        title: 'Migration one', noWorktree: true, claimKind: 'analysis',
      });
      await startTask(value.db, 'default', lead.name, 'migration-two', {
        title: 'Migration two', noWorktree: true, claimKind: 'analysis',
      });
      const attempts = await Promise.allSettled([
        Promise.resolve().then(() => reserveMigrationResource(
          value.db,
          'default',
          owner.name,
          { resource: '0034', taskId: 'migration-one', ttl: '2h' }
        )),
        Promise.resolve().then(() => reserveMigrationResource(
          value.db,
          'default',
          lead.name,
          { resource: '0034', taskId: 'migration-two', ttl: '2h' }
        )),
      ]);
      assert.strictEqual(attempts.filter(result => result.status === 'fulfilled').length, 1);
      assert.strictEqual(attempts.filter(result => result.status === 'rejected').length, 1);
      assert.strictEqual(
        (value.db.prepare(`
          SELECT COUNT(*) AS n FROM migration_resource_leases
          WHERE resource = 'migration:0034' AND released_at IS NULL
        `).get() as { n: number }).n,
        1
      );
      assert.throws(
        () => reserveMigrationResource(value.db, 'default', worker.name, {
          resource: '0035', taskId: 'migration-one', ttl: '2h',
        }),
        /not an active Owner\/Lead authority/
      );
    } finally {
      value.db.close();
    }
  });

  test('unverified leave refuses; exact-tree stand-down preserves unrelated and PID-reused processes', async () => {
    const value = fixture('swarm-v2-standdown-');
    const owner = join(value.db, 'Owner');
    const worker = join(value.db, 'Worker', 'claude-code', REVIEWER_BINARY);
    const identities = parseProcessSnapshot([
      '100 1 Thu Jul 31 10:00:00 2026 reviewer-root',
      '101 100 Thu Jul 31 10:00:01 2026 reviewer-child',
      '102 101 Thu Jul 31 10:00:02 2026 reviewer-grandchild',
      '200 1 Thu Jul 31 10:00:03 2026 unrelated-root',
      '201 200 Thu Jul 31 10:00:04 2026 unrelated-child',
      '900 1 Thu Jul 31 10:00:05 2026 operator-root',
    ].join('\n'));
    const root = identities.find(identity => identity.pid === 100)!;
    value.db.prepare('UPDATE agents SET ppid = 100, process_fingerprint = ? WHERE id = ?')
      .run(root.fingerprint, worker.id);
    try {
      const refused = runCli(value.home, worker, ['leave']);
      assert.notStrictEqual(refused.status, 0);
      assert.match(refused.stderr, /Refused unverified leave/);
      assert.ok(value.db.prepare('SELECT id FROM agents WHERE id = ?').get(worker.id));
      assert.strictEqual(
        (value.db.prepare('SELECT COUNT(*) AS n FROM stand_down_events').get() as { n: number }).n,
        0
      );

      const live = new Map(identities.map(identity => [identity.pid, identity]));
      const signalled: Array<{ pid: number; signal: NodeJS.Signals }> = [];
      const reused = parseProcessSnapshot(
        '102 1 Thu Jul 31 10:01:02 2026 unrelated-reused-pid'
      )[0];
      const controller: ProcessTreeController = {
        currentPid: 999,
        snapshot: () => [...live.values()],
        signal: (pid, signal) => {
          signalled.push({ pid, signal });
          live.delete(pid);
          if (pid === 102 && signal === 'SIGTERM') live.set(102, reused);
        },
        wait: async () => {},
      };
      const result = await standDownAgent(
        value.db,
        'default',
        owner.name,
        worker.name,
        controller,
        new Date('2026-07-31T10:02:00.000Z')
      );
      assert.deepStrictEqual(result.terminatedPids, [100, 101, 102]);
      assert.deepStrictEqual(signalled.map(entry => entry.pid), [102, 101, 100]);
      assert.ok(live.has(200));
      assert.ok(live.has(201));
      assert.strictEqual(live.get(102)?.fingerprint, reused.fingerprint);
      assert.strictEqual(value.db.prepare('SELECT id FROM agents WHERE id = ?').get(worker.id), undefined);
      const event = value.db.prepare('SELECT * FROM stand_down_events').get() as any;
      assert.strictEqual(event.target_agent_id, worker.id);
      assert.deepStrictEqual(JSON.parse(event.terminated_pids), [100, 101, 102]);
    } finally {
      value.db.close();
    }
  });
});
