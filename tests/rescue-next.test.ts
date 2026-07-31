import { describe, test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { restoreRescueArtifact } from '../src/rescue.js';

const INDEX = path.resolve(fileURLToPath(new URL('../src/index.ts', import.meta.url)));

interface CliResult { stdout: string; stderr: string; status: number }

function cliToken(home: string, name: string): string {
  const dbPath = path.join(home, '.swarm', 'swarm.db');
  if (!fs.existsSync(dbPath)) return '';
  const db = new DatabaseSync(dbPath, { readOnly: true });
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
    TMPDIR: path.join(home, 'tmp-policy-root'),
    SWARM_ID: '',
    SWARM_NAME: '',
    SWARM_AGENT_NAME: agent ?? '',
    SWARM_SESSION_TOKEN: agent ? cliToken(home, agent) : '',
    CMUX_SURFACE_ID: '',
    CMUX_WORKSPACE_ID: '',
    TERM_PROGRAM: '',
    SWARM_TEST_DISABLE_BACKGROUND: '1',
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

function clearHeadlessMarker(home: string): void {
  const swarmDir = path.join(home, '.swarm');
  if (!fs.existsSync(swarmDir)) return;
  for (const name of fs.readdirSync(swarmDir)) {
    if (name.startsWith('headless-')) fs.rmSync(path.join(swarmDir, name), { force: true });
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

describe('WI-4 verified rescue artifacts', () => {
  test('detached staged + unstaged + untracked state round-trips, source stays untouched, corruption fails verification, and list reports state', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-wi4-home-'));
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-wi4-repo-'));
    const restoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-wi4-restore-'));
    try {
      execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
      git(repo, ['config', 'user.name', 'Swarm Test']);
      git(repo, ['config', 'user.email', 'swarm@example.test']);
      fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base\n');
      fs.writeFileSync(path.join(repo, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
      git(repo, ['add', 'tracked.txt', 'binary.bin']);
      git(repo, ['commit', '-m', 'initial']);
      git(repo, ['checkout', '--detach']);

      fs.writeFileSync(path.join(repo, 'tracked.txt'), 'staged\n');
      fs.writeFileSync(path.join(repo, 'binary.bin'), Buffer.from([0, 1, 9, 3, 4]));
      git(repo, ['add', 'tracked.txt', 'binary.bin']);
      fs.appendFileSync(path.join(repo, 'tracked.txt'), 'unstaged\n');
      fs.writeFileSync(path.join(repo, 'untracked name.txt'), 'untracked bytes\n');

      const beforeStatus = git(repo, ['status', '--porcelain']);
      const beforeHead = git(repo, ['rev-parse', 'HEAD']);
      assert.strictEqual(git(repo, ['branch', '--show-current']), '');

      const joined = runCli(home, ['join', 'Alice', '--headless'], 'Alice');
      assert.strictEqual(joined.status, 0, joined.stderr || joined.stdout);
      const rescued = runCli(home, ['rescue', '--worktree', repo], 'Alice');
      assert.strictEqual(rescued.status, 0, rescued.stderr || rescued.stdout);
      const artifactDir = rescued.stdout.match(/Rescue verified: (.+)$/m)?.[1];
      assert.ok(artifactDir);

      const manifestPath = path.join(artifactDir!, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      assert.strictEqual(manifest.verified, true);
      assert.strictEqual(manifest.head_sha, beforeHead);
      assert.strictEqual(manifest.branch, null);
      assert.match(manifest.rescue_branch, /^rescue\/unknown\/.+-\d{8}$/);
      assert.deepStrictEqual(manifest.counts, { staged: 2, unstaged: 1, dirty_tracked: 2, untracked: 1 });
      assert.deepStrictEqual(Object.keys(manifest.artifacts).sort(), [
        'repo.bundle', 'staged.patch', 'unstaged.patch', 'untracked.tar.gz',
      ]);
      assert.ok(manifest.local_unreachable_branches.includes('main'));
      assert.ok(manifest.local_unreachable_branches.includes(manifest.rescue_branch));
      const manifestDigest = sha256(manifestPath);
      const reverified = runCli(home, ['rescue', '--verify', artifactDir!], 'Alice');
      assert.strictEqual(reverified.status, 0, reverified.stderr || reverified.stdout);
      assert.strictEqual(
        sha256(manifestPath),
        manifestDigest,
        'repeat verification must preserve the digest recorded in successor pointers'
      );

      assert.strictEqual(git(repo, ['rev-parse', 'HEAD']), beforeHead);
      assert.strictEqual(git(repo, ['status', '--porcelain']), beforeStatus);
      assert.strictEqual(git(repo, ['branch', '--show-current']), '');
      assert.strictEqual(git(repo, ['rev-parse', '--verify', `refs/heads/${manifest.rescue_branch}`]), beforeHead);

      const restored = path.join(restoreRoot, 'fresh');
      restoreRescueArtifact(artifactDir!, restored);
      assert.strictEqual(git(restored, ['status', '--porcelain']), beforeStatus);
      assert.strictEqual(fs.readFileSync(path.join(restored, 'tracked.txt'), 'utf-8'), 'staged\nunstaged\n');
      assert.deepStrictEqual(fs.readFileSync(path.join(restored, 'binary.bin')), Buffer.from([0, 1, 9, 3, 4]));
      assert.strictEqual(fs.readFileSync(path.join(restored, 'untracked name.txt'), 'utf-8'), 'untracked bytes\n');

      fs.appendFileSync(path.join(artifactDir!, 'unstaged.patch'), Buffer.from([0]));
      const corrupt = runCli(home, ['rescue', '--verify', artifactDir!]);
      assert.notStrictEqual(corrupt.status, 0);
      assert.match(corrupt.stderr, /Rescue verification failed: unstaged\.patch checksum mismatch/);
      assert.match(corrupt.stderr, /Manifest:/);
      const failedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      assert.strictEqual(failedManifest.verified, false);
      assert.match(failedManifest.verification_error, /unstaged\.patch checksum mismatch/);

      const listed = runCli(home, ['rescue', '--list']);
      assert.strictEqual(listed.status, 0, listed.stderr || listed.stdout);
      assert.match(listed.stdout, new RegExp(`${path.basename(artifactDir!)}.*UNVERIFIED`));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(restoreRoot, { recursive: true, force: true });
    }
  });

  test('verified task rescue records provenance and delivers only to the exact successor registration', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-rescue-delivery-home-'));
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-rescue-delivery-repo-'));
    try {
      execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
      git(repo, ['config', 'user.name', 'Swarm Test']);
      git(repo, ['config', 'user.email', 'swarm@example.test']);
      fs.writeFileSync(path.join(repo, 'work.txt'), 'base\n');
      git(repo, ['add', 'work.txt']);
      git(repo, ['commit', '-m', 'initial']);
      fs.appendFileSync(path.join(repo, 'work.txt'), 'stranded\n');

      assert.strictEqual(runCli(home, ['join', 'Alice', '--headless'], 'Alice').status, 0);
      clearHeadlessMarker(home);
      assert.strictEqual(runCli(home, ['join', 'Bob', '--headless'], 'Bob').status, 0);
      const dbPath = path.join(home, '.swarm', 'swarm.db');
      const setup = new DatabaseSync(dbPath);
      const now = new Date().toISOString();
      const alice = setup.prepare("SELECT id FROM agents WHERE name = 'Alice'").get() as { id: string };
      const bob = setup.prepare("SELECT id FROM agents WHERE name = 'Bob'").get() as { id: string };
      setup.prepare(`
        INSERT INTO tasks (
          id, swarm_id, title, state, owner_agent, owner_agent_id, lease_epoch,
          lease_expires_at, repo_path, branch, worktree_path, transcript_hint,
          disposition, claim_kind, created_at, updated_at
        ) VALUES ('stranded', 'default', 'Stranded work', 'active', 'Alice', ?, 1,
          ?, ?, 'main', ?, NULL, NULL, 'analysis', ?, ?)
      `).run(alice.id, now, repo, repo, now, now);
      setup.close();

      const rescued = runCli(home, ['rescue', '--task', 'stranded', '--to', 'Bob'], 'Alice');
      assert.strictEqual(rescued.status, 0, rescued.stderr || rescued.stdout);
      assert.match(rescued.stdout, /Rescue pointer delivery committed for Bob: \d+ pushed, \d+ queued; message #\d+/);

      const inspect = new DatabaseSync(dbPath);
      const event = inspect.prepare(`
        SELECT actor_agent_id, data FROM task_events
        WHERE task_id = 'stranded' AND kind = 'rescue_created'
      `).get() as { actor_agent_id: string; data: string };
      assert.strictEqual(event.actor_agent_id, alice.id);
      assert.deepStrictEqual(
        {
          delivered_to: JSON.parse(event.data).delivered_to,
          delivered_to_agent_id: JSON.parse(event.data).delivered_to_agent_id,
          verified: typeof JSON.parse(event.data).verified_at === 'string',
        },
        { delivered_to: 'Bob', delivered_to_agent_id: bob.id, verified: true }
      );
      const pointer = inspect.prepare(`
        SELECT id, kind, to_agent_id, body FROM messages
        WHERE kind = 'handoff' AND body LIKE 'VERIFIED RESCUE for task stranded:%'
      `).get() as { id: number; kind: string; to_agent_id: string; body: string };
      assert.strictEqual(pointer.to_agent_id, bob.id);
      assert.match(pointer.body, /manifest\.json; manifest sha256=[0-9a-f]{64}; head [0-9a-f]{40}/);
      inspect.close();

      const oldRecipient = runCli(home, ['inbox', '--peek'], 'Bob');
      assert.match(oldRecipient.stdout, /VERIFIED RESCUE for task stranded/);

      const replace = new DatabaseSync(dbPath);
      replace.prepare("DELETE FROM agents WHERE name = 'Bob'").run();
      replace.close();
      const rejoined = runCli(home, ['join', 'Bob', '--headless'], 'Bob');
      assert.strictEqual(rejoined.status, 0, rejoined.stderr || rejoined.stdout);
      const replacementInbox = runCli(home, ['inbox', '--peek'], 'Bob');
      assert.doesNotMatch(replacementInbox.stdout, /VERIFIED RESCUE for task stranded/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
