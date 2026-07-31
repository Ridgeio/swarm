import { after, before, describe, test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';
import { collectBoardData } from '../src/board-data.js';
import { getDbAt, type SwarmDb } from '../src/db.js';
import {
  checkpointTask,
  closeTask,
  offerTaskHandoff,
  reopenTask,
  resolveDefaultBranchTarget,
  startTask,
  taskGitFacts,
  type GitQueryRunner,
} from '../src/tasks.js';
import { joinHeadlessAgent } from '../src/registry.js';
import { assignSwarmAuthority } from '../src/authority.js';

const INDEX = path.resolve(fileURLToPath(new URL('../src/index.ts', import.meta.url)));
const TSX_IMPORT = import.meta.resolve('tsx');

interface CliResult { stdout: string; stderr: string; status: number }

function runCli(home: string, args: string[], agent?: string, cwd?: string): CliResult {
  let sessionToken = '';
  const dbPath = path.join(home, '.swarm', 'swarm.db');
  if (agent && fs.existsSync(dbPath)) {
    const identityDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = identityDb.prepare('SELECT session_token FROM agents WHERE name = ? COLLATE NOCASE')
        .get(agent) as { session_token: string | null } | undefined;
      sessionToken = row?.session_token ?? '';
    } finally {
      identityDb.close();
    }
  }
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    TMPDIR: path.join(home, 'tmp-policy-root'),
    SWARM_ID: '',
    SWARM_NAME: '',
    SWARM_AGENT_NAME: agent ?? '',
    SWARM_SESSION_TOKEN: sessionToken,
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
  };
  try {
    const stdout = execFileSync('node', ['--import', TSX_IMPORT, INDEX, ...args], {
      encoding: 'utf-8',
      env,
      cwd,
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

function dropSessionMarkers(home: string): void {
  const dir = path.join(home, '.swarm');
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith('headless-')) fs.rmSync(path.join(dir, entry), { force: true });
  }
}

function joinAgent(home: string, name: string): void {
  const joined = runCli(home, ['join', name, '--headless'], name);
  assert.strictEqual(joined.status, 0, joined.stderr || joined.stdout);
  const db = new DatabaseSync(path.join(home, '.swarm', 'swarm.db'));
  db.prepare(`
    UPDATE agents
    SET host_agent = 'codex', worker_version = 'fixture-codex', worker_binary_sha256 = ?
    WHERE name = ? COLLATE NOCASE
  `).run('a'.repeat(64), name);
  db.close();
  dropSessionMarkers(home);
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

function createPushedRepo(root: string, repoName: string = 'repo'): { repo: string; remote: string } {
  const repo = path.join(root, repoName);
  const remote = path.join(root, `${repoName}-remote.git`);
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  git(repo, ['config', 'user.name', 'Swarm Test']);
  git(repo, ['config', 'user.email', 'swarm@example.test']);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base\n');
  git(repo, ['add', 'tracked.txt']);
  git(repo, ['commit', '-m', 'initial']);
  git(repo, ['remote', 'add', 'origin', pathToFileURL(remote).href]);
  git(repo, ['push', '-u', 'origin', 'main']);
  return { repo, remote };
}

function openDb(home: string): SwarmDb {
  return new DatabaseSync(path.join(home, '.swarm', 'swarm.db'));
}

function taskRow(db: SwarmDb, slug: string): any {
  return db.prepare('SELECT * FROM tasks WHERE swarm_id = ? AND id = ?').get('default', slug);
}

function seedPassVerdict(db: SwarmDb, slug: string): number {
  const task = taskRow(db, slug);
  const reviewer = db.prepare("SELECT * FROM agents WHERE name = 'Alice' COLLATE NOCASE").get() as any;
  const head = git(task.worktree_path, ['rev-parse', 'HEAD']);
  const tree = git(task.worktree_path, ['rev-parse', 'HEAD^{tree}']);
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  db.prepare('UPDATE tasks SET head_sha = ?, tree_sha = ? WHERE swarm_id = ? AND id = ?')
    .run(head, tree, 'default', slug);
  const qualification = db.prepare(`
    INSERT INTO reviewer_qualifications (
      swarm_id, agent_id, agent_name, family, worker_version, binary_sha256,
      model_id, harness_sha256, prompt_sha256, tools_sha256,
      qualified_by_agent_id, qualified_at, expires_at, revoked_at
    ) VALUES ('default', ?, ?, 'openai', ?, ?, 'fixture-model', ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    reviewer.id,
    reviewer.name,
    reviewer.worker_version,
    reviewer.worker_binary_sha256,
    'b'.repeat(64),
    'c'.repeat(64),
    'd'.repeat(64),
    reviewer.id,
    now,
    expires
  );
  const qualificationId = Number(qualification.lastInsertRowid);
  const request = db.prepare(`
    INSERT INTO review_requests (
      swarm_id, task_id, task_epoch, requester_agent_id, reviewer_agent_id,
      reviewer_name, author_family, reviewer_family, head_sha, tree_sha,
      qualification_id, brief_path, status, created_at, resolved_at
    ) VALUES ('default', ?, ?, ?, ?, ?, ?, 'openai', ?, ?, ?, 'fixture.md', 'passed', ?, ?)
  `).run(
    slug,
    task.lease_epoch,
    reviewer.id,
    reviewer.id,
    reviewer.name,
    task.author_family,
    head,
    tree,
    qualificationId,
    now,
    now
  );
  const verdict = db.prepare(`
    INSERT INTO review_verdicts (
      swarm_id, task_id, request_id, task_epoch, reviewer_agent_id,
      qualification_id, verdict, head_sha, tree_sha, report_path,
      report_sha256, submitted_at
    ) VALUES ('default', ?, ?, ?, ?, ?, 'pass', ?, ?, 'fixture.md', ?, ?)
  `).run(
    slug,
    Number(request.lastInsertRowid),
    task.lease_epoch,
    reviewer.id,
    qualificationId,
    head,
    tree,
    'e'.repeat(64),
    now
  );
  return Number(verdict.lastInsertRowid);
}

describe('WI-3 task ledger CLI', () => {
  let suiteRoot: string;

  before(() => {
    suiteRoot = fs.mkdtempSync(path.join(process.cwd(), '.wi3-tests-'));
  });

  after(() => {
    fs.rmSync(suiteRoot, { recursive: true, force: true });
  });

  test('task start teaches default and explicit claim contracts plus the no-worktree rescue tradeoff', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-wi3-start-teach-'));
    try {
      joinAgent(home, 'Alice');
      const defaultClaim = runCli(home, [
        'task', 'start', 'default-claim', '--title', 'Default claim', '--no-worktree',
      ], 'Alice');
      assert.strictEqual(defaultClaim.status, 0, defaultClaim.stderr || defaultClaim.stdout);
      assert.match(defaultClaim.stdout, /^claim: analysis — close requires: report$/m);
      assert.match(defaultClaim.stdout, /change claim: re-run 'swarm task start default-claim --claim <kind>'/);
      assert.match(
        defaultClaim.stdout,
        /^note: no worktree recorded — 'swarm rescue --task\/--agent' will refuse for this task; use 'swarm rescue --worktree <path>' for ad-hoc trees\.$/m
      );

      const explicitClaim = runCli(home, [
        'task', 'start', 'explicit-claim', '--title', 'Explicit claim', '--no-worktree', '--claim', 'journey-works',
      ], 'Alice');
      assert.strictEqual(explicitClaim.status, 0, explicitClaim.stderr || explicitClaim.stdout);
      assert.match(explicitClaim.stdout, /^claim: journey-works — close requires: journey$/m);

      joinAgent(home, 'Bob');
      const authority = runCli(home, ['authority', 'assign', 'lead', '--to', 'Bob'], 'Alice');
      assert.strictEqual(authority.status, 0, authority.stderr || authority.stdout);
      const changedAtTakeover = runCli(home, [
        'task', 'start', 'explicit-claim', '--takeover', '--no-worktree', '--claim', 'probe',
      ], 'Bob');
      assert.strictEqual(changedAtTakeover.status, 0, changedAtTakeover.stderr || changedAtTakeover.stdout);
      assert.match(changedAtTakeover.stdout, /^claim: probe — close requires: report$/m);
      const db = openDb(home);
      assert.strictEqual(taskRow(db, 'explicit-claim').claim_kind, 'probe');
      db.close();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('start → checkpoint → close uses a named canonical worktree and remote evidence', () => {
    const root = fs.mkdtempSync(path.join(suiteRoot, 'happy-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-wi3-home-'));
    try {
      const { repo } = createPushedRepo(root);
      joinAgent(home, 'Alice');

      const started = runCli(home, ['task', 'start', 'happy-path', '--title', 'Happy path', '--repo', repo], 'Alice');
      assert.strictEqual(started.status, 0, started.stderr || started.stdout);
      assert.match(started.stdout, /Branch: swarm\/Alice\/happy-path/);

      const db = openDb(home);
      const active = taskRow(db, 'happy-path');
      assert.strictEqual(active.state, 'active');
      assert.strictEqual(active.lease_epoch, 1);
      assert.strictEqual(active.claim_kind, 'code-merged');
      assert.strictEqual(active.branch, 'swarm/Alice/happy-path');
      assert.strictEqual(active.worktree_path, path.join(home, '.swarm', 'wt', 'repo', 'Alice--happy-path'));
      assert.ok(active.transcript_hint.includes(`cwd=${process.cwd()}`));
      assert.strictEqual(git(active.worktree_path, ['branch', '--show-current']), active.branch);
      db.close();

      const checkpoint = runCli(home, ['task', 'checkpoint', 'happy-path', '--notes', 'Keep the remote-reachable base commit.'], 'Alice');
      assert.strictEqual(checkpoint.status, 0, checkpoint.stderr || checkpoint.stdout);
      assert.match(checkpoint.stdout, /Checkpoint #001 recorded/);
      const checkpointPath = checkpoint.stdout.match(/recorded: (.+)$/m)?.[1];
      assert.ok(checkpointPath);
      const contents = fs.readFileSync(checkpointPath!, 'utf-8');
      assert.match(contents, /^# checkpoint happy-path #001$/m);
      assert.match(contents, /^## decisions \(\+why, \+rejected alternatives\)$/m);
      assert.match(contents, /^## failed approaches \(do-not-repeat\)$/m);
      assert.match(contents, /^## next action$/m);
      assert.match(contents, /^## blockers \/ landmines$/m);
      assert.match(contents, /Keep the remote-reachable base commit\./);
      assert.strictEqual((contents.match(/- none noted/g) ?? []).length, 3);
      assert.doesNotMatch(contents, /<FILL>/);

      const secondCheckpoint = runCli(home, ['task', 'checkpoint', 'happy-path', '--notes', 'Second phase boundary.'], 'Alice');
      assert.strictEqual(secondCheckpoint.status, 0, secondCheckpoint.stderr || secondCheckpoint.stdout);
      assert.match(secondCheckpoint.stdout, /Checkpoint #002 recorded: .*\/002\.md/);

      const evidenceDb = openDb(home);
      const verdictId = seedPassVerdict(evidenceDb, 'happy-path');
      evidenceDb.close();
      const closed = runCli(home, [
        'task', 'close', 'happy-path', '--disposition', 'pr',
        '--evidence', `verdict:${verdictId}`, '--not-established', 'none',
      ], 'Alice');
      assert.strictEqual(closed.status, 0, closed.stderr || closed.stdout);
      const verified = openDb(home);
      const done = taskRow(verified, 'happy-path');
      assert.strictEqual(done.state, 'done');
      assert.strictEqual(done.disposition, 'pr');
      assert.ok(!fs.existsSync(done.worktree_path));
      assert.ok(git(repo, ['show-ref', '--verify', 'refs/heads/swarm/Alice/happy-path']));
      verified.close();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('merged close refuses a feature-only push with source/target SHAs, then verifies the default branch before removing the worktree', () => {
    const root = fs.mkdtempSync(path.join(suiteRoot, 'merged-default-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-merged-default-home-'));
    try {
      const { repo } = createPushedRepo(root);
      joinAgent(home, 'Alice');
      const started = runCli(home, [
        'task', 'start', 'default-merged', '--title', 'Default branch merged', '--repo', repo,
      ], 'Alice');
      assert.strictEqual(started.status, 0, started.stderr || started.stdout);

      let db = openDb(home);
      const active = taskRow(db, 'default-merged');
      db.close();
      fs.appendFileSync(path.join(active.worktree_path, 'tracked.txt'), 'feature only\n');
      git(active.worktree_path, ['add', 'tracked.txt']);
      git(active.worktree_path, ['commit', '-m', 'feature-only commit']);
      git(active.worktree_path, ['push', '-u', 'origin', active.branch]);
      const sourceSha = git(active.worktree_path, ['rev-parse', 'HEAD']);
      const originalTargetSha = git(repo, ['rev-parse', 'origin/main']);
      db = openDb(home);
      const verdictId = seedPassVerdict(db, 'default-merged');
      db.close();

      const grant = runCli(home, [
        'grant', 'create', '--op', 'merge', '--resource', 'default-merged', '--ttl', '2h', '--to', 'Alice',
      ], 'Alice');
      assert.strictEqual(grant.status, 0, grant.stderr || grant.stdout);

      const refused = runCli(home, [
        'task', 'close', 'default-merged', '--disposition', 'merged', '--not-established', 'none',
        '--evidence', `verdict:${verdictId}`,
      ], 'Alice');
      assert.notStrictEqual(refused.status, 0);
      assert.match(refused.stderr, new RegExp(`source SHA ${sourceSha}`));
      assert.match(refused.stderr, /target ref origin\/main/);
      assert.match(refused.stderr, new RegExp(`target SHA ${originalTargetSha}`));
      assert.match(refused.stderr, /The commit is not on the target branch/);
      assert.ok(fs.existsSync(active.worktree_path), 'failed verification must leave the worktree in place');
      db = openDb(home);
      assert.strictEqual(taskRow(db, 'default-merged').state, 'active');
      db.close();

      git(repo, ['merge', '--ff-only', active.branch]);
      git(repo, ['push', 'origin', 'main']);
      const targetSha = git(repo, ['rev-parse', 'origin/main']);
      assert.strictEqual(targetSha, sourceSha);

      const closed = runCli(home, [
        'task', 'close', 'default-merged', '--disposition', 'merged', '--not-established', 'none',
        '--evidence', `verdict:${verdictId}`,
      ], 'Alice');
      assert.strictEqual(closed.status, 0, closed.stderr || closed.stdout);
      assert.match(
        closed.stdout,
        new RegExp(`disposition recorded: merged \\(verified: ${sourceSha} reachable from origin/main\\)`)
      );
      assert.ok(!fs.existsSync(active.worktree_path), 'worktree removal follows successful verification');
      db = openDb(home);
      assert.strictEqual(
        taskGitFacts(taskRow(db, 'default-merged')).head,
        sourceSha,
        'a removed/reopened worktree still resolves the durable task branch as its source commit'
      );
      db.close();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('default-branch resolution uses origin/HEAD, remote HEAD, then main and master fallbacks', () => {
    const sha = (digit: string) => digit.repeat(40);
    const runner = (responses: Record<string, string | null>): GitQueryRunner => (_cwd, args) =>
      responses[args.join(' ')] ?? null;

    assert.deepStrictEqual(resolveDefaultBranchTarget('/repo', runner({
      'symbolic-ref refs/remotes/origin/HEAD': 'refs/remotes/origin/trunk',
      'rev-parse --verify origin/trunk^{commit}': sha('1'),
    })), { ref: 'origin/trunk', sha: sha('1'), resolution: 'origin-head' });

    assert.deepStrictEqual(resolveDefaultBranchTarget('/repo', runner({
      'ls-remote --symref origin HEAD': `ref: refs/heads/release\tHEAD\n${sha('2')}\tHEAD`,
      'rev-parse --verify origin/release^{commit}': sha('2'),
    })), { ref: 'origin/release', sha: sha('2'), resolution: 'remote-head' });

    assert.deepStrictEqual(resolveDefaultBranchTarget('/repo', runner({
      'rev-parse --verify origin/main^{commit}': sha('3'),
      'rev-parse --verify origin/master^{commit}': sha('4'),
    })), { ref: 'origin/main', sha: sha('3'), resolution: 'main' });

    assert.deepStrictEqual(resolveDefaultBranchTarget('/repo', runner({
      'rev-parse --verify origin/master^{commit}': sha('4'),
    })), { ref: 'origin/master', sha: sha('4'), resolution: 'master' });
  });

  test('task reopen is fenced, bumps the epoch, audits the repair, returns to the active board, and refuses double reopen', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-reopen-'));
    const db = getDbAt(path.join(root, 'swarm.db'));
    const report = path.join(root, 'report.md');
    fs.writeFileSync(report, 'repair evidence\n');
    try {
      joinHeadlessAgent(db, 'default', 'Alice');
      joinHeadlessAgent(db, 'default', 'Bob');
      await startTask(db, 'default', 'Alice', 'repair-close', {
        title: 'Repair a close', noWorktree: true, claimKind: 'analysis',
      });
      await closeTask(db, 'default', 'Alice', 'repair-close', {
        disposition: 'archive', evidence: [`report:${report}`], notEstablished: 'runtime behavior',
      });

      await assert.rejects(
        reopenTask(db, 'default', 'Bob', 'repair-close', { reason: 'false disposition' }),
        /task reopen repair-close .* --takeover/
      );
      assert.strictEqual(taskRow(db, 'repair-close').state, 'done');

      const reopened = await reopenTask(db, 'default', 'Alice', 'repair-close', {
        reason: 'default branch verification was false',
      });
      assert.strictEqual(reopened.task.state, 'active');
      assert.strictEqual(reopened.task.lease_epoch, 2);
      assert.strictEqual(reopened.task.disposition, null);
      assert.strictEqual(reopened.priorDisposition, 'archive');
      const event = db.prepare(`
        SELECT epoch, actor, data FROM task_events
        WHERE task_id = 'repair-close' AND kind = 'reopened'
      `).get() as { epoch: number; actor: string; data: string };
      assert.strictEqual(event.epoch, 2);
      assert.strictEqual(event.actor, 'Alice');
      const aliceId = (db.prepare("SELECT id FROM agents WHERE name = 'Alice'")
        .get() as { id: string }).id;
      assert.deepStrictEqual(JSON.parse(event.data), {
        reason: 'default branch verification was false',
        prior_disposition: 'archive',
        previous_owner: 'Alice',
        previous_owner_agent_id: aliceId,
        owner_agent_id: aliceId,
        takeover: false,
      });
      const boardTask = collectBoardData(db, 'default').tasks.find(task => task.id === 'repair-close');
      assert.strictEqual(boardTask?.state, 'active');
      assert.strictEqual(boardTask?.leaseEpoch, 2);
      await assert.rejects(
        reopenTask(db, 'default', 'Alice', 'repair-close', { reason: 'again' }),
        /is active; reopen only accepts done or abandoned tasks/
      );

      await startTask(db, 'default', 'Alice', 'takeover-close', {
        title: 'Take over a closed task', noWorktree: true, claimKind: 'analysis',
      });
      await closeTask(db, 'default', 'Alice', 'takeover-close', {
        disposition: 'archive', evidence: [`report:${report}`], notEstablished: 'runtime behavior',
      });
      assignSwarmAuthority(db, 'default', 'Alice', 'lead', 'Bob');
      const taken = await reopenTask(db, 'default', 'Bob', 'takeover-close', {
        reason: 'new owner will repair', takeover: true,
      });
      assert.strictEqual(taken.task.owner_agent, 'Bob');
      assert.strictEqual(taken.task.lease_epoch, 2);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('checkpoint skeleton exits 2 until every exact <FILL> marker is edited', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-wi3-fill-'));
    try {
      joinAgent(home, 'Alice');
      assert.strictEqual(runCli(home, ['task', 'start', 'fill-gate', '--title', 'Fill gate', '--no-worktree'], 'Alice').status, 0);
      const first = runCli(home, ['task', 'checkpoint', 'fill-gate'], 'Alice');
      assert.strictEqual(first.status, 2, first.stderr || first.stdout);
      assert.match(first.stderr, /Edit every <FILL> marker/);
      const checkpointPath = first.stdout.match(/Checkpoint skeleton: (.+)$/m)?.[1];
      assert.ok(checkpointPath);
      let contents = fs.readFileSync(checkpointPath!, 'utf-8');
      assert.strictEqual((contents.match(/<FILL>/g) ?? []).length, 4);
      for (const replacement of ['Decision and why', '- none', 'Implement the next slice', '- none']) {
        contents = contents.replace('<FILL>', replacement);
      }
      fs.writeFileSync(checkpointPath!, contents);

      const second = runCli(home, ['task', 'checkpoint', 'fill-gate'], 'Alice');
      assert.strictEqual(second.status, 0, second.stderr || second.stdout);
      assert.match(second.stdout, /Checkpoint #001 recorded/);
      const db = openDb(home);
      const count = db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id = 'fill-gate' AND kind = 'checkpoint'").get() as { n: number };
      assert.strictEqual(count.n, 1);
      db.close();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('takeover never adopts an unrecorded prior-owner checkpoint draft into a handoff charter', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-wi3-draft-fence-'));
    try {
      joinAgent(home, 'Alice');
      joinAgent(home, 'Bob');
      joinAgent(home, 'Recipient');
      assert.strictEqual(
        runCli(home, ['authority', 'assign', 'lead', '--to', 'Bob'], 'Alice').status,
        0
      );
      assert.strictEqual(
        runCli(
          home,
          ['task', 'start', 'draft-fence', '--title', 'Fence draft provenance', '--no-worktree'],
          'Alice'
        ).status,
        0
      );

      const aliceDraft = runCli(home, ['task', 'checkpoint', 'draft-fence'], 'Alice');
      assert.strictEqual(aliceDraft.status, 2, aliceDraft.stderr || aliceDraft.stdout);
      const alicePath = aliceDraft.stdout.match(/Checkpoint skeleton: (.+)$/m)?.[1];
      assert.ok(alicePath);
      let stale = fs.readFileSync(alicePath!, 'utf-8');
      for (const replacement of [
        'STALE PRIOR OWNER DECISION',
        '- stale failure',
        'STALE PRIOR OWNER NEXT ACTION',
        '- stale blocker',
      ]) {
        stale = stale.replace('<FILL>', replacement);
      }
      fs.writeFileSync(alicePath!, stale);

      const takeover = runCli(
        home,
        ['task', 'start', 'draft-fence', '--takeover', '--no-worktree'],
        'Bob'
      );
      assert.strictEqual(takeover.status, 0, takeover.stderr || takeover.stdout);
      const bobDraft = runCli(home, ['task', 'checkpoint', 'draft-fence'], 'Bob');
      assert.strictEqual(bobDraft.status, 2, bobDraft.stderr || bobDraft.stdout);
      const bobPath = bobDraft.stdout.match(/Checkpoint skeleton: (.+)$/m)?.[1];
      assert.ok(bobPath);
      assert.notStrictEqual(bobPath, alicePath);
      assert.match(fs.readFileSync(alicePath!, 'utf-8'), /STALE PRIOR OWNER DECISION/);

      const recorded = runCli(
        home,
        ['task', 'checkpoint', 'draft-fence', '--notes', 'Fresh Bob-owned charter.'],
        'Bob'
      );
      assert.strictEqual(recorded.status, 0, recorded.stderr || recorded.stdout);
      assert.match(recorded.stdout, /Checkpoint #002 recorded/);
      const offered = runCli(
        home,
        ['handoff', 'offer', 'draft-fence', '--to', 'Recipient'],
        'Bob'
      );
      assert.strictEqual(offered.status, 0, offered.stderr || offered.stdout);
      const briefPath = offered.stdout.match(/^Brief: (.+)$/m)?.[1];
      assert.ok(briefPath);
      const charter = fs.readFileSync(briefPath!, 'utf-8');
      assert.match(charter, /Fresh Bob-owned charter/);
      assert.doesNotMatch(charter, /STALE PRIOR OWNER/);

      const db = openDb(home);
      const drafts = db.prepare(`
        SELECT epoch, actor, actor_agent_id, data
        FROM task_events
        WHERE task_id = 'draft-fence' AND kind = 'checkpoint_draft_created'
        ORDER BY id
      `).all() as Array<{
        epoch: number;
        actor: string;
        actor_agent_id: string;
        data: string;
      }>;
      assert.deepStrictEqual(drafts.map(row => [row.epoch, row.actor]), [
        [1, 'Alice'],
        [2, 'Bob'],
      ]);
      assert.notStrictEqual(drafts[0].actor_agent_id, drafts[1].actor_agent_id);
      assert.strictEqual(JSON.parse(drafts[0].data).path, alicePath);
      assert.strictEqual(JSON.parse(drafts[1].data).path, bobPath);
      db.close();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('draft generation binding rejects a delayed prior-owner overwrite after takeover', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-wi3-draft-race-'));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    fs.mkdirSync(path.join(home, '.swarm'), { recursive: true });
    const db = getDbAt(path.join(home, '.swarm', 'swarm.db'));
    const originalWrite = fs.writeFileSync;
    let takeoverPromise: ReturnType<typeof startTask> | undefined;
    let bobDraft: ReturnType<typeof checkpointTask> | undefined;
    let briefPath: string | undefined;
    try {
      joinHeadlessAgent(db, 'default', 'Alice');
      joinHeadlessAgent(db, 'default', 'Bob');
      joinHeadlessAgent(db, 'default', 'Recipient');
      assignSwarmAuthority(db, 'default', 'Alice', 'lead', 'Bob');
      await startTask(db, 'default', 'Alice', 'draft-race', {
        title: 'Fence delayed checkpoint writes',
        noWorktree: true,
      });

      let armed = true;
      fs.writeFileSync = function patchedWriteFileSync(
        file: fs.PathOrFileDescriptor,
        data: string | NodeJS.ArrayBufferView,
        options?: fs.WriteFileOptions
      ): void {
        if (armed && String(file).endsWith('/001.md')) {
          armed = false;
          // startTask commits the takeover synchronously before its first await.
          takeoverPromise = startTask(db, 'default', 'Bob', 'draft-race', {
            takeover: true,
            noWorktree: true,
          });
          bobDraft = checkpointTask(db, 'default', 'Bob', 'draft-race');
        }
        originalWrite.call(fs, file, data, options);
      } as typeof fs.writeFileSync;

      assert.throws(
        () => checkpointTask(
          db,
          'default',
          'Alice',
          'draft-race',
          'STALE ALICE DECISION'
        ),
        /Refused stale task authority/
      );
      fs.writeFileSync = originalWrite;
      await takeoverPromise;
      assert.ok(bobDraft);
      assert.match(fs.readFileSync(bobDraft.path, 'utf-8'), /STALE ALICE DECISION/);

      const recovered = checkpointTask(db, 'default', 'Bob', 'draft-race');
      assert.strictEqual(recovered.recorded, false);
      assert.notStrictEqual(recovered.path, bobDraft.path);
      assert.doesNotMatch(fs.readFileSync(recovered.path, 'utf-8'), /STALE ALICE DECISION/);

      const fresh = checkpointTask(
        db,
        'default',
        'Bob',
        'draft-race',
        'FRESH BOB DECISION'
      );
      assert.strictEqual(fresh.recorded, true);
      assert.strictEqual(fresh.path, recovered.path);
      const freshBody = fs.readFileSync(fresh.path, 'utf-8');
      fs.writeFileSync(fresh.path, `${freshBody}\nSTALE ALICE DECISION AFTER RECORD\n`);
      await assert.rejects(
        offerTaskHandoff(
          db,
          'default',
          'Bob',
          'draft-race',
          'Recipient'
        ),
        /checkpoint bytes no longer match the recorded owner\/epoch generation and digest/
      );
      fs.writeFileSync(fresh.path, freshBody);
      const offered = await offerTaskHandoff(
        db,
        'default',
        'Bob',
        'draft-race',
        'Recipient'
      );
      briefPath = offered.briefPath;
      const charter = fs.readFileSync(offered.briefPath, 'utf-8');
      assert.match(charter, /FRESH BOB DECISION/);
      assert.doesNotMatch(charter, /STALE ALICE DECISION/);
    } finally {
      fs.writeFileSync = originalWrite;
      if (briefPath) fs.rmSync(briefPath, { force: true });
      db.close();
      process.env.HOME = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('takeover bumps the epoch and fences both checkpoint and close with refusal events', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-wi3-fence-'));
    try {
      joinAgent(home, 'Alice');
      joinAgent(home, 'Bob');
      const authority = runCli(home, ['authority', 'assign', 'lead', '--to', 'Bob'], 'Alice');
      assert.strictEqual(authority.status, 0, authority.stderr || authority.stdout);
      assert.strictEqual(runCli(home, ['task', 'start', 'fenced-task', '--title', 'Fence me', '--no-worktree'], 'Alice').status, 0);

      const blocked = runCli(home, ['task', 'start', 'fenced-task', '--no-worktree'], 'Bob');
      assert.notStrictEqual(blocked.status, 0);
      assert.match(blocked.stderr, /--takeover/);
      const claimed = runCli(home, ['task', 'start', 'fenced-task', '--takeover', '--no-worktree'], 'Bob');
      assert.strictEqual(claimed.status, 0, claimed.stderr || claimed.stdout);
      assert.match(claimed.stdout, /lease epoch 2/);

      const staleCheckpoint = runCli(home, ['task', 'checkpoint', 'fenced-task', '--notes', 'stale'], 'Alice');
      const staleClose = runCli(home, ['task', 'close', 'fenced-task', '--disposition', 'archive', '--not-established', 'none'], 'Alice');
      assert.notStrictEqual(staleCheckpoint.status, 0);
      assert.notStrictEqual(staleClose.status, 0);
      assert.match(staleCheckpoint.stderr, /Refused stale task authority.*owner is "Bob".*epoch 2/s);
      assert.match(staleClose.stderr, /Refused stale task authority.*owner is "Bob".*epoch 2/s);

      const db = openDb(home);
      const task = taskRow(db, 'fenced-task');
      assert.strictEqual(task.owner_agent, 'Bob');
      assert.strictEqual(task.lease_epoch, 2);
      const refused = db.prepare("SELECT kind, actor FROM task_events WHERE task_id = 'fenced-task' AND kind = 'refused_stale_epoch' ORDER BY id").all() as any[];
      assert.deepStrictEqual(refused.map(row => row.actor), ['Alice', 'Alice']);
      const notice = db.prepare("SELECT kind, body FROM messages WHERE to_agent = 'Alice' COLLATE NOCASE").get() as any;
      assert.strictEqual(notice.kind, 'handoff');
      assert.match(notice.body, /prior task authority is fenced/);
      db.close();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('close refusal reports exact unpushed, dirty tracked, and untracked counts; force discard is double-confirmed and logged', () => {
    const root = fs.mkdtempSync(path.join(suiteRoot, 'counts-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-wi3-counts-'));
    try {
      const { repo } = createPushedRepo(root);
      joinAgent(home, 'Alice');
      assert.strictEqual(runCli(home, ['task', 'start', 'count-state', '--title', 'Count state', '--repo', repo], 'Alice').status, 0);
      const db = openDb(home);
      const task = taskRow(db, 'count-state');
      db.close();
      fs.writeFileSync(path.join(task.worktree_path, 'committed.txt'), 'commit\n');
      git(task.worktree_path, ['add', 'committed.txt']);
      git(task.worktree_path, ['config', 'user.name', 'Swarm Test']);
      git(task.worktree_path, ['config', 'user.email', 'swarm@example.test']);
      git(task.worktree_path, ['commit', '-m', 'local only']);
      const verdictDb = openDb(home);
      const verdictId = seedPassVerdict(verdictDb, 'count-state');
      verdictDb.close();
      fs.appendFileSync(path.join(task.worktree_path, 'tracked.txt'), 'dirty\n');
      fs.writeFileSync(path.join(task.worktree_path, 'untracked.txt'), 'untracked\n');

      const refused = runCli(home, [
        'task', 'close', 'count-state', '--disposition', 'pr',
        '--evidence', `verdict:${verdictId}`, '--not-established', 'none',
      ], 'Alice');
      assert.notStrictEqual(refused.status, 0);
      assert.match(refused.stderr, /unpushed commits: 1, dirty tracked files: 1, untracked files: 1/);

      const singleConfirm = runCli(home, ['task', 'close', 'count-state', '--disposition', 'discard', '--not-established', 'none'], 'Alice');
      assert.notStrictEqual(singleConfirm.status, 0);
      assert.match(singleConfirm.stderr, /requires both --disposition discard and --force-discard/);
      const discarded = runCli(home, ['task', 'close', 'count-state', '--disposition', 'discard', '--force-discard', '--not-established', 'none'], 'Alice');
      assert.strictEqual(discarded.status, 0, discarded.stderr || discarded.stdout);
      const after = openDb(home);
      const forceEvent = after.prepare("SELECT data FROM task_events WHERE task_id = 'count-state' AND kind = 'force_discard'").get() as { data: string };
      assert.deepStrictEqual(JSON.parse(forceEvent.data), { unpushed: 1, dirty_tracked: 1, untracked: 1 });
      after.close();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('T8 forced discard bypasses analysis evidence while plain discard still refuses', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-t8-discard-'));
    try {
      joinAgent(home, 'Alice');
      const started = runCli(home, [
        'task', 'start', 'void-analysis', '--title', 'Void analysis', '--no-worktree',
      ], 'Alice');
      assert.strictEqual(started.status, 0, started.stderr || started.stdout);

      const missingCeiling = runCli(home, [
        'task', 'close', 'void-analysis', '--disposition', 'discard', '--force-discard',
      ], 'Alice');
      assert.notStrictEqual(missingCeiling.status, 0);
      assert.match(missingCeiling.stderr, /requires --not-established/);

      const refused = runCli(home, [
        'task', 'close', 'void-analysis', '--disposition', 'discard',
        '--not-established', 'analysis intentionally voided',
      ], 'Alice');
      assert.notStrictEqual(refused.status, 0);
      assert.match(refused.stderr, /requires both --disposition discard and --force-discard/);

      const discarded = runCli(home, [
        'task', 'close', 'void-analysis', '--disposition', 'discard', '--force-discard',
        '--not-established', 'analysis intentionally voided',
      ], 'Alice');
      assert.strictEqual(discarded.status, 0, discarded.stderr || discarded.stdout);

      const db = openDb(home);
      assert.strictEqual(taskRow(db, 'void-analysis').state, 'done');
      const forceEvent = db.prepare(
        "SELECT data FROM task_events WHERE task_id = 'void-analysis' AND kind = 'force_discard'"
      ).get() as { data: string };
      assert.deepStrictEqual(JSON.parse(forceEvent.data), {
        unpushed: 0,
        dirty_tracked: 0,
        untracked: 0,
      });
      assert.strictEqual((db.prepare(
        "SELECT count(*) AS n FROM task_events WHERE task_id = 'void-analysis' AND kind = 'close_evidence'"
      ).get() as { n: number }).n, 0);
      db.close();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('a verified task rescue permits archive close with dirty state and removes the preserved worktree', () => {
    const root = fs.mkdtempSync(path.join(suiteRoot, 'archive-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-wi3-archive-'));
    try {
      const { repo } = createPushedRepo(root);
      joinAgent(home, 'Alice');
      assert.strictEqual(runCli(home, ['task', 'start', 'archive-it', '--title', 'Archive it', '--repo', repo], 'Alice').status, 0);
      const db = openDb(home);
      const task = taskRow(db, 'archive-it');
      db.close();
      fs.appendFileSync(path.join(task.worktree_path, 'tracked.txt'), 'dirty\n');
      fs.writeFileSync(path.join(task.worktree_path, 'untracked.txt'), 'preserve\n');

      const rescued = runCli(home, ['rescue', '--task', 'archive-it'], 'Alice');
      assert.strictEqual(rescued.status, 0, rescued.stderr || rescued.stdout);
      const artifactDir = rescued.stdout.match(/Rescue verified: (.+)$/m)?.[1];
      assert.ok(artifactDir);
      const manifest = JSON.parse(fs.readFileSync(path.join(artifactDir!, 'manifest.json'), 'utf-8'));
      assert.strictEqual(manifest.verified, true);
      assert.strictEqual(manifest.attribution.task_id, 'archive-it');
      assert.strictEqual(manifest.attribution.agent, 'Alice');

      const closed = runCli(home, ['task', 'close', 'archive-it', '--disposition', 'archive', '--not-established', 'none'], 'Alice');
      assert.strictEqual(closed.status, 0, closed.stderr || closed.stdout);
      assert.ok(!fs.existsSync(task.worktree_path));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('starting against an existing canonical branch reclaims it into a fresh worktree', () => {
    const root = fs.mkdtempSync(path.join(suiteRoot, 'reclaim-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-wi3-reclaim-'));
    try {
      const { repo } = createPushedRepo(root);
      joinAgent(home, 'Alice');
      assert.strictEqual(runCli(home, ['task', 'start', 'branch-reclaim', '--title', 'Reclaim branch', '--repo', repo], 'Alice').status, 0);
      let db = openDb(home);
      const first = taskRow(db, 'branch-reclaim');
      db.close();
      fs.rmSync(first.worktree_path, { recursive: true, force: true });
      assert.ok(!fs.existsSync(first.worktree_path));
      assert.ok(git(repo, ['show-ref', '--verify', 'refs/heads/swarm/Alice/branch-reclaim']));

      const restarted = runCli(home, ['task', 'start', 'branch-reclaim', '--repo', repo], 'Alice');
      assert.strictEqual(restarted.status, 0, restarted.stderr || restarted.stdout);
      db = openDb(home);
      const reclaimed = taskRow(db, 'branch-reclaim');
      assert.strictEqual(reclaimed.lease_epoch, 2);
      assert.ok(fs.existsSync(reclaimed.worktree_path));
      assert.strictEqual(git(reclaimed.worktree_path, ['branch', '--show-current']), 'swarm/Alice/branch-reclaim');
      db.close();
      const cleanup = runCli(home, ['task', 'close', 'branch-reclaim', '--disposition', 'discard', '--force-discard', '--not-established', 'none'], 'Alice');
      assert.strictEqual(cleanup.status, 0, cleanup.stderr || cleanup.stdout);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('--agent rescues every recorded task worktree, including clean worktrees with empty untracked archives', () => {
    const root = fs.mkdtempSync(path.join(suiteRoot, 'agent-rescue-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-wi3-agent-rescue-'));
    try {
      const firstRepo = createPushedRepo(root, 'repo-a').repo;
      const secondRepo = createPushedRepo(root, 'repo-b').repo;
      joinAgent(home, 'Alice');
      assert.strictEqual(runCli(home, ['task', 'start', 'agent-one', '--title', 'One', '--repo', firstRepo], 'Alice').status, 0);
      assert.strictEqual(runCli(home, ['task', 'start', 'agent-two', '--title', 'Two', '--repo', secondRepo], 'Alice').status, 0);

      const rescued = runCli(home, ['rescue', '--agent', 'alice'], 'Alice');
      assert.strictEqual(rescued.status, 0, rescued.stderr || rescued.stdout);
      const dirs = [...rescued.stdout.matchAll(/Rescue verified: (.+)$/gm)].map(match => match[1]);
      assert.strictEqual(dirs.length, 2);
      for (const artifactDir of dirs) {
        const manifest = JSON.parse(fs.readFileSync(path.join(artifactDir, 'manifest.json'), 'utf-8'));
        assert.strictEqual(manifest.verified, true);
        assert.strictEqual(manifest.attribution.agent, 'Alice');
        assert.strictEqual(manifest.counts.untracked, 0);
      }

      const evidenceDb = openDb(home);
      const firstVerdict = seedPassVerdict(evidenceDb, 'agent-one');
      const secondVerdict = seedPassVerdict(evidenceDb, 'agent-two');
      evidenceDb.close();
      assert.strictEqual(runCli(home, [
        'task', 'close', 'agent-one', '--disposition', 'pr',
        '--evidence', `verdict:${firstVerdict}`, '--not-established', 'none',
      ], 'Alice').status, 0);
      assert.strictEqual(runCli(home, [
        'task', 'close', 'agent-two', '--disposition', 'pr',
        '--evidence', `verdict:${secondVerdict}`, '--not-established', 'none',
      ], 'Alice').status, 0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('two-phase handoff enforces freshness, labels stale charters, and removes the immediate-transfer bypass', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-wi3-handoff-'));
    try {
      joinAgent(home, 'Alice');
      joinAgent(home, 'Bob');
      assert.strictEqual(runCli(home, ['task', 'start', 'handoff-me', '--title', 'Context transfer', '--no-worktree'], 'Alice').status, 0);
      assert.strictEqual(runCli(home, ['task', 'checkpoint', 'handoff-me', '--notes', 'Use the ledger.'], 'Alice').status, 0);
      const db = openDb(home);
      db.prepare("UPDATE task_events SET created_at = ? WHERE task_id = 'handoff-me' AND kind = 'checkpoint'")
        .run(new Date(Date.now() - 61 * 60_000).toISOString());
      db.close();

      const legacy = runCli(home, ['handoff', 'handoff-me', '--to', 'Bob'], 'Alice');
      assert.notStrictEqual(legacy.status, 0);
      assert.match(legacy.stderr, /Immediate handoff is not supported/);
      let before = openDb(home);
      assert.deepStrictEqual(
        { ...before.prepare("SELECT owner_agent, lease_epoch FROM tasks WHERE id = 'handoff-me'").get() as object },
        { owner_agent: 'Alice', lease_epoch: 1 }
      );
      before.close();

      const refused = runCli(home, ['handoff', 'offer', 'handoff-me', '--to', 'Bob'], 'Alice');
      assert.notStrictEqual(refused.status, 0);
      assert.match(refused.stderr, /checkpoint is 61m old.*--stale-ok/s);
      const handed = runCli(home, [
        'handoff', 'offer', 'handoff-me', '--to', 'Bob', '--stale-ok',
      ], 'Alice');
      assert.strictEqual(handed.status, 0, handed.stderr || handed.stdout);
      assert.match(handed.stdout, /retains lease epoch 1 until acceptance/);
      assert.match(handed.stdout, /\(STALE\)/);
      const briefPath = handed.stdout.match(/Brief: (.+) \(STALE\)$/m)?.[1];
      const offerId = Number(handed.stdout.match(/Handoff offer #(\d+)/)?.[1]);
      assert.ok(briefPath);
      assert.ok(offerId > 0);
      assert.match(fs.readFileSync(briefPath!, 'utf-8'), /^# STALE Context transfer$/m);

      let after = openDb(home);
      let task = taskRow(after, 'handoff-me');
      assert.strictEqual(task.owner_agent, 'Alice');
      assert.strictEqual(task.lease_epoch, 1);
      const pointer = after.prepare(
        "SELECT body, kind FROM messages WHERE to_agent = 'Bob' COLLATE NOCASE AND kind = 'handoff'"
      ).get() as any;
      assert.strictEqual(pointer.kind, 'handoff');
      assert.ok(pointer.body.includes(briefPath));
      assert.strictEqual(pointer.body.split('\n').length, 1);
      assert.doesNotMatch(pointer.body, /## latest checkpoint/);
      after.close();

      const accepted = runCli(home, [
        'handoff', 'accept', 'handoff-me', '--offer', String(offerId),
      ], 'Bob');
      assert.strictEqual(accepted.status, 0, accepted.stderr || accepted.stdout);
      assert.match(accepted.stdout, /lease epoch 2/);
      after = openDb(home);
      task = taskRow(after, 'handoff-me');
      assert.strictEqual(task.owner_agent, 'Bob');
      assert.strictEqual(task.lease_epoch, 2);
      after.close();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('hook renders owner-only next action and stale nag, with zero task output for non-owner', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-wi3-hook-'));
    try {
      joinAgent(home, 'Alice');
      joinAgent(home, 'Bob');
      assert.strictEqual(runCli(home, ['task', 'start', 'hook-task', '--title', 'Hook task', '--no-worktree'], 'Alice').status, 0);
      const first = runCli(home, ['task', 'checkpoint', 'hook-task'], 'Alice');
      const checkpointPath = first.stdout.match(/Checkpoint skeleton: (.+)$/m)?.[1];
      assert.ok(checkpointPath);
      let checkpoint = fs.readFileSync(checkpointPath!, 'utf-8');
      for (const replacement of ['Decision', '- none', 'Ship the verified patch', '- none']) checkpoint = checkpoint.replace('<FILL>', replacement);
      fs.writeFileSync(checkpointPath!, checkpoint);
      assert.strictEqual(runCli(home, ['task', 'checkpoint', 'hook-task'], 'Alice').status, 0);
      const db = openDb(home);
      db.prepare("UPDATE task_events SET created_at = ? WHERE task_id = 'hook-task' AND kind = 'checkpoint'")
        .run(new Date(Date.now() - 94 * 60_000).toISOString());
      db.close();

      const ownerHook = runCli(home, ['hook-context'], 'Alice');
      assert.strictEqual(ownerHook.status, 0, ownerHook.stderr || ownerHook.stdout);
      assert.match(ownerHook.stdout, /Your task: hook-task \[active\] — last checkpoint 94m ago \(stale — swarm task checkpoint hook-task\); next: Ship the verified patch/);
      const otherHook = runCli(home, ['hook-context'], 'Bob');
      assert.strictEqual(otherHook.status, 0, otherHook.stderr || otherHook.stdout);
      assert.doesNotMatch(otherHook.stdout, /Your task:/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('decisions supersede only within a swarm and both reset paths preserve the full ledger', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-wi3-reset-'));
    try {
      joinAgent(home, 'Alice');
      assert.strictEqual(runCli(home, ['task', 'start', 'reset-ledger', '--title', 'Durable ledger', '--no-worktree'], 'Alice').status, 0);
      assert.strictEqual(runCli(home, ['task', 'checkpoint', 'reset-ledger', '--notes', 'Preserve it.'], 'Alice').status, 0);
      const first = runCli(home, ['decision', 'DECISION: keep ledger BECAUSE resets are hygiene', '--task', 'reset-ledger'], 'Alice');
      assert.strictEqual(first.status, 0, first.stderr || first.stdout);
      const firstId = Number(first.stdout.match(/#(\d+)/)?.[1]);
      const second = runCli(home, ['decision', 'DECISION: keep all rows BECAUSE history matters', '--task', 'reset-ledger', '--supersedes', String(firstId)], 'Alice');
      assert.strictEqual(second.status, 0, second.stderr || second.stdout);
      const preResetGrant = runCli(home, [
        'grant', 'create', '--op', 'override', '--resource', '*', '--ttl', '2h',
      ], 'Alice');
      assert.strictEqual(preResetGrant.status, 0, preResetGrant.stderr || preResetGrant.stdout);
      const preResetGrantId = Number(preResetGrant.stdout.match(/Grant #(\d+)/)?.[1]);

      let db = openDb(home);
      const foreignId = Number(db.prepare(`
        INSERT INTO decisions (swarm_id, task_id, body, made_by, supersedes, status, created_at)
        VALUES ('another-swarm', NULL, 'foreign', 'Elsewhere', NULL, 'active', ?)
      `).run(new Date().toISOString()).lastInsertRowid);
      db.close();
      const crossSwarm = runCli(home, ['decision', 'must fail', '--supersedes', String(foreignId)], 'Alice');
      assert.notStrictEqual(crossSwarm.status, 0);
      assert.match(crossSwarm.stderr, /does not exist in this swarm/);
      db = openDb(home);
      db.prepare('DELETE FROM decisions WHERE id = ?').run(foreignId);
      db.close();

      assert.strictEqual(runCli(home, ['reset'], 'Alice').status, 0);
      db = openDb(home);
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1);
      assert.ok((db.prepare('SELECT COUNT(*) AS n FROM task_events').get() as any).n >= 2);
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM decisions').get().n, 2);
      assert.strictEqual((db.prepare('SELECT status FROM decisions WHERE id = ?').get(firstId) as any).status, 'superseded');
      assert.ok(
        (db.prepare('SELECT revoked_at FROM grants WHERE id = ?').get(preResetGrantId) as any).revoked_at,
        'reset must revoke wildcard grants before a new registration epoch bootstraps'
      );
      db.close();

      joinAgent(home, 'Bob');
      const recovered = runCli(home, [
        'task', 'start', 'reset-ledger', '--takeover', '--no-worktree',
      ], 'Bob');
      assert.strictEqual(recovered.status, 0, recovered.stderr || recovered.stdout);
      const authority = runCli(home, ['authority', 'show'], 'Bob');
      assert.strictEqual(authority.status, 0, authority.stderr || authority.stdout);
      assert.match(authority.stdout, /owner: Bob .*\(active; bootstrap;/s);
      assert.match(authority.stdout, /lead: Bob .*\(active; bootstrap;/s);

      assert.strictEqual(runCli(home, ['reset', '--all']).status, 0);
      joinAgent(home, 'Carol');
      const recoveredAgain = runCli(home, [
        'task', 'start', 'reset-ledger', '--takeover', '--no-worktree',
      ], 'Carol');
      assert.strictEqual(recoveredAgain.status, 0, recoveredAgain.stderr || recoveredAgain.stdout);
      db = openDb(home);
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1);
      assert.ok((db.prepare('SELECT COUNT(*) AS n FROM task_events').get() as any).n >= 2);
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM decisions').get().n, 2);
      db.close();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('worktree creation refuses /private/tmp while --no-worktree skips git entirely', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-wi3-path-'));
    const repo = fs.mkdtempSync('/private/tmp/swarm-wi3-repo-');
    try {
      execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
      joinAgent(home, 'Alice');
      const refused = runCli(home, ['task', 'start', 'tmp-refuse', '--title', 'Temporary', '--repo', repo], 'Alice');
      assert.notStrictEqual(refused.status, 0);
      assert.match(refused.stderr, /Refusing task worktree creation from temporary repository/);

      const skipped = runCli(home, ['task', 'start', 'tmp-skip', '--title', 'No git', '--repo', path.join(repo, 'does-not-exist'), '--no-worktree'], 'Alice');
      assert.strictEqual(skipped.status, 0, skipped.stderr || skipped.stdout);
      const db = openDb(home);
      const task = taskRow(db, 'tmp-skip');
      assert.strictEqual(task.branch, null);
      assert.strictEqual(task.worktree_path, null);
      db.close();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('task list and task show expose the durable ledger without changing it', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-wi3-inspect-'));
    try {
      joinAgent(home, 'Alice');
      assert.strictEqual(runCli(home, ['task', 'start', 'inspect-me', '--title', 'Inspect ledger', '--no-worktree'], 'Alice').status, 0);
      assert.strictEqual(runCli(home, ['task', 'checkpoint', 'inspect-me', '--notes', 'Keep inspecting.'], 'Alice').status, 0);
      assert.strictEqual(runCli(home, ['decision', 'DECISION: expose history BECAUSE operators need it', '--task', 'inspect-me'], 'Alice').status, 0);

      const db = openDb(home);
      const before = JSON.stringify({
        tasks: db.prepare('SELECT * FROM tasks ORDER BY id').all(),
        events: db.prepare('SELECT * FROM task_events ORDER BY id').all(),
        decisions: db.prepare('SELECT * FROM decisions ORDER BY id').all(),
      });
      db.close();

      const list = runCli(home, ['task', 'list'], 'Alice');
      assert.strictEqual(list.status, 0, list.stderr || list.stdout);
      assert.match(list.stdout, /inspect-me \[active\] \u2014 Alice\(1\) \u2014 Inspect ledger/);
      const show = runCli(home, ['task', 'show', 'inspect-me'], 'Alice');
      assert.strictEqual(show.status, 0, show.stderr || show.stdout);
      assert.match(show.stdout, /inspect-me: Inspect ledger/);
      assert.match(show.stdout, /checkpoint by Alice @1/);
      assert.match(show.stdout, /DECISION: expose history BECAUSE operators need it/);

      const afterDb = openDb(home);
      const after = JSON.stringify({
        tasks: afterDb.prepare('SELECT * FROM tasks ORDER BY id').all(),
        events: afterDb.prepare('SELECT * FROM task_events ORDER BY id').all(),
        decisions: afterDb.prepare('SELECT * FROM decisions ORDER BY id').all(),
      });
      afterDb.close();
      assert.strictEqual(after, before);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('T1 claim matrix accepts matching evidence and refuses wrong kinds, missing files, and missing decisions', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-t1-matrix-'));
    const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-t1-evidence-'));
    try {
      joinAgent(home, 'Alice');
      const report = path.join(evidenceRoot, 'report.md');
      const journey = path.join(evidenceRoot, 'journey.log');
      const health = path.join(evidenceRoot, 'health.log');
      fs.writeFileSync(report, '# findings\nEstablished by the analysis.\n');
      fs.writeFileSync(journey, 'opened /login and completed the journey\n');
      fs.writeFileSync(health, 'GET /health 200\n');
      const missing = path.join(evidenceRoot, 'missing.log');

      const invalidClaim = runCli(home, [
        'task', 'start', 'bad-claim', '--title', 'Bad', '--no-worktree', '--claim', 'wishful-thinking',
      ], 'Alice');
      assert.notStrictEqual(invalidClaim.status, 0);
      assert.match(invalidClaim.stderr, /Invalid --claim.*code-merged.*journey-works.*deploy-healthy.*analysis.*decision.*probe/s);

      const codeWithoutIdentity = runCli(home, [
        'task', 'start', 'code-claim', '--title', 'Code', '--no-worktree', '--claim', 'code-merged',
      ], 'Alice');
      assert.notStrictEqual(codeWithoutIdentity.status, 0);
      assert.match(codeWithoutIdentity.stderr, /requires --repo and an isolated named worktree/);

      assert.strictEqual(runCli(home, [
        'task', 'start', 'journey-claim', '--title', 'Journey', '--no-worktree', '--claim', 'journey-works',
      ], 'Alice').status, 0);
      const journeyWrong = runCli(home, [
        'task', 'close', 'journey-claim', '--disposition', 'archive', '--evidence', `report:${report}`, '--not-established', 'none',
      ], 'Alice');
      assert.notStrictEqual(journeyWrong.status, 0);
      assert.match(journeyWrong.stderr, /claim "journey-works" expects evidence kind\(s\): journey; received "report"/);
      const journeyMissing = runCli(home, [
        'task', 'close', 'journey-claim', '--disposition', 'archive', '--evidence', `journey:${missing}`, '--not-established', 'none',
      ], 'Alice');
      assert.notStrictEqual(journeyMissing.status, 0);
      assert.match(journeyMissing.stderr, /journey evidence file .* does not exist.*--evidence journey:/s);
      assert.strictEqual(runCli(home, [
        'task', 'close', 'journey-claim', '--disposition', 'archive', '--evidence', `journey:${journey}`, '--not-established', 'visual polish',
      ], 'Alice').status, 0);
      assert.strictEqual(runCli(home, [
        'task', 'start', 'journey-url', '--title', 'Journey URL', '--no-worktree', '--claim', 'journey-works',
      ], 'Alice').status, 0);
      assert.strictEqual(runCli(home, [
        'task', 'close', 'journey-url', '--disposition', 'archive',
        '--evidence', 'journey:https://evidence.example/run/42', '--not-established', 'cross-browser behavior',
      ], 'Alice').status, 0);

      assert.strictEqual(runCli(home, [
        'task', 'start', 'deploy-claim', '--title', 'Deploy', '--no-worktree', '--claim', 'deploy-healthy',
      ], 'Alice').status, 0);
      const deployWrong = runCli(home, [
        'task', 'close', 'deploy-claim', '--disposition', 'archive', '--evidence', `report:${report}`, '--not-established', 'none',
      ], 'Alice');
      assert.notStrictEqual(deployWrong.status, 0);
      assert.match(deployWrong.stderr, /expects evidence kind\(s\): deploy-health; received "report"/);
      const deployMissing = runCli(home, [
        'task', 'close', 'deploy-claim', '--disposition', 'archive', '--evidence', `deploy-health:${missing}`, '--not-established', 'none',
      ], 'Alice');
      assert.notStrictEqual(deployMissing.status, 0);
      assert.match(deployMissing.stderr, /deploy-health evidence file .* does not exist/);
      assert.strictEqual(runCli(home, [
        'task', 'close', 'deploy-claim', '--disposition', 'archive', '--evidence', `deploy-health:${health}`, '--not-established', 'long-term health',
      ], 'Alice').status, 0);

      assert.strictEqual(runCli(home, [
        'task', 'start', 'analysis-claim', '--title', 'Analysis', '--no-worktree',
      ], 'Alice').status, 0);
      const analysisAbsent = runCli(home, [
        'task', 'close', 'analysis-claim', '--disposition', 'archive', '--not-established', 'none',
      ], 'Alice');
      assert.notStrictEqual(analysisAbsent.status, 0);
      assert.match(analysisAbsent.stderr, /claim "analysis" expects evidence kind\(s\): report/);
      const analysisWrong = runCli(home, [
        'task', 'close', 'analysis-claim', '--disposition', 'archive', '--evidence', `journey:${journey}`, '--not-established', 'none',
      ], 'Alice');
      assert.notStrictEqual(analysisWrong.status, 0);
      assert.match(analysisWrong.stderr, /claim "analysis" expects evidence kind\(s\): report; received "journey"/);
      const analysisMissing = runCli(home, [
        'task', 'close', 'analysis-claim', '--disposition', 'archive', '--evidence', `report:${missing}`, '--not-established', 'none',
      ], 'Alice');
      assert.notStrictEqual(analysisMissing.status, 0);
      assert.match(analysisMissing.stderr, /must exist and be non-empty/);
      assert.strictEqual(runCli(home, [
        'task', 'close', 'analysis-claim', '--disposition', 'archive', '--evidence', `report:${report}`, '--not-established', 'production behavior',
      ], 'Alice').status, 0);

      assert.strictEqual(runCli(home, [
        'task', 'start', 'decision-claim', '--title', 'Decision', '--no-worktree', '--claim', 'decision',
      ], 'Alice').status, 0);
      const decisionWrong = runCli(home, [
        'task', 'close', 'decision-claim', '--disposition', 'archive', '--evidence', `journey:${journey}`, '--not-established', 'none',
      ], 'Alice');
      assert.notStrictEqual(decisionWrong.status, 0);
      assert.match(decisionWrong.stderr, /expects evidence kind\(s\): decision, report; received "journey"/);
      const absentDecision = runCli(home, [
        'task', 'close', 'decision-claim', '--disposition', 'archive', '--evidence', 'decision:999999', '--not-established', 'none',
      ], 'Alice');
      assert.notStrictEqual(absentDecision.status, 0);
      assert.match(absentDecision.stderr, /decision evidence id "999999" does not exist in this swarm/);
      const recorded = runCli(home, [
        'decision', 'DECISION: use the typed close BECAUSE evidence must match', '--task', 'decision-claim',
      ], 'Alice');
      assert.strictEqual(recorded.status, 0, recorded.stderr || recorded.stdout);
      const decisionId = recorded.stdout.match(/#(\d+)/)?.[1];
      assert.ok(decisionId);
      assert.strictEqual(runCli(home, [
        'task', 'close', 'decision-claim', '--disposition', 'archive',
        '--evidence', `decision:${decisionId}`, '--evidence', `report:${report}`,
        '--not-established', 'implementation correctness',
      ], 'Alice').status, 0);

      assert.strictEqual(runCli(home, [
        'task', 'start', 'probe-claim', '--title', 'Probe', '--no-worktree', '--claim', 'probe',
      ], 'Alice').status, 0);
      const probeWrong = runCli(home, [
        'task', 'close', 'probe-claim', '--disposition', 'archive', '--evidence', `journey:${journey}`, '--not-established', 'none',
      ], 'Alice');
      assert.notStrictEqual(probeWrong.status, 0);
      assert.match(probeWrong.stderr, /claim "probe" expects evidence kind\(s\): report; received "journey"/);
      const probeMissing = runCli(home, [
        'task', 'close', 'probe-claim', '--disposition', 'archive', '--evidence', `report:${missing}`, '--not-established', 'none',
      ], 'Alice');
      assert.notStrictEqual(probeMissing.status, 0);
      assert.match(probeMissing.stderr, /must exist and be non-empty/);
      assert.strictEqual(runCli(home, [
        'task', 'close', 'probe-claim', '--disposition', 'archive', '--outcome', 'inconclusive',
        '--not-established', 'the probe established no answer',
      ], 'Alice').status, 0);

      const db = openDb(home);
      assert.strictEqual(taskRow(db, 'analysis-claim').claim_kind, 'analysis', '--no-worktree defaults to analysis');
      const decisionEvidence = db.prepare(`
        SELECT data FROM task_events WHERE task_id = 'decision-claim' AND kind = 'close_evidence' ORDER BY id
      `).all() as Array<{ data: string }>;
      assert.deepStrictEqual(decisionEvidence.map(row => JSON.parse(row.data)), [
        { kind: 'decision', ref: decisionId, verified: true },
        { kind: 'report', ref: report, verified: true },
      ]);
      const journeyUrlEvidence = db.prepare("SELECT data FROM task_events WHERE task_id = 'journey-url' AND kind = 'close_evidence'").get() as { data: string };
      assert.deepStrictEqual(JSON.parse(journeyUrlEvidence.data), {
        kind: 'journey', ref: 'https://evidence.example/run/42', verified: 'unverified',
      });
      const probeClose = db.prepare("SELECT data FROM task_events WHERE task_id = 'probe-claim' AND kind = 'closed'").get() as { data: string };
      assert.strictEqual(JSON.parse(probeClose.data).outcome, 'inconclusive');
      db.close();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(evidenceRoot, { recursive: true, force: true });
    }
  });

  test('T1 requires and surfaces --not-established while legacy NULL claims behave as code-merged', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-t1-honesty-'));
    const report = path.join(home, 'analysis.md');
    fs.writeFileSync(report, 'bounded analysis\n');
    try {
      joinAgent(home, 'Alice');
      assert.strictEqual(runCli(home, [
        'task', 'start', 'honest-close', '--title', 'Honest', '--no-worktree', '--claim', 'analysis',
      ], 'Alice').status, 0);
      const missingFlag = runCli(home, [
        'task', 'close', 'honest-close', '--disposition', 'archive', '--evidence', `report:${report}`,
      ], 'Alice');
      assert.notStrictEqual(missingFlag.status, 0);
      assert.match(missingFlag.stderr, /requires --not-established/);
      assert.strictEqual(runCli(home, [
        'task', 'close', 'honest-close', '--disposition', 'archive', '--evidence', `report:${report}`,
        '--not-established', 'deployment health',
      ], 'Alice').status, 0);
      const show = runCli(home, ['task', 'show', 'honest-close'], 'Alice');
      assert.strictEqual(show.status, 0, show.stderr || show.stdout);
      assert.match(show.stdout, /claim: analysis/);
      assert.match(show.stdout, /report:.*analysis\.md \[verified: true\]/);
      assert.match(show.stdout, /not established: deployment health/);
      let db = openDb(home);
      const closeEvent = db.prepare("SELECT data FROM task_events WHERE task_id = 'honest-close' AND kind = 'closed'").get() as { data: string };
      assert.strictEqual(JSON.parse(closeEvent.data).not_established, 'deployment health');
      db.close();

      assert.strictEqual(runCli(home, [
        'task', 'start', 'legacy-null', '--title', 'Legacy', '--no-worktree', '--claim', 'analysis',
      ], 'Alice').status, 0);
      db = openDb(home);
      db.prepare("UPDATE tasks SET claim_kind = NULL WHERE id = 'legacy-null'").run();
      db.close();
      const legacyList = runCli(home, ['task', 'list'], 'Alice');
      assert.match(legacyList.stdout, /legacy-null .*claim code-merged/);
      const legacyClose = runCli(home, [
        'task', 'close', 'legacy-null', '--disposition', 'archive', '--not-established', 'none',
      ], 'Alice');
      assert.strictEqual(legacyClose.status, 0, legacyClose.stderr || legacyClose.stdout);
      const legacyShow = runCli(home, ['task', 'show', 'legacy-null'], 'Alice');
      assert.match(legacyShow.stdout, /claim: code-merged/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('T1 repo-backed non-code claims retain git gates and override requires a reason and records bypassed gates', () => {
    const root = fs.mkdtempSync(path.join(suiteRoot, 'override-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-t1-override-'));
    try {
      const { repo } = createPushedRepo(root);
      const report = path.join(home, 'report.md');
      fs.writeFileSync(report, 'analysis complete\n');
      joinAgent(home, 'Alice');
      assert.strictEqual(runCli(home, [
        'task', 'start', 'override-gates', '--title', 'Override gates', '--repo', repo, '--claim', 'analysis',
      ], 'Alice').status, 0);
      let db = openDb(home);
      const task = taskRow(db, 'override-gates');
      db.close();
      fs.appendFileSync(path.join(task.worktree_path, 'tracked.txt'), 'dirty\n');

      const gated = runCli(home, [
        'task', 'close', 'override-gates', '--disposition', 'archive', '--evidence', `report:${report}`,
        '--not-established', 'runtime behavior',
      ], 'Alice');
      assert.notStrictEqual(gated.status, 0);
      assert.match(gated.stderr, /dirty tracked files: 1/);

      const noReason = runCli(home, [
        'task', 'close', 'override-gates', '--disposition', 'archive', '--override', '--not-established', 'runtime behavior',
      ], 'Alice');
      assert.notStrictEqual(noReason.status, 0);
      assert.match(noReason.stderr, /--override.*requires --reason/s);

      const grant = runCli(home, [
        'grant', 'create', '--op', 'override', '--resource', 'override-gates', '--ttl', '2h',
      ], 'Alice');
      assert.strictEqual(grant.status, 0, grant.stderr || grant.stdout);

      const overridden = runCli(home, [
        'task', 'close', 'override-gates', '--disposition', 'archive', '--override', '--reason', 'urgent audit handoff',
        '--not-established', 'runtime behavior',
      ], 'Alice');
      assert.strictEqual(overridden.status, 0, overridden.stderr || overridden.stdout);
      assert.ok(!fs.existsSync(task.worktree_path));
      db = openDb(home);
      const overrideEvent = db.prepare("SELECT data FROM task_events WHERE task_id = 'override-gates' AND kind = 'gate_override'").get() as { data: string };
      assert.deepStrictEqual(JSON.parse(overrideEvent.data), {
        reason: 'urgent audit handoff',
        bypassed_gates: ['evidence-required', 'git-dirty-tracked'],
      });
      db.close();
      const show = runCli(home, ['task', 'show', 'override-gates'], 'Alice');
      assert.match(show.stdout, /gate overrides:\n  #\d+ reason: urgent audit handoff; bypassed: evidence-required, git-dirty-tracked/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('T1 swarm run logs full combined output, bounds the summary, propagates exit, infers worktrees, and records events', () => {
    const root = fs.mkdtempSync(path.join(suiteRoot, 'run-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-t1-run-'));
    try {
      const { repo } = createPushedRepo(root);
      joinAgent(home, 'Alice');
      assert.strictEqual(runCli(home, [
        'task', 'start', 'run-evidence', '--title', 'Run evidence', '--repo', repo,
      ], 'Alice').status, 0);
      const db = openDb(home);
      const task = taskRow(db, 'run-evidence');
      db.close();
      const nested = path.join(task.worktree_path, 'nested');
      fs.mkdirSync(nested);
      const script = [
        'for (let i = 1; i <= 45; i += 1) {',
        "  const line = 'line-' + String(i).padStart(3, '0');",
        '  (i % 2 === 0 ? console.error : console.log)(line);',
        '}',
        'process.exit(7);',
      ].join('\n');
      const inferred = runCli(home, ['run', '--', process.execPath, '-e', script], 'Alice', nested);
      assert.strictEqual(inferred.status, 7, inferred.stderr || inferred.stdout);
      assert.match(inferred.stdout, /^line-001$/m);
      assert.match(inferred.stdout, /^line-015$/m);
      assert.doesNotMatch(inferred.stdout, /^line-020$/m);
      assert.match(inferred.stdout, /output truncated: 5 lines omitted/);
      assert.match(inferred.stdout, /^line-021$/m);
      assert.match(inferred.stdout, /^line-045$/m);
      assert.match(inferred.stdout, /Exit status: 7/);
      const logPath = inferred.stdout.match(/^Log: (.+)$/m)?.[1];
      assert.strictEqual(logPath, path.join(home, '.swarm', 'evidence', 'default', 'run-evidence', 'run-001.log'));
      const fullLog = fs.readFileSync(logPath!, 'utf-8');
      assert.strictEqual((fullLog.match(/^line-\d{3}$/gm) ?? []).length, 45);
      assert.match(fullLog, /^line-002$/m, 'stderr is captured in the combined full log');

      const explicit = runCli(home, [
        'run', '--task', 'run-evidence', '--', process.execPath, '-e', "console.log('explicit-task')",
      ], 'Alice', root);
      assert.strictEqual(explicit.status, 0, explicit.stderr || explicit.stdout);
      assert.match(explicit.stdout, /explicit-task/);
      assert.match(explicit.stdout, /run-002\.log/);

      const outside = runCli(home, ['run', '--', process.execPath, '-e', "console.log('no task')"], 'Alice', root);
      assert.notStrictEqual(outside.status, 0);
      assert.match(outside.stderr, /Pass --task <slug> or run from under a recorded task worktree/);

      assert.strictEqual(runCli(home, [
        'task', 'start', 'run-no-worktree', '--title', 'No worktree run', '--no-worktree',
      ], 'Alice', root).status, 0);
      const noWorktree = runCli(home, [
        'run', '--task', 'run-no-worktree', '--', process.execPath, '-e', 'console.log(process.cwd())',
      ], 'Alice', root);
      assert.strictEqual(noWorktree.status, 0, noWorktree.stderr || noWorktree.stdout);
      assert.match(noWorktree.stdout, new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));

      const after = openDb(home);
      const events = after.prepare("SELECT data FROM task_events WHERE task_id = 'run-evidence' AND kind = 'run' ORDER BY id").all() as Array<{ data: string }>;
      assert.strictEqual(events.length, 2);
      assert.deepStrictEqual(JSON.parse(events[0].data), {
        argv0: process.execPath,
        argsCount: 2,
        exit: 7,
        logPath,
        durationMs: JSON.parse(events[0].data).durationMs,
      });
      assert.ok(Number.isInteger(JSON.parse(events[0].data).durationMs));
      after.close();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('T1 deploy-health URL failures are injected, non-blocking, and recorded as unverified', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-t1-deploy-stub-'));
    const db = getDbAt(path.join(root, 'swarm.db'));
    try {
      joinHeadlessAgent(db, 'default', 'Alice');
      await startTask(db, 'default', 'Alice', 'deploy-url', {
        title: 'Deploy URL',
        noWorktree: true,
        claimKind: 'deploy-healthy',
      });
      const calls: string[] = [];
      const closed = await closeTask(db, 'default', 'Alice', 'deploy-url', {
        disposition: 'archive',
        evidence: ['deploy-health:https://health.invalid/status'],
        notEstablished: 'sustained health',
        deployHealthCheck: async url => {
          calls.push(url);
          throw new Error('stubbed network failure');
        },
      });
      assert.strictEqual(closed.state, 'done');
      assert.deepStrictEqual(calls, ['https://health.invalid/status']);
      const event = db.prepare("SELECT data FROM task_events WHERE task_id = 'deploy-url' AND kind = 'close_evidence'").get() as { data: string };
      assert.deepStrictEqual(JSON.parse(event.data), {
        kind: 'deploy-health',
        ref: 'https://health.invalid/status',
        verified: 'unverified',
      });

      await startTask(db, 'default', 'Alice', 'deploy-status', {
        title: 'Deploy status',
        noWorktree: true,
        claimKind: 'deploy-healthy',
      });
      await closeTask(db, 'default', 'Alice', 'deploy-status', {
        disposition: 'archive',
        evidence: ['deploy-health:https://health.example/status'],
        notEstablished: 'sustained health',
        deployHealthCheck: async () => 204,
      });
      const statusEvent = db.prepare("SELECT data FROM task_events WHERE task_id = 'deploy-status' AND kind = 'close_evidence'").get() as { data: string };
      assert.strictEqual(JSON.parse(statusEvent.data).verified, 204);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
