import { describe, test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDbAt, type SwarmDb } from '../src/db.js';
import {
  checkSwarmVersion,
  formatSwarmUpdateBanner,
  getSwarmVersionCache,
  handleJoinUpdateAwareness,
  runJanitorTick,
  SWARM_VERSION_CACHE_STALE_MS,
  type SwarmVersionCache,
  type SwarmVersionGitRunner,
} from '../src/janitor.js';
import { joinHeadlessAgent } from '../src/registry.js';
import {
  deriveModelFamily,
  MODEL_FAMILY_MAP,
  requestTaskReview,
  REVIEW_EXPERIMENTAL_CAVEAT,
  REVIEW_PRIORS,
} from '../src/reviews.js';
import { startTask } from '../src/tasks.js';
import { REPO_DIR } from '../src/version.js';

const INDEX = path.resolve(fileURLToPath(new URL('../src/index.ts', import.meta.url)));
const TSX_IMPORT = import.meta.resolve('tsx');
const NOW = Date.parse('2026-07-21T18:42:00.000Z');
const LOCAL_SHA = 'a'.repeat(40);
const REMOTE_SHA = 'b'.repeat(40);

interface Fixture { root: string; home: string; db: SwarmDb }
interface CliResult { stdout: string; stderr: string; status: number }

function fixture(prefix: string): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.swarm'), { recursive: true });
  return { root, home, db: getDbAt(path.join(home, '.swarm', 'swarm.db')) };
}

function cleanup(value: Fixture): void {
  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
}

