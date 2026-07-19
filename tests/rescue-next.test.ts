import { describe, test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { restoreRescueArtifact } from '../src/rescue.js';

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

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
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
});
