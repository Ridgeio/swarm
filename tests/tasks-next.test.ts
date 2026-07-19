import { after, before, describe, test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import SQLite from 'better-sqlite3';

const INDEX = path.resolve(fileURLToPath(new URL('../src/index.ts', import.meta.url)));

interface CliResult { stdout: string; stderr: string; status: number }

function runCli(home: string, args: string[], agent?: string): CliResult {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    TMPDIR: path.join(home, 'tmp-policy-root'),
    SWARM_ID: '',
    SWARM_NAME: '',
    SWARM_AGENT_NAME: agent ?? '',
    CMUX_SURFACE_ID: '',
    CMUX_WORKSPACE_ID: '',
    TERM_PROGRAM: '',
    CODEX_CLI: '',
    CODEX_CI: '',
    CODEX_THREAD_ID: '',
    CODEX_MANAGED_BY_NPM: '',
    CLAUDE_CODE: '',
    GROK_AGENT: '',
  };
  try {
    const stdout = execFileSync('node', ['--import', 'tsx', INDEX, ...args], {
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

function openDb(home: string): SQLite.Database {
  return new SQLite(path.join(home, '.swarm', 'swarm.db'));
}

function taskRow(db: SQLite.Database, slug: string): any {
  return db.prepare('SELECT * FROM tasks WHERE swarm_id = ? AND id = ?').get('default', slug);
}

describe('WI-3 task ledger CLI', () => {
  let suiteRoot: string;

  before(() => {
    suiteRoot = fs.mkdtempSync(path.join(process.cwd(), '.wi3-tests-'));
  });

  after(() => {
    fs.rmSync(suiteRoot, { recursive: true, force: true });
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

      const closed = runCli(home, ['task', 'close', 'happy-path', '--disposition', 'pr'], 'Alice');
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

  test('takeover bumps the epoch and fences both checkpoint and close with refusal events', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-wi3-fence-'));
    try {
      joinAgent(home, 'Alice');
      joinAgent(home, 'Bob');
      assert.strictEqual(runCli(home, ['task', 'start', 'fenced-task', '--title', 'Fence me', '--no-worktree'], 'Alice').status, 0);

      const blocked = runCli(home, ['task', 'start', 'fenced-task', '--no-worktree'], 'Bob');
      assert.notStrictEqual(blocked.status, 0);
      assert.match(blocked.stderr, /--takeover/);
      const claimed = runCli(home, ['task', 'start', 'fenced-task', '--takeover', '--no-worktree'], 'Bob');
      assert.strictEqual(claimed.status, 0, claimed.stderr || claimed.stdout);
      assert.match(claimed.stdout, /lease epoch 2/);

      const staleCheckpoint = runCli(home, ['task', 'checkpoint', 'fenced-task', '--notes', 'stale'], 'Alice');
      const staleClose = runCli(home, ['task', 'close', 'fenced-task', '--disposition', 'archive'], 'Alice');
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
      fs.appendFileSync(path.join(task.worktree_path, 'tracked.txt'), 'dirty\n');
      fs.writeFileSync(path.join(task.worktree_path, 'untracked.txt'), 'untracked\n');

      const refused = runCli(home, ['task', 'close', 'count-state', '--disposition', 'pr'], 'Alice');
      assert.notStrictEqual(refused.status, 0);
      assert.match(refused.stderr, /unpushed commits: 1, dirty tracked files: 1, untracked files: 1/);

      const singleConfirm = runCli(home, ['task', 'close', 'count-state', '--disposition', 'discard'], 'Alice');
      assert.notStrictEqual(singleConfirm.status, 0);
      assert.match(singleConfirm.stderr, /requires both --disposition discard and --force-discard/);
      const discarded = runCli(home, ['task', 'close', 'count-state', '--disposition', 'discard', '--force-discard'], 'Alice');
      assert.strictEqual(discarded.status, 0, discarded.stderr || discarded.stdout);
      const after = openDb(home);
      const forceEvent = after.prepare("SELECT data FROM task_events WHERE task_id = 'count-state' AND kind = 'force_discard'").get() as { data: string };
      assert.deepStrictEqual(JSON.parse(forceEvent.data), { unpushed: 1, dirty_tracked: 1, untracked: 1 });
      after.close();
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

      const closed = runCli(home, ['task', 'close', 'archive-it', '--disposition', 'archive'], 'Alice');
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
      const cleanup = runCli(home, ['task', 'close', 'branch-reclaim', '--disposition', 'discard', '--force-discard'], 'Alice');
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

      assert.strictEqual(runCli(home, ['task', 'close', 'agent-one', '--disposition', 'pr'], 'Alice').status, 0);
      assert.strictEqual(runCli(home, ['task', 'close', 'agent-two', '--disposition', 'pr'], 'Alice').status, 0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('handoff enforces freshness, labels stale briefs, sends only a pointer summary, and target start re-fences', () => {
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

      const refused = runCli(home, ['handoff', 'handoff-me', '--to', 'Bob'], 'Alice');
      assert.notStrictEqual(refused.status, 0);
      assert.match(refused.stderr, /checkpoint is 61m old.*--stale-ok/s);
      const handed = runCli(home, ['handoff', 'handoff-me', '--to', 'Bob', '--stale-ok'], 'Alice');
      assert.strictEqual(handed.status, 0, handed.stderr || handed.stdout);
      assert.match(handed.stdout, /lease epoch 2/);
      assert.match(handed.stdout, /\(STALE\)/);
      const briefPath = handed.stdout.match(/Brief: (.+) \(STALE\)$/m)?.[1];
      assert.ok(briefPath);
      assert.match(fs.readFileSync(briefPath!, 'utf-8'), /^# STALE Context transfer$/m);

      const after = openDb(home);
      const task = taskRow(after, 'handoff-me');
      assert.strictEqual(task.owner_agent, 'Bob');
      assert.strictEqual(task.lease_epoch, 2);
      const pointer = after.prepare("SELECT body, kind FROM messages WHERE to_agent = 'Bob' COLLATE NOCASE AND kind = 'handoff'").get() as any;
      assert.strictEqual(pointer.kind, 'handoff');
      assert.ok(pointer.body.includes(briefPath));
      assert.strictEqual(pointer.body.split('\n').length, 1);
      assert.doesNotMatch(pointer.body, /## latest checkpoint/);
      after.close();

      const accepted = runCli(home, ['task', 'start', 'handoff-me', '--no-worktree'], 'Bob');
      assert.strictEqual(accepted.status, 0, accepted.stderr || accepted.stdout);
      assert.match(accepted.stdout, /lease epoch 3/);
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
      db.close();

      assert.strictEqual(runCli(home, ['reset', '--all']).status, 0);
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
});