function runCli(home: string, args: string[], envOverrides: Record<string, string> = {}): CliResult {
  const env: Record<string, string> = {
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
    GEMINI_CLI: '',
    SWARM_TEST_DISABLE_BACKGROUND: '1',
    ...envOverrides,
  };
  fs.mkdirSync(env.TMPDIR, { recursive: true });
  try {
    const stdout = execFileSync('node', ['--import', TSX_IMPORT, INDEX, ...args], {
      encoding: 'utf-8', env, stdio: ['ignore', 'pipe', 'pipe'],
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

function join(
  db: SwarmDb,
  name: string,
  hostAgent: 'claude-code' | 'codex' | 'grok' | 'gemini' | null
): void {
  joinHeadlessAgent(db, 'default', name, undefined, {
    hostAgent,
    versionRunner: () => 'fixture version\n',
  });
}

async function startAnalysis(db: SwarmDb, actor: string, slug: string): Promise<void> {
  await startTask(db, 'default', actor, slug, {
    title: `Review ${slug}`,
    noWorktree: true,
    claimKind: 'analysis',
  });
}

function writeVersionCache(db: SwarmDb, cache: SwarmVersionCache): void {
  db.prepare(`
    INSERT INTO janitor_kv (key, value, updated_at)
    VALUES ('swarm_version_check', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(JSON.stringify(cache), cache.checked_at);
}

describe('T6 model-inversion review routing', () => {
  test('exports the host-family map and derives every family including unknown', () => {
    assert.deepStrictEqual({ ...MODEL_FAMILY_MAP }, {
      'claude-code': 'claude',
      codex: 'openai',
      grok: 'xai',
      gemini: 'google',
    });
    assert.strictEqual(deriveModelFamily('claude-code'), 'claude');
    assert.strictEqual(deriveModelFamily('codex'), 'openai');
    assert.strictEqual(deriveModelFamily('grok'), 'xai');
    assert.strictEqual(deriveModelFamily('gemini'), 'google');
    assert.strictEqual(deriveModelFamily('other'), 'unknown');
    assert.strictEqual(deriveModelFamily(null), 'unknown');
  });

  test('same-family review refuses with live alternatives; override requires and audits a reason', async () => {
    const value = fixture('swarm-t6-same-family-');
    try {
      join(value.db, 'Author', 'claude-code');
      join(value.db, 'Same', 'claude-code');
      join(value.db, 'Alternative', 'codex');
      await startAnalysis(value.db, 'Author', 'same-family');

      await assert.rejects(
        requestTaskReview(value.db, 'default', 'Author', 'same-family', {
          to: 'Same', now: new Date(NOW), homeDir: value.home,
        }),
        /model inversion requires.*Live different-family members: Alternative.*--same-family-ok.*--reason/s
      );
      assert.strictEqual(
        (value.db.prepare("SELECT state FROM tasks WHERE id = 'same-family'").get() as any).state,
        'active'
      );
      await assert.rejects(
        requestTaskReview(value.db, 'default', 'Author', 'same-family', {
          to: 'Same', sameFamilyOk: true, now: new Date(NOW), homeDir: value.home,
        }),
        /--same-family-ok requires --reason/
      );

      await requestTaskReview(value.db, 'default', 'Author', 'same-family', {
        to: 'Same', sameFamilyOk: true, reason: 'Only reviewer with domain context',
        now: new Date(NOW), homeDir: value.home,
      });
      const event = value.db.prepare(`
        SELECT data FROM task_events
        WHERE task_id = 'same-family' AND kind = 'same_family_review'
      `).get() as { data: string };
      // `gate` and `author_family` were added so the record says WHICH refusal was
      // overridden — the same event kind now also covers unknown-family overrides,
      // which previously bypassed the control without writing anything at all.
      assert.deepStrictEqual(JSON.parse(event.data), {
        gate: 'same-family',
        reviewer: 'Same',
        reviewer_family: 'claude',
        author_family: 'claude',
        reason: 'Only reviewer with domain context',
      });
    } finally {
      cleanup(value);
    }
  });

  test('auto-pick selects a different-family reviewer with the fewest open reviews', async () => {
    const value = fixture('swarm-t6-auto-pick-');
    try {
      join(value.db, 'Author', 'claude-code');
      join(value.db, 'Busy', 'codex');
      join(value.db, 'Free', 'gemini');
      await startAnalysis(value.db, 'Author', 'existing-review');
      await requestTaskReview(value.db, 'default', 'Author', 'existing-review', {
        to: 'Busy', now: new Date(NOW - 60_000), homeDir: value.home,
      });
      await startAnalysis(value.db, 'Author', 'auto-review');
      const selected = await requestTaskReview(value.db, 'default', 'Author', 'auto-review', {
        now: new Date(NOW), homeDir: value.home,
      });
      assert.strictEqual(selected.reviewer, 'Free');
      assert.strictEqual(selected.authorFamily, 'claude');
      assert.strictEqual(selected.reviewerFamily, 'google');
    } finally {
      cleanup(value);
    }
  });

  test('briefs carry claude/openai priors and caveat; message is pointer-only and event data is complete', async () => {
    const value = fixture('swarm-t6-brief-');
    try {
      join(value.db, 'ClaudeAuthor', 'claude-code');
      join(value.db, 'OpenAIAuthor', 'codex');
      await startAnalysis(value.db, 'ClaudeAuthor', 'claude-authored');
      await startAnalysis(value.db, 'OpenAIAuthor', 'openai-authored');

      const claude = await requestTaskReview(value.db, 'default', 'ClaudeAuthor', 'claude-authored', {
        to: 'OpenAIAuthor', now: new Date(NOW), homeDir: value.home,
      });
      const openai = await requestTaskReview(value.db, 'default', 'OpenAIAuthor', 'openai-authored', {
        to: 'ClaudeAuthor', now: new Date(NOW + 60_000), homeDir: value.home,
      });
      const claudeBrief = fs.readFileSync(claude.briefPath, 'utf-8');
      const openaiBrief = fs.readFileSync(openai.briefPath, 'utf-8');
      assert.match(claudeBrief, new RegExp(REVIEW_PRIORS.claude.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(openaiBrief, new RegExp(REVIEW_PRIORS.openai.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.ok(claudeBrief.includes(REVIEW_EXPERIMENTAL_CAVEAT));
      assert.ok(openaiBrief.includes(REVIEW_EXPERIMENTAL_CAVEAT));

      const message = value.db.prepare('SELECT body, kind, to_agent FROM messages WHERE id = ?')
        .get(claude.messageId) as { body: string; kind: string; to_agent: string };
      assert.deepStrictEqual({ ...message }, {
        body: claude.briefPath,
        kind: 'gate',
        to_agent: 'OpenAIAuthor',
      });
      const event = value.db.prepare(`
        SELECT data FROM task_events
        WHERE task_id = 'claude-authored' AND kind = 'review_requested'
      `).get() as { data: string };
      assert.deepStrictEqual(JSON.parse(event.data), {
        author_family: 'claude',
        reviewer: 'OpenAIAuthor',
        reviewer_family: 'openai',
        brief_path: claude.briefPath,
      });
    } finally {
      cleanup(value);
    }
  });

  test('no live cross-family reviewer is actionable and leaves task state/events unchanged', async () => {
    const value = fixture('swarm-t6-no-reviewer-');
    try {
      join(value.db, 'Author', 'claude-code');
      join(value.db, 'SameFamily', 'claude-code');
      await startAnalysis(value.db, 'Author', 'no-reviewer');
      const beforeEvents = (value.db.prepare("SELECT count(*) AS n FROM task_events WHERE task_id = 'no-reviewer'").get() as any).n;
      await assert.rejects(
        requestTaskReview(value.db, 'default', 'Author', 'no-reviewer', {
          now: new Date(NOW), homeDir: value.home,
        }),
        /No live cross-family reviewer.*Spawn a reviewer from a different model family.*swarm review no-reviewer/s
      );
      assert.strictEqual(
        (value.db.prepare("SELECT state FROM tasks WHERE id = 'no-reviewer'").get() as any).state,
        'active'
      );
      assert.strictEqual(
        (value.db.prepare("SELECT count(*) AS n FROM task_events WHERE task_id = 'no-reviewer'").get() as any).n,
        beforeEvents
      );
      assert.strictEqual(fs.existsSync(path.join(value.home, '.swarm', 'briefs', 'reviews')), false);
    } finally {
      cleanup(value);
    }
  });
});

describe('T7 automatic update awareness', () => {
  test('version cache records current, update-available, and unknown using ls-remote without fetch', () => {
    const value = fixture('swarm-t7-cache-');
    const calls: string[][] = [];
    const runner = (remoteSha: string, failRemote = false): SwarmVersionGitRunner =>
      (binary, args, options) => {
        assert.strictEqual(binary, 'git');
        assert.strictEqual(options.cwd, path.resolve(value.root, 'repo'));
        assert.strictEqual(options.timeout, 5_000);
        calls.push(args);
        if (args[0] === 'rev-parse') return `${LOCAL_SHA}\n`;
        assert.deepStrictEqual(args, ['ls-remote', 'origin', 'master']);
        if (failRemote) throw new Error('offline');
        return `${remoteSha}\trefs/heads/master\n`;
      };
    try {
      assert.strictEqual(checkSwarmVersion(value.db, {
        now: NOW, repoDir: path.join(value.root, 'repo'), runner: runner(LOCAL_SHA),
      }).status, 'current');
      const different = checkSwarmVersion(value.db, {
        now: NOW + 1, repoDir: path.join(value.root, 'repo'), runner: runner(REMOTE_SHA),
      });
      assert.deepStrictEqual(different, {
        local_sha: LOCAL_SHA,
        remote_sha: REMOTE_SHA,
        checked_at: new Date(NOW + 1).toISOString(),
        status: 'update-available',
      });
      assert.strictEqual(getSwarmVersionCache(value.db)?.status, 'update-available');
      const failed = checkSwarmVersion(value.db, {
        now: NOW + 2, repoDir: path.join(value.root, 'repo'), runner: runner(REMOTE_SHA, true),
      });
      assert.strictEqual(failed.status, 'unknown');
      assert.strictEqual(failed.local_sha, LOCAL_SHA);
      assert.strictEqual(failed.remote_sha, null);
      assert.ok(calls.some(args => args[0] === 'ls-remote'));
      assert.ok(calls.every(args => args[0] !== 'fetch'));
    } finally {
      cleanup(value);
    }
  });

  test('banner renders only for update-available and hook context appends the exact line', () => {
    const value = fixture('swarm-t7-hook-');
    const checkedAt = new Date(NOW).toISOString();
    const cache = (status: SwarmVersionCache['status']): SwarmVersionCache => ({
      local_sha: LOCAL_SHA,
      remote_sha: status === 'update-available' ? REMOTE_SHA : LOCAL_SHA,
      checked_at: checkedAt,
      status,
    });
    try {
      const expected = `swarm update available — cd ${REPO_DIR} && git pull && npm install && npm run build`;
      assert.strictEqual(formatSwarmUpdateBanner(cache('current')), null);
      assert.strictEqual(formatSwarmUpdateBanner(cache('unknown')), null);
      assert.strictEqual(formatSwarmUpdateBanner(cache('update-available')), expected);

      join(value.db, 'Alice', null);
      value.db.prepare(`
        INSERT INTO janitor_status (id, last_tick_at, last_duration_ms, counters)
        VALUES (1, ?, 1, ?)
      `).run(new Date().toISOString(), JSON.stringify({
        worktrees: 0, detachedHeads: 0, orphanedWorktrees: 0, unpushedCommits: 0,
        goneUpstreamBranches: 0, tempStrays: 0, junkDirs: 0, reposScanned: 0, tickMs: 1,
      }));
      for (const status of ['current', 'unknown', 'update-available'] as const) {
        writeVersionCache(value.db, cache(status));
        const hook = runCli(value.home, ['hook-context'], { SWARM_AGENT_NAME: 'Alice' });
        assert.strictEqual(hook.status, 0, hook.stderr);
        assert.strictEqual(hook.stdout.includes('swarm update available —'), status === 'update-available');
        if (status === 'update-available') assert.ok(hook.stdout.includes(expected));
      }
    } finally {
      cleanup(value);
    }
  });

  test('join awareness prints cached updates and injectably spawns refreshes for stale or absent cache', () => {
    const value = fixture('swarm-t7-join-');
    const printed: string[] = [];
    let spawned = 0;
    try {
      writeVersionCache(value.db, {
        local_sha: LOCAL_SHA,
        remote_sha: REMOTE_SHA,
        checked_at: new Date(NOW).toISOString(),
        status: 'update-available',
      });
      const fresh = handleJoinUpdateAwareness(value.db, {
        now: NOW,
        print: line => printed.push(line),
        spawnTick: () => { spawned += 1; },
      });
      assert.strictEqual(fresh.spawned, false);
      assert.strictEqual(spawned, 0);
      assert.deepStrictEqual(printed, [
        `swarm update available — cd ${REPO_DIR} && git pull && npm install && npm run build`,
      ]);

      const cli = runCli(value.home, ['join', 'CliAgent', '--headless']);
      assert.strictEqual(cli.status, 0, cli.stderr);
      assert.ok(cli.stdout.includes(printed[0]));

      const stale = handleJoinUpdateAwareness(value.db, {
        now: NOW + SWARM_VERSION_CACHE_STALE_MS + 1,
        print: () => {},
        spawnTick: () => { spawned += 1; },
      });
      assert.strictEqual(stale.spawned, true);
      assert.strictEqual(spawned, 1);

      value.db.prepare("DELETE FROM janitor_kv WHERE key = 'swarm_version_check'").run();
      const absent = handleJoinUpdateAwareness(value.db, {
        now: NOW,
        print: () => {},
        spawnTick: () => { spawned += 1; },
      });
      assert.deepStrictEqual(absent, { banner: null, spawned: true });
      assert.strictEqual(spawned, 2);
    } finally {
      cleanup(value);
    }
  });

  test('janitor tick survives network failure and caches unknown', () => {
    const value = fixture('swarm-t7-network-failure-');
    const calls: string[][] = [];
    const runner: SwarmVersionGitRunner = (_binary, args) => {
      calls.push(args);
      throw new Error('network unavailable');
    };
    try {
      const result = runJanitorTick(value.db, {
        homeDir: value.home,
        tempScanPaths: [],
        controlsFilePath: path.join(value.root, 'missing-controls.md'),
        now: NOW,
        versionRunner: runner,
        versionRepoDir: value.root,
      });
      assert.strictEqual(result.ran, true);
      assert.strictEqual(result.lockedOut, false);
      assert.strictEqual(getSwarmVersionCache(value.db)?.status, 'unknown');
      assert.deepStrictEqual(calls, [['rev-parse', 'HEAD']]);
      assert.ok(calls.every(args => args[0] !== 'fetch'));
    } finally {
      cleanup(value);
    }
  });
});
